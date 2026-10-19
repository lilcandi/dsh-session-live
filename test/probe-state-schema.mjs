/**
 * 回归测试：折叠状态的 schema 必须字段级校验，且归一化必须产出纯 JSON。
 *
 * 为什么需要这个测试
 * ------------------
 * 旧实现把 `stateSchema` 写成「是个对象就行」（`isPlainObject`）。后果是
 * 一条被改写或旧版本插件留下的垃圾行（例如 `{totally:'wrong'}`）会被宿主
 * **静默接受**，随后 `wire.view` 产出 10 个 `undefined` 字段：
 *   seq / turn / step / prompt / reply / error / compaction / toolCalls /
 *   turnStart / stepStart
 * `undefined` 不是合法 JSON，既会随投影 wire 下发给客户端，也会被
 * `dsh-session-projection-cache` 的 `snapshotJsonValue` 写回 checkpoint
 * （`lib/index.js:349-350` 注明「not losslessly JSON-serializable」会直接抛）。
 *
 * 判据分三层
 * ----------
 *   A 真实数据不误杀：磁盘上 `C:\Users\candi\.dsh\storages\session_projcache\
 *     sessions\` 里每一条真实 `liveActivity` 行都必须通过新 schema。
 *     这是最重要的一条 —— 严格化绝不能把好数据挡在门外。
 *   B 垃圾必须被拦：`{totally:'wrong'}` 一类必须 parse 失败。
 *   C 即便有垃圾绕过 schema（例如未来校验放宽），`viewActivity` 与
 *     `normalizeState` 也必须产出零 undefined 的纯 JSON（第二道防线）。
 *
 * 所有断言都打在**真源码**上（import 插件的 activity.js / index.js），
 * 不靠复述。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { isCompleteState, normalizeState, initActivity, viewActivity, applyActivity } from '../src/activity.js';
import { createStateSchema, STATE_VERSION } from '../src/index.js';

const CACHE_DIR = 'C:\\Users\\candi\\.dsh\\storages\\session_projcache\\sessions';

const results = [];
const pending = [];

function check(label, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(
        out.then(
          () => results.push({ label, ok: true }),
          (error) => results.push({ label, ok: false, detail: String(error && error.message ? error.message : error) }),
        ),
      );
      return;
    }
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, detail: String(error && error.message ? error.message : error) });
  }
}

/** 递归找出值里的 undefined 路径（JSON 安全性判据）。 */
function undefinedPaths(value, path = '$', found = []) {
  if (value === undefined) {
    found.push(path);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, found));
    return found;
  }
  for (const key of Object.keys(value)) undefinedPaths(value[key], `${path}.${key}`, found);
  return found;
}

console.log('=== 探针：stateSchema 严格校验 + 归一化纯 JSON ===\n');

// ---------------------------------------------------------------- A 段
console.log('=== A 段：磁盘上真实 checkpoint 必须零误杀 ===');

const realRows = [];
if (existsSync(CACHE_DIR)) {
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(CACHE_DIR, name), 'utf8'));
    } catch {
      continue;
    }
    const rows = doc && doc.record && doc.record.rows;
    if (!rows || typeof rows !== 'object') continue;
    const row = rows.liveActivity;
    if (!row) continue;
    realRows.push({ file: name, row });
  }
}

check(`A0：找到真实 liveActivity 行（应 >0，否则后续断言无意义）`, () => {
  assert.ok(realRows.length > 0, `未在 ${CACHE_DIR} 找到 liveActivity 行`);
});

check(`A1：真实行按 ver 过滤（v1 行跳过=升级语义）+ v2 行通过新 stateSchema`, () => {
  const schema = createStateSchema();
  const bad = [];
  let checked = 0;
  let skipped = 0;
  for (const { file, row } of realRows) {
    if (row.ver !== STATE_VERSION) { skipped += 1; continue; }
    checked += 1;
    const parsed = schema.safeParse(row.val);
    if (!parsed.success) bad.push(`${file}: ${parsed.error.message}`);
  }
  assert.equal(checked + skipped, realRows.length, '行计数不符');
  // STATE_VERSION 1→2 升级后，磁盘 checkpoint 行仍是 v1（ver=1）→ 全部被
  // 过滤跳过（宿主 fold 路径从 seq=0 全量重放自愈）。若未来磁盘行已重写为
  // v2，上面循环会真正校验它们。这里额外用真折叠器产出的 v2 行验证 schema。
  const probe = applyActivity(applyActivity(initActivity(),
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } }),
    { seq: 2, type: 'model/selection', data: { provider: 'deepseek', model: 'test-model' } });
  assert.equal(schema.safeParse(probe).success, true, 'v2 构造行竟未通过 stateSchema');
  assert.equal(bad.length, 0, `被误杀：\n${bad.join('\n')}`);
});

