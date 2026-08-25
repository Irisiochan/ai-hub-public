import {
  isShanghaiSilentHour,
  shanghaiDayStart,
} from './triage-core.mjs';
import {
  buildFollowupDispatchSummary,
  evaluateFollowupGate,
  FOLLOWUP_SOURCE,
  FOLLOWUP_STATUS_CANCELLED,
  FOLLOWUP_STATUS_EXPIRED,
  FOLLOWUP_STATUS_QUEUED,
  isUserMessage,
  matchesAbsenceKeyword,
  messageNumericId,
  normalizeAbsenceExtract,
  normalizeFollowupConfig,
} from './followups.mjs';
import { hash, log } from './worker-shared.mjs';

/**
 * TriageWorker 的临时离开跟进（followup）domain。方法通过
 * Object.assign(TriageWorker.prototype, followupMethods) 挂载，
 * `this` 语义与类内方法完全一致。
 */
export const followupMethods = {
  followupConfig() {
    return this.config.followups ?? normalizeFollowupConfig({});
  },

  followupFallbacks(now = Date.now()) {
    if (!this.followupConfig().enabled) return [];
    const since = shanghaiDayStart(now) - 24 * 60 * 60_000;
    return this.store.expiredFollowupsForFallback({ since, limit: 1 }).map((followup) => ({
      id: followup.id,
      activity: followup.activity,
      returnCommitment: followup.return_commitment ?? '',
      contactId: followup.contact_id,
      recipientKey: followup.recipient_key,
    }));
  },

  isFollowupEvent(event) {
    return event?.source === FOLLOWUP_SOURCE
      || event?.payload?.mode === 'followup'
      || Boolean(event?.payload?.followupId);
  },

  followupScanCursors() {
    try {
      const parsed = JSON.parse(this.store.getSourceState('followup-scan-cursors:v1') ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  },

  saveFollowupScanCursors(cursors) {
    this.store.setSourceState('followup-scan-cursors:v1', JSON.stringify(cursors));
  },

  async scanAbsenceFollowups(now = Date.now()) {
    const config = this.followupConfig();
    if (!config.enabled || !this.hub.baseUrl) return { scanned: 0, created: 0 };
    let contacts;
    try {
      contacts = await this.hub.contacts();
    } catch (error) {
      log('warn', 'followup contact list unavailable', { error: error.message });
      return { scanned: 0, created: 0 };
    }
    const dms = (Array.isArray(contacts) ? contacts : [])
      .filter((contact) => contact?.kind === 'dm' || contact?.kind === 'api')
      .filter((contact) => contact?.config?.routing?.enabled !== false);
    const cursors = this.followupScanCursors();
    let scanned = 0;
    let created = 0;

    for (const contact of dms) {
      if (this.store.hasOpenFollowupForContact(contact.id)) continue;
      const after = Number(cursors[contact.id] ?? 0);
      let messages = [];
      try {
        messages = await this.hub.messages(contact.id, after, config.scanLimit, 'all');
      } catch (error) {
        log('warn', 'followup message scan failed', {
          contactId: contact.id,
          error: error.message,
        });
        continue;
      }
      if (!messages.length) continue;
      scanned += messages.length;
      let maxId = after;
      for (const message of messages) {
        const mid = messageNumericId(message);
        if (mid !== null && mid > maxId) maxId = mid;
        if (!isUserMessage(message)) continue;
        if (!matchesAbsenceKeyword(message.content)) continue;
        if (mid === null) continue;
        if (this.store.hasOpenFollowupForContact(contact.id)) break;

        let extract;
        try {
          extract = await this.deepseek.extractTemporaryAbsence(message.content);
        } catch (error) {
          log('warn', 'followup extract failed', {
            contactId: contact.id,
            messageId: mid,
            error: error.message,
          });
          continue;
        }
        const absence = normalizeAbsenceExtract(extract.result, config);
        if (!absence) continue;

        const followupId = hash(`followup:${contact.id}:${mid}`);
        const dueAt = now + absence.expectedMinutes * 60_000;
        const recipientKey = contact.config?.routing?.recipientKey ?? contact.id;
        const inserted = this.store.insertFollowup({
          id: followupId,
          contactId: contact.id,
          messageId: mid,
          activity: absence.activity,
          returnCommitment: absence.returnCommitment,
          expectedMinutes: absence.expectedMinutes,
          dueAt,
          recipientKey,
          now,
        });
        if (inserted) {
          created += 1;
          log('info', 'followup scheduled', {
            followupId,
            contactId: contact.id,
            messageId: mid,
            activity: absence.activity,
            returnCommitment: absence.returnCommitment,
            expectedMinutes: absence.expectedMinutes,
            dueAt: new Date(dueAt).toISOString(),
            extractCostCny: extract.costCny,
          });
        }
      }
      if (maxId > after) cursors[contact.id] = maxId;
    }
    this.saveFollowupScanCursors(cursors);
    return { scanned, created };
  },

  async processFollowupsIfDue(now = Date.now()) {
    const config = this.followupConfig();
    if (!config.enabled) return false;
    // Share the outcomes interval (default 5 min) to avoid a second timer chain.
    const intervalMs = (this.config.outcomes?.intervalMinutes ?? 5) * 60_000;
    if (now < this.nextFollowupPollAt) return false;
    this.nextFollowupPollAt = now + intervalMs;

    const scan = await this.scanAbsenceFollowups(now);
    if (scan.created || scan.scanned) {
      log('info', 'followup scan complete', scan);
    }

    const pending = this.store.pendingFollowups({ limit: 50 });
    if (!pending.length) return scan.created > 0;

    const proactive = this.proactiveConfig();
    const silent = isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour);
    let acted = false;

    for (const followup of pending) {
      let userMessagesAfter = [];
      try {
        const rows = await this.hub.messages(
          followup.contact_id,
          followup.message_id,
          config.scanLimit,
          'all',
        );
        userMessagesAfter = rows.filter((message) => {
          const mid = messageNumericId(message);
          if (mid !== null && mid <= followup.message_id) return false;
          return isUserMessage(message);
        });
      } catch (error) {
        log('warn', 'followup cancel-check messages failed', {
          followupId: followup.id,
          error: error.message,
        });
        continue;
      }

      const proactiveDeliveredAfter = this.store.hasDailyDeliverySince(
        followup.contact_id,
        followup.created_at,
        now,
      );
      // Followups clear only the minimum gap (like date-events); hard pool + silent still apply.
      const policy = this.dailyPolicy(now, { hasTodayDateEvent: true });
      const poolBlocked = policy.poolFull;

      const gate = evaluateFollowupGate(followup, {
        now,
        userMessagesAfter,
        proactiveDeliveredAfter,
        expireAfterMinutes: config.expireAfterMinutes,
        silent,
        poolBlocked,
      });

      if (gate.action === 'cancel') {
        this.store.updateFollowupStatus(followup.id, FOLLOWUP_STATUS_CANCELLED, {
          cancelReason: gate.reason,
          now,
        });
        log('info', 'followup cancelled', { followupId: followup.id, reason: gate.reason });
        acted = true;
        continue;
      }
      if (gate.action === 'expire') {
        this.store.updateFollowupStatus(followup.id, FOLLOWUP_STATUS_EXPIRED, {
          cancelReason: gate.reason,
          now,
        });
        log('info', 'followup expired', { followupId: followup.id, reason: gate.reason });
        acted = true;
        continue;
      }
      if (gate.action !== 'fire') continue;

      const queued = this.enqueue({
        source: FOLLOWUP_SOURCE,
        categoryHint: 'daily',
        summary: buildFollowupDispatchSummary(followup),
        dedupeKey: `followup:${followup.id}`,
        payload: {
          mode: 'daily',
          followupId: followup.id,
          activity: followup.activity,
          returnCommitment: followup.return_commitment,
          contactId: followup.contact_id,
          recipientKey: followup.recipient_key,
          forceActionable: true,
        },
      });
      this.store.updateFollowupStatus(followup.id, FOLLOWUP_STATUS_QUEUED, {
        eventId: queued.id,
        now,
      });
      log('info', 'followup queued for dispatch', {
        followupId: followup.id,
        eventId: queued.id,
        activity: followup.activity,
      });
      acted = true;
    }
    return acted || scan.created > 0;
  },
};
