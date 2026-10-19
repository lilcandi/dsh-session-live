/**
 * v4 专项自检：一行概况（轮数 · token 用量 · 模型名）。
 *
 * 数据源是宿主内置的 tokenUsage 投影（dsh-token-meter），客户端零折叠成本直读。
 * 这里守三件事：
 *   1. 读数纯函数的边界（K/M 格式化、缺失、全零、脏输入）；
 *   2. hasContent 不因缺 token 把整块面板吞掉（缺就少显示，不是不显示）；
 *   3. 真 bundle 渲染出 .dsl-usage，文本含轮数与用量。
 *
 * 运行：node test/probe-usage.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 沙箱（与 load-check.mjs 同规）
 * ------------------------------------------------------------------ */
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

const react = makeFakeReact();
const sandbox = {
  window: { __ModuleLoader__: moduleLoader },
  document: {
    baseURI: 'http://127.0.0.1:3080/',
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', style: {}, appendChild() {} }),
    addEventListener() {},
    removeEventListener() {},
  },
  localStorage: { getItem: () => null, setItem() {} },
  location: { href: 'http://127.0.0.1:3080/' },
  fetch: () => Promise.reject(new Error('offline in test')),
  URL,
  console: { log() {}, warn() {}, error() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  isFinite,
  Symbol,
  Promise,
  Error,
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;

vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.js' });
const exported = registrations[0].factory((spec) => {
  if (spec === 'react') return react;
  throw new Error(`unexpected require: ${spec}`);
});
const api = exported.__test;

/* ------------------------------------------------------------------ *
 * 1. 纯函数边界
 * ------------------------------------------------------------------ */
check('formatTokens：K / M 档与零值', () => {
  assert.equal(api.formatTokens(0), '0');
  assert.equal(api.formatTokens(999), '999');
  assert.equal(api.formatTokens(1000), '1K');
  assert.equal(api.formatTokens(1500), '1.5K');
  assert.equal(api.formatTokens(300323), '300.3K');
  assert.equal(api.formatTokens(1200000), '1.2M');
});

check('formatTokens：脏输入一律退化成 0，不产出 NaN', () => {
  for (const bad of [undefined, null, NaN, -5, '1000', {}, []]) {
    assert.equal(api.formatTokens(bad), '0', `输入 ${String(bad)} 未退化成 0`);
  }
});

check('turnCount：只认 >0 的有限数', () => {
  assert.equal(api.turnCount({ turn: 12 }), 12);
  assert.equal(api.turnCount({ turn: 0 }), 0);
  assert.equal(api.turnCount({ turn: -1 }), 0);
  assert.equal(api.turnCount({ turn: NaN }), 0);
  assert.equal(api.turnCount({}), 0);
  assert.equal(api.turnCount(null), 0);
});

check('tokenUsageOf：input 计入 cacheRead/cacheWrite', () => {
  const usage = api.tokenUsageOf({
    projectionValues: {
      tokenUsage: {
        uncachedInputTokens: 33719,
        outputTokens: 2540,
        cacheReadTokens: 264064,
        cacheWriteTokens: 0,
      },
    },
  });
  assert.equal(usage.input, 297783);
  assert.equal(usage.output, 2540);
  assert.equal(usage.total, 300323);
  // 注：不整体 deepEqual —— 这是跨 vm realm 造出来的对象，
  // node:assert/strict 会比较原型，必然不等。
});

check('tokenUsageOf：缺失 / 全零 → null（不显示总 token，而不是显示 0）', () => {
  assert.equal(api.tokenUsageOf({}), null);
  assert.equal(api.tokenUsageOf(null), null);
  assert.equal(api.tokenUsageOf({ projectionValues: {} }), null);
  assert.equal(api.tokenUsageOf({ projectionValues: { tokenUsage: 'nope' } }), null);
  assert.equal(
    api.tokenUsageOf({
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    }),
    null,
  );
});

check('shortModel：剥 provider 前缀与日期尾巴', () => {
  assert.equal(api.shortModel('autoclaw-cn/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(api.shortModel('deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(api.shortModel('provider/model-20250101'), 'model');
  assert.equal(api.shortModel('provider/model-2025-01-01'), 'model');
  assert.equal(api.shortModel(''), '');
  assert.equal(api.shortModel(null), '');
});

check('shortModel：超长名截断到 19 字符 + 省略号', () => {
  const long = 'a-very-long-model-name-that-exceeds-twenty';
  const out = api.shortModel(long);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('\u2026'));
});

/* ------------------------------------------------------------------ *
 * 2. hasContent 不应因缺 token 吞掉面板
 * ------------------------------------------------------------------ */
const ONLY_USAGE = {
  enabled: true,
  showActivity: false,
  showError: false,
  showCompaction: false,
  showPreview: false,
  showRecent: false,
  showImage: false,
  showModel: false,
  showUsage: true,
};
const EMPTY_ACTIVITY = { turn: 0, recent: [], prompt: '', reply: '', error: null, compaction: 0 };

check('hasContent：showUsage + 有轮数 → true', () => {
  assert.equal(api.hasContent({ ...EMPTY_ACTIVITY, turn: 3 }, ONLY_USAGE, {}), true);
});

check('hasContent：轮数与 token 都没有时，showUsage 不撑起面板', () => {
  assert.equal(api.hasContent(EMPTY_ACTIVITY, ONLY_USAGE, {}), false);
});

check('hasContent：只有 token 也成立（token 来自宿主投影，与轮数独立）', () => {
  const row = { projectionValues: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5 } } };
  assert.equal(api.hasContent(EMPTY_ACTIVITY, ONLY_USAGE, row), true);
});

/* ------------------------------------------------------------------ *
 * 3. 真 bundle 渲染
 * ------------------------------------------------------------------ */
function makeCtx(byId) {
  const registered = [];
  return {
    registered,
    ctx: {
      logger: { debug() {}, warn() {} },
      effect(fn) {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      locale: { register: () => () => {} },
      sessions: {
        list: {
          getSnapshot: () => ({ ids: Object.keys(byId), byId, phase: 'ready', projectionsBySession: {} }),
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
    },
  };
}

function renderPanel(byId, sessionId) {
  const harness = makeCtx(byId);
  exported.apply(harness.ctx);
  const hover = harness.registered.find((item) => item.options.name === 'sidebar.session.row.hover');
  assert.ok(hover, 'hover 槽位未注册');
  return hover.component({ sessionId });
}

/**
 * 展开函数组件。
 *
 * 关键：宿主元素树里，子组件是以 `h(UsageLine, props)` 的形式**悬挂**在
 * children 里的，fakeReact.createElement 不会去调用它们。不展开就等于
 * 只看到一个空壳 div —— 那样「找不到 .dsl-usage」这类断言会假绿。
 */
function expand(node) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { type: node.type, props: node.props, children: expand(node.children) };
}

function collect(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collect(item, visit));
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  collect(node.children, visit);
}

function classList(node) {
  const out = [];
  collect(expand(node), (item) => {
    const cls = item.props && item.props.className;
    if (typeof cls === 'string') out.push(cls);
  });
  return out;
}

function plainText(node) {
  const out = [];
  collect(expand(node), (item) => {
    (item.children || []).forEach((child) => {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child));
    });
  });
  return out.join(' ');
}

