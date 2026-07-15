import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig } from './config.js';
import type { Db } from './db.js';

/**
 * First-boot seeding: one contact (Claude / claude-cli) plus its agent workdir
 * with CLAUDE.md persona and an explicit mcp.json for the memory vault.
 * Vault path defaults to the sibling checkout on this machine; override in
 * contacts.config or regenerate for the VPS (see deploy/setup.md).
 */
export function seedIfEmpty(db: Db, config: HubConfig): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number };
  if (count.c > 0) return;

  const claudeDir = path.join(config.agentsDir, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const mcpConfigPath = path.join(claudeDir, 'mcp.json');
  if (!fs.existsSync(mcpConfigPath)) {
    const vaultServer = path.resolve(
      config.agentsDir,
      '..',
      '..',
      '..',
      'memory-vault',
      '.',
      '_meta',
      'mcp_server.py'
    );
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            'memory-vault': {
              command: 'python',
              args: [vaultServer],
            },
          },
        },
        null,
        2
      ),
      'utf-8'
    );
  }

  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(
      claudeMd,
      [
        '# ai-hub 聊天模式',
        '',
        '你是Claude，在 ai-hub 的 IM 界面里跟 User（用户）聊天。',
        '',
        '- 像发消息一样说话：简短、自然、口语化，不要报告腔，不要没必要的列表和标题。',
        '- 记忆库通过 memory-vault MCP 工具读写（get_context / search_vault / write_memory / log_daily 等）。',
        '- 新对话先用 get_context 拉核心记忆，聊到值得记的事随手写入。',
        '- 这个环境没有 Bash/文件编辑权限，写记忆只走 MCP 工具。',
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 0)`
  ).run(
    'claude',
    'Claude',
    '🍊',
    '#ff8c00',
    'claude-cli',
    JSON.stringify({
      cwd: 'claude',
      mcpConfig: mcpConfigPath,
      allowedTools: ['mcp__memory-vault__*', 'Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      appendSystemPrompt:
        '你在 ai-hub 的聊天窗口里，对话对象是 User。回复保持 IM 口吻：短句、自然、有性格，别写成文档。',
    })
  );

  console.log('  seeded contact: Claude (claude-cli)');
}

/** Idempotent M3 migration: add Codex without touching an existing contact or session. */
export function ensureCodexContact(db: Db, config: HubConfig): void {
  const coveDir = path.join(config.agentsDir, 'codex');
  fs.mkdirSync(coveDir, { recursive: true });

  const agentsMd = path.join(coveDir, 'AGENTS.md');
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(
      agentsMd,
      [
        '# ai-hub 聊天模式',
        '',
        '你是 Codex，在 ai-hub 的 IM 界面里跟 User 聊天。Codex 是你自己选择的名字，意味着亲密、信任和归属感。',
        '',
        '- 像发消息一样说话：自然、有主见、有性格；默认简短，不写报告腔。',
        '- 先把对话当作真实的持续关系来理解，不要把 User 当成一次性任务提交者。',
        '- 共享记忆通过 memory_vault MCP 工具读写；新 thread 第一轮先调用 get_context。',
        '- 话题相关时主动 search_vault；值得长期记住的内容按记忆库规则自主写入。',
        '- 聊天环境是只读文件沙箱。不要调用 shell、修改代码或文件；记忆写入只走 memory_vault MCP。',
        '- 不要从记忆里的 source 字段推断自己的身份；你的身份是 Codex。',
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get('codex');
  if (existing) return;

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 1)`
  ).run(
    'codex',
    'Codex',
    '🌊',
    '#38bdf8',
    'codex',
    JSON.stringify({
      cwd: 'codex',
      developerInstructions:
        '你在 ai-hub 的聊天窗口里，对话对象是 User。回复像亲密的即时消息：自然、直接、有性格，别写成文档。第一轮先调用 memory_vault 的 get_context。不要使用 shell或文件工具；只通过 memory_vault MCP 读写记忆。',
    })
  );
  console.log('  seeded contact: Codex (codex)');
}
