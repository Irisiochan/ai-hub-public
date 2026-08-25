import {
  buildDispatchableTaskContext,
  nextWallClockDelay,
  normalizeBacklogSweepConfig,
  planBacklogSweep,
  shanghaiDateAt,
} from './triage-core.mjs';
import { BACKLOG_CLAIMS_KEY, log, once, sweepOnce } from './worker-shared.mjs';

/** TriageWorker 的 backlog domain：可派发任务快照、claim 去重与待拆分需求日扫。 */
export const backlogMethods = {
  isBacklogSweep(event) {
    return event?.category_hint === 'backlog' || event?.categoryHint === 'backlog';
  },

  backlogSweepConfig() {
    return this.config.backlogSweep ?? normalizeBacklogSweepConfig({});
  },

  backlogClaims() {
    try {
      const parsed = JSON.parse(this.store.getSourceState(BACKLOG_CLAIMS_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  },

  saveBacklogClaims(claims) {
    this.store.setSourceState(BACKLOG_CLAIMS_KEY, JSON.stringify(claims));
  },

  async dispatchableBacklog() {
    if (!this.vault.enabled) {
      // Vault unavailable is not "zero tasks" — mark parseOk false so gates fail-open.
      return { summary: '', taskPaths: [], allTaskPaths: [], ignored: [], parseOk: false };
    }
    const raw = await this.vault.taskContext();
    const claims = this.backlogClaims();
    const snapshot = buildDispatchableTaskContext(raw, {
      claimedTaskPaths: Object.keys(claims),
      maxChars: Math.max(500, Number(this.deepseek.backlogMaxChars ?? 4000)),
    });
    // Only prune claims against a well-formed snapshot; garbage must not wipe claims.
    if (snapshot.parseOk) {
      const open = new Set(snapshot.allTaskPaths);
      const pruned = Object.fromEntries(Object.entries(claims).filter(([taskPath]) => open.has(taskPath)));
      if (JSON.stringify(pruned) !== JSON.stringify(claims)) this.saveBacklogClaims(pruned);
    }
    return snapshot;
  },

  claimBacklogTask(taskPath, eventId) {
    if (!taskPath) return;
    const claims = this.backlogClaims();
    claims[taskPath] = { eventId, claimedAt: Date.now() };
    this.saveBacklogClaims(claims);
  },

  releaseBacklogClaim(taskPath, eventId) {
    if (!taskPath) return false;
    const claims = this.backlogClaims();
    const claim = claims[taskPath];
    if (!claim || (eventId && claim.eventId !== eventId)) return false;
    delete claims[taskPath];
    this.saveBacklogClaims(claims);
    return true;
  },

  /**
   * 待拆分需求的定期清扫。联系人随手记的需求先落 inbox，这里定时捞出来要一份
   * 拆分提案——机制的意义就是不靠人自觉，所以默认开，且只在真有东西时出声。
   * 走普通 backlog 事件，沿用现成的静默时段、池子与去重，不另开一条投递通道。
   */
  async sweepBacklogInbox() {
    const config = this.backlogSweepConfig();
    if (!config.enabled) return null;
    if (!this.vault.enabled) {
      log('info', 'backlog sweep skipped: no memory vault configured');
      return null;
    }
    const stateKey = 'backlog-sweep:v1';
    const text = await this.vault.backlog(config.query);
    const plan = planBacklogSweep({
      text,
      previous: this.store.getSourceState(stateKey),
      now: Date.now(),
      config,
    });
    if (!plan.emit) {
      log('info', 'backlog sweep quiet', { reason: plan.reason, pending: plan.hits.length });
      return plan;
    }
    this.store.setSourceState(stateKey, plan.state);
    this.enqueue({
      source: 'backlog-sweep',
      categoryHint: 'backlog',
      dedupeKey: `backlog-sweep:${plan.digest}:${shanghaiDateAt(Date.now(), 0)}`,
      summary: plan.summary,
      payload: { mode: 'backlog-sweep', pending: plan.hits.length, digest: plan.digest },
    });
    log('info', 'backlog sweep queued', { reason: plan.reason, pending: plan.hits.length });
    return plan;
  },

  /** 内建日程，不依赖 sources 配置——生产的 triage.config.json 不进 git，
   *  靠配置才能开的机制等于永远开不了。 */
  startBacklogSweep() {
    const config = this.backlogSweepConfig();
    if (!config.enabled) return null;
    const run = () => this.sweepBacklogInbox().catch((error) => {
      log('warn', 'backlog sweep failed', { error: error.message });
    });
    // --once 是「把队列排空就退出」，不是「替所有定时器走一格」；
    // 想手动扫一次用 --once --sweep。
    if (once) return sweepOnce ? run() : null;
    const slot = this.timers.push(null) - 1;
    const schedule = () => {
      if (this.stopping) return;
      this.timers[slot] = setTimeout(() => {
        void run();
        schedule();
      }, nextWallClockDelay(config));
    };
    schedule();
    log('info', 'backlog sweep scheduled', {
      at: `${String(config.atHour).padStart(2, '0')}:${String(config.atMinute).padStart(2, '0')}`,
      query: config.query,
      renagHours: config.renagHours,
    });
    return null;
  },
};