const RICH = {
  'session-rich': {
    id: 'session-rich',
    running: false,
    updatedAt: 1,
    projectionValues: {
      liveActivity: {
        seq: 9,
        turn: 12,
        step: 3,
        recent: [],
        prompt: '给我看看 token 用量',
        reply: '这是结果',
        error: null,
        compaction: 0,
        toolCalls: 2,
        model: { provider: 'autoclaw-cn', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      },
      tokenUsage: {
        uncachedInputTokens: 33719,
        outputTokens: 2540,
        cacheReadTokens: 264064,
        cacheWriteTokens: 0,
      },
    },
  },
};

check('★ 渲染出 .dsl-usage，含轮数与格式化用量与模型短名', () => {
  const tree = renderPanel(RICH, 'session-rich');
  assert.ok(tree, '整块面板返回了 null');
  const classes = classList(tree);
  assert.ok(classes.some((c) => c.includes('dsl-usage')), `未渲染 dsl-usage：${classes.join(' | ')}`);
  const text = plainText(tree);
  assert.match(text, /12\s*\u8f6e/);
  assert.match(text, /300\.3K/);
  assert.match(text, /deepseek-v4\.1-flash/);
});

check('reasoningEffort 进 title 而不是挤进行内文本', () => {
  const tree = renderPanel(RICH, 'session-rich');
  let title = '';
  collect(expand(tree), (item) => {
    const cls = item.props && item.props.className;
    if (typeof cls === 'string' && cls.includes('dsl-usage')) title = String(item.props.title || '');
  });
  assert.match(title, /high/);
});

check('反证：活动有内容但 row 缺 tokenUsage 时，面板照常渲染（少一行而已）', () => {
  const byId = {
    'session-notoken': {
      id: 'session-notoken',
      running: false,
      updatedAt: 1,
      projectionValues: {
        liveActivity: {
          seq: 4,
          turn: 5,
          recent: [],
          prompt: '问',
          reply: '答',
          error: null,
          compaction: 0,
          toolCalls: 1,
          model: { provider: 'p', model: 'm' },
        },
      },
    },
  };
  const tree = renderPanel(byId, 'session-notoken');
  assert.ok(tree, '缺 tokenUsage 时面板整块消失 —— 这是回归');
  const text = plainText(tree);
  assert.match(text, /5\s*\u8f6e/);
  assert.equal(/K\b/.test(text), false, '没有 token 数据却显示了用量数字');
});

check('反证：tokenUsage 为脏形状时不抛错', () => {
  const byId = {
    'session-dirty': {
      id: 'session-dirty',
      running: false,
      updatedAt: 1,
      projectionValues: {
        liveActivity: { seq: 1, turn: 1, recent: [], prompt: 'x', reply: '', error: null, compaction: 0 },
        tokenUsage: { uncachedInputTokens: 'lots', outputTokens: null },
      },
    },
  };
  assert.doesNotThrow(() => renderPanel(byId, 'session-dirty'));
});

check('反证：turn 缺失但有 token → 用量行仍渲染，且不显示轮数段', () => {
  const byId = {
    'session-noturn': {
      id: 'session-noturn',
      running: false,
      updatedAt: 1,
      projectionValues: {
        liveActivity: { seq: 1, recent: [], prompt: '只有问', reply: '', error: null, compaction: 0 },
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
  };
  const tree = renderPanel(byId, 'session-noturn');
  assert.ok(tree, '面板整块消失');
  const classes = classList(tree);
  assert.ok(classes.some((c) => c.includes('dsl-usage')), '有 token 却没渲染用量行');
  const text = plainText(tree);
  assert.match(text, /200/);
  assert.equal(/\u8f6e/.test(text), false, '没有轮数却显示了轮数');
});

console.log('');
if (failures.length > 0) {
  console.log(`FAILED ${failures.length}/${checks}: ${failures.join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${checks}/${checks}`);
}
