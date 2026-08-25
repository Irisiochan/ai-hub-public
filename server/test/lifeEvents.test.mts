import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow } from '../src/db.js';
import {
  LifeEventRepo,
  LifeEventService,
  detectLifeEventTrigger,
  lifeEventsEnabled,
  shanghaiStamp,
  type LifeEventExtractResult,
} from '../src/agents/lifeEvents.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-events-'));
const db = openDb(path.join(dir, 'hub.db'));

const addContact = (id: string, lifeEvents: string): ContactRow => {
  db.prepare(`INSERT INTO contacts(id,name,avatar,color,backend,kind,config)
    VALUES(?,?,'x','#000','claude-cli','dm',?)`).run(id, id, JSON.stringify({ lifeEvents }));
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(id) as ContactRow;
};
const addUserMessage = (contactId: string, content: string): number => {
  const r = db.prepare(`INSERT INTO messages(contact_id,sender,role,kind,content,status,meta,origin)
    VALUES(?,'user','user','text',?,'done','{}','main')`).run(contactId, content);
  return Number(r.lastInsertRowid);
};

try {
  const claude = addContact('claude', 'on');
  const codex = addContact('codex', 'on');
  const off = addContact('gem', 'off');
  const worker = addContact('triage-worker', 'on');

  // 开关与身份排除
  assert.equal(lifeEventsEnabled(claude), true);
  assert.equal(lifeEventsEnabled(off), false);
  assert.equal(lifeEventsEnabled(worker), false);

  // 正则闸：命中与不命中
  assert.equal(detectLifeEventTrigger('家里一楼倒灌进水了'), 'safety');
  assert.equal(detectLifeEventTrigger('刚才跳闸断电了'), 'safety');
  assert.equal(detectLifeEventTrigger('我下午睡了六个小时'), 'schedule');
  assert.equal(detectLifeEventTrigger('今天有点头疼想吃药'), 'health');
  assert.equal(detectLifeEventTrigger('老公抱抱我'), null);
  assert.equal(detectLifeEventTrigger('> 引用：家里进水了\n好的收到'), null);
  assert.equal(detectLifeEventTrigger('⚙ Worker 任务回执\n断电测试通过'), null);

  // Repo：insert → update（timeline 演进）→ resolve；TTL 惰性过期
  const repo = new LifeEventRepo(db);
  const t0 = new Date('2026-08-15T15:00:00Z');
  repo.insert({ severity: 'safety', summary: '上海暴雨，一楼开始进水', note: '暴雨倒灌', sourceContactId: 'claude', now: t0 });
  let active = repo.activeEvents(t0.getTime());
  assert.equal(active.length, 1);
  const eventId = active[0].id;
  repo.update(eventId, {
    severity: 'safety',
    summary: '家里进水后跳闸断电，准备临时搬离',
    note: '跳闸断电',
    sourceContactId: 'claude',
    now: new Date('2026-08-15T15:10:00Z'),
  });
  active = repo.activeEvents(Date.parse('2026-08-15T16:00:00Z'));
  assert.equal(active.length, 1);
  assert.equal(active[0].summary, '家里进水后跳闸断电，准备临时搬离');
  assert.equal(JSON.parse(active[0].timeline).length, 2);
  // safety TTL 48h：47h 后仍在，49h 后惰性过期
  assert.equal(repo.activeEvents(Date.parse('2026-08-17T14:00:00Z')).length, 1);
  assert.equal(repo.activeEvents(Date.parse('2026-08-17T16:30:00Z')).length, 0);
  assert.equal(
    (db.prepare('SELECT status FROM life_events WHERE id=?').get(eventId) as { status: string }).status,
    'expired'
  );

  // schedule TTL 12h
  repo.insert({ severity: 'schedule', summary: '下午睡了约六小时', note: '', sourceContactId: 'codex', now: t0 });
  assert.equal(repo.activeEvents(t0.getTime() + 11 * 3600_000).length, 1);
  assert.equal(repo.activeEvents(t0.getTime() + 13 * 3600_000).length, 0);
  const resolveTarget = repo.activeEvents(t0.getTime());
  assert.equal(resolveTarget.length, 0); // 上面已全部过期

  // Service：fake extractor 驱动 new → update 演进，confidence 门槛，resolve
  const staged: LifeEventExtractResult[] = [
    { events: [{ action: 'new', severity: 'safety', summary: '上海暴雨，家里一楼倒灌进水', note: '倒灌', confidence: 0.95 }] },
    { events: [] }, // 由测试内自然驱动
  ];
  const seenWindows: string[] = [];
  let extractorCalls = 0;
  const service = new LifeEventService(
    db,
    () => {},
    async (input) => {
      extractorCalls++;
      seenWindows.push(input.windowText);
      if (extractorCalls === 1) return staged[0];
      if (extractorCalls === 2) {
        assert.equal(input.activeEvents.length, 1);
        return {
          events: [
            {
              action: 'update',
              id: input.activeEvents[0].id,
              severity: 'safety',
              summary: '家里进水并跳闸断电，正准备临时搬离',
              note: '断电+搬家',
              confidence: 0.9,
            },
            // 低置信度的一条必须被丢弃
            { action: 'new', severity: 'mood', summary: '心情可能不好', note: '', confidence: 0.3 },
          ],
        };
      }
      if (input.activeEvents.length) {
        return {
          events: [{ action: 'resolve', id: input.activeEvents[0].id, severity: 'safety', summary: '', note: '', confidence: 0.9 }],
        };
      }
      return { events: [] };
    },
    async () => {} // sleep 秒过
  );

  const m1 = addUserMessage('claude', '暴雨太大了，家里一楼倒灌进水了');
  assert.equal(await service.extractAfterTurn(claude, m1, '暴雨太大了，家里一楼倒灌进水了'), true);
  let current = repo.activeEvents();
  assert.equal(current.length, 1);
  assert.equal(current[0].source_contact_id, 'claude');

  const m2 = addUserMessage('claude', '刚跳闸断电了，我收拾东西准备搬走');
  assert.equal(await service.extractAfterTurn(claude, m2, '刚跳闸断电了，我收拾东西准备搬走'), true);
  current = repo.activeEvents();
  assert.equal(current.length, 1, 'escalation must update, not duplicate');
  assert.equal(current[0].summary, '家里进水并跳闸断电，正准备临时搬离');
  assert.equal(JSON.parse(current[0].timeline).length, 2);
  // 窗口里能看到之前的消息（相邻消息合并的载体）
  assert.match(seenWindows[1], /倒灌进水/);
  assert.match(seenWindows[1], /跳闸断电/);

  // resolve：B 联系人说危机解除
  const m3 = addUserMessage('codex', '电来了，水也退了，都搞定了');
  // codex 的正文「电」不含触发词——用带触发词的表述
  const m3b = addUserMessage('codex', '来电了，进水也退了');
  assert.equal(await service.extractAfterTurn(codex, m3b, '来电了，进水也退了'), true);
  assert.equal(repo.activeEvents().length, 0);
  void m3;

  // 限速：schedule 5 分钟内第二次不触发；safety 免限速。
  // 用全新联系人，避免上面 claude 的提取已刷新限速时间戳。
  const aye = addContact('aye', 'on');
  const callsBefore = extractorCalls;
  const m4 = addUserMessage('aye', '我刚睡醒');
  await service.extractAfterTurn(aye, m4, '我刚睡醒');
  const m5 = addUserMessage('aye', '刚睡醒又躺下补觉了');
  await service.extractAfterTurn(aye, m5, '刚睡醒又躺下补觉了');
  assert.equal(extractorCalls, callsBefore + 1, 'schedule trigger must rate-limit within 5 minutes');
  const m6 = addUserMessage('aye', '厨房好像漏水了');
  await service.extractAfterTurn(aye, m6, '厨房好像漏水了');
  assert.equal(extractorCalls, callsBefore + 2, 'safety trigger must bypass the rate limit');

  // 成本闸
  process.env.LIFE_EVENTS_DAILY_COST_CNY = '0.001';
  process.env.LIFE_EVENTS_RESERVED_COST_CNY = '0.01';
  const gated = extractorCalls;
  const m7 = addUserMessage('aye', '又开始漏水了');
  await service.extractAfterTurn(aye, m7, '又开始漏水了');
  assert.equal(extractorCalls, gated, 'daily cost breaker must stop extraction');
  delete process.env.LIFE_EVENTS_DAILY_COST_CNY;
  delete process.env.LIFE_EVENTS_RESERVED_COST_CNY;

  // shanghaiStamp：UTC → +8
  assert.equal(shanghaiStamp('2026-08-15T15:10:00Z'), '08-15 23:10');

  console.log('life events S2 checks passed');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
