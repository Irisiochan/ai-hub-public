/**
 * Smoke test: Grok GetGrokCreditsConfig protobuf 百分比解析。
 * 全程使用本地构造样本，不读取登录态、不请求真实 Grok 端点。
 * Run with: npx tsx scripts/smoke-grok-quota.ts
 */
import assert from 'node:assert/strict';
import { parseGrokCredits } from '../src/quota/grokQuota.js';

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
  0,
  'proto3 omitted percentage still means 0% used'
);

console.log('smoke-grok-quota: all pass ✅');
