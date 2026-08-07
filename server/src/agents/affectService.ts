import type { ContactRow, Db } from '../db.js';
import {
  AffectRepo,
  affectEnabled,
  affectPromptBlock,
  type AffectCoordinates,
  type AffectScore,
  type AffectScorer,
} from './affect.js';

const MAX_TEXT_CHARS = 6000;
const DEFAULT_DAILY_COST_CNY = 5;
const DEFAULT_RESERVED_COST_CNY = 0.002;
const SCORE_TIMEOUT_MS = 30_000;

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function endpoint(): string {
  const base = (process.env.DEEPSEEK_API_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function tokenCostCny(usage: Record<string, unknown> | undefined): number {
  const input = finite(usage?.prompt_tokens, 0);
  const output = finite(usage?.completion_tokens, 0);
  const inputRate = finite(process.env.DEEPSEEK_FLASH_INPUT_CNY_PER_MILLION, 0);
  const outputRate = finite(process.env.DEEPSEEK_FLASH_OUTPUT_CNY_PER_MILLION, 0);
  return (input * inputRate + output * outputRate) / 1_000_000;
}

export const scoreAffectWithDeepSeek: AffectScorer = async (input) => {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未配置');
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_CAPTURE_MODEL?.trim() || 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      stream: false,
      max_tokens: 180,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是对话情境连续性的旁路评分器。只估计 AI 联系人在本轮回复结束时表现出的状态，不评估用户。',
            '输出严格 JSON：valence(number -1..1), arousal(number 0..1), reason(string)。',
            'valence 是愉快到不愉快，arousal 是平静到激活。根据语义和互动情境评分，不按情绪词机械匹配。',
            'previous 只是衰减后的上一轮参考；新文本证据优先。reason 只写一句可审计依据，不写建议或行为指令。',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            contact: input.contact,
            previous: input.previous,
            turn: input.turnText.slice(0, MAX_TEXT_CHARS),
            reply: input.replyText.slice(0, MAX_TEXT_CHARS),
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: Record<string, unknown>;
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `DeepSeek HTTP ${response.status}`);
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('DeepSeek 返回空 affect JSON');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const valence = Number(parsed.valence);
  const arousal = Number(parsed.arousal);
  if (!Number.isFinite(valence) || valence < -1 || valence > 1) throw new Error('valence 无效');
  if (!Number.isFinite(arousal) || arousal < 0 || arousal > 1) throw new Error('arousal 无效');
  return {
    valence,
    arousal,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    costCny: tokenCostCny(payload.usage),
  };
};

export class AffectService {
  readonly repo: AffectRepo;

  constructor(
    db: Db,
    private readonly log: (message: string) => void,
    private readonly scorer: AffectScorer = scoreAffectWithDeepSeek
  ) {
    this.repo = new AffectRepo(db);
  }

  turnBlock(contact: ContactRow, allowAffect: boolean): string {
    if (!allowAffect || !affectEnabled(contact)) return '';
    const state = this.repo.current(contact);
    return state ? affectPromptBlock(state) : '';
  }

  async scoreAfterTurn(contact: ContactRow, turnText: string, replyText: string): Promise<boolean> {
    if (!affectEnabled(contact) || !turnText.trim() || !replyText.trim()) return false;
    const dailyLimit = finite(process.env.AFFECT_DAILY_COST_CNY, DEFAULT_DAILY_COST_CNY);
    const reserved = finite(process.env.AFFECT_SCORE_RESERVED_COST_CNY, DEFAULT_RESERVED_COST_CNY);
    if (!this.repo.reserveDailyCost(dailyLimit, reserved)) {
      this.log(`affect score skipped: dailyCostCny breaker (${dailyLimit})`);
      return false;
    }
    try {
      const previous = this.repo.current(contact);
      const score = await this.scorer({
        contact: { id: contact.id, name: contact.name },
        previous: previous ? { valence: previous.valence, arousal: previous.arousal } : null,
        turnText,
        replyText,
      });
      const actual = Math.max(finite(score.costCny, 0), 0);
      if (actual > reserved) this.repo.addDailyCost(actual - reserved);
      this.repo.upsert(contact.id, score);
      this.log(`affect state updated contact=${contact.id}`);
      return true;
    } catch (error) {
      this.log(`affect score failed; previous state kept: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

export type { AffectCoordinates, AffectScore };
