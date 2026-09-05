import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { contactConfig, openContact } from '../src/agents/configSchemas.js';
import type { ContactRow } from '../src/db.js';
import { openDb } from '../src/db.js';
import { contactsRouter } from '../src/routes/contacts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.contact-config-smoke.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

const db = openDb(dbPath);
const switchedModels: string[] = [];
const manager = {
  statusOf: () => ({ state: 'idle' }),
  isAgentBusy: () => false,
  switchContactModel: async (contact: ContactRow) => {
    switchedModels.push(String(JSON.parse(contact.config).model ?? ''));
  },
  notifyContactUpdated: async () => {},
  remove: async () => {},
} as any;
const sse = { broadcast: () => {} } as any;
const hubConfig = {
  agentsDir: here,
  codex: { cliPath: 'codex' },
  grok: { cliPath: path.join(here, 'mock-grok.mjs') },
  opencode: { cliPath: path.join(here, 'mock-opencode.mjs') },
} as any;
const app = express();
app.use(express.json());
app.use('/api/contacts', contactsRouter(db, sse, manager, hubConfig));
const server = http.createServer(app);
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
const base = `http://127.0.0.1:${port}/api/contacts`;
const TEST_KEY = 'test-only-key';
const MASKED_TEST_KEY = '••••-key';

async function json(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  return { status: response.status, body: await response.json() };
}

