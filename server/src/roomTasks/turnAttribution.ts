import crypto from 'node:crypto';
import type { Db } from '../platform/index.js';

/**
 * Trusted origin-turn provenance for the handoff obligation.
 *
 * Every room module turn gets a server-created origin nonce (turnId UUID,
 * never from model text, never from tool-name scans, never from timestamps).
 * The nonce is captured in that turn's own model-request/native-tool closure
 * at turn start (backend rebuild per room turn) and signed into the actual
 * generated MCP bearer for CLI turns. Each task-tool call presents the nonce
 * bound to its own origin turn; the store validates the nonce is still
 * active AND exactly matches room/contact/module (+task/callback pin).
 *
 * There is deliberately NO latest-turn lookup: an old turn A token used
 * while B is active is rejected (A is ended, or nonce mismatches B), stale
 * calls can never satisfy a newer turn, and concurrent turns never overwrite
 * each other (registry is keyed by nonce, not by room/contact/module slot).
 * Calls with an expired/unknown nonce are rejected, never upgraded to the
 * latest turn and never silently written untraced.
 */

export interface ActiveTurn {
  turnId: string;
  roomId: string;
  contactId: string;
  moduleId: string;
  taskId?: string;
  handoffId?: string;
  callbackJobId?: string;
  startedAt: number;
}

const active = new Map<string, ActiveTurn>();
/** Turns whose audit persistence failed: the guard must fail them closed. */
const poisoned = new Set<string>();
/**
 * Trusted in-memory touched set per turn (task ids from successful calls in
 * this process). Used ONLY to widen the guard's related-task set — never to
 * grant a pass — so a persistence failure can never silently narrow the
 * obligation to zero tasks.
 */
const touched = new Map<string, Set<string>>();

export function ensureTurnSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_task_turns (
      turn_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL DEFAULT '',
      contact_id TEXT NOT NULL DEFAULT '',
      module_id TEXT NOT NULL DEFAULT '',
      task_id TEXT,
      handoff_id TEXT,
      callback_job_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_room_task_turns_active
      ON room_task_turns(room_id, contact_id, module_id, status);
    CREATE TABLE IF NOT EXISTS room_task_turn_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL REFERENCES room_task_turns(turn_id),
      room_id TEXT NOT NULL DEFAULT '',
      contact_id TEXT NOT NULL DEFAULT '',
      module_id TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL DEFAULT '',
      task_id TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_room_task_turn_calls_turn
      ON room_task_turn_calls(turn_id, id);
  `);
  // Q1 (cost batch 2): link each origin turn to its final assistant message
  // so chat-seat token usage (message_usage) can be attributed to tasks.
  // Nullable + best-effort: old rows stay NULL, missing ids stay unattributed,
  // never fabricated.
  try {
    const info = db.prepare(`PRAGMA table_info(room_task_turns)`).all() as Array<{ name: string }>;
    if (!info.some((col) => col.name === 'message_id')) {
      db.exec(`ALTER TABLE room_task_turns ADD COLUMN message_id INTEGER`);
    }
  } catch {
    // Best-effort: concurrent ensureSchema calls may race the ALTER; readers
    // treat a missing column as "no attribution data", never throw.
  }
}

/** Begin a new origin turn. The returned nonce must be captured in that turn's own closures/bearer. */
export function beginRoomTurn(db: Db, input: {
  roomId: string;
  contactId: string;
  moduleId: string;
  taskId?: string;
  handoffId?: string;
  callbackJobId?: string;
}): ActiveTurn {
  const turnId = crypto.randomUUID();
  const turn: ActiveTurn = {
    turnId,
    roomId: input.roomId,
    contactId: input.contactId,
    moduleId: input.moduleId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.handoffId ? { handoffId: input.handoffId } : {}),
    ...(input.callbackJobId ? { callbackJobId: input.callbackJobId } : {}),
    startedAt: Date.now(),
  };
  active.set(turnId, turn);
  try {
    ensureTurnSchema(db);
    db.prepare(
      `INSERT INTO room_task_turns
        (turn_id, room_id, contact_id, module_id, task_id, handoff_id, callback_job_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      turnId, input.roomId, input.contactId, input.moduleId,
      input.taskId ?? null, input.handoffId ?? null, input.callbackJobId ?? null,
    );
  } catch (error) {
    // Audit persistence failed: latch poison so the guard fails closed, and
    // rethrow so no caller can silently continue with an unaudited turn.
    poisoned.add(turnId);
    throw error;
  }
  return turn;
}

