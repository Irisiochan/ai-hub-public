import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig } from './config.js';
import type { Db } from './db.js';

/** First-boot public seed: neutral product identities, never private personas. */
export function seedIfEmpty(db: Db, config: HubConfig): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number };
  if (count.c > 0) return;

  const claudeDir = path.join(config.agentsDir, 'claude-code');
  fs.mkdirSync(claudeDir, { recursive: true });

  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(
      claudeMd,
      [
        '# AI Hub chat mode',
        '',
        'You are Claude Code in a private, self-hosted AI Hub.',
        '',
        '- Reply like a natural chat message; stay concise unless detail is useful.',
        '- Do not infer the user\'s identity or your persona from memory metadata.',
        '- Use only the tools and workspaces explicitly enabled for this contact.',
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  const insert = db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, ?)`
  );

  insert.run(
    'claude-code', 'Claude Code', '🟧', '#d97757', 'claude-cli',
    JSON.stringify({
      cwd: 'claude-code',
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      appendSystemPrompt:
        'You are Claude Code chatting with the current AI Hub user. Keep a conversational tone and do not assume a name or relationship.',
    }),
    0
  );

  insert.run(
    'codex', 'Codex', '🧩', '#10a37f', 'codex',
    JSON.stringify({
      cwd: 'codex',
      developerInstructions:
        'You are Codex chatting with the current AI Hub user. Keep a conversational tone and do not assume a name or relationship.',
    }),
    1
  );

  insert.run(
    'grok-build', 'Grok Build', '⚡', '#334155', 'grok-cli',
    JSON.stringify({
      cwd: 'grok-build',
      appendSystemPrompt:
        'You are Grok Build chatting with the current AI Hub user. Keep a conversational tone and do not assume a name or relationship.',
    }),
    2
  );

  console.log('  seeded contacts: Claude Code, Codex, Grok Build');
}
