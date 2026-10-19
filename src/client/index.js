/**
 * 浏览器半边入口：往两个官方插槽里挂东西，再向宿主注册文案。
 *
 * 这里刻意只用 seed 白名单里的模块（react 及自身的相对路径），
 * 不 value-import 任何 @deepseek-ai/* 包 —— 客户端的 bundle purity gate
 * 在构建期会直接 throw，运行期 require 也会 miss module table。
 */

import {
  NS,
  HOVER_SLOT,
  HOVER_SLOT_ID,
  HOVER_SLOT_ORDER,
  SETTINGS_SLOT,
  SETTINGS_SLOT_ID,
  SETTINGS_SLOT_ORDER,
  rowOfSnapshot,
} from './logic.js';
import { createSettingsStore } from './store.js';
import { createHoverPanel } from './HoverPanel.js';
import { createSettingsPage } from './SettingsPage.js';
import { CSS_TEXT } from './styles.js';
import { zh, en } from './locale.js';

export const name = 'dsh-session-live';
/**
 * 声明 apply 里立刻要用的服务。
 *
 * `sessions` 必须声明：cordis 只等待 inject 里列出的服务，没列出时 apply
 * 可能在该服务挂上之前就跑，readService 读到 undefined —— 那不是崩溃，
 * 而是更隐蔽的「面板永远读不到行数据」。官方参考实现 dsh-better-sidebar
 * 的客户端 inject 同样声明了 sessions。
 *
 * 运行时仍走 readService 二次兜底：宿主版本漂移导致服务缺失时降级而非 pending。
 */
export const inject = ['slots', 'locale', 'sessions'];

const STYLE_TAG_ID = 'dsh-session-live/client.css';

/**
 * 安全读服务。
 *
 * cordis 的 `Context` 是 Proxy，读「未 inject 且未被提供」的服务名会**直接抛**
 * `cannot get property "X" without inject`，而不是返回 undefined。
 * 一旦在 apply 顶部裸读一个当时还没就绪的服务，插件 fiber 立刻进 FAILED 态，
 * 加载器会把该 entry 标成 `disabled: true` —— 这就是 `dsh-session-live: failed` 的成因。
 *
 * `ctx.get(name, false)` 是同一 get trap 的保留逃生路径（strict=false 时不抛）。
 */
export function readService(ctx, name) {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name, false);
      if (viaGet !== undefined) return viaGet;
    }
  } catch (_error) {
    /* 旧版 cordis 无 ctx.get，走下面的兜底 */
  }
  try {
    return ctx[name];
  } catch (_error) {
    return undefined;
  }
}

/** 幂等注入样式：重复装载不会产生第二个 <style>。 */
export function ensureStyle() {
  if (typeof document === 'undefined') return;
  try {
    if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
    const tag = document.createElement('style');
    tag.dataset.plugin = name;
    tag.dataset.pluginCss = STYLE_TAG_ID;
    tag.textContent = CSS_TEXT;
    document.head.appendChild(tag);
  } catch (_error) {
    /* 样式失败只影响观感，不该阻断功能 */
  }
}

/**
 * 从会话列表快照里按 id 取行。
 * 宿主 hover 插槽只给 sessionId，而 useProjection 绑定"当前会话"，
 * 所以这里必须走列表快照 —— 那是宿主已算好的整值，零 I/O。
 *
 * 权威形态是 `byId` 字典（见 logic.js 的 rowOfSnapshot 注释），
 * 不是 `items` 数组 —— 写错这一处会让面板永远不渲染。
 */
export function createRowReader(sessions) {
  return function getRow(sessionId) {
    if (!sessions || typeof sessions !== 'object') return undefined;
    try {
      const list = sessions.list;
      if (!list || typeof list.getSnapshot !== 'function') return undefined;
      return rowOfSnapshot(list.getSnapshot(), sessionId);
    } catch (_error) {
      return undefined;
    }
  };
}

/** 订阅会话列表，任何会话的投影变化都会让卡片重读一次行数据。 */
export function createRowSubscription(sessions) {
  return function subscribeRows(listener) {
    if (!sessions || typeof sessions !== 'object') return () => {};
    try {
      const list = sessions.list;
      if (!list || typeof list.subscribe !== 'function') return () => {};
      const dispose = list.subscribe(listener);
      return typeof dispose === 'function' ? dispose : () => {};
    } catch (_error) {
      return () => {};
    }
  };
}

