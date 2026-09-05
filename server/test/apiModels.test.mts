import assert from 'node:assert/strict';
import http from 'node:http';
import {
  composeApiModels,
  defaultApiBaseUrl,
  listApiModels,
  modelsUrlFor,
  optionFromApiItem,
} from '../src/agents/apiModels.js';

assert.equal(
  modelsUrlFor('openai-compat', 'https://api.openai.com/v1/chat/completions'),
  'https://api.openai.com/v1/models',
);
assert.equal(
  modelsUrlFor('openai-compat', 'https://openrouter.ai/api/v1/chat/completions'),
  'https://openrouter.ai/api/v1/models',
);
assert.equal(
  modelsUrlFor('openai-compat', 'https://api.deepseek.com/chat/completions'),
  'https://api.deepseek.com/models',
);
assert.equal(
  modelsUrlFor('anthropic', 'https://api.anthropic.com/v1/messages'),
  'https://api.anthropic.com/v1/models',
);
assert.equal(
  modelsUrlFor('gemini', defaultApiBaseUrl('gemini')),
  'https://generativelanguage.googleapis.com/v1beta/models',
);
assert.equal(
  modelsUrlFor('openai-compat', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
  'https://generativelanguage.googleapis.com/v1beta/openai/models',
);

const geminiChat = optionFromApiItem('gemini', {
  name: 'models/gemini-2.5-flash',
  displayName: 'Gemini 2.5 Flash',
  supportedGenerationMethods: ['generateContent', 'countTokens'],
});
assert.deepEqual(geminiChat, { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' });

const geminiEmbed = optionFromApiItem('gemini', {
  name: 'models/text-embedding-004',
  displayName: 'Text Embedding 004',
  supportedGenerationMethods: ['embedContent'],
});
assert.equal(geminiEmbed, null);

const anthropic = optionFromApiItem('anthropic', {
  id: 'claude-sonnet-4-20250514',
  display_name: 'Claude Sonnet 4',
});
assert.deepEqual(anthropic, { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' });

const openrouter = optionFromApiItem('openai-compat', {
  id: 'google/gemini-2.5-pro',
  name: 'Google: Gemini 2.5 Pro',
  description: 'long context',
});
assert.equal(openrouter?.id, 'google/gemini-2.5-pro');
assert.equal(openrouter?.label, 'Google: Gemini 2.5 Pro');
assert.equal(openrouter?.description, 'long context');

assert.deepEqual(
  composeApiModels({
    live: [{ id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' }],
    catalog: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }, { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }],
    custom: [{ id: 'my-finetune', label: 'finetune' }],
    current: 'kept-current',
  }).map((model) => model.id),
  ['kept-current', 'gemini-2.5-flash', 'gemini-2.5-pro', 'my-finetune'],
);
assert.equal(
  composeApiModels({
    live: [{ id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' }],
    catalog: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }],
    custom: [],
    current: 'gemini-2.5-flash',
  })[0].label,
  'Gemini 2.5 Flash',
);

const seenAuth: string[] = [];
const seenPaths: string[] = [];
const server = http.createServer((req, res) => {
  seenAuth.push(String(
    req.headers.authorization
    ?? req.headers['x-api-key']
    ?? req.headers['x-goog-api-key']
    ?? '',
  ));
  seenPaths.push(req.url ?? '');
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/v1/models') {
    res.statusCode = 404;
    res.end('nope');
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (!url.searchParams.get('after_id')) {
    res.end(JSON.stringify({
      data: [{ id: 'page-one' }],
      has_more: true,
      last_id: 'page-one',
    }));
    return;
  }
  res.end(JSON.stringify({
    data: [{ id: 'page-two' }],
    has_more: false,
  }));
});

const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});

try {
  const models = await listApiModels({
    provider: 'anthropic',
    baseUrl: `http://127.0.0.1:${port}/v1/messages`,
    apiKey: 'secret-key',
  });
  assert.deepEqual(models.map((model) => model.id), ['page-one', 'page-two']);
  assert.equal(seenAuth[0], 'secret-key');
  assert.match(seenPaths[0], /limit=100/);
  assert.match(seenPaths[1], /after_id=page-one/);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('api model catalog tests: ok');
