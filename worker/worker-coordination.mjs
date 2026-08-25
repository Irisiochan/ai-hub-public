import fs from 'node:fs';
import path from 'node:path';
import {
  coordinationPolicyState,
  DELIVERY_POOL_COORDINATION,
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_NONE,
  executionDispatchKey,
  executionFingerprint,
  formatCoordinationDispatchBlock,
  formatVerificationDispatchBlock,
  isShanghaiSilentHour,
  normalizeCoordinationConfig,
  parseCoordinationTask,
  parseVerificationTask,
  planHubAutoHygiene,
  shanghaiDateAt,
  verificationDispatchKey,
  legacyVerificationDispatchKey,
} from './triage-core.mjs';
import {
  COORDINATION_SOURCE,
  COORDINATION_STATE_KEY,
  HUB_AUTO_HYGIENE_MODE,
  hubAutoHygieneStateKey,
  legacyVerificationStateKey,
  log,
  VERIFICATION_MODE,
  verificationStateKey,
} from './worker-shared.mjs';

/**
 * TriageWorker 的 coordination domain：Plan-ready 执行派单、到期验收派单
 * 与 hub-auto 卫生 digest。挂载方式见 worker-followups.mjs 注释。
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

  coordinationPlans() {
    const config = this.coordinationConfig();
    if (!fs.existsSync(config.tasksDir)) return [];
    return fs.readdirSync(config.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const taskPath = `tasks/${entry.name}`;
        try {
          return parseCoordinationTask(
            fs.readFileSync(path.join(config.tasksDir, entry.name), 'utf8'),
            { taskPath },
          );
        } catch (error) {
          log('warn', 'coordination task read failed', { taskPath, error: error.message });
          return null;
        }
      })
      .filter(Boolean);
  },

  verificationTasks() {
    const config = this.coordinationConfig();
    if (!fs.existsSync(config.tasksDir)) return [];
    return fs.readdirSync(config.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const taskPath = `tasks/${entry.name}`;
        try {
          return parseVerificationTask(
            fs.readFileSync(path.join(config.tasksDir, entry.name), 'utf8'),
            { taskPath },
          );
        } catch (error) {
          log('warn', 'verification task read failed', { taskPath, error: error.message });
          return null;
        }
      })
      .filter(Boolean);
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
    const config = this.coordinationConfig();
    if (!config.enabled) return false;
    const intervalMs = config.scanIntervalMinutes * 60_000;
    if (now < this.nextCoordinationPollAt) return false;
    this.nextCoordinationPollAt = now + intervalMs;
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) {
      log('info', 'coordination sweep skipped: silent hours');
      return false;
    }
    const policy = this.coordinationPolicy(now);
    if (policy.poolFull) return false;
    const state = this.coordinationState();
    let stateDirty = false;
    const plans = this.coordinationPlans()
      .filter((task) => {
        const fingerprint = executionFingerprint(task);
        if (state[task.taskPath] === fingerprint) return false;
        if (state[task.taskPath] === task.planHash) {
          // legacy v1 record of this exact Plan: upgrade in place, no re-dispatch
          state[task.taskPath] = fingerprint;
          stateDirty = true;
          return false;
        }
        return true;
      })
      .slice(0, policy.remaining);
    if (stateDirty) this.saveCoordinationState(state);
    for (const task of plans) {
      this.enqueue({
        source: COORDINATION_SOURCE,
        categoryHint: 'coordination',
        summary: `Plan-ready coordination dispatch: ${task.taskPath} (${executionFingerprint(task).slice(0, 12)})`,
        dedupeKey: executionDispatchKey(task),
        payload: { mode: 'coordination', task },
      });
    }
    const verificationRemaining = Math.max(0, policy.remaining - plans.length);
    const today = shanghaiDateAt(now);
    const verifications = this.verificationTasks()
      .filter((task) => task.due <= today && !this.verificationAlreadyDispatched(task))
      .slice(0, verificationRemaining);
    for (const task of verifications) {
      const stateKey = verificationStateKey(task);
      this.enqueue({
        source: COORDINATION_SOURCE,
        categoryHint: 'coordination',
        summary: `Due verification coordination dispatch: ${task.taskPath} (${task.due})`,
        dedupeKey: stateKey,
        payload: { mode: VERIFICATION_MODE, task },
      });
    }
    const hygieneQueued = await this.scanHubAutoHygieneIfDue(
      now,
      Math.max(0, verificationRemaining - verifications.length),
    );
    if (plans.length || verifications.length || hygieneQueued) {
      log('info', 'coordination tasks queued', {
        executionCount: plans.length,
        verificationCount: verifications.length,
        hygieneCount: hygieneQueued ? 1 : 0,
        taskPaths: [...plans, ...verifications].map((task) => task.taskPath),
      });
    }
    return plans.length + verifications.length + (hygieneQueued ? 1 : 0) > 0;
  },

  async processCoordination(event) {
    if (event.payload?.mode === VERIFICATION_MODE) {
      await this.processVerification(event);
      return;
    }
    if (event.payload?.mode === HUB_AUTO_HYGIENE_MODE) {
      await this.processHubAutoHygiene(event);
      return;
    }
    const config = this.coordinationConfig();
    const task = event.payload?.task;
    const validTask = task
      && typeof task.taskPath === 'string'
      && typeof task.planHash === 'string'
      && typeof task.executor === 'string'
      && typeof task.workspace === 'string'
      && typeof task.branch === 'string';
    if (!config.enabled || !config.roomId || !validTask) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'coordination config or task payload is no longer valid',
        },
      });
      return;
    }
    const eventFingerprint = executionFingerprint(task);
    const state = this.coordinationState();
    if (state[task.taskPath] === eventFingerprint || state[task.taskPath] === task.planHash) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'same execution fingerprint already dispatched',
        },
      });
      return;
    }
    // 执行前复核：任务在排队/重试期间可能被置 done、改 Plan 或改派。
    // 只有重读后的当前语义与 event 完全一致才允许派发；否则本 event 以
    // superseded 收口，新版任务由下一轮扫描重新入队。
    const current = this.rereadCoordinationTaskFile(task.taskPath, parseCoordinationTask);
    if (!current || executionFingerprint(current) !== eventFingerprint) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'superseded: task closed or changed after enqueue; rescan will queue the current version',
        },
      });
      return;
    }
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)) {
      this.store.retry(event.id, 'coordination silent hours', 60 * 60_000);
      return;
    }
    if (this.coordinationPolicy().poolFull) {
      this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000);
      return;
    }
    const dispatched = await this.hub.dispatchRoomHost(config.roomId, {
      content: formatCoordinationDispatchBlock(current),
      hostName: config.hostName,
      targetIds: [current.executor],
      reactionRounds: 0,
      idempotencyKey: executionDispatchKey(current),
      coordination: {
        kind: 'execution',
        taskPath: current.taskPath,
        branch: current.branch,
        workspace: current.workspace,
        planHash: current.planHash,
        executor: current.executor,
      },
    });
    // 投递已成功；state/delivery/终态必须一起落（见 settleCoordinationDispatch 注释）。
    const settledState = this.coordinationState();
    settledState[current.taskPath] = eventFingerprint;
    this.store.settleCoordinationDispatch(event.id, {
      recipientId: config.roomId,
      pool: DELIVERY_POOL_COORDINATION,
      messageId: dispatched?.messageId,
      executedVia: EXECUTED_VIA_CONTACT,
      taskPath: current.taskPath,
      sourceStates: [{ key: COORDINATION_STATE_KEY, value: JSON.stringify(settledState) }],
      triageResult: {
        actionable: true,
        needsLocalExec: true,
        category: 'coordination',
        priority: 2,
        suggestedRecipient: current.executor,
        rationale: `Plan hash dispatched to @${current.executor}`,
        taskPath: current.taskPath,
      },
      finishRecipientId: current.executor,
    });
    log('info', 'coordination plan dispatched', {
      eventId: event.id,
      taskPath: task.taskPath,
      planHash: task.planHash,
      executor: task.executor,
      pool: DELIVERY_POOL_COORDINATION,
    });
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
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)) {
      this.store.retry(event.id, 'coordination silent hours', 60 * 60_000);
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
    const config = this.coordinationConfig();
    const task = event.payload?.task;
    const validTask = task
      && typeof task.taskPath === 'string'
      && typeof task.title === 'string'
      && typeof task.verifier === 'string'
      && typeof task.due === 'string'
      && task.due <= shanghaiDateAt();
    if (!config.enabled || !config.roomId || !validTask) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'verification config or task payload is no longer valid or due',
        },
      });
      return;
    }
    const stateKey = verificationStateKey(task);
    if (this.verificationAlreadyDispatched(task)) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'same verification key already dispatched',
        },
      });
      return;
    }
    // 执行前复核：due 改写、verifier 改派或任务关闭后，旧 event 一律 superseded。
    const current = this.rereadCoordinationTaskFile(task.taskPath, parseVerificationTask);
    if (!current || verificationDispatchKey(current) !== verificationDispatchKey(task)) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'superseded: verification task closed or changed after enqueue; rescan will queue the current version',
        },
      });
      return;
    }
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)) {
      this.store.retry(event.id, 'coordination silent hours', 60 * 60_000);
      return;
    }
    if (this.coordinationPolicy().poolFull) {
      this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000);
      return;
    }
    const dispatched = await this.hub.dispatchRoomHost(config.roomId, {
      content: formatVerificationDispatchBlock(current),
      hostName: config.hostName,
      targetIds: [current.verifier],
      reactionRounds: 0,
      idempotencyKey: stateKey,
      coordination: {
        kind: 'verification',
        taskPath: task.taskPath,
        due: task.due,
        verifier: task.verifier,
      },
    });
    // 投递已成功；state/delivery/终态必须一起落（见 settleCoordinationDispatch 注释）。
    this.store.settleCoordinationDispatch(event.id, {
      recipientId: config.roomId,
      pool: DELIVERY_POOL_COORDINATION,
      messageId: dispatched?.messageId,
      executedVia: EXECUTED_VIA_CONTACT,
      taskPath: current.taskPath,
      sourceStates: [{
        key: stateKey,
        value: JSON.stringify({
          taskPath: current.taskPath,
          due: current.due,
          verifier: current.verifier,
          dispatchedAt: Date.now(),
        }),
      }],
      triageResult: {
        actionable: true,
        needsLocalExec: false,
        category: 'coordination',
        priority: 2,
        suggestedRecipient: current.verifier,
        rationale: `Due verification dispatched to @${current.verifier}`,
        taskPath: current.taskPath,
      },
      finishRecipientId: current.verifier,
    });
    log('info', 'coordination verification dispatched', {
      eventId: event.id,
      taskPath: task.taskPath,
      due: task.due,
      verifier: task.verifier,
      pool: DELIVERY_POOL_COORDINATION,
    });
  },
};
