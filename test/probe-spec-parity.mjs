/**
 * 三方同源回归测试 —— client.js / src/shared.js / src/config-schema.js。
 *
 * ## 为什么需要这条测试
 * 本插件的设置字段清单存在于**三个物理位置**：
 *   1. `src/shared.js` 的 `SETTINGS_SPEC` —— 宿主半边与测试的权威来源；
 *   2. `client.js` 里内联的一份副本 —— 浏览器 bundle 是手写 CJS，不能 import 宿主的 ESM；
 *   3. `src/config-schema.js` 的 `Config` —— 由 (1) 派生，已由 probe-boundary-parity 守住。
 *
 * (2) 是唯一无法自动派生的一处。它一旦与 (1) 漂移，重现的正是已经踩过的坑：
 * 设置页按旧边界允许某个值 → 存进 profile → 下次启动 `Config` 校验拒绝 →
 * 插件 failed。这条测试就是那一处的守卫。
 *
 * ## 做法
 * 从 client.js 源码里**真实提取**内联的 SETTINGS_SPEC 字面量并求值，
 * 与 src/shared.js 的 SETTINGS_SPEC 做逐字段深比较。
 * 提取失败一律判 FAIL（不静默跳过）—— 静默跳过等于守卫失效。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const shared = await import(new URL('../src/shared.js', import.meta.url).href);

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

/** 从 client.js 源码里提取内联的 SETTINGS_SPEC 数组字面量并求值。 */
function extractClientSpec() {
  const source = readFileSync(path.join(root, 'client.js'), 'utf8');
  const marker = 'var SETTINGS_SPEC = [';
  const start = source.indexOf(marker);
  if (start < 0) return { ok: false, reason: '未找到 "var SETTINGS_SPEC = [" 标记' };

  const bodyStart = start + marker.length - 1; // 指向 '['
  // 括号配对扫描，跳过字符串字面量，找到与之匹配的 ']'。
  let depth = 0;
  let quote = null;
  let end = -1;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return { ok: false, reason: '括号未配对，提取失败' };

  const literal = source.slice(bodyStart, end + 1);
  try {
    const value = vm.runInNewContext(`(${literal})`, Object.create(null));
    if (!Array.isArray(value) || value.length === 0) {
      return { ok: false, reason: `提取结果不是非空数组（得到 ${typeof value}）` };
    }
    return { ok: true, value, literal, line: source.slice(0, start).split('\n').length };
  } catch (error) {
    return { ok: false, reason: `字面量求值失败：${error.message}` };
  }
}

console.log('════════ 1. 提取 client.js 内联规格 ════════');
const extracted = extractClientSpec();
check('能从 client.js 提取出 SETTINGS_SPEC 字面量', extracted.ok, extracted.reason);
if (!extracted.ok) {
  console.log('');
  console.log('════════ 结论 ════════');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('提取失败 —— 守卫无法生效，等同于失效。请检查 client.js 结构。');
  process.exit(1);
}
console.log(`  info 提取自 client.js:${extracted.line}，共 ${extracted.value.length} 项`);
check('提取到的项数与 src/shared.js 一致', extracted.value.length === shared.SETTINGS_SPEC.length,
  `client=${extracted.value.length} shared=${shared.SETTINGS_SPEC.length}`);

console.log('');
console.log('════════ 2. 逐字段深比较 ════════');
{
  const byKey = new Map(extracted.value.map((s) => [s.key, s]));
  const fields = ['key', 'kind', 'default', 'min', 'max', 'step'];

  for (const spec of shared.SETTINGS_SPEC) {
    const clientSpec = byKey.get(spec.key);
    if (!clientSpec) {
      check(`client.js 含字段 ${spec.key}`, false, '缺失');
      continue;
    }
    const diffs = [];
    for (const field of fields) {
      const a = spec[field];
      const b = clientSpec[field];
      if (a !== b) diffs.push(`${field}: shared=${JSON.stringify(a)} client=${JSON.stringify(b)}`);
    }
    check(
      `${spec.key} 六个字段完全一致`,
      diffs.length === 0,
      diffs.join('；'),
    );
  }

  const specKeys = new Set(shared.SETTINGS_SPEC.map((s) => s.key));
  const extra = extracted.value.filter((s) => !specKeys.has(s.key)).map((s) => s.key);
  check('client.js 没有多余字段', extra.length === 0, extra.join(','));
}

console.log('');
console.log('════════ 3. 顺序一致（设置页渲染顺序 = 用户看到的顺序）════════');
{
  const a = shared.SETTINGS_SPEC.map((s) => s.key);
  const b = extracted.value.map((s) => s.key);
  check('字段顺序一致', JSON.stringify(a) === JSON.stringify(b), `shared=${a.join('>')} client=${b.join('>')}`);
}

console.log('');
console.log('════════ 4. 数值边界语义一致（0 表隐藏）════════');
{
  const rc = extracted.value.find((s) => s.key === 'recentCount');
  const srcRc = shared.SETTINGS_SPEC.find((s) => s.key === 'recentCount');
  check('client.js 的 recentCount 下界是 0（0 有语义：隐藏）', rc && rc.min === 0, `得到 ${rc && rc.min}`);
  check('client.js 的 recentCount 上界是 12', rc && rc.max === 12, `得到 ${rc && rc.max}`);
  check('client.js 与 shared.js 的 recentCount 默认值一致', rc && srcRc && rc.default === srcRc.default);
}

console.log('');
console.log('════════ 5. 复盘：旧 bug 若复现，这条测试会拦住吗 ════════');
{
  // 模拟「client.js 用 min:0、Config 用 min:1」的旧漂移：把共享侧改成 min:1，
  // 再看比较逻辑是否报出差异 —— 这是对守卫本身的元测试。
  const mutated = shared.SETTINGS_SPEC.map((s) =>
    s.key === 'recentCount' ? { ...s, min: 1 } : s);
  const clientRc = extracted.value.find((s) => s.key === 'recentCount');
  const mutatedRc = mutated.find((s) => s.key === 'recentCount');
  check(
    '元测试：把 shared.js 的 min 改成 1 后，比较逻辑能报出差异',
    clientRc.min !== mutatedRc.min,
    '守卫自身失去辨别力',
  );
}

console.log('');
console.log('════════ 结论 ════════');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(
  fail === 0
    ? '三方同源：client.js 内联规格与 src/shared.js 逐字段一致，Config 又由 shared.js 派生。'
    : '存在规格漂移 —— 设置页与 Config 的边界可能不再一致。',
);
process.exit(fail === 0 ? 0 : 1);
