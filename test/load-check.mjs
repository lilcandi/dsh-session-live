/**
 * dsh-session-live 客户端自检。
 *
 * 用 node:vm 在受控沙箱里加载 client.js，模拟 `window.__ModuleLoader__` 与
 * `require('react')`，验证：
 *   1. bundle 能解析、工厂能注册、模块能物化；
 *   2. 导出的 name / inject / apply 形态正确；
 *   3. apply 在 mock cordis 上下文里注册到正确的槽位、id、order；
 *   4. 两个插槽组件都是可渲染函数；
 *   5. 纯函数（状态推导、时长格式、设置归一化）行为符合预期。
 *
 * 运行：node test/load-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'client.js');
const source = readFileSync(BUNDLE, 'utf8');

const failures = [];
let checks = 0;

function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 沙箱：模拟浏览器模块系统
 * ------------------------------------------------------------------ */
const registrations = [];
const moduleLoader = {
  load(registration) {
    registrations.push(registration);
  },
};

const warnings = [];
const timers = [];
const fakeSetTimeout = (fn, ms) => {
  timers.push({ fn, ms, cancelled: false });
  return timers.length;
};
const fakeClearTimeout = (id) => {
  const entry = timers[id - 1];
  if (entry) entry.cancelled = true;
};

/** 极简 React：只提供组件工厂与 hooks 的占位实现。 */
function makeFakeReact() {
  const effects = [];
  const states = [];
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      const setter = (next) => {
        states.push(next);
      };
      return [value, setter];
    },
    useEffect(fn, deps) {
      effects.push({ fn, deps });
      return undefined;
    },
    useMemo(fn) {
      return fn();
    },
    useSyncExternalStore(subscribe, get) {
      subscribe(() => {});
      return get();
    },
    __effects: effects,
  };
}

const react = makeFakeReact();

const sandbox = {
  window: { __ModuleLoader__: moduleLoader },
  document: {
    baseURI: 'http://127.0.0.1:3080/',
    head: { appendChild() {} },
    querySelector() {
      return null;
    },
    createElement() {
      return { dataset: {}, textContent: '' };
    },
  },
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, value);
    },
  },
  location: { href: 'http://127.0.0.1:3080/' },
  fetch: () => Promise.reject(new Error('offline in test')),
  URL,
  console: {
    log: (...args) => console.log(...args),
    warn: (...args) => warnings.push(args.join(' ')),
    error: (...args) => warnings.push(args.join(' ')),
  },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  isFinite,
  Symbol,
  Promise,
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;

const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: 'client.js' });

/* ------------------------------------------------------------------ *
 * 1. 注册与物化
 * ------------------------------------------------------------------ */
check('bundle 向 __ModuleLoader__ 注册了自己', () => {
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'dsh-session-live');
  assert.equal(typeof registrations[0].factory, 'function');
});

const requireStub = (spec) => {
  if (spec === 'react') return react;
  throw new Error(`unexpected require: ${spec}`);
};

const exported = registrations[0].factory(requireStub);

check('模块能物化并导出 name / inject / apply', () => {
  assert.equal(exported.name, 'dsh-session-live');
  // sessions 必须声明：cordis 只等待 inject 里列出的服务，
  // 不声明时 apply 可能在它挂上之前就跑，面板会静默读不到行数据。
  assert.deepEqual([...exported.inject], ['slots', 'locale', 'sessions']);
  assert.equal(typeof exported.apply, 'function');
});

