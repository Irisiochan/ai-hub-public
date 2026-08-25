import crypto from 'node:crypto';
import type { Db, TaskWritebackRow } from '../db.js';
import { TaskStateService } from '../tasks/taskStateService.js';

const REVIEW_TIMEOUT_MS = 10_000;
const AUTO_APPLY_THRESHOLD = 0.9;
const MAX_SOURCE_CHARS = 4000;
const TASK_PATH_RE = /^tasks\/[a-z0-9][a-z0-9-]*\.md$/;
const TASK_UPDATE_RE = /(?:改期|改到|推迟|延期|延后|提前|过几天|晚点|下次|等.+再|进展|进度|开始|已经|刚刚|搞定|完成|做完|结束|取消|不做|放弃|不需要)/;
const NON_AUTHOR_RE = /(?:^|[，。！？；\s])(?:他|她|他们|她们|别人|朋友|同事|老板|家里人|Claude|Codex|阿野|示例助手)\s*(?:说|表示|打算|计划|要|会)/i;
const META_NEGATION_RE = /(?:我没(?:有)?说|我不是说|别把.+当(?:成)?|只是(?:引用|转述)|并不代表)/;

export type TaskWritebackAction = 'progress' | 'reschedule' | 'done' | 'dropped';
export type TaskWritebackStatus = TaskWritebackRow['status'] | 'ignored' | 'duplicate';

export interface TaskWritebackReview {
  decision: 'candidate' | 'reject' | 'pending';
  confidence: number | null;
  action: TaskWritebackAction | null;
  taskQuery: string | null;
  due: string | null;
  detail?: string;
}

export interface TaskWritebackOutcome {
  status: TaskWritebackStatus;
  idempotencyKey?: string;
  taskPath?: string;
  action?: TaskWritebackAction;
  detail?: string;
}

export interface TaskWritebackVault {
  call(name: string, args?: Record<string, unknown>, retries?: number): Promise<string>;
}

export type TaskWritebackReviewer = (text: string) => Promise<TaskWritebackReview>;

interface ContactRef {
  id: string;
  name: string;
}

interface TaskSnapshot {
  path: string;
  contentFingerprint: string;
}

const activeTaskWrites = new Set<string>();

class TaskWritebackConflictError extends Error {}

function vaultText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { result?: unknown };
    return typeof parsed.result === 'string' ? parsed.result : raw;
  } catch {
    return raw;
  }
}

function taskStatus(raw: string): string | null {
  const frontmatter = vaultText(raw).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return frontmatter?.[1].match(/^status:\s*['"]?([^'"\s]+)['"]?\s*$/im)?.[1]?.toLowerCase() ?? null;
}

function taskContentFingerprint(raw: string): string {
  return crypto.createHash('sha256').update(vaultText(raw).replaceAll('\r\n', '\n')).digest('hex');
}

function shanghaiDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function reviewEndpoint(): string {
  const base = (process.env.DEEPSEEK_API_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function pendingReview(detail: string): TaskWritebackReview {
  return { decision: 'pending', confidence: null, action: null, taskQuery: null, due: null, detail };
}

export function ownTaskUpdateText(text: string): string | null {
  const own = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
  if (!own || !TASK_UPDATE_RE.test(own)) return null;
  if (NON_AUTHOR_RE.test(own) || META_NEGATION_RE.test(own)) return null;
  return own;
}

export const reviewTaskWritebackWithDeepSeek: TaskWritebackReviewer = async (text) => {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return pendingReview('DEEPSEEK_API_KEY 未配置');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
  try {
    const response = await fetch(reviewEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_CAPTURE_MODEL?.trim() || 'deepseek-v4-flash',
        thinking: { type: 'disabled' },
        stream: false,
        max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              '你是私人任务库的状态变更精筛器。只判断 User 本人原话是否明确更新一个已经存在的任务。',
              `今天是上海日期 ${shanghaiDate()}。输出 JSON：candidate(boolean), action, task_query, due, confidence。`,
              '这里只判断原话是否像对已有个人待办的状态说明，不要求你证明任务库中确实存在；后续程序会搜索并要求唯一命中。',
              'action 只能是 progress、reschedule、done、dropped 或 null。task_query 用两个或更多原文中的具体主题词，供 AND 搜索定位唯一任务。',
              'progress 表示明确有进展但未完成；reschedule 表示改期且任务仍 open；done/dropped 仅形成待确认候选，不会自动归档。',
              '否定句、疑问句、玩笑、情绪、模糊说法、引用块、转述别人的计划、模型或系统消息一律 candidate=false。',
              '“还没做/没有完成”本身不是进展；只有同时明确给出新进展或改期才可成为候选。',
              '正例：“项目 Alpha 的验收要过几天再做，改到 8 月 10 日”应输出 candidate=true、action=reschedule、task_query="项目 Alpha 验收"。',
              '不得补充原文没有的任务、日期或状态。高置信度必须有明确动作和可定位主题。',
            ].join(' '),
          },
          { role: 'user', content: text.slice(0, MAX_SOURCE_CHARS) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return pendingReview(`DeepSeek HTTP ${response.status}`);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) return pendingReview('DeepSeek 返回空内容');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const confidence = Number(parsed.confidence);
    const action = ['progress', 'reschedule', 'done', 'dropped'].includes(String(parsed.action))
      ? parsed.action as TaskWritebackAction
      : null;
    const taskQuery = typeof parsed.task_query === 'string' ? parsed.task_query.trim().slice(0, 200) : null;
    const due = typeof parsed.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due)
      ? parsed.due
      : null;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return pendingReview('DeepSeek confidence 无效');
    }
    if (parsed.candidate !== true || !action || !taskQuery) {
      return {
        decision: 'reject',
        confidence,
        action: null,
        taskQuery: null,
        due: null,
        detail: `candidate=${parsed.candidate === true}; action=${action ?? 'null'}; task_query=${taskQuery ?? 'null'}`,
      };
    }
    return { decision: 'candidate', confidence, action, taskQuery, due };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return pendingReview(`DeepSeek 审查失败：${detail}`);
  } finally {
    clearTimeout(timeout);
  }
};

