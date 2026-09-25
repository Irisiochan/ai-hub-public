import fs from 'node:fs';
import path from 'node:path';
import {
  coordinationExecutionAllowed,
  coordinationPolicyState,
  DELIVERY_POOL_COORDINATION,
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_NONE,
  executionDispatchKey,
  executionFingerprint,
  formatCoordinationDispatchBlock,
  formatVerificationDispatchBlock,
  isWorkflowOnlyConfig,
  normalizeCoordinationConfig,
  parseCoordinationTask,
  parseVerificationTask,
  planHubAutoHygiene,
  shanghaiDateAt,
  verificationDispatchKey,
  WORKFLOW_EXECUTION_SCAN_BATCH_LIMIT,
  legacyVerificationDispatchKey,
} from '../triage-core.mjs';
import {
  COORDINATION_SOURCE,
  COORDINATION_STATE_KEY,
  HUB_AUTO_HYGIENE_MODE,
  hubAutoHygieneStateKey,
  legacyVerificationStateKey,
  log,
  VERIFICATION_MODE,
  verificationStateKey,
} from '../domain-shared.mjs';

/**
 * TriageWorker 的 coordination domain：Plan-ready 执行派单、到期验收派单
 * 与 hub-auto 卫生 digest。
 */
export const coordinationMethods = {
  coordinationConfig() {
    return this.config.coordination ?? normalizeCoordinationConfig({});
  },

  isCoordinationEvent(event) {
    return event?.source === COORDINATION_SOURCE
      || event?.payload?.mode === 'coordination';
  },

  coordinationState() {
    try {
      const parsed = JSON.parse(this.store.getSourceState(COORDINATION_STATE_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  },

  saveCoordinationState(state) {
    this.store.setSourceState(COORDINATION_STATE_KEY, JSON.stringify(state));
  },

  coordinationTaskSnapshot() {
    const config = this.coordinationConfig();
    const snapshot = { plans: [], verifications: [] };
    if (!fs.existsSync(config.tasksDir)) return snapshot;
    const entries = fs.readdirSync(config.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const taskPath = `tasks/${entry.name}`;
      let raw;
      try {
        raw = fs.readFileSync(path.join(config.tasksDir, entry.name), 'utf8');
      } catch (error) {
        log('warn', 'coordination task read failed', { taskPath, error: error.message });
        continue;
      }
      for (const [kind, parser] of [['plans', parseCoordinationTask], ['verifications', parseVerificationTask]]) {
        try {
          const task = parser(raw, { taskPath });
          if (task) snapshot[kind].push(task);
        } catch (error) {
          log('warn', 'coordination task parse failed', { taskPath, kind, error: error.message });
        }
      }
    }
    return snapshot;
  },

  coordinationPolicy(now = Date.now()) {
    return coordinationPolicyState(
      this.coordinationConfig(),
      this.store.poolUsage(DELIVERY_POOL_COORDINATION, now),
    );
  },

  /** due-today 催办抑制：同日验收派单可能记在 v2 或 legacy v1 key 下。 */
  verificationDispatchSettled(taskPath, due, verifier) {
    return Boolean(
      this.store.getSourceState(verificationDispatchKey({ taskPath, due, verifier }))
      || this.store.getSourceState(legacyVerificationDispatchKey({ taskPath, due })),
    );
  },

  verificationAlreadyDispatched(task) {
    if (this.store.getSourceState(verificationStateKey(task))) return true;
    const legacyRaw = this.store.getSourceState(legacyVerificationStateKey(task));
    if (!legacyRaw) return false;
    let legacy = null;
    try {
      legacy = JSON.parse(legacyRaw);
    } catch {
      legacy = null;
    }
    if (String(legacy?.verifier ?? '').trim().toLowerCase() !== task.verifier) return false;
    // legacy v1 record already covered this verifier: migrate so v2 stays settled
    this.store.setSourceState(verificationStateKey(task), legacyRaw);
    return true;
  },

  /** 执行前复核：以 exact taskPath 重读任务文件，返回当前语义（或 null）。 */
  rereadCoordinationTaskFile(taskPath, parser) {
    const normalized = String(taskPath ?? '').trim().replaceAll('\\', '/');
    if (!/^tasks\/[^/]+\.md$/i.test(normalized)) return null;
    const config = this.coordinationConfig();
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(config.tasksDir, normalized.slice('tasks/'.length)), 'utf8');
    } catch {
      return null;
    }
    try {
      return parser(raw, { taskPath: normalized });
    } catch {
      return null;
    }
  },

  async scanHubAutoHygieneIfDue(now = Date.now(), remaining = 0) {
    // Workflow-only: hub-auto hygiene digest is ancillary proactive messaging.
    // Forced off even when config enables it; ledger preserved (no deletion).
    if (isWorkflowOnlyConfig(this.config)) return false;
    const coordination = this.coordinationConfig();
    const hygiene = coordination.hubAutoHygiene;
    if (!hygiene.enabled || !this.vault.enabled || remaining <= 0) return false;
    const date = shanghaiDateAt(now);
    const stateKey = hubAutoHygieneStateKey(date);
    if (this.store.getSourceState(stateKey)) return false;
    const inbox = await this.vault.call('list_inbox');
    const plan = planHubAutoHygiene(inbox, { today: date, staleDays: hygiene.staleDays });
    if (!plan.digest) {
      this.store.setSourceState(stateKey, JSON.stringify({
        status: 'quiet',
        date,
        metrics: plan.metrics,
        checkedAt: now,
      }));
      log('info', 'hub-auto hygiene quiet', { date, ...plan.metrics });
      return false;
    }
    const queued = this.enqueue({
      source: COORDINATION_SOURCE,
      categoryHint: 'coordination',
      summary: `hub-auto hygiene digest: ${plan.metrics.staleCount} stale of ${plan.metrics.hubAutoTotal}`,
      dedupeKey: stateKey,
      payload: { mode: HUB_AUTO_HYGIENE_MODE, stateKey, plan },
    });
    this.store.setSourceState(stateKey, JSON.stringify({
      status: 'queued',
      date,
      eventId: queued.id,
      metrics: plan.metrics,
      queuedAt: now,
    }));
    log('info', 'hub-auto hygiene queued', { date, eventId: queued.id, ...plan.metrics });
    return true;
  },

  async scanCoordinationIfDue(now = Date.now()) {
    // Retired: the model-driven task ledger replaces host execution and
    // verification dispatches. Plan-ready scans and due-verification scans
    // never enqueue anymore. The ancillary hub-auto hygiene digest below is
    // preserved (non-workflowOnly only); ledger history is never deleted.
    if (!isWorkflowOnlyConfig(this.config)) {
      const policy = this.coordinationPolicy(now);
      if (!policy.poolFull) {
        const hygieneQueued = await this.scanHubAutoHygieneIfDue(now, policy.remaining);
        if (hygieneQueued) {
          log('info', 'coordination tasks queued', {
            executionCount: 0,
            verificationCount: 0,
            hygieneCount: 1,
            taskPaths: [],
          });
          return true;
        }
      }
    }
    return false;
  },

  async processCoordination(event) {
    if (event.payload?.mode === HUB_AUTO_HYGIENE_MODE) {
      await this.processHubAutoHygiene(event);
      return;
    }
    // Retired (both the scan and this pending consumer): host execution and
    // verification dispatches no longer exist. Queued legacy payloads drain as
    // noop without model wake or Hub sends; the model-driven task ledger owns
    // all continuation. Ledger preserved, never erased.
    this.store.finish(event.id, 'noop', {
      triageResult: {
        actionable: false,
        needsLocalExec: false,
        category: 'coordination',
        priority: 1,
        suggestedRecipient: null,
        rationale: 'retired: host coordination dispatch removed; task ledger owns continuation',
      },
    });
    return;
  },

  async processHubAutoHygiene(event) {
    const config = this.coordinationConfig();
    const plan = event.payload?.plan;
    const date = typeof plan?.today === 'string' ? plan.today : '';
    const stateKey = event.payload?.stateKey === hubAutoHygieneStateKey(date)
      ? event.payload.stateKey
      : '';
    let state = null;
    try {
      state = JSON.parse(this.store.getSourceState(stateKey) ?? 'null');
    } catch {
      state = null;
    }
    if (state?.status === 'dispatched' || state?.status === 'quiet') {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'hub-auto hygiene already settled for this Shanghai date',
        },
      });
      return;
    }
    const validPlan = stateKey
      && typeof plan?.digest === 'string'
      && plan.digest
      && Number(plan?.metrics?.staleCount) > 0;
    // Workflow-only forces hygiene off even when config enables it.
    if (isWorkflowOnlyConfig(this.config)) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'workflow-only: hub-auto hygiene suppressed (no DS, no dispatch)',
        },
      });
      return;
    }
    if (!config.enabled || !config.roomId || !config.hubAutoHygiene.enabled || !validPlan) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'hub-auto hygiene config or payload is no longer valid',
        },
      });
      return;
    }
    if (this.coordinationPolicy().poolFull) {
      this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000);
      return;
    }
    const dispatched = await this.hub.dispatchRoomHost(config.roomId, {
      content: plan.digest,
      hostName: config.hostName,
      trigger: false,
      reactionRounds: 0,
      capture: false,
      idempotencyKey: stateKey,
    });
    // 投递已成功；state/delivery/终态必须一起落（见 settleCoordinationDispatch 注释）。
    this.store.settleCoordinationDispatch(event.id, {
      recipientId: config.roomId,
      pool: DELIVERY_POOL_COORDINATION,
      messageId: dispatched?.messageId,
      executedVia: EXECUTED_VIA_NONE,
      sourceStates: [{
        key: stateKey,
        value: JSON.stringify({
          status: 'dispatched',
          date,
          eventId: event.id,
          messageId: dispatched?.messageId,
          metrics: plan.metrics,
          dispatchedAt: Date.now(),
        }),
      }],
      triageResult: {
        actionable: true,
        needsLocalExec: false,
        category: 'coordination',
        priority: 1,
        suggestedRecipient: null,
        rationale: `hub-auto hygiene digest posted for ${date}`,
      },
      finishRecipientId: config.roomId,
    });
    log('info', 'hub-auto hygiene dispatched', {
      eventId: event.id,
      date,
      roomId: config.roomId,
      pool: DELIVERY_POOL_COORDINATION,
      ...plan.metrics,
    });
  },

  async processVerification(event) {
    // Retired with processCoordination: verification dispatches no longer
    // exist. Queued legacy payloads drain as noop; ledger preserved.
    this.store.finish(event.id, 'noop', {
      triageResult: {
        actionable: false,
        needsLocalExec: false,
        category: 'coordination',
        priority: 1,
        suggestedRecipient: null,
        rationale: 'retired: host verification dispatch removed; task ledger owns continuation',
      },
    });
    return;
  },
};
