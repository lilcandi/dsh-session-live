/**
 * React 组件：悬停卡片里的实时活动面板。
 *
 * 关键约束（源码核实）：`sidebar.session.row.hover` 的 owner 只给 sessionId，
 * 客户端拿不到该会话的 useProjection。所以数据从会话列表快照的行里读——
 * 宿主已经算好的整值，读它不产生任何 I/O，符合"悬停零往返"的纪律。
 */

import {
  NS,
  HOVER_SLOT,
  deriveState,
  elapsedSince,
  formatDuration,
  formatTokens,
  glyphOf,
  hasContent,
  imageUrl,
  modelLabel,
  shortModel,
  tokenUsageOf,
  turnCount,
  validImage,
} from './logic.js';
import { createImageViewer } from './viewer.js';

const h = (type, props, ...children) => ({ type, props, children });

/** 每秒一次的重绘时钟：只在卡片可见时跑，且只更新一个 tick 值。 */
function useTick(active) {
  const [tick, setTick] = useStateValue(0);
  useEffectValue(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [active, tick]);
  return tick;
}

// 下面两个别名在 getReact() 注入后指向真实的 React hooks，
// 让组件函数保持纯声明式的写法，同时避免在模块顶层 import（seed 白名单约束）。
let useStateValue = () => [0, () => {}];
let useEffectValue = () => {};
let useMemoValue = (fn) => fn();
let useSyncValue = () => undefined;

export function bindHooks(react) {
  useStateValue = react.useState;
  useEffectValue = react.useEffect;
  useMemoValue = react.useMemo;
  useSyncValue = typeof react.useSyncExternalStore === 'function' ? react.useSyncExternalStore : () => undefined;
}

