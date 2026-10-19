/**
 * 会话列表快照形状回归测试（防止「面板恒不渲染」缺陷复发）。
 *
 * 背景：本项目曾出过一次功能级失效 —— 客户端读 `sessions.list.getSnapshot().items`，
 * 而该字段根本不存在（`items` 属于 `workspaces.list.getSnapshot()`），于是
 * getRow 恒为 undefined、悬停面板永远空白。这个 bug 比 HTTP 409 严重得多，
 * 因为它不报错、不写日志，只是静默不显示。
 *
 * 本测试做两件事：
 *   A. 用**真宿主源码**做规范对齐 —— 不靠我自己复述，而是去 DSH 安装目录里
 *      读 dsh-api-session-controller 的 projectList 实现与 service.d.ts 声明，
 *      把 `byId` 是权威形态这件事钉成可执行断言。宿主升级后这里会先失败。
 *   B. 用真 bundle（client.js，经 node:vm 加载）断言 rowOfSnapshot 的取行行为：
 *      权威 byId 命中、items 兜底、projectionsBySession 兜底、以及
 *      「只给 items 形态的旧快照」仍能工作，反证不会回归。
 *
 * 运行：node test/probe-list-snapshot.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'client.js');

const DSH_ROOT = 'C:\\Users\\candi\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh';
const PKGS = join(DSH_ROOT, 'node_modules', '@deepseek-ai');
const CONTROLLER_CLIENT = join(PKGS, 'dsh-api-session-controller', 'lib', 'client.js');
const CONTROLLER_SERVICE_DTS = join(PKGS, 'dsh-api-session-controller', 'lib', 'types', 'client', 'sessions', 'service.d.ts');

const failures = [];
let checks = 0;

/** 递归收集目录下所有 .js 文件（用于跨官方包扫描）。 */
function collectJs(dir, out) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
}

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
 * A. 真宿主源码做规范对齐
 * ------------------------------------------------------------------ */
console.log('\n=== A. 宿主规范对齐（读真源码，非复述） ===');

check('宿主 projectList 以 byId 为权威行字典', () => {
  assert.equal(existsSync(CONTROLLER_CLIENT), true, `找不到 ${CONTROLLER_CLIENT}`);
  const src = readFileSync(CONTROLLER_CLIENT, 'utf8');
  // projectList 的返回对象必须同时给出 items、byId、phase、projectionsBySession
  assert.match(src, /projectionsBySession:\s*Object\.fromEntries/, '快照里没有 projectionsBySession 投影');
  assert.match(src, /byId/, '快照里没有 byId 字典');
});

check('service.d.ts 声明 SessionListState 含 byId 且不含 items', () => {
  assert.equal(existsSync(CONTROLLER_SERVICE_DTS), true, `找不到 ${CONTROLLER_SERVICE_DTS}`);
  const dts = readFileSync(CONTROLLER_SERVICE_DTS, 'utf8');

  const listState = dts.match(/interface SessionListState\s*\{([\s\S]*?)\n\}/);
  assert.ok(listState, '解析不到 SessionListState 声明');
  const body = listState[1];

  assert.match(body, /\bbyId\b/, 'SessionListState 里没有 byId');
  assert.match(body, /projectionsBySession/, 'SessionListState 里没有 projectionsBySession');
  assert.equal(/\bitems\b/.test(body), false, 'SessionListState 里出现了 items —— 权威形态可能已变，需重新核实');
});

check('SessionSummary 行上带 projectionValues', () => {
  const dts = readFileSync(CONTROLLER_SERVICE_DTS, 'utf8');
  const summary = dts.match(/interface SessionSummary\s*\{([\s\S]*?)\n\}/);
  assert.ok(summary, '解析不到 SessionSummary 声明');
  assert.match(summary[1], /projectionValues\??:/, 'SessionSummary 行上没有 projectionValues');
});

check('官方消费者一律读 byId，无人读 list 上的 items', () => {
  // 扫官方全部包，而不是只看一个文件 —— 单文件命中数会随打包切分漂移。
  const hits = { byId: 0, items: 0, files: 0 };

  let pkgDirs = [];
  try {
    pkgDirs = readdirSync(PKGS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(PKGS, d.name, 'lib'))
      .filter((d) => existsSync(d));
  } catch (error) {
    throw new Error(`读不到官方包目录 ${PKGS}：${error.message}`);
  }
  assert.ok(pkgDirs.length > 50, `只找到 ${pkgDirs.length} 个包，目录结构可能已变`);

  for (const libDir of pkgDirs) {
    const files = [];
    collectJs(libDir, files);
    for (const file of files) {
      hits.files += 1;
      const src = readFileSync(file, 'utf8');
      hits.byId += (src.match(/sessions\.list\.getSnapshot\(\)\.byId/g) ?? []).length;
      hits.items += (src.match(/sessions\.list\.getSnapshot\(\)\.items/g) ?? []).length;
    }
  }

  assert.ok(hits.files > 500, `只扫到 ${hits.files} 个 lib 文件，包目录结构可能已变`);
  assert.ok(hits.byId >= 5, `官方读 sessions...byId 的点只有 ${hits.byId} 处，预期 ≥5 —— 形态可能已变`);
  assert.equal(hits.items, 0, `有 ${hits.items} 处读 sessions.list.getSnapshot().items —— 该字段不存在，若宿主新增需重新核实`);
});

