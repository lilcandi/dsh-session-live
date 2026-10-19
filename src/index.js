/**
 * 宿主半边：把每个会话的活动折成客户端可见的投影，并提供一条只读设置通道。
 *
 * 设计约束（全部来自本机 DSH 0.2.1-rc.2 源码核实）：
 * - 悬停卡片插槽 `sidebar.session.row.hover` 的 owner 只给 sessionId，
 *   客户端拿不到该会话的 `useProjection`（那个 hook 绑定"当前会话"）。
 *   所以数据必须由宿主提前算好、按 sessionId 推给客户端列表快照。
 * - 客户端可见性由投影单元的 `wire` 决定；有 wire 才会被推。
 * - `apply` 必须同步、返回纯 JSON；无关事件必须返回同一引用，否则每次事件都会推。
 *
 * 因此这里做两件事：
 * 1. 注册 `liveActivity` 投影单元（状态 = 折叠器状态，视图 = 客户端可渲染的最小集）。
 * 2. 注册 `/session-live/api/*` 只读路由，给独立设置页与详情面板取数据。
 */

import { createReadStream, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyActivity, initActivity, isCompleteState, normalizeState, viewActivity } from './activity.js';
import { Config } from './config-schema.js';
import { PLUGIN_ID, PROJECTION_KEY, ROUTE_PREFIX, STATE_VERSION } from './shared.js';

export { Config };

export { PLUGIN_ID, PROJECTION_KEY, STATE_VERSION, ROUTE_PREFIX };

