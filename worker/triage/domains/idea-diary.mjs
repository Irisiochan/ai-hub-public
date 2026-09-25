import {
  DELIVERY_POOL_DIARY,
  isDiaryMode,
  isWorkflowOnlyConfig,
  normalizeDiaryConfig,
} from '../triage-core.mjs';
import { rollupDay } from '../diary-rollup.mjs';
import { log } from '../domain-shared.mjs';

/** TriageWorker 的日记 rollup domain。 */
export const ideaDiaryMethods = {
  isDiaryEvent(event) {
    return isDiaryMode(event);
  },

  diaryConfig() {
    return this.config.diary ?? normalizeDiaryConfig({});
  },

  /**
   * 日终日记 rollup。跟 daily/idea 的区别：不派给任何联系人，也不消耗它们的池——
   * 终点是 vault 的 diary 流水，唯一的额度约束是「一个上海日只结算一次」。
   */
  async processDiary(event) {
    // Workflow-only: diary rollup calls DS extract + vault writes. Forced off;
    // ledger preserved as noop (pipeline already guards, this is defense).
    if (isWorkflowOnlyConfig(this.config)) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          category: 'diary',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'workflow-only: diary rollup suppressed (no DS, no vault write)',
        },
        costCny: Number(event.cost_cny ?? 0),
        triageLatencyMs: event.triage_latency_ms === null ? null : Number(event.triage_latency_ms),
      });
      log('info', 'diary rollup skipped', { eventId: event.id, date: event.payload?.date, rationale: 'workflow-only' });
      return;
    }
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

};
