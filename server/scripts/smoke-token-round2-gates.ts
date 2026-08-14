/**
 * Token round2 mainline 4 gates (撤闸必红):
 * C1 nsfwCraft switch + intimate fail-open scene gate
 * C2 TEMPORAL_CONTEXT_RULES only when replay/history present
 *
 * Reverting the round2 demotion / conditional temporal injection must turn this red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageRepo } from '../src/agents/messageRepo.js';
import { PromptComposer, type PromptContext } from '../src/agents/promptComposer.js';
import { openDb } from '../src/db.js';
import {
  buildSessionPreamble,
  countEngineeringSignals,
  isIntimateScene,
  nsfwCraftCompact,
  shouldInjectNsfwCraft,
  TEMPORAL_CONTEXT_RULES,
} from '../src/memory/inject.js';
import { estimateTokens } from '../src/agents/tokenEstimate.js';
import type { ContactRow } from '../src/db.js';

const NSFW_MARK = 'NSFW 书写工艺（网关 compact';
const TEMPORAL_MARK = '# 时间语义（网关强制）';

const vault = {
  async call(name: string): Promise<string> {
    if (name === 'get_core_context' || name === 'get_context') {
      return '---\ntype: memory\n---\n# compact facts\n- identity.name: User';
    }
    if (name === 'search_vault') return '没有找到相关内容。';
    throw new Error(`unexpected ${name}`);
  },
} as any;

// --- pure helpers: detector fail-open contract ---
assert.equal(isIntimateScene(''), true, 'empty → fail-open inject');
assert.equal(isIntimateScene(null), true, 'null → fail-open inject');
assert.equal(isIntimateScene('今晚想你，抱紧我亲我'), true, 'intimate Chinese → inject');
assert.equal(isIntimateScene('npm run build && git commit -m fix'), false, 'pure engineering multi-signal → skip');
assert.equal(
  isIntimateScene('帮我看下这个 smoke 报错，顺便…其实也想抱抱'),
  true,
  'mixed uncertain with intimate cue → inject'
);
// Multi-signal gate: a single engineering hit must NOT skip (comment contract 多个工程信号).
// 撤闸必红: if MIN_ENGINEERING_SIGNALS_TO_SKIP is lowered to 1 / single RE.test restored,
// the soft-intimate + sparse eng cases below flip to false and this smoke fails.
assert.equal(countEngineeringSignals('帮看一下这个 commit'), 1, 'single eng token counts as 1');
assert.equal(isIntimateScene('帮看一下这个 commit'), true, 'single eng signal → fail-open inject');
assert.equal(
  countEngineeringSignals('npm run build && git commit -m fix'),
  3,
  'npm+git+commit are three independent signals'
);
assert.equal(
  shouldInjectNsfwCraft('off', '今晚想你'),
  false,
  'off never injects'
);
assert.equal(shouldInjectNsfwCraft('always', 'npm run build'), true, 'always always injects');
// pure multi-signal engineering still skips under intimate mode
assert.equal(
  shouldInjectNsfwCraft('intimate', 'npm run build && git commit -m fix'),
  false,
  'intimate+multi-signal engineering skips'
);
// single eng signal alone must not skip (fail-open)
assert.equal(
  shouldInjectNsfwCraft('intimate', 'npm run build'),
  true,
  'intimate+single eng signal fails open (inject)'
);
assert.equal(shouldInjectNsfwCraft('intimate', '抱紧我'), true, 'intimate+scene injects');
assert.equal(shouldInjectNsfwCraft('intimate', ''), true, 'intimate+empty fail-open');
assert.equal(shouldInjectNsfwCraft(undefined, ''), true, 'default intimate fail-open');

// --- C1 false-negative class from real review: intimate + sparse eng words still inject ---
// Hard-marker intimate + one eng token (should already inject via INTIMATE_SCENE_RE).
const hardIntimateSparseEng =
  '今晚想你，抱紧我亲我……对了那个 commit 先放一边，别扫兴';
assert.equal(
  countEngineeringSignals(hardIntimateSparseEng),
  1,
  'hard-intimate fixture has only one eng signal'
);
assert.equal(
  isIntimateScene(hardIntimateSparseEng),
  true,
  'hard intimate + single eng word → inject'
);
assert.equal(
  shouldInjectNsfwCraft('intimate', hardIntimateSparseEng),
  true,
  'shouldInject hard intimate + sparse eng → inject'
);

// Soft intimate body language WITHOUT hard INTIMATE_SCENE_RE hits + single eng word.
// This is the exact false-negative class: loose single-signal skip misclassifies as engineering.
// 撤闸必红: restoring PURE_ENGINEERING_RE.test / single-signal skip makes these assert red.
const softIntimateSparseEngCases = [
  '腿缠着你，呼吸贴得很近，身体还在发烫。那个 deploy 明天再说',
  '今晚就想窝在你怀里别动，git 什么的先别管',
  '手指还停在腰侧，别急着去看那个 commit',
];
for (const sample of softIntimateSparseEngCases) {
  assert.ok(
    countEngineeringSignals(sample) === 1,
    `soft-intimate fixture must be single-signal for 撤闸必红: ${sample}`
  );
  assert.equal(
    isIntimateScene(sample),
    true,
    `soft intimate + sparse eng must inject (false-neg guard): ${sample}`
  );
  assert.equal(
    shouldInjectNsfwCraft('intimate', sample),
    true,
    `shouldInject soft intimate + sparse eng: ${sample}`
  );
}

// --- C1 preamble: always in session; intimate/off out of session ---
const alwaysPreamble = await buildSessionPreamble(
  vault,
  { id: 'partner', name: 'Partner', backend: 'api' },
  'compact',
  { nsfwCraft: 'always' }
);
assert.match(alwaysPreamble, new RegExp(NSFW_MARK), 'always → session preamble has nsfw');
assert.equal(alwaysPreamble.split(NSFW_MARK).length - 1, 1, 'always nsfw once');

const intimatePreamble = await buildSessionPreamble(
  vault,
  { id: 'partner', name: 'Partner', backend: 'api' },
  'compact',
  { nsfwCraft: 'intimate' }
);
assert.doesNotMatch(
  intimatePreamble,
  new RegExp(NSFW_MARK),
  'intimate → not in static session preamble (per-turn path)'
);

const offPreamble = await buildSessionPreamble(
  vault,
  { id: 'bot', name: 'Bot', backend: 'api' },
  'compact',
  { nsfwCraft: 'off' }
);
assert.doesNotMatch(offPreamble, new RegExp(NSFW_MARK), 'off → no nsfw in preamble');

// default option (omit) = intimate demotion
const defaultPreamble = await buildSessionPreamble(
  vault,
  { id: 'x', name: 'X', backend: 'api' },
  'compact'
);
assert.doesNotMatch(defaultPreamble, new RegExp(NSFW_MARK), 'default mode demotes nsfw out of preamble');

// --- compose path with real DB ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-round2-'));
const dbPath = path.join(dir, 'hub.db');
const db = openDb(dbPath);
const messages = new MessageRepo(db);
const composer = new PromptComposer(vault, messages, null);

function insertContact(id: string, backend: string, config: Record<string, unknown>): ContactRow {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', ?)`
  ).run(id, id, backend, JSON.stringify(config));
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
}

function ctxFor(agent: ContactRow, isRoom = false): PromptContext {
  return {
    agent,
    convo: agent,
    isRoom,
    memory: {
      mcpUrl: null,
      repoPath: null,
      injectOnSpawn: true,
      searchPerTurn: false,
      capture: false,
      maxTurnChars: 800,
      sessionMaxAgeHours: 12,
    },
    userName: 'User',
    nameOf: (s) => s,
    log: () => {},
  };
}

try {
  const always = insertContact('always-c', 'api', { nsfwCraft: 'always', memoryPreambleMode: 'compact' });
  const intimate = insertContact('intimate-c', 'api', { nsfwCraft: 'intimate', memoryPreambleMode: 'compact' });
  const off = insertContact('off-c', 'api', { nsfwCraft: 'off', memoryPreambleMode: 'compact' });
  const fresh = insertContact('fresh-c', 'claude-cli', { nsfwCraft: 'off' });
  const hist = insertContact('hist-c', 'claude-cli', { nsfwCraft: 'off' });

  // C1 always: present in composeStart preamble
  const alwaysStart = await composer.composeStart(ctxFor(always), 'resume-token');
  assert.match(alwaysStart.preamble, new RegExp(NSFW_MARK), 'compose always still has nsfw');

  // C1 off: absent in start and turn
  const offStart = await composer.composeStart(ctxFor(off), 'resume-token');
  assert.doesNotMatch(offStart.preamble, new RegExp(NSFW_MARK), 'compose off has no nsfw in start');
  const offTurn = await composer.composeTurn(ctxFor(off), '你好', '今晚抱紧我亲我', new Set());
  assert.doesNotMatch(offTurn, new RegExp(NSFW_MARK), 'compose off has no nsfw on intimate turn');

  // C1 intimate: absent in start; present on intimate turn; absent on pure engineering turn
  const intimateStart = await composer.composeStart(ctxFor(intimate), 'resume-token');
  assert.doesNotMatch(
    intimateStart.preamble,
    new RegExp(NSFW_MARK),
    'compose intimate has no nsfw in static start'
  );
  const intimateTurn = await composer.composeTurn(
    ctxFor(intimate),
    '用户正文',
    '今晚想你，抱紧我',
    new Set()
  );
  assert.match(intimateTurn, new RegExp(NSFW_MARK), 'intimate scene turn injects nsfw');
  assert.equal(
    intimateTurn.split(NSFW_MARK).length - 1,
    1,
    'intimate turn nsfw once'
  );
  const engTurn = await composer.composeTurn(
    ctxFor(intimate),
    '用户正文',
    'npm run build --prefix server 挂了，帮看 commit',
    new Set()
  );
  assert.doesNotMatch(engTurn, new RegExp(NSFW_MARK), 'pure multi-signal engineering turn skips nsfw');
  // single eng signal alone must not skip on compose path either
  const singleEngTurn = await composer.composeTurn(
    ctxFor(intimate),
    '用户正文',
    '帮看一下这个 commit',
    new Set()
  );
  assert.match(singleEngTurn, new RegExp(NSFW_MARK), 'single eng signal compose turn fail-open injects');
  // fail-open: empty / short non-engineering uncertain text still injects
  const uncertainTurn = await composer.composeTurn(ctxFor(intimate), '嗯', '嗯', new Set());
  assert.match(uncertainTurn, new RegExp(NSFW_MARK), 'uncertain short text fail-open injects');

  // compose path: hard intimate + sparse eng still injects
  const hardMixedTurn = await composer.composeTurn(
    ctxFor(intimate),
    '用户正文',
    hardIntimateSparseEng,
    new Set()
  );
  assert.match(hardMixedTurn, new RegExp(NSFW_MARK), 'compose hard intimate + sparse eng injects');

  // compose path: soft intimate + single eng (false-neg class) still injects — 撤闸必红
  for (const sample of softIntimateSparseEngCases) {
    const mixedTurn = await composer.composeTurn(ctxFor(intimate), '用户正文', sample, new Set());
    assert.match(
      mixedTurn,
      new RegExp(NSFW_MARK),
      `compose soft intimate + sparse eng injects: ${sample}`
    );
  }

  // --- C2 temporal: omit on pure new session; present with history/replay/resume ---
  const freshStart = await composer.composeStart(ctxFor(fresh), null);
  assert.doesNotMatch(
    freshStart.preamble,
    new RegExp(TEMPORAL_MARK),
    'pure new session without history omits temporal rules'
  );
  assert.doesNotMatch(
    freshStart.preamble,
    /# 对话存档回放/,
    'fixture sanity: fresh has no replay'
  );

  // resume implies continuing session → temporal required even without local replay block
  const resumed = await composer.composeStart(ctxFor(fresh), 'resume-token');
  assert.match(
    resumed.preamble,
    new RegExp(TEMPORAL_MARK),
    'resumeToken requires temporal co-presence'
  );

  // seed history → CLI bridge injects replay → temporal co-present
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, created_at)
     VALUES ('hist-c', 'user', 'user', 'text', '上周聊过的旧话题', 'done', '2026-08-01 01:00:00')`
  ).run();
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, created_at)
     VALUES ('hist-c', 'hist-c', 'assistant', 'text', '旧回复', 'done', '2026-08-01 01:01:00')`
  ).run();
  const histStart = await composer.composeStart(ctxFor(hist), null);
  assert.match(histStart.preamble, /# 对话存档回放/, 'history must produce replay for CLI');
  assert.match(
    histStart.preamble,
    new RegExp(TEMPORAL_MARK),
    'replay present → temporal rules co-present'
  );
  assert.ok(
    histStart.preamble.indexOf(TEMPORAL_MARK) < histStart.preamble.indexOf('# 对话存档回放'),
    'temporal rules must sit with/before replay block'
  );

  // token comparison receipt numbers (per-contact preamble delta for default demotion)
  const nsfwTokens = estimateTokens(nsfwCraftCompact());
  const temporalTokens = estimateTokens(TEMPORAL_CONTEXT_RULES);
  const beforeAlwaysTokens = estimateTokens(alwaysPreamble);
  const afterIntimateTokens = estimateTokens(intimatePreamble);
  const report = {
    ok: true,
    nsfwCraftTokens: nsfwTokens,
    temporalTokens,
    preambleTokens: {
      nsfwAlways: beforeAlwaysTokens,
      nsfwIntimateDefault: afterIntimateTokens,
      savedByDemotingNsfwFromPreamble: beforeAlwaysTokens - afterIntimateTokens,
    },
    gates: {
      c1_always_injects: true,
      c1_off_skips: true,
      c1_intimate_scene_injects: true,
      c1_intimate_engineering_multi_signal_skips: true,
      c1_single_eng_signal_fail_open: true,
      c1_soft_intimate_sparse_eng_injects: true,
      c1_fail_open: true,
      c2_fresh_omits_temporal: true,
      c2_resume_has_temporal: true,
      c2_replay_has_temporal: true,
    },
    fixture: 'smoke-token-round2-gates alwaysPreamble vs intimatePreamble (vault mock compact facts)',
  };
  console.log(JSON.stringify(report, null, 2));
  console.log('token round2 gates smoke: ok');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
