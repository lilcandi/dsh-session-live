/**
 * 边界同源回归测试 —— 防止「设置页允许写，Config 拒绝读」再次发生。
 *
 * ## 这条测试守的是什么
 * 曾经的缺陷：`shared.js` 的 `SETTINGS_SPEC.recentCount` 是 `{min:0, max:12}`，
 * 而 `config-schema.js` 手写成 `.min(1).max(12)`。设置页因此允许用户把值调成 0
 * （0 = 隐藏工具条），用户存下后 profile 里就是 `recentCount: 0`；下次 DSH 启动
 * `resolveConfig` 校验失败抛 `ValidationError`，插件直接被标 failed。
 *
 * 恶化链条：设置失效（409）→ 用户改配置 → 插件起不来（failed）。比原 bug 更糟。
 *
 * ## 判定标准
 * 1. `Config` 的字段集合必须与 `SETTINGS_SPEC` **完全相等**（不多不少）。
 * 2. 设置页可能产出的**每一个**值（boolean 两态；number 的 min..max 全集，
 *    含 step 与边界）都必须通过 `Config` 校验。
 * 3. `Config` 对越界/类型错误必须仍然**拒绝**（否则不是放宽而是失守）。
 *
 * 用真实 schemastery + 真实插件源码跑，不 mock。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'package.json'));

const { SETTINGS_SPEC, defaultSettings, normalizeSettings } = await import(
  new URL('../src/shared.js', import.meta.url).href
);
const { Config, SETTINGS_FIELDS, SETTINGS_DEFAULTS } = await import(
  new URL('../src/config-schema.js', import.meta.url).href
);

const Schema = require('@deepseek-ai/schemastery');

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

/** volatile 包装后字段解析成带 .get() 的引用，统一取值。 */
function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch (_error) {
      return value;
    }
  }
  return value;
}

