import { Router } from 'express';

export interface VaultTaskClient {
  call(name: string, args?: Record<string, unknown>, retries?: number): Promise<string>;
}

const TASK_PATH = /^tasks\/[a-z0-9][a-z0-9-]*\.md$/;
const TAIL_PATH = /^tasks\/(?:worker-tail-|deploy-)/;

function vaultText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { result?: unknown };
    return typeof parsed.result === 'string' ? parsed.result : raw;
  } catch {
    return raw;
  }
}

function isOpenTask(raw: string): boolean {
  const frontmatter = vaultText(raw).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return !!frontmatter && /^status:\s*['"]?open['"]?\s*$/im.test(frontmatter[1]);
}

export function vaultTasksRouter(vault: VaultTaskClient | null): Router {
  const r = Router();
  const activeWrites = new Set<string>();

  r.post('/task-status', async (req, res) => {
    if (!vault) return res.status(503).json({ error: 'memory vault is not configured' });
    const taskPath = typeof req.body?.path === 'string' ? req.body.path.trim().toLowerCase() : '';
    const status = req.body?.status;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 4000) : '';
    if (!TASK_PATH.test(taskPath) || status !== 'done' || !note) {
      return res.status(400).json({ error: 'path, status=done and note are required' });
    }
    if (TAIL_PATH.test(taskPath)) {
      return res.status(409).json({ error: '尾巴任务不能从回执快捷按钮关闭，请在任务账本单独处理' });
    }
    if (activeWrites.has(taskPath)) {
      return res.status(409).json({ error: '这个任务正在更新，请勿重复点击' });
    }

    activeWrites.add(taskPath);
    try {
      try {
        const current = await vault.call('read_file', { path: taskPath }, 0);
        if (!isOpenTask(current)) {
          return res.status(409).json({ error: '任务不是 open 状态，未执行置 done' });
        }
      } catch (error) {
        return res.status(404).json({
          error: `任务读取失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }

      try {
        await vault.call('update_task', {
          path: taskPath,
          status: 'done',
          note,
          source: 'User',
        }, 0);
        return res.json({ ok: true, path: taskPath, status: 'done' });
      } catch (error) {
        return res.status(502).json({
          error: `任务状态写入失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      activeWrites.delete(taskPath);
    }
  });

  return r;
}
