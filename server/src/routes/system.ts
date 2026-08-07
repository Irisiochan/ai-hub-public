import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HubConfig } from '../config.js';
import { serverRoot } from '../config.js';
import { inspectRepo } from '../publishStatus.js';

const execFileAsync = promisify(execFile);

const startedAt = new Date().toISOString();

const LEGACY_DEPLOY_UNIT = 'ai-hub-deploy';
const DEPLOY_UNIT = 'ai-hub-update';
const HARDENING_UNIT = 'ai-hub-m15-hardening';

function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/.exec(header ?? '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** 单元状态三态：探测不到（systemctl 缺失/被拒）不能和「没在跑」混为一谈。 */
export type UnitProbe = 'active' | 'inactive' | 'unknown';

async function probeUnit(unit: string, kind: 'service' | 'path'): Promise<UnitProbe> {
  const running = (state: string): UnitProbe =>
    state === 'active' || state === 'activating' ? 'active' : 'inactive';
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', `${unit}.${kind}`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return running(stdout.trim());
  } catch (error) {
    // is-active 对 inactive/failed/不存在的单元返回非零，但仍把状态打到 stdout；
    // stdout 为空才说明 systemctl 本身用不了，那时只能说「不知道」。
    const stdout = (error as { stdout?: unknown })?.stdout;
    const state = typeof stdout === 'string' ? stdout.trim() : '';
    return state ? running(state) : 'unknown';
  }
}

/** 触发/拒绝新部署时按「探测不到就当没在跑」处理，避免探测故障把部署通道锁死。 */
async function unitActive(unit: string): Promise<boolean> {
  return (await probeUnit(unit, 'service')) === 'active';
}

async function pathActive(unit: string): Promise<boolean> {
  return (await probeUnit(unit, 'path')) === 'active';
}

const DEPLOY_LOG_STALE_MS = 30 * 60_000;

/**
 * 日志自证：update.sh 每次开工写 `== deploy start <ISO> ==`，收尾写
 * `== deploy ok ... ==` 或 `== deploy fail (...)`。只要最后一个开工标记后面
 * 没有收尾标记，部署就还在跑——这条不依赖 systemd 单元叫什么名字，也不依赖
 * 网关有没有权限问 systemctl，正好补上 probe 返回 unknown 的那段盲区。
 * 超过 staleMs 的开工标记不再采信，免得被 OOM 掐死的部署把状态永远钉成 running。
 */
export function deployLogRunning(
  log: string,
  now = Date.now(),
  staleMs = DEPLOY_LOG_STALE_MS
): boolean {
  let startedAtMs: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const start = /^== deploy start (\S+) ==/.exec(line);
    if (start) {
      const parsed = Date.parse(start[1]);
      startedAtMs = Number.isFinite(parsed) ? parsed : now;
      continue;
    }
    if (/^== deploy ok /.test(line) || /^== deploy fail \(/.test(line)) startedAtMs = null;
  }
  if (startedAtMs === null) return false;
  return now - startedAtMs < staleMs;
}

export function systemRouter(config: HubConfig): Router {
  const router = Router();
  let cached: { expiresAt: number; value: unknown } | null = null;

  router.get('/system/publish-status', async (_req, res) => {
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.value);
    const repos = await Promise.all([
      inspectRepo(
        'app',
        'ai-hub 代码',
        path.resolve(serverRoot, '..'),
        process.env.AI_HUB_APP_PUBLISH_STATUS_FILE ?? '/var/lib/ai-hub/app-publish-status.json'
      ),
      inspectRepo(
        'memory',
        'memory-vault 记忆库',
        config.memory.repoPath,
        process.env.AI_HUB_MEMORY_PUBLISH_STATUS_FILE ?? '/run/memory-vault-publish/status.json'
      ),
    ]);
    const value = { checkedAt: new Date().toISOString(), startedAt, repos };
    cached = { expiresAt: Date.now() + 30_000, value };
    res.json(value);
  });

  return router;
}

/**
 * Deployment has its own constant-time DEPLOY_TOKEN boundary. Mount this
 * router before sessionAuth so enabling HUB_TOKEN cannot break the recovery
 * channel, while ordinary /api/system routes remain behind the Web session.
 */
