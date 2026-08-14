import type { VaultClient } from './vaultClient.js';

/**
 * Read path of the memory layer: the gateway decides what the model sees,
 * instead of hoping the model decides to look.
 *
 *  - buildSessionPreamble → get_context / get_core_context, appended to the system prompt
 *    every (re)spawn, so a session never starts cold.
 *  - buildTurnBlock → lightweight keyword search per user message, injected
 *    alongside the message; deduped per session via `seen`.
 */

const CJK_RUN = /[一-鿿]{2,6}/g;
const LATIN_WORD = /[a-zA-Z][a-zA-Z0-9_-]{2,}/g;

const STOPWORDS = new Set([
  '什么', '怎么', '怎么样', '可以', '没有', '现在', '今天', '明天', '时候', '就是',
  '但是', '然后', '这个', '那个', '不是', '知道', '觉得', '还是', '已经', '所以',
  '因为', '如果', '我们', '你们', '他们', '不过', '还有', '一下', '一个', '有点',
  '真的', '感觉', '应该', '需要', '问题', '东西', '事情', '时间', '直接', '其实',
  'the', 'and', 'for', 'you', 'not', 'with', 'that', 'this', 'have', 'are',
]);

// 无分词器的穷人版切词：先按常见虚词把中文切成短语，再提取词元。
// "周六要去看示例活动的演唱会" → 周六 / 示例活动 / 演唱会
const CJK_PARTICLES =
  /[的了是在有要去看和跟把给对就都也很会能别不得着过吗呢吧啊呀哦嘛啦么这那哪你我他她它们]/g;

export function shanghaiTimeString(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('weekday')} ${get('hour')}:${get('minute')}:${get('second')} CST (Asia/Shanghai)`;
}

/**
 * sqlite 的 `created_at` 是 `datetime('now')` 写下的 UTC 文本（`YYYY-MM-DD HH:MM:SS`），
 * 渲染成上海时间必须 +8，语义同 migrations/0014_usage_daily.sql 的 `date(created_at, '+8 hours')`。
 * 输出形如 `2026-07-24 周五 09:05 CST`；解析失败返回空串，调用方据此省略时间前缀。
 */
export function shanghaiStamp(sqliteUtc: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    (sqliteUtc ?? '').trim()
  );
  if (!m) return '';
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? '0')
  );
  if (!Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('weekday')} ${get('hour')}:${get('minute')} CST`;
}

export type MessageTimeLabel = '本轮新消息' | '历史消息' | '历史摘要';

/**
 * 模型侧消息时间锚点。label 必须说明这条内容属于当前未读窗口还是历史，
 * 否则即使给了当前时钟，模型仍可能把旧正文里的“今晚/刚才”投射到现在。
 */
export function timestampedMessage(
  text: string,
  sqliteUtc: string | null | undefined,
  label: MessageTimeLabel
): string {
  const stamp = shanghaiStamp(sqliteUtc);
  return `[${stamp || '时间未知'}｜${label}] ${text}`;
}

export function injectTurnTime(text: string): string {
  return [
    text,
    '',
    '<TURN_TIME_PRELOADED|网关注入，禁止调用 get_turn_time>',
    `上海时间：${shanghaiTimeString()}`,
    '</TURN_TIME_PRELOADED>',
  ].join('\n');
}

export interface KeywordPlan {
  primary: string[];
  fragments: string[];
  all: string[];
}

export function extractKeywordPlan(text: string, max = 4): KeywordPlan {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(CJK_PARTICLES, ' ');
  const runs = [
    ...(cleaned.match(LATIN_WORD) ?? []),
    ...(cleaned.match(CJK_RUN) ?? []),
  ].map((w) => w.trim());

  const primary = [...new Set(runs)].filter(
    (w) => w.length >= 2 && !STOPWORDS.has(w.toLowerCase())
  );
  primary.sort((a, b) => b.length - a.length);

  // 三字碎片只用于长词不足时的召回兜底，不能越过任何完整词元抢查询名额。
  const primarySet = new Set(primary);
  const fragments = [...new Set(primary.flatMap((word) =>
    /[一-鿿]/.test(word) && word.length >= 5
      ? [word.slice(0, 3), word.slice(-3)]
      : []
  ))].filter((word) => !primarySet.has(word) && !STOPWORDS.has(word.toLowerCase()));
  const all = [...primary, ...fragments].slice(0, max);
  return {
    primary: primary.slice(0, max),
    fragments: fragments.slice(0, Math.max(max - primary.length, 0)),
    all,
  };
}

