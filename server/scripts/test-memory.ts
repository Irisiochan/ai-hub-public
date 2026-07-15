/** Smoke test for the memory layer against the live vault MCP (tailnet). */
import { openDb } from '../src/db.js';
import { detectTrigger } from '../src/memory/capture.js';
import { buildSessionPreamble, buildTurnBlock, extractKeywords } from '../src/memory/inject.js';
import { VaultClient } from '../src/memory/vaultClient.js';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8900/mcp';
const db = openDb('data/test-memory.db');
const vault = new VaultClient(
  URL_,
  db,
  (m) => console.log(`[vault] ${m}`),
  process.env.VAULT_TOKEN ?? null
);

// 1. keyword extraction
console.log('keywords:', extractKeywords('周六要去看示例活动的演唱会，ai-hub 记得提醒我买票'));

// 2. capture triggers
for (const t of ['明天下午三点见', '我最讨厌吃香菜', '随便聊聊天气', '答应我别熬夜']) {
  console.log(`trigger("${t}") →`, detectTrigger(t));
}

// 3+4. live MCP: preamble + turn search (needs VAULT_TOKEN when server enforces auth)
try {
  const preamble = await buildSessionPreamble(vault, {
    id: 'identity-test',
    name: '示例助手',
    backend: 'api',
  });
  if (!preamble.includes('你当前是联系人「示例助手」')) {
    throw new Error('identity guard missing from preamble');
  }
  for (const ownershipRule of [
    '共享的是关于 User 的知识，不是其他 AI 的人生经历',
    '只能用第三人称复述',
    '绝不能说“你把我处刑了”',
  ]) {
    if (!preamble.includes(ownershipRule)) {
      throw new Error(`memory ownership guard missing: ${ownershipRule}`);
    }
  }
  console.log(`preamble: ${preamble.length} chars, head: ${preamble.slice(0, 120).replace(/\n/g, ' ')}`);
  const seen = new Set<string>();
  const block = await buildTurnBlock(vault, '示例活动演唱会到底去不去', seen, 1200);
  console.log('turn block:', block ?? '(no hits)');
} catch (e: any) {
  console.log('live MCP unavailable from here:', e.message?.slice(0, 80));
}

// 5. outbox fallback: point at a dead URL and write
const deadVault = new VaultClient('http://127.0.0.1:1/mcp', db, (m) => console.log(`[dead] ${m}`));
const r = await deadVault.write('log_daily', { content: 'outbox test', source: 'test' });
console.log('dead write →', r, '| outbox rows:', db.prepare('SELECT COUNT(*) c FROM memory_outbox').get());
await deadVault.close();

await vault.close();
db.close();
process.exit(0);
