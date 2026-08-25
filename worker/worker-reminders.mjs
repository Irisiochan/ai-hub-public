import fs from 'node:fs';
import path from 'node:path';
import {
  buildTaskReminders,
  isShanghaiSilentHour,
  isTaskReminderMode,
  nextTimerDelay,
  normalizeTaskReminderConfig,
  taskReminderRoomRoute,
} from './triage-core.mjs';
import { log, once, reminderOnce, reminderShadow } from './worker-shared.mjs';

/** TriageWorker 的任务到期提醒 domain：确定性截止日期扫描与会议室/主窗路由。 */
export const reminderMethods = {
  taskReminderConfig() {
    return this.config.taskReminders ?? normalizeTaskReminderConfig({}, this.proactiveConfig());
  },

  isTaskReminder(event) {
    return isTaskReminderMode(event);
  },

  taskReminderRoute(reminder) {
    const coordination = this.coordinationConfig();
    if (!coordination.enabled || !coordination.roomId) {
      return { route: 'main', executor: '', verifier: '', tags: [], reason: 'coordination-unavailable' };
    }
    const taskPath = String(reminder?.taskPath ?? '').replaceAll('\\', '/');
    const fileName = path.posix.basename(taskPath);
    if (!/^tasks\/[^/]+\.md$/i.test(taskPath) || !fileName) {
      return { route: 'main', executor: '', verifier: '', tags: [], reason: 'invalid-task-path' };
    }
    try {
      return {
        ...taskReminderRoomRoute(
          fs.readFileSync(path.join(coordination.tasksDir, fileName), 'utf8'),
          { roomTags: coordination.reminderRoomTags },
        ),
        reason: 'task-frontmatter',
      };
    } catch (error) {
      log('warn', 'task reminder route read failed; falling back to main', {
        taskPath,
        error: error.message,
      });
      return { route: 'main', executor: '', verifier: '', tags: [], reason: 'task-read-failed' };
    }
  },

  async scanTaskReminders({ shadow = false } = {}) {
    const config = this.taskReminderConfig();
    if (!config.enabled && !shadow) return { reason: 'disabled', reminders: [] };
    if (!this.vault.enabled) return { reason: 'vault-disabled', reminders: [] };
    const now = Date.now();
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) {
      log('info', 'task reminder scan skipped: silent hours');
      return { reason: 'silent-hours', reminders: [] };
    }
    const snapshot = await this.vault.taskContext();
    const reminders = buildTaskReminders(snapshot);
    let queued = 0;
    let verificationSkipped = 0;
    for (const reminder of reminders) {
      if (shadow) continue;
      const route = this.taskReminderRoute(reminder);
      if (
        reminder.stage === 'due-today'
        && route.verifier
        && this.verificationDispatchSettled(reminder.taskPath, reminder.dueDate, route.verifier)
      ) {
        verificationSkipped += 1;
        log('info', 'task reminder skipped after same-day verification dispatch', {
          taskPath: reminder.taskPath,
          dueDate: reminder.dueDate,
          verifier: route.verifier,
        });
        continue;
      }
      const result = this.enqueue({
        source: 'task-reminder',
        categoryHint: 'task-reminder',
        dedupeKey: reminder.reminderKey,
        summary: reminder.summary,
        payload: {
          mode: 'task-reminder',
          ...reminder,
          reminderRoute: route.route,
          emittedAt: now,
        },
      });
      if (result.inserted) queued += 1;
    }
    log('info', shadow ? 'task reminder shadow complete' : 'task reminder scan complete', {
      candidates: reminders.length,
      queued,
      verificationSkipped,
      reminders: reminders.map(({ taskPath, stage, dueDate }) => ({ taskPath, stage, dueDate })),
    });
    return { reason: shadow ? 'shadow' : queued ? 'queued' : 'no-op', reminders, queued };
  },

  async startTaskReminders() {
    const config = this.taskReminderConfig();
    if (reminderShadow) {
      await this.scanTaskReminders({ shadow: true });
      return;
    }
    if (!config.enabled) return;
    if (once) {
      if (reminderOnce) await this.scanTaskReminders();
      return;
    }
    const source = {
      intervalMinutes: config.intervalMinutes,
      jitterSeconds: config.jitterSeconds,
    };
    const slot = this.timers.push(null) - 1;
    const schedule = (first) => {
      if (this.stopping) return;
      this.timers[slot] = setTimeout(async () => {
        try {
          await this.scanTaskReminders();
        } catch (error) {
          log('warn', 'task reminder scan failed', { error: error.message });
        }
        schedule(false);
      }, nextTimerDelay(source, { first }));
    };
    schedule(true);
    log('info', 'task reminder scan scheduled', {
      intervalMinutes: config.intervalMinutes,
      jitterSeconds: config.jitterSeconds,
      recipient: config.recipient,
    });
  },
};
