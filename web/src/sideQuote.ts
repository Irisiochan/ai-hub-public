import type { Message } from './api';
import { automationDescriptor } from './messageSource.ts';
import { formatLocalTime } from './time.ts';

/**
 * 副窗「引到主窗」：把一条副窗消息的原文作为引用块塞进主窗草稿。
 *
 * 为什么需要：主窗历史里副窗行会被 server `agents/sideChannel.ts` 折叠成
 * `[后台回复] + 前 200 字` 或一行模板，模型拿不到验收细节。引用块以
 * origin=main + sender=user 落库，走 sideChannel.ts 的原样返回分支，不被折叠。
 */

export type QuoteMode = 'full' | 'digest';

/** 摘要档对齐 server sideChannel.ts 的 compact(text, 200)，避免两套口径。 */
export const DIGEST_CHARS = 200;

/**
 * 引原文的硬上限。默认 historyTokenBudget 是 8000 token，中文约 1 字 1 token，
 * 2000 字≈四分之一预算：够放下完整回执，又不至于把更早的历史整段挤出去。
 * 超出部分截断并写明总字数，绝不静默丢。
 */
export const FULL_CHARS = 2000;

export function sideSourceLabel(message: Pick<Message, 'content' | 'meta'>): string {
  const automation = automationDescriptor(message);
  if (automation?.messageType === 'background-event') {
    return [
      '网关',
      automation.eventSource,
      automation.eventCategory,
      automation.eventPriority ? `P${automation.eventPriority}` : '',
    ].filter(Boolean).join(' · ');
  }

  try {
    const event = JSON.parse(message.meta || '{}')?.event;
    if (event === 'worker-receipt') return '网关 · Worker 回执';
    if (event === 'model-switch') return '网关 · 模型切换';
    if (event === 'effort-switch') return '网关 · 推理强度切换';
  } catch {
    // Fall through to content-derived labels for legacy rows.
  }
  if (message.content.startsWith('⚡ AI Hub 自主事件分派')) {
    const source = lineField(message.content, '来源');
    const category = lineField(message.content, '分类');
    return ['网关', source, category].filter(Boolean).join(' · ');
  }
  return '网关事件';
}

function lineField(content: string, label: string): string {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${label}：`));
  return line?.trim().slice(label.length + 1).trim() ?? '';
}

function digestBody(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > DIGEST_CHARS ? `${oneLine.slice(0, DIGEST_CHARS)}…` : oneLine;
}

function fullBody(content: string): string {
  const text = content.trim();
  if (text.length <= FULL_CHARS) return text;
  return `${text.slice(0, FULL_CHARS)}…\n（原文共 ${text.length} 字，此处只引前 ${FULL_CHARS} 字，完整内容在副窗）`;
}

/**
 * 组装引用块。每行都加 `> ` 前缀，这不只是排版：
 * `messageSource.ts` 的 automationDescriptor 用 `^⚡ AI Hub 自主事件分派` 和
 * `^\[后台事件\]` 认副窗消息，前缀让引用过来的机器原文不会被重新判成副窗行
 * 而从主窗消失。同理 server 侧 sideChannel.ts:57 的正文前缀判断也躲开了。
 */
export function buildSideQuote(
  message: Pick<Message, 'content' | 'meta' | 'created_at'>,
  mode: QuoteMode
): string {
  const head = `[副窗 · ${sideSourceLabel(message)} · ${formatLocalTime(message.created_at)}]`;
  const body = mode === 'digest' ? digestBody(message.content) : fullBody(message.content);
  return [head, ...body.split('\n')]
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

/** 追加而不是覆盖——她可能已经打了一半的字。返回值末尾留空行，光标落在引用块之后。 */
export function appendQuoteToDraft(draft: string, quote: string): string {
  const base = draft.trimEnd();
  return base ? `${base}\n\n${quote}\n\n` : `${quote}\n\n`;
}