check(`A2：真实行的顶层字段集合 = v1 集合（14 字段旧 checkpoint）或 v2 集合（16 字段）`, () => {
  const expected = Object.keys(initActivity()).sort();
  const v1Expected = expected.filter((key) => key !== 'model' && key !== 'image');
  for (const { file, row } of realRows) {
    const actual = Object.keys(row.val).sort();
    const isV2 = JSON.stringify(actual) === JSON.stringify(expected);
    const isV1 = JSON.stringify(actual) === JSON.stringify(v1Expected);
    assert.ok(isV2 || isV1, `${file} 字段集合既非 v2 也非 v1：${actual.join(',')}`);
    if (isV1) {
      // v1 行缺 model/image —— normalizeState 必须补齐成完整 v2 字段
      const normalized = normalizeState(row.val);
      assert.deepEqual(Object.keys(normalized).sort(), expected, `${file} v1 行 normalize 后仍残缺`);
    }
  }
});

check(`A3：真实行喂给 viewActivity 产出零 undefined`, () => {
  for (const { file, row } of realRows) {
    const view = viewActivity(row.val, 0, false);
    const bad = undefinedPaths(view);
    assert.deepEqual(bad, [], `${file} 产生 undefined: ${bad.join(', ')}`);
  }
});

check(`A4：真实行喂给 viewActivity 后 JSON 往返无损（可落盘）`, () => {
  for (const { file, row } of realRows) {
    const view = viewActivity(row.val, 0, false);
    const round = JSON.parse(JSON.stringify(view));
    assert.deepEqual(round, view, `${file} JSON 往返有损（存在 undefined 或不可序列化值）`);
  }
});

// ---------------------------------------------------------------- B 段
console.log('\n=== B 段：垃圾形状必须被 schema 拦下 ===');

const schema = createStateSchema();

const junkCases = [
  ['空对象', {}],
  ['纯垃圾键', { totally: 'wrong' }],
  ['缺 seq', { ...initActivity(), seq: undefined }],
  ['seq 是字符串', { ...initActivity(), seq: 'x' }],
  ['phase 非法', { ...initActivity(), phase: 'bogus' }],
  ['recent 非数组', { ...initActivity(), recent: 'nope' }],
  ['prompt 非字符串', { ...initActivity(), prompt: 42 }],
  ['是数组', []],
  ['是 null', null],
  ['是字符串', 'state'],
];

for (const [label, value] of junkCases) {
  check(`B：垃圾形状被拒 —— ${label}`, () => {
    const parsed = schema.safeParse(value);
    assert.equal(parsed.success, false, '竟然通过了校验');
  });
}

check('B：完整状态被接受（正对照，证明不是一律拒绝）', () => {
  const parsed = schema.safeParse(initActivity());
  assert.equal(parsed.success, true, `完整状态被拒：${parsed.error && parsed.error.message}`);
});

check('B：schema.parse 对垃圾抛错（宿主 viewCheckpoint 靠 catch 跳过该行）', () => {
  assert.throws(() => schema.parse({ totally: 'wrong' }));
});

check('B：schema.optional()/nullable() 仍可用（宿主可能这样包装）', () => {
  assert.equal(schema.optional().safeParse(undefined).success, true);
  assert.equal(schema.nullable().safeParse(null).success, true);
  assert.equal(schema.optional().safeParse({ totally: 'wrong' }).success, false);
});

// ---------------------------------------------------------------- C 段
console.log('\n=== C 段：第二道防线 —— 归一化必须产出纯 JSON ===');

check('C1：normalizeState 修正垃圾输入，产出零 undefined', () => {
  const out = normalizeState({ totally: 'wrong' });
  assert.deepEqual(undefinedPaths(out), []);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(initActivity()).sort());
});

check('C2：normalizeState 对 null/undefined/数组/字符串/数字都给出完整状态', () => {
  for (const value of [null, undefined, [], 'x', 0, true]) {
    const out = normalizeState(value);
    assert.equal(isCompleteState(out), true, `输入 ${JSON.stringify(value)} 未归一化完整`);
  }
});

check('C3：viewActivity 对垃圾输入也产出零 undefined（决定性防线）', () => {
  for (const value of [null, undefined, {}, { totally: 'wrong' }, [], 'x', 0]) {
    const view = viewActivity(value, 0, false);
    const bad = undefinedPaths(view);
    assert.deepEqual(bad, [], `输入 ${JSON.stringify(value)} 产生 undefined: ${bad.join(', ')}`);
  }
});

