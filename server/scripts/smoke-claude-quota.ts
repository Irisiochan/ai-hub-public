/**
 * Smoke test: ClaudeQuotaPoller 的原因分类与 refresh 续期。
 * 全程 mock fetch，不打真实 Anthropic 端点。
 * Run with: npx tsx scripts/smoke-claude-quota.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-quota-smoke-'));
const credsPath = path.join(dir, 'credentials.json');
process.env.CLAUDE_CREDENTIALS_PATH = credsPath;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { ClaudeQuotaPoller } = await import('../src/quota/claudeQuota.js');

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
}

const realFetch = globalThis.fetch;
const noop = () => {};
const tick = () => new Promise((r) => setTimeout(r, 50));

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function pollOnce(poller: InstanceType<typeof ClaudeQuotaPoller>) {
  poller.start(3_600_000); // 只触发首轮 poll
  await tick();
  poller.stop();
}

// 1. 无 token → no-token
{
  const p = new ClaudeQuotaPoller(noop);
  await pollOnce(p);
  const s = p.get();
  check('无 token → no-token', !s.available && s.reason === 'no-token', JSON.stringify(s));
}

// 2. setup-token 被 403 → reason setup-token，detail 带真实响应
{
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-fake';
  globalThis.fetch = async () => jsonRes(403, { error: 'oauth token scope insufficient' });
  const p = new ClaudeQuotaPoller(noop);
  await pollOnce(p);
  const s = p.get();
  check(
    'setup-token 403 → reason=setup-token 且 detail 含响应体',
    !s.available && s.reason === 'setup-token' && /403/.test(s.detail ?? '') && /scope/.test(s.detail ?? ''),
    JSON.stringify(s)
  );
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

// 3. credentials token 正常 → 百分比换算
{
  fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'good', refreshToken: 'r1' } }));
  globalThis.fetch = async () =>
    jsonRes(200, {
      five_hour: { utilization: 30, resets_at: '2026-07-15T08:00:00Z' },
      seven_day: { utilization: 46 },
    });
  const p = new ClaudeQuotaPoller(noop);
  await pollOnce(p);
  const s = p.get();
  check(
    'credentials 正常 → 5h剩70/周剩54',
    s.available === true && s.fiveHour?.remainingPct === 70 && s.sevenDay?.remainingPct === 54,
    JSON.stringify(s)
  );
}

// 4. access token 过期 → 401 → refresh → 重试成功，且新 token 写回文件
{
  fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'stale', refreshToken: 'r1' } }));
  const calls: string[] = [];
  globalThis.fetch = async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('/v1/oauth/token')) {
      calls.push('refresh');
      return jsonRes(200, { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 });
    }
    const auth = init?.headers?.authorization ?? '';
    if (auth.includes('stale')) {
      calls.push('usage-stale');
      return jsonRes(401, { error: 'token expired' });
    }
    calls.push('usage-fresh');
    return jsonRes(200, { five_hour: { utilization: 10 } });
  };
  const p = new ClaudeQuotaPoller(noop);
  await pollOnce(p);
  const s = p.get();
  const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  check(
    '401 → refresh → 重试成功',
    s.available === true && s.fiveHour?.remainingPct === 90 && calls.join(',') === 'usage-stale,refresh,usage-fresh',
    `state=${JSON.stringify(s)} calls=${calls.join(',')}`
  );
  check(
    '新 token 原子写回 credentials',
    written.claudeAiOauth.accessToken === 'fresh' && written.claudeAiOauth.refreshToken === 'r2' && typeof written.claudeAiOauth.expiresAt === 'number',
    JSON.stringify(written)
  );
}

// 5. refresh 也失败 → login-expired
{
  fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'stale2', refreshToken: 'dead' } }));
  globalThis.fetch = async (url: any) =>
    String(url).includes('/v1/oauth/token')
      ? jsonRes(400, { error: 'invalid_grant' })
      : jsonRes(401, { error: 'token expired' });
  const p = new ClaudeQuotaPoller(noop);
  await pollOnce(p);
  const s = p.get();
  check('refresh 失败 → login-expired', !s.available && s.reason === 'login-expired', JSON.stringify(s));
}

globalThis.fetch = realFetch;
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke-claude-quota: all pass ✅' : `\nsmoke-claude-quota: ${failures} failure(s) ❌`);
process.exitCode = failures === 0 ? 0 : 1;