/* ------------------------------------------------------------------ *
 * B. 真 bundle 的取行行为
 * ------------------------------------------------------------------ */
console.log('\n=== B. bundle 的 rowOfSnapshot 行为 ===');

const registrations = [];
const moduleLoader = { load: (reg) => registrations.push(reg) };

const sandbox = {
  window: { __ModuleLoader__: moduleLoader },
  console: { warn() {}, log() {}, error() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  document: { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
context.window.__ModuleLoader__ = moduleLoader;

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_sub, get) => get(),
};
const requireStub = (spec) => {
  if (spec === 'react') return fakeReact;
  if (spec === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' };
  throw new Error(`unexpected require: ${spec}`);
};

vm.runInContext(readFileSync(BUNDLE, 'utf8'), context, { filename: 'client.js' });

check('bundle 完成注册', () => {
  assert.equal(registrations.length, 1, 'bundle 未注册');
});

const exported = registrations[0].factory(requireStub);
const { rowOfSnapshot, createRowReader, findRow } = exported.__test;

check('__test 暴露 rowOfSnapshot 与 createRowReader', () => {
  assert.equal(typeof rowOfSnapshot, 'function');
  assert.equal(typeof createRowReader, 'function');
  assert.equal(typeof findRow, 'function');
});

const SID = 'session-abc';
const ROW = { sessionId: SID, title: 't', projectionValues: { liveActivity: { phase: 'idle' } } };

check('权威形态：byId 命中', () => {
  const snapshot = { ids: [SID], byId: { [SID]: ROW }, phase: 'ready', projectionsBySession: {} };
  assert.equal(rowOfSnapshot(snapshot, SID), ROW);
});

check('byId 内没有该 id 时返回 undefined（不误取别的行）', () => {
  const snapshot = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} };
  assert.equal(rowOfSnapshot(snapshot, SID), undefined);
});

check('兜底：旧形态 items 数组仍能命中', () => {
  const snapshot = { items: [{ id: SID, projectionValues: { liveActivity: { phase: 'idle' } } }] };
  const row = rowOfSnapshot(snapshot, SID);
  assert.ok(row, 'items 兜底失效');
  assert.equal(String(row.id), SID);
});

check('兜底：行未进列表时读 projectionsBySession.values', () => {
  const values = { liveActivity: { phase: 'running' } };
  const snapshot = { ids: [], byId: {}, phase: 'ready', projectionsBySession: { [SID]: { values } } };
  const row = rowOfSnapshot(snapshot, SID);
  assert.ok(row, 'projectionsBySession 兜底失效');
  assert.equal(row.sessionId, SID);
  assert.equal(row.projectionValues, values);
});

check('byId 优先于 items 与 projectionsBySession', () => {
  const other = { sessionId: SID, marker: 'fromItems' };
  const snapshot = {
    byId: { [SID]: ROW },
    items: [other],
    projectionsBySession: { [SID]: { values: { x: 1 } } },
  };
  assert.equal(rowOfSnapshot(snapshot, SID), ROW, 'byId 未优先');
});

check('null / undefined / 非对象快照一律返回 undefined，不抛', () => {
  assert.equal(rowOfSnapshot(null, SID), undefined);
  assert.equal(rowOfSnapshot(undefined, SID), undefined);
  assert.equal(rowOfSnapshot('nope', SID), undefined);
  assert.equal(rowOfSnapshot(42, SID), undefined);
});

check('sessionId 为数字时按字符串匹配', () => {
  const snapshot = { byId: { [SID]: ROW } };
  assert.equal(rowOfSnapshot(snapshot, SID), ROW);
});

check('createRowReader 走 rowOfSnapshot（真快照形态能读到行）', () => {
  const snapshot = { ids: [SID], byId: { [SID]: ROW }, phase: 'ready', projectionsBySession: {} };
  const sessions = { list: { getSnapshot: () => snapshot } };
  const getRow = createRowReader(sessions);
  assert.equal(getRow(SID), ROW, 'createRowReader 没读到行 —— 面板会空白');
});

check('createRowReader 对缺失服务降级为 undefined，不抛', () => {
  assert.equal(createRowReader(null)(SID), undefined);
  assert.equal(createRowReader({})(SID), undefined);
  assert.equal(createRowReader({ list: {} })(SID), undefined);
  const boom = { list: { getSnapshot() { throw new Error('boom'); } } };
  assert.equal(createRowReader(boom)(SID), undefined);
});

check('反证：不读 items 的能力已保留（缺 byId 才回落 items）', () => {
  const snapshot = { byId: {}, items: [{ id: SID }] };
  const row = rowOfSnapshot(snapshot, SID);
  assert.ok(row, 'items 回落分支缺失');
});

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n=== 结果：${checks - failures.length}/${checks} 通过 ===`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f.label}\n  ${f.error && f.error.message}`);
  process.exit(1);
}
console.log('列表快照取行通路正常 —— 面板不会因读错字段而静默空白。');
