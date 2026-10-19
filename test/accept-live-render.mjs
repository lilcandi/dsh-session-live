/**
 * 端到端闭环验收：**活实例宿主真实产出的投影值** → **真 client.js bundle** → 渲染出非空树。
 *
 * 为什么需要这个探针
 * ------------------
 * 此前所有客户端断言都喂**手搓**的投影值。手搓值只能证明「组件逻辑自洽」，
 * 不能证明「宿主真给的值能被组件消化」—— 两者的字段契约可能不一致，
 * 而那正是导致面板静默空白的典型原因（本插件已因「读错快照字段」栽过一次）。
 *
 * 本探针把两端接上：
 *   1. 从活实例 `GET /session-live/api/overview` 取**真实** activity 值
 *      （宿主折叠器 + wire.view 的真实产物）。
 *   2. 用 node:vm 加载**真** `client.js`（宿主浏览器实际加载的那份）。
 *   3. 把真值装进**权威形状**的列表快照（`byId[sessionId].projectionValues`），
 *      渲染 hover 组件。
 *   4. 断言非空树、且树里出现真实工具名/真实字段派生的文案。
 *
 * 还包含一条反向断言：把真值故意改成宿主**早期版本**可能给的形状（例如
 * 缺 `phase`/`running`），组件仍不得抛错、不得产出 undefined 文案。
 *
 * 前置条件：DSH 活实例在跑（否则该探针 SKIP 而非 FAIL —— 它依赖外部状态，
 * 不该让「没开 DSH」变成代码缺陷）。
 *
 * 运行：node test/accept-live-render.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'client.js');
const BASE = 'http://127.0.0.1:3080';

const failures = [];
let checks = 0;
let skipped = 0;

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
 * 1. 拉真实数据
 * ------------------------------------------------------------------ */
console.log(`=== 拉活实例真实投影值：${BASE}/session-live/api/overview ===`);

let overview = null;
try {
  const response = await fetch(`${BASE}/session-live/api/overview`, {
    signal: AbortSignal.timeout(15000),
  });
  if (response.ok) overview = await response.json();
} catch (_error) {
  overview = null;
}

if (overview === null) {
  console.log('  SKIP 活实例不可达或路由未响应 —— 本探针依赖运行中的 DSH，跳过（不计失败）');
  console.log('\naccept-live-render：SKIP（外部依赖未就绪）');
  process.exit(0);
}

const sessions = Array.isArray(overview.sessions) ? overview.sessions : [];
const withActivity = sessions.filter((row) => row.activity !== null && row.activity !== undefined);
console.log(`  会话 ${sessions.length} 个，其中带 activity 的 ${withActivity.length} 个`);