/** 极简 zod 兼容层：宿主投影要求 stateSchema / viewSchema 至少能被当作 schema 使用。 */
function makeSchema(check) {
  return {
    _output: undefined,
    safeParse(value) {
      return check(value)
        ? { success: true, data: value }
        : { success: false, error: { message: `${PLUGIN_ID}: invalid payload` } };
    },
    parse(value) {
      const result = this.safeParse(value);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    optional() {
      return makeSchema((value) => value === undefined || check(value));
    },
    nullable() {
      return makeSchema((value) => value === null || check(value));
    },
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 折叠状态的 schema。
 *
 * 这里**必须字段级校验**，不能只判「是个对象」。
 *
 * 理由链（全部源码核实）：
 *   - 宿主用 `stateSchema.parse(row.val)` 读磁盘 checkpoint
 *     （`dsh-session-projection/lib/index.js:254` viewCheckpoint、`:296` restore）；
 *     判不过就 `continue` 跳过该行。
 *   - 若 schema 只判「是对象」，一行被改写或旧版本写的垃圾（例如
 *     `{totally:'wrong'}`）会被**静默接受**，随后 `wire.view` 产出 10 个
 *     `undefined` 字段（seq/turn/step/prompt/reply/error/compaction/
 *     toolCalls/turnStart/stepStart）—— undefined 不是合法 JSON，会随投影
 *     wire 下发给客户端，也会写回新的 checkpoint 行。
 *   - 严格校验会把垃圾行拦成「跳过」，代价是该行短暂无投影（客户端显示
 *     兜底态）；比下发 undefined 垃圾好。
 *
 * 尺度：只守顶层字段的类型与存在性，不守嵌套结构 —— 嵌套由
 * `viewActivity` 入口的 `normalizeState` 修正。这样旧版本插件多写或少写
 * 一个嵌套字段时不会误杀整行。（顶层 14 字段已用磁盘上 10 条真实 checkpoint
 * 校准：零误杀。）
 */
export function createStateSchema() {
  return makeSchema(isCompleteState);
}

export function createViewSchema() {
  return makeSchema(isPlainObject);
}

/** 投影单元定义。导出以便单测直接驱动，不必启动宿主。 */
export function createProjectionDefinition() {
  return {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: createStateSchema(),
    init() {
      return initActivity();
    },
    apply(state, event) {
      return applyActivity(state, event);
    },
    wire: {
      viewSchema: createViewSchema(),
      view(state) {
        return stableView(state);
      },
    },
  };
}

/**
 * 投影 view 必须是纯读侧：用 Date.now() 会让每次读取都产生新对象，
 * 破坏宿主按 Object.is 做的发布抑制（每条事件都推一次全量）。
 * 所以耗时字段恒为 0，客户端拿边界时间戳自己算「已运行多久」。
 */
const viewCache = new WeakMap();
function stableView(state, running) {
  const cached = state && typeof state === 'object' ? viewCache.get(state) : undefined;
  const value = viewActivity(state, 0, running, cached);
  if (state && typeof state === 'object' && cached === undefined) viewCache.set(state, value);
  return value;
}

/**
 * 安全读取一个 cordis 服务。
 *
 * cordis 的 get trap 对「未声明 inject 的服务名」会直接抛
 * `cannot get property "x" without inject`，而不是返回 undefined ——
 * 这是本插件曾经启动失败的根因（客户端与宿主半边同时踩中）。
 * `ctx.get(name, false)` 是同一个 trap 里的保留逃生路径：strict=false 时
 * 未提供返回 undefined 而不抛。
 *
 * @param ctx cordis 上下文
 * @param name 服务名
 * @returns 服务实例，或 undefined（未提供 / 读不到）
 */
export function readService(ctx, name) {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') return ctx.get(name, false);
  } catch (_error) {
    /* get 本身被拒时退到属性读 */
  }
  try {
    return ctx[name];
  } catch (_error) {
    return undefined;
  }
}

/**
 * 把任意抛出物压成一句可诊断的文本。
 *
 * 设置写入曾经把**所有**异常统一映射成 `false`、再由路由变成 409，
 * 真实原因（`No configurable plugin entry "dsh-session-live"`）被彻底掩盖，
 * 排查绕了很远。失败必须可见，这是那次的教训。
 */
function describeError(error) {
  if (error === null || error === undefined) return 'unknown-error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') {
    const code = error.code !== undefined ? `${error.code}: ` : '';
    return `${code}${error.message}`;
  }
  try {
    return String(error);
  } catch (_error) {
    return 'unprintable-error';
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 只读 API 的实现，路由层只做协议适配。 */
export function createApi(ctx) {
  function projectionsOf(sessionId) {
    try {
      const registry = readService(ctx, 'sessionProjections');
      if (!registry || typeof registry.snapshot !== 'function') return null;
      const session = resolveSession(ctx, sessionId);
      if (session === null) return null;
      return registry.snapshot(session, [PROJECTION_KEY]);
    } catch (_error) {
      return null;
    }
  }

  function listSessions() {
    const items = [];
    try {
      const handle = readService(ctx, 'sessions');
      if (handle && typeof handle.list === 'function') {
        for (const entry of handle.list()) {
          items.push({
            sessionId: String(entry.id !== undefined ? entry.id : entry.sessionId),
            title: entry.title,
            cwd: entry.cwd,
            updatedAt: entry.updatedAt,
          });
        }
      }
    } catch (_error) {
      /* 列表不可用就是空列表，绝不抛给 HTTP 层 */
    }
    return items;
  }

  return {
    /** 一次性返回所有会话的活动快照，供设置页做预览与统计。 */
    overview() {
      const sessions = listSessions();
      const rows = [];
      for (const item of sessions) {
        const snapshot = projectionsOf(item.sessionId);
        const value = snapshot && snapshot.values ? snapshot.values[PROJECTION_KEY] : undefined;
        rows.push({
          sessionId: item.sessionId,
          title: item.title,
          cwd: item.cwd,
          updatedAt: item.updatedAt,
          asOfSeq: snapshot ? snapshot.asOfSeq : -1,
          activity: value === undefined ? null : value,
        });
      }
      return { plugin: PLUGIN_ID, projectionKey: PROJECTION_KEY, sessions: rows };
    },
    /** 单会话详情：折叠状态（含最近工具序列）与渲染视图各一份。 */
    detail(sessionId) {
      const session = resolveSession(ctx, sessionId);
      if (session === null) return null;
      const registry = readService(ctx, 'sessionProjections');
      const state =
        registry && typeof registry.stateOf === 'function'
          ? registry.stateOf(session, PROJECTION_KEY)
          : undefined;
      const snapshot =
        registry && typeof registry.snapshot === 'function'
          ? registry.snapshot(session, [PROJECTION_KEY])
          : null;
      return {
        sessionId: String(sessionId),
        asOfSeq: snapshot ? snapshot.asOfSeq : -1,
        state: state === undefined ? null : state,
        view: state === undefined ? null : viewActivity(state, Date.now(), undefined),
      };
    },
    /** 健康探测：证明插件路由确实挂上了（区别于宿主兜底的 405）。 */
    health() {
      return {
        plugin: PLUGIN_ID,
        version: '0.1.0',
        projectionKey: PROJECTION_KEY,
        hasProjections: Boolean(readService(ctx, 'sessionProjections')),
        hasSessions: Boolean(readService(ctx, 'sessions')),
        hasSettings: Boolean(readService(ctx, 'settings')),
      };
    },
    /** 从 profile 的插件条目配置里读设置；拿不到就返回空对象（客户端会补默认值）。 */
    settings() {
      const document = readSettingsEntry(ctx);
      if (document === null) return {};
      const value = document.value;
      if (value === null || typeof value !== 'object') return {};
      return value.settings && typeof value.settings === 'object' ? value.settings : value;
    },
    settingsWritable() {
      const handle = readService(ctx, 'settings');
      return Boolean(
        handle &&
          typeof handle.update === 'function' &&
          typeof handle.describe === 'function' &&
          handle.writable !== false,
      );
    },
    /**
     * 写设置：只写本插件条目的 `settings` 子树，不碰别的字段。
     *
     * 返回值是 `{ ok, status, reason }` 而不是裸 boolean —— 失败必须能说清是
     * 哪一步坏的（服务缺失 / 条目不可配置 / 版本冲突 / 未预期异常），
     * 路由据此选状态码，运维据此定位。裸 boolean 是上一版的教训。
     */
    saveSettings(settings) {
      const handle = readService(ctx, 'settings');
      if (!handle || typeof handle.update !== 'function') {
        return Promise.resolve({ ok: false, status: 409, reason: 'settings-service-unavailable' });
      }
      const document = readSettingsEntry(ctx);
      if (document === null) {
        return Promise.resolve({
          ok: false,
          status: 409,
          reason: `no-configurable-entry:${PLUGIN_ID}`,
          detail: describeError(
            `SettingsForms 里没有 "${PLUGIN_ID}" 条目。宿主只在插件导出 Config 且含 volatile 字段时登记它。`,
          ),
        });
      }
      const base = document.value && typeof document.value === 'object' ? document.value : {};
      const next = { ...base, settings };
      let result;
      try {
        result = handle.update(PLUGIN_ID, next, document.revision);
      } catch (error) {
        return Promise.resolve(classifySettingsFailure(error));
      }
      return Promise.resolve(result).then(
        () => ({ ok: true, status: 200, reason: 'saved' }),
        (error) => classifySettingsFailure(error),
      );
    },
  };
}

/** 把 SettingsForms 的抛错映射成可读的失败描述与状态码。 */
function classifySettingsFailure(error) {
  const detail = describeError(error);
  if (/SETTINGS_CONFLICT/.test(detail)) {
    return { ok: false, status: 409, reason: 'revision-conflict', detail };
  }
  if (/No configurable plugin entry/.test(detail)) {
    return { ok: false, status: 409, reason: 'no-configurable-entry', detail };
  }
  if (/has no volatile fields/.test(detail)) {
    return { ok: false, status: 409, reason: 'no-volatile-fields', detail };
  }
  if (/is not volatile/.test(detail)) {
    return { ok: false, status: 400, reason: 'non-volatile-field', detail };
  }
  return { ok: false, status: 500, reason: 'unexpected', detail };
}

/** 在 SettingsForms 的描述表里定位本插件条目（附带 revision，供乐观并发用）。 */
function readSettingsEntry(ctx) {
  const handle = readService(ctx, 'settings');
  if (!handle || typeof handle.describe !== 'function') return null;
  try {
    const descriptors = handle.describe({ redactSecrets: false });
    if (!Array.isArray(descriptors)) return null;
    for (const descriptor of descriptors) {
      if (!descriptor || String(descriptor.ns) !== PLUGIN_ID) continue;
      return { value: descriptor.value, revision: descriptor.revision };
    }
    return null;
  } catch (_error) {
    return null;
  }
}

/** 按 id 找活的 Session 对象；找不到就返回 null，不触发创建。 */
function resolveSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  try {
    const handle = readService(ctx, 'sessions');
    if (handle && typeof handle.get === 'function') {
      const live = handle.get(sessionId);
      if (live) return live;
    }
    if (handle && typeof handle.list === 'function') {
      for (const entry of handle.list()) {
        const id = String(entry.id !== undefined ? entry.id : entry.sessionId);
        if (id === sessionId && typeof entry.session === 'object' && entry.session !== null) {
          return entry.session;
        }
      }
    }
  } catch (_error) {
    return null;
  }
  return null;
}

/** 按钮不放行：图片路由只认这几种媒体类型，其余一律回落 png。 */
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * 附件根目录：`$DSH_HOME/attachments/v1`。
 *
 * 不引入 @deepseek-ai/dsh-home-paths —— 它在宿主自己的 node_modules 里，
 * 插件副本的祖先链上未必解析得到；而宿主侧的解析顺序就是
 * 显式配置 → DSH_HOME env → ~/.dsh，本插件没有显式配置，自己复刻后两步即可。
 */
function attachmentsRoot() {
  const env = typeof process !== 'undefined' && process.env ? process.env.DSH_HOME : '';
  const base = typeof env === 'string' && env.trim() !== '' ? env : join(homedir(), '.dsh');
  return join(base, 'attachments', 'v1');
}

/** 挂路由。任何一步不可用都静默降级，绝不打断宿主启动。 */
export function mountRoutes(ctx, logger) {
  const api = createApi(ctx);
  const routes = [];

  const register = (path, handler) => {
    try {
      const webServer = readService(ctx, 'webServer');
      if (!webServer || typeof webServer.register !== 'function') return;
      const dispose = webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res);
          } catch (error) {
            if (logger && typeof logger.warn === 'function') logger.warn(error);
            if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
            else res.end();
          }
        },
      });
      if (typeof dispose === 'function') routes.push(dispose);
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn(error);
    }
  };

  register(`${ROUTE_PREFIX}/api/health`, (req, res) => {
    sendJson(res, 200, api.health());
  });

  register(`${ROUTE_PREFIX}/api/overview`, (req, res) => {
    sendJson(res, 200, api.overview());
  });

  register(`${ROUTE_PREFIX}/api/detail`, (req, res) => {
    let sessionId = '';
    try {
      const url = new URL(req.url || '/', 'http://dsh.invalid');
      sessionId = url.searchParams.get('session') || '';
    } catch (_error) {
      sessionId = '';
    }
    const detail = api.detail(sessionId);
    if (detail === null) {
      sendJson(res, 404, { error: 'session-not-found', sessionId });
      return;
    }
    sendJson(res, 200, detail);
  });

  // 设置通道：GET 读、POST 写。写进去的是 profile 的插件条目配置，
  // 与官方 configForms 同源，因此 `dsh config` 与设置页看到的永远是一份值。
  register(`${ROUTE_PREFIX}/api/settings`, (req, res) => {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, { plugin: PLUGIN_ID, settings: api.settings(), writable: api.settingsWritable() });
      return;
    }
    readJsonBody(req)
      .then((body) => {
        if (body === null || typeof body !== 'object' || typeof body.settings !== 'object') {
          sendJson(res, 400, { error: 'bad-request' });
          return;
        }
        return api.saveSettings(body.settings).then((result) => {
          // 状态码由 saveSettings 判定，失败原因原样回给调用方 —— 不再吞成 409。
          sendJson(res, result.status, {
            ok: result.ok,
            reason: result.reason,
            detail: result.detail,
            settings: api.settings(),
            writable: api.settingsWritable(),
          });
        });
      })
      .catch((error) => {
        if (logger && typeof logger.warn === 'function') logger.warn(error);
        sendJson(res, 500, { error: 'internal' });
      });
  });

  // 图片通道：按内容寻址直读 `$DSH_HOME/attachments/v1/objects/<前2位>/<sha>`。
  // ref 必须整体匹配 sha256 白名单 —— 路径由白名单捕获组拼接，没有任何
  // 用户可控的路径成分，穿越不可能发生。内容寻址意味着字节永不变化，可长缓存。
  register(`${ROUTE_PREFIX}/api/image`, (req, res) => {
    let ref = '';
    let type = '';
    try {
      const url = new URL(req.url || '/', 'http://dsh.invalid');
      ref = url.searchParams.get('ref') || '';
      type = url.searchParams.get('type') || '';
    } catch (_error) {
      ref = '';
    }
    const match = /^sha256:([a-f0-9]{64})$/.exec(ref);
    if (match === null) {
      sendJson(res, 400, { error: 'bad-ref' });
      return;
    }
    const sha = match[1];
    const mediaType = MEDIA_TYPES.has(type) ? type : 'image/png';
    let filePath;
    try {
      filePath = join(attachmentsRoot(), 'objects', sha.slice(0, 2), sha);
      statSync(filePath);
    } catch (_error) {
      sendJson(res, 404, { error: 'attachment-not-found' });
      return;
    }
    let stream;
    try {
      stream = createReadStream(filePath);
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn(error);
      sendJson(res, 500, { error: 'read-failed' });
      return;
    }
    res.writeHead(200, {
      'content-type': mediaType,
      'cache-control': 'private, max-age=86400, immutable',
    });
    stream.on('error', (error) => {
      if (logger && typeof logger.warn === 'function') logger.warn(error);
      if (!res.headersSent) sendJson(res, 500, { error: 'read-failed' });
      else res.destroy();
    });
    stream.pipe(res);
  });

  return () => {
    for (const dispose of routes) {
      try {
        dispose();
      } catch (_error) {
        /* 卸载期失败没有补救手段，也不值得吵 */
      }
    }
    routes.length = 0;
  };
}

