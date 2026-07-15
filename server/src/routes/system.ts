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

// 受控一键部署：systemd-run 瞬态单元跑 deploy/update.sh。
// 独立 cgroup，update.sh 里的 systemctl restart ai-hub 杀不到它自己；
// 固定 unit 名 = 天然互斥锁，部署进行中时二次 systemd-run 直接失败。
const DEPLOY_UNIT = 'ai-hub-deploy';

function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/.exec(header ?? '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function deployUnitActive(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', `${DEPLOY_UNIT}.service`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const state = stdout.trim();
    return state === 'active' || state === 'activating';
  } catch {
    return false; // is-active 对 inactive/不存在的单元返回非零
  }
}

export function systemRouter(config: HubConfig): Router {
  const router = Router();
  let cached: { expiresAt: number; value: unknown } | null = null;

  router.get('/system/publish-status', async (_req, res) => {
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.value);
    const repos = await Promise.all([
      inspectRepo('app', 'ai-hub 代码', path.resolve(serverRoot, '..')),
      inspectRepo('memory', 'memory-vault 记忆库', config.memory.repoPath),
    ]);
    const value = { checkedAt: new Date().toISOString(), startedAt, repos };
    cached = { expiresAt: Date.now() + 30_000, value };
    res.json(value);
  });

  const deployToken = process.env.DEPLOY_TOKEN ?? '';
  const deployLog = process.env.DEPLOY_LOG ?? '/var/log/ai-hub-deploy.log';
  const deployScript = process.env.DEPLOY_SCRIPT ?? path.resolve(serverRoot, '..', 'deploy', 'update.sh');

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
    if (await deployUnitActive()) {
      return res.status(409).json({ error: '已有部署在进行中', log: deployLog });
    }
    try {
      fs.appendFileSync(deployLog, `\n== deploy requested ${new Date().toISOString()} ==\n`);
      await execFileAsync(
        'systemd-run',
        [
          `--unit=${DEPLOY_UNIT}`,
          '--collect',
          `--property=StandardOutput=append:${deployLog}`,
          `--property=StandardError=append:${deployLog}`,
          '/bin/bash',
          deployScript,
        ],
        { encoding: 'utf8', timeout: 10_000 }
      );
      res.status(202).json({ started: true, unit: DEPLOY_UNIT, log: deployLog });
    } catch (e) {
      res.status(500).json({ error: `systemd-run 启动失败：${e instanceof Error ? e.message : String(e)}` });
    }
  });

  router.get('/system/deploy/status', async (req, res) => {
    if (!requireDeployAuth(req, res)) return;
    const running = process.platform === 'linux' ? await deployUnitActive() : false;
    let tail = '';
    try {
      tail = fs.readFileSync(deployLog, 'utf8').slice(-4_000);
    } catch {
      tail = '(暂无部署日志)';
    }
    res.json({ running, log: deployLog, tail });
  });

  return router;
}
