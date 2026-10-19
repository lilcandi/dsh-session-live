/**
 * 决定性验证：v4 新增的「token 用量 + 对话轮数 + 模型短名」在真实链路上确实可用。
 *
 * 为什么必须有这个探针：
 *   面板上多一行很容易，难的是证明**这一行真的有数**。token 值不是本插件折叠出来的，
 *   而是宿主内置的 `tokenUsage` 投影（`@deepseek-ai/dsh-token-meter`）算好后塞进
 *   列表快照的 `projectionValues`。只要这条链路任何一环对不上（键名、版本号、桶名），
 *   面板不会报错，只会永远少一行 —— 静默失效，正是本项目栽过最多次的坑。
 *
 * 本探针分两段，都不 mock 关键物：
 *   A 段（宿主真值）：真 cordis + 真注册表，注册**宿主自己的** tokenUsageProjectionDefinition
 *     和本插件的 liveActivity，然后把 `C:\Users\candi\.dsh\storages\session_projcache\sessions\*.json`
 *     里的**真实 rows** 喂给 `viewCheckpoint`（且不带 keys，复刻
 *     `dsh-api-session-controller/lib/types/list.js:282` 的调用形态）。
 *   B 段（客户端真值）：node:vm 加载**真正生效的** `client.js`，用真 checkpoint 的数值
 *     驱动 tokenUsageOf / formatTokens / turnCount / shortModel / hasContent。
 *
 * 运行：node test/probe-usage-snapshot.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'client.js');

const DSH_MODULES =
  'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const CORDIS = `${DSH_MODULES}/cordis/lib/index.js`;
const PROJECTION = `${DSH_MODULES}/dsh-session-projection/lib/index.js`;
const TOKEN_METER = `${DSH_MODULES}/dsh-token-meter/lib/types/usage-projection.js`;
const CACHE_DIR = 'C:\\Users\\candi\\.dsh\\storages\\session_projcache\\sessions';

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

/* ================================================================== *
 * A 段：宿主真值 —— 真注册表 view 真实持久化 rows
 * ================================================================== */
const cordis = await import(CORDIS);
const Context = cordis.Context ?? cordis.default;
const projection = await import(PROJECTION);
const Registry = projection.SessionProjectionRegistry ?? projection.default;
const tokenMeter = await import(TOKEN_METER);
const mine = await import('../src/index.js');

const hostDefinition = tokenMeter.tokenUsageProjectionDefinition;
const myDefinition = mine.createProjectionDefinition();

const ctx = new Context();
await ctx.plugin(Registry);
const registry = ctx.get('sessionProjections', false);
assert.ok(registry, '投影注册表服务未挂上');
registry.register(hostDefinition);
registry.register(myDefinition);

console.log('=== A 段：宿主真值 ===');
console.log(`  宿主 tokenUsage 投影：key=${hostDefinition.key} stateVersion=${hostDefinition.stateVersion}`);
console.log(`  本插件 liveActivity ：key=${myDefinition.key} stateVersion=${myDefinition.stateVersion}`);

const files = readdirSync(CACHE_DIR).filter((name) => name.endsWith('.json'));
const parsed = [];
for (const name of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(CACHE_DIR, name), 'utf8'));
  } catch (_error) {
    continue;
  }
  const rows = doc?.record?.rows;
  if (rows && typeof rows === 'object') parsed.push({ name, rows });
}

const withUsage = parsed.filter((entry) => entry.rows.tokenUsage !== undefined);
const withBoth = withUsage.filter((entry) => entry.rows[mine.PROJECTION_KEY] !== undefined);

console.log(`  缓存文件 ${files.length} 个 / 可解析 ${parsed.length} 个 / 含 tokenUsage ${withUsage.length} 个 / 两者都有 ${withBoth.length} 个`);

check('磁盘上存在带 tokenUsage 行的真实 checkpoint（不是臆测）', () => {
  assert.ok(withUsage.length > 0, '一个都没有 —— 需要先跑一次 DSH 让 checkpoint 落盘');
});

check('tokenUsage 行的 ver 与宿主内置 stateVersion 一致（不一致会被直读路径全丢）', () => {
  const versions = new Set(withUsage.map((entry) => entry.rows.tokenUsage.ver));
  const list = [...versions].sort();
  console.log(`       磁盘 tokenUsage ver 分布：${list.map((v) => `${v}×${withUsage.filter((e) => e.rows.tokenUsage.ver === v).length}`).join('、')}`);
  assert.ok(
    versions.has(hostDefinition.stateVersion),
    `磁盘上没有任何 ver=${hostDefinition.stateVersion} 的 tokenUsage 行 —— 直读路径会全部丢弃`
  );
});

