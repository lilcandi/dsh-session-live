/**
 * 客户端半边的纯逻辑：视图渲染文案、状态推导、设置归一化。
 *
 * 刻意与 React 组件分离：这些函数全部无副作用、可单测，
 * 也让 client.js 的 bundle 里「DOM 与文案」和「数据整形」互不纠缠。
 */

import {
  PROJECTION_KEY as SHARED_PROJECTION_KEY,
  ROUTE_PREFIX as SHARED_ROUTE_PREFIX,
  SETTINGS_SPEC as SHARED_SETTINGS_SPEC,
  defaultSettings as defaultsShared,
  normalizeSettings as normalizeShared,
} from '../shared.js';

export const PLUGIN_ID = 'dsh-session-live';
export const NS = 'dsh-session-live';
export const PROJECTION_KEY = SHARED_PROJECTION_KEY;
export const ROUTE_PREFIX = SHARED_ROUTE_PREFIX;
export const SETTINGS_ENTRY_ID = 'dsh-session-live';
export const HOVER_SLOT = 'sidebar.session.row.hover';
export const HOVER_SLOT_ID = 'live-activity';
export const HOVER_SLOT_ORDER = 150;
export const SETTINGS_SLOT = 'settings.section';
export const SETTINGS_SLOT_ID = 'dsh-session-live';
export const SETTINGS_SLOT_ORDER = 300;

export const SETTINGS_SPEC = SHARED_SETTINGS_SPEC;

export function defaultSettings() {
  return defaultsShared();
}

/** 把任意输入归一化成合法设置（页面、本地存储、宿主返回都走这一条）。 */
export function normalizeSettings(input) {
  return normalizeShared(input);
}

