import type { Db, HubLogger } from '../platform/index.js';
import { isWorkflowRoomConfig } from './workflowModules.js';

/** Idempotent: workflow rooms gain every enabled CLI contact as reserve members.
 * Reserves never wake unless a module binding selects them; addition never
 * removes members and never invokes a model. */
export function ensureWorkflowRoomReserves(db: Db, logger?: HubLogger): void {
  const agents = db.prepare(
    `SELECT id FROM contacts WHERE kind = 'dm' AND enabled = 1
      AND backend IN ('codex', 'claude-cli', 'grok-cli', 'opencode-cli', 'kimi-cli')`
  ).all() as { id: string }[];
  if (agents.length === 0) return;
  const rooms = db.prepare(
    `SELECT id, config FROM contacts WHERE kind = 'room' AND enabled = 1`
  ).all() as { id: string; config: string }[];
  const update = db.prepare('UPDATE contacts SET config = ? WHERE id = ?');
  for (const room of rooms) {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(room.config || '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!isWorkflowRoomConfig(cfg)) continue;
    const members = Array.isArray(cfg.members)
      ? cfg.members.filter((item): item is string => typeof item === 'string')
      : [];
    const missing = agents.map((agent) => agent.id).filter((id) => !members.includes(id));
    if (missing.length === 0) continue;
    cfg.members = [...members, ...missing];
    update.run(JSON.stringify(cfg), room.id);
    logger?.info({ component: 'seed', roomId: room.id, added: missing }, 'workflow room reserves added');
  }
}