export function extractKeywords(text: string, max = 4): string[] {
  return extractKeywordPlan(text, max).all;
}

export interface MemoryIdentityContext {
  id: string;
  name: string;
  backend: string;
}

export type MemoryPreambleMode = 'full' | 'compact' | 'off';

export function identityGuard(contact: MemoryIdentityContext): string {
  const name = contact.name.replace(/\s+/g, ' ').trim().slice(0, 80) || contact.id;
  return [
    '# 当前会话身份边界（高于记忆正文）',
    `- 你当前是联系人「${name}」（id: ${contact.id}，backend: ${contact.backend}）。`,
    '- 共享记忆里的其他 AI、frontmatter source、日记来源标记和第一人称叙事都只是第三人称资料；知道其经历不等于经历属于你，禁止改写成“我/我们”。',
    `- 只有明确属于「${name}」或当前对话刚发生的事才可第一人称承接；文字冲突或归属不明时，以当前联系人身份为准并保持第三人称。`,
    '- 称呼归属有方向，两个方向分别执行：',
    `- 你 → User 不泛化：只用记忆明确写明「${name}」可用的称呼；不明时直呼其名，不借用其他关系线的称呼。`,
    '- User → 你泛化：她在当前会话里对你说的伴侣称呼、爱称或关系角色词，就是在叫当前对话对象；直接接住，不因历史映射而拒领、纠正或声明别的身份。接住称呼不改变你的身份。',
  ].join('\n');
}

/**
 * 工作流预载标记：与 TURN_TIME_PRELOADED / MEMORY_CONTEXT_PRELOADED 同构。
 * 触发条件必须是模型能自证的（"本提示里有没有这个标记"），不能是"这是不是新会话"——
 * grok-cli 每轮新进程重烤 system prompt，"新会话"技术上每轮为真，于是会话中途去
 * read_file 全局工作流，流程性自语漏给 User。必须保持静态以维持 prompt-cache 前缀稳定。
 * B 类瘦身：只压表述，不改边界（标记自证 / 禁止重读全局工作流 / 流程自语不进回复）。
 */
export const WORKFLOW_PRELOADED = [
  '<WORKFLOW_PRELOADED|网关注入，每轮都在>',
  '- 本提示已给全本会话工作流（身份边界、记忆预载、口吻与工具权限）；禁止再 read_file `_meta/cli/global-agent-workflow.md` 或其他全局流程文件，“先确认一下”也不行。',
  '- 判据只看本标记在不在，不要用“这是不是新会话”判断——那个状态你无法自证。流程自语不进回复。',
  '</WORKFLOW_PRELOADED>',
].join('\n');

/**
 * 静态时间解释规则：不依赖记忆库。
 * C2：仅在有对话回放 / 历史摘要 / 既有消息上下文时注入；纯新会话无历史可省。
 * 红线：回放或历史摘要在场时必须同场。
 */
export const TEMPORAL_CONTEXT_RULES = [
  '# 时间语义（网关强制）',
  '- TURN_TIME_PRELOADED 只表示本轮当前时间，不会自动给历史消息补发生时间。',
  '- `[时间｜本轮新消息]` 才是本轮刚送达的输入；`[时间｜历史消息]` 与 `[时间｜历史摘要]` 都是过去记录。',
  '- 历史正文里的“今晚、今天、昨天、刚才、最近”等相对时间，只能相对该条消息开头的绝对时间解释，禁止顺延成当前 TURN_TIME。',
  '- 只有本轮新消息明确重新提起旧事，才能把旧话题当作当前话题；不能仅因历史记录排在上下文末尾就声称它刚发生。',
].join('\n');

/** Contact-level NSFW craft switch. Default intimate demotes always-on resident cost. */
export type NsfwCraftMode = 'always' | 'intimate' | 'off';

