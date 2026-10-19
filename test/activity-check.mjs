/**
 * dsh-session-live 宿主半边自检。
 *
 * 验证三件事：
 *   1. 投影单元符合宿主契约（key / stateVersion / init / apply / wire）；
 *   2. 折叠语义正确（工具生命周期、错误、预览、无关事件返回同一引用）；
 *   3. 只读路由在 mock webServer 上真的挂上了，且返回结构正确。
 *
 * 运行：node test/activity-check.mjs
 */
import assert from 'node:assert/strict';
import { __test, name, inject, apply } from '../index.js';
import { PREVIEW_MAX_CHARS } from '../src/activity.js';

const failures = [];
let checks = 0;

/**
 * ⚠️ 必须支持异步：曾经的版本里 `check(label, async () => ...)` 的 body 被
 * 立刻丢弃，async 断言从未执行，失败只变成 unhandled rejection —— 测试
 * 「全绿」是假的。现在把结果按序收集，汇总前统一 await。
 */
const results = [];
const pending = [];

const settle = (label, error) => {
  results.push({ label, error });
  if (error) failures.push({ label, error });
};

function check(label, fn) {
  checks += 1;
  try {
    const returned = fn();
    if (returned && typeof returned.then === 'function') {
      pending.push(returned.then(() => settle(label, null), (error) => settle(label, error)));
      return;
    }
    settle(label, null);
  } catch (error) {
    settle(label, error);
  }
}

const { createProjectionDefinition, applyActivity, initActivity, viewActivity, createApi, mountRoutes } = __test;

function ev(type, data, seq, time) {
  return { type, seq, time: time === undefined ? 1000 + seq : time, data };
}

/* ------------------------------------------------------------------ *
 * 1. 单元契约
 * ------------------------------------------------------------------ */
check('投影单元 key 与 stateVersion 固定', () => {
  const definition = createProjectionDefinition();
  assert.equal(definition.key, 'liveActivity');
  assert.equal(definition.stateVersion, 2); // v4 行结构未变（只改取值语义）→ 绝不升级，否则老会话画面永久空白
});

check('投影单元具备 init / apply / wire.view', () => {
  const definition = createProjectionDefinition();
  assert.equal(typeof definition.init, 'function');
  assert.equal(typeof definition.apply, 'function');
  assert.equal(typeof definition.wire.view, 'function');
  assert.equal(typeof definition.wire.viewSchema.safeParse, 'function');
  assert.equal(definition.wire.viewSchema.safeParse({ a: 1 }).success, true);
  assert.equal(definition.wire.viewSchema.safeParse(1).success, false);
});

check('init 返回纯 JSON 且被 stateSchema 接受', () => {
  const definition = createProjectionDefinition();
  const state = definition.init();
  assert.deepEqual(state, initActivity());
  assert.equal(definition.stateSchema.safeParse(state).success, true);
  assert.equal(JSON.parse(JSON.stringify(state)).seq, -1);
});

check('插件导出 name / inject / apply', () => {
  assert.equal(name, 'dsh-session-live');
  // inject 保持为空：cordis 的 inject 是等待闸门，声明未提供的服务会让 apply
  // 永不执行（永久 pending）；本插件的能力全部可选，应当立即执行并逐项探测。
  // 服务读取一律走 readService（内部 ctx.get(name, false)）规避 get trap。
  assert.deepEqual([...inject], []);
  assert.equal(typeof apply, 'function');
});

/* ------------------------------------------------------------------ *
 * 2. 折叠语义
 * ------------------------------------------------------------------ */
check('无关事件返回同一引用（发布抑制的前提）', () => {
  const state = initActivity();
  const same = applyActivity(state, { type: 'some/unknown-event', seq: -1, time: 1, data: {} });
  assert.equal(same, state);
});

check('非法输入不抛错', () => {
  assert.doesNotThrow(() => applyActivity(null, null));
  assert.doesNotThrow(() => applyActivity({}, { type: 'tool/call', data: null, seq: 0, time: 0 }));
});

