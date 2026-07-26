import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_CATEGORIES = [
  'calendar',
  'file-change',
  'rss',
  'backlog',
  'message',
  'system',
  'daily',
  'other',
];

export const DEFAULT_DAILY_RECIPIENTS = ['cheng', 'cove', 'aye'];
export const DELIVERY_POOL_TASK = 'task';
export const DELIVERY_POOL_DAILY = 'daily';

const FINAL_STATES = new Set(['noop', 'dispatched', 'parked', 'dead']);
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function boundedText(value, max = 20_000) {
  const text = typeof value === 'string' ? value : stableJson(value);
  return text.trim().slice(0, max);
}

export function shanghaiDayStart(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - SHANGHAI_OFFSET_MS;
}

export function shanghaiClock(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    weekday: read('weekday'),
    hour: Number(read('hour')),
    minute: Number(read('minute')),
    second: Number(read('second')),
    label: `${read('year')}-${read('month')}-${read('day')} ${read('weekday')} ${read('hour')}:${read('minute')}:${read('second')} Asia/Shanghai`,
  };
}

// Silent window is half-open: [startHour, endHour) in Asia/Shanghai.
// Default 0–9 means 00:00 inclusive through 09:00 exclusive.
export function isShanghaiSilentHour(now = Date.now(), startHour = 0, endHour = 9) {
  const start = Math.max(0, Math.min(23, Number(startHour)));
  const end = Math.max(0, Math.min(24, Number(endHour)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const hour = shanghaiClock(now).hour;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function isDailyMode(sourceOrResult) {
  if (!sourceOrResult || typeof sourceOrResult !== 'object') return false;
  if (sourceOrResult.mode === 'daily') return true;
  if (sourceOrResult.category === 'daily') return true;
  if (sourceOrResult.categoryHint === 'daily') return true;
  if (sourceOrResult.category_hint === 'daily') return true;
  if (sourceOrResult.payload && typeof sourceOrResult.payload === 'object'
    && sourceOrResult.payload.mode === 'daily') {
    return true;
  }
  return false;
}

export function normalizeProactiveConfig(raw = {}) {
  const recipients = Array.isArray(raw.recipients) && raw.recipients.length
    ? raw.recipients.map((item) => String(item).trim()).filter(Boolean)
    : [...DEFAULT_DAILY_RECIPIENTS];
  return {
    enabled: raw.enabled !== false,
    dailyDispatchLimit: Math.max(0, Number(raw.dailyDispatchLimit ?? 10)),
    silentStartHour: Number.isFinite(Number(raw.silentStartHour)) ? Number(raw.silentStartHour) : 0,
    silentEndHour: Number.isFinite(Number(raw.silentEndHour)) ? Number(raw.silentEndHour) : 9,
    recipients,
  };
}

export function buildDailyCheckSummary(source = {}, now = Date.now()) {
  const clock = shanghaiClock(now);
  const base = typeof source.summary === 'string' && source.summary.trim()
    ? source.summary.trim()
    : 'Proactive daily companion check for Iris.';
  const recipients = Array.isArray(source.recipients) && source.recipients.length
    ? source.recipients.join(', ')
    : DEFAULT_DAILY_RECIPIENTS.join(', ');
  return [
    base,
    `Current local time: ${clock.label}.`,
    'Quiet hours are 00:00–09:00 Asia/Shanghai; this wake should only fire outside that window.',
    'Decide whether a proactive message to Iris is worthwhile right now.',
    'Allowed intents: care/health/routine nudges, practical reminders, light chat openers, or small affectionate check-ins.',
    'Be selective — not every wake needs a message. Prefer NO_OP when nothing natural fits.',
    `If actionable, set category to "daily" and choose exactly one suggestedRecipient among: ${recipients}.`,
    'Route by tone and relationship fit; do not invent other recipients.',
  ].join('\n');
}

export function timerSchedule(source) {
  const intervalMs = Math.max(15 * 60_000, Number(source?.intervalMinutes ?? 15) * 60_000);
  const jitterMs = Math.max(0, Number(source?.jitterSeconds ?? 900) * 1000);
  return { intervalMs, jitterMs };
}

// Jitter is added on top of a full interval instead of sliding inside a fixed
// grid, so two consecutive wakes are never closer than intervalMs. The wall
// clock dedupe bucket in triage-worker.mjs relies on that spacing to stay
// collision free.
export function nextTimerDelay(source, { first = false, random = Math.random } = {}) {
  const { intervalMs, jitterMs } = timerSchedule(source);
  const jitter = Math.floor(random() * (jitterMs + 1));
  return first ? jitter : intervalMs + jitter;
}

export function eventId(event) {
  const explicit = typeof event.id === 'string' ? event.id.trim() : '';
  if (explicit) return explicit.slice(0, 200);
  const dedupe = event.dedupeKey ?? event.payload ?? event.summary ?? '';
  return crypto
    .createHash('sha256')
    .update(`${event.source ?? 'unknown'}\0${stableJson(dedupe)}`)
    .digest('hex');
}

export function normalizeEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('event must be an object');
  const source = boundedText(event.source ?? 'unknown', 100);
  const summary = boundedText(event.summary ?? event.payload ?? '', 20_000);
  if (!summary) throw new Error('event must carry real context in summary or payload');
  return {
    id: eventId(event),
    source,
    summary,
    payload: event.payload ?? null,
    categoryHint: boundedText(event.categoryHint ?? '', 80) || null,
    createdAt: Number.isFinite(event.createdAt) ? Number(event.createdAt) : Date.now(),
  };
}

export function parseTriageJson(raw, categories = DEFAULT_CATEGORIES) {
  if (typeof raw !== 'string') throw new Error('triage response must be text');
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('triage response did not contain a JSON object');
  const value = JSON.parse(text.slice(start, end + 1));
  if (typeof value.actionable !== 'boolean') throw new Error('triage actionable must be boolean');
  if (!categories.includes(value.category)) throw new Error(`triage category is invalid: ${value.category}`);
  if (![1, 2, 3].includes(value.priority)) throw new Error('triage priority must be 1, 2, or 3');
  if (
    value.suggestedRecipient !== null
    && value.suggestedRecipient !== undefined
    && (typeof value.suggestedRecipient !== 'string' || !value.suggestedRecipient.trim())
  ) {
    throw new Error('triage suggestedRecipient must be a non-empty string or null');
  }
  if (typeof value.rationale !== 'string' || !value.rationale.trim()) {
    throw new Error('triage rationale must be a non-empty string');
  }
  return {
    actionable: value.actionable,
    category: value.category,
    priority: value.priority,
    suggestedRecipient: value.suggestedRecipient?.trim().slice(0, 200) || null,
    rationale: value.rationale.trim().slice(0, 1000),
  };
}

export function estimateCostCny(usage, pricing = {}) {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const inputRate = Number(pricing.inputCnyPerMillion ?? 0);
  const outputRate = Number(pricing.outputCnyPerMillion ?? 0);
  if (![input, output, inputRate, outputRate].every(Number.isFinite)) return 0;
  return (input * inputRate + output * outputRate) / 1_000_000;
}

export function contactRoute(contact) {
  const raw = contact?.config?.routing;
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((item) => typeof item === 'string')
    : [];
  return {
    recipientKey: typeof raw.recipientKey === 'string' && raw.recipientKey.trim()
      ? raw.recipientKey.trim()
      : contact.id,
    categories,
    minPriority: [1, 2, 3].includes(Number(raw.minPriority)) ? Number(raw.minPriority) : 1,
    dailyLimit: Number.isFinite(Number(raw.dailyLimit))
      ? Math.max(1, Math.min(1000, Number(raw.dailyLimit)))
      : 10,
    cooldownMinutes: Number.isFinite(Number(raw.cooldownMinutes))
      ? Math.max(0, Math.min(24 * 60, Number(raw.cooldownMinutes)))
      : 30,
    fallback: raw.fallback === true,
  };
}

function contactKeys(contact) {
  const route = contactRoute(contact);
  return new Set([
    contact?.id,
    contact?.name,
    route?.recipientKey,
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim().toLowerCase()));
}

export function chooseRecipient({
  contacts,
  result,
  rules = {},
  usageOf = () => ({ count: 0, lastAt: null }),
  now = Date.now(),
  allowedRecipientKeys = null,
  ignoreRecipientLimits = false,
  modelOnly = false,
}) {
  const allowed = Array.isArray(allowedRecipientKeys) && allowedRecipientKeys.length
    ? new Set(allowedRecipientKeys.map((item) => String(item).trim().toLowerCase()).filter(Boolean))
    : null;
  // modelOnly (daily proactive): never let the static rules table override L1.
  const target = modelOnly
    ? (result.suggestedRecipient ?? null)
    : (rules[result.category] ?? result.suggestedRecipient ?? null);
  const targetKey = typeof target === 'string' ? target.trim().toLowerCase() : null;
  const candidates = contacts
    .filter((contact) => contact?.enabled !== false)
    .map((contact) => ({ contact, route: contactRoute(contact) }))
    .filter(({ contact, route }) => {
      const keys = contactKeys(contact);
      if (allowed) {
        const inAllow = [...keys].some((key) => allowed.has(key));
        if (!inAllow) return false;
      }
      if (targetKey && keys.has(targetKey)) return true;
      if (modelOnly) return false;
      return route
        && route.categories.includes(result.category)
        && result.priority >= route.minPriority;
    })
    .sort((a, b) => {
      const aTarget = targetKey && contactKeys(a.contact).has(targetKey) ? 0 : 1;
      const bTarget = targetKey && contactKeys(b.contact).has(targetKey) ? 0 : 1;
      if (aTarget !== bTarget) return aTarget - bTarget;
      const aBusy = a.contact.state && a.contact.state !== 'idle' ? 1 : 0;
      const bBusy = b.contact.state && b.contact.state !== 'idle' ? 1 : 0;
      return aBusy - bBusy;
    });

  let busy = false;
  let limited = false;
  for (const candidate of candidates) {
    const { contact, route } = candidate;
    if (contact.state && contact.state !== 'idle') {
      busy = true;
      continue;
    }
    const policy = route ?? {
      dailyLimit: 10,
      cooldownMinutes: 30,
    };
    if (!ignoreRecipientLimits) {
      const usage = usageOf(contact.id);
      const cooldownMs = policy.cooldownMinutes * 60_000;
      if (usage.count >= policy.dailyLimit || (usage.lastAt && now - usage.lastAt < cooldownMs)) {
        limited = true;
        continue;
      }
    }
    return {
      contact,
      route: policy,
      reason: targetKey ? (modelOnly ? 'model-suggestion' : 'explicit-or-rule') : 'category-profile',
    };
  }
  return {
    contact: null,
    reason: busy ? 'all-candidates-busy' : limited ? 'all-candidates-rate-limited' : 'no-route',
  };
}

export class TriageStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.closed = false;
    this.db = new DatabaseSync(path.resolve(file));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS triage_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT,
        category_hint TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        triage_result TEXT,
        recipient_id TEXT,
        error TEXT,
        cost_cny REAL NOT NULL DEFAULT 0,
        triage_latency_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_triage_events_claim
        ON triage_events(status, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS triage_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        pool TEXT NOT NULL DEFAULT 'task',
        FOREIGN KEY(event_id) REFERENCES triage_events(id)
      );
      CREATE INDEX IF NOT EXISTS idx_triage_deliveries_recipient
        ON triage_deliveries(recipient_id, delivered_at);
      CREATE INDEX IF NOT EXISTS idx_triage_deliveries_pool
        ON triage_deliveries(pool, delivered_at);
      CREATE TABLE IF NOT EXISTS triage_source_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = new Set(
      this.db.prepare('PRAGMA table_info(triage_events)').all().map((column) => column.name),
    );
    if (!columns.has('triage_latency_ms')) {
      this.db.exec('ALTER TABLE triage_events ADD COLUMN triage_latency_ms INTEGER');
    }
    const deliveryColumns = new Set(
      this.db.prepare('PRAGMA table_info(triage_deliveries)').all().map((column) => column.name),
    );
    if (!deliveryColumns.has('pool')) {
      this.db.exec(`ALTER TABLE triage_deliveries ADD COLUMN pool TEXT NOT NULL DEFAULT 'task'`);
    }
  }

  enqueue(input) {
    const event = normalizeEvent(input);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO triage_events
        (id, source, summary, payload, category_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.source,
      event.summary,
      event.payload === null ? null : stableJson(event.payload),
      event.categoryHint,
      event.createdAt,
      Date.now(),
    );
    return { id: event.id, inserted: result.changes === 1 };
  }

  recoverStale(timeoutMs, now = Date.now()) {
    return this.db.prepare(`
      UPDATE triage_events
      SET status = 'queued', next_attempt_at = ?, updated_at = ?, error = 'recovered stale processing lease'
      WHERE status = 'processing' AND updated_at < ?
    `).run(now, now, now - timeoutMs).changes;
  }

  claim(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM triage_events
        WHERE status IN ('queued', 'retry') AND next_attempt_at <= ?
        ORDER BY created_at, id
        LIMIT 1
      `).get(now);
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`
        UPDATE triage_events
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      this.db.exec('COMMIT');
      return {
        ...row,
        status: 'processing',
        attempts: row.attempts + 1,
        payload: row.payload ? JSON.parse(row.payload) : null,
        triageResult: row.triage_result ? JSON.parse(row.triage_result) : null,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finish(id, status, fields = {}, now = Date.now()) {
    if (!FINAL_STATES.has(status)) throw new Error(`invalid final status: ${status}`);
    this.db.prepare(`
      UPDATE triage_events
      SET status = ?, updated_at = ?, triage_result = ?, recipient_id = ?,
          error = ?, cost_cny = ?, triage_latency_ms = ?
      WHERE id = ?
    `).run(
      status,
      now,
      fields.triageResult ? stableJson(fields.triageResult) : null,
      fields.recipientId ?? null,
      fields.error ? boundedText(fields.error, 2000) : null,
      Number(fields.costCny ?? 0),
      Number.isFinite(Number(fields.triageLatencyMs)) ? Math.max(0, Math.round(Number(fields.triageLatencyMs))) : null,
      id,
    );
  }

  retry(id, error, delayMs, fields = {}, now = Date.now()) {
    this.db.prepare(`
      UPDATE triage_events
      SET status = 'retry', next_attempt_at = ?, updated_at = ?, error = ?,
          triage_result = COALESCE(?, triage_result), cost_cny = ?,
          triage_latency_ms = COALESCE(?, triage_latency_ms)
      WHERE id = ?
    `).run(
      now + Math.max(1000, delayMs),
      now,
      boundedText(error, 2000),
      fields.triageResult ? stableJson(fields.triageResult) : null,
      Number(fields.costCny ?? 0),
      Number.isFinite(Number(fields.triageLatencyMs)) ? Math.max(0, Math.round(Number(fields.triageLatencyMs))) : null,
      id,
    );
  }

  recordDelivery(eventIdValue, recipientId, now = Date.now(), pool = DELIVERY_POOL_TASK) {
    const normalizedPool = pool === DELIVERY_POOL_DAILY ? DELIVERY_POOL_DAILY : DELIVERY_POOL_TASK;
    this.db.prepare(`
      INSERT INTO triage_deliveries (event_id, recipient_id, delivered_at, pool)
      VALUES (?, ?, ?, ?)
    `).run(eventIdValue, recipientId, now, normalizedPool);
  }

  // Task dispatches use a rolling 24h window and only count the task pool, so
  // proactive daily outreach does not burn per-recipient work quotas.
  recipientUsage(recipientId, now = Date.now(), pool = DELIVERY_POOL_TASK) {
    const since = now - 24 * 60 * 60_000;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(delivered_at) AS last_at
      FROM triage_deliveries
      WHERE recipient_id = ? AND delivered_at >= ? AND COALESCE(pool, 'task') = ?
    `).get(recipientId, since, pool);
    return { count: Number(row.count), lastAt: row.last_at === null ? null : Number(row.last_at) };
  }

  // Daily proactive cap is a Shanghai calendar-day total across all recipients.
  poolUsage(pool = DELIVERY_POOL_DAILY, now = Date.now()) {
    const start = shanghaiDayStart(now);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM triage_deliveries
      WHERE delivered_at >= ? AND COALESCE(pool, 'task') = ?
    `).get(start, pool);
    return { count: Number(row.count), since: start };
  }

  dailySummary(now = Date.now()) {
    // Business-day metrics are pinned to Asia/Shanghai, independent of host timezone.
    const start = shanghaiDayStart(now);
    const statuses = this.db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(cost_cny), 0) AS cost
      FROM triage_events WHERE created_at >= ? GROUP BY status
    `).all(start);
    const fallback = this.db.prepare(`
      SELECT COUNT(*) AS count FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"fallbackUsed":true%'
    `).get(start);
    const deliveries = this.db.prepare(`
      SELECT recipient_id, COUNT(*) AS count
      FROM triage_deliveries WHERE delivered_at >= ?
      GROUP BY recipient_id ORDER BY count DESC
    `).all(start);
    const poolRows = this.db.prepare(`
      SELECT COALESCE(pool, 'task') AS pool, COUNT(*) AS count
      FROM triage_deliveries WHERE delivered_at >= ?
      GROUP BY COALESCE(pool, 'task')
    `).all(start);
    const latency = this.db.prepare(`
      SELECT COUNT(*) AS count, AVG(triage_latency_ms) AS average
      FROM triage_events
      WHERE created_at >= ? AND triage_latency_ms IS NOT NULL
    `).get(start);
    const total = statuses.reduce((sum, row) => sum + Number(row.count), 0);
    const noop = statuses.find((row) => row.status === 'noop');
    const pools = Object.fromEntries(poolRows.map((row) => [row.pool, Number(row.count)]));
    return {
      since: new Date(start).toISOString(),
      total,
      noopRatio: total ? Number(noop?.count ?? 0) / total : 0,
      fallbackCount: Number(fallback.count),
      costCny: statuses.reduce((sum, row) => sum + Number(row.cost), 0),
      triagedCount: Number(latency.count),
      avgTriageLatencyMs: latency.average === null ? null : Math.round(Number(latency.average)),
      statuses,
      deliveries,
      pools,
      dailyPoolDispatched: pools[DELIVERY_POOL_DAILY] ?? 0,
    };
  }

  getSourceState(key) {
    return this.db.prepare('SELECT value FROM triage_source_state WHERE key = ?').get(key)?.value ?? null;
  }

  setSourceState(key, value, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO triage_source_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), now);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
