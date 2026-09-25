import {
  buildTaskReminders,
  chooseRecipient,
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_TASK,
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_NONE,
  EXECUTED_VIA_WORKER,
  formatTaskNudgeRoomNotice,
  formatTaskReminderRoomNotice,
  isRemovedCompanionEvent,
  isSystemTimerEvent,
  isWebhookProbeInput,
  isWorkflowEssentialEvent,
  isWorkflowOnlyConfig,
  validateTriageMode,
} from './triage-core.mjs';
import { log, retryDelay } from './domain-shared.mjs';

function dispatchPrompt(event, result, { reminder = false } = {}) {
  if (reminder) {
    return [
      '这是一次已通过确定性截止日期检查的任务提醒。',
      '请直接用你自己的自然语气把提醒告诉 User；不要提及 triage、路由、定时器、后台扫描或系统事件。',
      '只保留三项：一句结论、一个下一步、是否需要 User 操作。不要扩写背景，不要连续追问。',
      '',
      event.summary.slice(0, 3000),
    ].join('\n');
  }
  return [
    '⚡ AI Hub 自主事件分派',
    `来源：${event.source}`,
    `分类：${result.category}｜优先级：P${result.priority}`,
    `判断：${result.rationale}`,
    result.taskPath ? `账本任务：${result.taskPath}（本次派单已登记接管，禁止再次派同一路径）` : '',
    '',
    '真实事件上下文：',
    event.summary.slice(0, 16_000),
    '',
    '请只按下面三种路径选一种，不要扩写成第四种：',
    '1. [PASS]：当前不需要任何动作，群轮次原生静默。',
    '2. 登记观察：仅记录 User 当时可直接确认的现象、复现路径、原话与时间；用 memory_vault write_inbox 写入 inbox/，source 必须是 frontend-observation。不要创建或更新 tasks/。猜测只能标成“未验证假设”，并写明本机需独立核查。',
    '3. delegate_to_worker：凡是需要读取真实仓库/文件状态、运行测试或 shell、修改代码/文件、构建或部署的，一律调用 delegate_to_worker 转给本机。只传目标、约束和可判定验收标准，不要只凭聊天上下文猜根因、方案、文件或行号。',
    result.needsLocalExec
      ? '本事件 needsLocalExec=true，只能走 delegate_to_worker；不得由前端联系人就地执行或改记成 task。'
      : '本事件 needsLocalExec=false；若只是可确认的前端现象，优先登记观察，不要把观察升级成任务。',
  ].filter((line) => line !== '').join('\n');
}

/**
 * TriageWorker 的核心处理管线：单事件 claim → 分流（coordination/idea/diary/
 * followup/daily/reminder/backlog/system-timer）→ L1 triage → 路由 → 派发 →
 * 终态落库；以及 vault outbox 的逐条消费与成本断路器。
 */