check('活实例返回带 activity 的会话（至少 1 个，否则证明不了渲染）', () => {
  assert.ok(withActivity.length > 0, `activity 全为空：${sessions.map((row) => row.sessionId).join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * 2. 加载真 bundle
 * ------------------------------------------------------------------ */
const source = readFileSync(BUNDLE, 'utf8');

const registrations = [];
const moduleLoader = { load: (registration) => registrations.push(registration) };

function makeFakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {
      return undefined;
    },
    useMemo(fn) {
      return fn();
    },
    useSyncExternalStore(subscribe, get) {
      subscribe(() => {});
      return get();
    },
  };
}

const store = new Map();
const sandbox = {
  window: { __ModuleLoader__: moduleLoader },
  document: {
    baseURI: `${BASE}/`,
    head: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  },
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  },
  location: { href: `${BASE}/` },
  fetch: () => Promise.reject(new Error('offline in test')),
  URL,
  console: { log() {}, warn() {}, error() {} },
  setTimeout: () => 0,
  clearTimeout() {},
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

const react = makeFakeReact();
const exported = registrations[0].factory((spec) => {
  if (spec === 'react') return react;
  throw new Error(`unexpected require: ${spec}`);
});

check('真 bundle 物化出 apply 与 __test', () => {
  assert.equal(typeof exported.apply, 'function');
  assert.equal(typeof exported.__test, 'object');
});

/* ------------------------------------------------------------------ *
 * 3. 用真值构建权威形状快照，渲染组件
 * ------------------------------------------------------------------ */
const target = withActivity[0];
console.log(`  选用会话 ${target.sessionId}（phase=${target.activity.phase} running=${target.activity.running}）`);

/**
 * 把真实 activity 值装进宿主权威形状的列表快照。
 * 注意：`projectionValues` 里放**原样**的值（保留退化输入），
 * 但行上的 `running` 位必须容错 —— 演示/退化值可能是 null 或非对象。
 */
function snapshotWith(sessionId, value) {
  const safe = value !== null && typeof value === 'object' ? value : {};
  return {
    ids: [sessionId],
    byId: {
      [sessionId]: {
        id: sessionId,
        displayTitle: 'real',
        running: safe.running === true,
        updatedAt: 1,
        projectionValues: { liveActivity: value },
      },
    },
    phase: 'ready',
    projectionsBySession: {},
  };
}

/**
 * 判断一份真实投影值里有没有「值得展示的内容」。
 *
 * 存在的理由：真实宿主里**存在什么都没发生过的新会话**（实测
 * `session-c181a30f`：turn=0 step=0 recent=[] prompt="" reply="" error=null
 * compaction=0 lastTool=null）。这类会话连 `turn/start` 都还没有，
 * 组件按设计返回 null 不插入空块。若用「全部会话必须渲染」这种粗断言，
 * 会把正确的设计行为判成失败 —— 所以必须先把「有内容 / 空白」分堆。
 */
function hasRealContent(activity) {
  if (!activity || typeof activity !== 'object') return false;
  if (activity.running === true) return true;
  if (activity.tool && activity.tool.name) return true;
  if (activity.lastTool && activity.lastTool.name) return true;
  if (activity.error) return true;
  if (activity.compaction) return true;
  if (activity.prompt) return true;
  if (activity.reply) return true;
  if (Array.isArray(activity.recent) && activity.recent.length > 0) return true;
  return false;
}

/** 造一个最小的 mock ctx，让 apply 完成注册，再取出 hover 组件。 */
function harnessFor(snapshot) {
  const registered = [];
  const ctx = {
    logger: { debug() {}, warn() {} },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: { register: () => () => {} },
    sessions: {
      list: {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      },
    },
    slots: {
      inject(slot, callback) {
        callback();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, registered };
}

const hoverHarness = harnessFor(snapshotWith(target.sessionId, target.activity));
exported.apply(hoverHarness.ctx);
const hover = hoverHarness.registered.find((item) => item.options.name === 'sidebar.session.row.hover');

check('apply 在真 bundle 上完成注册', () => {
  assert.ok(hover, 'hover 槽位未注册');
  assert.equal(typeof hover.component, 'function');
});

const tree = hover.component({ sessionId: target.sessionId });
const flat = tree === null ? '' : JSON.stringify(tree);

check('★ 真实宿主值经真 bundle 渲染出非空树（端到端闭环）', () => {
  assert.ok(tree !== null, '组件返回 null —— 真实投影值被组件判为「无内容」');
  assert.ok(flat.includes('dsl-panel'), `树里没有根 class：${flat.slice(0, 200)}`);
});

check('渲染树里出现真实工具名（若该会话有工具活动）', () => {
  const names = [];
  if (target.activity.tool && target.activity.tool.name) names.push(target.activity.tool.name);
  if (target.activity.lastTool && target.activity.lastTool.name) names.push(target.activity.lastTool.name);
  for (const item of target.activity.recent || []) if (item && item.name) names.push(item.name);
  if (names.length === 0) {
    console.log(`       （该会话无工具活动，跳过名字断言）`);
    return;
  }
  const hit = names.some((name) => flat.includes(name));
  assert.ok(hit, `树里没有任何真实工具名 ${names.join('/')}：${flat.slice(0, 300)}`);
});

check('渲染树无 undefined 泄漏（真值驱动的字符串拼接不得出现 "undefined"）', () => {
  assert.equal(flat.includes('undefined'), false, `树里出现 undefined：${flat.slice(0, 300)}`);
});

/* ------------------------------------------------------------------ *
 * 4. 反向断言：退化/异常输入不得抛错
 * ------------------------------------------------------------------ */
check('真值缺失字段（只有 running）时组件不抛', () => {
  const h = harnessFor(snapshotWith('s-degenerate', { running: true }));
  exported.apply(h.ctx);
  const component = h.registered.find((item) => item.options.name === 'sidebar.session.row.hover').component;
  let error = null;
  let result;
  try {
    result = component({ sessionId: 's-degenerate' });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error, null, `抛错：${error && error.message}`);
  assert.ok(result !== null, '只有 running 位时应仍能渲染出运行中状态');
});

check('真值是 null / 垃圾对象时组件不抛且不产出 undefined 文案', () => {
  for (const bad of [null, {}, { totally: 'wrong' }, { running: 'yes' }, []]) {
    const h = harnessFor(snapshotWith('s-bad', bad));
    exported.apply(h.ctx);
    const component = h.registered.find((item) => item.options.name === 'sidebar.session.row.hover').component;
    let result;
    assert.doesNotThrow(() => {
      result = component({ sessionId: 's-bad' });
    }, `输入 ${JSON.stringify(bad)} 抛错`);
    if (result !== null) {
      assert.equal(
        JSON.stringify(result).includes('undefined'),
        false,
        `输入 ${JSON.stringify(bad)} 产出 undefined 文案`,
      );
    }
  }
});

check('对不存在的会话组件返回 null（不插入空块）', () => {
  const h = harnessFor(snapshotWith(target.sessionId, target.activity));
  exported.apply(h.ctx);
  const component = h.registered.find((item) => item.options.name === 'sidebar.session.row.hover').component;
  assert.equal(component({ sessionId: 'no-such-session-xyz' }), null);
});

/* ------------------------------------------------------------------ *
 * 5. 全量会话扫一遍（不是单例侥幸）—— 有内容的必须渲染，空白的必须不渲染
 * ------------------------------------------------------------------ */
const withRealContent = withActivity.filter((row) => hasRealContent(row.activity));
const blank = withActivity.filter((row) => !hasRealContent(row.activity));
console.log(`  有内容会话 ${withRealContent.length} 个，空白会话 ${blank.length} 个`);

/** 用真 bundle 渲染某会话，返回 { result, error }。 */
function renderLive(sessionId, activity) {
  const h = harnessFor(snapshotWith(sessionId, activity));
  exported.apply(h.ctx);
  const component = h.registered.find((item) => item.options.name === 'sidebar.session.row.hover').component;
  try {
    return { result: component({ sessionId }), error: null };
  } catch (caught) {
    return { result: undefined, error: caught };
  }
}

check('★ 全部有内容的真实会话都能渲染出非空树（不是单例侥幸）', () => {
  const broken = [];
  for (const row of withRealContent) {
    const { result, error } = renderLive(row.sessionId, row.activity);
    if (error) {
      broken.push(`${row.sessionId}: 抛错 ${error.message}`);
      continue;
    }
    if (result === null) broken.push(`${row.sessionId}: 返回 null（phase=${row.activity.phase}）`);
    else if (!JSON.stringify(result).includes('dsl-panel')) {
      broken.push(`${row.sessionId}: 树里没有根 class`);
    }
  }
  assert.deepEqual(broken, [], `未渲染的会话：\n${broken.join('\n')}`);
});

check('★ 空白会话必须返回 null（不插入空块 —— 这是设计意图，不是缺陷）', () => {
  for (const row of blank) {
    const { result, error } = renderLive(row.sessionId, row.activity);
    assert.equal(error, null, `${row.sessionId} 抛错：${error && error.message}`);
    assert.equal(
      result,
      null,
      `${row.sessionId} 是空白会话（turn=${row.activity.turn} step=${row.activity.step} recent=${row.activity.recent.length}）却渲染出了块`,
    );
  }
  if (blank.length === 0) console.log('       （当前实例没有空白会话，该边界由构造用例兜底）');
});

check('空白会话边界：构造一个 turn=0 的空活动，必须返回 null', () => {
  const empty = {
    seq: 2,
    turn: 0,
    step: 0,
    running: false,
    phase: 'idle',
    state: 'idle',
    tool: null,
    lastTool: null,
    recent: [],
    prompt: '',
    reply: '',
    error: null,
    compaction: 0,
    toolCalls: 0,
  };
  const { result, error } = renderLive('s-empty', empty);
  assert.equal(error, null, `抛错：${error && error.message}`);
  assert.equal(result, null, '全新空会话不该插入空块');
});

check('空白会话边界：空活动但 running=true 时**必须**渲染（运行中比内容优先）', () => {
  const runningEmpty = {
    seq: 3,
    turn: 0,
    step: 0,
    running: true,
    phase: 'thinking',
    state: 'thinking',
    tool: null,
    lastTool: null,
    recent: [],
    prompt: '',
    reply: '',
    error: null,
    compaction: 0,
    toolCalls: 0,
    stepStart: Date.now() - 1000,
  };
  const { result, error } = renderLive('s-running-empty', runningEmpty);
  assert.equal(error, null, `抛错：${error && error.message}`);
  assert.notEqual(result, null, 'running=true 时必须渲染，否则用户看不到「正在跑」');
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} / ${checks}`);
  for (const failure of failures) console.error(` - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`端到端渲染验收：全部通过 ${checks} 项（真实会话 ${withActivity.length} 个）`);
