import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { ContactRow, Db, WorkerRow } from '../db.js';
import type { TaobaoBridge } from '../workers/taobaoBridge.js';
import type { CompanionHeartbeat } from './companionHeartbeat.js';
import { contactConfig, openContact } from './configSchemas.js';
import { defineGatewayTool, type GatewayTool } from './gatewayTool.js';

/**
 * Taobao desktop-client tools exposed to heartbeat contacts as `taobao_<name>`.
 * The catalog is a static, token-trimmed mirror of the client's own tools/list
 * (taobao-native-mcp 1.0.0, 22 tools, captured 2026-09-02); the required
 * `sourceApp` argument is injected by the gateway and hidden from the model.
 * Which subset a contact sees is a per-contact policy (`heartbeat.taobao.mode`, default cart):
 *   browse — look, search, scroll, open pages; nothing that changes her account
 *   cart   — browse + favorite clicks (legacy config name)
 *   full   — every tool, including Wangwang messages, ratings and raw key events
 */

export type TaobaoMode = 'browse' | 'cart' | 'full';
export const TAOBAO_MODES: TaobaoMode[] = ['browse', 'cart', 'full'];
export const TAOBAO_TOOL_PREFIX = 'taobao_';
const SOURCE_APP = 'ai-hub';
const MAX_MODEL_TEXT_CHARS = 20_000;

interface CatalogProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  enum?: string[];
  items?: ZodTypeAny;
}

export interface TaobaoCatalogEntry {
  name: string;
  description: string;
  properties: Record<string, CatalogProperty>;
  required?: string[];
  /** Lowest mode that may call the tool. */
  minMode: TaobaoMode;
}

const str = (description: string, enumValues?: string[]): CatalogProperty =>
  ({ type: 'string', description, ...(enumValues ? { enum: enumValues } : {}) });
const num = (description: string): CatalogProperty => ({ type: 'number', description });
const bool = (description: string): CatalogProperty => ({ type: 'boolean', description });
const arr = (description: string, items: ZodTypeAny): CatalogProperty => ({ type: 'array', description, items });

