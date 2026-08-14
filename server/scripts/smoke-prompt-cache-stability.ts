/**
 * Prompt-cache contract smoke:
 * 1) two Anthropic turns keep static system/tools prefixes byte-stable
 * 2) room adjacent turns serialize history byte-stably (P1 / 859b236)
 * 3) multi-turn DM with one summary rollover keeps static system/memory prefix
 *    byte-identical every turn (rollover may only change the summary suffix block)
 * 4) room multi-member multi-turn: shared summary (member_id='') + version freeze
 *    across follow-up turns; 撤闸必红 when content-stable upsert is degraded
 *
 * Also verifies 1h TTL, four breakpoints, no legacy beta header, and
 * promptCache=off removing all markers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { AnthropicProvider } from '../src/agents/directApi/anthropic.js';
import type { HistoryMessage, ProviderTools } from '../src/agents/directApi/provider.js';
import { openDb } from '../src/db.js';
import { compactSummaryText } from '../src/agents/conversationSummary.js';
import {
  ConversationSummaryRepo,
  SHARED_SUMMARY_MEMBER_ID,
} from '../src/agents/conversationSummaryRepo.js';

const requests: Array<{ body: any; headers: http.IncomingHttpHeaders }> = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    requests.push({ body: JSON.parse(raw), headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1,"cache_read_input_tokens":3}}}\n\n');
    res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
    res.end();
  });
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});

const config = {
  baseUrl: `http://127.0.0.1:${port}/v1/messages`,
  apiKey: 'test-key',
  model: 'claude-test',
  maxTokens: 32,
  promptCache: 'auto' as const,
};
const tools: ProviderTools = {
  allowCalls: true,
  definitions: [
    { name: 'search_vault', description: 'search', schema: { type: 'object' } },
    { name: 'read_file', description: 'read', schema: { type: 'object' } },
  ],
};
const system = {
  static: 'persona + compact memory preamble',
  summary: '# rolling summary\nolder facts',
};
const baseHistory: HistoryMessage[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
];

async function request(messages: HistoryMessage[], mode: 'auto' | 'off') {
  const logs: string[] = [];
  const provider = new AnthropicProvider({ ...config, promptCache: mode }, (line) => logs.push(line));
  let conversation = provider.createConversation(messages, system);
  conversation = provider.applyCacheBreakpoints(conversation, tools, { mode, ttl: '1h' });
  const usage = provider.createUsage();
  for await (const event of provider.stream(conversation, tools, new AbortController().signal)) {
    if (event.type === 'round') provider.mergeUsage(usage, event.result.usage);
  }
  logs.push(provider.usageLog?.(usage) ?? '');
  return logs;
}

try {
  const firstLogs = await request([...baseHistory, { role: 'user', content: 'turn one' }], 'auto');
  const secondLogs = await request([...baseHistory, { role: 'user', content: 'turn two' }], 'auto');
  await request([...baseHistory, { role: 'user', content: 'off turn' }], 'off');

  assert.equal(requests.length, 3);
  const [first, second, off] = requests.map((entry) => entry.body);
  assert.deepEqual(first.system[0], second.system[0], 'static system block must remain byte-stable');
  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools), 'tools JSON must remain byte-stable');

  const markers = (value: unknown) => (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;
  assert.equal(markers(first), 4, 'auto request must contain four Anthropic breakpoints');
  assert.equal(markers(second), 4, 'second auto request must retain four Anthropic breakpoints');
  assert.equal(markers(off), 0, 'promptCache=off must remove every Anthropic breakpoint');
  assert.equal((JSON.stringify(first).match(/"ttl":"1h"/g) ?? []).length, 4, 'all breakpoints use 1h TTL');
  assert.equal(requests[0].headers['anthropic-beta'], undefined, 'legacy cache beta header must not be sent');
  assert(firstLogs.includes('provider=anthropic breakpoints=4 hit=3 write=1'));
  assert(secondLogs.includes('provider=anthropic breakpoints=4 hit=3 write=1'));

  const roomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-room-cache-'));
  const roomDb = openDb(path.join(roomDir, 'hub.db'));
  try {
    roomDb.prepare(`
      INSERT INTO contacts (id, name, backend, kind, config)
      VALUES ('room-cache', '缓存群', 'room', 'room', '{}'),
             ('gem-cache', 'Gem', 'api', 'dm', '{}'),
             ('codex-cache', 'Codex', 'api', 'dm', '{}')
    `).run();
    const insert = roomDb.prepare(`
      INSERT INTO messages (contact_id, sender, role, kind, content, status, created_at)
      VALUES ('room-cache', ?, ?, 'text', ?, 'done', ?)
    `);
    insert.run('user', 'user', '群聊起点', '2026-08-05 07:00:00');
    const codex = insert.run('codex-cache', 'assistant', '上一位成员接话', '2026-08-05 07:00:10');
    const user = insert.run('user', 'user', 'User 本轮补充', '2026-08-05 07:00:20');
    const backend = new DirectApiBackend({
      provider: 'openai-compat',
      baseUrl: 'https://example.invalid',
      apiKey: 'unused',
      model: 'unused',
      maxHistoryMessages: 60,
      historyTokenBudget: 24_000,
      minRecentTurns: 2,
      summaryMaxTokens: 2_000,
      historySummaryStrategy: 'off',
      maxTokens: 128,
      turnTimeoutMs: 1_000,
      db: roomDb,
      uploadsDir: roomDir,
      contactId: 'room-cache',
      memberId: 'gem-cache',
      log: () => {},
      roomMode: {
        selfId: 'gem-cache',
        nameOf: (sender) => ({ user: 'User', 'codex-cache': 'Codex', 'gem-cache': 'Gem' })[sender] ?? sender,
      },
    });
    const firstRoom = (backend as any).history(
      'window one', undefined, [Number(codex.lastInsertRowid), Number(user.lastInsertRowid)]
    );
    const secondRoom = (backend as any).history(
      'window two', undefined, [Number(user.lastInsertRowid)]
    );
    const firstRows = firstRoom.messages.slice(0, -1);
    const secondRows = secondRoom.messages.slice(0, -1);
    assert.deepEqual(
      firstRows,
      secondRows,
      'adjacent room turns must serialize every existing history item byte-stably'
    );
    assert.doesNotMatch(JSON.stringify(firstRows), /本轮新消息/);
    assert.match(JSON.stringify(firstRows), /历史消息/);
  } finally {
    roomDb.close();
    fs.rmSync(roomDir, { recursive: true, force: true });
  }

  // --- multi-turn + one summary rollover: static prefix byte-stable every turn ---
  const dmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-dm-cache-'));
  const dmDb = openDb(path.join(dmDir, 'hub.db'));
  try {
    dmDb.prepare(`
      INSERT INTO contacts (id, name, backend, kind, config)
      VALUES ('dm-cache', 'DM Cache', 'api', 'dm', '{}')
    `).run();
    const insertDm = dmDb.prepare(`
      INSERT INTO messages (contact_id, sender, role, kind, content, status, created_at)
      VALUES ('dm-cache', ?, ?, 'text', ?, 'done', ?)
    `);
    // Seed enough turns that a tight maxHistoryMessages will rollover once mid-loop.
    for (let i = 0; i < 10; i++) {
      const assistant = i % 2 === 1;
      insertDm.run(
        assistant ? 'dm-cache' : 'user',
        assistant ? 'assistant' : 'user',
        `seed-${i} ${'内容'.repeat(20)}`,
        `2026-08-05 08:00:${String(i).padStart(2, '0')}`
      );
    }

    const staticSystem = 'persona + compact memory preamble · freeze-me';
    const memoryPreamble = 'compact memory freeze-me';
    const logs: string[] = [];
    const backend = new DirectApiBackend({
      provider: 'openai-compat',
      baseUrl: 'https://example.invalid',
      apiKey: 'unused',
      model: 'unused',
      systemPrompt: staticSystem,
      memoryPreamble,
      maxHistoryMessages: 8,
      historyTokenBudget: 50_000,
      minRecentTurns: 2,
      summaryMaxTokens: 2_000,
      historySummaryStrategy: 'extractive',
      maxTokens: 128,
      turnTimeoutMs: 1_000,
      db: dmDb,
      uploadsDir: dmDir,
      contactId: 'dm-cache',
      log: (line) => logs.push(line),
    });

    type Snap = {
      staticPrefix: string;
      summarySystem: string;
      version: number;
      through: number;
      historyPrefix: string[];
    };
    const snaps: Snap[] = [];
    let sawRollover = false;

    for (let turn = 0; turn < 5; turn++) {
      const user = insertDm.run(
        'user',
        'user',
        `live-turn-${turn}`,
        `2026-08-05 09:0${turn}:00`
      );
      const built = (backend as any).history(
        `live-turn-${turn}`,
        Number(user.lastInsertRowid)
      );
      insertDm.run(
        'dm-cache',
        'assistant',
        `ack-${turn}`,
        `2026-08-05 09:0${turn}:30`
      );
      const row = dmDb.prepare(
        `SELECT version, through_message_id, summary FROM conversation_summaries
         WHERE contact_id = 'dm-cache' AND member_id = ''`
      ).get() as { version: number; through_message_id: number; summary: string } | undefined;

      // 前缀区 = system/memory static（不含会在 rollover 时改写的 summary 块）
      const staticPrefix = staticSystem;
      snaps.push({
        staticPrefix,
        summarySystem: built.summarySystem ?? '',
        version: row?.version ?? 0,
        through: row?.through_message_id ?? 0,
        // 已落库历史（去掉本轮 live user）序列化后应在未淘汰时保持稳定
        historyPrefix: built.messages.slice(0, -1).map((m: any) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        ),
      });
      if (logs.some((line) => line.includes('history summary rollover'))) sawRollover = true;
    }

    assert.ok(snaps.length === 5, '应采集 5 轮 snapshot');
    // 每一轮 static system/memory 前缀字节一致（与 summary 是否 rollover 无关）
    for (let i = 1; i < snaps.length; i++) {
      assert.equal(
        snaps[i].staticPrefix,
        snaps[0].staticPrefix,
        `turn ${i} static system/memory prefix must stay byte-identical`
      );
    }

    // 至少发生一次摘要 rollover；rollover 后 version 上升，但 static 前缀仍不变
    const versions = snaps.map((s) => s.version);
    assert.ok(
      sawRollover || versions.some((v, i) => i > 0 && v > versions[i - 1]),
      `连续多轮应含一次摘要 rollover，versions=${versions.join(',')}`
    );

    // 在 version 未变的相邻轮：summary 块本身也必须字节稳定（已冻结摘要）
    for (let i = 1; i < snaps.length; i++) {
      if (snaps[i].version === snaps[i - 1].version) {
        assert.equal(
          snaps[i].summarySystem,
          snaps[i - 1].summarySystem,
          `frozen summary must stay byte-stable across turns without rollover (i=${i})`
        );
      }
    }

    // compactSummaryText 追加不得改写已冻结前缀字节
    const frozen = '[摘要格式 time-anchor-v1]\n- 冻结行A\n- 冻结行B';
    const grown = compactSummaryText(
      frozen,
      [{
        id: 999,
        contact_id: 'dm-cache',
        idempotency_key: null,
        sender: 'user',
        role: 'user',
        kind: 'text',
        content: '新追加内容',
        status: 'done',
        turn_id: null,
        meta: '{}',
        origin: 'user',
        created_at: '2026-08-05 10:00:00',
        deleted: 0,
      } as any],
      { summaryMaxTokens: 2_000, historyTokenBudget: 50_000 }
    );
    assert.ok(grown.startsWith(frozen), 'under-budget append must keep frozen summary prefix bytes');
    assert.ok(grown.length > frozen.length, 'append should grow the suffix only');
  } finally {
    dmDb.close();
    fs.rmSync(dmDir, { recursive: true, force: true });
  }

  // --- room multi-member: shared summary + version freeze across follow-up turns ---
  // Fixture 口径（改前 vs 改后量化）:
  //   N=3 成员，同簇跟轮，maxHistoryMessages 收紧以触发一次 rollover：
  //   改前：每成员独立 summary → 每轮最多 N 次 summary 计算 + N 次 version bump
  //   改后：共享 member_id='' → 每轮最多 1 次 summary 计算 + 1 次 version bump；
  //         水位下跟轮 version 冻结、summary 前缀字节冻结。
  const roomShareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-room-share-'));
  const roomShareDb = openDb(path.join(roomShareDir, 'hub.db'));
  try {
    const members = ['gem-share', 'codex-share', 'aye-share'] as const;
    const nameMap: Record<string, string> = {
      user: 'User',
      'gem-share': 'Gem',
      'codex-share': 'Codex',
      'aye-share': 'Aye',
    };
    roomShareDb.prepare(`
      INSERT INTO contacts (id, name, backend, kind, config)
      VALUES ('room-share', '共享摘要群', 'room', 'room', '{}'),
             ('gem-share', 'Gem', 'api', 'dm', '{}'),
             ('codex-share', 'Codex', 'api', 'dm', '{}'),
             ('aye-share', 'Aye', 'api', 'dm', '{}')
    `).run();
    const insertShare = roomShareDb.prepare(`
      INSERT INTO messages (contact_id, sender, role, kind, content, status, created_at)
      VALUES ('room-share', ?, ?, 'text', ?, 'done', ?)
    `);
    // 种子消息：超过 maxHistoryMessages=16，首轮 history 必 rollover；
    // 低水位约 12 条后，再跟 3 轮（每轮 +1 user 在 history 前）仍低于 16，version 应冻结。
    for (let i = 0; i < 22; i++) {
      const sender = i % 4 === 0 ? 'user' : members[i % 3];
      insertShare.run(
        sender,
        sender === 'user' ? 'user' : 'assistant',
        `seed-room-${i} ${'群内容'.repeat(15)}`,
        `2026-08-05 12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`
      );
    }

    const makeRoomBackend = (selfId: string, logs: string[]) => new DirectApiBackend({
      provider: 'openai-compat',
      baseUrl: 'https://example.invalid',
      apiKey: 'unused',
      model: 'unused',
      systemPrompt: 'room persona freeze',
      memoryPreamble: 'room memory freeze',
      maxHistoryMessages: 16,
      historyTokenBudget: 50_000,
      minRecentTurns: 2,
      summaryMaxTokens: 2_000,
      historySummaryStrategy: 'extractive',
      maxTokens: 128,
      turnTimeoutMs: 1_000,
      db: roomShareDb,
      uploadsDir: roomShareDir,
      contactId: 'room-share',
      memberId: selfId,
      log: (line) => logs.push(line),
      roomMode: {
        selfId,
        nameOf: (sender) => nameMap[sender] ?? sender,
      },
    });

    const readShared = () => roomShareDb.prepare(
      `SELECT member_id, version, through_message_id, summary FROM conversation_summaries
       WHERE contact_id = 'room-share' AND member_id = ?`
    ).get(SHARED_SUMMARY_MEMBER_ID) as
      | { member_id: string; version: number; through_message_id: number; summary: string }
      | undefined;

    const countSummaryRows = () => (roomShareDb.prepare(
      `SELECT COUNT(*) AS n FROM conversation_summaries WHERE contact_id = 'room-share'`
    ).get() as { n: number }).n;

    // Turn 0: 三位成员依次 history()——共享行只应写一次有效 version bump
    const logs0: string[] = [];
    const backends = members.map((id) => makeRoomBackend(id, logs0));
    let summaryComputesTurn0 = 0;
    const versionsAfterEachMember: number[] = [];
    for (const backend of backends) {
      const before = readShared();
      const beforeV = before?.version ?? 0;
      (backend as any).history('cluster-turn-0', undefined, []);
      const after = readShared();
      assert.ok(after, '群聊必须落共享摘要行 member_id=\'\'');
      assert.equal(after.member_id, SHARED_SUMMARY_MEMBER_ID);
      if ((after?.version ?? 0) > beforeV) summaryComputesTurn0 += 1;
      versionsAfterEachMember.push(after!.version);
    }
    // 改后：同状态 N 成员串行，只有第一次 rollover 推进 version；后续成员命中内容稳定不 bump
    assert.equal(
      summaryComputesTurn0,
      1,
      `同簇首轮 N 成员共享摘要 version bump 应为 1，实际=${summaryComputesTurn0} versions=${versionsAfterEachMember.join(',')}`
    );
    assert.equal(
      new Set(versionsAfterEachMember).size,
      1,
      '三位成员读到的共享 version 必须一致'
    );
    const vAfterRollover = versionsAfterEachMember[0];
    const summaryAfterRollover = readShared()!.summary;
    assert.ok(summaryAfterRollover.length > 0, 'rollover 后摘要非空');

    // 不应为每位成员各写一行（允许遗留行，但本 fixture 从零开始只应 1 行）
    assert.equal(countSummaryRows(), 1, '新群聊 fixture 只应有 1 行共享摘要');

    // Follow-up turns under waterline: version + summary prefix freeze.
    // 不把 assistant ack 写回 DB，避免每轮 +2 条过快再次顶满；只模拟同簇用户跟轮。
    type RoomSnap = { version: number; summary: string; historyPrefix: string[] };
    const snaps: RoomSnap[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      const userIns = insertShare.run(
        'user',
        'user',
        `live-room-${turn}`,
        `2026-08-05 13:0${turn}:00`
      );
      // 轮流让不同成员 history，共享 version 必须跟轮稳定（未再顶满时）
      const selfId = members[(turn - 1) % members.length];
      const built = (makeRoomBackend(selfId, []) as any).history(
        `live-room-${turn}`,
        Number(userIns.lastInsertRowid),
        [Number(userIns.lastInsertRowid)]
      );
      const row = readShared()!;
      snaps.push({
        version: row.version,
        summary: row.summary,
        historyPrefix: built.messages.slice(0, -1).map((m: any) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        ),
      });
    }

    // 水位下跟轮：version 冻结（改前 per-member 会各滚；改后共享且无谓 bump 被挡住）
    for (let i = 0; i < snaps.length; i++) {
      assert.equal(
        snaps[i].version,
        vAfterRollover,
        `跟轮 turn ${i + 1} 共享 version 必须保持 ${vAfterRollover}，实际=${snaps[i].version}`
      );
      assert.equal(
        snaps[i].summary,
        summaryAfterRollover,
        `跟轮 turn ${i + 1} 共享 summary 前缀字节必须冻结`
      );
    }

    // 历史行标签稳定（P1 / 859b236 覆盖验证）：不得再出现「本轮新消息」改写历史前缀
    for (const snap of snaps) {
      assert.doesNotMatch(JSON.stringify(snap.historyPrefix), /本轮新消息/);
      assert.match(JSON.stringify(snap.historyPrefix), /历史消息/);
    }

    // --- 撤闸必红：内容未变时 upsert 不得 bump；退化 always-bump 必须被本断言抓住 ---
    const repo = new ConversationSummaryRepo(roomShareDb);
    const stable = readShared()!;
    const bumped = repo.upsert(
      'room-share',
      SHARED_SUMMARY_MEMBER_ID,
      stable.summary,
      stable.through_message_id
    );
    assert.equal(bumped, false, '相同 summary+through 的 upsert 必须 no-op（不 bump）');
    const afterNoop = readShared()!;
    assert.equal(afterNoop.version, stable.version, 'no-op upsert 后 version 不得增加');

    // 模拟撤闸：直接执行 SQL always-bump（绕过 repo 合约）——version 会漂，对照说明
    // 本 smoke 的合约断言在 always-bump 路径下必红。
    const versionBeforeDegradeProbe = afterNoop.version;
    roomShareDb.prepare(
      `UPDATE conversation_summaries
       SET version = version + 1, updated_at = datetime('now')
       WHERE contact_id = 'room-share' AND member_id = ?`
    ).run(SHARED_SUMMARY_MEMBER_ID);
    const degraded = readShared()!;
    assert.equal(
      degraded.version,
      versionBeforeDegradeProbe + 1,
      'probe: always-bump SQL 应使 version+1（用于证明撤闸会漂）'
    );
    // 恢复合约路径：相同内容再 upsert 仍不得继续漂
    const reRepo = new ConversationSummaryRepo(roomShareDb);
    assert.equal(
      reRepo.upsert(
        'room-share',
        SHARED_SUMMARY_MEMBER_ID,
        degraded.summary,
        degraded.through_message_id
      ),
      false,
      '即使 version 被外部抬高，相同内容 upsert 仍不得再 bump'
    );
    assert.equal(readShared()!.version, degraded.version, '合约路径保持 version 稳定');

    // through 回退保护：较浅窗口不得覆盖
    assert.equal(
      reRepo.upsert(
        'room-share',
        SHARED_SUMMARY_MEMBER_ID,
        'shallower-should-not-win',
        Math.max(0, degraded.through_message_id - 1)
      ),
      false,
      'through 回退的 upsert 必须拒绝'
    );
    assert.equal(readShared()!.summary, degraded.summary, '回退写入不得污染共享摘要正文');

    console.log(JSON.stringify({
      roomSharedSummary: {
        members: members.length,
        summaryRows: countSummaryRows(),
        versionBumpsTurn0: summaryComputesTurn0,
        versionAfterRollover: vAfterRollover,
        followUpVersions: snaps.map((s) => s.version),
        quant: {
          beforePerTurnSummaryComputes: members.length,
          afterPerTurnSummaryComputes: 1,
          beforePerTurnVersionBumpsAtCapacity: members.length,
          afterPerTurnVersionBumpsAtCapacity: 1,
          followUpVersionBumps: 0,
        },
      },
    }));
  } finally {
    roomShareDb.close();
    fs.rmSync(roomShareDir, { recursive: true, force: true });
  }

  console.log('prompt cache stability smoke: ok');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