/** 毫秒 → 人类可读的短时长。刻意不用 t()，两种语言下都是同一套数字。 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return '<1s';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** token 数 → 面板里的短记法（292K / 1.2M），刻意不本地化。 */
export function formatTokens(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return '';
  if (count < 1000) return String(Math.round(count));
  if (count < 100000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (count < 1000000) return `${Math.round(count / 1000)}K`;
  return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** 会话已发生的对话轮数（宿主 view 下发的 turn，0 表示还没开始）。 */
export function turnCount(activity) {
  const turn = activity && typeof activity.turn === 'number' ? activity.turn : 0;
  return Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : 0;
}

/**
 * 读宿主内置的 tokenUsage 投影 —— 本插件不自己折 token，只消费宿主已算好的值。
 *
 * 依据（源码核实）：
 *   `@deepseek-ai/dsh-token-meter` 注册 key='tokenUsage'，stateVersion=2，
 *   wire.view 返回 {uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}；
 *   会话列表快照（dsh-api-session-controller/lib/types/list.js 的 projectionsFor）
 *   调 `cachedSnapshot(session)` / `cache.cachedSnapshot(header)` 时**不传 keys**，
 *   而 registry 的 `keys === void 0 → 全量返回所有带 wire 的注册投影**，
 *   所以这一行值在 `row.projectionValues.tokenUsage` 上直接可见。
 *
 * 容错：热会话首帧可能还没有该单位的 cell（registry 里 cell 缺失即跳过），
 * 因此返回 null 是正常状态，调用方必须容忍缺失、不能因此不渲染面板。
 */
export function tokenUsageOf(row) {
  if (!row || typeof row !== 'object') return null;
  const values = row.projectionValues;
  if (!values || typeof values !== 'object') return null;
  const usage = values.tokenUsage;
  if (!usage || typeof usage !== 'object') return null;
  const read = (key) => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const uncached = read('uncachedInputTokens');
  const cacheRead = read('cacheReadTokens');
  const cacheWrite = read('cacheWriteTokens');
  const output = read('outputTokens');
  const input = uncached + cacheRead + cacheWrite;
  const total = input + output;
  if (total <= 0) return null;
  return { uncached, cacheRead, cacheWrite, input, output, total };
}

/** 活动类别 → 单字符图标。跨语言通用，不依赖字体图标库。 */
export const CATEGORY_GLYPH = {
  read: '◍',
  readImage: '◍',
  search: '⌕',
  write: '✎',
  edit: '✎',
  commands: '❯',
  code: '❯',
  webSearch: '⌕',
  webFetch: '⌕',
  subagents: '⧉',
  plan: '☑',
  questions: '?',
  tools: '•',
};

export function glyphOf(category) {
  return CATEGORY_GLYPH[category] || CATEGORY_GLYPH.tools;
}

/**
 * 由投影值 + 列表行快照推导出最终展示状态。
 * 这是整个插件的语义核心：官方 hover 卡片只给 running/idle 两态，
 * 这里补上 thinking / tool / error / compaction 的区分。
 *
 * @param activity 宿主下发的 liveActivity 投影值（可能为 undefined）
 * @param row 会话列表行（可选，用于 running 兜底）
 * @param now 当前时间戳
 */
export function deriveState(activity, row, now) {
  const current = typeof now === 'number' ? now : Date.now();
  const running =
    (row && typeof row.running === 'boolean' ? row.running : false) ||
    (activity && activity.running === true);
  if (!activity) {
    return { kind: running ? 'running' : 'idle', since: 0, category: '', label: '' };
  }
  const tool = activity.tool;
  if (running && tool && tool.name) {
    const startedAt = typeof tool.startedAt === 'number' ? tool.startedAt : activity.toolStart;
    return {
      kind: 'tool',
      since: typeof startedAt === 'number' ? startedAt : 0,
      category: tool.category || 'tools',
      label: tool.name,
    };
  }
  if (running) {
    const startedAt =
      typeof activity.stepStart === 'number' && activity.stepStart > 0
        ? activity.stepStart
        : typeof activity.turnStart === 'number'
          ? activity.turnStart
          : 0;
    return { kind: 'thinking', since: startedAt, category: 'tools', label: '' };
  }
  if (activity.error && activity.error.label) {
    return {
      kind: activity.error.kind === 'interrupted' ? 'interrupted' : 'error',
      since: typeof activity.errorAt === 'number' ? activity.errorAt : 0,
      category: 'tools',
      label: activity.error.label,
    };
  }
  return { kind: 'idle', since: 0, category: '', label: '' };
}

/** 本轮已运行多久（客户端本地补齐，宿主 view 里恒为 0）。 */
export function elapsedSince(start, now) {
  if (typeof start !== 'number' || start <= 0) return 0;
  const current = typeof now === 'number' ? now : Date.now();
  return Math.max(0, current - start);
}

/**
 * 从会话列表快照行里取投影值。
 * 官方 hover 插槽只传 sessionId，所以这里做「按 id 找行」的适配。
 *
 * 仅用于旧形态快照（`{ items: [...] }`）的兜底遍历；当前宿主的权威形态是
 * `byId` 字典，走 rowOfSnapshot。
 */
export function findRow(items, sessionId) {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (item && String(item.id !== undefined ? item.id : item.sessionId) === String(sessionId)) {
      return item;
    }
  }
  return undefined;
}

/**
 * 从会话列表快照里按 sessionId 取行 —— 这是「悬停面板能否拿到数据」的唯一入口。
 *
 * 权威形态（已核实 dsh-api-session-controller/lib/client.js 的 projectList）：
 *   `sessions.list.getSnapshot()` → `{ ids, byId, phase, projectionsBySession }`
 *   其中 `byId[sessionId]` 行自带 `projectionValues`（:4161 的展开），
 *   官方全部消费者（workspace / subagent / terminal）都读 `byId`。
 *
 * 历史缺陷：本插件曾只读 `snapshot.items` —— 那个字段在会话列表快照里并不存在
 * （`items` 属于 manager.getListSnapshot() 的另一形态），于是 getRow 恒为 undefined，
 * 面板恒不渲染。这里把 `items` 降级为兜底分支，并加断言测试钉死形状。
 */
export function rowOfSnapshot(snapshot, sessionId) {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const key = String(sessionId);

  // 1) 权威：byId 字典，行上直接带 projectionValues。
  const byId = snapshot.byId;
  if (byId && typeof byId === 'object' && byId[key]) return byId[key];

  // 2) 兜底：旧形态快照的数组遍历。
  const legacy = findRow(snapshot.items, key);
  if (legacy !== undefined) return legacy;

  // 3) 兜底：行尚未进列表（子代理会话延迟登记）时，读已实例化的投影存储。
  const projections = snapshot.projectionsBySession;
  if (projections && typeof projections === 'object' && projections[key]) {
    const values = projections[key].values;
    if (values) return { sessionId: key, projectionValues: values, running: false };
  }
  return undefined;
}

/** 从列表行挑出本插件要的三个投影键。 */
export function activityOfRow(row) {
  if (!row || typeof row !== 'object') return undefined;
  const values = row.projectionValues;
  if (!values || typeof values !== 'object') return undefined;
  const value = values[PROJECTION_KEY];
  return value && typeof value === 'object' ? value : undefined;
}

/** 是否有值得渲染的内容（全关时直接不渲染，避免插入空 div 影响卡片布局）。 */
export function hasContent(activity, settings, row) {
  if (!settings || settings.enabled === false) return false;
  const state = deriveState(activity, row, 0);
  if (settings.showActivity && state.kind !== 'idle') return true;
  if (settings.showError && activity && activity.error) return true;
  if (settings.showCompaction && activity && activity.compaction) return true;
  if (settings.showPreview && activity && (activity.prompt || activity.reply)) return true;
  if (settings.showRecent && settings.recentCount > 0 && activity && activity.recent && activity.recent.length > 0) {
    return true;
  }
  if (settings.showActivity && activity && activity.lastTool && state.kind !== 'tool') return true;
  if (settings.showImage && activity && activity.image && validImage(activity.image)) return true;
  if (settings.showModel && activity && validModel(activity.model)) return true;
  if (settings.showUsage && (turnCount(activity) > 0 || tokenUsageOf(row) !== null)) return true;
  return false;
}

/** 图片记录合法性：attachmentId 必须是 sha256 形态（与宿主折叠器白名单同规）。 */
export function validImage(image) {
  return Boolean(
    image &&
      typeof image === 'object' &&
      typeof image.attachmentId === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(image.attachmentId),
  );
}

/** 模型记录合法性：provider/model 至少一个非空。 */
export function validModel(model) {
  return Boolean(
    model &&
      typeof model === 'object' &&
      ((typeof model.model === 'string' && model.model !== '') ||
        (typeof model.provider === 'string' && model.provider !== '')),
  );
}

/** 模型显示名：优先裸模型名，缺了回落 provider。 */
export function modelLabel(model) {
  if (!validModel(model)) return '';
  const name = typeof model.model === 'string' ? model.model : '';
  const provider = typeof model.provider === 'string' ? model.provider : '';
  return name !== '' ? name : provider;
}

/**
 * 面板里显示的模型短名：丢掉路径/provider 前缀，只留最后一段。
 * 完整名（如 magpie/commandcode-plan/deepseek/deepseek-v4.1-flash）
 * 在窄卡片里会被 CSS 截成 `commandcod...`——那才是真正不直白的东西。
 */
export function shortModel(label) {
  if (typeof label !== 'string' || label === '') return '';
  const parts = label.split('/');
  const tail = parts[parts.length - 1].trim();
  return tail !== '' ? tail : label;
}

/** 图片路由 URL：ref 已在宿主白名单内，type 供服务端挑 Content-Type。 */
export function imageUrl(image) {
  if (!validImage(image)) return '';
  const params = new URLSearchParams();
  params.set('ref', image.attachmentId);
  if (typeof image.mediaType === 'string' && image.mediaType !== '') params.set('type', image.mediaType);
  return routeUrl(`${ROUTE_PREFIX}/api/image?${params.toString()}`);
}

/** 路由 URL：必须相对页面基，不能以 / 开头（反代前缀下会 404）。 */
export function routeUrl(path) {
  const base =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined'
        ? location.href
        : 'http://localhost/';
  const clean = String(path).replace(/^\/+/, '');
  return new URL(clean, base).href;
}