export const TAOBAO_TOOL_CATALOG: TaobaoCatalogEntry[] = [
  {
    name: 'list_available_pages',
    description: '列出淘宝客户端所有预设页面名及链接。不确定 navigate 的 page 时先调这个。',
    properties: {},
    minMode: 'browse',
  },
  {
    name: 'navigate',
    description: '打开淘宝预设页面（home/cart/order/message/my/collect/coupon/miaosha/tmall/taobaolive 等）。cart/order 页可带 searchKey 自动筛选。',
    properties: {
      page: str('页面名；不确定就先 taobao_list_available_pages'),
      searchKey: str('导航后自动搜索的关键词，仅 cart / order 页支持'),
    },
    required: ['page'],
    minMode: 'browse',
  },
  {
    name: 'navigate_to_url',
    description: '在淘宝客户端打开一个已知存在的淘宝/天猫链接（如搜索结果里的商品详情页）。禁止编造 URL。',
    properties: { url: str('淘宝/天猫可信域名下的有效链接') },
    required: ['url'],
    minMode: 'browse',
  },
  {
    name: 'close_page',
    description: '关闭当前任务页面（首页除外）。逛完调一下，别把页面留给她收拾。',
    properties: {},
    minMode: 'browse',
  },
  {
    name: 'get_current_tab',
    description: '获取当前标签页的 URL 和标题。',
    properties: {},
    minMode: 'browse',
  },
  {
    name: 'read_page_content',
    description: '读取当前页面可见文本（默认最多 5000 字）。truncated 时用 offset 分段继续读；scope 用 CSS 选择器缩小范围。商品页会自动带出 [商品图] 链接。',
    properties: {
      scope: str('CSS 选择器，限定读取范围'),
      maxLength: num('最大字符数，默认 5000'),
      offset: num('起始字符位置，默认 0，用于分段读取'),
    },
    minMode: 'browse',
  },
  {
    name: 'scroll_page',
    description: '滚动页面。',
    properties: {
      direction: str('up / down / top / bottom', ['up', 'down', 'top', 'bottom']),
      selector: str('滚动到该 CSS 选择器对应元素（优先于 direction）'),
      amount: num('滚动像素数，默认 80% 屏高'),
    },
    minMode: 'browse',
  },
  {
    name: 'scan_page_elements',
    description: '扫描可交互元素，返回带 [index] 的列表，供 taobao_click_element 使用。强烈建议传 filter 缩小体积。',
    properties: {
      filter: str('只返回包含该关键词的元素行'),
      scope: str('CSS 选择器，限定扫描范围'),
    },
    minMode: 'browse',
  },
  {
    name: 'click_element',
    description: '点击元素：index（scan_page_elements 的序号，精确）或 text（文本模糊匹配）。返回 pageChanges。disabled=true 时不要重试。',
    properties: {
      index: num('scan_page_elements 返回的序号'),
      text: str('文本关键词（模糊匹配）'),
    },
    minMode: 'browse',
  },
  {
    name: 'inspect_page',
    description: '诊断当前页面 DOM 状态（SKU 选择器、按钮、弹窗），用于排查操作为什么失败。',
    properties: {},
    minMode: 'browse',
  },
  {
    name: 'search_products',
    description: '搜索商品或店铺，返回商品列表（标题、价格、店铺、销量）。type=shop 搜店铺。',
    properties: {
      keyword: str('搜索关键词'),
      type: str('all=商品（默认）、shop=店铺、tmall=天猫、22pc_b=企业购、pc_taobao=淘宝', ['all', 'shop', 'tmall', '22pc_b', 'pc_taobao']),
    },
    required: ['keyword'],
    minMode: 'browse',
  },
  {
    name: 'get_product_skus',
    description: '读取商品详情页的 SKU 维度和可选规格。不传 itemId 就读当前页。',
    properties: { itemId: str('商品 ID（可选，提供则先导航到该商品）') },
    minMode: 'browse',
  },
  {
    name: 'get_browse_history',
    description: '读取她最近的浏览历史：商品 / 搜索词 / 店铺。',
    properties: { type: str('product / search / shop', ['product', 'search', 'shop']) },
    required: ['type'],
    minMode: 'browse',
  },
  {
    name: 'add_to_cart',
    description: '加入购物车（自动处理 SKU 与弹窗）。sku 必须与页面维度数量一致；传空数组可拿到 availableSkus。needsSkuSelection=true 时要告诉她让她自己选，不能替她换规格。加购成功后必须开口告诉她加了什么、为什么，不能只回 HEARTBEAT_OK。',
    properties: {
      itemId: str('商品 ID（可选，提供则先导航到该商品）'),
      sku: arr('SKU 属性值数组，如 ["黑色", "XL"]', z.string()),
    },
    minMode: 'cart',
  },
  {
    name: 'input_text',
    description: '向输入框填入文本。submit=true 自动回车。旺旺输入框会被自动识别。',
    properties: {
      text: str('要输入的文本'),
      index: num('scan_page_elements 返回的序号'),
      placeholder: str('placeholder 关键词（模糊匹配）'),
      scope: str('CSS 选择器，限定查找范围'),
      submit: bool('输入后按回车提交，默认 false'),
    },
    required: ['text'],
    minMode: 'full',
  },
  {
    name: 'image_search',
    description: '以图搜图。imagePath 为 PC 本地绝对路径、图片 URL 或 base64 data URL。',
    properties: { imagePath: str('本地绝对路径 / CDN 地址 / base64 数据') },
    required: ['imagePath'],
    minMode: 'full',
  },
  {
    name: 'open_chat',
    description: '打开旺旺聊天并给商家发消息（复合工具）。source 不传时按当前页面自动判断。',
    properties: {
      source: str('cart / order / search；不传则自动判断', ['cart', 'order', 'search']),
      productName: str('商品关键词（cart / order 场景）'),
      query: str('搜索关键词（search 场景）'),
      message: str('要发送的消息'),
      imagePath: str('要发送的图片路径'),
    },
    minMode: 'full',
  },
  {
    name: 'send_chat_message',
    description: '在已打开的旺旺页面继续发消息。',
    properties: {
      message: str('消息内容'),
      imagePath: str('要发送的图片路径'),
    },
    minMode: 'full',
  },
  {
    name: 'submit_product_rating',
    description: '填写并提交商品评价（评价页唯一方式）。首次评价需三项评分；多商品必须用 qualityContents 且每条不同。',
    properties: {
      qualityContent: str('单商品评价内容'),
      qualityContents: arr('多商品评价内容数组，长度等于商品数且各不相同', z.string()),
      merDsr: num('描述相符 1-5'),
      serviceQualityScore: num('卖家服务 1-5'),
      saleConsignmentScore: num('物流服务 1-5'),
      isAppend: bool('是否追加评价'),
      serviceContent: str('服务评价内容'),
      imageUrls: arr('图片路径数组，最多 5 张', z.string()),
      anonymous: bool('是否匿名，默认 true'),
      submit: bool('是否自动点击提交，默认 true'),
    },
    minMode: 'full',
  },
  {
    name: 'trigger_keyboard_event',
    description: '触发一次键盘事件（key 或 keyCode 二选一，可带修饰键）。',
    properties: {
      key: str('按键名，如 Enter / Escape / ArrowDown / a'),
      keyCode: num('按键 keyCode'),
      eventType: str('keydown / keyup / keypress', ['keydown', 'keyup', 'keypress']),
      ctrlKey: bool('Ctrl'),
      altKey: bool('Alt'),
      shiftKey: bool('Shift'),
      metaKey: bool('Meta'),
      target: str('目标元素 CSS 选择器'),
      delay: num('触发后等待毫秒'),
    },
    minMode: 'full',
  },
  {
    name: 'trigger_key_sequence',
    description: '连续触发按键序列或逐字输入文本。',
    properties: {
      sequence: arr('按键事件数组', z.object({
        key: z.string().optional(),
        keyCode: z.number().optional(),
        eventType: z.enum(['keydown', 'keyup', 'keypress']).optional(),
        ctrlKey: z.boolean().optional(),
        altKey: z.boolean().optional(),
        shiftKey: z.boolean().optional(),
        metaKey: z.boolean().optional(),
        delay: z.number().optional(),
      }).passthrough()),
      text: str('逐字输入的文本'),
      target: str('目标元素 CSS 选择器'),
      interval: num('按键间隔毫秒，默认 50'),
    },
    minMode: 'full',
  },
  {
    name: 'hold_keyboard_key',
    description: '长按某个按键。',
    properties: {
      key: str('按键名'),
      keyCode: num('按键 keyCode'),
      duration: num('持续毫秒，默认 500'),
      ctrlKey: bool('Ctrl'),
      altKey: bool('Alt'),
      shiftKey: bool('Shift'),
      metaKey: bool('Meta'),
      target: str('目标元素 CSS 选择器'),
      repeatEvents: bool('长按期间重复 keydown'),
      repeatInterval: num('重复间隔毫秒'),
    },
    minMode: 'full',
  },
];

