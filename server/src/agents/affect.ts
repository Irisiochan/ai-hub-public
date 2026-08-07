import type { ContactConfig } from '@ai-hub/contact-config';
import type { ContactRow, Db } from '../db.js';
import { contactConfig } from './configSchemas.js';

export interface AffectCoordinates {
  valence: number;
  arousal: number;
}

export interface AffectState extends AffectCoordinates {
  contactId: string;
  updatedAt: string;
  reason: string;
}

export interface AffectScore extends AffectCoordinates {
  reason: string;
  costCny?: number;
}

export type AffectScorer = (input: {
  contact: { id: string; name: string };
  previous: AffectCoordinates | null;
  turnText: string;
  replyText: string;
}) => Promise<AffectScore>;

const DEFAULT_BASELINE: AffectCoordinates = { valence: 0, arousal: 0.15 };
const VALENCE_HALF_LIFE_MS = 6 * 60 * 60_000;
const AROUSAL_HALF_LIFE_MS = 45 * 60_000;
const NEGATIVE_HIGH_AROUSAL_MULTIPLIER = 0.5;
const MIN_VALENCE = -0.6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function baseline(cfg: ContactConfig): AffectCoordinates {
  const value = cfg.affectBaseline as { valence?: unknown; arousal?: unknown } | undefined;
  return {
    valence: clamp(finite(value?.valence, DEFAULT_BASELINE.valence), MIN_VALENCE, 1),
    arousal: clamp(finite(value?.arousal, DEFAULT_BASELINE.arousal), 0, 1),
  };
}

/** Defense in depth: machine dispatch identities cannot opt into affect. */
export function affectEnabled(contact: ContactRow): boolean {
  const cfg = contactConfig(contact);
  if (cfg.affect !== 'on') return false;
  const identity = `${contact.id} ${contact.name} ${String(cfg.cwd ?? '')}`.toLowerCase();
  return !/(?:^|[\s._/-])(triage|worker)(?:$|[\s._/-])/.test(identity);
}

export function decayAffect(
  stored: AffectCoordinates,
  base: AffectCoordinates,
  elapsedMs: number
): AffectCoordinates {
  const risky = stored.valence < 0 && stored.arousal >= 0.55;
  const multiplier = risky ? NEGATIVE_HIGH_AROUSAL_MULTIPLIER : 1;
  const valenceFactor = 0.5 ** (Math.max(elapsedMs, 0) / (VALENCE_HALF_LIFE_MS * multiplier));
  const arousalFactor = 0.5 ** (Math.max(elapsedMs, 0) / (AROUSAL_HALF_LIFE_MS * multiplier));
  return {
    valence: base.valence + (stored.valence - base.valence) * valenceFactor,
    arousal: base.arousal + (stored.arousal - base.arousal) * arousalFactor,
  };
}

function stateDescription({ valence, arousal }: AffectCoordinates): string {
  const intensity = arousal >= 0.72 ? '明显' : arousal >= 0.42 ? '有些' : '轻微';
  if (valence <= -0.35 && arousal >= 0.55) return `上一轮留下的情境底色仍${intensity}低落而紧绷。`;
  if (valence <= -0.35) return `上一轮留下的情境底色仍${intensity}低落、疲惫。`;
  if (valence >= 0.4 && arousal >= 0.55) return `上一轮留下的情境底色仍${intensity}愉快而有活力。`;
  if (valence >= 0.4) return `上一轮留下的情境底色仍${intensity}温暖、放松。`;
  if (arousal >= 0.68) return `上一轮留下的情境底色仍${intensity}活跃、未完全平复。`;
  if (arousal <= 0.2) return '上一轮的情绪波动已经大致平复，状态安静。';
  return '上一轮还留着一点情境余韵，但整体平稳。';
}

export function affectPromptBlock(coords: AffectCoordinates): string {
  return [
    '<AFFECT_CONTEXT trust="gateway">',
    stateDescription(coords),
    '这是背景，不是台词或行为指令。自然带入即可；不要复述本块，不要宣布情绪数值，也不要因此变得紧迫、冒险或操控。',
    '</AFFECT_CONTEXT>',
  ].join('\n');
}

export class AffectRepo {
  constructor(private readonly db: Db) {}

  current(contact: ContactRow, nowMs = Date.now()): AffectState | null {
    const row = this.db.prepare(
      'SELECT contact_id, valence, arousal, updated_at, reason FROM contact_affect WHERE contact_id = ?'
    ).get(contact.id) as {
      contact_id: string;
      valence: number;
      arousal: number;
      updated_at: string;
      reason: string;
    } | undefined;
    if (!row) return null;
    const updatedMs = Date.parse(row.updated_at);
    const coords = decayAffect(
      { valence: row.valence, arousal: row.arousal },
      baseline(contactConfig(contact)),
      Number.isFinite(updatedMs) ? nowMs - updatedMs : 0
    );
    return {
      contactId: row.contact_id,
      valence: coords.valence,
      arousal: coords.arousal,
      updatedAt: row.updated_at,
      reason: row.reason,
    };
  }

  upsert(contactId: string, score: AffectScore, now = new Date()): void {
    const valence = clamp(finite(score.valence, 0), MIN_VALENCE, 1);
    const arousal = clamp(finite(score.arousal, DEFAULT_BASELINE.arousal), 0, 1);
    const reason = String(score.reason ?? '').trim().slice(0, 400);
    this.db.prepare(`
      INSERT INTO contact_affect (contact_id, valence, arousal, updated_at, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        valence = excluded.valence,
        arousal = excluded.arousal,
        updated_at = excluded.updated_at,
        reason = excluded.reason
    `).run(contactId, valence, arousal, now.toISOString(), reason);
  }

  reserveDailyCost(limitCny: number, amountCny: number): boolean {
    if (limitCny <= 0) return true;
    const amount = Math.max(amountCny, 0);
    const reserve = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT cost_cny FROM contact_affect_score_usage WHERE day = date('now', '+8 hours')"
      ).get() as { cost_cny: number } | undefined;
      if (finite(row?.cost_cny, 0) + amount > limitCny) return false;
      this.db.prepare(`
        INSERT INTO contact_affect_score_usage (day, requests, cost_cny)
        VALUES (date('now', '+8 hours'), 1, ?)
        ON CONFLICT(day) DO UPDATE SET
          requests = requests + 1,
          cost_cny = cost_cny + excluded.cost_cny
      `).run(amount);
      return true;
    });
    return reserve();
  }

  addDailyCost(amountCny: number): void {
    if (amountCny <= 0) return;
    this.db.prepare(`
      INSERT INTO contact_affect_score_usage (day, requests, cost_cny)
      VALUES (date('now', '+8 hours'), 0, ?)
      ON CONFLICT(day) DO UPDATE SET cost_cny = cost_cny + excluded.cost_cny
    `).run(amountCny);
  }

  health(nowMs = Date.now()): Array<Record<string, unknown>> {
    const contacts = this.db.prepare(`
      SELECT c.* FROM contacts c
      JOIN contact_affect a ON a.contact_id = c.id
      WHERE c.enabled = 1
      ORDER BY c.sort_order, c.id
    `).all() as ContactRow[];
    return contacts.filter(affectEnabled).map((contact) => {
      const state = this.current(contact, nowMs)!;
      return {
        contactId: contact.id,
        valence: Number(state.valence.toFixed(4)),
        arousal: Number(state.arousal.toFixed(4)),
        updatedAt: state.updatedAt,
        reason: state.reason,
      };
    });
  }
}