/** 读一个小 JSON 请求体；超过 64KB 直接判无效，防止被灌爆。 */
const MAX_BODY_BYTES = 64 * 1024;
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        try {
          req.destroy();
        } catch (_error) {
          /* 断开失败无所谓，反正已经放弃了 */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/** 单测入口：暴露内部纯函数（`__test` 与默认导出同源，避免两处不一致）。 */
export const __test = {
  stableView,
  createProjectionDefinition,
  createApi,
  mountRoutes,
  applyActivity,
  initActivity,
  viewActivity,
  normalizeState,
  isCompleteState,
};

export const name = PLUGIN_ID;
/**
 * 不声明任何 inject。
 *
 * cordis 的 inject 是**等待闸门**：声明了但服务未就绪时 apply 根本不执行
 * （实测 applyRan=false）；服务就绪后才执行。而本插件的能力全部是可选的——
 * 宿主缺 webServer 时应当只是「挂不上路由」，不该整条 entry 卡在 pending。
 *
 * 那为什么可以用 inject=[]？因为 apply 里的每次服务读取都走 readService：
 * cordis 的 get trap（cordis/lib/index.js:673-698）对「未声明 inject 且未提供」
 * 的服务名会抛 `cannot get property "X" without inject`，裸读必崩；
 * `ctx.get(name, false)` 是同一 trap 的保留逃生路径，缺失时返回 undefined。
 *
 * 注意 logger **不是**服务读取风险点：它是 cordis 内置服务，实测 inject=[]
 * 时裸读 ctx.logger 仍返回 function。仍然统一走 readService 只为一致性。
 */
export const inject = [];

export function apply(ctx) {
  const logger = readService(ctx, 'logger');

  // 1) 投影单元：能力可用就注册，卸载自动摘除（注册即 effect）。
  const projections = readService(ctx, 'sessionProjections');
  if (projections && typeof projections.register === 'function') {
    try {
      projections.register(createProjectionDefinition());
      if (logger && typeof logger.debug === 'function') {
        logger.debug(`[${PLUGIN_ID}] 已注册投影单元 ${PROJECTION_KEY}`);
      }
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn(error);
    }
  } else if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['sessionProjections'], (inner) => {
      const innerProjections = readService(inner, 'sessionProjections');
      if (!innerProjections || typeof innerProjections.register !== 'function') return;
      innerProjections.register(createProjectionDefinition());
    });
  }

  // 2) 只读路由：只依赖 webServer，缺它就整块挂不上，但仍不报错。
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (inner) => {
      inner.effect(() => mountRoutes(inner, logger), `${PLUGIN_ID}: routes`);
    });
  }

  // 3) 设置持久化：SettingsForms 是 profile 条目配置的权威写入口。
  //    与底座共用同一个 ctx（不需要单独 fiber 作用域），能力缺失时整块跳过。
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['settings'], () => {
      if (logger && typeof logger.debug === 'function') {
        logger.debug(`[${PLUGIN_ID}] SettingsForms 可用，设置将写入 profile 条目。`);
      }
    });
  }
}

/**
 * ⚠️ 这里**绝不能**再写 `export default { name, inject, apply }`。
 *
 * `cordis-plugin-loader/lib/index.js:667-672` 的 `unwrapExports` 是：
 *   exports = exports.default ?? exports
 * 一旦存在 default 导出，整个命名空间会被 default 对象**顶替**，
 * 挂在具名导出上的 `Config` 随即丢失 → `runtime.Config` 为 undefined →
 * SettingsForms 里查不到条目 → 设置页读空、写入 409。这就是那条根因链。
 *
 * 纯具名形态同样被 cordis 接受：`resolve()` 走 `isApplicable(plugin)`
 * （`cordis/lib/index.js:1446-1448`：对象且 `typeof apply === 'function'`）
 * 取到 `plugin.apply`，而 `runtime.Config = plugin.Config`
 * （同文件 `:1631`）从同一个命名空间对象上读到我们导出的 Config。
 */

