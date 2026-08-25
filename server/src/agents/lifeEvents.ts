import type { ContactRow, Db } from '../db.js';
import { isSystemReceipt, stripQuotedLines } from '../memory/capture.js';
import { contactConfig } from './configSchemas.js';
import { historicalMessageText } from './sideChannel.js';

/**
 * 跨联系人生活事件（daily check-in P3 S2/S3）。
 *
 * 起因：User 在Claude的会话里聊了暴雨倒灌进水断电，切到 Codex 问「我现在什么状态」，
 * Codex 的自动上下文只有静态 facts。这里把「User 自述的高时效生活状态」提取成
 * 演进式事件（同一件事多次 update），存进 life_events 表，供其他联系人每轮注入续接。
 *
 * 提取两级：本地正则闸（零成本）→ DeepSeek flash 结构化抽取（confidence 门槛）。
 * 隐私边界：只提取现实生活状态；亲密内容、关系互动、对他人隐私的转述一律排除，
 * 原文永不入表，只存 ≤80 字的事实句。
 */

export type LifeEventSeverity = 'safety' | 'health' | 'schedule' | 'mood';
export type LifeEventStatus = 'active' | 'resolved' | 'expired';

export interface LifeEventRow {
  id: number;
  severity: LifeEventSeverity;
  status: LifeEventStatus;
  summary: string;
  timeline: string; // JSON [{at, contactId, note}]
  source_contact_id: string;
  last_message_id: number | null;
  first_at: string;
  updated_at: string;
}

export interface LifeEventChange {
  action: 'new' | 'update' | 'resolve';
  id?: number;
  severity: LifeEventSeverity;
  summary: string;
  note: string;
  confidence: number;
}

export interface LifeEventExtractInput {
  contact: { id: string; name: string };
  windowText: string;
  activeEvents: Array<Pick<LifeEventRow, 'id' | 'severity' | 'summary' | 'updated_at' | 'source_contact_id'>>;
  nowShanghai: string;
}

export interface LifeEventExtractResult {
  events: LifeEventChange[];
  costCny?: number;
}

export type LifeEventExtractor = (input: LifeEventExtractInput) => Promise<LifeEventExtractResult>;

/** TTL 按 severity：安全事件留最久，情绪最短。update 刷新 updated_at 即续期。 */
export const LIFE_EVENT_TTL_HOURS: Record<LifeEventSeverity, number> = {
  safety: 48,
  health: 24,
  schedule: 12,
  mood: 6,
};

const SEVERITY_ORDER: LifeEventSeverity[] = ['safety', 'health', 'schedule', 'mood'];
const SEVERITY_LABEL: Record<LifeEventSeverity, string> = {
  safety: '安全',
  health: '健康',
  schedule: '作息',
  mood: '状态',
};

/** 一级本地正则闸。mood 故意没有正则：情绪本体归 affect 管，mood 事件只允许 LLM 顺带产出。 */
export const LIFE_EVENT_TRIGGERS: Array<{ severity: LifeEventSeverity; re: RegExp }> = [
  {
    severity: 'safety',
    re: /暴雨|积水|倒灌|进水|淹|漏水|停电|断电|跳闸|着火|火灾|烟味|煤气|地震|台风|受伤|流血|摔(了|伤)|烫伤|急诊|救护车|120/,
  },
  {
    severity: 'health',
    re: /发烧|头疼|胃疼|恶心|生病|吃药|过敏|痛经|不舒服|难受/,
  },
  {
    severity: 'schedule',
    re: /睡了.{0,4}(小时|钟头)|补觉|通宵|熬夜|刚醒|睡醒|出门|到家|回家|搬家|加班到|值班/,
  },
];