check('C4：viewActivity 对垃圾输入仍能 JSON 往返', () => {
  for (const value of [null, {}, { totally: 'wrong' }]) {
    const view = viewActivity(value, 0, false);
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  }
});

check('C5：嵌套字段被逐项修正（tool / recent / error 的字段级归一化）', () => {
  const out = normalizeState({
    ...initActivity(),
    tool: { name: 'pwsh' },
    recent: [{ name: 'read' }, 'garbage', null, { category: 7 }],
    error: { label: 'boom' },
  });
  assert.equal(out.tool.callId, '');
  assert.equal(out.tool.name, 'pwsh');
  assert.equal(out.tool.category, 'tools');
  assert.equal(out.tool.running, false);
  assert.equal(out.recent.length, 2, 'garbage/null 项应被剔除');
  assert.equal(out.recent[0].name, 'read');
  assert.equal(out.recent[1].category, 'tools');
  assert.equal(out.error.kind, 'error');
  assert.equal(out.error.label, 'boom');
  assert.equal(out.error.at, 0);
});

check('C6：recent 超长被截到 RECENT_MAX', () => {
  const many = Array.from({ length: 40 }, (unused, index) => ({ name: `t${index}` }));
  const out = normalizeState({ ...initActivity(), recent: many });
  assert.ok(out.recent.length <= 12, `recent 长度 ${out.recent.length} 未被截断`);
});

// ------------------------------------------------- D 段：引用同一性
console.log('\n=== D 段：归一化不得破坏宿主的 Object.is 发布抑制 ===');

check('D1：状态完整且事件无关时 applyActivity 返回同一引用', () => {
  const state = initActivity();
  const out = applyActivity(state, { type: 'unknown/event', seq: state.seq, time: 1, data: {} });
  assert.equal(out, state, '完整状态下无关事件必须返回同一引用，否则每次事件都推全量');
});

check('D2：状态是垃圾时 applyActivity 返回完整状态（不崩）', () => {
  const out = applyActivity({ totally: 'wrong' }, { type: 'turn/start', seq: 5, time: 100, data: { turn: 1 } });
  assert.equal(isCompleteState(out), true);
  assert.equal(out.phase, 'turn');
  assert.equal(out.seq, 5);
});

check('D3：applyActivity 对 null 状态不崩', () => {
  const out = applyActivity(null, { type: 'step/start', seq: 3, time: 50, data: { turn: 1, step: 2 } });
  assert.equal(isCompleteState(out), true);
  assert.equal(out.step, 2);
});

check('D4：连续 200 次折叠（含垃圾起点）后状态始终完整', () => {
  let state = { totally: 'wrong' };
  const types = [
    ['turn/start', { turn: 1 }],
    ['step/start', { turn: 1, step: 1 }],
    ['tool/call', { callId: 'c1', name: 'pwsh', arguments: { command: 'ls' } }],
    ['tool/result', { callId: 'c1', message: 'ok' }],
    ['step/end', { turn: 1, step: 1 }],
    ['turn/end', { reason: 'completed' }],
    ['user/message', { message: 'hi' }],
    ['assistant/message', { message: 'hello' }],
  ];
  for (let index = 0; index < 200; index++) {
    const [type, data] = types[index % types.length];
    state = applyActivity(state, { type, seq: index, time: 1000 + index, data });
    assert.equal(isCompleteState(state), true, `第 ${index} 步（${type}）后状态不完整`);
    assert.deepEqual(undefinedPaths(state), [], `第 ${index} 步（${type}）后出现 undefined`);
  }
  // 全部事件跑完后视图也必须干净
  assert.deepEqual(undefinedPaths(viewActivity(state, 2000, true)), []);
});

// ---------------------------------------------------------------- 汇总
await Promise.all(pending);
let failed = 0;
for (const row of results) {
  if (row.ok) console.log(`  ok   ${row.label}`);
  else {
    failed++;
    console.log(`  FAIL ${row.label}${row.detail ? ` — ${row.detail}` : ''}`);
  }
}
console.log('');
if (failed === 0) {
  console.log(`stateSchema 回归：全部通过 ${results.length} 项`);
  console.log(`（真实 checkpoint 样本 ${realRows.length} 条）`);
  process.exit(0);
}
console.log(`stateSchema 回归：失败 ${failed} / ${results.length} 项`);
process.exit(1);
