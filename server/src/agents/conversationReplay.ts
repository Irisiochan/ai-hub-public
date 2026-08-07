import type { MessageRow } from '../db.js';
import { shanghaiStamp, timestampedMessage } from '../memory/inject.js';
import { compactSummaryText } from './conversationSummary.js';
import { historicalMessageText } from './sideChannel.js';
import { estimateTokens } from './tokenEstimate.js';

export const CLI_REPLAY_TOKEN_BUDGET = 4_096;
export const CLI_REPLAY_SUMMARY_MAX_TOKENS = 1_200;
export const CLI_REPLAY_MIN_RECENT_MESSAGES = 4;
export const CLI_REPLAY_MESSAGE_MAX_CHARS = 500;

export interface ConversationReplayOptions {
  tokenBudget?: number;
  summaryMaxTokens?: number;
  minRecentMessages?: number;
  messageMaxChars?: number;
  userName: string;
  nameOf(sender: string): string;
}
export interface ConversationReplayPlan {
  block: string;
  tokens: number;
  summary: string;
  summaryTokens: number;
  recentCount: number;
  summarizedCount: number;
  summarizedThrough: number | null;
}

function speaker(row: MessageRow, opts: ConversationReplayOptions): string {
  const text = historicalMessageText(row);
  if (text.startsWith('[后台') || text.startsWith('[主动消息触发]')) return '网关';
  return row.sender === 'user' ? opts.userName : opts.nameOf(row.sender);
}

function clipRecentText(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const marker = '\n[…本条历史消息按回放预算截断…]\n';
  const remaining = Math.max(maxChars - marker.length, 80);
  const head = Math.ceil(remaining * 0.65);
  return clean.slice(0, head) + marker + clean.slice(-(remaining - head));
}

function replayLine(row: MessageRow, opts: ConversationReplayOptions, maxChars: number): string {
  return timestampedMessage(
    `${speaker(row, opts)}：${clipRecentText(historicalMessageText(row), maxChars)}`,
    row.created_at,
    '历史消息'
  );
}

function replayHeader(rows: MessageRow[], tokenBudget: number): string[] {
  const first = rows.length > 0 ? shanghaiStamp(rows[0].created_at) : '';
  const last = rows.length > 0 ? shanghaiStamp(rows[rows.length - 1].created_at) : '';
  const span = first && last ? `${first} ～ ${last}（上海时间）` : '较早摘要内各行自带上海时间锚点';
  return [
    '',
    '# 对话存档回放（网关注入）',
    '此前 CLI 会话已重置；以下是连续性的权威存档，删除内容不在其中。继续对话，不向 User 提“会话重置”。',
    `- 上限 ${tokenBudget} estimated tokens；较早内容为摘要，最近原文跨度：${span}。全部是历史记录。`,
    '- 相对时间按每行时间锚点解释，当前时间只认 TURN_TIME_PRELOADED。',
    '- 标有“[后台事件]”“[主动消息触发]”的行来自网关自动流程，不是 User 说的话。',
  ];
}

function renderBlock(
  rows: MessageRow[],
  summary: string,
  opts: ConversationReplayOptions,
  tokenBudget: number,
  messageMaxChars: number
): string {
  return [
    ...replayHeader(rows, tokenBudget),
    ...(summary ? ['', '## 较早对话摘要（覆盖更早消息）', summary] : []),
    ...(rows.length > 0 ? ['', '## 最近消息原文', ...rows.map((row) => replayLine(row, opts, messageMaxChars))] : []),
  ].join('\n');
}

/**
 * CLI fresh session 的确定性回放规划：复用 API 的 extractive rolling summary，
 * 只把超预算的最早消息推进摘要，并至少保留最近若干条原文。
 */
export function buildConversationReplay(
  existingSummary: string,
  rowsAfterSummary: MessageRow[],
  opts: ConversationReplayOptions
): ConversationReplayPlan | null {
  if (!existingSummary.trim() && rowsAfterSummary.length === 0) return null;

  const tokenBudget = Math.max(Number(opts.tokenBudget ?? CLI_REPLAY_TOKEN_BUDGET), 4_096);
  const summaryMaxTokens = Math.max(
    Math.min(Number(opts.summaryMaxTokens ?? CLI_REPLAY_SUMMARY_MAX_TOKENS), tokenBudget - 1_024),
    256
  );
  const messageMaxChars = Math.max(Number(opts.messageMaxChars ?? CLI_REPLAY_MESSAGE_MAX_CHARS), 200);
  const minRecent = Math.min(
    Math.max(Number(opts.minRecentMessages ?? CLI_REPLAY_MIN_RECENT_MESSAGES), 1),
    rowsAfterSummary.length
  );

  const summarize = (count: number) => compactSummaryText(
    existingSummary,
    rowsAfterSummary.slice(0, count),
    {
      summaryMaxTokens,
      historyTokenBudget: tokenBudget,
      nameOf: opts.nameOf,
    }
  );
  const evaluate = (count: number) => {
    const summary = summarize(count);
    const recent = rowsAfterSummary.slice(count);
    const block = renderBlock(recent, summary, opts, tokenBudget, messageMaxChars);
    return { summary, recent, block, tokens: estimateTokens(block) };
  };

  let dropCount = 0;
  let chosen = evaluate(0);
  const maxDrop = Math.max(rowsAfterSummary.length - minRecent, 0);
  if (chosen.tokens > tokenBudget && maxDrop > 0) {
    let low = 1;
    let high = maxDrop;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (evaluate(mid).tokens <= tokenBudget) high = mid;
      else low = mid + 1;
    }
    dropCount = low;
    chosen = evaluate(dropCount);
  }

  // 极端单条长消息仍以 per-message clip 收敛；若自定义预算/上限组合不合理，
  // 继续淘汰最早原文，但始终保留最新一条作为连续性锚点。
  while (chosen.tokens > tokenBudget && dropCount < rowsAfterSummary.length - 1) {
    dropCount++;
    chosen = evaluate(dropCount);
  }

  return {
    block: chosen.block,
    tokens: chosen.tokens,
    summary: chosen.summary,
    summaryTokens: estimateTokens(chosen.summary),
    recentCount: chosen.recent.length,
    summarizedCount: dropCount,
    summarizedThrough: dropCount > 0 ? rowsAfterSummary[dropCount - 1].id : null,
  };
}