const RATE_LIMIT_MS = 5 * 60_000;
const DEFAULT_DAILY_COST_CNY = 2;
const DEFAULT_RESERVED_COST_CNY = 0.002;
const EXTRACT_TIMEOUT_MS = 15_000;
const CONFIDENCE_THRESHOLD = 0.7;
const WINDOW_MINUTES = 60;
const WINDOW_MAX_MESSAGES = 10;
const MAX_SUMMARY_CHARS = 120;
const MAX_NOTE_CHARS = 100;
const MAX_TIMELINE_ENTRIES = 20;
const BLOCK_MAX_CHARS = 700;
const BLOCK_MAX_EVENTS = 5;
const BLOCK_MAX_SAFETY = 3;
const CAPTION_PENDING_RETRY_MS = 10_000;

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Defense in depth（同 affectEnabled）：机器派单身份不许参与生活事件。 */
export function lifeEventsEnabled(contact: ContactRow): boolean {
  const cfg = contactConfig(contact) as Record<string, unknown>;
  if (cfg.lifeEvents !== 'on') return false;
  const identity = `${contact.id} ${contact.name} ${String(cfg.cwd ?? '')}`.toLowerCase();
  return !/(?:^|[\s._/-])(triage|worker)(?:$|[\s._/-])/.test(identity);
}

/** 命中的最高优先级触发类别；没命中返回 null（不花钱）。 */
export function detectLifeEventTrigger(text: string): LifeEventSeverity | null {
  if (isSystemReceipt(text)) return null;
  const own = stripQuotedLines(text);
  if (!own) return null;
  for (const trigger of LIFE_EVENT_TRIGGERS) {
    if (trigger.re.test(own)) return trigger.severity;
  }
  return null;
}

/** 上海时间 MM-DD HH:mm（与 journal 的 +8 小时口径一致），用于注入块展示。 */
export function shanghaiStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 8 * 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
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

const EXTRACT_SYSTEM_PROMPT = [
  '你是跨会话生活状态提取器。输入是 User（用户本人）最近的消息片段（含 [图片内容：…] 转写）',
  '和当前已记录的进行中事件列表。任务：提取/更新 User 自述的现实生活状态事件。',
  '输出严格 JSON：{"events":[{"action":"new"|"update"|"resolve","id":number|null,',
  '"severity":"safety"|"health"|"schedule"|"mood","summary":"最新事实一句话（≤80字）",',
  '"note":"本次新增进展（≤60字）","confidence":0..1}]}。没有可提取内容时输出 {"events":[]}。',
  '硬规则：',
  '1. 同一件事的进展必须用 update 指向已有事件 id，不得新建重复事件；风险解除/事情结束用 resolve。',
  '2. summary 写"现在是什么状态"的最新事实，不写演变过程。',
  '3. severity：safety=现实人身/居所风险（进水、断电、火灾、受伤等）；health=身体不适；',
  '   schedule=作息与行程（睡眠、出门、到家、搬家进度）；mood 仅在明显影响互动判断时才记。',
  '4. 只提取 User 本人陈述的现实生活状态。绝不输出：亲密或性相关内容；User 与 AI 之间的关系互动、',
  '   称呼、情话；对第三者隐私的转述；未经 User 确认的猜测。拿不准就不输出。',
  '5. 不编造原文没有的信息；低把握时降低 confidence。',
].join('\n');

export const extractLifeEventsWithDeepSeek: LifeEventExtractor = async (input) => {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未配置');
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_CAPTURE_MODEL?.trim() || 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
      stream: false,
      max_tokens: 600,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            now_shanghai: input.nowShanghai,
            contact: input.contact,
            active_events: input.activeEvents.map((event) => ({
              id: event.id,
              severity: event.severity,
              summary: event.summary,
              updated_at: event.updated_at,
            })),
            recent_messages: input.windowText,
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: Record<string, unknown>;
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `DeepSeek HTTP ${response.status}`);
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('DeepSeek 返回空 life-event JSON');
  const parsed = JSON.parse(raw) as { events?: unknown };
  const events: LifeEventChange[] = [];
  for (const item of Array.isArray(parsed.events) ? parsed.events : []) {
    const o = item as Record<string, unknown>;
    const action = o.action;
    const severity = o.severity;
    const confidence = Number(o.confidence);
    if (action !== 'new' && action !== 'update' && action !== 'resolve') continue;
    if (!SEVERITY_ORDER.includes(severity as LifeEventSeverity)) continue;
    if (!Number.isFinite(confidence)) continue;
    const summary = String(o.summary ?? '').trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary && action !== 'resolve') continue;
    events.push({
      action,
      id: Number.isFinite(Number(o.id)) ? Number(o.id) : undefined,
      severity: severity as LifeEventSeverity,
      summary,
      note: String(o.note ?? '').trim().slice(0, MAX_NOTE_CHARS),
      confidence,
    });
  }
  return { events, costCny: tokenCostCny(payload.usage) };
};