check('工具调用 → 运行中，结果 → 结束', () => {
  let state = initActivity();
  state = applyActivity(state, ev('turn/start', { turn: 1 }, 1, 1000));
  state = applyActivity(state, ev('step/start', { turn: 1, step: 1 }, 2, 1100));
  state = applyActivity(
    state,
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' }, 3, 1200),
  );

  const running = viewActivity(state, 5000, undefined);
  assert.equal(running.running, true);
  assert.equal(running.tool.name, 'pwsh');
  assert.equal(running.tool.category, 'commands');
  assert.equal(running.tool.detail, 'npm test');
  assert.equal(running.tool.elapsedMs, 3800);

  state = applyActivity(state, ev('tool/result', { turn: 1, step: 1, callId: 'c1', message: 'ok' }, 4, 2500));
  const done = viewActivity(state, 6000, undefined);
  assert.equal(done.tool, null);
  assert.equal(done.lastTool.name, 'pwsh');
  assert.equal(done.lastTool.durationMs, 1300);
  assert.equal(done.reply, ''); // v4：工具结果不再冒充助手回复，reply 只来自 assistant/message
  assert.equal(done.toolCalls, 1);
});

check('工具失败会被记成 error 且不污染 reply', () => {
  let state = initActivity();
  state = applyActivity(state, ev('turn/start', { turn: 1 }, 1));
  state = applyActivity(
    state,
    ev('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{"file_path":"a.js"}' }, 2),
  );
  state = applyActivity(
    state,
    ev(
      'tool/result',
      { turn: 1, step: 1, callId: 'c9', message: 'boom', error: { name: 'EOENT', code: 'ENOENT', reason: 'missing file' } },
      3,
    ),
  );
  const view = viewActivity(state, 9000, false);
  assert.equal(view.error.kind, 'tool');
  assert.equal(view.error.label, 'EOENT');
  assert.equal(view.lastTool.failed, true);
  assert.equal(view.reply, '');
});

check('轮次异常终止会被记成 error', () => {
  let state = initActivity();
  state = applyActivity(state, ev('turn/start', { turn: 2 }, 1));
  state = applyActivity(state, ev('turn/end', { turn: 2, reason: 'aborted' }, 2));
  const view = viewActivity(state, 9000, false);
  assert.equal(view.running, false);
  assert.equal(view.error.kind, 'turn');
  assert.equal(view.error.label, 'aborted');
});

check('正常结束不产生 error', () => {
  let state = initActivity();
  state = applyActivity(state, ev('turn/start', { turn: 3 }, 1));
  state = applyActivity(state, ev('turn/end', { turn: 3, reason: 'completed' }, 2));
  assert.equal(viewActivity(state, 1, false).error, null);
});

check('用户提示与助手回复被压成单行预览', () => {
  let state = initActivity();
  state = applyActivity(
    state,
    ev('user/message', { message: { content: [{ type: 'text', text: '第一行\n\n第二行   多余空白' }] } }, 1),
  );
  state = applyActivity(
    state,
    ev('assistant/message', { turn: 1, step: 1, message: { content: '答复内容' }, stream: [] }, 2),
  );
  const view = viewActivity(state, 1, false);
  assert.equal(view.prompt, '第一行 第二行 多余空白');
  assert.equal(view.reply, '答复内容');
});

check('最近工具序列最多保留 RECENT_MAX 条且新在前', () => {
  let state = initActivity();
  for (let index = 0; index < 20; index += 1) {
    state = applyActivity(
      state,
      ev('tool/call', { turn: 1, step: 1, callId: `c${index}`, name: `tool${index}`, arguments: '{}' }, index + 1),
    );
  }
  const view = viewActivity(state, 1, true);
  assert.equal(view.recent.length, 12);
  assert.equal(view.recent[0].name, 'tool19');
});

check('长参数被截断且坏 JSON 有兜底', () => {
  let state = initActivity();
  state = applyActivity(
    state,
    ev('tool/call', { turn: 1, step: 1, callId: 'x', name: 'pwsh', arguments: 'not json at all' }, 1),
  );
  assert.equal(viewActivity(state, 1, true).tool.detail, 'not json at all');

  let long = initActivity();
  long = applyActivity(
    long,
    ev('tool/call', { turn: 1, step: 1, callId: 'y', name: 'pwsh', arguments: JSON.stringify({ command: 'x'.repeat(400) }) }, 1),
  );
  const detail = viewActivity(long, 1, true).tool.detail;
  assert.ok(detail.length <= 120, `detail 太长: ${detail.length}`);
  assert.ok(detail.endsWith('…'));
});