export const pipelineMethods = {
  breakerReason() {
    const summary = this.store.dailySummary();
    if (summary.total >= this.config.breakers.dailyEvents) return 'daily event breaker';
    if (
      this.config.breakers.dailyCostCny > 0
      && summary.costCny >= this.config.breakers.dailyCostCny
    ) {
      return 'daily cost breaker';
    }
    return null;
  },

  routeOptions(reminder = false) {
    if (reminder) {
      return {
        rules: {},
        usageOf: () => ({ count: 0, lastAt: null }),
        allowedRecipientKeys: [this.taskReminderConfig().recipient],
        ignoreRecipientLimits: true,
        modelOnly: true,
      };
    }
    return {
      rules: this.config.routing?.rules ?? {},
      usageOf: (recipientId) => this.store.recipientUsage(recipientId, Date.now(), DELIVERY_POOL_TASK),
      allowedRecipientKeys: null,
      ignoreRecipientLimits: false,
      modelOnly: false,
    };
  },

  async processVaultOutboxOne() {
    // Workflow-only: the vault outbox currently only carries idea-diary writes
    // (ancillary idea-room downstream, NOT real Worker receipts/outbox).
    // Pause the drain and preserve pending rows; do not claim/finish/erase.
    if (isWorkflowOnlyConfig(this.config)) return false;
    const item = this.store.claimVaultWrite();
    if (!item) return false;
    try {
      if (item.kind !== 'idea-diary') {
        throw new Error(`unsupported vault outbox kind: ${item.kind}`);
      }
      if (!this.vault.enabled) {
        throw new Error('memory-vault URL is not configured');
      }
      await this.vault.writeDiary(item.payload);
      this.store.finishVaultWrite(item.id);
      log('info', 'idea diary written', {
        eventId: item.event_id,
        outboxId: item.id,
        slug: item.payload.slug,
        attempts: item.attempts,
      });
    } catch (error) {
      const delayMs = retryDelay(item.attempts);
      this.store.retryVaultWrite(item.id, error.message, delayMs);
      log('warn', 'idea diary scheduled for retry', {
        eventId: item.event_id,
        outboxId: item.id,
        attempt: item.attempts,
        retryInMs: delayMs,
        error: error.message,
      });
    }
    return true;
  },

  async processOne() {
    const event = this.store.claim();
    if (!event) return false;
    let costCny = Number(event.cost_cny ?? 0);
    let triageLatencyMs = event.triage_latency_ms === null
      ? null
      : Number(event.triage_latency_ms);
    let triageResult = event.triageResult ?? null;
    try {
      // Probe payloads must never reach L1/dispatch (defense in depth for webhook).
      if (isWebhookProbeInput(event) || isWebhookProbeInput(event.payload)) {
        const probeResult = triageResult ?? {
          actionable: false,
          needsLocalExec: false,
          category: 'system',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'webhook probe payload; recorded without model dispatch',
        };
        this.store.finish(event.id, 'noop', {
          triageResult: probeResult,
          costCny,
          triageLatencyMs,
        });
        log('info', 'webhook probe suppressed before L1', { eventId: event.id });
        return true;
      }

      if (isRemovedCompanionEvent(event)) {
        this.store.finish(event.id, 'noop', {
          triageResult: triageResult ?? {
            actionable: false,
            needsLocalExec: false,
            category: 'other',
            priority: 1,
            suggestedRecipient: null,
            rationale: 'removed: idea, followups, and proactive check-ins no longer run',
          },
          costCny,
          triageLatencyMs,
        });
        log('info', 'removed companion event drained', { eventId: event.id, source: event.source });
        return true;
      }

      // Workflow-only master boundary (consumption side): only formal sweep
      // execution + due verification may proceed (formal source AND formal
      // mode). Everything else — diary, reminders,
      // backlog/system-timer nudges, agenda, route triage,
      // hub-auto hygiene, forged webhook/timer modes (mode alone never
      // suffices; source must be the formal coordination sweep), and
      // pre-existing retry events with cached actionable triageResults —
      // finishes as claimed noop WITHOUT DS calls, Hub sends, or endless
      // retry retention. Ledger preserved, never erased. Suppression runs
      // BEFORE daily-budget breakers so disabled events do not linger as retry.
      if (isWorkflowOnlyConfig(this.config) && !isWorkflowEssentialEvent(event)) {
        const base = triageResult ?? {
          actionable: false,
          needsLocalExec: false,
          category: event.categoryHint ?? event.category_hint ?? 'other',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'workflow-only: non-essential background automation suppressed (no DS, no dispatch)',
        };
        this.store.finish(event.id, 'noop', {
          triageResult: {
            ...base,
            actionable: false,
            suggestedRecipient: null,
            rationale: `${String(base.rationale ?? '').slice(0, 500)} | workflow-only suppressed`,
          },
          costCny,
          triageLatencyMs,
        });
        log('info', 'workflow-only suppressed non-essential event', {
          eventId: event.id,
          source: event.source,
        });
        return true;
      }

      // Formal deterministic execution/verification bypass daily background
      // budgets (dailyEvents/dailyCostCny): removing coordination.dailyLimit
      // alone still leaves this starvation gate. Concurrency, batching,
      // retry, and authority gates all remain.
      if (!isWorkflowEssentialEvent(event)) {
        const breaker = this.breakerReason();
        if (breaker) {
          this.store.retry(event.id, breaker, 60 * 60_000);
          log('warn', 'breaker deferred event', { eventId: event.id, breaker });
          return true;
        }
      }

      if (this.isCoordinationEvent(event)) {
        // Retired consumer (scan retired with it): host execution and
        // verification payloads drain as noop without model wake or Hub
        // sends, even outside workflowOnly. Hygiene payloads still route to
        // the preserved ancillary handler.
        const retiredMode = event.payload?.mode === 'coordination'
          || event.payload?.mode === 'coordination-verification';
        if (retiredMode) {
          this.store.finish(event.id, 'noop', {
            triageResult: {
              actionable: false,
              needsLocalExec: false,
              category: 'coordination',
              priority: 1,
              suggestedRecipient: null,
              rationale: 'retired: host coordination dispatch removed; task ledger owns continuation',
            },
            costCny,
            triageLatencyMs,
          });
          log('info', 'retired coordination payload drained', { eventId: event.id });
          return true;
        }
        await this.processCoordination(event);
        return true;
      }

      if (this.isRouteTriageEvent(event)) {
        await this.processRouteTriage(event);
        return true;
      }

      if (this.isDiaryEvent(event)) {
        await this.processDiary(event);
        return true;
      }

      const isReminder = this.isTaskReminder(event);
      const isBacklogSweep = this.isBacklogSweep(event);
      let backlogSnapshot = null;
      let contacts = null;
      if (isReminder) {
        if (!this.vault.enabled) throw new Error('task reminders require a configured memory vault');
        const current = buildTaskReminders(await this.vault.taskContext())
          .find((item) => item.reminderKey === event.payload?.reminderKey);
        if (!current) {
          const staleResult = {
            actionable: false,
            needsLocalExec: false,
            category: 'daily',
            priority: 1,
            suggestedRecipient: null,
            rationale: 'task reminder became stale before delivery',
            taskPath: event.payload?.taskPath ?? null,
          };
          this.store.finish(event.id, 'noop', { triageResult: staleResult, costCny, triageLatencyMs });
          log('info', 'stale task reminder suppressed', { eventId: event.id, taskPath: event.payload?.taskPath });
          return true;
        }
        triageResult = {
          actionable: true,
          needsLocalExec: false,
          category: 'daily',
          priority: current.priority,
          suggestedRecipient: this.taskReminderConfig().recipient,
          rationale: `${current.taskPath} entered reminder stage ${current.stage}`,
          taskPath: current.taskPath,
        };
        const reminderRoute = this.taskReminderRoute(current);
        if (
          current.stage === 'due-today'
          && reminderRoute.verifier
          && this.verificationDispatchSettled(current.taskPath, current.dueDate, reminderRoute.verifier)
        ) {
          this.store.finish(event.id, 'noop', {
            triageResult: {
              ...triageResult,
              actionable: false,
              rationale: 'same-day verification dispatch already covers this due-today reminder',
            },
            costCny,
            triageLatencyMs,
          });
          log('info', 'task reminder suppressed after same-day verification dispatch', {
            eventId: event.id,
            taskPath: current.taskPath,
          });
          return true;
        }
        if (reminderRoute.route === 'room') {
          if (this.coordinationPolicy().poolFull) {
            this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000, {
              triageResult,
              costCny,
              triageLatencyMs,
            });
            return true;
          }
          try {
            const coordination = this.coordinationConfig();
            const dispatched = await this.hub.dispatchRoomHost(coordination.roomId, {
              content: formatTaskReminderRoomNotice(current),
              hostName: coordination.hostName,
              trigger: false,
              reactionRounds: 0,
              idempotencyKey: `reminder:v1:${current.taskPath}:${current.dueDate}:${current.stage}`,
            });
            const storedResult = {
              ...triageResult,
              category: 'coordination',
              suggestedRecipient: null,
              rationale: `${current.taskPath} reminder stage ${current.stage} posted to coordination room`,
            };
            this.store.recordDelivery(
              event.id,
              coordination.roomId,
              Date.now(),
              DELIVERY_POOL_COORDINATION,
              {
                messageId: dispatched?.messageId,
                taskPath: current.taskPath,
                executedVia: EXECUTED_VIA_NONE,
              },
            );
            this.store.finish(event.id, 'dispatched', {
              triageResult: storedResult,
              recipientId: coordination.roomId,
              costCny,
              triageLatencyMs,
            });
            log('info', 'task reminder dispatched to coordination room', {
              eventId: event.id,
              taskPath: current.taskPath,
              stage: current.stage,
              roomId: coordination.roomId,
              pool: DELIVERY_POOL_COORDINATION,
            });
            return true;
          } catch (error) {
            log('warn', 'task reminder room dispatch failed; falling back to main', {
              eventId: event.id,
              taskPath: current.taskPath,
              error: error.message,
            });
          }
        }
      }
      if (isBacklogSweep) {
        backlogSnapshot = await this.dispatchableBacklog();
        // Soft-parse failure (empty/garbage snapshot) → fail-open to L1; only a
        // well-formed explicit-zero eligible set may short-circuit.
        if (backlogSnapshot.parseOk && !backlogSnapshot.taskPaths.length) {
          const noTaskResult = {
            actionable: false,
            category: 'backlog',
            priority: 1,
            suggestedRecipient: null,
            rationale: 'no unclaimed current task; tails, future tasks, and previously handled paths are suppressed',
            taskPath: null,
          };
          this.store.finish(event.id, 'noop', {
            triageResult: noTaskResult,
            costCny,
            triageLatencyMs,
          });
          log('info', 'backlog sweep suppressed before L1', {
            eventId: event.id,
            ignored: backlogSnapshot.ignored.length,
          });
          return true;
        }
        if (
          backlogSnapshot.parseOk
          && triageResult?.taskPath
          && !backlogSnapshot.taskPaths.includes(triageResult.taskPath)
        ) {
          const staleResult = {
            ...triageResult,
            actionable: false,
            suggestedRecipient: null,
            rationale: `${triageResult.rationale} | task is no longer dispatchable`,
            taskPath: null,
          };
          this.store.finish(event.id, 'noop', {
            triageResult: staleResult,
            costCny,
            triageLatencyMs,
          });
          log('info', 'stale backlog retry suppressed', {
            eventId: event.id,
            taskPath: triageResult.taskPath,
          });
          return true;
        }
      }

      // System timer (quarter-hour-check): same eligible-task gate as backlog, $0 before L1.
      // Vault missing/error OR unparseable snapshot → fail-open to L1 (no false negatives).
      // Only a well-formed snapshot with explicit zero eligible tasks may short-circuit.
      if (!isReminder && !isBacklogSweep && isSystemTimerEvent(event) && !triageResult) {
        if (this.vault.enabled) {
          try {
            backlogSnapshot = await this.dispatchableBacklog();
            if (!backlogSnapshot.parseOk) {
              log('warn', 'system timer task snapshot unparseable; fail-open to L1', {
                eventId: event.id,
              });
              backlogSnapshot = null;
            } else if (!backlogSnapshot.taskPaths.length) {
              const noTaskResult = {
                actionable: false,
                category: 'system',
                priority: 1,
                suggestedRecipient: null,
                rationale: 'system timer: no eligible current task; suppressed before L1',
                taskPath: null,
              };
              this.store.finish(event.id, 'noop', {
                triageResult: noTaskResult,
                costCny,
                triageLatencyMs,
              });
              log('info', 'system timer suppressed before L1', {
                eventId: event.id,
                ignored: backlogSnapshot.ignored.length,
              });
              return true;
            }
          } catch (error) {
            log('warn', 'system timer eligible-task probe failed; fail-open to L1', {
              eventId: event.id,
              error: error.message,
            });
            backlogSnapshot = null;
          }
        }
      }

      if (!triageResult) {
        let backlogSummary = '';
        let triageOptions = {};
        if (isBacklogSweep) {
          backlogSummary = backlogSnapshot.summary;
          triageOptions = { allowedTaskPaths: backlogSnapshot.taskPaths };
        } else {
          backlogSummary = await this.vault.taskContext().catch((error) => {
            log('warn', 'task context unavailable', { error: error.message });
            return '';
          });
        }
        const reviewed = await this.deepseek.triage(
          event,
          backlogSummary,
          triageOptions,
        );
        triageResult = reviewed.result;
        costCny += reviewed.costCny;
        triageLatencyMs = reviewed.latencyMs;
      }
      if (
        isBacklogSweep
        && triageResult.actionable
        && !backlogSnapshot.taskPaths.includes(triageResult.taskPath)
      ) {
        const invalidSelection = {
          ...triageResult,
          actionable: false,
          suggestedRecipient: null,
          rationale: `${triageResult.rationale} | L1 did not select an exact eligible taskPath`,
          taskPath: null,
        };
        this.store.finish(event.id, 'noop', {
          triageResult: invalidSelection,
          costCny,
          triageLatencyMs,
        });
        log('warn', 'backlog sweep rejected invalid L1 task selection', {
          eventId: event.id,
          taskPath: triageResult.taskPath,
        });
        return true;
      }
      if (isBacklogSweep && !triageResult.actionable && triageResult.taskPath !== null) {
        triageResult = { ...triageResult, taskPath: null };
      }
      validateTriageMode(triageResult, {
        mode: isReminder ? 'daily' : 'task',
        dailyRecipients: isReminder ? [this.taskReminderConfig().recipient] : [],
        allowedTaskPaths: isBacklogSweep ? backlogSnapshot.taskPaths : null,
      });
      if (!triageResult.actionable) {
        this.store.finish(event.id, 'noop', { triageResult, costCny, triageLatencyMs });
        log('info', 'event classified NO_OP', {
          eventId: event.id,
          category: triageResult.category,
          priority: triageResult.priority,
          costCny,
          triageLatencyMs,
        });
        return true;
      }

      contacts ??= await this.hub.contacts();
      const options = this.routeOptions(isReminder);
      let route = chooseRecipient({
        contacts,
        result: triageResult,
        ...options,
      });
      let fallbackUsed = triageResult.fallbackUsed === true;
      if (
        !route.contact
        && route.reason === 'no-route'
        && !fallbackUsed
        && this.config.routing?.fuzzyFallback !== false
        && (
          triageResult.needsLocalExec !== true
          || contacts.some((contact) => contact.config?.delegation?.enabled === true)
        )
      ) {
        const fallback = await this.deepseek.fuzzyRoute(event, triageResult, contacts, {
          allowedRecipientKeys: isReminder ? [this.taskReminderConfig().recipient] : null,
        });
        costCny += fallback.costCny;
        fallbackUsed = true;
        triageResult = {
          ...triageResult,
          suggestedRecipient: fallback.result.suggestedRecipient,
        };
        route = chooseRecipient({
          contacts,
          result: triageResult,
          ...this.routeOptions(isReminder),
        });
      }
      const storedResult = { ...triageResult, fallbackUsed };

      if (!route.contact) {
        if (route.reason === 'all-candidates-busy' || route.reason === 'all-candidates-rate-limited') {
          this.store.retry(event.id, route.reason, 15 * 60_000, {
            triageResult: storedResult,
            costCny,
            triageLatencyMs,
          });
          log('info', 'event deferred by recipient policy', { eventId: event.id, reason: route.reason });
          return true;
        }
        if (this.vault.enabled) {
          await this.vault.park(event, storedResult, route.reason);
        }
        this.store.finish(event.id, 'parked', {
          triageResult: storedResult,
          error: route.reason,
          costCny,
          triageLatencyMs,
        });
        log('warn', 'event parked without route', { eventId: event.id, reason: route.reason });
        return true;
      }

      const automationKey = `automation:${event.source}:${event.id}`;
      let dispatchResult;
      let deliveryRecipientId = route.contact.id;
      let deliveryPool = DELIVERY_POOL_DAILY;
      let deliveryRoute = 'reminder-main';
      if (isReminder) {
        dispatchResult = await this.hub.dispatch(
          route.contact.id,
          dispatchPrompt(event, storedResult, { reminder: true }),
          {
            origin: 'main',
            hidden: true,
            idempotencyKey: automationKey,
            automation: {
              messageType: 'proactive-trigger',
              eventSource: event.source,
              eventId: event.id,
              eventCategory: storedResult.category,
              eventPriority: storedResult.priority,
            },
          },
        );
      } else {
        const coordination = this.coordinationConfig();
        const room = contacts.find((contact) => (
          contact?.id === coordination.roomId
          && contact?.kind === 'room'
          && contact?.enabled !== false
        ));
        const roomMembers = Array.isArray(room?.config?.members) ? room.config.members : [];
        const roomTargeted = roomMembers.includes(route.contact.id);
        if (coordination.enabled && coordination.roomId && coordination.tasksDir
            && this.coordinationPolicy().poolFull) {
          this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000, {
            triageResult: storedResult,
            costCny,
            triageLatencyMs,
          });
          return true;
        }
        const nudge = formatTaskNudgeRoomNotice(event, storedResult, route.contact.id);
        deliveryPool = DELIVERY_POOL_COORDINATION;
        if (roomTargeted) {
          dispatchResult = await this.hub.dispatchRoomHost(coordination.roomId, {
            content: nudge,
            hostName: coordination.hostName,
            targetIds: [route.contact.id],
            reactionRounds: 0,
            idempotencyKey: automationKey,
          });
          deliveryRecipientId = coordination.roomId;
          deliveryRoute = 'coordination-room';
        } else {
          dispatchResult = await this.hub.dispatch(
            route.contact.id,
            `【降级投递：会议室不可用或 @${route.contact.id} 不在群成员中】\n${nudge}`,
            {
              origin: 'main',
              hidden: false,
              idempotencyKey: automationKey,
              automation: {
                messageType: 'automation-trigger',
                eventSource: event.source,
                eventId: event.id,
                eventCategory: storedResult.category,
                eventPriority: storedResult.priority,
              },
            },
          );
          deliveryRoute = 'degraded-dm-main';
        }
      }
      if (isBacklogSweep) this.claimBacklogTask(storedResult.taskPath, event.id);
      const deliveredAt = Date.now();
      this.store.recordDelivery(
        event.id,
        deliveryRecipientId,
        deliveredAt,
        deliveryPool,
        {
          messageId: dispatchResult?.messageId,
          taskPath: storedResult.taskPath ?? null,
          executedVia: isReminder
            ? EXECUTED_VIA_NONE
            : storedResult.needsLocalExec
              ? EXECUTED_VIA_WORKER
              : EXECUTED_VIA_CONTACT,
        },
      );
      if (!isReminder) {
        // Two ledgers, one nudge. The row above is attributed to wherever the message
        // actually landed (the coordination room, or the contact on degraded DM) and burns
        // the shared coordination pool; outcome collection follows that recipient. The task
        // pool stays what it always was: the per-contact 24h work quota chooseRecipient
        // reads through routeOptions. Room-routed nudges never touch the contact's own
        // recipient_id, so without this ledger row the daily-limit and cooldown branches
        // could never fire again.
        this.store.recordDelivery(event.id, route.contact.id, deliveredAt, DELIVERY_POOL_TASK);
      }
      this.store.finish(event.id, 'dispatched', {
        triageResult: storedResult,
        recipientId: deliveryRecipientId,
        costCny,
        triageLatencyMs,
      });
      log('info', 'event dispatched', {
        eventId: event.id,
        recipientId: deliveryRecipientId,
        category: storedResult.category,
        priority: storedResult.priority,
        pool: deliveryPool,
        route: deliveryRoute,
        fallbackUsed,
        costCny,
        triageLatencyMs,
      });
    } catch (error) {
      if (event.attempts >= this.config.maxAttempts) {
        if (this.vault.enabled && triageResult) {
          await this.vault.park(event, triageResult, `dead after ${event.attempts} attempts: ${error.message}`)
            .catch(() => {});
        }
        this.store.finish(event.id, 'dead', {
          triageResult,
          error: error.message,
          costCny,
          triageLatencyMs,
        });
        log('error', 'event exhausted retries', { eventId: event.id, error: error.message });
      } else {
        this.store.retry(event.id, error.message, retryDelay(event.attempts), {
          triageResult,
          costCny,
          triageLatencyMs,
        });
        log('warn', 'event scheduled for retry', {
          eventId: event.id,
          attempt: event.attempts,
          error: error.message,
        });
      }
    }
    return true;
  },
};