export class LifeEventRepo {
  constructor(private readonly db: Db) {}

  /** active 且未过 TTL 的事件；过期的当场惰性置为 expired（家用规模，无需定时清理）。 */
  activeEvents(nowMs = Date.now()): LifeEventRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM life_events WHERE status = 'active' ORDER BY updated_at DESC"
    ).all() as LifeEventRow[];
    const alive: LifeEventRow[] = [];
    for (const row of rows) {
      const ttlMs = (LIFE_EVENT_TTL_HOURS[row.severity] ?? 6) * 60 * 60_000;
      const updatedMs = Date.parse(row.updated_at);
      if (Number.isFinite(updatedMs) && nowMs - updatedMs > ttlMs) {
        this.db.prepare("UPDATE life_events SET status = 'expired' WHERE id = ?").run(row.id);
        continue;
      }
      alive.push(row);
    }
    return alive;
  }

  insert(input: {
    severity: LifeEventSeverity;
    summary: string;
    note: string;
    sourceContactId: string;
    lastMessageId?: number;
    now?: Date;
  }): void {
    const at = (input.now ?? new Date()).toISOString();
    const timeline = JSON.stringify([{ at, contactId: input.sourceContactId, note: input.note || input.summary }]);
    this.db.prepare(`
      INSERT INTO life_events (severity, status, summary, timeline, source_contact_id, last_message_id, first_at, updated_at)
      VALUES (?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(input.severity, input.summary, timeline, input.sourceContactId, input.lastMessageId ?? null, at, at);
  }

  update(id: number, input: {
    severity: LifeEventSeverity;
    summary: string;
    note: string;
    sourceContactId: string;
    lastMessageId?: number;
    now?: Date;
  }): void {
    const row = this.db.prepare('SELECT timeline FROM life_events WHERE id = ?').get(id) as
      | { timeline: string }
      | undefined;
    if (!row) return;
    const at = (input.now ?? new Date()).toISOString();
    let timeline: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(row.timeline);
      timeline = Array.isArray(parsed) ? parsed : [];
    } catch {
      timeline = [];
    }
    timeline.push({ at, contactId: input.sourceContactId, note: input.note || input.summary });
    if (timeline.length > MAX_TIMELINE_ENTRIES) timeline = timeline.slice(-MAX_TIMELINE_ENTRIES);
    this.db.prepare(`
      UPDATE life_events
      SET severity = ?, summary = ?, timeline = ?, source_contact_id = ?, last_message_id = ?, updated_at = ?, status = 'active'
      WHERE id = ?
    `).run(input.severity, input.summary, JSON.stringify(timeline), input.sourceContactId, input.lastMessageId ?? null, at, id);
  }

  resolve(id: number): void {
    this.db.prepare("UPDATE life_events SET status = 'resolved' WHERE id = ?").run(id);
  }

  reserveDailyCost(limitCny: number, amountCny: number): boolean {
    if (limitCny <= 0) return true;
    const amount = Math.max(amountCny, 0);
    const reserve = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT cost_cny FROM life_event_usage WHERE day = date('now', '+8 hours')"
      ).get() as { cost_cny: number } | undefined;
      if (finite(row?.cost_cny, 0) + amount > limitCny) return false;
      this.db.prepare(`
        INSERT INTO life_event_usage (day, requests, cost_cny)
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
      INSERT INTO life_event_usage (day, requests, cost_cny)
      VALUES (date('now', '+8 hours'), 0, ?)
      ON CONFLICT(day) DO UPDATE SET cost_cny = cost_cny + excluded.cost_cny
    `).run(amountCny);
  }

  /** 观测端点 & worker S4 读取：active 事件带来源联系人名。 */
  healthWithNames(nowMs = Date.now()): Array<Record<string, unknown>> {
    const events = this.activeEvents(nowMs);
    const nameOf = new Map(
      (this.db.prepare('SELECT id, name FROM contacts').all() as Array<{ id: string; name: string }>)
        .map((c) => [c.id, c.name])
    );
    return events.map((event) => ({
      id: event.id,
      severity: event.severity,
      status: event.status,
      summary: event.summary,
      sourceContactId: event.source_contact_id,
      sourceContactName: nameOf.get(event.source_contact_id) ?? event.source_contact_id,
      firstAt: event.first_at,
      updatedAt: event.updated_at,
      updatedAtShanghai: shanghaiStamp(event.updated_at),
    }));
  }
}

interface WindowRow {
  id: number;
  sender: string;
  role: string;
  content: string;
  origin: string;
  meta: string;
  created_at: string;
}

export class LifeEventService {
  readonly repo: LifeEventRepo;
  private readonly lastExtract = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly log: (message: string) => void,
    private readonly extractor: LifeEventExtractor = extractLifeEventsWithDeepSeek,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {
    this.repo = new LifeEventRepo(db);
  }

  /** S3：其他会话产出的事件，注入当前联系人的每轮 turn text。 */
  turnBlock(contact: ContactRow, nowMs = Date.now()): string {
    if (!lifeEventsEnabled(contact)) return '';
    const events = this.repo.activeEvents(nowMs)
      // 对方自己会话里刚聊过的事不用再告诉他；他的历史/摘要里本来就有。
      .filter((event) => event.source_contact_id !== contact.id)
      .sort((a, b) => {
        const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
        if (bySeverity !== 0) return bySeverity;
        return Date.parse(b.updated_at) - Date.parse(a.updated_at);
      });
    if (events.length === 0) return '';

    const nameOf = new Map(
      (this.db.prepare('SELECT id, name FROM contacts').all() as Array<{ id: string; name: string }>)
        .map((c) => [c.id, c.name])
    );
    const lines: string[] = [];
    let safetyCount = 0;
    for (const event of events) {
      if (lines.length >= BLOCK_MAX_EVENTS) break;
      if (event.severity === 'safety' && safetyCount >= BLOCK_MAX_SAFETY) continue;
      const label = event.severity === 'safety'
        ? `${SEVERITY_LABEL.safety}·进行中`
        : SEVERITY_LABEL[event.severity];
      const source = nameOf.get(event.source_contact_id) ?? event.source_contact_id;
      const line = `- 【${label}】${event.summary}（${shanghaiStamp(event.updated_at)}，来自与${source}的对话）`;
      // 预算裁剪：safety 必进（上限 BLOCK_MAX_SAFETY），其余超预算就丢。
      const projected = lines.join('\n').length + line.length;
      if (event.severity !== 'safety' && projected > BLOCK_MAX_CHARS - 260) continue;
      lines.push(line);
      if (event.severity === 'safety') safetyCount++;
    }
    if (lines.length === 0) return '';

    return [
      '<CROSS_CONTACT_STATE trust="gateway">',
      'User 最近在其他对话里提到的生活状态（跨会话共享给你衔接语境，不是台词）：',
      ...lines,
      '使用规则：相关时自然接上，别装作不知道；不要逐条复述本块，不要提"跨会话/系统/注入"。',
      '若 User 本轮亲口更新了状态，以本轮陈述为准。有安全类事项时，优先关切 User 此刻的现实处境。',
      '</CROSS_CONTACT_STATE>',
    ].join('\n');
  }

  /**
   * S2：回合结束后的旁路提取。fire-and-forget（runtime case 'done' 里 void 调用），
   * 内部吞掉所有异常。
   */
  async extractAfterTurn(contact: ContactRow, userMessageId: number, userText: string): Promise<boolean> {
    try {
      return await this.extractInner(contact, userMessageId, userText);
    } catch (error) {
      this.log(`life-event extract failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async extractInner(contact: ContactRow, userMessageId: number, userText: string): Promise<boolean> {
    if (!lifeEventsEnabled(contact)) return false;
    const trigger = detectLifeEventTrigger(userText);
    if (!trigger) return false;

    // safety 免限速：事故场景连发的每条消息都要有机会升级事件。
    if (trigger !== 'safety') {
      const last = this.lastExtract.get(contact.id) ?? 0;
      if (Date.now() - last < RATE_LIMIT_MS) return false;
    }

    const dailyLimit = finite(process.env.LIFE_EVENTS_DAILY_COST_CNY, DEFAULT_DAILY_COST_CNY);
    const reserved = finite(process.env.LIFE_EVENTS_RESERVED_COST_CNY, DEFAULT_RESERVED_COST_CNY);
    if (!this.repo.reserveDailyCost(dailyLimit, reserved)) {
      this.log(`life-event extract skipped: dailyCostCny breaker (${dailyLimit})`);
      return false;
    }
    this.lastExtract.set(contact.id, Date.now());

    // caption 竞态兜底：本条消息的转写还在跑就等一拍再取窗口。
    if (this.hasPendingCaptions(userMessageId)) {
      await this.sleep(CAPTION_PENDING_RETRY_MS);
    }

    const windowText = this.windowText(contact.id);
    if (!windowText) return false;
    const activeEvents = this.repo.activeEvents();

    const result = await this.extractor({
      contact: { id: contact.id, name: contact.name },
      windowText,
      activeEvents: activeEvents.map((event) => ({
        id: event.id,
        severity: event.severity,
        summary: event.summary,
        updated_at: event.updated_at,
        source_contact_id: event.source_contact_id,
      })),
      nowShanghai: shanghaiStamp(new Date().toISOString()),
    });
    const actual = Math.max(finite(result.costCny, 0), 0);
    if (actual > reserved) this.repo.addDailyCost(actual - reserved);

    const activeIds = new Set(activeEvents.map((event) => event.id));
    let applied = 0;
    for (const change of result.events) {
      if (change.confidence < CONFIDENCE_THRESHOLD) continue;
      if (change.action === 'resolve') {
        if (change.id !== undefined && activeIds.has(change.id)) {
          this.repo.resolve(change.id);
          applied++;
        }
        continue;
      }
      if (change.action === 'update' && change.id !== undefined && activeIds.has(change.id)) {
        this.repo.update(change.id, {
          severity: change.severity,
          summary: change.summary,
          note: change.note,
          sourceContactId: contact.id,
          lastMessageId: userMessageId,
        });
        applied++;
        continue;
      }
      if (change.action === 'new') {
        this.repo.insert({
          severity: change.severity,
          summary: change.summary,
          note: change.note,
          sourceContactId: contact.id,
          lastMessageId: userMessageId,
        });
        applied++;
      }
    }
    if (applied > 0) this.log(`life events applied=${applied} contact=${contact.id} trigger=${trigger}`);
    return applied > 0;
  }

  private hasPendingCaptions(messageId: number): boolean {
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS n FROM message_attachments WHERE message_id = ? AND caption_status = 'pending'"
      ).get(messageId) as { n: number };
      return row.n > 0;
    } catch {
      return false;
    }
  }

  /** 最近 60 分钟内本联系人主窗里 User 自己的消息（含 caption 转写），旧→新。 */
  private windowText(contactId: string): string {
    const rows = (this.db.prepare(`
      SELECT id, sender, role, content, origin, meta, created_at FROM messages
      WHERE contact_id = ?
        AND deleted = 0
        AND kind = 'text'
        AND origin = 'main'
        AND role = 'user'
        AND sender = 'user'
        AND created_at >= datetime('now', ?)
      ORDER BY id DESC
      LIMIT ?
    `).all(contactId, `-${WINDOW_MINUTES} minutes`, WINDOW_MAX_MESSAGES) as WindowRow[]).reverse();
    return rows
      .map((row) => {
        const at = shanghaiStamp(row.created_at.includes('T') ? row.created_at : `${row.created_at.replace(' ', 'T')}Z`);
        const text = historicalMessageText({
          sender: row.sender,
          role: row.role as 'user',
          content: row.content,
          origin: row.origin as 'main',
          meta: row.meta,
        });
        return `[${at}] ${text}`;
      })
      .join('\n')
      .trim();
  }
}