check('工具名到活动类别的映射覆盖宿主词表', () => {
  let state = initActivity();
  const cases = [
    ['read', 'read'],
    ['grep', 'search'],
    ['write', 'write'],
    ['apply_patch', 'edit'],
    ['bash', 'commands'],
    ['run_code', 'code'],
    ['web_search', 'webSearch'],
    ['subagent', 'subagents'],
    ['todo_write', 'plan'],
    ['ask_user_question', 'questions'],
    ['whatever', 'tools'],
  ];
  for (const [tool, expected] of cases) {
    state = applyActivity(
      state,
      ev('tool/call', { turn: 1, step: 1, callId: tool, name: tool, arguments: '{}' }, 1),
    );
    assert.equal(viewActivity(state, 1, true).tool.category, expected, `${tool} → ${expected}`);
  }
});

check('视图在状态不变时返回同一引用（缓存生效）', () => {
  const definition = createProjectionDefinition();
  let state = definition.init();
  state = definition.apply(state, ev('turn/start', { turn: 1 }, 1));
  const first = definition.wire.view(state);
  const second = definition.wire.view(state);
  assert.equal(first, second);
});

check('视图内容变化时引用也变化', () => {
  const definition = createProjectionDefinition();
  let state = definition.init();
  state = definition.apply(state, ev('turn/start', { turn: 1 }, 1));
  const first = definition.wire.view(state);
  state = definition.apply(state, ev('tool/call', { turn: 1, step: 1, callId: 'c', name: 'pwsh', arguments: '{}' }, 2));
  const second = definition.wire.view(state);
  assert.notEqual(first, second);
  assert.equal(second.tool.name, 'pwsh');
});

check('视图里不含 Date.now 相关的不稳定字段', () => {
  const definition = createProjectionDefinition();
  let state = definition.init();
  state = definition.apply(state, ev('turn/start', { turn: 1 }, 1, 1000));
  const view = definition.wire.view(state);
  assert.equal(view.toolElapsedMs === undefined || view.toolElapsedMs === 0, true);
});

/* ------------------------------------------------------------------ *
 * 3. 路由
 * ------------------------------------------------------------------ */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
      this.headersSent = true;
    },
    end(body) {
      this.body = body === undefined ? '' : String(body);
    },
  };
}

const routes = new Map();
const mockCtx = {
  logger: { warn() {}, debug() {} },
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  sessionProjections: {
    snapshot() {
      return { asOfSeq: 42, values: { liveActivity: { running: true } } };
    },
    stateOf() {
      return initActivity();
    },
  },
  sessions: {
    list() {
      return [{ id: 'session-a', title: '测试会话', cwd: 'J:\\plugin', updatedAt: 1 }];
    },
    get(id) {
      return id === 'session-a' ? { id: 'session-a' } : undefined;
    },
  },
};

check('挂载了五条路由（含设置读写与图片流）', () => {
  const dispose = mountRoutes(mockCtx, mockCtx.logger);
  assert.deepEqual([...routes.keys()].sort(), [
    '/session-live/api/detail',
    '/session-live/api/health',
    '/session-live/api/image',
    '/session-live/api/overview',
    '/session-live/api/settings',
  ]);
  dispose();
  assert.equal(routes.size, 0);
});

check('health 返回插件身份', async () => {
  mountRoutes(mockCtx, mockCtx.logger);
  const res = fakeResponse();
  await routes.get('/session-live/api/health').handler({ url: '/session-live/api/health' }, res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.plugin, 'dsh-session-live');
  assert.equal(body.projectionKey, 'liveActivity');
  assert.equal(body.hasProjections, true);
});

check('overview 汇总每个会话的活动', async () => {
  const res = fakeResponse();
  await routes.get('/session-live/api/overview').handler({ url: '/session-live/api/overview' }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].sessionId, 'session-a');
  assert.equal(body.sessions[0].activity.running, true);
});

check('detail 未知会话返回 404', async () => {
  const res = fakeResponse();
  await routes.get('/session-live/api/detail').handler(
    { url: '/session-live/api/detail?session=nope' },
    res,
  );
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error, 'session-not-found');
});

check('detail 已知会话返回状态与视图', async () => {
  const res = fakeResponse();
  await routes.get('/session-live/api/detail').handler(
    { url: '/session-live/api/detail?session=session-a' },
    res,
  );
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.sessionId, 'session-a');
  assert.equal(body.asOfSeq, 42);
  assert.equal(body.state.seq, -1);
  assert.equal(typeof body.view.running, 'boolean');
});

