/**
 * Smoke test: /api/system/deploy 的鉴权与平台门控。
 * 不会真的触发部署：DEPLOY_SCRIPT 指向不存在的路径，
 * linux 上最多走到 500（找不到脚本），win/mac 上走到 501。
 * Run with: npx tsx scripts/smoke-deploy.ts
 */
import express from 'express';

process.env.DEPLOY_TOKEN = 'smoke-secret';
process.env.DEPLOY_SCRIPT = '/nonexistent/smoke-deploy-guard.sh';
process.env.DEPLOY_LOG = `${process.cwd()}/smoke-deploy-never-written.log`;

const { deployControlRouter } = await import('../src/routes/system.js');

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
}

const app = express();
app.use(express.json());
app.use('/api', deployControlRouter());
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api/system`;

// 1. 无 token → 401
let res = await fetch(`${base}/deploy`, { method: 'POST' });
check('无 Authorization 被拒 401', res.status === 401, `got ${res.status}`);

// 2. 错 token → 401
res = await fetch(`${base}/deploy`, {
  method: 'POST',
  headers: { authorization: 'Bearer wrong-token' },
});
check('错误 token 被拒 401', res.status === 401, `got ${res.status}`);

// 3. 对 token → 平台门控：非 linux 501；linux 上脚本不存在 500（绝不真跑）
res = await fetch(`${base}/deploy`, {
  method: 'POST',
  headers: { authorization: 'Bearer smoke-secret' },
});
if (process.platform === 'linux') {
  check('linux + 脚本缺失 → 500', res.status === 500, `got ${res.status}`);
} else {
  check('非 linux → 501', res.status === 501, `got ${res.status}`);
}

// 4. status 同样要 token
res = await fetch(`${base}/deploy/status`);
check('status 无 token 被拒 401', res.status === 401, `got ${res.status}`);

res = await fetch(`${base}/deploy/status`, {
  headers: { authorization: 'Bearer smoke-secret' },
});
const body: any = await res.json();
check('status 带 token → 200 且 running=false', res.status === 200 && body.running === false, JSON.stringify(body));

// 5. 未配置 DEPLOY_TOKEN 的网关 → 503（token 在 router 创建时快照）
delete process.env.DEPLOY_TOKEN;
const app2 = express();
app2.use('/api', deployControlRouter());
const server2 = app2.listen(0, '127.0.0.1');
await new Promise((r) => server2.once('listening', r));
const port2 = (server2.address() as any).port;
res = await fetch(`http://127.0.0.1:${port2}/api/system/deploy`, {
  method: 'POST',
  headers: { authorization: 'Bearer smoke-secret' },
});
check('未配置 DEPLOY_TOKEN → 503', res.status === 503, `got ${res.status}`);

await new Promise((r) => server.close(r));
await new Promise((r) => server2.close(r));

console.log(failures === 0 ? '\nsmoke-deploy: all pass ✅' : `\nsmoke-deploy: ${failures} failure(s) ❌`);
process.exitCode = failures === 0 ? 0 : 1;
