import fs from 'node:fs';
import path from 'node:path';
import type { Db, HubConfig, HubLogger } from '../platform/index.js';

function writeIfMissing(file: string, lines: string[]): void {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

/** Public first boot: generic contacts only; Compose provides memory automatically. */
export function seedIfEmpty(db: Db, config: HubConfig, logger?: HubLogger): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number };
  if (count.c > 0) return;

  const claudeDir = path.join(config.agentsDir, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeIfMissing(path.join(claudeDir, 'CLAUDE.md'), [
    '# ai-hub chat mode',
    '',
    'You are the Claude contact in an IM-style AI client.',
    '',
    '- Reply naturally and concisely unless the user asks for detail.',
    '- Do not claim tools or permissions that are not available.',
    '- Use memory context supplied by the gateway when it is available.',
  ]);

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 0)`
  ).run(
    'claude',
    'Claude',
    '🤖',
    '#d97706',
    'claude-cli',
    JSON.stringify({
      cwd: 'claude',
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      appendSystemPrompt: 'You are chatting through ai-hub. Keep replies natural, direct, and suitable for IM.',
    })
  );

  logger?.info({ component: 'seed', contactId: 'claude' }, 'contact seeded');
}

/** Add a generic Codex contact without modifying existing contacts or sessions. */
export function ensureCodexContact(db: Db, config: HubConfig, logger?: HubLogger): void {
  const codexDir = path.join(config.agentsDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  writeIfMissing(path.join(codexDir, 'AGENTS.md'), [
    '# ai-hub chat mode',
    '',
    'You are the Codex contact in an IM-style AI client.',
    '',
    '- Reply naturally and concisely unless the user asks for detail.',
    '- Treat the filesystem as read-only unless project access is explicitly enabled.',
    '- Use memory context supplied by the gateway when it is available.',
  ]);

  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get('codex');
  if (existing) return;

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 1)`
  ).run(
    'codex',
    'Codex',
    '💻',
    '#2563eb',
    'codex',
    JSON.stringify({
      cwd: 'codex',
      developerInstructions:
        'You are chatting through ai-hub. Keep replies natural and direct. Do not use shell or file-writing tools unless project access is explicitly enabled.',
    })
  );

  logger?.info({ component: 'seed', contactId: 'codex' }, 'contact seeded');
}

/** Add a generic Grok contact without modifying existing contacts or sessions. */
export function ensureGrokContact(db: Db, config: HubConfig, logger?: HubLogger): void {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get('grok');
  if (existing) return;

  const grokDir = path.join(config.agentsDir, 'grok');
  fs.mkdirSync(grokDir, { recursive: true });

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 2)`
  ).run(
    'grok',
    'Grok Build',
    '🛠️',
    '#6e7681',
    'grok-cli',
    JSON.stringify({
      cwd: 'grok',
      appendSystemPrompt:
        'You are chatting through ai-hub. Keep replies natural and direct, and do not claim tools or permissions that are unavailable.',
    })
  );

  logger?.info({ component: 'seed', contactId: 'grok' }, 'contact seeded');
}

/** Add a generic OpenCode contact without modifying existing contacts or sessions. */
export function ensureMuseContact(db: Db, config: HubConfig, logger?: HubLogger): void {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get('opencode');
  if (existing) return;

  const opencodeDir = path.join(config.agentsDir, 'opencode');
  fs.mkdirSync(opencodeDir, { recursive: true });

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 3)`
  ).run(
    'opencode',
    'OpenCode',
    '🎼',
    '#c4a574',
    'opencode-cli',
    JSON.stringify({
      cwd: 'opencode',
      appendSystemPrompt:
        'You are chatting through ai-hub via the OpenCode CLI. Keep replies natural and direct, and do not claim tools or permissions that are unavailable.',
    })
  );

  logger?.info({ component: 'seed', contactId: 'opencode' }, 'contact seeded');
}

/** Append opencode to existing delegation.runners so the execute module can dispatch to it. */
export function ensureOpencodeDelegationRunner(db: Db, logger?: HubLogger): void {
  const rows = db.prepare('SELECT id, config FROM contacts').all() as { id: string; config: string }[];
  const update = db.prepare('UPDATE contacts SET config = ? WHERE id = ?');
  for (const row of rows) {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(row.config || '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    const delegation = cfg.delegation && typeof cfg.delegation === 'object' && !Array.isArray(cfg.delegation)
      ? { ...(cfg.delegation as Record<string, unknown>) }
      : null;
    if (!delegation || delegation.enabled !== true) continue;
    const runners = Array.isArray(delegation.runners) ? delegation.runners.filter((item) => typeof item === 'string') : [];
    if (!runners.includes('codex') && !runners.includes('grok')) continue;
    if (runners.includes('opencode')) continue;
    delegation.runners = [...runners, 'opencode'];
    cfg.delegation = delegation;
    update.run(JSON.stringify(cfg), row.id);
    logger?.info({ component: 'seed', contactId: row.id }, 'delegation.runners added opencode');
  }
}

/** Move the room intake/dispatch seat from Claude to Codex when the room still uses the old default. */
export function ensureRoomOrchestratorCove(db: Db, logger?: HubLogger): void {
  const rooms = db.prepare(
    `SELECT id, config FROM contacts WHERE kind = 'room' AND enabled = 1`
  ).all() as { id: string; config: string }[];
  const codex = db.prepare(
    `SELECT id FROM contacts WHERE id = 'codex' AND kind = 'dm' AND enabled = 1`
  ).get() as { id: string } | undefined;
  if (!codex) return;
  const update = db.prepare('UPDATE contacts SET config = ? WHERE id = ?');
  for (const row of rooms) {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(row.config || '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    const members = Array.isArray(cfg.members)
      ? cfg.members.filter((item): item is string => typeof item === 'string')
      : [];
    if (!members.includes('codex')) continue;
    const coordination = cfg.coordination && typeof cfg.coordination === 'object' && !Array.isArray(cfg.coordination)
      ? { ...(cfg.coordination as Record<string, unknown>) }
      : {};
    const current = typeof coordination.orchestrator === 'string' ? coordination.orchestrator : '';
    if (current === 'codex') continue;
    if (current && current !== 'claude') continue;
    coordination.orchestrator = 'codex';
    cfg.coordination = coordination;
    update.run(JSON.stringify(cfg), row.id);
    logger?.info({ component: 'seed', roomId: row.id, from: current || 'default' }, 'room orchestrator set to codex');
  }
}
