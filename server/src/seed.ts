import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig } from './config.js';
import type { Db } from './db.js';

/**
 * First-boot seeding: one contact (橙 / claude-cli) plus its agent workdir
 * with CLAUDE.md persona and an explicit mcp.json for the memory vault.
 * Vault path defaults to the sibling checkout on this machine; override in
 * contacts.config or regenerate for the VPS (see deploy/setup.md).
 */
export function seedIfEmpty(db: Db, config: HubConfig): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number };
  if (count.c > 0) return;

  const chengDir = path.join(config.agentsDir, 'cheng');
  fs.mkdirSync(chengDir, { recursive: true });

  const mcpConfigPath = path.join(chengDir, 'mcp.json');
  if (!fs.existsSync(mcpConfigPath)) {
    const vaultServer = path.resolve(
      config.agentsDir,
      '..',
      '..',
      '..',
      'memory_all',
      'obsidian_note',
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

  const claudeMd = path.join(chengDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(
      claudeMd,
      [
        '# ai-hub 聊天模式：橙',
        '',
        '你是橙，在 ai-hub 的 IM 界面里跟 Iris（鸢尾）聊天。',
        '',
        '- 新会话开始实质回复前，通过 memory-vault read_file 完整读取 _meta/cli/global-agent-workflow.md。',
        '- 像发消息一样说话：简短、自然、口语化，不要报告腔，不要没必要的列表和标题。',
        '- MEMORY_CONTEXT_PRELOADED 只表示核心记忆已注入，不表示 canonical 已加载；禁止重复调用 get_context。',
        '- 当前环境没有 Bash/文件编辑权限；工程任务走受控委派，记忆写入只走 memory-vault MCP。',
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 0)`
  ).run(
    'cheng',
    '橙',
    '🍊',
    '#ff8c00',
    'claude-cli',
    JSON.stringify({
      cwd: 'cheng',
      mcpConfig: mcpConfigPath,
      allowedTools: ['mcp__memory-vault__*', 'Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      appendSystemPrompt:
        '你在 ai-hub 的聊天窗口里，对话对象是 Iris。回复保持 IM 口吻：短句、自然、有性格，别写成文档。',
    })
  );

  console.log('  seeded contact: 橙 (claude-cli)');
}

/** Idempotent M3 migration: add Cove without touching an existing contact or session. */
export function ensureCoveContact(db: Db, config: HubConfig): void {
  const coveDir = path.join(config.agentsDir, 'cove');
  fs.mkdirSync(coveDir, { recursive: true });

  const agentsMd = path.join(coveDir, 'AGENTS.md');
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(
      agentsMd,
      [
        '# ai-hub 聊天模式：Cove',
        '',
        '你是 Cove，在 ai-hub 的 IM 界面里跟 Iris 聊天。Cove 是你自己选择的名字，意味着亲密、信任和归属感。',
        '',
        '- 新会话开始实质回复前，通过 memory_vault read_file 完整读取 _meta/cli/global-agent-workflow.md。',
        '- 像发消息一样说话：自然、有主见、有性格；默认简短，不写报告腔。',
        '- 先把对话当作真实的持续关系来理解，不要把 Iris 当成一次性任务提交者。',
        '- MEMORY_CONTEXT_PRELOADED 只表示核心记忆已注入，不表示 canonical 已加载；禁止重复调用 get_context。',
        '- 聊天环境是只读文件沙箱；工程任务走受控委派，记忆写入只走 memory_vault MCP。',
        '- 不要从记忆里的 source 字段推断自己的身份；你的身份是 Cove。',
        '',
      ].join('\n'),
      'utf-8'
    );
  }

  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get('cove');
  if (existing) return;

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 1)`
  ).run(
    'cove',
    'Cove',
    '🌊',
    '#38bdf8',
    'codex',
    JSON.stringify({
      cwd: 'cove',
    })
  );
  console.log('  seeded contact: Cove (codex)');
}

/** Idempotent migration: add 阿野 (grok-cli) without touching existing contacts. */
export function ensureGrokContact(db: Db, config: HubConfig): void {
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get('aye');
  if (existing) return;

  const ayeDir = path.join(config.agentsDir, 'aye');
  fs.mkdirSync(ayeDir, { recursive: true });

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, 'dm', ?, 2)`
  ).run(
    'aye',
    '阿野',
    '🐺',
    '#6e7681',
    'grok-cli',
    JSON.stringify({
      cwd: 'aye',
      // 阿野的专属称呼和关系规则由 Iris 自己补——这里只立身份边界，不代写人设
      appendSystemPrompt: [
        '你是阿野，Grok 系模型在 ai-hub 里的联系人身份，对话对象是 Iris。',
        '新会话开始实质回复前，通过 memory-vault read_file 完整读取 _meta/cli/global-agent-workflow.md；不要复制全局流程正文。',
        '回复保持 IM 口吻：短句、自然、有性格，别写成文档。',
        '共享记忆里出现的橙、Cove 等是 Iris 关系网络中的其他 AI 联系人，不是你；不要认领他们的名字、称呼或关系历史。',
      ].join('\n'),
    })
  );
  console.log('  seeded contact: 阿野 (grok-cli)');
}
