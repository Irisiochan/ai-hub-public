import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig } from './config.js';
import type { Db } from './db.js';
import type { HubLogger } from './logger.js';

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