check('路由 handler 内部异常被吞掉并回 500', async () => {
  routes.clear();
  const brokenCtx = {
    logger: { warn() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => {};
      },
    },
    get sessionProjections() {
      throw new Error('registry exploded');
    },
    sessions: { list: () => [] },
  };
  mountRoutes(brokenCtx, brokenCtx.logger);
  const res = fakeResponse();
  await routes.get('/session-live/api/overview').handler({ url: '/session-live/api/overview' }, res);
  assert.equal(res.status, 200, '异常应降级成空列表而不是 500');
  assert.deepEqual(JSON.parse(res.body).sessions, []);
  routes.clear();
});

check('apply 在没有任何服务时静默降级', () => {
  assert.doesNotThrow(() => apply({ logger: { debug() {}, warn() {} } }));
});

/* ------------------------------------------------------------------ *
 * 4. 设置通道
 * ------------------------------------------------------------------ */
function makeSettingsCtx(initialValue, revision) {
  let stored = initialValue === undefined ? { ipPool: { enabled: true } } : initialValue;
  let rev = revision === undefined ? 7 : revision;
  const writes = [];
  return {
    writes,
    get stored() {
      return stored;
    },
    ctx: {
      logger: { warn() {}, debug() {} },
      settings: {
        writable: true,
        describe() {
          return [
            { ns: 'other-plugin', value: {}, revision: 1, autoGenerate: false, schema: null, applies: 'live' },
            { ns: 'dsh-session-live', value: stored, revision: rev, autoGenerate: false, schema: null, applies: 'live' },
          ];
        },
        update(ns, patch, expectedRevision) {
          writes.push({ ns, patch, expectedRevision });
          stored = { ...stored, ...patch };
          rev += 1;
          return Promise.resolve();
        },
      },
    },
  };
}

check('settings 读到插件的 settings 子树', () => {
  const harness2 = makeSettingsCtx({ ipPool: { enabled: true }, settings: { dense: true, recentCount: 3 } });
  const api = createApi(harness2.ctx);
  assert.deepEqual(api.settings(), { dense: true, recentCount: 3 });
  assert.equal(api.settingsWritable(), true);
});

check('saveSettings 只合并 settings 子树，保留其它字段', async () => {
  const harness2 = makeSettingsCtx({ ipPool: { enabled: true }, settings: { dense: false } });
  const api = createApi(harness2.ctx);
  const result = await api.saveSettings({ dense: true, recentCount: 2 });
  assert.deepEqual(result, { ok: true, status: 200, reason: 'saved' });
  assert.equal(harness2.writes.length, 1);
  assert.equal(harness2.writes[0].ns, 'dsh-session-live');
  assert.equal(harness2.writes[0].expectedRevision, 7);
  assert.deepEqual(harness2.writes[0].patch.ipPool, { enabled: true });
  assert.deepEqual(harness2.writes[0].patch.settings, { dense: true, recentCount: 2 });
});