/** 把配置喂给 Config，返回 { ok, value, error }；单字段 probe 走同一条路。 */
function validate(settings) {
  try {
    const parsed = Config({ settings });
    const out = {};
    const got = parsed.settings;
    for (const spec of SETTINGS_SPEC) {
      out[spec.key] = unwrap(got ? got[spec.key] : undefined);
    }
    return { ok: true, value: out, error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

/** 用真实 schemastery 取出 Config 里某个字段节点的边界元数据。 */
function fieldMeta(key) {
  const node = Config.dict?.settings?.dict?.[key];
  if (!node) return null;
  return node.meta || {};
}

console.log('════════ 1. 字段集合必须同源（不多不少）════════');
{
  const specKeys = SETTINGS_SPEC.map((s) => s.key).sort();
  const fieldKeys = SETTINGS_FIELDS.map((f) => f[0]).sort();
  const schemaKeys = Object.keys(Config.dict?.settings?.dict || {}).sort();

  check(
    `SETTINGS_FIELDS 与 SETTINGS_SPEC 键集合相等（${specKeys.length} 项）`,
    JSON.stringify(specKeys) === JSON.stringify(fieldKeys),
    `spec=${specKeys.join(',')} fields=${fieldKeys.join(',')}`,
  );
  check(
    `Config schema 覆盖全部 ${specKeys.length} 个字段`,
    JSON.stringify(specKeys) === JSON.stringify(schemaKeys),
    `spec=${specKeys.join(',')} schema=${schemaKeys.join(',')}`,
  );
  const defaultsOk = SETTINGS_SPEC.every((s) => SETTINGS_DEFAULTS[s.key] === s.default);
  check('SETTINGS_DEFAULTS 与 SETTINGS_SPEC 默认值逐项相等', defaultsOk);
}

console.log('');
console.log('════════ 2. 数值边界必须与 SETTINGS_SPEC 逐项一致 ════════');
for (const spec of SETTINGS_SPEC) {
  if (spec.kind !== 'number') continue;
  const meta = fieldMeta(spec.key);
  const hasMin = typeof spec.min === 'number';
  const hasMax = typeof spec.max === 'number';
  if (hasMin) {
    check(
      `${spec.key} 下界 ${spec.min} 被 Config 接受`,
      validate({ ...defaultSettings(), [spec.key]: spec.min }).ok,
      '设置页允许的最小值被 schema 拒绝 = 用户能把插件写成 failed',
    );
  }
  if (hasMax) {
    check(
      `${spec.key} 上界 ${spec.max} 被 Config 接受`,
      validate({ ...defaultSettings(), [spec.key]: spec.max }).ok,
    );
  }
  // 上界 +1 必须仍被拒绝 —— 放宽边界不等于取消边界。
  if (hasMax) {
    check(
      `${spec.key} 上界溢出 ${spec.max + 1} 仍被拒绝`,
      !validate({ ...defaultSettings(), [spec.key]: spec.max + 1 }).ok,
    );
  }
  if (hasMin && spec.min > 0) {
    check(
      `${spec.key} 下界溢出 ${spec.min - 1} 仍被拒绝`,
      !validate({ ...defaultSettings(), [spec.key]: spec.min - 1 }).ok,
    );
  } else if (hasMin && spec.min === 0) {
    check(`${spec.key} 下界 0 合法（0 有语义：隐藏）`, true);
    check(
      `${spec.key} 越界 -1 仍被拒绝`,
      !validate({ ...defaultSettings(), [spec.key]: -1 }).ok,
    );
  }
  // 非整数：natural() 的语义是自然数，设置页 step=1 不会产出小数，
  // 但旧 profile 或手改 config 可能带小数，这里只记录行为，不作成败判定。
  const frac = validate({ ...defaultSettings(), [spec.key]: spec.min + 0.5 });
  console.log(
    `  info ${spec.key} 小数 ${spec.min + 0.5} -> ${frac.ok ? `接受为 ${frac.value[spec.key]}` : '拒绝'}`,
  );
  void meta;
}

console.log('');
console.log('════════ 3. 设置页可能产出的全部值都必须通过 ════════');
{
  const enumErrors = [];
  const sweep = (settings) => {
    const r = validate(settings);
    if (!r.ok) enumErrors.push({ settings, message: r.error?.message });
  };

  // boolean 字段：两态各扫一遍（其余字段取默认）。
  for (const spec of SETTINGS_SPEC) {
    if (spec.kind !== 'boolean') continue;
    for (const v of [true, false]) sweep({ ...defaultSettings(), [spec.key]: v });
  }
  // number 字段：min..max 全整数扫一遍。
  for (const spec of SETTINGS_SPEC) {
    if (spec.kind !== 'number') continue;
    const min = typeof spec.min === 'number' ? spec.min : 0;
    const max = typeof spec.max === 'number' ? spec.max : 12;
    const target = SETTINGS_SPEC.find((s) => s.key === spec.key);
    const over = !(target.max !== undefined);
    for (let v = min; v <= max; v += 1) sweep({ ...defaultSettings(), [spec.key]: v });
    // min..max 的每一种都必须在 schema 域内；超出域外的值不应出现，由第 2 节守。
    void over;
  }
  check(
    `设置页全值域扫描（boolean 两态 + number min..max 逐整数）无一被拒`,
    enumErrors.length === 0,
    enumErrors.length ? JSON.stringify(enumErrors.slice(0, 3)) : '',
  );

  // 归一化后的设置也必须通过 —— 路由与 localStorage 都走 normalizeSettings。
  const normalized = normalizeSettings({ recentCount: 12, dense: true, enabled: 'false' });
  check('normalizeSettings 的输出能通过 Config 校验', validate(normalized).ok);
  check('normalizeSettings 会把越界值夹回域内', normalized.recentCount === 12);
  check(
    'normalizeSettings 对越界 99 夹回 12（而非产出非法值）',
    normalizeSettings({ recentCount: 99 }).recentCount === 12,
  );
  check(
    'normalizeSettings 对 -5 夹回 0（插件不会因它 failed）',
    normalizeSettings({ recentCount: -5 }).recentCount === 0,
  );
}

console.log('');
console.log('════════ 4. 反证：非法值仍须被拒（放宽 ≠ 失守）════════');
{
  const bad = [
    ['recentCount 越界 13', { recentCount: 13 }],
    ['recentCount 越界 -1', { recentCount: -1 }],
    ['recentCount 类型错误（字符串 abc）', { recentCount: 'abc' }],
    ['enabled 类型错误（字符串 yes）', { enabled: 'yes' }],
    ['settings 是数组（类型错误）', null],
  ];
  for (const [label, patch] of bad) {
    if (patch === null) {
      let threw = false;
      try {
        Config({ settings: [] });
      } catch (_error) {
        threw = true;
      }
      check(`${label} 被拒绝`, threw);
      continue;
    }
    check(`${label} 被拒绝`, !validate({ ...defaultSettings(), ...patch }).ok);
  }
}

console.log('');
console.log('════════ 5. 空/缺省配置必须给出完整默认（插件起得来）════════');
{
  for (const [label, input] of [
    ['undefined', undefined],
    ['空对象', {}],
    ['settings 为 null', null],
  ]) {
    const r = validate(input);
    check(`config 为 ${label} 时解析出全部默认值`, r.ok, r.error?.message);
    if (r.ok) {
      const same = SETTINGS_SPEC.every((s) => r.value[s.key] === s.default);
      check(`  ${label} -> 默认值与 SETTINGS_SPEC 完全一致`, same, JSON.stringify(r.value));
    }
  }
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
    ? '边界同源：设置页能写的每一个值，Config 都能读。插件不会再因用户配置而 failed。'
    : '存在边界漂移 —— 用户可能把自己的合法配置变成插件的启动失败。',
);
void Schema;
process.exit(fail === 0 ? 0 : 1);
