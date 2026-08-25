import { attachmentDataUrl, attachmentsForMessage } from './attachments.js';
import type { AttachmentRow, Db } from './db.js';

/**
 * 图片 caption 旁路转写（daily check-in P3 S1）。
 *
 * 上传落库后 fire-and-forget 调一次 vision 模型（openai-compat 协议，生产指向
 * Gemini flash），把「图中文字逐字 + 一句场景」的中文转写写回附件行，并反规范化
 * 进 messages.meta 的 $.captions——historicalMessageText / journalDay 只拿得到
 * meta，这份副本是全部文字化链路能看到图片内容的唯一通道。
 *
 * Fail-open 是硬约束：无 key、超时、超额、模型报错都只影响 caption_status，
 * 消息主流程零感知。
 */

export type CaptionStatus = 'none' | 'pending' | 'done' | 'failed' | 'skipped';

export interface CaptionResult {
  text: string;
  costCny?: number;
}

export type Captioner = (input: {
  dataUrl: string;
  mimeType: string;
}) => Promise<CaptionResult>;

const DEFAULT_DAILY_COST_CNY = 2;
const DEFAULT_RESERVED_COST_CNY = 0.01;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_CAPTION_CHARS = 400;

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function endpoint(): string {
  const base = (process.env.CAPTION_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('CAPTION_API_BASE_URL 未配置');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function tokenCostCny(usage: Record<string, unknown> | undefined): number {
  const input = finite(usage?.prompt_tokens, 0);
  const output = finite(usage?.completion_tokens, 0);
  const inputRate = finite(process.env.CAPTION_INPUT_CNY_PER_MILLION, 0);
  const outputRate = finite(process.env.CAPTION_OUTPUT_CNY_PER_MILLION, 0);
  return (input * inputRate + output * outputRate) / 1_000_000;
}

const CAPTION_SYSTEM_PROMPT = [
  '你是图片转写器。优先逐字提取图中文字——聊天截图、通知、表单里的文字必须原样保留，',
  '再用一句话描述画面场景与关键细节。输出中文纯文本，不超过 200 字，',
  '格式「文字内容：…／画面：…」；图中无文字则只写「画面：…」。',
  '看不清的部分标注（不确定），不要编造。不要输出任何前后缀或解释。',
].join('');

export const captionWithVisionModel: Captioner = async ({ dataUrl }) => {
  const apiKey = process.env.CAPTION_API_KEY?.trim();
  if (!apiKey) throw new Error('CAPTION_API_KEY 未配置');
  const timeoutMs = finite(process.env.CAPTION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.CAPTION_MODEL?.trim() || 'gemini-flash-latest',
      stream: false,
      max_tokens: 500,
      temperature: 0,
      messages: [
        { role: 'system', content: CAPTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '转写这张图片。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: Record<string, unknown>;
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `caption HTTP ${response.status}`);
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('caption 模型返回空内容');
  return { text: text.slice(0, MAX_CAPTION_CHARS), costCny: tokenCostCny(payload.usage) };
};

/** 从 messages.meta JSON 里取反规范化的 caption 数组（历史链路的读取端）。 */
export function captionsFromMeta(meta: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(meta || '{}');
    const captions = parsed?.captions;
    if (!Array.isArray(captions)) return [];
    return captions.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  } catch {
    return [];
  }
}

export class CaptionService {
  constructor(
    private readonly db: Db,
    private readonly uploadsDir: string,
    private readonly log: (message: string) => void = () => {},
    private readonly captioner: Captioner = captionWithVisionModel
  ) {}

  get enabled(): boolean {
    return Boolean(process.env.CAPTION_API_KEY?.trim() && process.env.CAPTION_API_BASE_URL?.trim());
  }

  private setStatus(ids: number[], status: CaptionStatus): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE message_attachments SET caption_status = ? WHERE id IN (${placeholders})`
    ).run(status, ...ids);
  }

  private reserveDailyCost(limitCny: number, amountCny: number): boolean {
    if (limitCny <= 0) return true;
    const amount = Math.max(amountCny, 0);
    const reserve = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT cost_cny FROM caption_usage WHERE day = date('now', '+8 hours')"
      ).get() as { cost_cny: number } | undefined;
      if (finite(row?.cost_cny, 0) + amount > limitCny) return false;
      this.db.prepare(`
        INSERT INTO caption_usage (day, requests, cost_cny)
        VALUES (date('now', '+8 hours'), 1, ?)
        ON CONFLICT(day) DO UPDATE SET
          requests = requests + 1,
          cost_cny = cost_cny + excluded.cost_cny
      `).run(amount);
      return true;
    });
    return reserve();
  }

  private addDailyCost(amountCny: number): void {
    if (amountCny <= 0) return;
    this.db.prepare(`
      INSERT INTO caption_usage (day, requests, cost_cny)
      VALUES (date('now', '+8 hours'), 0, ?)
      ON CONFLICT(day) DO UPDATE SET cost_cny = cost_cny + excluded.cost_cny
    `).run(amountCny);
  }

  /**
   * 为一条消息的全部附件生成 caption。设计为 fire-and-forget（`void captions.captureMessage(id)`）；
   * 内部吞掉所有异常，只落 caption_status。
   */
  async captureMessage(messageId: number): Promise<void> {
    let attachments: AttachmentRow[];
    try {
      attachments = attachmentsForMessage(this.db, messageId);
    } catch (error) {
      this.log(`caption: 查附件失败 message=${messageId}: ${(error as Error).message}`);
      return;
    }
    if (attachments.length === 0) return;
    const ids = attachments.map((a) => a.id);

    if (!this.enabled) {
      this.setStatus(ids, 'skipped');
      return;
    }
    const dailyLimit = finite(process.env.CAPTION_DAILY_COST_CNY, DEFAULT_DAILY_COST_CNY);
    const reserved = finite(process.env.CAPTION_RESERVED_COST_CNY, DEFAULT_RESERVED_COST_CNY);

    this.setStatus(ids, 'pending');
    const results = new Map<number, { caption: string | null; status: CaptionStatus }>();
    for (const attachment of attachments) {
      if (!this.reserveDailyCost(dailyLimit, reserved)) {
        this.log(`caption skipped: dailyCostCny breaker (${dailyLimit})`);
        results.set(attachment.id, { caption: null, status: 'skipped' });
        continue;
      }
      try {
        const dataUrl = attachmentDataUrl(this.uploadsDir, attachment);
        const result = await this.captioner({ dataUrl, mimeType: attachment.mime_type });
        const actual = Math.max(finite(result.costCny, 0), 0);
        if (actual > reserved) this.addDailyCost(actual - reserved);
        results.set(attachment.id, { caption: result.text, status: 'done' });
      } catch (error) {
        this.log(`caption failed attachment=${attachment.id}: ${(error as Error).message}`);
        results.set(attachment.id, { caption: null, status: 'failed' });
      }
    }

    // 单事务：写回附件行 + 重建 messages.meta 的 $.captions（保留 meta 其余键）。
    try {
      const commit = this.db.transaction(() => {
        for (const attachment of attachments) {
          const r = results.get(attachment.id)!;
          this.db.prepare(
            'UPDATE message_attachments SET caption = ?, caption_status = ? WHERE id = ?'
          ).run(r.caption, r.status, attachment.id);
        }
        const captions = attachments
          .map((a) => results.get(a.id)?.caption)
          .filter((c): c is string => Boolean(c));
        if (captions.length > 0) {
          this.db.prepare(
            "UPDATE messages SET meta = json_set(COALESCE(meta, '{}'), '$.captions', json(?)) WHERE id = ?"
          ).run(JSON.stringify(captions), messageId);
        }
      });
      commit();
      const done = [...results.values()].filter((r) => r.status === 'done').length;
      if (done > 0) this.log(`caption done message=${messageId} images=${done}/${attachments.length}`);
    } catch (error) {
      this.log(`caption: 写回失败 message=${messageId}: ${(error as Error).message}`);
    }
  }

  /** 观测端点用：今日用量 + 各状态计数。 */
  health(): Record<string, unknown> {
    const usage = this.db.prepare(
      "SELECT requests, cost_cny FROM caption_usage WHERE day = date('now', '+8 hours')"
    ).get() as { requests: number; cost_cny: number } | undefined;
    const statuses = this.db.prepare(
      "SELECT caption_status AS status, COUNT(*) AS n FROM message_attachments GROUP BY caption_status"
    ).all() as Array<{ status: string; n: number }>;
    return {
      enabled: this.enabled,
      todayRequests: usage?.requests ?? 0,
      todayCostCny: Number((usage?.cost_cny ?? 0).toFixed(4)),
      statusCounts: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
    };
  }
}
