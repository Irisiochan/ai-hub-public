import fs from 'node:fs';
import {
  isShanghaiSilentHour,
  nextWallClockDelay,
  parseTaskFrontmatter,
  shanghaiDateAt,
} from './triage-core.mjs';
import { parseAgendaListing } from './agenda-core.mjs';
import {
  formatAutoDispatchBlock,
  formatPlanRequestBlock,
  formatRouteTriageNudge,
  formatRouteTriageStats,
  isAutoDispatchSafeTitle,
  normalizeRouteTriageConfig,
  parseRouteTriageReply,
  parseRouteVetoes,
  resolveRouteSuggestion,
  routeAutoDispatchStateKey,
  routeAutoDispatchKey,
  routeTriageStateKey,
  routeTriageStatsStateKey,
  selectRouteTriageCandidates,
  shanghaiWeekdayOf,
} from './route-triage-core.mjs';
import { taskFilePath } from './worker-agenda.mjs';
import { log, once, ROUTE_TRIAGE_SOURCE, routeTriageOnce } from './worker-shared.mjs';

function parseState(raw) {
  try {
    const parsed = JSON.parse(raw ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * TriageWorker 的路由初筛 domain（影子模式）。
 * Agenda digest 之后 room-host 点名 reviewer（默认 aye）给无主任务出路由建议；
 * 建议只落 route_suggestions 账本与群消息，不写 executor、不派单。
 * 归宿解析与改派率周报见 resolveRouteSuggestionsIfDue。
 */
export const routeTriageMethods = {
  routeTriageConfig() {
    return this.config.routeTriage
      ?? normalizeRouteTriageConfig({}, this.config.coordination);
  },

  isRouteTriageEvent(event) {
    return event?.source === ROUTE_TRIAGE_SOURCE
      || event?.payload?.mode === 'route-triage';
  },

  /** 读每个 open 任务文件的路由 frontmatter；文件缺失/无 frontmatter/非 open 一律不可证明无主。 */
  async readRouteTaskMetadata(taskContextText) {
    const tasksDir = this.coordinationConfig().tasksDir;
    if (!tasksDir || !fs.existsSync(tasksDir)) return {};
    const metadata = {};
    for (const item of parseAgendaListing(taskContextText, 'task')) {
      const file = taskFilePath(tasksDir, item.path);
      if (!file) continue;
      let frontmatter = null;
      try {
        frontmatter = parseTaskFrontmatter(fs.readFileSync(file, 'utf8'));
      } catch {
        frontmatter = null;
      }
      const open = String(frontmatter?.status ?? '').toLowerCase() === 'open';
      metadata[item.path] = {
        readable: Boolean(frontmatter) && open,
        executor: String(frontmatter?.executor ?? '').trim().toLowerCase(),
        verifier: String(frontmatter?.verifier ?? '').trim().toLowerCase(),
      };
    }
    return metadata;
  },

  async collectRouteTriageCandidates(config, today) {
    const taskContextText = await this.vault.taskContext();
    const taskMetadata = await this.readRouteTaskMetadata(taskContextText);
    const pendingPaths = [
      ...this.store.pendingRouteSuggestionPaths(),
      ...this.store.routeSuggestionPathsForDate(today),
    ];
    return selectRouteTriageCandidates({
      taskContextText,
      taskMetadata,
      pendingPaths,
      today,
      maxItems: config.maxItems,
    });
  },

  /** 每日一次（上海墙钟）：有无主候选就入队一条 route-triage 事件，无候选记 quiet。 */
  async runRouteTriageScan(now = Date.now()) {
    const config = this.routeTriageConfig();
    if (!config.enabled) {
      log('info', 'route triage quiet', { reason: 'disabled' });
      return { status: 'quiet', reason: 'disabled' };
    }
    if (!this.store || this.maintenance) {
      log('info', 'route triage quiet', { reason: 'maintenance state store unavailable' });
      return { status: 'quiet', reason: 'maintenance state store unavailable' };
    }
    if (!config.roomId || !this.vault.enabled) {
      log('info', 'route triage quiet', { reason: 'roomId or memory vault missing' });
      return { status: 'quiet', reason: 'roomId or memory vault missing' };
    }
    const date = shanghaiDateAt(now, 0);
    const key = routeTriageStateKey(date);
    if (this.store.getSourceState(key)) {
      log('info', 'route triage quiet', { date, reason: 'Shanghai date already settled' });
      return { status: 'quiet', reason: 'Shanghai date already settled', date };
    }
    const { candidates, foldedCount, skipped } = await this.collectRouteTriageCandidates(config, date);
    if (!candidates.length) {
      this.store.setSourceState(key, JSON.stringify({
        status: 'quiet',
        date,
        reason: 'no unrouted candidates',
        skipped,
        settledAt: now,
      }));
      log('info', 'route triage quiet', { date, reason: 'no unrouted candidates', ...skipped });
      return { status: 'quiet', reason: 'no unrouted candidates', date };
    }
    const queued = this.enqueue({
      source: ROUTE_TRIAGE_SOURCE,
      categoryHint: 'coordination',
      summary: `Route triage nudge: ${candidates.length} unrouted tasks for @${config.reviewer}`,
      dedupeKey: key,
      payload: { mode: 'route-triage', date, paths: candidates.map((item) => item.path) },
    });
    this.store.setSourceState(key, JSON.stringify({
      status: 'queued',
      date,
      eventId: queued.id,
      candidateCount: candidates.length,
      foldedCount,
      queuedAt: now,
    }));
    log('info', 'route triage queued', {
      date,
      eventId: queued.id,
      candidates: candidates.length,
      foldedCount,
      ...skipped,
    });
    return { status: 'queued', date, eventId: queued.id };
  },

  async processRouteTriage(event) {
    const config = this.routeTriageConfig();
    const date = typeof event.payload?.date === 'string' ? event.payload.date : '';
    // 只有已开轮次（roundId 在手）的中间态才值得续跑；没发出去的一律整段重建，
    // hub 侧 idempotencyKey 保证重建后的 dispatch 不会重复发消息。
    let result = event.triageResult?.category === 'route-triage' && event.triageResult.roundId
      ? event.triageResult
      : null;
    // pipeline 的 catch 通过 error.ideaState 恢复分阶段进度（与 idea 房同一机制）。
    const stateError = (error) => {
      error.ideaState = { costCny: 0, triageLatencyMs: 0, triageResult: result };
      return error;
    };
    const finishNoop = (rationale) => {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'route-triage',
          priority: 1,
          suggestedRecipient: null,
          rationale,
        },
      });
      log('info', 'route triage noop', { eventId: event.id, date, rationale });
    };

    if (!config.enabled || !config.roomId || !date) {
      return finishNoop('route triage config or payload is no longer valid');
    }
    const stateKey = routeTriageStateKey(date);
    const settled = parseState(this.store.getSourceState(stateKey));
    if (settled && settled.status !== 'queued') {
      return finishNoop(`route triage already ${settled.status} for ${date}`);
    }
    if (isShanghaiSilentHour(
      Date.now(),
      this.proactiveConfig().silentStartHour,
      this.proactiveConfig().silentEndHour,
    )) {
      this.store.retry(event.id, 'route triage silent hours', 60 * 60_000, {
        triageResult: result,
      });
      return;
    }
    if (this.coordinationPolicy().poolFull) {
      this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000, {
        triageResult: result,
      });
      return;
    }

    try {
      if (!result) {
        // 派前重刷候选：排队/重试期间任务可能被认领或关闭。
        const { candidates, foldedCount } = await this.collectRouteTriageCandidates(config, date);
        const fresh = new Set(event.payload?.paths ?? []);
        const current = fresh.size
          ? candidates.filter((item) => fresh.has(item.path))
          : candidates;
        if (!current.length) {
          this.store.setSourceState(stateKey, JSON.stringify({
            status: 'quiet',
            date,
            reason: 'candidates resolved before nudge',
            settledAt: Date.now(),
          }));
          return finishNoop('all candidates were routed or closed before the nudge');
        }
        const opened = await this.hub.dispatchRoomHost(config.roomId, {
          content: formatRouteTriageNudge({
            date,
            reviewer: config.reviewer,
            candidates: current,
            foldedCount,
            allowedRecipients: config.allowedRecipients,
            autoDispatch: config.autoDispatch,
          }),
          hostName: config.hostName,
          targetIds: [config.reviewer],
          reactionRounds: config.reactionRounds,
          idempotencyKey: `${stateKey}:nudge`,
        });
        result = {
          actionable: true,
          needsLocalExec: false,
          category: 'route-triage',
          priority: 1,
          suggestedRecipient: config.reviewer,
          rationale: `route triage nudge for ${current.length} unrouted tasks`,
          stage: 'nudge-dispatched',
          candidatePaths: current.map((item) => item.path),
          roundId: opened.roundId,
          nudgeMessageId: opened.messageId,
        };
      }

      let round;
      try {
        round = await this.hub.waitRoomRound(config.roomId, result.roundId, {
          pollMs: config.roundPollMs,
          timeoutMs: config.roundTimeoutMs,
        });
      } catch (error) {
        if (String(error.message).startsWith('room round failed:')) {
          result = {
            ...result,
            stage: 'candidates-selected',
            roundId: undefined,
            nudgeMessageId: undefined,
          };
        }
        throw error;
      }

      const rows = await this.hub.messages(config.roomId, result.nudgeMessageId, 200);
      const replyRows = rows.filter((row) => (
        row.kind === 'text' && row.status === 'done' && row.sender === config.reviewer
      ));
      const parsed = parseRouteTriageReply(
        replyRows.map((row) => row.content).join('\n'),
        {
          candidatePaths: result.candidatePaths,
          allowedRecipients: config.allowedRecipients,
        },
      );
      if (parsed.invalid.length) {
        log('warn', 'route triage reply had invalid lines', {
          eventId: event.id,
          date,
          invalid: parsed.invalid,
        });
      }
      this.store.settleRouteTriage(event.id, {
        roomId: config.roomId,
        suggestions: parsed.suggestions.map((item) => ({
          ...item,
          kind: 'task',
          suggestDate: date,
        })),
        stateKey,
        stateValue: JSON.stringify({
          status: 'dispatched',
          date,
          eventId: event.id,
          messageId: result.nudgeMessageId,
          // 晚到补收（harvest）需要原候选集来复验路径；见 harvestLateRouteRepliesIfNeeded。
          candidatePaths: result.candidatePaths,
          suggested: parsed.suggestions.length,
          held: parsed.holds.length,
          invalid: parsed.invalid.length,
          roundOutcome: round?.outcome ?? null,
          settledAt: Date.now(),
        }),
        messageId: result.nudgeMessageId,
        triageResult: {
          ...result,
          stage: 'completed',
          suggested: parsed.suggestions.length,
          held: parsed.holds.length,
          invalidLines: parsed.invalid.length,
        },
      });
      log('info', 'route triage completed', {
        eventId: event.id,
        date,
        candidates: result.candidatePaths.length,
        suggested: parsed.suggestions.length,
        held: parsed.holds.length,
        invalid: parsed.invalid.length,
        nudgeMessageId: result.nudgeMessageId,
      });
    } catch (error) {
      throw stateError(error);
    }
  },

  /** 归宿解析当前语义：以 exact taskPath 重读任务文件。 */
  routeTaskCurrentState(taskPath) {
    const tasksDir = this.coordinationConfig().tasksDir;
    const file = tasksDir ? taskFilePath(tasksDir, taskPath) : null;
    const missing = { exists: false, open: false, executor: '', title: '', mode: null, tags: [] };
    if (!file) return missing;
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return missing;
    }
    const frontmatter = parseTaskFrontmatter(raw);
    const rawMode = String(frontmatter?.mode ?? '').trim().toLowerCase();
    return {
      exists: true,
      open: String(frontmatter?.status ?? '').toLowerCase() === 'open',
      executor: String(frontmatter?.executor ?? '').trim().toLowerCase(),
      title: raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '',
      mode: rawMode === 'ask' || rawMode === 'auto' ? rawMode : null,
      tags: (Array.isArray(frontmatter?.tags) ? frontmatter.tags : [frontmatter?.tags])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    };
  },

  /**
   * 阶段二：否决窗口过后的自动派单闭环。
   * 建议落账（pending）满 delayMinutes 后，扫 nudge 之后的群消息找 vetoSenders 的
   * `[VETO] <path>` 行；被否决的记 vetoed，其余通过安全闸（任务仍 open 且无主、
   * 非 mode:ask、标题/tags 不含 T3 敏感词、日额度未满）的按 stage 派单：
   * plan → 向建议对象征集 Plan（写回后由既有 coordination sweep 接手执行派单）；
   * execute/review/maintenance → 直接派给建议对象（三选一：PASS/就地完成/delegate_to_worker）。
   * 超过 maxAgeHours 未派的建议不再自动开火，由常规到期逻辑收 expired。
   */
  async autoDispatchRouteSuggestionsIfDue(now = Date.now()) {
    const config = this.routeTriageConfig();
    const auto = config.autoDispatch;
    if (!auto.enabled || !config.roomId) return false;
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) return false;
    const candidates = this.store.autoDispatchCandidates({
      delayMs: auto.delayMinutes * 60_000,
      maxAgeMs: auto.maxAgeHours * 3_600_000,
      now,
    });
    if (!candidates.length) return false;
    const dayKey = routeAutoDispatchStateKey(shanghaiDateAt(now, 0));
    const dayState = parseState(this.store.getSourceState(dayKey)) ?? { count: 0, paths: [] };
    const byAnchor = new Map();
    for (const row of candidates) {
      const anchor = Number(row.message_id);
      // 无 nudge 锚点就没有可审计的否决窗口：不自动派，留给人工或到期。
      if (!Number.isInteger(anchor)) continue;
      if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
      byAnchor.get(anchor).push(row);
    }
    let acted = false;
    for (const [anchor, rows] of byAnchor) {
      let messages = [];
      try {
        messages = await this.hub.messages(config.roomId, anchor, 200);
      } catch (error) {
        log('warn', 'route auto-dispatch veto scan failed', { anchor, error: error.message });
        continue;
      }
      const vetoes = new Map(parseRouteVetoes(messages, {
        paths: rows.map((row) => row.item_path),
        vetoSenders: auto.vetoSenders,
      }).map((veto) => [veto.path, veto]));
      for (const row of rows) {
        const veto = vetoes.get(row.item_path);
        if (veto) {
          this.store.resolveRouteSuggestionRow(row.id, 'vetoed', {
            resolvedRecipient: null,
            resolvedVia: `veto:${veto.sender}`,
          }, now);
          acted = true;
          log('info', 'route suggestion vetoed', {
            id: row.id,
            taskPath: row.item_path,
            vetoedBy: veto.sender,
            reason: veto.reason,
          });
          continue;
        }
        if (dayState.count >= auto.dailyLimit || this.coordinationPolicy(now).poolFull) continue;
        const current = this.routeTaskCurrentState(row.item_path);
        // closed/已有 executor 的行留给常规归宿解析记 closed/followed/overridden。
        if (!current.exists || !current.open || current.executor) continue;
        if (current.mode === 'ask' || !isAutoDispatchSafeTitle(`${current.title} ${current.tags.join(' ')}`)) {
          log('info', 'route auto-dispatch held by safety gate', {
            id: row.id,
            taskPath: row.item_path,
            mode: current.mode,
          });
          continue;
        }
        const content = row.stage === 'plan'
          ? formatPlanRequestBlock({ suggestion: row, title: current.title })
          : formatAutoDispatchBlock({ suggestion: row, title: current.title });
        let dispatched;
        try {
          dispatched = await this.hub.dispatchRoomHost(config.roomId, {
            content,
            hostName: config.hostName,
            targetIds: [row.recipient],
            reactionRounds: 0,
            idempotencyKey: routeAutoDispatchKey(row),
          });
        } catch (error) {
          log('warn', 'route auto-dispatch failed', {
            id: row.id,
            taskPath: row.item_path,
            error: error.message,
          });
          continue;
        }
        this.store.markRouteSuggestionDispatched(row.id, {
          resolvedRecipient: row.recipient,
          dispatchMessageId: dispatched?.messageId,
          dispatchRoundId: dispatched?.roundId,
        }, now);
        // 与 backlog sweep 互斥：同一路径不再被 L1 通道二次派单。
        this.claimBacklogTask(row.item_path, `route-auto:${row.id}`);
        dayState.count += 1;
        dayState.paths.push(row.item_path);
        this.store.setSourceState(dayKey, JSON.stringify(dayState));
        acted = true;
        log('info', 'route suggestion auto-dispatched', {
          id: row.id,
          taskPath: row.item_path,
          stage: row.stage,
          recipient: row.recipient,
          messageId: dispatched?.messageId,
          dailyCount: dayState.count,
        });
      }
    }
    return acted;
  },

  /**
   * route-auto 轮次结束但 normal.spoke=0 时，派单并未被真正承接：把建议记为
   * passed 并释放精确 claim。v10 存量行没有 round id，按稳定幂等键从 nudge
   * 之后的 room-host 消息反查并补绑；因此同一逻辑既是启动清理，也是日常对账。
   */
  async reconcileRouteAutoDispatches(now = Date.now()) {
    const config = this.routeTriageConfig();
    const summary = {
      checked: 0,
      running: 0,
      passed: 0,
      released: 0,
      unresolved: 0,
      settledPaths: [],
      passedPaths: [],
      remainingClaimPaths: [],
    };
    if (!config.roomId || !this.store) return summary;
    for (const row of this.store.dispatchedRouteSuggestions()) {
      summary.checked += 1;
      let roundId = String(row.dispatch_round_id ?? '').trim();
      let dispatchMessageId = Number(row.dispatch_message_id);
      if (!roundId) {
        const messages = await this.hub.messages(config.roomId, row.message_id, 1000);
        const key = routeAutoDispatchKey(row);
        const host = messages.find((message) => {
          if (message?.sender !== 'room-host') return false;
          try {
            const meta = typeof message.meta === 'string' ? JSON.parse(message.meta || '{}') : message.meta;
            return meta?.roomHost?.idempotencyKey === key;
          } catch {
            return false;
          }
        });
        if (host) {
          try {
            const meta = typeof host.meta === 'string' ? JSON.parse(host.meta || '{}') : host.meta;
            roundId = String(meta?.roomHost?.roundId ?? '').trim();
            dispatchMessageId = Number(host.id);
          } catch {}
        }
        if (roundId) {
          this.store.bindRouteSuggestionRound(row.id, { dispatchMessageId, dispatchRoundId: roundId });
        }
      }
      if (!roundId) {
        summary.unresolved += 1;
        continue;
      }
      const round = await this.hub.roomRound(config.roomId, roundId);
      if (round.status !== 'done') {
        summary.running += 1;
        continue;
      }
      if (Number(round.outcome?.normal?.spoke) !== 0) continue;
      const claimId = `route-auto:${row.id}`;
      const claimReleased = this.releaseBacklogClaim(row.item_path, claimId);
      if (claimReleased) summary.released += 1;
      if (this.store.passRouteSuggestionRow(row.id, now)) {
        summary.passed += 1;
        summary.settledPaths.push(row.item_path);
      }
      log('info', 'route auto-dispatch passed without response', {
        id: row.id,
        taskPath: row.item_path,
        roundId,
        claimReleased,
      });
    }
    summary.passedPaths = this.store.passedRouteSuggestionPaths();
    summary.remainingClaimPaths = Object.entries(this.backlogClaims())
      .filter(([, claim]) => String(claim?.eventId ?? '').startsWith('route-auto:'))
      .map(([taskPath]) => taskPath);
    return summary;
  },

  /**
   * 晚到补收。首日（2026-08-30）实测的洞：reviewer 后端在轮次窗口内崩掉，
   * 轮次 0 回复收账，真实初筛发生在修复后的新轮次——已收账的 worker 再也不看。
   * 补法：当日状态 dispatched 且 suggested=0 时，随 resolve 节拍重拉 nudge 之后
   * 的消息重新解析；只补当日、不重发 nudge，(item_path, suggest_date) 唯一约束
   * 保证幂等。收到任何合法行（ROUTE 或 HOLD）即置 lateHarvested 停止重试。
   */
  async harvestLateRouteRepliesIfNeeded(now = Date.now()) {
    const config = this.routeTriageConfig();
    if (!config.enabled || !config.roomId) return false;
    const date = shanghaiDateAt(now, 0);
    const stateKey = routeTriageStateKey(date);
    const state = parseState(this.store.getSourceState(stateKey));
    if (
      state?.status !== 'dispatched'
      || state.lateHarvested === true
      || Number(state.suggested) > 0
      || !Number.isInteger(Number(state.messageId))
      || !Array.isArray(state.candidatePaths)
      || !state.candidatePaths.length
    ) return false;
    const rows = await this.hub.messages(config.roomId, state.messageId, 200);
    const parsed = parseRouteTriageReply(
      rows
        .filter((row) => row.kind === 'text' && row.status === 'done' && row.sender === config.reviewer)
        .map((row) => row.content)
        .join('\n'),
      {
        candidatePaths: state.candidatePaths,
        allowedRecipients: config.allowedRecipients,
      },
    );
    if (!parsed.suggestions.length && !parsed.holds.length) return false;
    const inserted = this.store.insertRouteSuggestions(parsed.suggestions.map((item) => ({
      ...item,
      kind: 'task',
      suggestDate: date,
      eventId: state.eventId ?? null,
      messageId: state.messageId,
    })), now);
    this.store.setSourceState(stateKey, JSON.stringify({
      ...state,
      suggested: parsed.suggestions.length,
      held: parsed.holds.length,
      invalid: parsed.invalid.length,
      lateHarvested: true,
      lateHarvestedAt: now,
    }));
    log('info', 'route triage late replies harvested', {
      date,
      inserted,
      suggested: parsed.suggestions.length,
      held: parsed.holds.length,
      invalid: parsed.invalid.length,
      nudgeMessageId: state.messageId,
    });
    return true;
  },

  /** 定期把 pending 建议对账成 followed/overridden/closed/expired，并按周贴改派率。 */
  async resolveRouteSuggestionsIfDue(now = Date.now()) {
    const config = this.routeTriageConfig();
    if (!config.enabled || !this.store || this.maintenance) return false;
    const intervalMs = config.resolveIntervalMinutes * 60_000;
    if (now < (this.nextRouteResolveAt ?? 0)) return false;
    this.nextRouteResolveAt = now + intervalMs;
    await this.harvestLateRouteRepliesIfNeeded(now).catch((error) => {
      log('warn', 'route triage late harvest failed', { error: error.message });
    });
    const routeAuto = await this.reconcileRouteAutoDispatches(now).catch((error) => {
      log('warn', 'route auto-dispatch reconciliation failed', { error: error.message });
      return { passed: 0, released: 0 };
    });
    const claims = this.backlogClaims();
    let resolved = 0;
    for (const row of this.store.pendingRouteSuggestions()) {
      const current = this.routeTaskCurrentState(row.item_path);
      const claim = claims[row.item_path];
      const dispatchRecipient = claim ? this.store.eventRecipient(claim.eventId) : '';
      const verdict = resolveRouteSuggestion({
        suggestion: { recipient: row.recipient, createdAt: Number(row.created_at) },
        current,
        dispatchRecipient,
        now,
        maxAgeDays: config.resolveMaxAgeDays,
      });
      if (verdict.status === 'pending') continue;
      this.store.resolveRouteSuggestionRow(row.id, verdict.status, verdict, now);
      resolved += 1;
      log('info', 'route suggestion resolved', {
        id: row.id,
        taskPath: row.item_path,
        suggested: row.recipient,
        status: verdict.status,
        resolvedRecipient: verdict.resolvedRecipient,
        resolvedVia: verdict.resolvedVia,
      });
    }
    const autoActed = await this.autoDispatchRouteSuggestionsIfDue(now).catch((error) => {
      log('warn', 'route auto-dispatch pass failed', { error: error.message });
      return false;
    });
    await this.maybePostRouteTriageStats(now).catch((error) => {
      log('warn', 'route triage stats post failed', { error: error.message });
    });
    return resolved > 0 || autoActed === true || routeAuto.passed > 0 || routeAuto.released > 0;
  },

  async maybePostRouteTriageStats(now = Date.now()) {
    const config = this.routeTriageConfig();
    if (!config.enabled || !config.roomId) return false;
    const date = shanghaiDateAt(now, 0);
    if (shanghaiWeekdayOf(date) !== config.statsWeekday) return false;
    const key = routeTriageStatsStateKey(date);
    if (this.store.getSourceState(key)) return false;
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) return false;
    const stats = this.store.routeSuggestionStats(now - config.statsWindowDays * 86_400_000);
    const content = formatRouteTriageStats({
      date,
      windowDays: config.statsWindowDays,
      stats,
    });
    if (!content) {
      this.store.setSourceState(key, JSON.stringify({ status: 'quiet', date, settledAt: now }));
      return false;
    }
    const dispatched = await this.hub.dispatchRoomHost(config.roomId, {
      content,
      hostName: config.hostName,
      trigger: false,
      capture: false,
      reactionRounds: 0,
      idempotencyKey: key,
    });
    this.store.setSourceState(key, JSON.stringify({
      status: 'dispatched',
      date,
      messageId: dispatched?.messageId ?? null,
      stats,
      settledAt: now,
    }));
    log('info', 'route triage stats posted', { date, messageId: dispatched?.messageId, ...stats });
    return true;
  },

  startRouteTriage() {
    const config = this.routeTriageConfig();
    if (!config.enabled) return null;
    const run = () => this.runRouteTriageScan().catch((error) => {
      log('warn', 'route triage scan failed', { error: error.message });
      if (routeTriageOnce) process.exitCode = 1;
    });
    if (once) return routeTriageOnce ? run() : null;
    const slot = this.timers.push(null) - 1;
    const schedule = () => {
      if (this.stopping) return;
      this.timers[slot] = setTimeout(() => {
        void run();
        schedule();
      }, nextWallClockDelay(config));
    };
    schedule();
    log('info', 'route triage scheduled', {
      at: `${String(config.atHour).padStart(2, '0')}:${String(config.atMinute).padStart(2, '0')}`,
      roomId: config.roomId || null,
      reviewer: config.reviewer,
    });
    return null;
  },
};
