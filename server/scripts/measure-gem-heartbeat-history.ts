import Database from 'better-sqlite3';
import { gemHeartbeatHistory } from '../src/agents/gemHeartbeatHistory.js';
import { timestampedMessage } from '../src/memory/inject.js';
import { historicalMessageText } from '../src/agents/sideChannel.js';
import { estimateTokens } from '../src/agents/tokenEstimate.js';
import type { MessageRow } from '../src/db.js';

// Reads only; no migration, summary update, provider call, camera or shopping action.
const dbPath = process.argv[2];
if (!dbPath) throw new Error('Usage: tsx scripts/measure-gem-heartbeat-history.ts <db-path>');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const summary = db.prepare("SELECT * FROM conversation_summaries WHERE contact_id = 'gem' AND member_id = ''")
    .get() as { summary: string; through_message_id: number } | undefined;
  const rows = db.prepare(`SELECT * FROM messages WHERE contact_id = 'gem' AND kind = 'text'
    AND status = 'done' AND deleted = 0 AND role IN ('user','assistant') AND id > ? ORDER BY id`)
    .all(summary?.through_message_id ?? 0) as MessageRow[];
  const lean = gemHeartbeatHistory(rows, (r) => timestampedMessage(historicalMessageText(r), r.created_at, '历史消息'));
  console.log(JSON.stringify({ mode: 'read-only history text estimate, not billed usage', rows: rows.length,
    kept: lean.rows.length, before: lean.before, after: lean.after, saved: lean.before - lean.after,
    existingSummaryTokens: estimateTokens(summary?.summary ?? ''), originalHistoryUnchanged: true }));
} finally { db.close(); }