try {
  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('grok-model-test', 'Grok model test', '🤖', '#888888', 'grok-cli', 'dm', '{}', 999);

  let result = await json('/grok-model-test/models');
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.models.slice(0, 3).map((model: { id: string }) => model.id),
    ['', 'grok-4.6', 'grok-4.5'],
    'Grok 下拉必须先保留默认项，再跟随 CLI 的运行时模型目录'
  );
  assert.equal(result.body.dynamic, true, 'Grok CLI 查询成功时应标记为动态目录');

  result = await json('/grok-model-test/model', {
    method: 'PATCH',
    body: JSON.stringify({ model: 'grok-4.6' }),
  });
  assert.equal(result.status, 200, 'Grok 具体模型应可保存');
  const storedGrok = db.prepare('SELECT config FROM contacts WHERE id = ?').get('grok-model-test') as { config: string };
  assert.equal(JSON.parse(storedGrok.config).model, 'grok-4.6', '选定模型必须持久化到联系人 config');
  assert.equal(switchedModels.at(-1), 'grok-4.6', '模型切换必须通知 manager 用新 config 重建 backend');

  result = await json('/grok-model-test/model', {
    method: 'PATCH',
    body: JSON.stringify({ model: '' }),
  });
  assert.equal(result.status, 200, 'Grok 默认模型仍应可保存');
  const defaultGrok = db.prepare('SELECT config FROM contacts WHERE id = ?').get('grok-model-test') as { config: string };
  assert.equal(JSON.parse(defaultGrok.config).model, '', '默认项必须持久化为空串，维持 CLI 自动选择');
  assert.equal(switchedModels.at(-1), '', '切回默认也必须通知 manager 重建 backend');

  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('opencode-model-test', 'OpenCode model test', '🎼', '#c4a574', 'opencode-cli', 'dm', '{}', 998);

  result = await json('/opencode-model-test/models');
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.models.slice(0, 5).map((model: { id: string }) => model.id),
    [
      '',
      'opencode-go/muse-spark-1.2-contributor',
      'opencode-go/muse-spark-1.2',
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5',
    ],
    'OpenCode 下拉必须先保留默认项，再跟随 CLI 的运行时模型目录'
  );
  assert.equal(result.body.dynamic, true, 'OpenCode CLI 查询成功时应标记为动态目录');
  assert.equal(
    result.body.models.find((model: { id: string }) => model.id === 'opencode-go/muse-spark-1.2-contributor')?.label,
    'Muse Spark 1.2 Contributor (Go)',
    '热更新 catalog 的显示名应盖住 CLI 原始 id'
  );
  assert.ok(result.body.efforts?.length > 0, 'OpenCode 应沿用 catalog 的推理强度档');

  result = await json('/opencode-model-test/model', {
    method: 'PATCH',
    body: JSON.stringify({ model: 'anthropic/claude-sonnet-4-6' }),
  });
  assert.equal(result.status, 200, 'OpenCode 具体模型应可保存');
  const storedOpencode = db.prepare('SELECT config FROM contacts WHERE id = ?').get('opencode-model-test') as { config: string };
  assert.equal(JSON.parse(storedOpencode.config).model, 'anthropic/claude-sonnet-4-6', '选定模型必须持久化到联系人 config');
  assert.equal(switchedModels.at(-1), 'anthropic/claude-sonnet-4-6', '模型切换必须通知 manager 用新 config 重建 backend');

  result = await json('/opencode-model-test/effort', {
    method: 'PATCH',
    body: JSON.stringify({ effort: 'xhigh' }),
  });
  assert.equal(result.status, 200, 'OpenCode 推理强度应可保存');
  assert.equal(JSON.parse((db.prepare('SELECT config FROM contacts WHERE id = ?').get('opencode-model-test') as { config: string }).config).effort, 'xhigh');

  // Stored rows are parsed once, receive defaults, preserve forward-compatible fields,
  // and never expose configParsed via object spread.
  const row = {
    id: 'cached', name: 'Cached', avatar: '🤖', color: '#888888', backend: 'api', kind: 'dm',
    config: JSON.stringify({ provider: 'gemini', model: 'gemini-test', apiKey: TEST_KEY, futureFlag: true }),
    sort_order: 0, enabled: 1, created_at: '',
  } as ContactRow;
  const first = contactConfig(row);
  const second = contactConfig(row);
  assert.strictEqual(first, second, 'same ContactRow must reuse configParsed');
  assert.equal(first.historyTokenBudget, 8000, 'stored config receives API defaults');
  assert.equal(first.promptCache, 'auto', 'stored API config defaults prompt cache to auto');
  assert.equal(first.routing.enabled, false, 'stored contacts do not opt into autonomous routing by default');
  assert.equal(first.routing.dailyLimit, 10, 'routing receives a conservative daily default');
  assert.equal(first.heartbeat.enabled, true, 'stored API contacts default heartbeat on like CLI');
  assert.equal('intervalMinutes' in first.heartbeat, false, 'heartbeat has no fixed interval default');
  assert.equal(first.futureFlag, true, 'unknown stored fields remain forward-compatible');
  assert.equal(Object.keys(openContact(row)).includes('configParsed'), false, 'configParsed must be non-enumerable');
  assert.equal('configParsed' in { ...row }, false, 'spreading a row must not leak parsed secrets');

  for (const backend of ['claude-cli', 'codex', 'grok-cli', 'opencode-cli'] as const) {
    const cliRow = {
      ...row,
      id: `${backend}-default-heartbeat`,
      backend,
      config: '{}',
    } as ContactRow;
    assert.equal(contactConfig(cliRow).heartbeat.enabled, true, `${backend} defaults heartbeat on`);
    const explicitOff = {
      ...cliRow,
      id: `${backend}-heartbeat-off`,
      config: JSON.stringify({ heartbeat: { enabled: false } }),
    } as ContactRow;
    assert.equal(contactConfig(explicitOff).heartbeat.enabled, false, `${backend} preserves explicit heartbeat opt-out`);
  }
  const apiOff = {
    ...row,
    id: 'api-heartbeat-off',
    backend: 'api' as const,
    config: JSON.stringify({ heartbeat: { enabled: false } }),
  } as ContactRow;
  assert.equal(contactConfig(apiOff).heartbeat.enabled, false, 'API preserves explicit heartbeat opt-out');

  result = await json('', {
    method: 'POST',
    body: JSON.stringify({ name: 'Missing model', backend: 'api', config: { provider: 'gemini', apiKey: 'k' } }),
  });
  assert.equal(result.status, 400, 'API contact without model must be rejected');
  assert.match(result.body.error, /model required/);

  result = await json('', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Malicious shape', backend: 'api',
      config: { provider: 'openai-compat', model: 'm', apiKey: 'k', projectAccess: { enabled: 'yes' } },
    }),
  });
  assert.equal(result.status, 400, 'wrong nested field types must be rejected');

  result = await json('', {
    method: 'POST',
    body: JSON.stringify({
      id: 'valid-api', name: 'Valid API', backend: 'api',
      config: {
        provider: 'openai-compat', model: 'test-model', apiKey: TEST_KEY, baseUrl: '', futureFlag: 'kept',
        routing: {
          enabled: true,
          recipientKey: 'engineering',
          categories: ['file-change'],
          minPriority: 2,
          dailyLimit: 8,
          cooldownMinutes: 20,
        },
      },
    }),
  });
  assert.equal(result.status, 201, 'valid API contact should be created');
  assert.equal(result.body.config.apiKey, MASKED_TEST_KEY, 'API response must mask key');
  assert.equal(result.body.config.historyTokenBudget, 8000, 'POST stores schema defaults');
  assert.equal(result.body.config.routing.recipientKey, 'engineering', 'POST stores triage routing policy');
  assert.equal(result.body.config.routing.dailyLimit, 8, 'routing daily limit survives validation');
  assert.equal(result.body.config.heartbeat.enabled, true, 'POST stores the heartbeat default on for API contacts');
  assert.equal(result.body.config.futureFlag, 'kept', 'unknown fields should not break existing advanced config');
  assert.equal(JSON.stringify(result.body).includes(TEST_KEY), false, 'clear API key must not escape');

  result = await json('/valid-api', {
    method: 'PATCH',
    body: JSON.stringify({ config: { provider: 'gemini', apiKey: MASKED_TEST_KEY } }),
  });
  assert.equal(result.status, 400, 'PATCH missing required model must be rejected');

  result = await json('/valid-api', {
    method: 'PATCH',
    body: JSON.stringify({
      config: { provider: 'gemini', model: 'gemini-test', apiKey: MASKED_TEST_KEY, maxTokens: -1 },
    }),
  });
  assert.equal(result.status, 400, 'malicious numeric ranges must be rejected');

  result = await json('/valid-api', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        provider: 'gemini',
        model: 'gemini-test',
        apiKey: MASKED_TEST_KEY,
        routing: { enabled: true, categories: ['system'], dailyLimit: 0 },
      },
    }),
  });
  assert.equal(result.status, 400, 'routing limits outside the safe range must be rejected');

  result = await json('/valid-api', {
    method: 'PATCH',
    body: JSON.stringify({
      config: {
        provider: 'gemini', model: 'gemini-test', apiKey: MASKED_TEST_KEY,
        heartbeat: { enabled: true, intervalMinutes: 0 },
      },
    }),
  });
  assert.equal(result.status, 200, 'legacy fixed heartbeat intervals are accepted for config migration');
  assert.equal(result.body.config.heartbeat.enabled, true);
  assert.equal(
    'intervalMinutes' in result.body.config.heartbeat,
    false,
    'legacy fixed heartbeat intervals are removed instead of controlling the scheduler',
  );

  result = await json('/valid-api', {
    method: 'PATCH',
    body: JSON.stringify({
      config: { provider: 'gemini', model: 'gemini-test', apiKey: MASKED_TEST_KEY },
    }),
  });
  assert.equal(result.status, 200, 'masked key PATCH should retain stored key and pass');
  assert.equal(result.body.config.apiKey, MASKED_TEST_KEY);

  const mockModels = http.createServer((req, res) => {
    if (req.url !== '/v1/models') {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: [
        { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        { id: 'gemini-2.5-pro' },
        { id: 'gemini-2.0-flash' },
      ],
    }));
  });
  const modelsPort = await new Promise<number>((resolve) => {
    mockModels.listen(0, '127.0.0.1', () => resolve((mockModels.address() as { port: number }).port));
  });
  try {
    result = await json('', {
      method: 'POST',
      body: JSON.stringify({
        id: 'api-model-list',
        name: 'API model list',
        backend: 'api',
        config: {
          provider: 'openai-compat',
          model: 'gemini-3.5-flash',
          apiKey: TEST_KEY,
          baseUrl: `http://127.0.0.1:${modelsPort}/v1/chat/completions`,
          modelOptions: [{ id: 'custom-finetune', label: 'finetune' }],
        },
      }),
    });
    assert.equal(result.status, 201, 'API contact with live model directory should be created');

    result = await json('/api-model-list/models');
    assert.equal(result.status, 200);
    assert.equal(result.body.dynamic, true, 'API 上游 /models 成功时应标记为动态目录');
    assert.deepEqual(
      result.body.models.map((model: { id: string }) => model.id),
      ['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'custom-finetune'],
      'API 下拉必须展示上游全量模型，并保留联系人自定义项',
    );
    assert.equal(
      result.body.models[0].label,
      'Gemini 3.5 Flash',
      '上游提供的显示名应盖住原始 id',
    );

    result = await json('/api-model-list/model', {
      method: 'PATCH',
      body: JSON.stringify({ model: 'gemini-2.5-pro' }),
    });
    assert.equal(result.status, 200, '从动态目录里选中的 API 模型应可保存');
    assert.equal(switchedModels.at(-1), 'gemini-2.5-pro');
  } finally {
    await new Promise<void>((resolve) => mockModels.close(() => resolve()));
  }

  console.log('contact config smoke: ok');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
