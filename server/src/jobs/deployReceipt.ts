import fs from 'node:fs';
import type { JobStore } from './jobStore.js';

interface DeployReceipt {
  deployId: string;
  commit: string;
  deployedAt: string;
  reachableCommits: string[];
}

function validReceipt(value: unknown): DeployReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const deployId = typeof record.deployId === 'string' ? record.deployId.trim().slice(0, 100) : '';
  const commit = typeof record.commit === 'string' ? record.commit.trim() : '';
  const deployedAt = typeof record.deployedAt === 'string' ? record.deployedAt : '';
  const reachableCommits = Array.isArray(record.reachableCommits)
    ? record.reachableCommits
      .filter((item): item is string => typeof item === 'string' && /^[0-9a-f]{40,64}$/i.test(item))
      .slice(0, 10_000)
    : [];
  if (!deployId || !/^[0-9a-f]{40,64}$/i.test(commit) || !Number.isFinite(Date.parse(deployedAt))) {
    return null;
  }
  if (!reachableCommits.some((item) => item.toLowerCase() === commit.toLowerCase())) return null;
  return { deployId, commit, deployedAt: new Date(deployedAt).toISOString(), reachableCommits };
}

export class DeployReceiptPoller {
  private timer: NodeJS.Timeout | null = null;
  private lastFingerprint = '';

  constructor(
    private jobs: JobStore,
    private log: (message: string, meta?: Record<string, unknown>) => void,
    private receiptFile = process.env.AI_HUB_DEPLOY_RECEIPT ?? '/var/lib/ai-hub/deploy-receipt.json',
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 5_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<string[]> {
    let raw = '';
    try { raw = fs.readFileSync(this.receiptFile, 'utf8'); } catch { return []; }
    if (raw === this.lastFingerprint) return [];
    this.lastFingerprint = raw;
    let receipt: DeployReceipt | null = null;
    try { receipt = validReceipt(JSON.parse(raw)); } catch {}
    if (!receipt) {
      this.log('invalid deploy receipt ignored', { receiptFile: this.receiptFile });
      return [];
    }

    const promoted: string[] = [];
    const reachable = new Set(receipt.reachableCommits.map((item) => item.toLowerCase()));
    for (const job of this.jobs.deploymentCandidates()) {
      let meta: Record<string, unknown> = {};
      try { meta = job.delivery_meta ? JSON.parse(job.delivery_meta) : {}; } catch {}
      const head = typeof meta.head === 'string' ? meta.head : '';
      if (!/^[0-9a-f]{7,64}$/i.test(head)) continue;
      const normalizedHead = head.toLowerCase();
      const included = reachable.has(normalizedHead)
        || (normalizedHead.length < 40
          && [...reachable].some((candidate) => candidate.startsWith(normalizedHead)));
      if (!included) continue;
      const outcome = this.jobs.updateDelivery(job.id, `deploy:${receipt.deployId}`, {
        stage: 'online_waiting_validation',
        summary: `部署 ${receipt.commit.slice(0, 12)} 已完成，等待真实入口验收。`,
        nextOwner: '验收负责人',
        evidence: {
          deployment: {
            deployId: receipt.deployId,
            commit: receipt.commit,
            deployedAt: receipt.deployedAt,
            source: 'one-click-deploy',
          },
        },
      });
      if ('job' in outcome) promoted.push(job.id);
    }
    this.log('deploy receipt processed', {
      deployId: receipt.deployId,
      commit: receipt.commit,
      promoted,
    });
    return promoted;
  }
}