export function endRoomTurn(db: Db, turnId: string, outcome: string): void {
  active.delete(turnId);
  touched.delete(turnId);
  poisoned.delete(turnId);
  try {
    ensureTurnSchema(db);
    db.prepare(
      `UPDATE room_task_turns SET status = ?, ended_at = datetime('now') WHERE turn_id = ?`,
    ).run(outcome.slice(0, 40), turnId);
  } catch {
    // best-effort
  }
}

/**
 * Q1 (cost batch 2): record the turn's final assistant message id for token
 * attribution. Best-effort and idempotent: unknown turns, missing columns and
 * any other failure leave the row untouched (NULL = unattributed, never
 * fabricated). Callers pass only real persisted message ids.
 */
export function setTurnMessageId(db: Db, turnId: string, messageId: number): void {
  if (!turnId || !Number.isSafeInteger(messageId) || messageId <= 0) return;
  try {
    ensureTurnSchema(db);
    db.prepare(
      `UPDATE room_task_turns SET message_id = ? WHERE turn_id = ?`,
    ).run(messageId, turnId);
  } catch {
    // best-effort: the cost ledger treats missing ids as unattributed
  }
}

/** Exact nonce lookup: returns the turn only while it is still active. */
export function getTurn(turnId: string): ActiveTurn | undefined {
  if (!turnId) return undefined;
  return active.get(turnId);
}

/**
 * Validate a presented origin nonce for a task-tool call. Returns the turn
 * on exact room/contact/module match, else null. Never falls back to any
 * other (e.g. latest) turn.
 */
export function validateTurnCall(
  turnId: string | undefined,
  expected: { roomId: string; contactId: string; moduleId: string },
): ActiveTurn | null {
  if (!turnId) return null;
  const turn = active.get(turnId);
  if (!turn) return null;
  if (turn.roomId !== expected.roomId) return null;
  if (turn.contactId !== expected.contactId) return null;
  if (turn.moduleId !== expected.moduleId) return null;
  return turn;
}

/** Record a touched task in the trusted in-memory set (widen-only for the guard). */
export function noteTouched(turnId: string, taskId: string | undefined): void {
  if (!turnId || !taskId) return;
  let set = touched.get(turnId);
  if (!set) {
    set = new Set<string>();
    touched.set(turnId, set);
  }
  set.add(taskId);
}

/** Tasks touched by successful calls in this process (trusted widen-only input for the guard). */
export function touchedTasks(turnId: string): Set<string> {
  return touched.get(turnId) ?? new Set<string>();
}

/** True when this turn's audit persistence failed: the guard must fail closed. */
export function isPoisoned(turnId: string): boolean {
  return poisoned.has(turnId);
}

export function recordTurnCall(
  db: Db,
  turnId: string,
  input: {
    roomId: string;
    contactId: string;
    moduleId: string;
    tool: string;
    taskId?: string;
    ok: boolean;
    detail?: string;
  },
): boolean {
  // Trusted in-memory touched set first: it survives audit persistence
  // failures so the guard can never see zero related tasks for a turn that
  // demonstrably operated on tasks in this process.
  noteTouched(turnId, input.taskId);
  try {
    ensureTurnSchema(db);
    db.prepare(
      `INSERT INTO room_task_turn_calls
        (turn_id, room_id, contact_id, module_id, tool, task_id, ok, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      turnId,
      input.roomId,
      input.contactId,
      input.moduleId,
      input.tool.slice(0, 80),
      input.taskId ?? null,
      input.ok ? 1 : 0,
      (input.detail ?? '').slice(0, 500),
    );
    return true;
  } catch {
    // Audit persistence failed: latch poison so the guard fails closed
    // instead of silently settling a turn whose receipts are unrecorded.
    poisoned.add(turnId);
    return false;
  }
}

export interface TurnCallRow {
  id: number;
  turn_id: string;
  room_id: string;
  contact_id: string;
  module_id: string;
  tool: string;
  task_id: string | null;
  ok: number;
  detail: string;
  created_at: string;
}

export function listTurnCalls(db: Db, turnId: string): TurnCallRow[] {
  // Strict: attribution read failures must surface (the guard fails closed),
  // never silently pass as an empty receipt list.
  ensureTurnSchema(db);
  return db.prepare(
    `SELECT * FROM room_task_turn_calls WHERE turn_id = ? ORDER BY id ASC`,
  ).all(turnId) as TurnCallRow[];
}
