import {
  buildDispatchableTaskContext,
  classifyOutcomeMessage,
  isTaskCompletionMessage,
  linkedReworkTail,
  OUTCOME_LABEL_ACCEPTED,
  OUTCOME_LABEL_ENGAGED,
  OUTCOME_LABEL_REJECTED,
  OUTCOME_LABEL_REWORKED,
} from './triage-core.mjs';
import { log } from './worker-shared.mjs';

/** TriageWorker 的 outcome 采集 domain：给已派发事件回填 engaged/accepted/reworked/rejected。 */
export const outcomeMethods = {
  async collectOutcomesIfDue(now = Date.now()) {
    const config = this.config.outcomes;
    if (!config?.enabled || now < this.nextOutcomePollAt) return false;
    this.nextOutcomePollAt = now + config.intervalMinutes * 60_000;
    const candidates = this.store.outcomeCandidates({
      since: now - config.maxAgeDays * 24 * 60 * 60_000,
      limit: config.batchSize,
    });
    if (!candidates.length) return false;

    const taskCandidates = candidates.filter((candidate) => candidate.triageResult?.taskPath);
    let openTaskPaths = null;
    let tailBodies = [];
    if (taskCandidates.length && this.vault.enabled) {
      try {
        const raw = await this.vault.taskContext();
        const snapshot = buildDispatchableTaskContext(raw, { maxChars: 500, maxItems: 1 });
        openTaskPaths = new Set(snapshot.allTaskPaths);
        const tailPaths = snapshot.allTaskPaths.filter(
          (taskPath) => /^tasks\/(?:worker-tail-|deploy-)/i.test(taskPath),
        );
        const results = await Promise.allSettled(tailPaths.map(async (taskPath) => ({
          taskPath,
          content: await this.vault.readFile(taskPath),
        })));
        tailBodies = results
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value);
      } catch (error) {
        log('warn', 'outcome task evidence unavailable', { error: error.message });
      }
    }

    for (const candidate of candidates) {
      try {
        const priorEvidence = candidate.evidence && typeof candidate.evidence === 'object'
          ? candidate.evidence
          : {};
        const cursor = Number(priorEvidence.cursorMessageId ?? candidate.message_id);
        const messages = await this.hub.messages(candidate.recipient_id, cursor, 200, 'all');
        const classified = messages
          .map((message) => ({ message, label: classifyOutcomeMessage(message) }))
          .filter((item) => item.label);
        const reply = classified.find((item) => item.label === OUTCOME_LABEL_REJECTED)
          ?? classified[0]
          ?? null;
        const taskPath = candidate.triageResult?.taskPath;
        const completion = taskPath
          ? messages.find((message) => isTaskCompletionMessage(message, taskPath)) ?? null
          : null;
        const nextCursor = messages.reduce(
          (max, message) => Math.max(max, Number(message.id) || 0),
          cursor,
        );
        const messageEvidence = {
          ...priorEvidence,
          cursorMessageId: nextCursor,
          ...(reply ? {
            replyMessageId: Number(reply.message.id),
            replyCreatedAt: reply.message.created_at ?? null,
            replyRule: reply.label === OUTCOME_LABEL_REJECTED
              ? 'explicit-rejection'
              : 'manual-user-reply',
          } : {}),
        };
        if (reply) {
          const replyLabel = reply.label === OUTCOME_LABEL_REJECTED
            ? OUTCOME_LABEL_REJECTED
            : OUTCOME_LABEL_ENGAGED;
          this.store.recordOutcome(
            candidate.delivery_id,
            replyLabel,
            messageEvidence,
            now,
          );
          if (replyLabel === OUTCOME_LABEL_REJECTED) {
            this.releaseBacklogClaim(taskPath, candidate.event_id);
          }
        } else if (nextCursor !== cursor) {
          this.store.recordOutcome(candidate.delivery_id, candidate.label, messageEvidence, now);
        }

        if (!taskPath || !openTaskPaths) continue;
        const tail = linkedReworkTail(taskPath, candidate.event_id, tailBodies);
        if (tail) {
          this.store.recordOutcome(candidate.delivery_id, OUTCOME_LABEL_REWORKED, {
            ...messageEvidence,
            taskPath,
            tailPath: tail.taskPath,
            taskRule: 'linked-tail',
          }, now);
          this.releaseBacklogClaim(taskPath, candidate.event_id);
        } else if (!openTaskPaths.has(taskPath) && completion) {
          this.store.recordOutcome(candidate.delivery_id, OUTCOME_LABEL_ACCEPTED, {
            ...messageEvidence,
            taskPath,
            completionMessageId: Number(completion.id),
            taskRule: 'done-tool-result-and-left-open-context',
          }, now);
        }
      } catch (error) {
        log('warn', 'outcome collection failed', {
          eventId: candidate.event_id,
          deliveryId: candidate.delivery_id,
          error: error.message,
        });
      }
    }
    return true;
  },
};
