import type { VaultClient } from './vaultClient.js';

/**
 * Write path of the memory layer: after each completed turn the gateway runs
 * cheap trigger heuristics over the exchange. On a hit, the exchange is parked
 * in inbox/ (tagged hub-auto) — 按库规矩，拿不准的进 inbox，之后由人/AI 整理晋升。
 * 不追求聪明，追求"绝不漏掉明显该记的"。
 */

interface Trigger {
  re: RegExp;
  reason: string;
}

const TRIGGERS: Trigger[] = [
  { re: /\d{1,2}月\d{1,2}[日号]|明天|今晚|下+周|大?后天|周[一二三四五六日天]|下个?月|月底|年底|[一二三四五六七八九十两\d]{1,2}点半?(见|集合|出发|开始|叫|喊)/, reason: '时间与计划' },
  { re: /答应|约好|说好(?=要|会|去|给)|说好了(?!吗|没|没有|么|嘛)|敲定|定好|要记得|记一下|帮我记|写进记忆库|别忘|提醒我|待办/, reason: '承诺与待办' },
  { re: /最喜欢|超喜欢|最讨厌|过敏|不吃|不能吃|爱吃|雷点|口味|尺码|偏好是/, reason: '偏好' },
  { re: /生日|纪念日|周年|第一次|搬家|离职|入职|面试|offer|录取|考试|体检|医院|确诊|受伤|分手|表白/, reason: '人生事件' },
  { re: /以后都|从今以后|往后|长期|每次都要|定个规矩|咱们约定|新习惯/, reason: '长期约定' },
];

const RATE_LIMIT_MS = 10 * 60_000;
const MAX_CAPTURE_TEXT_CHARS = 6000;
const REVIEW_TIMEOUT_MS = 10_000;
const REVIEW_CAPTURE_THRESHOLD = 0.8;
const REVIEW_REJECT_THRESHOLD = 0.2;
const lastCapture = new Map<string, number>();

const WORKER_RECEIPT_RE = /^⚙\s*Worker 任务回执（网关自动通知，Iris 也看得到这条）/;

export interface CaptureReview {
  decision: 'capture' | 'reject' | 'pending';
  confidence: number | null;
  category: string | null;
  subject: string | null;
  due: string | null;
  isCommitment: boolean | null;
  detail?: string;
}

export type CaptureReviewer = (text: string, triggerReason: string) => Promise<CaptureReview>;

export function isSystemReceipt(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return WORKER_RECEIPT_RE.test(text.trim())
    || (
      normalized.includes('Worker 任务回执')
      && normalized.includes('网关自动通知')
      && normalized.includes('交付状态：')
    );
}

export function detectTrigger(text: string): string | null {
  if (isSystemReceipt(text)) return null;
  for (const t of TRIGGERS) {
    if (t.re.test(text)) return t.reason;
  }
  return null;
}

