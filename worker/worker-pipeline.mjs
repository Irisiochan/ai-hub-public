import {
  buildTaskReminders,
  chooseRecipient,
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_TASK,
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_NONE,
  EXECUTED_VIA_WORKER,
  formatSafetyEventDispatchBlock,
  formatTaskNudgeRoomNotice,
  formatTaskReminderRoomNotice,
  isShanghaiSilentHour,
  isSystemTimerEvent,
  isWebhookProbeInput,
  validateTriageMode,
} from './triage-core.mjs';
import { formatDailyDispatchDateBlock } from './date-events.mjs';
import {
  FOLLOWUP_STATUS_DISPATCHED,
  FOLLOWUP_STATUS_EXPIRED,
  formatFollowupDispatchBlock,
  formatFollowupFallbackBlock,
} from './followups.mjs';
import { log, retryDelay } from './worker-shared.mjs';

function dispatchPrompt(event, result, {
  daily = false,
  reminder = false,
  todayDateEvents = [],
  followup = null,
  fallbackFollowups = [],
  safetyEvents = [],
} = {}) {
  if (reminder) {
    return [
      '这是一次已通过确定性截止日期检查的任务提醒。',
      '请直接用你自己的自然语气把提醒告诉 User；不要提及 triage、路由、定时器、后台扫描或系统事件。',
      '只保留三项：一句结论、一个下一步、是否需要 User 操作。不要扩写背景，不要连续追问。',
      '',
      event.summary.slice(0, 3000),
    ].join('\n');
  }
  if (daily) {
    const safetyBlock = formatSafetyEventDispatchBlock(safetyEvents);
    const dateBlock = formatDailyDispatchDateBlock(todayDateEvents);
    const followupBlock = formatFollowupDispatchBlock(followup);
    const fallbackBlock = formatFollowupFallbackBlock(fallbackFollowups);
    return [
      '这是一次已经通过 daily triage 的主动陪伴机会。',
      '请现在直接用你自己的自然语气对 User 说一条简短消息。',
      '不要提及 triage、路由、系统事件、后台判断或 NO_OP；不要复述本指令。',
      '除非上下文里确有具体待办，否则不要登记任务或写长期记忆。',
      // Safety/date events must land in THIS prompt: the companion never sees L1 proactiveContext.
      ...(safetyBlock ? [safetyBlock] : []),
      ...(dateBlock ? [dateBlock] : []),
      ...(followupBlock ? [followupBlock] : []),
      ...(fallbackBlock ? [fallbackBlock] : []),
      `分诊理由：${result.rationale}`,
      '',
      '可参考的当前线索：',
      event.summary.slice(0, 6000),
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

  async processVaultOutboxOne() {
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
      const breaker = this.breakerReason();
      if (breaker) {
        this.store.retry(event.id, breaker, 60 * 60_000);
        log('warn', 'breaker deferred event', { eventId: event.id, breaker });
        return true;
      }

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

      if (this.isCoordinationEvent(event)) {
        await this.processCoordination(event);
        return true;
      }

      if (this.isIdeaEvent(event)) {
        await this.processIdea(event);
        return true;
      }

      if (this.isDiaryEvent(event)) {
        await this.processDiary(event);
        return true;
      }

      const isFollowup = this.isFollowupEvent(event);
      const followupRow = isFollowup && event.payload?.followupId
        ? this.store.getFollowup(event.payload.followupId)
        : null;
      // Deterministic path: same contact thread, no L1 pick-a-recipient.
      if (isFollowup && !triageResult) {
        if (!followupRow || !['pending', 'queued'].includes(followupRow.status)) {
          this.store.finish(event.id, 'noop', {
            triageResult: {
              actionable: false,
              needsLocalExec: false,
              category: 'daily',
              priority: 1,
              suggestedRecipient: null,
              rationale: 'followup already closed before dispatch',
            },
            costCny,
            triageLatencyMs,
          });
          log('info', 'stale followup event suppressed', {
            eventId: event.id,
            followupId: event.payload?.followupId,
          });
          return true;
        }
        triageResult = {
          actionable: true,
          needsLocalExec: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: followupRow.recipient_key
            || event.payload?.recipientKey
            || null,
          rationale: `temporary-absence followup: ${followupRow.activity}`,
        };
      }

      const isDaily = this.isDailyEvent(event) || isFollowup;
      const isReminder = this.isTaskReminder(event);
      const isProactive = isDaily || isReminder;
      const isBacklogSweep = !isDaily && this.isBacklogSweep(event);
      let backlogSnapshot = null;
      const proactive = this.proactiveConfig();
      // P3 S4: fresh unclaimed safety life-events pierce silent hours, the hard
      // pool and the minimum gap. Loaded fresh here (not from payload) so stale
      // enqueued events cannot re-trigger after User resolved the situation.
      const safetyEvents = isDaily && !isFollowup
        ? await this.loadUnclaimedSafetyEvents(Date.now())
        : [];
      if (
        isProactive
        && safetyEvents.length === 0
        && isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)
      ) {
        if (isReminder || isFollowup) {
          this.store.retry(event.id, 'Shanghai quiet hours', 60 * 60_000, {
            triageResult,
            costCny,
            triageLatencyMs,
          });
          log('info', isFollowup ? 'followup deferred by silent hours' : 'task reminder deferred by silent hours', {
            eventId: event.id,
          });
          return true;
        }
        const silentResult = triageResult ?? {
          actionable: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'Shanghai quiet hours 00:00–09:00',
        };
        this.store.finish(event.id, 'noop', {
          triageResult: silentResult,
          costCny,
          triageLatencyMs,
        });
        log('info', 'event suppressed by silent hours', { eventId: event.id });
        return true;
      }
      const dateEvents = isDaily && !isFollowup
        ? await this.loadMatchedDateEvents()
        : { today: [], upcoming: [], unclaimedToday: [] };
      const fallbackFollowups = isDaily && !isFollowup && Array.isArray(event.payload?.fallbackFollowupIds)
        ? event.payload.fallbackFollowupIds
          .slice(0, 1)
          .map((id) => this.store.getFollowup(id))
          .filter((followup) => followup?.status === FOLLOWUP_STATUS_EXPIRED
            && followup.fallback_reminded_at === null)
          .map((followup) => ({
            id: followup.id,
            activity: followup.activity,
            returnCommitment: followup.return_commitment ?? '',
            contactId: followup.contact_id,
            recipientKey: followup.recipient_key,
          }))
        : [];
      // Direct and next-day followups clear the gap like date-events; all still share the hard pool.
      const hasTodayDateEvent = dateEvents.unclaimedToday.length > 0
        || fallbackFollowups.length > 0
        || isFollowup;
      const initialDailyPolicy = isDaily
        ? this.dailyPolicy(Date.now(), { hasTodayDateEvent, hasFreshSafetyEvent: safetyEvents.length > 0 })
        : null;
      if (isDaily && (initialDailyPolicy.poolFull || initialDailyPolicy.gapBlocked)) {
        const fullResult = triageResult ?? {
          actionable: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: null,
          rationale: initialDailyPolicy.poolFull
            ? 'daily proactive pool exhausted for Shanghai day'
            : 'minimum daily proactive gap is still active',
        };
        this.store.finish(event.id, 'noop', {
          triageResult: fullResult,
          costCny,
          triageLatencyMs,
        });
        log('info', 'event suppressed by daily proactive policy', {
          eventId: event.id,
          limit: proactive.dailyDispatchLimit,
          reason: initialDailyPolicy.poolFull ? 'pool-full' : 'minimum-gap',
        });
        return true;
      }

      // Presence damping (on top of silent hours / minimumGap): if User herself
      // spoke recently, skip pure proactive assessment. Date-events, guaranteed
      // forceActionable slots, and followups still go through (no false negatives).
      if (
        isDaily
        && !isFollowup
        && !triageResult
        && !hasTodayDateEvent
        && !initialDailyPolicy.forceActionable
      ) {
        const presence = await this.detectIrisPresence(Date.now());
        if (presence.active) {
          const presenceResult = {
            actionable: false,
            category: 'daily',
            priority: 1,
            suggestedRecipient: null,
            rationale: `User active within ${proactive.presenceIdleMinutes}m; daily proactive damped`,
          };
          this.store.finish(event.id, 'noop', {
            triageResult: presenceResult,
            costCny,
            triageLatencyMs,
          });
          log('info', 'daily suppressed by User presence', {
            eventId: event.id,
            contactId: presence.contactId,
            lastUserMessageAt: presence.lastUserMessageAt,
            presenceIdleMinutes: proactive.presenceIdleMinutes,
          });
          return true;
        }
      }

      // Privacy-preserving deterministic path: the commitment goes only to the
      // original companion contact, never through external L1 triage.
      if (fallbackFollowups.length && !triageResult) {
        triageResult = {
          actionable: true,
          needsLocalExec: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: fallbackFollowups[0].recipientKey || proactive.recipients[0],
          rationale: 'unfinished return commitment from last night',
        };
      }
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
      if (!isDaily && !isReminder && !isFollowup && !isBacklogSweep && isSystemTimerEvent(event) && !triageResult) {
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
        if (isDaily) {
          contacts = await this.hub.contacts();
          triageOptions = {
            mode: 'daily',
            dailyRecipients: proactive.recipients,
            forceActionable: initialDailyPolicy.forceActionable,
            proactiveContext: await this.proactiveContext(contacts, Date.now(), dateEvents),
          };
        } else {
          if (isBacklogSweep) {
            backlogSummary = backlogSnapshot.summary;
            triageOptions = { allowedTaskPaths: backlogSnapshot.taskPaths };
          } else {
            backlogSummary = await this.vault.taskContext().catch((error) => {
              log('warn', 'task context unavailable', { error: error.message });
              return '';
            });
          }
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
        mode: isProactive ? 'daily' : 'task',
        dailyRecipients: proactive.recipients,
        forceActionable: isDaily && initialDailyPolicy.forceActionable,
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

      const currentDailyPolicy = isDaily
        ? this.dailyPolicy(Date.now(), { hasTodayDateEvent, hasFreshSafetyEvent: safetyEvents.length > 0 })
        : null;
      if (isDaily && (currentDailyPolicy.poolFull || currentDailyPolicy.gapBlocked)) {
        this.store.finish(event.id, 'noop', {
          triageResult: {
            ...triageResult,
            actionable: false,
            rationale: `${triageResult.rationale} | ${
              currentDailyPolicy.poolFull ? 'daily pool full' : 'minimum gap active'
            }`,
          },
          costCny,
          triageLatencyMs,
        });
        log('info', 'actionable daily dropped by policy', {
          eventId: event.id,
          reason: currentDailyPolicy.poolFull ? 'pool-full' : 'minimum-gap',
        });
        return true;
      }

      contacts ??= await this.hub.contacts();
      const options = this.routeOptions(isProactive);
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
          allowedRecipientKeys: isProactive ? proactive.recipients : null,
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
          ...this.routeOptions(isProactive),
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
      let deliveryRoute = 'daily-main';
      if (isProactive) {
        dispatchResult = await this.hub.dispatch(
          route.contact.id,
          dispatchPrompt(event, storedResult, {
            daily: isDaily,
            reminder: isReminder,
            todayDateEvents: isDaily && !isFollowup ? dateEvents.unclaimedToday : [],
            followup: isFollowup ? followupRow : null,
            fallbackFollowups,
            safetyEvents,
          }),
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
      if (isDaily && !isFollowup && dateEvents.unclaimedToday.length) {
        this.claimDateEvents(dateEvents.unclaimedToday, { eventId: event.id });
      }
      if (safetyEvents.length) {
        this.claimSafetyEvents(safetyEvents, { eventId: event.id });
      }
      if (isFollowup && followupRow) {
        this.store.updateFollowupStatus(followupRow.id, FOLLOWUP_STATUS_DISPATCHED, {
          eventId: event.id,
        });
      }
      if (fallbackFollowups.length) {
        this.store.markFollowupsFallbackReminded(fallbackFollowups.map((item) => item.id));
      }
      const deliveredAt = Date.now();
      this.store.recordDelivery(
        event.id,
        deliveryRecipientId,
        deliveredAt,
        deliveryPool,
        {
          messageId: dispatchResult?.messageId,
          taskPath: storedResult.taskPath ?? null,
          executedVia: isProactive
            ? EXECUTED_VIA_NONE
            : storedResult.needsLocalExec
              ? EXECUTED_VIA_WORKER
              : EXECUTED_VIA_CONTACT,
        },
      );
      if (!isProactive) {
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
        dateEvents: isDaily ? dateEvents.unclaimedToday.map((item) => item.key) : undefined,
        costCny,
        triageLatencyMs,
      });
    } catch (error) {
      if (error.ideaState) {
        costCny = error.ideaState.costCny;
        triageLatencyMs = error.ideaState.triageLatencyMs;
        triageResult = error.ideaState.triageResult;
      }
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
