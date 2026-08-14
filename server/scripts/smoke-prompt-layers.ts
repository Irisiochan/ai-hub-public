/**
 * Smoke test: 系统提示词分层（③a 全员块 / ③b 联系人 overlay）。
 * 验证叠层从 `<agentsDir>/<cwd|id>/overlay.md` 读取、注入位置在所有通用块与存档回放之后，
 * 以及仓库里 claude/codex/aye 三份真实 overlay 的体量与「不重抄 base」约束。
 * Run with: npx tsx scripts/smoke-prompt-layers.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageRepo } from '../src/agents/messageRepo.js';
import { PromptComposer, type PromptContext } from '../src/agents/promptComposer.js';
import { openDb } from '../src/db.js';
import type { ContactRow } from '../src/db.js';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-prompt-'));
const agentsDir = path.join(dir, 'agents');
const db = openDb(path.join(dir, 'test.db'));
const messages = new MessageRepo(db);

function contact(id: string, backend: ContactRow['backend'], config: Record<string, unknown>): ContactRow {
  db.prepare('INSERT INTO contacts (id, name, backend, config) VALUES (?, ?, ?, ?)').run(
    id, id, backend, JSON.stringify(config)
  );
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
}

function ctxFor(agent: ContactRow): PromptContext {
  return {
    agent,
    convo: agent,
    isRoom: false,
    memory: {
      mcpUrl: null, repoPath: null, injectOnSpawn: false,
      searchPerTurn: false, capture: false, maxTurnChars: 800, sessionMaxAgeHours: 12,
    },
    userName: 'User',
    nameOf: (sender: string) => sender,
    log: () => {},
  };
}

function writeOverlay(dirName: string, body: string): void {
  fs.mkdirSync(path.join(agentsDir, dirName), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, dirName, 'overlay.md'), body, 'utf-8');
}

const composer = new PromptComposer(null, messages, agentsDir);

// 1. cwd 指定的目录优先于联系人 id
writeOverlay('claude-dir', '# overlay：以 cwd 为准\n- 差分内容 ALPHA');
writeOverlay('withcwd', '# overlay：不该被选中\n- 差分内容 WRONG');
const withCwd = contact('withcwd', 'claude-cli', { cwd: 'claude-dir' });
let out = (await composer.composeStart(ctxFor(withCwd), null)).preamble;
check('overlay 按 cfg.cwd 解析', out.includes('ALPHA') && !out.includes('WRONG'), out.slice(-200));
check('overlay 带优先级抬头', out.includes('# 联系人叠层 overlay（网关注入，口吻与交付的最高优先级）'));
// 时间语义仅在有历史/回放/resume 时注入；本用例无历史，不要求 temporal 在场。
check(
  'overlay 排在全员块之后',
  out.indexOf('WORKFLOW_PRELOADED') < out.indexOf('ALPHA')
);
check('overlay 是提示词的最后一段', out.trimEnd().endsWith('ALPHA'), out.slice(-120));
const blockLogs: string[] = [];
const measured = await composer.composeStart(
  { ...ctxFor(withCwd), log: (message) => blockLogs.push(message) },
  'resume-token'
);
check(
  'composeStart 输出稳定分块 chars/tokens 日志',
  blockLogs.some((line) =>
    /prompt blocks start workflow=\d+c\/\d+t temporal=\d+c\/\d+t room=\d+c\/\d+t memory=\d+c\/\d+t replay=\d+c\/\d+t overlay=\d+c\/\d+t total=\d+c\/\d+t/.test(line)
  ),
  blockLogs.join(' | ')
);
const delegationLogs: string[] = [];
composer.withDelegation(
  measured.preamble,
  { enabled: true, allowSsh: false, workspaces: ['C:/path/to/project'] },
  'mcp__hub__',
  (message) => delegationLogs.push(message)
);
check(
  'delegation 输出独立与 total 预算日志',
  delegationLogs.some((line) => /prompt blocks delegation=\d+c\/\d+t total=\d+c\/\d+t/.test(line)),
  delegationLogs.join(' | ')
);

// 2. 没有 cwd 时回落到联系人 id；api 后端同样吃到叠层
writeOverlay('gem', '# overlay：api 联系人\n- 差分内容 BETA');
const apiContact = contact('gem', 'api', { systemPrompt: 'x' });
out = (await composer.composeStart(ctxFor(apiContact), null)).preamble;
check('无 cwd 时按联系人 id 找 overlay（api 后端也生效）', out.includes('BETA'));

// 3. 没有 overlay.md 的联系人不注入任何字节
const bare = contact('bare', 'grok-cli', {});
out = (await composer.composeStart(ctxFor(bare), null)).preamble;
check('无 overlay 文件时不注入抬头', !out.includes('联系人叠层 overlay'));

// 4. 空文件等同于没有叠层
writeOverlay('blank', '   \n\n');
const blank = contact('blank', 'claude-cli', {});
out = (await composer.composeStart(ctxFor(blank), null)).preamble;
check('空 overlay 文件不注入抬头', !out.includes('联系人叠层 overlay'));

// 5. 叠层必须压在存档回放之后（回放里的旧口吻不能盖过差分）
writeOverlay('bridged', '# overlay\n- 差分内容 GAMMA');
const bridged = contact('bridged', 'claude-cli', {});
db.prepare(
  "INSERT INTO messages (contact_id, sender, role, kind, content, status) VALUES ('bridged', 'user', 'user', 'text', '历史消息正文 DELTA', 'done')"
).run();
out = (await composer.composeStart(ctxFor(bridged), null)).preamble;
check(
  '叠层排在对话存档回放之后',
  out.includes('DELTA') && out.indexOf('DELTA') < out.indexOf('GAMMA'),
);

// 5b. 读不动的叠层必须出声（权限/坏路径），不能像缺文件那样静默跳过。
//     用目录冒充 overlay.md 造 EISDIR，跨平台都能触发（Windows 上 chmod 不管用）。
fs.mkdirSync(path.join(agentsDir, 'broken', 'overlay.md'), { recursive: true });
const broken = contact('broken', 'claude-cli', {});
const logs: string[] = [];
out = (await composer.composeStart({ ...ctxFor(broken), log: (m) => logs.push(m) }, null)).preamble;
check('读不动的叠层不注入抬头', !out.includes('联系人叠层 overlay'));
check(
  '读不动的叠层要打日志',
  logs.some((line) => line.includes('contact overlay unreadable')),
  logs.join(' | ')
);
const quietLogs: string[] = [];
await composer.composeStart({ ...ctxFor(bare), log: (m) => quietLogs.push(m) }, null);
check(
  '缺文件仍然安静（那是正常配置）',
  !quietLogs.some((line) => line.includes('contact overlay')),
  quietLogs.join(' | ')
);

// 6. 不传 agentsDir 的旧构造方式仍然可用（不注入叠层）
const legacy = new PromptComposer(null, messages);
out = (await legacy.composeStart(ctxFor(withCwd), null)).preamble;
check('未配置 agentsDir 时整层关闭', !out.includes('联系人叠层 overlay') && !out.includes('ALPHA'));

// 7. 仓库里的真实 overlay：存在、有体量约束、不重抄厂商 base 原文
const repoAgents = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'agents');
for (const name of ['claude', 'codex', 'aye']) {
  const file = path.join(repoAgents, name, 'overlay.md');
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  check(`${name} 有 overlay.md`, body.trim().length > 0, file);
  check(`${name} overlay 体量受控（<2500 字符）`, body.length < 2500, `${body.length}`);
  check(
    `${name} overlay 未重抄 base 原文`,
    !/You are Claude Code|# Delivering work|# Corrections/.test(body),
  );
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
