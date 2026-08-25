import {
  buildIdeaDiaryRequest,
  DELIVERY_POOL_DIARY,
  DELIVERY_POOL_IDEA,
  ideaPolicyState,
  isDiaryMode,
  isIdeaMode,
  isShanghaiSilentHour,
  normalizeDiaryConfig,
  normalizeIdeaConfig,
} from './triage-core.mjs';
import { rollupDay } from './diary-rollup.mjs';
import { hash, log } from './worker-shared.mjs';

/** TriageWorker 的 idea 房与日记 rollup domain。 */
export const ideaDiaryMethods = {
  isIdeaEvent(event) {
    return isIdeaMode(event);
  },

  isDiaryEvent(event) {
    return isDiaryMode(event);
  },

  diaryConfig() {
    return this.config.diary ?? normalizeDiaryConfig({});
  },

  ideaConfig() {
    return this.config.idea ?? normalizeIdeaConfig({});
  },

  ideaPolicy(now = Date.now()) {
    return ideaPolicyState(
      this.ideaConfig(),
      this.store.poolUsage(DELIVERY_POOL_IDEA, now),
    );
  },

  /**
   * 日终日记 rollup。跟 daily/idea 的区别：不派给任何联系人，也不消耗它们的池——
   * 终点是 vault 的 diary 流水，唯一的额度约束是「一个上海日只结算一次」。
   */
  async processDiary(event) {
    const config = this.diaryConfig();
    const date = typeof event.payload?.date === 'string' ? event.payload.date : null;
    const finishNoop = (rationale, extra = {}) => {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          category: 'diary',
          priority: 1,
          suggestedRecipient: null,
          rationale,
        },
        costCny: Number(extra.costCny ?? 0),
        triageLatencyMs: Number(extra.latencyMs ?? 0),
      });
      log('info', 'diary rollup skipped', { eventId: event.id, date, rationale });
    };

    if (!config.enabled) return finishNoop('diary rollup is disabled');
    if (!date) throw new Error('diary event is missing payload.date');
    if (!this.vault.enabled) throw new Error('diary rollup requires a configured memory vault');

    const stateKey = `diary-rollup:${date}`;
    if (this.store.getSourceState(stateKey)) {
      return finishNoop(`diary for ${date} was already settled`);
    }

    const result = await rollupDay({
      date,
      hub: this.hub,
      deepseek: this.deepseek,
      vault: this.vault,
      config,
      log,
    });

    // thin/empty 也要落状态：安静的一天就是没内容，重试只会重复烧钱。
    this.store.setSourceState(stateKey, `${result.status}:${new Date().toISOString()}`);
    if (result.status !== 'written') {
      return finishNoop(`${result.status}: ${result.reason}`, result);
    }

    this.store.recordDelivery(event.id, 'memory-vault', Date.now(), DELIVERY_POOL_DIARY);
    this.store.finish(event.id, 'dispatched', {
      triageResult: {
        actionable: true,
        category: 'diary',
        priority: 1,
        suggestedRecipient: null,
        rationale: `wrote ${result.written} diary entries for ${date}`,
        date,
        entryCount: result.written,
      },
      recipientId: 'memory-vault',
      costCny: result.costCny,
      triageLatencyMs: result.latencyMs,
    });
    log('info', 'diary rollup written', {
      eventId: event.id,
      date,
      entries: result.written,
      truncated: result.truncated === true,
      dropped: result.dropped,
      pool: DELIVERY_POOL_DIARY,
      costCny: result.costCny,
      triageLatencyMs: result.latencyMs,
    });
  },

  async processIdea(event) {
    let costCny = Number(event.cost_cny ?? 0);
    let triageLatencyMs = event.triage_latency_ms === null
      ? 0
      : Number(event.triage_latency_ms);
    let result = event.triageResult?.category === 'idea' ? event.triageResult : null;
    const idea = this.ideaConfig();
    const stateError = (error) => {
      error.ideaState = { costCny, triageLatencyMs, triageResult: result };
      return error;
    };

    try {
      const now = Date.now();
      if (isShanghaiSilentHour(
        now,
        this.proactiveConfig().silentStartHour,
        this.proactiveConfig().silentEndHour,
      )) {
        result = {
          actionable: false,
          category: 'idea',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'Shanghai quiet hours',
        };
        this.store.finish(event.id, 'noop', { triageResult: result, costCny, triageLatencyMs });
        log('info', 'idea event suppressed by silent hours', { eventId: event.id });
        return;
      }
      if (this.ideaPolicy(now).poolFull) {
        result = {
          actionable: false,
          category: 'idea',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'idea pool disabled, unconfigured, or exhausted for Shanghai day',
        };
        this.store.finish(event.id, 'noop', { triageResult: result, costCny, triageLatencyMs });
        log('info', 'idea event suppressed by pool policy', { eventId: event.id });
        return;
      }

      const contacts = await this.hub.contacts();
      const room = contacts.find((contact) =>
        contact.id === idea.roomId && contact.kind === 'room'
      );
      if (!room) throw new Error(`idea room is unavailable: ${idea.roomId}`);
      const memberIds = Array.isArray(room.config?.members) ? room.config.members : [];
      const memberSet = new Set(memberIds);
      const members = contacts.filter((contact) =>
        contact.kind === 'dm' && memberSet.has(contact.id)
      );
      if (members.length < 2) throw new Error('idea room needs at least two enabled members');

      if (!result?.topic) {
        const recentTopics = this.store.recentIdeaTopics(idea.recentTopicLimit);
        const recentCategories = new Set(
          recentTopics.slice(0, 2).map((item) => item.category.trim().toLowerCase())
        );
        const recentTopicKeys = new Set(
          recentTopics.map((item) => hash(item.topic.replace(/\s+/g, '').toLowerCase()))
        );
        let generated = null;
        let rejection = 'no valid topic generated';
        for (let attempt = 1; attempt <= idea.maxTopicAttempts; attempt++) {
          const response = await this.deepseek.ideaTopic({ room, members, recentTopics });
          costCny += response.costCny;
          triageLatencyMs += response.latencyMs;
          const candidate = response.result;
          const targetsValid = candidate.targetIds.length === 1 && candidate.targetIds[0] === 'all'
            || candidate.targetIds.every((targetId) => memberSet.has(targetId));
          const topicKey = hash(candidate.topic.replace(/\s+/g, '').toLowerCase());
          if (!targetsValid) {
            rejection = 'topic selected invalid room targets';
            continue;
          }
          if (recentCategories.has(candidate.category)) {
            rejection = `topic category repeats one of the previous two: ${candidate.category}`;
            continue;
          }
          if (recentTopicKeys.has(topicKey)) {
            rejection = 'topic repeats a recent prompt';
            continue;
          }
          generated = candidate;
          break;
        }
        if (!generated) throw new Error(rejection);
        result = {
          actionable: true,
          category: 'idea',
          priority: 1,
          suggestedRecipient: room.id,
          rationale: generated.rationale,
          ideaCategory: generated.category,
          topic: generated.topic,
          targetIds: generated.targetIds,
          stage: 'topic-generated',
        };
      }

      if (!result.roundId) {
        const mention = result.targetIds.includes('all')
          ? '@all'
          : result.targetIds.map((targetId) => {
            const member = members.find((candidate) => candidate.id === targetId);
            return `@${member?.name ?? targetId}`;
          }).join(' ');
        const opened = await this.hub.dispatchRoomHost(room.id, {
          content: `${mention} ${result.topic}`,
          hostName: idea.hostName,
          targetIds: result.targetIds,
          reactionRounds: idea.reactionRounds,
          idempotencyKey: `idea:${event.id}:topic:${event.attempts}`,
        });
        result = {
          ...result,
          stage: 'round-dispatched',
          roundId: opened.roundId,
          topicMessageId: opened.messageId,
        };
      }

      let round;
      try {
        round = await this.hub.waitRoomRound(room.id, result.roundId, {
          pollMs: idea.roundPollMs,
          timeoutMs: idea.roundTimeoutMs,
        });
      } catch (error) {
        if (String(error.message).startsWith('room round failed:')) {
          result = {
            ...result,
            stage: 'topic-generated',
            roundId: undefined,
            topicMessageId: undefined,
          };
        }
        throw error;
      }
      const rows = await this.hub.messages(room.id, result.topicMessageId, 200);
      const names = new Map(contacts.map((contact) => [contact.id, contact.name]));
      const participantNames = [...new Set(
        rows
          .filter((row) => row.kind === 'text' && row.status === 'done' && row.sender !== 'room-host')
          .map((row) => names.get(row.sender) ?? row.sender),
      )];
      const transcript = rows
        .filter((row) => row.kind === 'text' && row.status === 'done' && row.sender !== 'room-host')
        .map((row) => `${names.get(row.sender) ?? row.sender}: ${row.content}`)
        .join('\n')
        .slice(0, 30_000);
      if (!transcript) throw new Error('idea room round finished without a visible transcript');

      if (!result.summary) {
        const summarized = await this.deepseek.ideaSummary({ topic: result.topic, transcript });
        costCny += summarized.costCny;
        triageLatencyMs += summarized.latencyMs;
        result = {
          ...result,
          stage: 'summarized',
          summary: summarized.result.summary,
          outcome: round.outcome,
        };
      }

      const closed = await this.hub.dispatchRoomHost(room.id, {
        content: result.summary,
        hostName: idea.hostName,
        trigger: false,
        idempotencyKey: `idea:${event.id}:summary`,
      });
      result = {
        ...result,
        stage: 'completed',
        summaryMessageId: closed.messageId,
      };
      const completedAt = Date.now();
      const diaryRequest = idea.writeDiary
        ? buildIdeaDiaryRequest({
          eventId: event.id,
          room,
          topic: result.topic,
          topicCategory: result.ideaCategory,
          targetNames: result.targetIds.includes('all')
            ? members.map((member) => member.name)
            : result.targetIds.map((targetId) => names.get(targetId) ?? targetId),
          participantNames,
          outcome: result.outcome,
          roundId: result.roundId,
          topicMessageId: result.topicMessageId,
          summaryMessageId: result.summaryMessageId,
          summary: result.summary,
          completedAt,
        })
        : null;
      const dedupeKey = `idea:${event.id}:summary:${result.summaryMessageId}`;
      this.store.completeIdea(event.id, {
        roomId: room.id,
        triageResult: result,
        costCny,
        triageLatencyMs,
        vaultWrite: diaryRequest ? {
          id: `idea-diary:${hash(dedupeKey)}`,
          dedupeKey,
          payload: diaryRequest,
        } : null,
      }, completedAt);
      log('info', 'idea discussion completed', {
        eventId: event.id,
        roomId: room.id,
        topicCategory: result.ideaCategory,
        topicMessageId: result.topicMessageId,
        summaryMessageId: result.summaryMessageId,
        outcome: result.outcome,
        diaryQueued: Boolean(diaryRequest),
        pool: DELIVERY_POOL_IDEA,
        costCny,
        triageLatencyMs,
      });
    } catch (error) {
      throw stateError(error);
    }
  },
};