check('磁盘 liveActivity 行的版本分布（诊断：版本抖动会自愈，但不是零代价）', () => {
  const byVer = new Map();
  for (const entry of parsed) {
    const row = entry.rows[mine.PROJECTION_KEY];
    if (row === undefined) continue;
    byVer.set(row.ver, (byVer.get(row.ver) ?? 0) + 1);
  }
  const list = [...byVer.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`       磁盘 liveActivity ver 分布：${list.map(([ver, n]) => `${ver}×${n}`).join('、')}（当前代码 stateVersion=${myDefinition.stateVersion}）`);
  const stale = list.filter(([ver]) => ver !== myDefinition.stateVersion).reduce((sum, [, n]) => sum + n, 0);
  if (stale > 0) {
    console.log(`       注：${stale} 行版本不匹配 → 直读路径丢弃，attach 后由 fold 从 seq 0 重放自愈`);
  }
});

check('★ viewCheckpoint 不带 keys 时同时产出 tokenUsage 与 liveActivity（复刻 list.js:282）', () => {
  const entry = withBoth.find((item) => item.rows[mine.PROJECTION_KEY].ver === myDefinition.stateVersion);
  assert.ok(
    entry,
    `没有任何 liveActivity 行匹配当前 stateVersion=${myDefinition.stateVersion}，需要跑一次 DSH 让 fold 重写`
  );
  const values = registry.viewCheckpoint(entry.rows);
  assert.ok(values.tokenUsage, `没产出 tokenUsage，实际键：${Object.keys(values).join(',')}`);
  assert.ok(values[mine.PROJECTION_KEY], '没产出 liveActivity');
  console.log(`       样例 ${entry.name}：tokenUsage=${JSON.stringify(values.tokenUsage)}`);
});

check('★ 真实行的 tokenUsage 四个桶都是有限数（客户端可直接相加）', () => {
  for (const entry of withUsage) {
    const values = registry.viewCheckpoint({ tokenUsage: entry.rows.tokenUsage });
    if (!values.tokenUsage) continue;
    const usage = values.tokenUsage;
    for (const bucket of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      assert.equal(typeof usage[bucket], 'number', `${entry.name} 的 ${bucket} 不是数字`);
      assert.ok(Number.isFinite(usage[bucket]), `${entry.name} 的 ${bucket} 不是有限数`);
      assert.ok(usage[bucket] >= 0, `${entry.name} 的 ${bucket} 为负`);
    }
  }
});

check('反证：把 tokenUsage 行 val 改坏 → viewCheckpoint 必须丢弃（证明确实在校验）', () => {
  const entry = withUsage[0];
  const broken = { tokenUsage: { ...entry.rows.tokenUsage, val: { totally: 'wrong' } } };
  const values = registry.viewCheckpoint(broken);
  assert.equal(values.tokenUsage, undefined, '非法 val 竟然被放行 —— 校验没在跑');
});

check('反证：把 tokenUsage 行 ver 改坏 → viewCheckpoint 必须丢弃', () => {
  const entry = withUsage[0];
  const broken = { tokenUsage: { ...entry.rows.tokenUsage, ver: 999 } };
  const values = registry.viewCheckpoint(broken);
  assert.equal(values.tokenUsage, undefined, '版本不匹配的行竟然被放行');
});

/* ================================================================== *
 * B 段：客户端真值 —— 真 bundle 读真数值
 * ================================================================== */
console.log('');
console.log('=== B 段：客户端真值（真 bundle） ===');