const MODE_RANK: Record<TaobaoMode, number> = { browse: 0, cart: 1, full: 2 };

/** click_element text that would change her account in browse / cart mode. */
const GUARDED_CLICK_TEXT = /购买|下单|提交|付款|结算|支付|发送|删除|确认收货|退款|退货|评价|领取|领券|关注|收藏|加入购物车|加购/;

export function normalizeTaobaoMode(value: unknown): TaobaoMode {
  return typeof value === 'string' && (TAOBAO_MODES as string[]).includes(value) ? value as TaobaoMode : 'browse';
}

export function taobaoCatalogForMode(mode: TaobaoMode): TaobaoCatalogEntry[] {
  // Keep the native catalog for schema compatibility, but never offer broken add-to-cart in heartbeats.
  return TAOBAO_TOOL_CATALOG.filter((entry) => entry.name !== 'add_to_cart' && MODE_RANK[entry.minMode] <= MODE_RANK[mode]);
}

export function taobaoToolNames(mode: TaobaoMode): string[] {
  return taobaoCatalogForMode(mode).map((entry) => `${TAOBAO_TOOL_PREFIX}${entry.name}`);
}

/** Per-contact Taobao policy resolved from the stored config; null = tools not offered. */
export function taobaoModeFor(cfg: { heartbeat?: { enabled?: boolean; taobao?: { enabled?: boolean; mode?: unknown } } }): TaobaoMode | null {
  if (cfg.heartbeat?.enabled !== true) return null;
  if (cfg.heartbeat.taobao?.enabled === false) return null;
  return normalizeTaobaoMode(cfg.heartbeat.taobao?.mode);
}

