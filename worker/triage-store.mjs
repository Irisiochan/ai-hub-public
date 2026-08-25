import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrateTriageDb } from './triage-migrations.mjs';
import {
  boundedText,
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_DIARY,
  DELIVERY_POOL_IDEA,
  DELIVERY_POOL_TASK,
  DELIVERY_POOLS,
  EXECUTED_VIA_NONE,
  EXECUTED_VIA_SET,
  EXECUTED_VIA_VALUES,
  FINAL_STATES,
  normalizeEvent,
  OUTCOME_LABEL_ACCEPTED,
  OUTCOME_LABEL_PRIORITY,
  OUTCOME_LABEL_REJECTED,
  OUTCOME_LABEL_REWORKED,
  OUTCOME_LABEL_SET,
  OUTCOME_LABEL_UNKNOWN,
  OUTCOME_LABELS,
  shanghaiDayStart,
  stableJson,
} from './triage-shared.mjs';

/** triage 的 SQLite 账本：事件队列、投递/结果、vault outbox、followup 与 source state。 */
export class TriageStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.closed = false;
    this.db = new DatabaseSync(path.resolve(file));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    // schema 演进统一走版本化迁移（user_version + 单事务），见 triage-migrations.mjs
    this.migration = migrateTriageDb(this.db);
  }

  enqueue(input) {
    const event = normalizeEvent(input);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO triage_events
        (id, source, summary, payload, category_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.source,
      event.summary,
      event.payload === null ? null : stableJson(event.payload),
      event.categoryHint,
      event.createdAt,
      Date.now(),
    );
    return { id: event.id, inserted: result.changes === 1 };
  }

  recoverStale(timeoutMs, now = Date.now()) {
    return this.db.prepare(`
      UPDATE triage_events
      SET status = 'queued', next_attempt_at = ?, updated_at = ?, error = 'recovered stale processing lease'
      WHERE status = 'processing' AND updated_at < ?
    `).run(now, now, now - timeoutMs).changes;
  }

  claim(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM triage_events
        WHERE status IN ('queued', 'retry') AND next_attempt_at <= ?
        ORDER BY created_at, id
        LIMIT 1
      `).get(now);
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`
        UPDATE triage_events
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      this.db.exec('COMMIT');
      return {
        ...row,
        status: 'processing',
        attempts: row.attempts + 1,
        payload: row.payload ? JSON.parse(row.payload) : null,
        triageResult: row.triage_result ? JSON.parse(row.triage_result) : null,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finish(id, status, fields = {}, now = Date.now()) {
    if (!FINAL_STATES.has(status)) throw new Error(`invalid final status: ${status}`);
    this.db.prepare(`
      UPDATE triage_events
      SET status = ?, updated_at = ?, triage_result = ?, recipient_id = ?,
          error = ?, cost_cny = ?, triage_latency_ms = ?
      WHERE id = ?
    `).run(
      status,
      now,
      fields.triageResult ? stableJson(fields.triageResult) : null,
      fields.recipientId ?? null,
      fields.error ? boundedText(fields.error, 2000) : null,
      Number(fields.costCny ?? 0),
      Number.isFinite(Number(fields.triageLatencyMs)) ? Math.max(0, Math.round(Number(fields.triageLatencyMs))) : null,
      id,
    );
  }

  retry(id, error, delayMs, fields = {}, now = Date.now()) {
    this.db.prepare(`
      UPDATE triage_events
      SET status = 'retry', next_attempt_at = ?, updated_at = ?, error = ?,
          triage_result = COALESCE(?, triage_result), cost_cny = ?,
          triage_latency_ms = COALESCE(?, triage_latency_ms)
      WHERE id = ?
    `).run(
      now + Math.max(1000, delayMs),
      now,
      boundedText(error, 2000),
      fields.triageResult ? stableJson(fields.triageResult) : null,
      Number(fields.costCny ?? 0),
      Number.isFinite(Number(fields.triageLatencyMs)) ? Math.max(0, Math.round(Number(fields.triageLatencyMs))) : null,
      id,
    );
  }

  completeIdea(id, {
    roomId,
    triageResult,
    costCny = 0,
    triageLatencyMs = null,
    vaultWrite = null,
  }, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO triage_deliveries (event_id, recipient_id, delivered_at, pool)
        SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM triage_deliveries WHERE event_id = ? AND pool = ?
        )
      `).run(id, roomId, now, DELIVERY_POOL_IDEA, id, DELIVERY_POOL_IDEA);
      if (vaultWrite) {
        this.db.prepare(`
          INSERT OR IGNORE INTO triage_vault_outbox
            (id, kind, event_id, dedupe_key, payload, created_at, updated_at)
          VALUES (?, 'idea-diary', ?, ?, ?, ?, ?)
        `).run(
          vaultWrite.id,
          id,
          vaultWrite.dedupeKey,
          stableJson(vaultWrite.payload),
          now,
          now,
        );
      }
      this.db.prepare(`
        UPDATE triage_events
        SET status = 'dispatched', updated_at = ?, triage_result = ?, recipient_id = ?,
            error = NULL, cost_cny = ?, triage_latency_ms = ?
        WHERE id = ?
      `).run(
        now,
        stableJson(triageResult),
        roomId,
        Number(costCny),
        Number.isFinite(Number(triageLatencyMs))
          ? Math.max(0, Math.round(Number(triageLatencyMs)))
          : null,
        id,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recoverStaleVaultWrites(timeoutMs, now = Date.now()) {
    return this.db.prepare(`
      UPDATE triage_vault_outbox
      SET status = 'retry', next_attempt_at = ?, updated_at = ?,
          error = 'recovered stale vault outbox lease'
      WHERE status = 'processing' AND updated_at < ?
    `).run(now, now, now - timeoutMs).changes;
  }

  claimVaultWrite(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM triage_vault_outbox
        WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
        ORDER BY created_at, id
        LIMIT 1
      `).get(now);
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`
        UPDATE triage_vault_outbox
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      this.db.exec('COMMIT');
      return {
        ...row,
        status: 'processing',
        attempts: Number(row.attempts) + 1,
        payload: JSON.parse(row.payload),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  retryVaultWrite(id, error, delayMs, now = Date.now()) {
    this.db.prepare(`
      UPDATE triage_vault_outbox
      SET status = 'retry', next_attempt_at = ?, updated_at = ?, error = ?
      WHERE id = ?
    `).run(
      now + Math.max(1000, Number(delayMs) || 0),
      now,
      boundedText(error, 2000),
      id,
    );
  }

  finishVaultWrite(id, now = Date.now()) {
    this.db.prepare(`
      UPDATE triage_vault_outbox
      SET status = 'done', updated_at = ?, completed_at = ?, error = NULL
      WHERE id = ?
    `).run(now, now, id);
  }

  /**
   * Coordination 投递收口：source_state、delivery/outcome、event 终态在同一事务落盘。
   * 远端投递成功后这些本地步骤若分开写，任一边界崩溃都会留下“消息已发但账本缺失”，
   * 而重试又因 source_state 命中而 noop。单事务保证 state 存在 ⇒ 账本齐全恒成立；
   * 崩溃发生在远端投递之后、settle 之前时，重试会带同一 idempotencyKey 重发，
   * 远端按 key 去重后返回同一 messageId，settle 再完整落一次。
   * delivery 以 (event_id, pool) 幂等，重复 settle 不重复计池。
   */
  settleCoordinationDispatch(eventIdValue, {
    recipientId,
    pool = DELIVERY_POOL_COORDINATION,
    messageId = null,
    executedVia = EXECUTED_VIA_NONE,
    taskPath = null,
    sourceStates = [],
    triageResult = null,
    finishRecipientId = null,
  }, now = Date.now()) {
    const normalizedPool = DELIVERY_POOLS.has(pool) ? pool : DELIVERY_POOL_TASK;
    const normalizedMessageId = Number.isInteger(Number(messageId)) ? Number(messageId) : null;
    const normalizedExecutedVia = EXECUTED_VIA_SET.has(executedVia) ? executedVia : EXECUTED_VIA_NONE;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const state of sourceStates) {
        this.db.prepare(`
          INSERT INTO triage_source_state (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(state.key, String(state.value), now);
      }
      const inserted = this.db.prepare(`
        INSERT INTO triage_deliveries
          (event_id, recipient_id, delivered_at, pool, message_id, executed_via)
        SELECT ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM triage_deliveries WHERE event_id = ? AND pool = ?
        )
      `).run(
        eventIdValue, recipientId, now, normalizedPool, normalizedMessageId, normalizedExecutedVia,
        eventIdValue, normalizedPool,
      );
      if (inserted.changes === 1 && normalizedMessageId !== null) {
        this.db.prepare(`
          INSERT INTO triage_outcomes (delivery_id, event_id, label, evidence, labeled_at)
          VALUES (?, ?, 'unknown', ?, ?)
        `).run(
          Number(inserted.lastInsertRowid),
          eventIdValue,
          stableJson({
            anchorMessageId: normalizedMessageId,
            cursorMessageId: normalizedMessageId,
            taskPath: taskPath ?? null,
          }),
          now,
        );
      }
      this.db.prepare(`
        UPDATE triage_events
        SET status = 'dispatched', updated_at = ?, triage_result = ?, recipient_id = ?, error = NULL
        WHERE id = ?
      `).run(
        now,
        triageResult ? stableJson(triageResult) : null,
        finishRecipientId ?? null,
        eventIdValue,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordDelivery(
    eventIdValue,
    recipientId,
    now = Date.now(),
    pool = DELIVERY_POOL_TASK,
    outcome = null,
  ) {
    const normalizedPool = DELIVERY_POOLS.has(pool) ? pool : DELIVERY_POOL_TASK;
    const messageId = Number.isInteger(Number(outcome?.messageId))
      ? Number(outcome.messageId)
      : null;
    const executedVia = EXECUTED_VIA_SET.has(outcome?.executedVia)
      ? outcome.executedVia
      : EXECUTED_VIA_NONE;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        INSERT INTO triage_deliveries
          (event_id, recipient_id, delivered_at, pool, message_id, executed_via)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(eventIdValue, recipientId, now, normalizedPool, messageId, executedVia);
      const deliveryId = Number(result.lastInsertRowid);
      if (messageId !== null) {
        this.db.prepare(`
          INSERT INTO triage_outcomes (delivery_id, event_id, label, evidence, labeled_at)
          VALUES (?, ?, 'unknown', ?, ?)
        `).run(
          deliveryId,
          eventIdValue,
          stableJson({
            anchorMessageId: messageId,
            cursorMessageId: messageId,
            taskPath: outcome?.taskPath ?? null,
          }),
          now,
        );
      }
      this.db.exec('COMMIT');
      return deliveryId;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordOutcome(deliveryId, label, evidence = {}, now = Date.now()) {
    if (!OUTCOME_LABEL_SET.has(label)) throw new Error(`invalid outcome label: ${label}`);
    const current = this.db.prepare(`
      SELECT label FROM triage_outcomes WHERE delivery_id = ?
    `).get(deliveryId);
    if (!current) throw new Error(`outcome delivery not found: ${deliveryId}`);
    const currentPriority = OUTCOME_LABEL_PRIORITY.get(current.label) ?? -1;
    const nextPriority = OUTCOME_LABEL_PRIORITY.get(label) ?? -1;
    if (nextPriority < currentPriority || (nextPriority === currentPriority && label !== current.label)) {
      return false;
    }
    this.db.prepare(`
      UPDATE triage_outcomes
      SET label = ?, evidence = ?, labeled_at = ?
      WHERE delivery_id = ?
    `).run(label, stableJson(evidence), now, deliveryId);
    return true;
  }

  outcomeCandidates({ since = 0, limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT
        o.delivery_id, o.event_id, o.label, o.evidence, o.labeled_at,
        d.recipient_id, d.delivered_at, d.message_id, d.pool, d.executed_via,
        e.triage_result
      FROM triage_outcomes o
      JOIN triage_deliveries d ON d.id = o.delivery_id
      JOIN triage_events e ON e.id = o.event_id
      WHERE d.message_id IS NOT NULL
        AND d.delivered_at >= ?
        AND o.label NOT IN ('reworked', 'rejected')
      ORDER BY d.delivered_at ASC, o.delivery_id ASC
      LIMIT ?
    `).all(Math.max(0, Number(since) || 0), Math.max(1, Number(limit) || 50));
    return rows.map((row) => ({
      ...row,
      delivery_id: Number(row.delivery_id),
      delivered_at: Number(row.delivered_at),
      message_id: Number(row.message_id),
      labeled_at: Number(row.labeled_at),
      evidence: JSON.parse(row.evidence || '{}'),
      triageResult: row.triage_result ? JSON.parse(row.triage_result) : null,
    }));
  }

  outcomeSummary() {
    const rows = this.db.prepare(`
      SELECT label, COUNT(*) AS count
      FROM triage_outcomes
      GROUP BY label
    `).all();
    const labels = Object.fromEntries(OUTCOME_LABELS.map((label) => [label, 0]));
    for (const row of rows) labels[row.label] = Number(row.count);
    const total = OUTCOME_LABELS.reduce((sum, label) => sum + labels[label], 0);
    const known = total - labels[OUTCOME_LABEL_UNKNOWN];
    const strong = labels[OUTCOME_LABEL_ACCEPTED]
      + labels[OUTCOME_LABEL_REWORKED]
      + labels[OUTCOME_LABEL_REJECTED];
    const last = this.db.prepare(`
      SELECT MAX(labeled_at) AS labeled_at
      FROM triage_outcomes
      WHERE label != 'unknown'
    `).get();
    const byViaRows = this.db.prepare(`
      SELECT
        COALESCE(d.executed_via, 'none') AS executed_via,
        o.label,
        COUNT(*) AS count
      FROM triage_outcomes o
      JOIN triage_deliveries d ON d.id = o.delivery_id
      GROUP BY COALESCE(d.executed_via, 'none'), o.label
    `).all();
    const byExecutedVia = Object.fromEntries(EXECUTED_VIA_VALUES.map((executedVia) => {
      const viaLabels = Object.fromEntries(OUTCOME_LABELS.map((label) => [label, 0]));
      for (const row of byViaRows) {
        if (row.executed_via === executedVia) viaLabels[row.label] = Number(row.count);
      }
      const viaTotal = OUTCOME_LABELS.reduce((sum, label) => sum + viaLabels[label], 0);
      return [executedVia, {
        total: viaTotal,
        labels: viaLabels,
        acceptedRatio: viaTotal ? viaLabels[OUTCOME_LABEL_ACCEPTED] / viaTotal : 0,
        reworkedRatio: viaTotal ? viaLabels[OUTCOME_LABEL_REWORKED] / viaTotal : 0,
      }];
    }));
    return {
      total,
      labels,
      knownCount: known,
      knownRatio: total ? known / total : 0,
      strongCount: strong,
      strongRatio: total ? strong / total : 0,
      unknownRatio: total ? labels[OUTCOME_LABEL_UNKNOWN] / total : 0,
      byExecutedVia,
      lastLabeledAt: last.labeled_at === null
        ? null
        : new Date(Number(last.labeled_at)).toISOString(),
    };
  }

  // Task dispatches use a rolling 24h window and only count the task pool, so
  // proactive daily outreach does not burn per-recipient work quotas.
  recipientUsage(recipientId, now = Date.now(), pool = DELIVERY_POOL_TASK) {
    const since = now - 24 * 60 * 60_000;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(delivered_at) AS last_at
      FROM triage_deliveries
      WHERE recipient_id = ? AND delivered_at >= ? AND COALESCE(pool, 'task') = ?
    `).get(recipientId, since, pool);
    return { count: Number(row.count), lastAt: row.last_at === null ? null : Number(row.last_at) };
  }

  // Daily proactive cap is a Shanghai calendar-day total across all recipients.
  poolUsage(pool = DELIVERY_POOL_DAILY, now = Date.now()) {
    const start = shanghaiDayStart(now);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(delivered_at) AS last_at
      FROM triage_deliveries
      WHERE delivered_at >= ? AND COALESCE(pool, 'task') = ?
    `).get(start, pool);
    return {
      count: Number(row.count),
      lastAt: row.last_at === null ? null : Number(row.last_at),
      since: start,
    };
  }

  dailySummary(now = Date.now()) {
    // Business-day metrics are pinned to Asia/Shanghai, independent of host timezone.
    const start = shanghaiDayStart(now);
    const statuses = this.db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(cost_cny), 0) AS cost
      FROM triage_events WHERE created_at >= ? GROUP BY status
    `).all(start);
    const fallback = this.db.prepare(`
      SELECT COUNT(*) AS count FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"fallbackUsed":true%'
    `).get(start);
    const deliveries = this.db.prepare(`
      SELECT recipient_id, COUNT(*) AS count
      FROM triage_deliveries WHERE delivered_at >= ?
      GROUP BY recipient_id ORDER BY count DESC
    `).all(start);
    const poolRows = this.db.prepare(`
      SELECT COALESCE(pool, 'task') AS pool, COUNT(*) AS count
      FROM triage_deliveries WHERE delivered_at >= ?
      GROUP BY COALESCE(pool, 'task')
    `).all(start);
    const coordinationKinds = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN json_extract(events.payload, '$.mode') = 'coordination'
          THEN 1 ELSE 0 END), 0) AS execution_count,
        COALESCE(SUM(CASE WHEN json_extract(events.payload, '$.mode') = 'coordination-verification'
          THEN 1 ELSE 0 END), 0) AS verification_count,
        COALESCE(SUM(CASE WHEN json_extract(events.payload, '$.mode') = 'task-reminder'
          THEN 1 ELSE 0 END), 0) AS reminder_count
      FROM triage_deliveries AS deliveries
      JOIN triage_events AS events ON events.id = deliveries.event_id
      WHERE deliveries.delivered_at >= ?
        AND COALESCE(deliveries.pool, 'task') = ?
    `).get(start, DELIVERY_POOL_COORDINATION);
    const latency = this.db.prepare(`
      SELECT COUNT(*) AS count, AVG(triage_latency_ms) AS average
      FROM triage_events
      WHERE created_at >= ? AND triage_latency_ms IS NOT NULL
    `).get(start);
    const dailyChecks = this.db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'noop' THEN 1 ELSE 0 END) AS noop_count
      FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"category":"daily"%'
    `).get(start);
    const ideaChecks = this.db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'noop' THEN 1 ELSE 0 END) AS noop_count
      FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"category":"idea"%'
    `).get(start);
    const diaryChecks = this.db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'noop' THEN 1 ELSE 0 END) AS noop_count,
             COALESCE(SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END), 0) AS written_count
      FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"category":"diary"%'
    `).get(start);
    const ideaDiaryOutbox = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending', 'processing', 'retry') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) AS written
      FROM triage_vault_outbox
      WHERE kind = 'idea-diary'
    `).get(start);
    const ideaDiaryLastError = this.db.prepare(`
      SELECT error FROM triage_vault_outbox
      WHERE kind = 'idea-diary' AND error IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get()?.error ?? null;
    const total = statuses.reduce((sum, row) => sum + Number(row.count), 0);
    const noop = statuses.find((row) => row.status === 'noop');
    const pools = Object.fromEntries(poolRows.map((row) => [row.pool, Number(row.count)]));
    const dailyUsage = this.poolUsage(DELIVERY_POOL_DAILY, now);
    const ideaUsage = this.poolUsage(DELIVERY_POOL_IDEA, now);
    const diaryUsage = this.poolUsage(DELIVERY_POOL_DIARY, now);
    return {
      since: new Date(start).toISOString(),
      total,
      noopRatio: total ? Number(noop?.count ?? 0) / total : 0,
      fallbackCount: Number(fallback.count),
      costCny: statuses.reduce((sum, row) => sum + Number(row.cost), 0),
      triagedCount: Number(latency.count),
      avgTriageLatencyMs: latency.average === null ? null : Math.round(Number(latency.average)),
      statuses,
      deliveries,
      pools,
      dailyPoolDispatched: pools[DELIVERY_POOL_DAILY] ?? 0,
      ideaPoolDispatched: pools[DELIVERY_POOL_IDEA] ?? 0,
      coordinationPoolDispatched: pools[DELIVERY_POOL_COORDINATION] ?? 0,
      coordinationExecutionDispatched: Number(coordinationKinds.execution_count),
      coordinationVerificationDispatched: Number(coordinationKinds.verification_count),
      coordinationReminderDispatched: Number(coordinationKinds.reminder_count),
      diaryPoolDispatched: pools[DELIVERY_POOL_DIARY] ?? 0,
      dailyChecks: Number(dailyChecks.count),
      dailyNoops: Number(dailyChecks.noop_count ?? 0),
      ideaChecks: Number(ideaChecks.count),
      ideaNoops: Number(ideaChecks.noop_count ?? 0),
      diaryChecks: Number(diaryChecks.count),
      diaryNoops: Number(diaryChecks.noop_count ?? 0),
      diaryRollups: Number(diaryChecks.written_count ?? 0),
      ideaDiaryPending: Number(ideaDiaryOutbox.pending ?? 0),
      ideaDiaryRetrying: Number(ideaDiaryOutbox.retrying ?? 0),
      ideaDiariesWritten: Number(ideaDiaryOutbox.written ?? 0),
      ideaDiaryLastError,
      outcomes: this.outcomeSummary(),
      lastDailyDeliveryAt: dailyUsage.lastAt === null
        ? null
        : new Date(dailyUsage.lastAt).toISOString(),
      lastIdeaDeliveryAt: ideaUsage.lastAt === null
        ? null
        : new Date(ideaUsage.lastAt).toISOString(),
      lastDiaryRollupAt: diaryUsage.lastAt === null
        ? null
        : new Date(diaryUsage.lastAt).toISOString(),
    };
  }

  recentIdeaTopics(limit = 12) {
    const rows = this.db.prepare(`
      SELECT triage_result FROM triage_events
      WHERE status = 'dispatched' AND triage_result LIKE '%"category":"idea"%'
      ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Number(limit) || 12));
    return rows.flatMap((row) => {
      try {
        const value = JSON.parse(row.triage_result);
        if (!value?.topic || !value?.ideaCategory) return [];
        return [{
          topic: String(value.topic).slice(0, 500),
          category: String(value.ideaCategory).slice(0, 100),
        }];
      } catch {
        return [];
      }
    });
  }

  getSourceState(key) {
    return this.db.prepare('SELECT value FROM triage_source_state WHERE key = ?').get(key)?.value ?? null;
  }

  setSourceState(key, value, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO triage_source_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), now);
  }

  insertFollowup({
    id,
    contactId,
    messageId,
    activity,
    returnCommitment = null,
    expectedMinutes,
    dueAt,
    recipientKey = null,
    now = Date.now(),
  }) {
    try {
      this.db.prepare(`
        INSERT INTO triage_followups (
          id, contact_id, message_id, activity, return_commitment, expected_minutes, due_at,
          status, recipient_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        id,
        String(contactId),
        Number(messageId),
        String(activity).slice(0, 80),
        returnCommitment ? String(returnCommitment).slice(0, 120) : null,
        Math.max(1, Number(expectedMinutes) || 30),
        Number(dueAt),
        recipientKey ? String(recipientKey) : null,
        now,
        now,
      );
      return true;
    } catch (error) {
      // UNIQUE(contact_id, message_id) — already tracked.
      if (String(error.message ?? '').includes('UNIQUE')) return false;
      throw error;
    }
  }

  pendingFollowups({ contactId = null, limit = 50 } = {}) {
    if (contactId) {
      return this.db.prepare(`
        SELECT * FROM triage_followups
        WHERE status = 'pending' AND contact_id = ?
        ORDER BY due_at ASC, created_at ASC
        LIMIT ?
      `).all(String(contactId), Math.max(1, Number(limit) || 50));
    }
    return this.db.prepare(`
      SELECT * FROM triage_followups
      WHERE status = 'pending'
      ORDER BY due_at ASC, created_at ASC
      LIMIT ?
    `).all(Math.max(1, Number(limit) || 50));
  }

  expiredFollowupsForFallback({ since = 0, limit = 10 } = {}) {
    return this.db.prepare(`
      SELECT * FROM triage_followups
      WHERE status = 'expired'
        AND fallback_reminded_at IS NULL
        AND updated_at >= ?
      ORDER BY updated_at ASC, created_at ASC
      LIMIT ?
    `).all(Number(since) || 0, Math.max(1, Number(limit) || 10));
  }

  markFollowupsFallbackReminded(ids, now = Date.now()) {
    const values = [...new Set(
      (Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean),
    )];
    if (!values.length) return 0;
    const placeholders = values.map(() => '?').join(', ');
    return this.db.prepare(`
      UPDATE triage_followups
      SET fallback_reminded_at = ?, updated_at = ?
      WHERE status = 'expired'
        AND fallback_reminded_at IS NULL
        AND id IN (${placeholders})
    `).run(now, now, ...values).changes;
  }

  getFollowup(id) {
    return this.db.prepare('SELECT * FROM triage_followups WHERE id = ?').get(String(id)) ?? null;
  }

  hasOpenFollowupForContact(contactId) {
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM triage_followups
      WHERE contact_id = ? AND status IN ('pending', 'queued')
      LIMIT 1
    `).get(String(contactId));
    return Boolean(row);
  }

  updateFollowupStatus(id, status, {
    cancelReason = null,
    eventId = null,
    now = Date.now(),
  } = {}) {
    const allowed = new Set(['pending', 'queued', 'dispatched', 'cancelled', 'expired']);
    if (!allowed.has(status)) throw new Error(`invalid followup status: ${status}`);
    return this.db.prepare(`
      UPDATE triage_followups
      SET status = ?, cancel_reason = COALESCE(?, cancel_reason),
          event_id = COALESCE(?, event_id), updated_at = ?
      WHERE id = ? AND status IN ('pending', 'queued')
    `).run(
      status,
      cancelReason,
      eventId,
      now,
      String(id),
    ).changes;
  }

  hasDailyDeliverySince(recipientId, since, now = Date.now()) {
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM triage_deliveries
      WHERE recipient_id = ? AND pool = ? AND delivered_at > ? AND delivered_at <= ?
      LIMIT 1
    `).get(String(recipientId), DELIVERY_POOL_DAILY, Number(since), Number(now));
    return Boolean(row);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