const source = readFileSync(BUNDLE, 'utf8');
const registrations = [];
const warnings = [];
const timers = [];
const react = {
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
const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  document: {
    baseURI: 'http://127.0.0.1:3080/',
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelector() {
      return null;
    },
    createElement() {
      return { dataset: {}, textContent: '', style: {}, appendChild() {} };
    },
    addEventListener() {},
    removeEventListener() {},
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
  URLSearchParams,
  console: {
    log: (...args) => console.log(...args),
    warn: (...args) => warnings.push(args.join(' ')),
    error: (...args) => warnings.push(args.join(' ')),
  },
  setTimeout: (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  },
  clearTimeout() {},
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Map,
  Set,
  WeakMap,
  RegExp,
  Error,
  isFinite,
  Symbol,
  Promise,
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;
const vmContext = vm.createContext(sandbox);
vm.runInContext(source, vmContext, { filename: 'client.js' });

const exported = registrations[0].factory((spec) => {
  if (spec === 'react') return react;
  throw new Error(`unexpected require: ${spec}`);
});
const T = exported.__test;

check('真 bundle 导出了 v4 的四个新函数', () => {
  for (const name of ['tokenUsageOf', 'formatTokens', 'turnCount', 'shortModel']) {
    assert.equal(typeof T[name], 'function', `缺少 ${name}`);
  }
});

/* 取一条真实记录的数值，直接喂给客户端函数 */
const realEntry =
  withBoth.find((item) => item.rows[mine.PROJECTION_KEY].ver === myDefinition.stateVersion) ?? withUsage[0];
const realValues = registry.viewCheckpoint(realEntry.rows);
const realUsage = realValues.tokenUsage;
const realActivity = realValues[mine.PROJECTION_KEY];
assert.ok(realUsage, '拿不到真实 tokenUsage 值，B 段无法进行');

check('★ 客户端从真实 checkpoint 值算出输入/输出/总计', () => {
  const row = { sessionId: 'probe', projectionValues: { tokenUsage: realUsage } };
  const usage = T.tokenUsageOf(row);
  assert.ok(usage, 'tokenUsageOf 返回 null —— 面板会静默少一行');
  const expectedInput = realUsage.uncachedInputTokens + realUsage.cacheReadTokens + realUsage.cacheWriteTokens;
  assert.equal(usage.input, expectedInput);
  assert.equal(usage.output, realUsage.outputTokens);
  assert.equal(usage.total, expectedInput + realUsage.outputTokens);
  assert.ok(usage.total > 0, '真实记录的用量为 0，样例不成立');
  console.log(`       样例：输入 ${T.formatTokens(usage.input)} / 输出 ${T.formatTokens(usage.output)} / 合计 ${T.formatTokens(usage.total)}`);
});

check('tokenUsage 缺失 / 非对象 / 全零 → 返回 null（不抛、不显示假数）', () => {
  assert.equal(T.tokenUsageOf({ projectionValues: {} }), null);
  assert.equal(T.tokenUsageOf({}), null);
  assert.equal(T.tokenUsageOf(undefined), null);
  assert.equal(T.tokenUsageOf({ projectionValues: { tokenUsage: 42 } }), null);
  assert.equal(
    T.tokenUsageOf({
      projectionValues: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    }),
    null,
    '全零应当视为「还没用量」，显示 0 会误导'
  );
});

check('formatTokens 分级：0 / 999 / 1000 / 15000 / 1200000', () => {
  assert.equal(T.formatTokens(0), '0');
  assert.equal(T.formatTokens(999), '999');
  assert.equal(T.formatTokens(1000), '1K');
  assert.equal(T.formatTokens(15000), '15K');
  assert.equal(T.formatTokens(1200000), '1.2M');
  assert.equal(T.formatTokens(-5), '0');
});

check('turnCount：正数取用 / 0、负数、缺失、非数归 0', () => {
  assert.equal(T.turnCount({ turn: 47 }), 47);
  assert.equal(T.turnCount({ turn: 0 }), 0);
  assert.equal(T.turnCount({ turn: -3 }), 0);
  assert.equal(T.turnCount({}), 0);
  assert.equal(T.turnCount({ turn: '12' }), 0, '字符串轮数不是权威数据，必须拒绝');
  assert.equal(T.turnCount(undefined), 0);
});

check('shortModel：取末段、去日期后缀、超长截断', () => {
  assert.equal(T.shortModel('magpie/commandcode-plan/deepseek/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(T.shortModel('deepseek-v4.1-flash-20260101'), 'deepseek-v4.1-flash');
  assert.equal(T.shortModel('deepseek-v4.1-flash-2026-01-01'), 'deepseek-v4.1-flash');
  assert.equal(T.shortModel('solo'), 'solo');
  assert.equal(T.shortModel(''), '');
  assert.equal(T.shortModel(42), '');
  const long = T.shortModel('provider/averyveryverylongmodelname-here');
  assert.ok(long.endsWith('…'), `超长名未被截断：${long}`);
  assert.ok(long.length <= 20, `截断后仍过长：${long.length}`);
});

check('★ hasContent：只有 token 与轮数时也必须渲染面板（否则整块静默消失）', () => {
  const activity = mine.__test?.initActivity ? mine.__test.initActivity() : {
    seq: 0, turn: 6, step: 0, phase: 'idle', turnStart: 0, turnEnd: 0, stepStart: 0,
    tool: null, recent: [], prompt: '', reply: '', error: null, compaction: 0,
    toolCalls: 0, model: null, image: null,
  };
  const settings = T.defaultSettings();
  const row = { sessionId: 'probe', running: false, projectionValues: { tokenUsage: realUsage } };
  assert.equal(
    T.hasContent(activity, settings, row),
    true,
    '一个刚结束 turn、没有问答文本的会话，只凭用量行也该显示'
  );
  assert.equal(
    T.hasContent(activity, { ...settings, showUsage: false }, row),
    false,
    '关掉用量行后确实什么都不剩，应当返回 false'
  );
});

check('★ 真实活动 + 真实用量装进列表快照 → rowOfSnapshot → 渲染出非空树', () => {
  if (!realActivity) return; // 该记录尚未 fold 出 liveActivity，跳过渲染断言
  const snapshot = {
    ids: ['probe'],
    byId: {
      probe: {
        sessionId: 'probe',
        running: false,
        projectionValues: { [mine.PROJECTION_KEY]: realActivity, tokenUsage: realUsage },
      },
    },
  };
  const row = T.rowOfSnapshot(snapshot, 'probe');
  assert.ok(row, 'rowOfSnapshot 取不到行');
  assert.equal(row.projectionValues.tokenUsage, realUsage, 'tokenUsage 在取行时被丢掉');
  const settings = T.defaultSettings();
  const activity = row.projectionValues[mine.PROJECTION_KEY];
  assert.equal(T.hasContent(activity, settings, row), true);
  /* 注意：客户端工厂读的键名是 `t`（见 client.js:1074 `var t = options.t`），
     入口也传 `t`（client.js:1368）。写成 `translate` 会让面板渲染时抛错。 */
  const tree = T.createHoverPanel({
    getRow: () => row,
    store: { get: () => settings, subscribe: () => () => {}, load: () => Promise.resolve() },
    react,
    t: (key) => key,
  })({ sessionId: 'probe' });
  assert.ok(tree, '组件返回 null，真实数据下渲染不出东西');
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes('dsl-panel'), '渲染树里没有面板根节点');
  assert.equal(flat.includes('undefined'), false, '渲染树里混入了 undefined（非法 JSON 值）');

  /* stub 的 createElement 返回裸对象，函数型 type 不会自动执行 —— 这正是 React 在真实环境做的事。
     UsageLine 是唯一 props 带 row 的子节点，手动执行一次等价于渲染它。 */
  const children = Array.isArray(tree.children) ? tree.children : [];
  const usageNode = children.find((child) => child && typeof child.type === 'function' && child.props && child.props.row);
  assert.ok(usageNode, `渲染树里没有用量行节点，子节点类型：${children.map((c) => (c && c.type && c.type.name) || typeof c).join(',')}`);
  const rendered = usageNode.type(usageNode.props);
  assert.ok(rendered, '用量行返回 null —— 有真实 token 与轮数却没渲染');
  const usageFlat = JSON.stringify(rendered);
  assert.ok(usageFlat.includes('dsl-usage'), `用量行没打出 dsl-usage 类：${usageFlat}`);
  assert.ok(usageFlat.includes(T.formatTokens(realUsage.uncachedInputTokens + realUsage.cacheReadTokens + realUsage.cacheWriteTokens)), '用量行里没有真实输入量');
  console.log(`       渲染树 ${flat.length} 字符；用量行：${usageFlat}`);
});

/* ------------------------------------------------------------------ */
console.log('');
if (failures.length === 0) {
  console.log(`全部通过 ${checks} 项 —— token 用量与对话轮数在真实链路上确实可读、可渲染`);
  process.exit(0);
}
console.log(`${failures.length} / ${checks} 项失败：`);
for (const item of failures) {
  console.log(`  - ${item.label}: ${item.error.message}`);
}
process.exit(1);
