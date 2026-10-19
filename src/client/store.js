/**
 * 设置持久化：三条路依次降级，任何一条通就算成功。
 *
 * 1. 官方 ConfigForms（`ctx.configForms`）：与 profile 配置同源、可被 `dsh config` 读到。
 * 2. 插件自己的只读/只写路由（`/session-live/api/settings`）：宿主有 webServer 就可用。
 * 3. localStorage：仅本机浏览器生效，最后兜底。
 *
 * 之所以要三级：官方 configForms 的 entry 是 profile 插件条目，只有插件被
 * profile 正式登记时才有；路由不看登记方式；localStorage 永远在。
 */

import { PLUGIN_ID, ROUTE_PREFIX, normalizeSettings, defaultSettings } from './logic.js';

export const STORAGE_KEY = `${PLUGIN_ID}:settings`;

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch (_error) {
    return null;
  }
}

/** 本地兜底读取。 */
export function readLocal() {
  const storage = safeStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (typeof raw !== 'string' || raw === '') return null;
    return normalizeSettings(JSON.parse(raw));
  } catch (_error) {
    return null;
  }
}

/** 本地兜底写入。 */
export function writeLocal(settings) {
  const storage = safeStorage();
  if (storage === null) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 设置通道。
 *
 * 用一个极小的订阅器做主分发：hover 组件订阅它，设置页写它，
 * 之后所有改动自动同步到所有已挂载的卡片（无需刷新页面）。
 */
export function createSettingsStore(ctx) {
  let current = readLocal() || defaultSettings();
  let transport = 'local';
  const listeners = new Set();

  function publish(next, nextTransport) {
    current = normalizeSettings(next);
    if (nextTransport !== undefined) transport = nextTransport;
    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch (_error) {
        /* 单个订阅者出错不能拖垮其他订阅者 */
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** 从宿主拉一次（路由优先，其次 configForms）。 */
  async function load() {
    const viaRoute = await loadFromRoute();
    if (viaRoute !== null) {
      publish(viaRoute, 'route');
      return current;
    }
    const viaForms = await loadFromForms();
    if (viaForms !== null) {
      publish(viaForms, 'config');
      return current;
    }
    publish(current, 'local');
    return current;
  }

  async function loadFromRoute() {
    try {
      if (typeof fetch !== 'function') return null;
      const url = new URL(`${ROUTE_PREFIX.replace(/^\/+/, '')}/api/settings`, document.baseURI);
      url.searchParams.set('plugin', PLUGIN_ID);
      const response = await fetch(url.href, { credentials: 'same-origin' });
      if (!response.ok) return null;
      const body = await response.json();
      if (!body || typeof body !== 'object' || typeof body.settings !== 'object') return null;
      return body.settings;
    } catch (_error) {
      return null;
    }
  }

  function formOf() {
    try {
      // 走 ctx.get(name, false) 逃生路径：裸读未 inject 的服务会抛
      // `cannot get property "configForms" without inject`。
      const forms =
        typeof ctx?.get === 'function' ? ctx.get('configForms', false) : ctx && ctx.configForms;
      if (!forms || typeof forms.get !== 'function') return null;
      const form = forms.get(PLUGIN_ID);
      if (!form || typeof form.getSnapshot !== 'function') return null;
      return form;
    } catch (_error) {
      return null;
    }
  }

  async function loadFromForms() {
    const form = formOf();
    if (form === null) return null;
    try {
      const snapshot = form.getSnapshot();
      if (!snapshot || snapshot.status !== 'ready') return null;
      const value = snapshot.value;
      if (!value || typeof value !== 'object') return null;
      if (value.settings && typeof value.settings === 'object') return value.settings;
      return value;
    } catch (_error) {
      return null;
    }
  }

  /** 写回。顺序：configForms → 路由 → localStorage。 */
  async function save(next) {
    const settings = normalizeSettings(next);
    publish(settings, undefined);

    const viaForms = await saveToForms(settings);
    if (viaForms) {
      transport = 'config';
      return { ok: true, transport };
    }
    const viaRoute = await saveToRoute(settings);
    if (viaRoute) {
      transport = 'route';
      return { ok: true, transport };
    }
    const viaLocal = writeLocal(settings);
    transport = viaLocal ? 'local' : 'memory';
    return { ok: viaLocal, transport };
  }

  async function saveToForms(settings) {
    const form = formOf();
    if (form === null) return false;
    try {
      const snapshot = form.getSnapshot();
      if (!snapshot || snapshot.status !== 'ready' || snapshot.writable === false) return false;
      // 逐字段 set，官方表单按 field 落盘；字段缺失说明宿主 schema 与插件版本不一致，
      // 那种情况下整体放弃，交给路由兜底。
      let wrote = 0;
      for (const key of Object.keys(settings)) {
        const value = settings[key];
        try {
          await form.set(key, value);
          wrote += 1;
        } catch (_error) {
          /* 单字段失败不中断，最后按写成功数判断 */
        }
      }
      return wrote > 0;
    } catch (_error) {
      return false;
    }
  }

  async function saveToRoute(settings) {
    try {
      if (typeof fetch !== 'function') return false;
      const url = new URL(`${ROUTE_PREFIX.replace(/^\/+/, '')}/api/settings`, document.baseURI);
      const response = await fetch(url.href, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plugin: PLUGIN_ID, settings }),
      });
      return response.ok;
    } catch (_error) {
      return false;
    }
  }

  return {
    get() {
      return current;
    },
    transport() {
      return transport;
    },
    subscribe,
    load,
    save,
    /** 只改一项，返回值与 save 一致。 */
    patch(key, value) {
      const next = { ...current, [key]: value };
      return save(next);
    },
  };
}