export function deployControlRouter(): Router {
  const router = Router();
  const deployToken = process.env.DEPLOY_TOKEN ?? '';
  const deployLog = process.env.DEPLOY_LOG ?? '/var/log/ai-hub-deploy.log';
  const hardeningLog = process.env.HARDENING_LOG ?? '/var/log/ai-hub-m15-hardening.log';
  const deployScript = process.env.DEPLOY_SCRIPT ?? path.resolve(serverRoot, '..', 'deploy', 'update.sh');
  const hardeningScript = process.env.HARDENING_SCRIPT
    ?? path.resolve(serverRoot, '..', 'deploy', 'migrate-m15.sh');
  const deployRequest = process.env.DEPLOY_REQUEST ?? '/var/lib/ai-hub/deploy.request';

  function requireDeployAuth(req: Request, res: Response): boolean {
    if (!deployToken) {
      res.status(503).json({ error: '未配置 DEPLOY_TOKEN，部署通道关闭' });
      return false;
    }
    if (!bearerMatches(req.header('authorization'), deployToken)) {
      res.status(401).json({ error: 'DEPLOY_TOKEN 无效' });
      return false;
    }
    return true;
  }

  router.post('/system/deploy', async (req, res) => {
    if (!requireDeployAuth(req, res)) return;
    if (process.platform !== 'linux') {
      return res.status(501).json({ error: '部署通道仅在 VPS（linux + systemd）上可用' });
    }
    if (!fs.existsSync(deployScript)) {
      return res.status(500).json({ error: `找不到部署脚本 ${deployScript}` });
    }
    if (await unitActive(DEPLOY_UNIT) || await unitActive(LEGACY_DEPLOY_UNIT) || fs.existsSync(deployRequest)) {
      return res.status(409).json({ error: '已有部署在进行中', log: deployLog });
    }
    try {
      if (await pathActive(DEPLOY_UNIT)) {
        fs.writeFileSync(deployRequest, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
        return res.status(202).json({ started: true, unit: DEPLOY_UNIT, log: deployLog });
      }
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        return res.status(503).json({ error: '非 root 网关的部署触发器尚未安装' });
      }
      await execFileAsync('systemd-run', [
        `--unit=${LEGACY_DEPLOY_UNIT}`,
        '--collect',
        `--property=StandardOutput=append:${deployLog}`,
        `--property=StandardError=append:${deployLog}`,
        '/bin/bash',
        deployScript,
      ], { encoding: 'utf8', timeout: 10_000 });
      return res.status(202).json({ started: true, unit: LEGACY_DEPLOY_UNIT, log: deployLog });
    } catch (e) {
      return res.status(500).json({ error: `部署启动失败：${e instanceof Error ? e.message : String(e)}` });
    }
  });

  router.get('/system/deploy/status', async (req, res) => {
    if (!requireDeployAuth(req, res)) return;
    let recent = '';
    let tail = '(暂无部署日志)';
    try {
      recent = fs.readFileSync(deployLog, 'utf8').slice(-65_536);
      tail = recent.slice(-4_000);
    } catch {}
    const probes = process.platform === 'linux'
      ? await Promise.all([probeUnit(DEPLOY_UNIT, 'service'), probeUnit(LEGACY_DEPLOY_UNIT, 'service')])
      : (['inactive', 'inactive'] as UnitProbe[]);
    const unitProbe: UnitProbe = probes.includes('active')
      ? 'active'
      : probes.every((probe) => probe === 'unknown') ? 'unknown' : 'inactive';
    const requestPending = process.platform === 'linux' && fs.existsSync(deployRequest);
    const logRunning = deployLogRunning(recent);
    const running = unitProbe === 'active' || requestPending || logRunning;
    // source 说明这次结论是谁给的：日志自证和 systemd 探测不一致时（比如探测
    // 返回 unknown），回执里看得见，不用再猜 running 为什么和 tail 对不上。
    const source = unitProbe === 'active'
      ? 'systemd'
      : requestPending ? 'request-file' : logRunning ? 'deploy-log' : 'idle';
    res.json({ running, source, unitProbe, log: deployLog, tail });
  });

  router.post('/system/hardening', async (req, res) => {
    if (!requireDeployAuth(req, res)) return;
    const requestedHubToken = typeof req.body?.hubToken === 'string' ? req.body.hubToken.trim() : '';
    if (requestedHubToken.length < 32 || requestedHubToken.length > 512) {
      return res.status(400).json({ error: 'hubToken 必须是 32–512 字符的随机值' });
    }
    if (process.platform !== 'linux') {
      return res.status(501).json({ error: 'M1.5 迁移仅在 VPS（linux + systemd）上可用' });
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      return res.status(409).json({ error: '网关已是非 root；拒绝重复启动权限迁移' });
    }
    if (!fs.existsSync(hardeningScript)) {
      return res.status(500).json({ error: `找不到迁移脚本 ${hardeningScript}` });
    }
    if (await unitActive(HARDENING_UNIT)) {
      return res.status(409).json({ error: 'M1.5 迁移正在进行中', log: hardeningLog });
    }
    try {
      const tokenFile = '/run/ai-hub-m15-hub-token';
      fs.writeFileSync(tokenFile, `${requestedHubToken}\n`, { mode: 0o600, flag: 'wx' });
      await execFileAsync('systemd-run', [
        `--unit=${HARDENING_UNIT}`,
        '--collect',
        `--property=StandardOutput=append:${hardeningLog}`,
        `--property=StandardError=append:${hardeningLog}`,
        '/bin/bash',
        hardeningScript,
      ], { encoding: 'utf8', timeout: 10_000 });
      return res.status(202).json({ started: true, unit: HARDENING_UNIT, log: hardeningLog });
    } catch (error) {
      try { fs.unlinkSync('/run/ai-hub-m15-hub-token'); } catch {}
      return res.status(500).json({ error: `M1.5 迁移启动失败：${error instanceof Error ? error.message : String(error)}` });
    }
  });

  router.get('/system/hardening/status', async (req, res) => {
    if (!requireDeployAuth(req, res)) return;
    const running = process.platform === 'linux' ? await unitActive(HARDENING_UNIT) : false;
    let tail = '';
    try {
      tail = fs.readFileSync(hardeningLog, 'utf8').slice(-6_000);
    } catch {
      tail = '(暂无迁移日志)';
    }
    res.json({ running, log: hardeningLog, tail });
  });

  return router;
}
