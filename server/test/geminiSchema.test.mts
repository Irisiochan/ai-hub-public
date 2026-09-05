import assert from 'node:assert/strict';
import http from 'node:http';
import { GeminiProvider, sanitizeGeminiSchema } from '../src/agents/directApi/gemini.js';

const cameraLike = {
  type: 'object',
  properties: { reason: { type: 'string' } },
  additionalProperties: false,
};

const cleaned = sanitizeGeminiSchema(cameraLike);
assert.deepEqual(cleaned, {
  type: 'object',
  properties: { reason: { type: 'string' } },
});
assert.equal('additionalProperties' in cleaned, false);
assert.equal('additionalProperties' in cameraLike, true, 'must not mutate the source schema');

const nested = sanitizeGeminiSchema({
  type: 'object',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  properties: {
    sku: {
      type: 'array',
      items: { type: 'string', additionalProperties: false },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
  default: {},
  const: 'nope',
});
assert.deepEqual(nested, {
  type: 'object',
  properties: {
    sku: {
      type: 'array',
      items: { type: 'string' },
    },
  },
});

const union = sanitizeGeminiSchema({
  anyOf: [
    { type: 'string', additionalProperties: false },
    { type: 'number', $ref: '#/defs/n' },
  ],
});
assert.deepEqual(union, {
  anyOf: [{ type: 'string' }, { type: 'number' }],
});

assert.deepEqual(sanitizeGeminiSchema(null), { type: 'object', properties: {} });
assert.deepEqual(sanitizeGeminiSchema([]), { type: 'object', properties: {} });

function hasAdditionalProperties(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAdditionalProperties);
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, 'additionalProperties')) return true;
  return Object.values(value).some(hasAdditionalProperties);
}

const collected: unknown[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    collected.push(parsed);
    if (hasAdditionalProperties(parsed.tools)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 400,
          message: 'Invalid JSON payload received. Unknown name "additionalProperties"',
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    })}\n\n`);
    res.end();
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const provider = new GeminiProvider({
  baseUrl: `http://127.0.0.1:${address.port}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
  apiKey: 'test-key',
  model: 'gemini-3.5-flash',
  maxTokens: 64,
  promptCache: 'off',
});

const events = [];
for await (const event of provider.stream(
  { system: '', contents: [{ role: 'user', parts: [{ text: 'tick' }] }] },
  {
    allowCalls: true,
    definitions: [
      { name: 'search_vault', description: 'search', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'camera_snap', description: 'snap', schema: cameraLike },
      {
        name: 'taobao_add_to_cart',
        description: 'cart',
        schema: {
          type: 'object',
          properties: { sku: { type: 'array', items: {}, additionalProperties: false } },
          additionalProperties: false,
        },
      },
    ],
  },
  new AbortController().signal,
)) {
  events.push(event);
}

const payload = collected[0] as any;
assert.ok(payload?.tools?.[0]?.functionDeclarations?.length === 3);
for (const declaration of payload.tools[0].functionDeclarations) {
  assert.equal(
    hasAdditionalProperties(declaration.parameters),
    false,
    `${declaration.name} still leaked additionalProperties`,
  );
}
assert.deepEqual(payload.tools[0].functionDeclarations[1].parameters, {
  type: 'object',
  properties: { reason: { type: 'string' } },
});
assert.equal(events.some((event) => event.type === 'round'), true);

await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log('geminiSchema.test.mts: ok');