/**
 * 亲密场景书写工艺 compact 块：不依赖模型自觉 search_vault。
 * 全文细则在 vault memories/nsfw-writing-rules.md（2026-08-09 工艺重写）；
 * 此处只常驻触发条件 + 硬约束，与全文保持同向。
 * 必须保持静态（无时间戳/联系人名），以免破坏 Anthropic prompt-cache 前缀稳定性。
 */
export function nsfwCraftCompact(): string {
  return [
    '# NSFW 书写工艺（网关 compact，亲密场景强制）',
    '- 触发：进入亲密/性/身体向描写时立刻执行；纯工程与日常事务不主动起色。',
    '- 感官密度：关键动作单元至少落地一种触感与一种可观察反馈；连续段落保持双方身体存在。不要求每句机械重复；绝不隐晦。',
    '- 器官词具体（鸡巴/肉棒/阴茎/囊袋/铃口/马眼、小穴/小逼/屄/阴蒂、奶子/乳头/乳尖、屁股、爱液/蜜汁等），并随关系/语气/强度变语域；同段不机械轮换；禁「下面」「那里」式回避。',
    '- 禁止笼统形容词（「很舒服」「红肿」）单独交差；五感服务动作（触温压摩擦、视充血/体液光泽、听湿响与碎呼吸、嗅味按叙事需要）。',
    '- 动作闭环：意图/试探 → 接触 → 双方反馈 → 读取 → 调位置/力度/节奏；禁止只罗列动作不响应。',
    '- 双向描写：稳定主视角，关键反馈处写入双方感受（含你侧温度压力涨感与她侧反应）；避免报告式来回切镜头。',
    '- 节奏有阶段（试探→有效刺激→调整→累积→释放→余韵）；篇幅服从当轮，增篇幅须带来新阶段/反馈/情绪，禁同义复述与循环注水。',
    '- 完整细则在记忆库 nsfw-writing-rules；本块是强制下限，不是上限。',
  ].join('\n');
}

/** Intimate-scene markers: positive hit → inject craft (hard + soft affection). */
const INTIMATE_SCENE_RE =
  /亲密|性爱|做爱|床上|亲吻|亲亲|爱抚|高潮|射精|插入|含住|鸡巴|肉棒|阴茎|小穴|小逼|阴蒂|乳头|奶子|屁股|爱液|湿润|呻吟|性感|脱衣|裸体|抱抱|抱紧|想你|爱你|贴贴|摸[摸我你]|sex|fuck|cock|pussy|orgasm|nude|erotic|nsfw/i;

/**
 * Independent pure-engineering markers used only to *skip* inject when no intimate hit.
 * Contract: require MULTIPLE independent engineering signals on the same turn to skip.
 * A single signal never skips — mixed intimate + sparse eng words must fail-open inject.
 * (Comment/impl alignment: 多个工程信号才 skip；单信号不 skip；漏报优先注入。)
 */
const ENGINEERING_SIGNAL_RES: RegExp[] = [
  /\bgit\b/i,
  /\bnpm\b/i,
  /\bnpx\b/i,
  /\bcommit\b/i,
  /\bdeploy\b/i,
  /\btypescript\b/i,
  /\beslint\b/i,
  /\bwebpack\b/i,
  /\bdocker\b/i,
  /\bkubectl\b/i,
  /\bCI\/CD\b/i,
  /\btypecheck\b/i,
  /单元测试/,
  /集成测试/,
  /构建失败/,
  /合并冲突/,
  /迁移脚本/,
  /pull request/i,
];

/** Minimum independent engineering signals required to skip nsfwCraft injection. */
const MIN_ENGINEERING_SIGNALS_TO_SKIP = 2;

/** Count distinct engineering signal categories present in text (for tests / gates). */
export function countEngineeringSignals(text: string): number {
  let n = 0;
  for (const re of ENGINEERING_SIGNAL_RES) {
    if (re.test(text)) n += 1;
  }
  return n;
}

/**
 * Intimate scene detector for nsfwCraft=intimate.
 * Fail-open: empty/uncertain text → inject. Only confident non-intimate skips.
 * Saving tokens must never drop craft rules on real intimate turns.
 */
