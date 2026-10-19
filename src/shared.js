/**
 * 客户端两半之间的共享常量与语义（不依赖 DOM、不依赖 React）。
 *
 * 宿主半边与浏览器半边都从这里取同一份定义：
 * 投影键、路由前缀、设置项规格。任何一侧改了名字，另一侧自动跟上。
 */

export const PLUGIN_ID = 'dsh-session-live';
export const PROJECTION_KEY = 'liveActivity';
/**
 * 折叠状态的行结构版本。只有**字段集或字段校验口径**变化时才允许 +1。
 *
 * v2 = 16 字段（含 model / image）。
 * v4（本轮的问答直白化、token 用量行）**只改了取值语义**：截断长度、
 * prompt/reply 的抽取方式、tool/result 不再写 reply —— 字段集与
 * isCompleteState 的校验逐条未变，因此**必须留在 2**。
 *
 * 为什么这个数字不能随便升：宿主 fold 路径遇到 `row.ver !== stateVersion`
 * 会从 seq 0 全量重放（有事件的会话能自愈），但 `viewCheckpoint` 路径
 * 直接丢弃版本不符的行。两者叠加的后果是 —— **不活跃的历史会话永远
 * 不会产生新事件、永远不重放，liveActivity 就此永久空白**。
 * 白白升级 = 白白丢掉所有老会话的画面。
 */
export const STATE_VERSION = 2;
export const ROUTE_PREFIX = '/session-live';
export const API_BASE = `${ROUTE_PREFIX}/api`;
export const SETTINGS_ENTRY_ID = 'dsh-session-live';

/** 设置项规格：设置页、hover 面板、自检脚本共用同一份，杜绝三处漂移。 */
export const SETTINGS_SPEC = [
  {
    key: 'enabled',
    kind: 'boolean',
    default: true,
    zh: '启用悬停实时预览',
    en: 'Enable hover live preview',
    zhHelp: '关闭后悬停卡片不再插入任何内容。',
    enHelp: 'When off, the hover card gains nothing.',
  },
  {
    key: 'showActivity',
    kind: 'boolean',
    default: true,
    zh: '显示当前活动行',
    en: 'Show current activity line',
    zhHelp: '正在跑的工具（名称 + 参数摘要 + 已运行时长）。',
    enHelp: 'The tool currently running, with its argument summary and elapsed time.',
  },
  {
    key: 'showRecent',
    kind: 'boolean',
    default: true,
    zh: '显示最近工具序列',
    en: 'Show recent tool sequence',
    zhHelp: '最近若干次工具调用的小图标条。',
    enHelp: 'A compact strip of the most recent tool calls.',
  },
  {
    key: 'showPreview',
    kind: 'boolean',
    default: true,
    zh: '显示内容预览',
    en: 'Show content preview',
    zhHelp: '最近一条用户提示与助手回复摘要。',
    enHelp: 'One-line previews of the latest prompt and reply.',
  },
  {
    key: 'showTiming',
    kind: 'boolean',
    default: true,
    zh: '显示耗时',
    en: 'Show timing',
    zhHelp: '本轮 / 当前步 / 当前工具已运行多久。',
    enHelp: 'How long the turn, step, or tool has been running.',
  },
  {
    key: 'showError',
    kind: 'boolean',
    default: true,
    zh: '显示异常',
    en: 'Show errors',
    zhHelp: '工具失败、轮次异常终止、被中断。',
    enHelp: 'Tool failures, aborted turns, interrupted streams.',
  },
  {
    key: 'showCompaction',
    kind: 'boolean',
    default: true,
    zh: '显示压缩标记',
    en: 'Show compaction marker',
    zhHelp: '上下文压缩发生时给一条提示。',
    enHelp: 'A hint when context compaction happened.',
  },
  {
    key: 'showImage',
    kind: 'boolean',
    default: true,
    zh: '显示最近图片',
    en: 'Show latest image',
    zhHelp: '最近一条用户消息里的图片缩略图。',
    enHelp: 'A thumbnail of the latest image from user messages.',
  },
  {
    key: 'showModel',
    kind: 'boolean',
    default: true,
    zh: '显示模型名称',
    en: 'Show model name',
    zhHelp: '会话当前使用的模型（provider/model）。',
    enHelp: 'The model currently in use (provider/model).',
  },
  {
    key: 'showUsage',
    kind: 'boolean',
    default: true,
    zh: '显示用量与轮数',
    en: 'Show usage and turns',
    zhHelp: '把对话轮数、token 用量、模型名合并成一行摘要。',
    enHelp: 'Turn count, token usage, and model name on one summary line.',
  },
  {
    key: 'dense',
    kind: 'boolean',
    default: false,
    zh: '紧凑模式',
    en: 'Compact mode',
    zhHelp: '减少行距与字号，适合长会话列表。',
    enHelp: 'Tighter spacing and smaller type for long session lists.',
  },
  {
    key: 'recentCount',
    kind: 'number',
    default: 5,
    min: 0,
    max: 12,
    step: 1,
    zh: '最近工具条长度',
    en: 'Recent tool strip length',
    zhHelp: '0 表示隐藏。',
    enHelp: '0 hides the strip.',
  },
];

export function defaultSettings() {
  const out = {};
  for (const spec of SETTINGS_SPEC) out[spec.key] = spec.default;
  return out;
}

/** 把任意输入归一化成合法设置（页面、本地存储、宿主返回都走这一条）。 */
export function normalizeSettings(input) {
  const out = defaultSettings();
  if (input === null || typeof input !== 'object') return out;
  for (const spec of SETTINGS_SPEC) {
    if (!Object.prototype.hasOwnProperty.call(input, spec.key)) continue;
    const value = input[spec.key];
    if (spec.kind === 'boolean') {
      if (typeof value === 'boolean') out[spec.key] = value;
      else if (value === 'true' || value === '1' || value === 1) out[spec.key] = true;
      else if (value === 'false' || value === '0' || value === 0) out[spec.key] = false;
      continue;
    }
    if (spec.kind === 'number') {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) continue;
      const min = typeof spec.min === 'number' ? spec.min : 0;
      const max = typeof spec.max === 'number' ? spec.max : 100;
      out[spec.key] = Math.min(max, Math.max(min, Math.round(num)));
    }
  }
  return out;
}