check('未引入任何 @deepseek-ai 依赖', () => {
  assert.equal(/require\(['"]@deepseek-ai/.test(source), false);
  assert.equal(/from\s+['"]@deepseek-ai/.test(source), false);
});

/* ------------------------------------------------------------------ *
 * 2. apply 在 mock cordis 上下文里的行为
 * ------------------------------------------------------------------ */
function makeCtx() {
  const injected = [];
  const registered = [];
  const effects = [];
  const localeRegistrations = [];
  return {
    injected,
    registered,
    effects,
    localeRegistrations,
    ctx: {
      logger: { debug() {}, warn() {} },
      effect(fn, label) {
        effects.push({ fn, label });
        // 真实 cordis 会立即执行 effect 回调并保留其返回的清理函数；
        // 测试里同样执行，才能验证 locale 注册这类「回调内才生效」的挂载。
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      locale: {
        register(ns, table) {
          localeRegistrations.push({ ns, table });
          return () => {};
        },
      },
      // ★ 快照桩必须与宿主**同形**。
      //
      // 权威形态（核实自 dsh-api-session-controller/lib/client.js 的 projectList）：
      //   this.list.set({ ids, byId, phase, projectionsBySession })
      //   byId[sessionId] 行自带 projectionValues（：4150-4166 构造）。
      //
      // 历史坑：本桩曾自造 `{ items: [...] }` —— 那个字段在会话列表快照里
      // **根本不存在**（items 属于 manager.getListSnapshot() 的另一形态），
      // 于是自检全绿而真实面板恒空白。桩与宿主不同形 = 测试在骗自己。
      sessions: {
        list: {
          getSnapshot() {
            return {
              ids: ['session-a'],
              byId: {
                'session-a': {
                  id: 'session-a',
                  displayTitle: '会话 A',
                  running: true,
                  updatedAt: 1,
                  projectionValues: {
                    liveActivity: {
                      running: true,
                      tool: { name: 'pwsh', category: 'commands', detail: 'npm test', startedAt: Date.now() },
                      recent: [{ name: 'pwsh', category: 'commands', detail: 'npm test' }],
                      prompt: '跑一下测试',
                      reply: '全部通过',
                      error: null,
                      compaction: 0,
                    },
                  },
                },
              },
              phase: 'ready',
              projectionsBySession: {},
            };
          },
          subscribe() {
            return () => {};
          },
        },
      },
      slots: {
        inject(slot, callback) {
          injected.push(slot);
          callback();
        },
        register(options, component) {
          registered.push({ options, component });
          return () => {};
        },
      },
    },
  };
}

const harness = makeCtx();
let applyError = null;
try {
  exported.apply(harness.ctx);
} catch (error) {
  applyError = error;
}

check('apply 不抛错', () => {
  assert.equal(applyError, null);
});

check('apply 注册到 hover 与 settings 两个槽位', () => {
  assert.deepEqual([...harness.injected], ['sidebar.session.row.hover', 'settings.section']);
  assert.equal(harness.registered.length, 2);
});

check('hover 注册参数正确（id / order / locale）', () => {
  const hover = harness.registered.find((item) => item.options.name === 'sidebar.session.row.hover');
  assert.ok(hover, 'hover 槽位未注册');
  assert.equal(hover.options.id, 'live-activity');
  assert.equal(hover.options.order, 150);
  assert.equal(hover.options.locale, 'dsh-session-live');
  assert.equal(typeof hover.component, 'function');
});

check('设置页注册参数正确', () => {
  const settings = harness.registered.find((item) => item.options.name === 'settings.section');
  assert.ok(settings, 'settings 槽位未注册');
  assert.equal(settings.options.id, 'dsh-session-live');
  assert.equal(settings.options.order, 300);
  assert.equal(typeof settings.component, 'function');
});

// 宿主的设置导航直接渲染 `label`：缺了就是一条空白项，用户点不到。
// 这个缺陷真实发生过（v1.0.0 里设置页在导航中不可见）。
check('设置区提供导航标题 label', () => {
  const settings = harness.registered.find((item) => item.options.name === 'settings.section');
  assert.equal(typeof settings.options.label, 'function', 'settings.section 缺 label，导航会渲染空行');
  assert.equal(settings.options.label(), '会话预览');
});

check('向 locale 注册了中英双语文案', () => {
  assert.equal(harness.localeRegistrations.length, 1);
  const { ns, table } = harness.localeRegistrations[0];
  assert.equal(ns, 'dsh-session-live');
  assert.equal(typeof table.zh['settings.title'], 'string');
  assert.equal(typeof table.en['settings.title'], 'string');
});

/* ------------------------------------------------------------------ *
 * 3. 组件渲染
 * ------------------------------------------------------------------ */
const hoverComponent = harness.registered.find((item) => item.options.name === 'sidebar.session.row.hover').component;

check('hover 组件在有活动时渲染出状态行', () => {
  // 预置默认设置：测试环境 localStorage 为空，store 用默认值（enabled=true）。
  const tree = hoverComponent({ sessionId: 'session-a' });
  assert.ok(tree, '组件返回了 null');
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes('dsl-panel'), '缺少根 class');
  assert.ok(flat.includes('pwsh'), '缺少工具名');
  assert.ok(flat.includes('npm test'), '缺少参数摘要');
});

check('hover 组件对未知会话返回 null（不插入空块）', () => {
  assert.equal(hoverComponent({ sessionId: 'missing' }), null);
});

check('设置页组件渲染出全部设置行', () => {
  const page = harness.registered.find((item) => item.options.name === 'settings.section').component;
  const tree = page();
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes('dsl-settings'), '缺少设置页根 class');
  const test = exported.__test;
  for (const spec of test.SETTINGS_SPEC) {
    // 渲染树里带的是本地化后的文案，不是键名；按中文标签断言。
    assert.ok(flat.includes(test.zh[`opt.${spec.key}`]), `缺少设置项 ${spec.key}`);
  }
});

/* ------------------------------------------------------------------ *
 * 4. 纯函数行为
 * ------------------------------------------------------------------ */
const t = exported.__test;

check('formatDuration 覆盖秒 / 分 / 时', () => {
  assert.equal(t.formatDuration(0), '');
  assert.equal(t.formatDuration(400), '<1s');
  assert.equal(t.formatDuration(1500), '2s');
  assert.equal(t.formatDuration(65000), '1m5s');
  assert.equal(t.formatDuration(3700000), '1h1m');
});

check('normalizeSettings 夹住数值区间并忽略未知键', () => {
  const value = t.normalizeSettings({ recentCount: '99', dense: 'true', nope: 1 });
  assert.equal(value.recentCount, 12);
  assert.equal(value.dense, true);
  assert.equal(Object.prototype.hasOwnProperty.call(value, 'nope'), false);
});

check('deriveState 区分 tool / thinking / error / idle', () => {
  const toolState = t.deriveState(
    { running: true, tool: { name: 'pwsh', category: 'commands', startedAt: 1000 }, toolStart: 1000 },
    null,
    5000,
  );
  assert.equal(toolState.kind, 'tool');
  assert.equal(toolState.label, 'pwsh');

  const thinking = t.deriveState({ running: true, tool: null, stepStart: 2000 }, null, 5000);
  assert.equal(thinking.kind, 'thinking');
  assert.equal(thinking.since, 2000);

  const failed = t.deriveState({ running: false, error: { kind: 'tool', label: 'ENOENT', at: 9 }, errorAt: 9 }, null, 5000);
  assert.equal(failed.kind, 'error');
  assert.equal(failed.label, 'ENOENT');

  const interrupted = t.deriveState({ running: false, error: { kind: 'interrupted', label: 'interrupted' } }, null, 1);
  assert.equal(interrupted.kind, 'interrupted');

  assert.equal(t.deriveState(undefined, { running: false }, 1).kind, 'idle');
});

check('deriveState 在只有行 running 位时也能判为运行中', () => {
  const state = t.deriveState(undefined, { running: true }, 1);
  assert.equal(state.kind, 'running');
});

check('elapsedSince 对非法起点返回 0', () => {
  assert.equal(t.elapsedSince(0, 1000), 0);
  assert.equal(t.elapsedSince(undefined, 1000), 0);
  assert.equal(t.elapsedSince(1000, 3000), 2000);
});

check('findRow 兼容 id 与 sessionId 两种字段名', () => {
  const items = [{ id: 'a' }, { sessionId: 'b' }];
  assert.equal(t.findRow(items, 'a').id, 'a');
  assert.equal(t.findRow(items, 'b').sessionId, 'b');
  assert.equal(t.findRow(items, 'c'), undefined);
});

check('hasContent 在全部关闭时返回 false', () => {
  const settings = { ...t.defaultSettings(), enabled: false };
  assert.equal(t.hasContent({ running: true }, settings, null), false);
});

check('glyphOf 对未知类别退化到通用图标', () => {
  assert.equal(t.glyphOf('commands'), '❯');
  assert.equal(t.glyphOf('nope'), '•');
});

check('routeUrl 生成相对的页面基 URL', () => {
  const url = t.routeUrl('/session-live/api/settings');
  assert.equal(url, 'http://127.0.0.1:3080/session-live/api/settings');
});

check('createRowReader 能从列表快照读到投影值', () => {
  const reader = t.createRowReader(harness.ctx.sessions);
  const row = reader('session-a');
  assert.ok(row, '读不到行');
  assert.equal(row.projectionValues.liveActivity.tool.name, 'pwsh');
  assert.equal(reader('session-z'), undefined);
});

/*
 * 快照取值的三级优先级 —— 钉死形状，防止「读错字段」再犯。
 * 第一级 byId 是宿主权威形态；后两级是兜底，不是主路径。
 */
check('rowOfSnapshot 优先读权威形态 byId（列表快照的真实形状）', () => {
  const snapshot = {
    ids: ['s1'],
    byId: { s1: { id: 's1', projectionValues: { liveActivity: { running: false } } } },
    phase: 'ready',
    projectionsBySession: {},
  };
  const row = t.rowOfSnapshot(snapshot, 's1');
  assert.equal(row.id, 's1');
  assert.equal(row.projectionValues.liveActivity.running, false);
});

check('rowOfSnapshot 反证：byId 与 items 同时存在时以 byId 为准', () => {
  const snapshot = {
    byId: { s3: { id: 's3', projectionValues: { liveActivity: { running: false } } } },
    items: [{ sessionId: 's3', projectionValues: { liveActivity: { running: true } } }],
  };
  assert.equal(t.rowOfSnapshot(snapshot, 's3').projectionValues.liveActivity.running, false);
});

check('rowOfSnapshot 兜底：只有旧形态 items 时仍能取到', () => {
  const snapshot = { items: [{ sessionId: 's2', projectionValues: { liveActivity: { running: true } } }] };
  assert.equal(t.rowOfSnapshot(snapshot, 's2').sessionId, 's2');
});

check('rowOfSnapshot 兜底：行未进列表时读 projectionsBySession', () => {
  const snapshot = { byId: {}, projectionsBySession: { s4: { values: { liveActivity: { running: true } } } } };
  const row = t.rowOfSnapshot(snapshot, 's4');
  assert.equal(row.sessionId, 's4');
  assert.equal(row.projectionValues.liveActivity.running, true);
});

check('rowOfSnapshot 对空/非法输入返回 undefined（不抛）', () => {
  assert.equal(t.rowOfSnapshot(undefined, 'x'), undefined);
  assert.equal(t.rowOfSnapshot(null, 'x'), undefined);
  assert.equal(t.rowOfSnapshot({}, 'x'), undefined);
  assert.equal(t.rowOfSnapshot({ byId: {} }, 'x'), undefined);
});

check('设置 store 在没有宿主时退回 localStorage', async () => {
  const store = t.createSettingsStore(harness.ctx);
  await store.save({ ...t.defaultSettings(), dense: true });
  assert.equal(store.get().dense, true);
  assert.equal(store.transport(), 'local');
  assert.equal(sandbox.localStorage.getItem('dsh-session-live:settings').includes('true'), true);
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log('');
if (warnings.length > 0) {
  console.log(`  note 捕获到 ${warnings.length} 条警告：${warnings[0]}`);
}
if (failures.length > 0) {
  console.error(`失败 ${failures.length} / ${checks}`);
  for (const failure of failures) console.error(` - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`全部通过 ${checks} 项`);