export function isIntimateScene(text: string | null | undefined): boolean {
  const raw = (text ?? '').trim();
  if (!raw) return true;
  if (INTIMATE_SCENE_RE.test(raw)) return true;
  // Strip fenced code so large patches don't drown signal; then re-check remainder.
  const withoutCode = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]+`/g, ' ').trim();
  if (!withoutCode) return true;
  if (INTIMATE_SCENE_RE.test(withoutCode)) return true;
  // Only skip when MULTIPLE independent engineering signals fire (not a single weak hit).
  // Single signal → fail-open inject so intimate + sparse eng words never false-skip.
  if (
    countEngineeringSignals(withoutCode) >= MIN_ENGINEERING_SIGNALS_TO_SKIP &&
    withoutCode.length < 4000
  ) {
    return false;
  }
  return true;
}

/** Whether the NSFW craft block should appear for this mode + optional scene text. */
export function shouldInjectNsfwCraft(
  mode: NsfwCraftMode | null | undefined,
  sceneText?: string | null
): boolean {
  const resolved: NsfwCraftMode = mode ?? 'intimate';
  if (resolved === 'off') return false;
  if (resolved === 'always') return true;
  return isIntimateScene(sceneText);
}

export interface SessionPreambleOptions {
  /** Contact-level NSFW craft switch; default intimate (not in static preamble). */
  nsfwCraft?: NsfwCraftMode;
}

export async function buildSessionPreamble(
  vault: VaultClient,
  contact: MemoryIdentityContext,
  mode: MemoryPreambleMode = 'full',
  opts: SessionPreambleOptions = {}
): Promise<string> {
  if (mode === 'off') return '';
  let ctx: string;
  if (mode === 'compact') {
    try {
      // compact 是明确的预算边界：只常驻 active pinned/high facts；其余内容依赖
      // 每轮 search_vault 与模型按需 read_file。source 必须显式传，不能随 vault
      // 默认值漂移回 narrative。
      ctx = await vault.call('get_core_context', { source: 'compact' });
    } catch {
      try {
        // 兼容旧版只接受无参数 get_core_context 的 Memory Vault；即使它返回 narrative，
        // 也比退回带全量索引的 get_context 更符合 compact 的预算语义。
        ctx = await vault.call('get_core_context');
      } catch {
        // 最老的外部 Memory Vault 没有 get_core_context，最后才退回完整上下文。
        ctx = await vault.call('get_context');
      }
    }
  } else {
    ctx = await vault.call('get_context');
  }
  // identityGuard 只注入一次：full 路径曾在前缀首尾各塞一份，白白翻倍身份边界 token。
  // compact 同样依赖这一份 guard 保住身份边界，勿删。
  // nsfwCraft=always 时才进 session preamble（静态前缀）；intimate 改走 per-turn fail-open。
  const guard = identityGuard(contact);
  const nsfwMode: NsfwCraftMode = opts.nsfwCraft ?? 'intimate';
  const nsfwCraft = nsfwMode === 'always' ? nsfwCraftCompact() : '';
  // B 类：MEMORY_CONTEXT_PRELOADED 标记与预载声明合并成一条，TURN_TIME 禁令并入同一行。
  const memoryMarker = mode === 'full'
    ? '<MEMORY_CONTEXT_PRELOADED|full> 网关已完整注入 get_context；禁止本会话首轮再调 get_context（仅见“记忆库上下文不可用”可重试）。TURN_TIME 每轮网关注入，禁止 get_turn_time。'
    : '<MEMORY_CONTEXT_PRELOADED|compact> 网关已注入 active pinned/high compact facts；禁止 get_context 扩全量，细节用 search_vault / read_file。TURN_TIME 每轮网关注入，禁止 get_turn_time。';
  return [
    '',
    memoryMarker,
    guard,
    ...(nsfwCraft ? ['', nsfwCraft] : []),
    '',
    `# 记忆库上下文（${mode === 'compact' ? 'compact 核心版' : '完整版'}，网关自动注入）`,
    `版本：${mode}-v2`,
    '',
    ctx,
    '',
    '——以上为网关注入的记忆快照。动态细节和话题深挖请用 search_vault / read_file 查最新。',
  ].join('\n');
}

