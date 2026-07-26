import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GrokQuotaWindow {
  remainingPct: number;
  resetsAt: string | null;
}

export type GrokQuotaReason = 'no-token' | 'login-expired' | 'error';

export interface GrokQuotaStatus {
  available: boolean;
  reason?: GrokQuotaReason;
  detail?: string;
  /** 订阅制是全产品共享的周池（百分比计），只有这一个窗口 */
  weekly?: GrokQuotaWindow | null;
  fetchedAt?: string;
}

const AUTH_PATH = process.env.GROK_AUTH_PATH ?? path.join(os.homedir(), '.grok', 'auth.json');
const BILLING_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

/** auth.json 顶层是 OIDC scope URL 键，值里嵌着 { key, refresh_token, … }；递归找第一个 key。 */
export function grokAuthToken(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.key === 'string' && o.key.length > 20) return o.key;
  for (const v of Object.values(o)) {
    const hit = grokAuthToken(v);
    if (hit) return hit;
  }
  return null;
}

// ── minimal protobuf walker（防御式，未知字段一律跳过）──────────

interface PbField {
  no: number;
  wire: number;
  varint?: bigint;
  bytes?: Buffer;
  fixed64?: Buffer;
  fixed32?: Buffer;
}

export function pbFields(buf: Buffer): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n;
    let val = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      val |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return val;
      shift += 7n;
      if (shift > 63n) throw new Error('varint overflow');
    }
    throw new Error('varint truncated');
  };
  while (i < buf.length) {
    const tag = varint();
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (no === 0) throw new Error('field 0');
    if (wire === 0) out.push({ no, wire, varint: varint() });
    else if (wire === 1) {
      out.push({ no, wire, fixed64: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      if (len < 0 || i + len > buf.length) throw new Error('len overflow');
      out.push({ no, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ no, wire, fixed32: buf.subarray(i, i + 4) });
      i += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

const EPOCH_MIN = 1_600_000_000n; // 2020-09
const EPOCH_MAX = 4_000_000_000n; // 2096

function asTimestamp(bytes: Buffer): number | null {
  try {
    const fields = pbFields(bytes);
    const secs = fields.find((f) => f.no === 1 && f.wire === 0)?.varint;
    if (secs !== undefined && secs > EPOCH_MIN && secs < EPOCH_MAX &&
        fields.every((f) => [1, 2].includes(f.no) && f.wire === 0)) {
      return Number(secs);
    }
  } catch {}
  return null;
}

/** {val: double} 之类的单字段数值包装（monthlyLimit/totalUsed 形状） */
function asValWrapper(bytes: Buffer): number | null {
  try {
    const fields = pbFields(bytes);
    if (fields.length !== 1) return null;
    const f = fields[0];
    if (f.wire === 1 && f.fixed64) return f.fixed64.readDoubleLE(0);
    if (f.wire === 0 && f.varint !== undefined) return Number(f.varint);
  } catch {}
  return null;
}

export interface GrokCreditsParse {
  usedPercent: number | null;
  resetsAtSec: number | null;
}

/**
 * GetGrokCreditsConfig 响应（gRPC-web framed 或裸 protobuf）→ 用量。
 * 端点未公开，字段号是从真机样本 + CLI 二进制字段名反推的，全部宽容解析：
 * - creditUsagePercent：顶层 config 的 field 1；线上当前是 float，
 *   兼容旧样本中的 double（0% 时按 proto3 被省略）
 * - 兜底：两个 {val} 包装（monthlyLimit/totalUsed）能除出百分比就用
 * - resetsAt：config 里能解出的最大 Timestamp（周期结束）
 */
export function parseGrokCredits(body: Buffer): GrokCreditsParse {
  // gRPC-web frame: [flags u8][len u32be][payload]；flags & 0x80 = trailer，跳过
  const payloads: Buffer[] = [];
  if (body.length >= 5) {
    let i = 0;
    while (i + 5 <= body.length) {
      const flags = body[i];
      const len = body.readUInt32BE(i + 1);
      if (i + 5 + len > body.length) break;
      if ((flags & 0x80) === 0) payloads.push(body.subarray(i + 5, i + 5 + len));
      i += 5 + len;
    }
  }
  if (payloads.length === 0) payloads.push(body); // 裸 protobuf

  for (const payload of payloads) {
    let config: Buffer;
    try {
      const top = pbFields(payload);
      config = top.find((f) => f.no === 1 && f.wire === 2)?.bytes ?? payload;
    } catch {
      continue;
    }
    try {
      const fields = pbFields(config);
      let usedPercent: number | null = null;
      let resetsAtSec: number | null = null;
      const wrappers: { no: number; val: number }[] = [];

      for (const f of fields) {
        if (f.no === 1 && f.wire === 5 && f.fixed32 && usedPercent === null) {
          const v = f.fixed32.readFloatLE(0);
          if (Number.isFinite(v) && v >= 0 && v <= 100) usedPercent = v;
        } else if (f.no === 1 && f.wire === 1 && f.fixed64 && usedPercent === null) {
          const v = f.fixed64.readDoubleLE(0);
          if (Number.isFinite(v) && v >= 0 && v <= 100) usedPercent = v;
        } else if (f.wire === 2 && f.bytes) {
          const ts = asTimestamp(f.bytes);
          if (ts !== null) {
            if (resetsAtSec === null || ts > resetsAtSec) resetsAtSec = ts;
            continue;
          }
          const val = asValWrapper(f.bytes);
          if (val !== null) wrappers.push({ no: f.no, val });
          // 子消息（billingCycle 等）里也捞一下更晚的 timestamp
          try {
            for (const sub of pbFields(f.bytes)) {
              if (sub.wire === 2 && sub.bytes) {
                const subTs = asTimestamp(sub.bytes);
                if (subTs !== null && (resetsAtSec === null || subTs > resetsAtSec)) resetsAtSec = subTs;
              }
            }
          } catch {}
        }
      }

      // 兜底：monthlyLimit/totalUsed 形状（字段号小的当 limit）
      if (usedPercent === null && wrappers.length >= 2) {
        wrappers.sort((a, b) => a.no - b.no);
        const [limit, used] = wrappers;
        if (limit.val > 0) usedPercent = Math.min(100, (used.val / limit.val) * 100);
      }
      // 0% 时 creditUsagePercent 整个被省略——解析成功但没数就是 0
      if (usedPercent === null) usedPercent = 0;
      return { usedPercent, resetsAtSec };
    } catch {
      continue;
    }
  }
  throw new Error('unparseable credits response');
}

/**
 * Best-effort subscription quota for grok-cli contacts. Endpoint is the same
 * gRPC-web call the TUI /usage screen makes (undocumented; parsed defensively
 * — when it breaks the UI shows the reason instead of fabricated numbers).
 *
 * Token 只读不刷新：grok CLI 自己会轮换 auth.json，
 * poller 抢着刷新反而会跟 CLI 打架。401 就报 login-expired 等 CLI 下次轮换。
 */
export class GrokQuotaPoller {
  private data: { weekly: GrokQuotaWindow | null; fetchedAt: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private skipUntil = 0;
  private lastReason: GrokQuotaReason | undefined;
  private lastDetail: string | undefined;

  constructor(private log: (msg: string) => void) {}

  start(intervalMs = 300_000): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(): GrokQuotaStatus {
    if (this.data) return { available: true, weekly: this.data.weekly, fetchedAt: this.data.fetchedAt };
    return { available: false, reason: this.lastReason ?? 'no-token', detail: this.lastDetail };
  }

  private token(): string | null {
    try {
      return grokAuthToken(JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')));
    } catch {
      return null;
    }
  }

  private async poll(): Promise<void> {
    const token = this.token();
    if (!token) {
      this.lastReason = 'no-token';
      this.lastDetail = undefined;
      return;
    }
    if (Date.now() < this.skipUntil) return;

    try {
      const res = await fetch(BILLING_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/grpc-web+proto',
          'x-grpc-web': '1',
          'user-agent': 'grok-cli',
        },
        body: new Uint8Array([0, 0, 0, 0, 0]),
      });
      if (!res.ok) {
        this.lastReason = res.status === 401 || res.status === 403 ? 'login-expired' : 'error';
        this.lastDetail = `HTTP ${res.status}`;
        throw new Error(`HTTP ${res.status}`);
      }
      const body = Buffer.from(await res.arrayBuffer());
      const parsed = parseGrokCredits(body);
      this.data = {
        weekly: {
          remainingPct: Math.max(0, Math.min(100, Math.round(100 - (parsed.usedPercent ?? 0)))),
          resetsAt: parsed.resetsAtSec ? new Date(parsed.resetsAtSec * 1000).toISOString() : null,
        },
        fetchedAt: new Date().toISOString(),
      };
      this.failures = 0;
      this.skipUntil = 0;
      this.lastReason = undefined;
      this.lastDetail = undefined;
    } catch (e: any) {
      this.failures++;
      if (this.lastReason === undefined) {
        this.lastReason = 'error';
        this.lastDetail = e.message;
      }
      const backoffMs = Math.min(300_000 * 2 ** this.failures, 7_200_000);
      this.skipUntil = Date.now() + backoffMs;
      this.log(`grok quota poll failed (${this.failures}): ${e.message}, backing off ${Math.round(backoffMs / 60_000)}min`);
    }
  }
}
