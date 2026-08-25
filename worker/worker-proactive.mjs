import {
  dailyPolicyState,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_TASK,
  isDailyMode,
  messageTimestampMs,
  normalizeProactiveConfig,
  shanghaiClock,
  summarizeTaskContext,
} from './triage-core.mjs';
import {
  claimDateEventKey,
  filterUnclaimedDateEvents,
  matchDateEvents,
  parseDateFacts,
} from './date-events.mjs';
import { irisPresenceFromMessages } from './followups.mjs';
import {
  DATE_EVENT_CLAIMS_KEY,
  log,
  SAFETY_EVENT_CLAIMS_KEY,
} from './worker-shared.mjs';

/**
 * TriageWorker 的 daily 主动陪伴 domain：proactive 配置/池策略、
 * 日期事件与 safety 事件的 claim 去重、User 在场探测与派发路由选项。
 */
export const proactiveMethods = {
  proactiveConfig() {
    return this.config.proactive ?? normalizeProactiveConfig({});
  },

  isDailyEvent(event) {
    // Delivery pools are a trusted event-source property. Never let L1 move a
    // normal task into the daily pool by returning category=daily.
    return isDailyMode(event);
  },

  dailyPolicy(now = Date.now(), options = {}) {
    return dailyPolicyState(
      this.proactiveConfig(),
      this.store.poolUsage(DELIVERY_POOL_DAILY, now),
      now,
      options,
    );
  },

  dateEventClaims() {
    try {
      const parsed = JSON.parse(this.store.getSourceState(DATE_EVENT_CLAIMS_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  },

  saveDateEventClaims(claims) {
    this.store.setSourceState(DATE_EVENT_CLAIMS_KEY, JSON.stringify(claims));
  },

  claimDateEvents(events, { eventId = null, now = Date.now() } = {}) {
    const shanghaiDate = shanghaiClock(now).date;
    const claims = this.dateEventClaims();
    let changed = false;
    for (const event of Array.isArray(events) ? events : []) {
      if (!event?.key) continue;
      const key = claimDateEventKey(event.key, shanghaiDate);
      if (claims[key]) continue;
      claims[key] = { claimedAt: now, eventId, matchDate: shanghaiDate, label: event.label ?? null };
      changed = true;
    }
    // Drop claims older than 40 days to keep the map small (yearly events only need one day).
    const cutoff = now - 40 * 24 * 60 * 60_000;
    for (const [key, value] of Object.entries(claims)) {
      if (!value || typeof value.claimedAt !== 'number' || value.claimedAt < cutoff) {
        delete claims[key];
        changed = true;
      }
    }
    if (changed) this.saveDateEventClaims(claims);
    return claims;
  },

  async loadMatchedDateEvents(now = Date.now()) {
    const empty = { today: [], upcoming: [], unclaimedToday: [] };
    if (!this.vault.enabled) return empty;
    try {
      const text = await this.vault.facts();
      const matched = matchDateEvents(parseDateFacts(text), now, { upcomingDays: 3 });
      const shanghaiDate = shanghaiClock(now).date;
      const unclaimedToday = filterUnclaimedDateEvents(
        matched.today,
        this.dateEventClaims(),
        shanghaiDate,
      );
      return {
        today: matched.today,
        upcoming: matched.upcoming,
        unclaimedToday,
      };
    } catch (error) {
      log('warn', 'date-event facts unavailable', { error: error.message });
      return empty;
    }
  },

  safetyEventClaims() {
    try {
      const parsed = JSON.parse(this.store.getSourceState(SAFETY_EVENT_CLAIMS_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  },

  saveSafetyEventClaims(claims) {
    this.store.setSourceState(SAFETY_EVENT_CLAIMS_KEY, JSON.stringify(claims));
  },

  claimSafetyEvents(events, { eventId = null, now = Date.now() } = {}) {
    const shanghaiDate = shanghaiClock(now).date;
    const claims = this.safetyEventClaims();
    let changed = false;
    for (const event of Array.isArray(events) ? events : []) {
      if (!event?.id || !event?.updatedAt) continue;
      const key = `${event.id}:${event.updatedAt}`;
      if (claims[key]) continue;
      claims[key] = { claimedAt: now, eventId, lifeEventId: event.id, matchDate: shanghaiDate };
      changed = true;
    }
    // life_events TTL 最长 48h；claim 留 7 天已绰绰有余。
    const cutoff = now - 7 * 24 * 60 * 60_000;
    for (const [key, value] of Object.entries(claims)) {
      if (!value || typeof value.claimedAt !== 'number' || value.claimedAt < cutoff) {
        delete claims[key];
        changed = true;
      }
    }
    if (changed) this.saveSafetyEventClaims(claims);
    return claims;
  },

  /**
   * P3 S4：网关侧 active safety 事件里，扣掉已 claim 状态与当日上限后仍可派单的。
   * claim key 含 updated_at：同一事件升级（新 update）可再派一次，同一状态不重复。
   */
  async loadUnclaimedSafetyEvents(now = Date.now()) {
    const config = this.proactiveConfig().safetyEvents;
    if (!config.enabled) return [];
    const events = await this.hub.lifeEvents();
    if (!events.length) return [];
    const claims = this.safetyEventClaims();
    const shanghaiDate = shanghaiClock(now).date;
    const freshMs = config.freshnessHours * 60 * 60_000;
    return events.filter((event) => {
      if (event?.severity !== 'safety' || event?.status !== 'active') return false;
      const updatedMs = Date.parse(String(event.updatedAt ?? ''));
      if (!Number.isFinite(updatedMs) || now - updatedMs > freshMs) return false;
      if (claims[`${event.id}:${event.updatedAt}`]) return false;
      const todayDispatches = Object.values(claims).filter((claim) => claim
        && claim.lifeEventId === event.id
        && claim.matchDate === shanghaiDate).length;
      return todayDispatches < config.maxPerEventPerDay;
    });
  },

  /**
   * $0 presence probe: User herself spoke in any DM within presenceIdleMinutes.
   * AI output never counts. Fail-open to inactive on any incomplete evidence.
   */
  async detectIrisPresence(now = Date.now()) {
    const idleMinutes = Number(this.proactiveConfig().presenceIdleMinutes);
    if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
      return { active: false, reason: 'disabled', lastUserMessageAt: null, contactId: null };
    }
    if (!this.hub?.baseUrl) {
      return { active: false, reason: 'hub-unavailable', lastUserMessageAt: null, contactId: null };
    }
    let contacts;
    try {
      contacts = await this.hub.contacts();
    } catch (error) {
      log('warn', 'User presence contact list unavailable', { error: error.message });
      return { active: false, reason: 'hub-error', lastUserMessageAt: null, contactId: null };
    }
    const thresholdMs = idleMinutes * 60_000;
    const candidates = (Array.isArray(contacts) ? contacts : [])
      .filter((contact) => contact?.kind === 'dm' || contact?.kind === 'api')
      .filter((contact) => contact?.config?.routing?.enabled !== false)
      .map((contact) => {
        const lastAt = Date.parse(String(contact?.last_at ?? '')) || 0;
        return { contact, lastAt };
      })
      .sort((a, b) => b.lastAt - a.lastAt);

    for (const { contact, lastAt } of candidates) {
      // last_at is any-party; if even that is older than the window, skip scan.
      if (lastAt > 0 && now - lastAt > thresholdMs) continue;
      let messages = [];
      try {
        messages = await this.hub.messages(contact.id, null, 40, 'all');
      } catch (error) {
        log('warn', 'User presence message scan failed', {
          contactId: contact.id,
          error: error.message,
        });
        continue;
      }
      const presence = irisPresenceFromMessages(messages, {
        now,
        idleMinutes,
        messageTimestampMs,
      });
      if (presence.active) {
        return {
          active: true,
          reason: presence.reason,
          lastUserMessageAt: presence.lastUserMessageAt,
          contactId: contact.id,
        };
      }
    }
    return { active: false, reason: 'idle', lastUserMessageAt: null, contactId: null };
  },

  async proactiveContext(contacts, now = Date.now(), dateEvents = null) {
    const usage = this.store.poolUsage(DELIVERY_POOL_DAILY, now);
    const recentConversations = contacts
      .filter((contact) => contact?.last_at)
      .sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
      .slice(0, 3)
      .map((contact) => ({
        recipient: contact.config?.routing?.recipientKey ?? contact.id,
        name: contact.name,
        lastAt: contact.last_at,
      }));
    const openTasks = this.vault.enabled
      ? await this.vault.taskContext().catch((error) => {
        log('warn', 'proactive task context unavailable', { error: error.message });
        return '';
      })
      : '';
    const matched = dateEvents ?? await this.loadMatchedDateEvents(now);
    return {
      currentShanghaiTime: shanghaiClock(now).label,
      dailyDeliveryCount: usage.count,
      lastDailyDeliveryAt: usage.lastAt === null ? null : new Date(usage.lastAt).toISOString(),
      recentConversations,
      openTaskSnapshot: summarizeTaskContext(openTasks) || '(unavailable)',
      todayDateEvents: matched.unclaimedToday ?? matched.today ?? [],
      upcomingDateEvents: matched.upcoming ?? [],
    };
  },

  routeOptions(isDaily) {
    const proactive = this.proactiveConfig();
    if (!isDaily) {
      return {
        rules: this.config.routing?.rules ?? {},
        usageOf: (recipientId) => this.store.recipientUsage(recipientId, Date.now(), DELIVERY_POOL_TASK),
        allowedRecipientKeys: null,
        ignoreRecipientLimits: false,
        modelOnly: false,
      };
    }
    return {
      // Daily proactive routing is model-owned: never apply the static task rules table.
      rules: {},
      usageOf: () => ({ count: 0, lastAt: null }),
      allowedRecipientKeys: proactive.recipients,
      ignoreRecipientLimits: true,
      modelOnly: true,
    };
  },
};
