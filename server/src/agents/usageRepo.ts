import type { Db } from '../db.js';

export interface UsageBucket {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface UsageSummary {
  today: UsageBucket;
  total: UsageBucket;
  last: UsageBucket;
}

interface UsageRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation: number | null;
  cache_read: number | null;
}

const empty = (): UsageBucket => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

function bucket(row: UsageRow | undefined): UsageBucket {
  if (!row) return empty();
  return {
    input: row.input_tokens ?? 0,
    output: row.output_tokens ?? 0,
    cacheCreation: row.cache_creation ?? 0,
    cacheRead: row.cache_read ?? 0,
  };
}

/** Indexed usage queries backed by migration-maintained message_usage/usage_daily tables. */
export class UsageRepo {
  private readonly total;
  private readonly todayShanghai;
  private readonly todayOffset;
  private readonly last;

  constructor(db: Db) {
    this.total = db.prepare(
      `SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_creation) AS cache_creation, SUM(cache_read) AS cache_read
       FROM usage_daily WHERE contact_id = ?`
    );
    this.todayShanghai = db.prepare(
      `SELECT input_tokens, output_tokens, cache_creation, cache_read
       FROM usage_daily WHERE contact_id = ? AND day = date('now', '+8 hours')`
    );
    this.todayOffset = db.prepare(
      `SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_creation) AS cache_creation, SUM(cache_read) AS cache_read
       FROM message_usage
       WHERE contact_id = ? AND date(occurred_at, ?) = date('now', ?)`
    );
    this.last = db.prepare(
      `SELECT input_tokens, output_tokens, cache_creation, cache_read
       FROM message_usage WHERE contact_id = ? ORDER BY message_id DESC LIMIT 1`
    );
  }

  summary(contactId: string, tzOffset = -480): UsageSummary {
    const bounded = Number.isFinite(tzOffset) ? Math.max(-840, Math.min(840, tzOffset)) : -480;
    const modifierMinutes = -bounded;
    const modifier = `${modifierMinutes >= 0 ? '+' : ''}${modifierMinutes} minutes`;
    const today = bounded === -480
      ? bucket(this.todayShanghai.get(contactId) as UsageRow | undefined)
      : bucket(this.todayOffset.get(contactId, modifier, modifier) as UsageRow | undefined);
    return {
      today,
      total: bucket(this.total.get(contactId) as UsageRow | undefined),
      last: bucket(this.last.get(contactId) as UsageRow | undefined),
    };
  }
}
