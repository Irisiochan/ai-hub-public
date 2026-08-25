import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildAgendaPlan,
  formatAgendaDigest,
  hasAgendaIncrement,
  normalizeAgendaConfig,
  parseAgendaListing,
} from './agenda-core.mjs';
import { nextWallClockDelay, shanghaiDateAt } from './triage-core.mjs';
import { agendaOnce, log, once } from './worker-shared.mjs';

const LAST_AGENDA_FINGERPRINT_KEY = 'agenda-shadow:v1:last-fingerprint';
const LEGACY_AGENDA_INCREMENT_STATE_KEY = 'agenda-shadow:v2:increment-state';
const AGENDA_INCREMENT_STATE_KEY = 'agenda-shadow:v3:increment-state';

function stateKey(date) {
  return `agenda-shadow:v1:${date}`;
}

function parseState(raw) {
  try {
    const parsed = JSON.parse(raw ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function frontmatterMode(content) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return null;
  const line = match[1].match(/^mode:\s*(.*?)\s*$/imu)?.[1] ?? '';
  const value = line.split(/\s+#/u, 1)[0].trim().replace(/^(['"])(.*)\1$/u, '$2');
  return value === 'ask' || value === 'auto' ? value : null;
}

function taskFilePath(tasksDir, vaultPath) {
  const normalized = path.posix.normalize(String(vaultPath).replaceAll('\\', '/'));
  if (!normalized.startsWith('tasks/') || normalized.includes('../')) return null;
  const relative = normalized.slice('tasks/'.length);
  if (!relative) return null;
  const root = path.resolve(tasksDir);
  const target = path.resolve(root, ...relative.split('/'));
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

export async function readAgendaTaskMetadata(taskContextText, tasksDir) {
  if (!tasksDir) return {};
  const entries = parseAgendaListing(taskContextText, 'task');
  const metadata = await Promise.all(entries.map(async (item) => {
    const file = taskFilePath(tasksDir, item.path);
    if (!file) return null;
    try {
      const content = await readFile(file, 'utf8');
      return [item.path, {
        readable: true,
        mode: frontmatterMode(content),
        contentFingerprint: crypto.createHash('sha256').update(content).digest('hex'),
      }];
    } catch {
      // An unreadable task deliberately falls back to the v1 title classifier.
      return null;
    }
  }));
  return Object.fromEntries(metadata.filter(Boolean));
}

/** Daily Agenda shadow domain. It reads inventory and posts a digest; it never mutates vault/jobs. */
export const agendaMethods = {
  agendaConfig() {
    return this.config.agenda ?? normalizeAgendaConfig({}, this.config.coordination);
  },

  async collectAgendaInputs(config) {
    const health = [];
    let inboxText = '';
    let taskContextText = '';
    let taskMetadata = {};
    let jobs = [];

    if (this.maintenance || !this.store) {
      health.push(`worker maintenance: ${this.maintenance?.reason ?? 'state store unavailable'}`);
      return { inboxText, taskContextText, jobs, health };
    }
    if (!this.vault.enabled) {
      health.push('memory-vault 未配置');
    } else {
      const [inboxResult, taskResult] = await Promise.allSettled([
        this.vault.call('list_inbox'),
        this.vault.taskContext(),
      ]);
      if (inboxResult.status === 'fulfilled') inboxText = inboxResult.value;
      else health.push(`memory-vault list_inbox 不可用: ${inboxResult.reason?.message ?? inboxResult.reason}`);
      if (taskResult.status === 'fulfilled') taskContextText = taskResult.value;
      else health.push(`memory-vault task context 不可用: ${taskResult.reason?.message ?? taskResult.reason}`);
      if (taskResult.status === 'fulfilled') {
        taskMetadata = await readAgendaTaskMetadata(taskContextText, config.tasksDir);
      }
    }

    try {
      jobs = await this.hub.jobs({ limit: config.jobsLimit });
    } catch (error) {
      // Jobs observation is fail-open: keep the task/inbox sections and show one degraded line.
      health.push(`jobs API 不可达（仅 reconcile 降级）: ${error.message}`);
    }
    return { inboxText, taskContextText, taskMetadata, jobs, health };
  },

  async runAgendaShadow(now = Date.now()) {
    if (this.agendaRunPromise) return this.agendaRunPromise;
    const pending = this.runAgendaShadowOnce(now);
    this.agendaRunPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.agendaRunPromise === pending) this.agendaRunPromise = null;
    }
  },

  async runAgendaShadowOnce(now = Date.now()) {
    const config = this.agendaConfig();
    if (!config.enabled) {
      log('info', 'agenda shadow quiet', { reason: 'disabled' });
      return { status: 'quiet', reason: 'disabled' };
    }
    if (!this.store) {
      log('info', 'agenda shadow quiet', {
        reason: 'maintenance state store unavailable',
        health: this.maintenance?.reason ?? 'unknown',
      });
      return { status: 'quiet', reason: 'maintenance state store unavailable' };
    }

    const date = shanghaiDateAt(now, 0);
    const key = stateKey(date);
    const existing = parseState(this.store.getSourceState(key));
    if (existing) {
      log('info', 'agenda shadow quiet', { date, reason: 'Shanghai date already settled' });
      return { status: 'quiet', reason: 'Shanghai date already settled', date };
    }

    const inputs = await this.collectAgendaInputs(config);
    // Jobs failure degrades reconcile only, so it must not suppress safe task planning.
    const blockingHealth = inputs.health.filter((note) => !note.startsWith('jobs API 不可达'));
    const plan = buildAgendaPlan({
      ...inputs,
      health: inputs.health,
      blockingHealth,
      previousState: parseState(this.store.getSourceState(AGENDA_INCREMENT_STATE_KEY))
        ?? parseState(this.store.getSourceState(LEGACY_AGENDA_INCREMENT_STATE_KEY))
        ?? {},
      config,
      now,
      today: date,
    });
    if (!hasAgendaIncrement(plan)) {
      this.store.setSourceState(key, JSON.stringify({
        status: 'quiet',
        date,
        fingerprint: plan.fingerprint,
        reason: 'unchanged',
        settledAt: now,
      }));
      this.store.setSourceState(AGENDA_INCREMENT_STATE_KEY, JSON.stringify(plan.sourceState));
      log('info', 'agenda shadow quiet', { date, reason: 'unchanged fingerprint' });
      return { status: 'quiet', reason: 'unchanged fingerprint', date, plan };
    }

    if (!config.roomId) {
      this.store.setSourceState(key, JSON.stringify({
        status: 'quiet',
        date,
        fingerprint: plan.fingerprint,
        reason: 'roomId missing',
        settledAt: now,
      }));
      log('info', 'agenda shadow quiet', { date, reason: 'roomId missing' });
      return { status: 'quiet', reason: 'roomId missing', date, plan };
    }

    const dispatched = await this.hub.dispatchRoomHost(config.roomId, {
      content: formatAgendaDigest(plan, { date }),
      hostName: config.hostName,
      trigger: false,
      capture: false,
      reactionRounds: 0,
      idempotencyKey: key,
    });
    this.store.setSourceState(key, JSON.stringify({
      status: 'dispatched',
      date,
      fingerprint: plan.fingerprint,
      messageId: dispatched?.messageId ?? null,
      settledAt: now,
    }));
    this.store.setSourceState(AGENDA_INCREMENT_STATE_KEY, JSON.stringify(plan.sourceState));
    this.store.setSourceState(LAST_AGENDA_FINGERPRINT_KEY, plan.fingerprint);
    log('info', 'agenda shadow dispatched', {
      date,
      messageId: dispatched?.messageId,
      wouldAuto: plan.wouldAuto.length,
      wouldAsk: plan.wouldAsk.length,
      deferred: plan.deferred.length,
      reconcile: plan.reconcile.length,
    });
    return { status: 'dispatched', date, plan, messageId: dispatched?.messageId ?? null };
  },

  startAgenda() {
    const config = this.agendaConfig();
    if (!config.enabled) return null;
    const run = () => this.runAgendaShadow().catch((error) => {
      log('warn', 'agenda shadow failed', { error: error.message });
      if (agendaOnce) process.exitCode = 1;
    });
    if (once) return agendaOnce ? run() : null;
    const slot = this.timers.push(null) - 1;
    const schedule = () => {
      if (this.stopping) return;
      this.timers[slot] = setTimeout(() => {
        void run();
        schedule();
      }, nextWallClockDelay(config));
    };
    schedule();
    log('info', 'agenda shadow scheduled', {
      at: `${String(config.atHour).padStart(2, '0')}:${String(config.atMinute).padStart(2, '0')}`,
      roomId: config.roomId || null,
    });
    return null;
  },
};