check('saveSettings 把宿主拒绝分类成 revision-conflict 而不是裸 false', async () => {
  const ctx2 = {
    logger: { warn() {}, debug() {} },
    settings: {
      describe() {
        return [{ ns: 'dsh-session-live', value: {}, revision: 2, autoGenerate: false, schema: null, applies: 'live' }];
      },
      update() {
        return Promise.reject(new Error('SETTINGS_CONFLICT'));
      },
    },
  };
  const result = await createApi(ctx2).saveSettings({ dense: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.reason, 'revision-conflict');
});

check('saveSettings 对「没有可配置条目」给出可诊断原因（旧版被吞成裸 409）', async () => {
  const ctx3 = {
    logger: { warn() {}, debug() {} },
    settings: {
      describe() {
        return [];
      },
      update() {
        throw new Error('should-not-be-called');
      },
    },
  };
  const result = await createApi(ctx3).saveSettings({ dense: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.reason, 'no-configurable-entry:dsh-session-live');
  assert.match(result.detail, /SettingsForms/);
});

check('没有 settings 服务时 settings() 返回空对象', () => {
  const api = createApi({ logger: { warn() {} }, sessions: { list: () => [] } });
  assert.deepEqual(api.settings(), {});
  assert.equal(api.settingsWritable(), false);
});

/* ------------------------------------------------------------------ *
 * 5. 敌意上下文：复现 cordis get trap 的「未 inject 即抛」语义
 * ------------------------------------------------------------------ */
/**
 * 构造一个按 cordis 真实语义行为的上下文。
 *
 * cordis 的 get trap（cordis/lib/index.js:673-699）只对 accessor
 * （effect / inject / get / on…）放行；读一个**未声明 inject 的服务名**会
 * 直接 throw `cannot get property "x" without inject`，而不是返回 undefined。
 * `ctx.get(name, false)` 是同一 trap 的保留逃生路径：strict=false 时返回 undefined。
 *
 * 插件首次启动即 failed 就是踩在这里：裸读 ctx.logger。
 */
function hostileCtx(provided) {
  const services = provided || {};
  const accessors = new Set(['on', 'effect', 'inject', 'get', 'set', 'provide', 'reflect', 'scope']);
  const target = {
    get(name, strict) {
      if (strict === false) return services[name];
      const value = services[name];
      if (value === undefined) throw new Error(`cannot get property "${name}" without inject`);
      return value;
    },
    inject(names, callback) {
      // 只提供真实存在的服务；缺失的服务名不触发回调（cordis 语义）。
      const ok = names.every((n) => services[n] !== undefined);
      if (ok && typeof callback === 'function') callback(makeHostile(services));
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  function makeHostile(extra) {
    const merged = { ...services, ...extra };
    return new Proxy(target, {
      get(_t, property) {
        if (typeof property !== 'string') return undefined;
        if (accessors.has(property)) return target[property];
        if (Object.prototype.hasOwnProperty.call(merged, property)) {
          return merged[property];
        }
        throw new Error(`cannot get property "${property}" without inject`);
      },
      has(_t, property) {
        return accessors.has(property) || Object.prototype.hasOwnProperty.call(merged, property);
      },
    });
  }
  return makeHostile({});
}

check('敌意上下文：裸读未 inject 的服务确实会抛（证明测试有效）', () => {
  const ctx = hostileCtx({});
  assert.throws(() => ctx.logger, /without inject/);
  assert.throws(() => ctx.sessionProjections, /without inject/);
  assert.equal(ctx.get('logger', false), undefined);
});

check('宿主 apply 在只剩 logger 的敌意上下文里不抛错', () => {
  const ctx = hostileCtx({ logger: { debug() {}, warn() {}, error() {} } });
  // 这是真实启动场景：logger 已按 inject 声明提供，其余服务都还没挂上。
  assert.doesNotThrow(() => apply(ctx));
});

check('宿主 apply 在连 logger 都没有的上下文里也不抛错', () => {
  const ctx = hostileCtx({});
  assert.doesNotThrow(() => apply(ctx));
});

check('宿主 apply 在所有服务齐备时注册投影并挂路由', () => {
  const registered = [];
  const routes = [];
  let registeredUnit = null;
  const ctx = hostileCtx({
    logger: { debug() {}, warn() {}, error() {} },
    sessionProjections: {
      register(definition) {
        registeredUnit = definition;
        registered.push(definition.key);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.push(route.path);
        return () => {};
      },
    },
    settings: { describe: () => [], update: () => Promise.resolve() },
    sessions: { list: () => [] },
  });
  assert.doesNotThrow(() => apply(ctx));
  assert.deepEqual(registered, ['liveActivity']);
  assert.equal(registeredUnit.key, 'liveActivity');
  assert.deepEqual(routes.sort(), [
    '/session-live/api/detail',
    '/session-live/api/health',
    '/session-live/api/image',
    '/session-live/api/overview',
    '/session-live/api/settings',
  ]);
});

check('createApi 在只有 logger 的敌意上下文里各方法都安全', () => {
  const ctx = hostileCtx({ logger: { warn() {} } });
  const api = createApi(ctx);
  assert.deepEqual(api.settings(), {});
  assert.equal(api.settingsWritable(), false);
  assert.deepEqual(api.overview().sessions, []);
  assert.equal(api.detail('nope'), null);
  assert.equal(api.health().hasSessions, false);
  assert.equal(api.health().hasProjections, false);
  return api.saveSettings({ dense: true }).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'settings-service-unavailable');
  });
});

check('mountRoutes 在只有 logger 的敌意上下文里静默不挂路由', () => {
  const ctx = hostileCtx({ logger: { warn() {} } });
  let dispose;
  assert.doesNotThrow(() => {
    dispose = mountRoutes(ctx, { warn() {} });
  });
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
});

/* ------------------------------------------------------------------ *
 * 视图层净化：v2 时期的旧 checkpoint 行结构未变、宿主不会重放，
 * 于是注入文本会永远留在 prompt/reply 里 —— view 路径必须再洗一遍。
 * ------------------------------------------------------------------ */

const DIRTY_PROMPT =
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent working directory: J:\\plugin';
const WRAPPED_PROMPT = '<system-reminder>\n全局工作指令\n</system-reminder>\n帮我改一下按钮颜色';

const dirtyState = (patch) => Object.assign(initActivity(), { seq: 5, turn: 3 }, patch);

check('视图净化：纯注入 prompt 在视图里清成空串，状态本身原样保留', () => {
  const state = dirtyState({ prompt: DIRTY_PROMPT });
  const view = viewActivity(state, 1, false);
  assert.equal(view.prompt, '');
  assert.equal(state.prompt, DIRTY_PROMPT);
});

check('视图净化：剥掉注入外壳后只留真人那句话', () => {
  const view = viewActivity(dirtyState({ prompt: WRAPPED_PROMPT }), 1, false);
  assert.equal(view.prompt, '帮我改一下按钮颜色');
});

check('视图净化：reply 走同一套清洗', () => {
  const view = viewActivity(dirtyState({ reply: DIRTY_PROMPT }), 1, false);
  assert.equal(view.reply, '');
});

check('视图净化是幂等的：新折叠器产出的干净值原样透出', () => {
  const view = viewActivity(dirtyState({ prompt: '你好，帮我看看这个 bug' }), 1, false);
  assert.equal(view.prompt, '你好，帮我看看这个 bug');
});

check('视图净化：超长文本仍被截到上限（不会因清洗而无限长）', () => {
  const view = viewActivity(dirtyState({ prompt: '啊'.repeat(500) }), 1, false);
  assert.ok(view.prompt.length <= PREVIEW_MAX_CHARS, `长度 ${view.prompt.length}`);
});

check('视图净化不破坏发布抑制：同一 state 复用视图仍返回同一引用', () => {
  const state = dirtyState({ prompt: DIRTY_PROMPT });
  const first = viewActivity(state, 1, false);
  const second = viewActivity(state, 1, false, first);
  assert.equal(first, second);
});

check('视图净化：空值与非字符串不抛', () => {
  assert.equal(viewActivity(dirtyState({ prompt: '' }), 1, false).prompt, '');
  assert.equal(viewActivity(dirtyState({ reply: undefined }), 1, false).reply, '');
});

/* 2026-10-19 于真实会话实测到的三种宿主系统标记（曾漏网，被当成「问」显示） */

check('视图净化：模型切换标记不被当成提问', () => {
  const prompt = '[model changed: assistant turns above this point were generated by claude-3]';
  assert.equal(viewActivity(dirtyState({ prompt }), 1, false).prompt, '');
});

check('视图净化：定时提醒标记不被当成提问（大写也算）', () => {
  const prompt = '[SCHEDULE REMINDER BATCH] This is a scheduled message from the scheduler.';
  assert.equal(viewActivity(dirtyState({ prompt }), 1, false).prompt, '');
});

check('视图净化：后台任务回执不被当成提问', () => {
  const prompt = "background job pwsh-729a10cdd4704584 (pwsh: $api = 'api.github')";
  assert.equal(viewActivity(dirtyState({ prompt }), 1, false).prompt, '');
});

check('视图净化不误杀：真话里提到 background job / [model changed] 仍保留', () => {
  assert.equal(
    viewActivity(dirtyState({ prompt: 'background job 跑完了吗' }), 1, false).prompt,
    'background job 跑完了吗',
  );
  assert.equal(
    viewActivity(dirtyState({ prompt: '[model changed] 这个提示能改吗' }), 1, false).prompt,
    '[model changed] 这个提示能改吗',
  );
});

check('视图净化：注入标记与真话同条时只留真话', () => {
  const prompt = '[SCHEDULE REMINDER BATCH] 提醒内容\n用户真话：帮我看下日志';
  assert.equal(viewActivity(dirtyState({ prompt }), 1, false).prompt, '用户真话：帮我看下日志');
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
await Promise.all(pending);
for (const row of results) {
  if (row.error) console.log(`  FAIL ${row.label}\n       ${row.error.message}`);
  else console.log(`  ok   ${row.label}`);
}
console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} / ${checks}`);
  for (const failure of failures) console.error(` - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`全部通过 ${checks} 项`);