function zodFor(property: CatalogProperty): ZodTypeAny {
  let schema: ZodTypeAny;
  if (property.enum) schema = z.enum(property.enum as [string, ...string[]]);
  else if (property.type === 'number') schema = z.number();
  else if (property.type === 'boolean') schema = z.boolean();
  else if (property.type === 'array') {
    if (!property.items) throw new Error('Taobao array properties require a typed item schema');
    schema = z.array(property.items);
  }
  else schema = z.string();
  return schema.describe(property.description);
}

export function taobaoInputShape(entry: TaobaoCatalogEntry): ZodRawShape {
  const required = new Set(entry.required ?? []);
  const shape: ZodRawShape = {};
  for (const [key, property] of Object.entries(entry.properties)) {
    const schema = zodFor(property);
    shape[key] = required.has(key) ? schema : schema.optional();
  }
  return shape;
}

/** Zod raw shapes keyed by the exposed `taobao_<name>`, for the hub MCP server. */
export const TAOBAO_INPUT_SHAPES: Record<string, ZodRawShape> = Object.fromEntries(
  TAOBAO_TOOL_CATALOG.map((entry) => [`${TAOBAO_TOOL_PREFIX}${entry.name}`, taobaoInputShape(entry)]),
);

export function taobaoGuidance(mode: TaobaoMode): string {
  const policy = mode === 'browse'
    ? '当前是 browse 模式：只看不动手——不加购、不下单、不给商家发消息、不改她的购物车和订单，网关也会拦这些动作。'
    : mode === 'cart'
      ? '当前是 cart 模式：可以搜索浏览和收藏商品，不加购物车、不下单、不付款、不给商家发消息。只逛可以沉默；收藏后必须开口告诉她收藏了什么、为什么，不能只回 HEARTBEAT_OK。'
      : '当前是 full 模式：可以收藏商品、联系商家和评价，不加购物车，但付款永远由 User 本人完成，涉及花钱或对外发消息前先跟她确认。只逛可以沉默；收藏了商品或给商家发了消息必须开口告诉她，不能只回 HEARTBEAT_OK。';
  return [
    '淘宝：心跳窗口内可用 taobao_* 工具逛 User 登录着的淘宝桌面客户端，同样只在心跳激活且 PC Worker 在线时可用。',
    policy,
    ...(mode !== 'browse' ? ['收藏路径：先读取商品页并用 taobao_scan_page_elements 确认收藏按钮；未收藏时用 taobao_click_element 的 text（收藏/收藏宝贝/收藏商品/加入收藏）点击，不传 index。已经收藏就跳过，不能取消收藏；点击后读取页面确认状态，确认不了就如实说明，不能声称成功或反复点击。不要调用加购工具或点击加购按钮。'] : []),
    '典型路径：taobao_search_products → taobao_navigate_to_url 进商品页 → taobao_read_page_content；逛完调 taobao_close_page。',
    '淘宝里看到的东西可以拿来聊，但不要把她的地址、订单号、聊天记录等隐私复述进持久记忆。取不到结果就作罢，不要用别的工具或命令绕过。',
  ].join(' ');
}