export const PREAMBLE_UNAVAILABLE = [
  '',
  '# 记忆库上下文',
  '⚠ 网关拉取记忆库失败（服务暂时不可用）。请在回复前主动调用 memory-vault 的 get_context 重试；若也失败，坦率告诉 User 记忆暂时离线。',
].join('\n');

/**
 * search_vault 只返回标题/路径/片段，没有 updated/created 字段（见 vault `_meta/mcp_server.py`），
 * 唯一不改 vault 接口就能拿到的日期是 diary/inbox 的日期文件名。拿得到就补锚点，拿不到就不补。
 */
function dateAnchor(path: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(path.split('/').pop() ?? '');
  return m ? `（记于 ${m[0]}）` : '';
}

export interface VaultSearchHit {
  title: string;
  path: string;
  snippet: string;
}

/** Parse the stable two-line search_vault result without discarding its relevance snippet. */
export function parseVaultSearchResults(result: string): VaultSearchHit[] {
  const hits: VaultSearchHit[] = [];
  for (const line of result.split('\n')) {
    const match = line.match(/^- \*\*(.+)\*\* \(`(.+)`\)/);
    if (match) {
      hits.push({ title: match[1], path: match[2], snippet: '' });
      continue;
    }
    const snippet = line.match(/^\s*>\s*(.+)$/);
    if (snippet && hits.length > 0 && !hits[hits.length - 1].snippet) {
      hits[hits.length - 1].snippet = snippet[1].replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return hits;
}

/** Search the vault for terms from the user message; returns a compact block or null. */
export async function buildTurnBlock(
  vault: VaultClient,
  userText: string,
  seen: Set<string>,
  maxChars: number
): Promise<string | null> {
  const keywordPlan = extractKeywordPlan(userText);
  const keywords = keywordPlan.all;
  if (keywords.length === 0) return null;

  const lines: string[] = [];
  const maxEntries = 3;
  let budget = maxChars;

  const append = (hit: VaultSearchHit): boolean => {
    if (seen.has(hit.path) || lines.length >= maxEntries) return false;
    const titleLine = `- **${hit.title}** (\`${hit.path}\`)`.slice(0, 200) + dateAnchor(hit.path);
    const snippetLine = hit.snippet ? `\n  > ${hit.snippet}` : '';
    const separator = lines.length > 0 ? 1 : 0;
    let entry = titleLine + snippetLine;
    if (entry.length + separator > budget) entry = titleLine;
    if (entry.length + separator > budget) return false;
    seen.add(hit.path);
    lines.push(entry);
    budget -= entry.length + separator;
    return true;
  };

  const search = async (query: string): Promise<VaultSearchHit[]> => {
    try {
      const result = await vault.call('search_vault', { query }, 0);
      return result.startsWith('没有找到') ? [] : parseVaultSearchResults(result);
    } catch {
      return [];
    }
  };

  // Native multi-term AND is the highest-precision pass. Fragments never enter it.
  const andTerms = keywordPlan.primary.slice(0, 3);
  if (andTerms.length >= 2) {
    const precise = await search(andTerms.join(' '));
    for (const hit of precise) {
      append(hit);
      if (lines.length >= maxEntries || budget <= 0) break;
    }
  }

  if (lines.length < maxEntries && budget > 0) {
    const resultSets = await Promise.all(keywords.map((keyword) => search(keyword)));
    const positions = resultSets.map(() => 0);
    let progressed = true;
    while (progressed && lines.length < maxEntries && budget > 0) {
      progressed = false;
      for (let index = 0; index < resultSets.length; index++) {
        const results = resultSets[index];
        while (positions[index] < results.length) {
          const hit = results[positions[index]++];
          progressed = true;
          if (append(hit)) break;
        }
        if (lines.length >= maxEntries || budget <= 0) break;
      }
    }
  }

  if (lines.length === 0) return null;
  return lines.join('\n');
}

/** Wrap the raw user message with the injected search block (raw text stays first). */
export function wrapTurnText(userText: string, block: string | null): string {
  if (!block) return userText;
  return [
    userText,
    '',
    '<记忆库检索|网关自动注入，User 看不到这段。相关就用，不相关忽略；细节用 read_file 深挖>',
    block,
    '</记忆库检索>',
  ].join('\n');
}