function taskPathsFromSearch(raw: string): string[] {
  const text = vaultText(raw);
  const paths = [...text.matchAll(/\(`(tasks\/[a-z0-9][a-z0-9-]*\.md)`\)/g)]
    .map((match) => match[1].toLowerCase())
    .filter((path) => TASK_PATH_RE.test(path));
  return [...new Set(paths)].slice(0, 8);
}

async function findUniqueOpenTask(vault: TaskWritebackVault, query: string): Promise<{
  snapshot?: TaskSnapshot;
  detail?: string;
}> {
  let searchRaw: string;
  try {
    searchRaw = await vault.call('search_vault', { query }, 0);
  } catch (error) {
    return { detail: `任务搜索失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const paths = taskPathsFromSearch(searchRaw);
  const open: TaskSnapshot[] = [];
  for (const path of paths) {
    try {
      const raw = await vault.call('read_file', { path }, 0);
      if (taskStatus(raw) !== 'open') continue;
      open.push({ path, contentFingerprint: taskContentFingerprint(raw) });
    } catch {
      // A stale search hit is not a writable target.
    }
  }
  if (open.length !== 1) {
    return { detail: open.length === 0 ? '没有定位到唯一 open 任务' : `定位到 ${open.length} 个 open 任务` };
  }
  return { snapshot: open[0] };
}

function updateRow(
  db: Db,
  idempotencyKey: string,
  fields: Partial<Pick<TaskWritebackRow,
    'task_path' | 'action' | 'confidence' | 'due' | 'status' | 'detail' | 'command_id' | 'event_id'>>
): void {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(
    `UPDATE task_writebacks SET ${assignments}, updated_at = datetime('now') WHERE idempotency_key = ?`
  ).run(...entries.map(([, value]) => value ?? null), idempotencyKey);
}

function traceNote(
  contact: ContactRef,
  messageId: number,
  idempotencyKey: string,
  sourceText: string,
  review: TaskWritebackReview
): string {
  const labels: Record<TaskWritebackAction, string> = {
    progress: '进展',
    reschedule: '改期（任务保持 open）',
    done: '完成候选',
    dropped: '放弃候选',
  };
  return [
    `AI Hub 聊天任务回写：${labels[review.action!]}`,
    `来源联系人：${contact.name}（${contact.id}）`,
    `消息引用：ai-hub:${contact.id}/messages/${messageId}`,
    `幂等键：${idempotencyKey}`,
    review.due ? `新时间承诺：${review.due}` : '',
    `User 原话：${sourceText.slice(0, MAX_SOURCE_CHARS)}`,
  ].filter(Boolean).join('\n');
}

export async function maybeWriteBackTask(
  db: Db,
  vault: TaskWritebackVault,
  tasksDir: string | null,
  contact: ContactRef,
  messageId: number,
  userText: string,
  log: (message: string) => void,
  reviewer: TaskWritebackReviewer = reviewTaskWritebackWithDeepSeek
): Promise<TaskWritebackOutcome> {
  const sourceText = ownTaskUpdateText(userText);
  if (!sourceText) return { status: 'ignored' };

  const contentHash = crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 16);
  const idempotencyKey = `chat-task:${contact.id}:${messageId}:${contentHash}`;
  const sourceRef = `ai-hub:${contact.id}/messages/${messageId}`;
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO task_writebacks (
       idempotency_key, message_id, contact_id, contact_name, source_quote, source_ref
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(idempotencyKey, messageId, contact.id, contact.name, sourceText.slice(0, MAX_SOURCE_CHARS), sourceRef);
  if (inserted.changes === 0) {
    const existing = db.prepare('SELECT * FROM task_writebacks WHERE idempotency_key = ?')
      .get(idempotencyKey) as TaskWritebackRow;
    log(`task writeback duplicate (${existing.status}) ${idempotencyKey}`);
    return {
      status: 'duplicate',
      idempotencyKey,
      taskPath: existing.task_path ?? undefined,
      action: existing.action as TaskWritebackAction | undefined,
      detail: existing.status,
    };
  }

  let review = await reviewer(sourceText);
  if (review.decision === 'pending') {
    log(`task writeback review pending, retrying once: ${review.detail ?? 'uncertain result'}`);
    review = await reviewer(sourceText);
  }
  if (review.decision !== 'candidate' || !review.action || !review.taskQuery) {
    const status = review.decision === 'pending' ? 'ambiguous' : 'rejected';
    updateRow(db, idempotencyKey, { status, detail: review.detail ?? '没有明确任务状态变化' });
    log(`task writeback ${status}: ${review.detail ?? 'not a candidate'}`);
    return { status, idempotencyKey, detail: review.detail };
  }
  updateRow(db, idempotencyKey, {
    action: review.action,
    confidence: review.confidence,
    due: review.due,
  });

  if ((review.confidence ?? 0) < AUTO_APPLY_THRESHOLD) {
    updateRow(db, idempotencyKey, { status: 'ambiguous', detail: '置信度不足，未写入 Vault' });
    return { status: 'ambiguous', idempotencyKey, action: review.action, detail: '置信度不足' };
  }

  const found = await findUniqueOpenTask(vault, review.taskQuery);
  if (!found.snapshot) {
    updateRow(db, idempotencyKey, { status: 'ambiguous', detail: found.detail });
    log(`task writeback ambiguous: ${found.detail}`);
    return { status: 'ambiguous', idempotencyKey, action: review.action, detail: found.detail };
  }
  const task = found.snapshot;
  updateRow(db, idempotencyKey, { task_path: task.path });

  if (!tasksDir) {
    const detail = '任务目录未配置，未执行 Controller 写入';
    updateRow(db, idempotencyKey, { status: 'ambiguous', detail });
    log(`task writeback ambiguous: ${detail}`);
    return { status: 'ambiguous', idempotencyKey, taskPath: task.path, action: review.action, detail };
  }

  if (review.action === 'done' || review.action === 'dropped') {
    const detail = `${review.action} 只生成待确认候选，未修改任务`;
    updateRow(db, idempotencyKey, { status: 'proposed', detail });
    log(`task writeback proposed: ${task.path} → ${review.action}`);
    return { status: 'proposed', idempotencyKey, taskPath: task.path, action: review.action, detail };
  }

  if (review.action === 'reschedule' && !review.due) {
    const detail = '改期候选缺少明确日期，未执行 Controller 写入';
    updateRow(db, idempotencyKey, { status: 'ambiguous', detail });
    return { status: 'ambiguous', idempotencyKey, taskPath: task.path, action: review.action, detail };
  }

  if (activeTaskWrites.has(task.path)) {
    const detail = '同一任务正由另一联系人更新，已保留候选并拒绝覆盖';
    updateRow(db, idempotencyKey, { status: 'conflict', detail });
    log(`task writeback conflict: ${task.path}`);
    return { status: 'conflict', idempotencyKey, taskPath: task.path, action: review.action, detail };
  }

  activeTaskWrites.add(task.path);
  try {
    const note = traceNote(contact, messageId, idempotencyKey, sourceText, review);
    const taskState = new TaskStateService(db);
    const commandId = idempotencyKey;
    try {
      const apply = db.transaction(() => {
        const current = taskState.refreshTask(tasksDir, task.path);
        if (current.contentFingerprint !== task.contentFingerprint) {
          throw new TaskWritebackConflictError('task_content_changed_after_review');
        }
        const command = {
          commandId,
          idempotencyKey,
          taskId: current.taskId,
          expectedVersion: current.version,
          actor: contact.id,
          source: 'chat-task-writeback',
          reason: note,
          evidence: {
            action: review.action,
            due: review.due,
            messageId,
            sourceRef,
          },
          projection: { path: task.path, note, source: contact.id },
        };
        const applied = review.action === 'reschedule'
          ? taskState.reschedule(command, review.due!)
          : taskState.annotate(command);
        if (applied.result !== 'applied' || !applied.eventId) {
          throw new TaskWritebackConflictError(applied.error ?? 'unknown conflict');
        }
        updateRow(db, idempotencyKey, {
          status: 'applied',
          command_id: commandId,
          event_id: applied.eventId,
          detail: '权威命令已写入 SQLite，等待 Vault 异步投影',
        });
        return applied;
      });
      apply();
    } catch (error) {
      if (error instanceof TaskWritebackConflictError) {
        const detail = `Controller 拒绝写入：${error.message}`;
        updateRow(db, idempotencyKey, { status: 'conflict', detail });
        log(`task writeback conflict: ${task.path} (${error.message})`);
        return { status: 'conflict', idempotencyKey, taskPath: task.path, action: review.action, detail };
      }
      const detail = `Controller 写入失败：${error instanceof Error ? error.message : String(error)}`;
      updateRow(db, idempotencyKey, { status: 'failed', detail });
      log(`task writeback failed: ${detail}`);
      return { status: 'failed', idempotencyKey, taskPath: task.path, action: review.action, detail };
    }

    log(`task writeback applied to Controller: ${task.path} stays open`);
    return { status: 'applied', idempotencyKey, taskPath: task.path, action: review.action };
  } finally {
    activeTaskWrites.delete(task.path);
  }
}