const TAOBAO_FAILURE_SUFFIX = '拿不到淘宝结果就作罢，不要用别的工具或命令绕过。';

function failure(text: string): { ok: false; text: string } {
  return { ok: false, text: `${text}\n${TAOBAO_FAILURE_SUFFIX}` };
}

export function taobaoWorkerOnline(db: Db): boolean {
  const rows = db.prepare(
    `SELECT * FROM workers
     WHERE last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-70 seconds')`
  ).all() as WorkerRow[];
  return rows.some((row) => {
    try {
      return JSON.parse(row.capabilities || '{}').taobao === true;
    } catch {
      return false;
    }
  });
}

/**
 * The Taobao client double-wraps results: content[0].text is itself a JSON
 * document with its own `content` array whose text is the real payload.
 * Peel every layer so the model reads the innermost text only.
 */
export function flattenTaobaoContent(blocks: Array<{ type: string; text?: string }>): string {
  const parts: string[] = [];
  const visit = (text: string, depth: number) => {
    if (depth < 4) {
      try {
        const parsed = JSON.parse(text) as { content?: unknown };
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) {
          for (const inner of parsed.content as Array<{ type?: string; text?: string }>) {
            if (inner?.type === 'text' && typeof inner.text === 'string') visit(inner.text, depth + 1);
          }
          return;
        }
      } catch {
        // plain text
      }
    }
    parts.push(text);
  };
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') visit(block.text, 0);
  }
  const joined = parts.join('\n').trim();
  return joined.length > MAX_MODEL_TEXT_CHARS
    ? `${joined.slice(0, MAX_MODEL_TEXT_CHARS)}\n…[淘宝返回已截断，用 offset 分段读取]`
    : joined;
}

export function buildTaobaoTools(
  bridge: TaobaoBridge,
  heartbeat: CompanionHeartbeat,
  db: Db,
  contactId: string,
  mode: TaobaoMode,
): GatewayTool[] {
  return taobaoCatalogForMode(mode).map((entry) => defineGatewayTool({
    name: `${TAOBAO_TOOL_PREFIX}${entry.name}`,
    description: entry.description,
    inputSchema: TAOBAO_INPUT_SHAPES[`${TAOBAO_TOOL_PREFIX}${entry.name}`],
    exec: async (input) => {
      const row = db.prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
        .get(contactId) as ContactRow | undefined;
      const currentMode = row ? taobaoModeFor(contactConfig(openContact(row))) : null;
      if (!currentMode) return failure('这个联系人没有开启心跳淘宝权限。');
      if (MODE_RANK[entry.minMode] > MODE_RANK[currentMode]) {
        return failure(`taobao_${entry.name} 在 ${currentMode} 模式下不可用。`);
      }
      if (!heartbeat.isActive(contactId)) {
        return failure('心跳窗口未激活，淘宝不可用。让 User 在运行时面板开启心跳后再试。');
      }
      if (entry.name === 'click_element') {
        const text = typeof input.text === 'string' ? input.text : '';
        if (/加入购物车|加购物车|加购/.test(text)) return failure('心跳已改为收藏商品，不再加购物车。');
        const favorite = currentMode === 'cart' && input.index === undefined && /^(收藏|收藏宝贝|收藏商品|加入收藏)$/.test(text);
        if (currentMode !== 'full' && GUARDED_CLICK_TEXT.test(text) && !favorite) {
          return failure(`${currentMode} 模式下不点「${text}」这类会改动她账户的按钮。`);
        }
      }
      if (!taobaoWorkerOnline(db)) return failure('当前没有在线且开放淘宝桥接的 PC Worker。');
      const result = await bridge.request(
        contactId,
        entry.name,
        { ...input, sourceApp: SOURCE_APP },
      );
      if (!result.ok) return failure(result.text);
      const text = flattenTaobaoContent(result.content ?? []);
      return {
        ok: result.isError !== true,
        text: text || (result.isError ? '淘宝客户端返回了错误但没有说明。' : '（淘宝客户端没有返回文本）'),
      };
    },
  }));
}