export function clipCaptureText(text: string, limit = MAX_CAPTURE_TEXT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[原文过长：已保留前 ${limit} 字，其余内容仍可在 ai-hub 对话历史中查看]`;
}

function reviewEndpoint(): string {
  const base = (process.env.DEEPSEEK_API_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function pendingReview(detail: string): CaptureReview {
  return {
    decision: 'pending',
    confidence: null,
    category: null,
    subject: null,
    due: null,
    isCommitment: null,
    detail,
  };
}

export const reviewCaptureWithDeepSeek: CaptureReviewer = async (text, triggerReason) => {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return pendingReview('DEEPSEEK_API_KEY 未配置');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
  try {
    const response = await fetch(reviewEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_CAPTURE_MODEL?.trim() || 'deepseek-v4-flash',
        thinking: { type: 'disabled' },
        stream: false,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是私人记忆库的精筛器，只判断用户原话是否值得进入待确认 inbox。',
              '输出 JSON，字段固定为：should_capture(boolean), is_commitment(boolean),',
              'due(string|null), subject(string), confidence(number 0..1),',
              'category("commitment"|"preference"|"life_event"|"long_term_rule"|"other").',
              'confidence 表示“这条内容值得进入记忆待审”的概率：0=明确不值得，1=明确值得。',
              'should_capture 应与 confidence 一致：>=0.8 为 true，<=0.2 为 false，中间值按不确定处理。',
              '只有明确、可复用的事实、偏好、承诺、日期或人生事件才应捕捉。',
              '闲聊、玩笑、转述、系统通知、Worker 回执、仅含关键词但无具体内容的句子应拒绝。',
              '不补充原文没有的信息。低把握时降低 confidence。',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              trigger_reason: triggerReason,
              text: clipCaptureText(text, 4000),
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return pendingReview(`DeepSeek HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) return pendingReview('DeepSeek 返回空内容');

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return pendingReview('DeepSeek confidence 无效');
    }
    const shouldCapture = parsed.should_capture === true;
    const decision =
      shouldCapture && confidence >= REVIEW_CAPTURE_THRESHOLD
        ? 'capture'
        : !shouldCapture && confidence <= REVIEW_REJECT_THRESHOLD
          ? 'reject'
          : 'pending';
    return {
      decision,
      confidence,
      category: typeof parsed.category === 'string' ? parsed.category : null,
      subject: typeof parsed.subject === 'string' ? parsed.subject : null,
      due: typeof parsed.due === 'string' ? parsed.due : null,
      isCommitment: typeof parsed.is_commitment === 'boolean' ? parsed.is_commitment : null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return pendingReview(`DeepSeek 审查失败：${detail}`);
  } finally {
    clearTimeout(timeout);
  }
};

export async function maybeCapture(
  vault: VaultClient,
  contact: { id: string; name: string },
  userText: string,
  replyText: string,
  log: (msg: string) => void,
  reviewer: CaptureReviewer = reviewCaptureWithDeepSeek
): Promise<void> {
  // Only Iris's original message may trigger capture. Model replies often repeat
  // dates, preferences and TODO words from injected memory or room transcripts;
  // treating those words as new user facts creates self-echo and identity bleed.
  const reason = detectTrigger(userText);
  if (!reason) return;

  const last = lastCapture.get(contact.id) ?? 0;
  if (Date.now() - last < RATE_LIMIT_MS) return;

  const review = await reviewer(userText, reason);
  if (review.decision === 'reject') {
    log(`memory capture (${reason}) rejected by DeepSeek (${review.confidence?.toFixed(2)})`);
    return;
  }
  lastCapture.set(contact.id, Date.now());

  const slug = `hub-auto-${contact.id}-${new Date().toISOString().slice(11, 16).replace(':', '')}`;
  const title = `[hub-auto] ${reason}：${userText.replace(/\s+/g, ' ').slice(0, 48)}`;
  const contentParts = [
    `网关自动捕捉（触发类别：${reason}，联系人：${contact.name}）。`,
    '内容未经确认——整理时采纳则 promote 或改写进 memories/，误报直接删。',
    review.decision === 'pending'
      ? `DeepSeek 精筛待处理：${review.detail ?? '置信度不足'}。`
      : `DeepSeek 精筛：${review.category ?? 'other'}，置信度 ${review.confidence?.toFixed(2) ?? '未知'}。`,
    '',
    `**Iris**：${clipCaptureText(userText)}`,
  ];
  if (replyText.trim()) {
    contentParts.push('', `**${contact.name}**：${clipCaptureText(replyText)}`);
  }
  const content = contentParts.join('\n');
  const reviewTags = review.decision === 'pending'
    ? ['llm-review-pending']
    : ['llm-reviewed', review.category ?? 'other'];

  const result = await vault.write('write_inbox', {
    slug,
    title,
    content,
    tags: ['hub-auto', contact.id, reason, ...reviewTags],
    source: 'hub-auto',
  });
  log(`memory capture (${reason}) → inbox ${result === 'ok' ? '✓' : '(outbox queued)'}`);
}