/** 订阅设置 store，任何一端改动都立即反映到所有已打开（及之后打开）的卡片。 */
function useSettings(store) {
  return useSyncValue(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
}

function classes(dense) {
  return dense ? 'dsl-panel dsl-dense' : 'dsl-panel';
}

/**
 * 最近一张用户图片的缩略图。点击放大到原尺寸——遮罩走原生 DOM（见 viewer.js），
 * 因为悬停卡片在鼠标离开时会连整棵 React 树一起消失，挂在树里的大图会跟着没。
 * 加载失败（404 / 损坏）时把 <img> 直接藏掉，整行塌缩，不出破图。
 */
function ImageThumb({ activity, t, viewer }) {
  const image = activity && activity.image;
  if (!validImage(image)) return null;
  const url = imageUrl(image);
  if (url === '') return null;
  const width = typeof image.width === 'number' && image.width > 0 ? image.width : 0;
  const height = typeof image.height === 'number' && image.height > 0 ? image.height : 0;
  const title = width > 0 && height > 0 ? `${t('image.title')} · ${width}×${height}` : t('image.title');
  return h(
    'div',
    { className: 'dsl-thumb-row' },
    h('img', {
      className: 'dsl-thumb',
      src: url,
      alt: t('image.alt'),
      title: `${title} · ${t('image.zoomHint')}`,
      draggable: false,
      onClick: (event) => {
        // 必须掐断冒泡：会话行自身带点击处理，放过去会顺带把会话打开。
        if (event) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        if (viewer) viewer.open(url, { alt: t('image.alt') });
      },
      onError: (event) => {
        const el = event && event.currentTarget;
        if (el && el.style) el.style.display = 'none';
      },
    }),
  );
}

/**
 * 一行概况：对话轮数 · token 用量 · 模型短名。
 *
 * 这三项原本各占一行（模型还单独占一行），在窄卡片里全是冗杂 ——
 * 合并成一行后既省高度，也把「这个会话聊了多少、烧了多少、用哪个模型」
 * 放在同一处读。token 值来自宿主内置的 tokenUsage 投影，不是自己折的。
 */
function UsageLine({ activity, settings, row, t }) {
  if (!settings.showUsage) return null;
  const parts = [];
  const turns = turnCount(activity);
  if (turns > 0) parts.push(`${turns} ${t('usage.turns')}`);
  const usage = tokenUsageOf(row);
  if (usage !== null) parts.push(formatTokens(usage.total));
  const model = activity && activity.model;
  const label = settings.showModel ? shortModel(modelLabel(model)) : '';
  if (label !== '') parts.push(label);
  if (parts.length === 0) return null;
  const effort = model && typeof model.reasoningEffort === 'string' ? model.reasoningEffort : '';
  const head =
    usage === null
      ? t('usage.title')
      : `${t('usage.title')} · ${t('usage.input')} ${formatTokens(usage.input)} · ${t('usage.output')} ${formatTokens(usage.output)}`;
  const title = effort !== '' ? `${head} · ${effort}` : head;
  return h(
    'div',
    { className: 'dsl-row dsl-usage', title },
    h('span', { className: 'dsl-label' }, t('usage.label')),
    h('span', { className: 'dsl-name' }, parts.join(' · ')),
  );
}

function ActivityLine({ activity, state, tick, t, settings }) {
  if (!settings.showActivity) return null;
  if (state.kind === 'tool') {
    const elapsed = settings.showTiming ? formatDuration(elapsedSince(state.since, Date.now())) : '';
    void tick;
    return h(
      'div',
      { className: 'dsl-row dsl-row-live', title: t('activity.title') },
      h('span', { className: 'dsl-glyph dsl-glyph-live' }, glyphOf(state.category)),
      h('span', { className: 'dsl-name' }, state.label || t('activity.tool')),
      activity && activity.tool && activity.tool.detail
        ? h('span', { className: 'dsl-detail' }, activity.tool.detail)
        : null,
      elapsed !== '' ? h('span', { className: 'dsl-time' }, elapsed) : null,
    );
  }
  if (state.kind === 'thinking') {
    const elapsed = settings.showTiming ? formatDuration(elapsedSince(state.since, Date.now())) : '';
    void tick;
    return h(
      'div',
      { className: 'dsl-row dsl-row-live' },
      h('span', { className: 'dsl-glyph dsl-glyph-live' }, '⋯'),
      h('span', { className: 'dsl-name' }, t('activity.thinking')),
      elapsed !== '' ? h('span', { className: 'dsl-time' }, elapsed) : null,
    );
  }
  if (activity && activity.lastTool && activity.lastTool.name) {
    const took =
      settings.showTiming && activity.lastTool.durationMs > 0
        ? formatDuration(activity.lastTool.durationMs)
        : '';
    return h(
      'div',
      { className: 'dsl-row' },
      h(
        'span',
        { className: activity.lastTool.failed ? 'dsl-glyph dsl-glyph-bad' : 'dsl-glyph' },
        glyphOf(activity.lastTool.category),
      ),
      h('span', { className: 'dsl-name' }, activity.lastTool.name),
      activity.lastTool.detail ? h('span', { className: 'dsl-detail' }, activity.lastTool.detail) : null,
      took !== '' ? h('span', { className: 'dsl-time' }, took) : null,
    );
  }
  return null;
}

function RecentStrip({ activity, settings, t }) {
  if (!settings.showRecent || !activity || !Array.isArray(activity.recent)) return null;
  const count = typeof settings.recentCount === 'number' ? settings.recentCount : 0;
  if (count <= 0) return null;
  const items = activity.recent.slice(0, count);
  if (items.length === 0) return null;
  return h(
    'div',
    { className: 'dsl-row dsl-recent', title: t('recent.title') },
    h('span', { className: 'dsl-label' }, t('recent.label')),
    h(
      'span',
      { className: 'dsl-recent-track' },
      ...items.map((item, index) =>
        h(
          'span',
          {
            key: `${index}-${item.name}`,
            className: item.failed ? 'dsl-dot dsl-dot-bad' : 'dsl-dot',
            title: item.detail ? `${item.name} · ${item.detail}` : item.name,
          },
          glyphOf(item.category),
        ),
      ),
    ),
  );
}

function PreviewLines({ activity, settings, t }) {
  if (!settings.showPreview || !activity) return null;
  const prompt = typeof activity.prompt === 'string' ? activity.prompt : '';
  const reply = typeof activity.reply === 'string' ? activity.reply : '';
  if (prompt === '' && reply === '') return null;
  return h(
    'div',
    { className: 'dsl-preview' },
    prompt !== ''
      ? h(
          'div',
          { className: 'dsl-row dsl-preview-row' },
          h('span', { className: 'dsl-label' }, t('preview.prompt')),
          h('span', { className: 'dsl-preview-text' }, prompt),
        )
      : null,
    reply !== ''
      ? h(
          'div',
          { className: 'dsl-row dsl-preview-row' },
          h('span', { className: 'dsl-label' }, t('preview.reply')),
          h('span', { className: 'dsl-preview-text' }, reply),
        )
      : null,
  );
}

function NoticeLines({ activity, state, settings, t }) {
  const rows = [];
  if (settings.showError && state.kind === 'error') {
    rows.push(
      h(
        'div',
        { className: 'dsl-row dsl-row-bad', key: 'error' },
        h('span', { className: 'dsl-glyph dsl-glyph-bad' }, '!'),
        h('span', { className: 'dsl-name' }, t('notice.failed')),
        h('span', { className: 'dsl-detail' }, state.label || ''),
      ),
    );
  }
  if (settings.showError && state.kind === 'interrupted') {
    rows.push(
      h(
        'div',
        { className: 'dsl-row dsl-row-warn', key: 'interrupted' },
        h('span', { className: 'dsl-glyph dsl-glyph-warn' }, '!'),
        h('span', { className: 'dsl-name' }, t('notice.interrupted')),
      ),
    );
  }
  if (settings.showCompaction && activity && activity.compaction) {
    rows.push(
      h(
        'div',
        { className: 'dsl-row dsl-row-dim', key: 'compaction' },
        h('span', { className: 'dsl-glyph' }, '⤵'),
        h('span', { className: 'dsl-name' }, t('notice.compacted')),
      ),
    );
  }
  if (rows.length === 0) return null;
  return h('div', { className: 'dsl-notices' }, ...rows);
}

/**
 * 注册到 `sidebar.session.row.hover` 的组件。
 * props 由宿主给：{ sessionId }，其余是本插件 apply 时注入的闭包。
 */
export function createHoverPanel({ getRow, store, react, translate }) {
  bindHooks(react);
  // 每个面板一个 viewer 实例；实测只会有很少几个（悬停卡片同一时刻只显示一个）。
  const viewer = createImageViewer({ translate });

  return function HoverLiveActivity(props) {
    const sessionId = props && props.sessionId;
    const settings = useSettings(store);
    const row = getRow(sessionId);
    const activity = row && row.projectionValues ? row.projectionValues.liveActivity : undefined;
    const state = deriveState(activity, row, Date.now());
    const live = state.kind === 'tool' || state.kind === 'thinking';
    useTick(live && settings.showTiming);
    const t = translate;

    const content = useMemoValue(
      () => hasContent(activity, settings, row),
      [activity, settings, row],
    );
    if (!content) return null;
    return h(
      'div',
      { className: classes(settings.dense), 'data-plugin': NS, 'data-session': String(sessionId || '') },
      h(ImageThumb, { activity, t, viewer }),
      h(ActivityLine, { activity, state, t, settings }),
      h(UsageLine, { activity, settings, row, t }),
      h(RecentStrip, { activity, settings, t }),
      h(PreviewLines, { activity, settings, t }),
      h(NoticeLines, { activity, state, settings, t }),
    );
  };
}

export const HOVER_SLOT_NAME = HOVER_SLOT;
