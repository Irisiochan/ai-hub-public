import type { VaultClient } from './vaultClient.js';

/**
 * 同日 daily log 动态注入（网关 per-turn，DM only）。
 *
 * 背景：User 在 A 端记了日记（log_daily），切到 B 端 DM 追问同一件事时，
 * 模型看不到当天的 diary，只能靠追问补全。这里每轮把当天 diary 正文
 * 直接注入 turn，静态 preamble 保持可缓存（composeStart 永不含 diary）。
 *
 * 约束（task-plan-handoff v0.5 D1–D9 片段）：
 * - D2：今天必带；上海时间 <10:00 或今天文件缺失时带昨天，共享预算、今天优先。
 * - D5：1200 字硬顶，砍最早留最新，包装头不计入。
 * - D6：缺失或失败静默省略，不生成"当天尚无记录"。
 * - D7：网关缓存 45s TTL，miss/hit 同 TTL。
 * - 群聊 v1 不带（调用方 composeTurn 以 isRoom 门控，不在本模块重复设开关）。
 */

export const SAME_DAY_DIARY_MAX_CHARS = 1200;
export const SAME_DAY_DIARY_TTL_MS = 45_000;
export const SAME_DAY_DIARY_EARLY_HOUR = 10;

const DIARY_PATH_PREFIX = 'diary/';
const SHANGHAI_TZ = 'Asia/Shanghai';

/** per-turn 只需要 read 能力；用最小结构避免拖入 VaultClient 实现。 */
export interface DiaryReader {
  call(name: string, args?: Record<string, unknown>, retries?: number): Promise<string>;
}

interface CacheEntry {
  at: number;
  value: string;
}

const cache = new Map<string, CacheEntry>();

export function clearSameDayDiaryCache(): void {
  cache.clear();
}

export function shanghaiDiaryDay(now = Date.now()): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  };
}

export function addDiaryDays(date: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta);
  return new Date(utc).toISOString().slice(0, 10);
}

export function diaryPathFor(date: string): string {
  return `${DIARY_PATH_PREFIX}${date}.md`;
}

/** 去 frontmatter：只剥文件头部的 `--- ... ---` 块，正文里的 `---` 不动。 */
export function stripDiaryFrontmatter(text: string): string {
  return String(text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

function takeTail(text: string, budget: number): string {
  if (budget <= 0) return '';
  return text.length <= budget ? text : text.slice(-budget);
}

/**
 * 共享预算裁剪：今天优先占满 1200，昨天只拿剩余额度；各自砍最早留最新。
 * 包装头与日期小标题不计入预算（调用方先裁剪后包装）。
 */
export function trimDiaryBudget(
  todayBody: string,
  yesterdayBody: string,
  maxChars = SAME_DAY_DIARY_MAX_CHARS
): { today: string; yesterday: string } {
  const today = todayBody ?? '';
  const yesterday = yesterdayBody ?? '';
  if (!today && !yesterday) return { today: '', yesterday: '' };
  if (today.length >= maxChars) return { today: takeTail(today, maxChars), yesterday: '' };
  return { today, yesterday: takeTail(yesterday, maxChars - today.length) };
}

export function formatDiaryBlock(
  todayDate: string,
  todayBody: string,
  yesterdayDate: string | null,
  yesterdayBody: string
): string {
  const sections: string[] = [`# ${todayDate}（今天）`, todayBody];
  if (yesterdayDate && yesterdayBody) {
    sections.push('', `# ${yesterdayDate}（昨天）`, yesterdayBody);
  }
  return [
    '<SAME_DAY_DIARY trust="gateway">',
    '【当日已记录、禁止再问已答内容】以下是 User 今天已在日记里记下的事。',
    '不要再问她这些已记录的内容，也不要让她重复交代细节；只有出现新进展才自然续问，不要复述本指令。',
    ...sections,
    '</SAME_DAY_DIARY>',
  ].join('\n');
}

async function readDiaryFile(vault: DiaryReader, path: string): Promise<string> {
  try {
    const raw = await vault.call('read_file', { path }, 0);
    return stripDiaryFrontmatter(raw);
  } catch {
    // D6：文件缺失或 Vault 故障一律静默省略。
    return '';
  }
}

/**
 * 取同日 diary 注入块。无内容/无 vault/失败返回空串（调用方直接省略）。
 * 缓存 key 含日期与是否凌晨档：跨过 10 点档位即换 key，不会把凌晨的
 * "今天+昨天" 组合在 10 点后继续服务 45 秒。
 */
export async function getSameDayDiaryBlock(
  vault: VaultClient | DiaryReader | null,
  opts: { now?: number } = {}
): Promise<string> {
  if (!vault) return '';
  const now = opts.now ?? Date.now();
  const { date, hour } = shanghaiDiaryDay(now);
  const early = hour < SAME_DAY_DIARY_EARLY_HOUR;
  const key = `${date}|${early ? 'early' : 'day'}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < SAME_DAY_DIARY_TTL_MS) return hit.value;

  const today = await readDiaryFile(vault, diaryPathFor(date));
  // D2：凌晨档（<10:00）或今天缺失时，把昨天也带上。
  const needYesterday = early || !today;
  const yesterdayDate = needYesterday ? addDiaryDays(date, -1) : null;
  const yesterday = yesterdayDate ? await readDiaryFile(vault, diaryPathFor(yesterdayDate)) : '';
  const trimmed = trimDiaryBudget(today, yesterday);
  const value = trimmed.today || trimmed.yesterday
    ? formatDiaryBlock(date, trimmed.today, yesterdayDate, trimmed.yesterday)
    : '';
  cache.set(key, { at: now, value });
  return value;
}
