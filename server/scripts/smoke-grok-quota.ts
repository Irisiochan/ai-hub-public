/**
 * Smoke test: Grok GetGrokCreditsConfig protobuf 百分比解析。
 * 全程使用本地构造样本，不读取登录态、不请求真实 Grok 端点。
 * Run with: npx tsx scripts/smoke-grok-quota.ts
 */
import assert from 'node:assert/strict';
import { GrokQuotaPoller, normalizeGrokQuotaSample, parseGrokCredits } from '../src/quota/grokQuota.js';

function configPayload(field: Buffer): Buffer {
  assert.ok(field.length < 128, 'test fixture only supports one-byte lengths');
  return Buffer.concat([Buffer.from([0x0a, field.length]), field]);
}

function grpcFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function percentFloat(value: number): Buffer {
  const field = Buffer.alloc(5);
  field[0] = 0x0d; // field 1, wire 5 (fixed32)
  field.writeFloatLE(value, 1);
  return field;
}

function percentDouble(value: number): Buffer {
  const field = Buffer.alloc(9);
  field[0] = 0x09; // field 1, wire 1 (fixed64)
  field.writeDoubleLE(value, 1);
  return field;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function resetTimestamp(seconds: number): Buffer {
  const timestamp = Buffer.concat([Buffer.from([0x08]), varint(seconds)]); // Timestamp.seconds
  return Buffer.concat([Buffer.from([0x12, timestamp.length]), timestamp]); // config field 2
}

const resetAtSec = 1_800_000_000;
const resetAtIso = new Date(resetAtSec * 1000).toISOString();

assert.equal(
  parseGrokCredits(grpcFrame(configPayload(percentFloat(3)))).usedPercent,
  3,
  'production float32 creditUsagePercent=3 must not collapse to 0'
);

assert.equal(
  parseGrokCredits(configPayload(percentDouble(7.5))).usedPercent,
  7.5,
  'legacy double creditUsagePercent remains supported'
);

assert.equal(
  parseGrokCredits(configPayload(Buffer.alloc(0))).usedPercent,
  null,
  'proto3 omitted percentage must stay unknown instead of fabricating 0% used'
);

assert.deepEqual(
  normalizeGrokQuotaSample(parseGrokCredits(configPayload(percentFloat(25)))),
  { ok: false, missingFields: ['resetsAt'] },
  'percentage-only partial sample must not publish remainingPct with a null reset'
);

assert.deepEqual(
  normalizeGrokQuotaSample(parseGrokCredits(configPayload(resetTimestamp(resetAtSec)))),
  { ok: false, missingFields: ['usedPercent'] },
  'reset-only partial sample must not infer proto3 default 0% used'
);

assert.deepEqual(
  normalizeGrokQuotaSample(
    parseGrokCredits(configPayload(Buffer.concat([percentFloat(25), resetTimestamp(resetAtSec)])))
  ),
  { ok: true, weekly: { remainingPct: 75, resetsAt: resetAtIso } },
  'complete sample must preserve percentage and reset time'
);

assert.deepEqual(
  normalizeGrokQuotaSample(
    parseGrokCredits(configPayload(Buffer.concat([percentFloat(0), resetTimestamp(resetAtSec)])))
  ),
  { ok: true, weekly: { remainingPct: 100, resetsAt: resetAtIso } },
  'an explicitly present 0% used field is a legitimate full pool'
);

const fullBody = grpcFrame(
  configPayload(Buffer.concat([percentFloat(25), resetTimestamp(resetAtSec)]))
);
const partialBody = grpcFrame(configPayload(percentFloat(0)));
let responseBody = fullBody;
const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
const poller = new GrokQuotaPoller(
  () => {},
  (message, fields) => warnings.push({ message, fields }),
);
const pollerTestApi = poller as unknown as {
  token(): string | null;
  poll(): Promise<void>;
};
pollerTestApi.token = () => 'test-token-that-is-long-enough';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(new Uint8Array(responseBody), { status: 200 });

try {
  await pollerTestApi.poll();
  const lastGood = poller.get();
  assert.deepEqual(lastGood.weekly, { remainingPct: 75, resetsAt: resetAtIso });
  assert.equal(lastGood.stale, undefined, 'complete sample must be fresh');

  responseBody = partialBody;
  await pollerTestApi.poll();
  const stale = poller.get();
  assert.deepEqual(stale.weekly, lastGood.weekly, 'partial sample must retain the last-good window');
  assert.equal(stale.fetchedAt, lastGood.fetchedAt, 'partial sample must retain the last successful timestamp');
  assert.equal(stale.stale, true, 'retained last-good data must be marked stale');
  assert.deepEqual(warnings.at(-1)?.fields.missingFields, ['resetsAt']);
  assert.equal(warnings.at(-1)?.fields.contact, 'aye');
  assert.equal(warnings.at(-1)?.fields.backend, 'grok-cli');
  assert.equal(typeof warnings.at(-1)?.fields.at, 'string');

  const emptyPoller = new GrokQuotaPoller(() => {});
  const emptyTestApi = emptyPoller as unknown as {
    token(): string | null;
    poll(): Promise<void>;
  };
  emptyTestApi.token = () => 'test-token-that-is-long-enough';
  await emptyTestApi.poll();
  assert.deepEqual(
    emptyPoller.get(),
    { available: false, reason: 'error', detail: 'missing fields: resetsAt' },
    'partial sample without last-good data must be explicitly unavailable'
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('smoke-grok-quota: all pass ✅');