export function apply(ctx, requireFn) {
  // 全部服务走 readService：裸读会让插件在服务未就绪时直接 FAILED。
  const logger = readService(ctx, 'logger');
  ensureStyle();

  // 宿主把 require 作为 apply 的第二参传进来（第二参默认是 config）。
  // 拿不到就退化为「面板不渲染」：宁可少一块 UI，也不能让插件抛错。
  const loadReact = typeof requireFn === 'function' ? requireFn : readService(ctx, 'require');
  const react = typeof loadReact === 'function' ? loadReact('react') : undefined;
  const sessions = readService(ctx, 'sessions');
  const locale = readService(ctx, 'locale');
  const store = createSettingsStore(ctx);

  // 文案：宿主语言未定时回落到中文字面量，绝不显示空白。
  const translate = (key) => {
    try {
      const bound = typeof ctx.t === 'function' ? ctx.t(NS) : null;
      const text = bound ? bound(key) : null;
      if (typeof text === 'string' && text !== '' && text !== key) return text;
    } catch (_error) {
      /* 未绑定语言时走本地表 */
    }
    return zh[key] || en[key] || key;
  };

  if (locale && typeof locale.register === 'function') {
    try {
      ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-session-live: locale');
    } catch (_error) {
      if (logger && typeof logger.warn === 'function') logger.warn(_error);
    }
  }

  const getRow = createRowReader(sessions);
  const subscribeRows = createRowSubscription(sessions);

  // 卡片渲染时读一次行，列表变化时重读 —— 用最小的重绘面换取实时性。
  const rowCache = new Map();
  function readRow(sessionId) {
    const cached = rowCache.get(sessionId);
    if (cached !== undefined) return cached;
    const row = getRow(sessionId);
    if (row !== undefined) rowCache.set(sessionId, row);
    return row;
  }
  try {
    ctx.effect(
      () =>
        subscribeRows(() => {
          rowCache.clear();
        }),
      'dsh-session-live: rows',
    );
  } catch (_error) {
    /* 订阅不上就退化为「打开卡片那一次读」，功能仍在 */
  }

  const HoverPanel = createHoverPanel({
    getRow: readRow,
    store,
    react: react || {},
    translate,
  });
  const SettingsPage = createSettingsPage({
    store,
    react: react || {},
    translate,
    version: '0.1.0',
  });

  // 悬停卡片插槽：list 槽，按 order 参与排序。
  const slots = readService(ctx, 'slots');
  if (slots && typeof slots.inject === 'function') {
    const t = (key) => {
      try {
        const bound = typeof ctx.t === 'function' ? ctx.t(NS) : undefined;
        const text = typeof bound === 'function' ? bound(key) : undefined;
        if (typeof text === 'string' && text !== '' && text !== key) return text;
      } catch (_error) {
        /* 未绑定语言时走本地表 */
      }
      return zh[key] || en[key] || key;
    };

    try {
      slots.inject(HOVER_SLOT, () =>
        slots.register(
          { name: HOVER_SLOT, id: HOVER_SLOT_ID, order: HOVER_SLOT_ORDER, locale: NS },
          HoverPanel,
        ),
      );
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn(error);
    }

    // 独立设置页：settings.section 是 list 槽，多个插件各占一节。
    // `label` 必填——宿主的设置导航直接渲染它，缺了就是一条空白项，用户点不到。
    try {
      slots.inject(SETTINGS_SLOT, () =>
        slots.register(
          {
            name: SETTINGS_SLOT,
            id: SETTINGS_SLOT_ID,
            order: SETTINGS_SLOT_ORDER,
            locale: NS,
            label: () => t('settings.nav'),
          },
          SettingsPage,
        ),
      );
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn(error);
    }
  }

  // 启动即拉一次设置，避免第一张卡片用默认值闪一下。
  store.load();
}

export { zh, en, CSS_TEXT };

/*
 * 这里**故意不写** `export default`。
 *
 * 宿主的 `cordis-plugin-loader` 会用 `unwrapExports` 规范化模块导出，其实现是
 * `exports = exports.default ?? exports` —— 一旦存在 default 导出，整个命名空间
 * 会被 default 对象顶替，挂在具名导出上的属性（最典型的就是宿主半边必需的
 * `Config`）随即丢失。客户端半边当前不吃这个亏，但作为参考实现必须与宿主半边
 * 保持同一纪律：**永远不要 default 导出**。
 */
