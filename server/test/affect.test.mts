import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow } from '../src/db.js';
import { AffectRepo, affectEnabled, affectPromptBlock, decayAffect } from '../src/agents/affect.js';
import { AffectService } from '../src/agents/affectService.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-'));
const db = openDb(path.join(dir, 'hub.db'));
const add = (id: string, affect: string): ContactRow => {
  db.prepare(`INSERT INTO contacts(id,name,avatar,color,backend,kind,config)
    VALUES(?,?,'x','#000','claude-cli','dm',?)`).run(id, id, JSON.stringify({ affect }));
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(id) as ContactRow;
};

try {
  const claude = add('claude', 'on');
  const off = add('off', 'off');
  const worker = add('triage-worker', 'on');
  assert.equal(affectEnabled(claude), true);
  assert.equal(affectEnabled(off), false);
  assert.equal(affectEnabled(worker), false);

  const normal = decayAffect({ valence: .8, arousal: .95 }, { valence: 0, arousal: .15 }, 6 * 60 * 60_000);
  assert.ok(Math.abs(normal.valence - .4) < 1e-9);
  assert.ok(normal.arousal < .16);
  const risky = decayAffect({ valence: -.4, arousal: .95 }, { valence: 0, arousal: .15 }, 3 * 60 * 60_000);
  assert.ok(Math.abs(risky.valence + .2) < 1e-9);

  const repo = new AffectRepo(db);
  const at = new Date('2026-08-05T07:00:00Z');
  repo.upsert('claude', { valence: -1, arousal: 2, reason: 'clamp' }, at);
  const state = repo.current(claude, at.getTime())!;
  assert.deepEqual([state.valence, state.arousal], [-.6, 1]);
  const block = affectPromptBlock(state);
  assert.match(block, /背景，不是台词或行为指令/);
  assert.doesNotMatch(block, /valence|arousal|-0\.6/i);

  let calls = 0;
  const service = new AffectService(db, () => {}, async () => {
    calls++;
    return { valence: .5, arousal: .4, reason: 'warm', costCny: .001 };
  });
  assert.equal(await service.scoreAfterTurn(claude, 'user', 'reply'), true);
  assert.equal(await service.scoreAfterTurn(off, 'private', 'private'), false);
  assert.equal(await service.scoreAfterTurn(worker, 'private', 'private'), false);
  assert.equal(calls, 1);
  assert.equal(repo.current(claude)!.reason, 'warm');
  process.env.AFFECT_DAILY_COST_CNY = '.001';
  process.env.AFFECT_SCORE_RESERVED_COST_CNY = '.002';
  assert.equal(await service.scoreAfterTurn(claude, 'blocked', 'blocked'), false);
  assert.equal(calls, 1);
  delete process.env.AFFECT_DAILY_COST_CNY;
  delete process.env.AFFECT_SCORE_RESERVED_COST_CNY;
  console.log('affect M1 checks passed');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
