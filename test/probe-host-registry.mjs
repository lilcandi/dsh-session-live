/**
 * 真实链路验证：把本插件交给**真 cordis Registry**，看宿主能否拿到 Config。
 *
 * 前面几个探针都是复刻宿主源码逐行比对，能证明「逻辑成立」；
 * 这个文件证明的是「真的成立」—— 直接调用 cordis 的
 *   registry.plugin(plugin, config) → fiber → runtime.Config
 * 然后对 runtime.Config 调 `resolveConfig` 用的那条 standard-schema 通道
 * （`cordis/lib/index.js:956-962`）：
 *   runtime.Config["~standard"].validate(config)
 * 最后复刻 dsh-settings 的 `schema(entry)` / `volatileForm` / `describe` 守卫。
 *
 * 运行：node test/probe-host-registry.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 与 cordis-plugin-loader/lib/index.js:667-672 逐行一致 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}

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

const cordis = await import(
  'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
);
const Context = cordis.Context ?? cordis.default;
console.log('cordis 载入 :', typeof Context === 'function' ? 'ok' : 'FAILED');

const namespace = await import('../index.js');
const plugin = unwrapExports(namespace);

/* ---------------- 1. registry.plugin 是否接受我们的形态 ---------------- */

let registry;
let fiber;
check('开始前确保插件没有全局注册残留', () => {
  registry = new Context().registry;
  assert.equal(registry.has(plugin), false);
});

check('★ registry.plugin(plugin, config) 接受纯具名导出形态（含 default 就会被顶替）', () => {
  fiber = registry.plugin(plugin, { settings: { dense: true, recentCount: 7 } });
  assert.ok(fiber, 'registry.plugin 返回空');
});

check('★ fiber 的 runtime 上带着 Config（dsh-settings 的 schema(entry) 读这里）', () => {
  const record = registry.get(plugin);
  assert.ok(record, 'registry 里查不到 runtime');
  assert.notEqual(record.Config, undefined, 'runtime.Config 是 undefined —— 设置页必然 409');
  assert.equal('toJSON' in record.Config, true);
});

check('runtime.name 与插件名一致', () => {
  const record = registry.get(plugin);
  assert.equal(record.name, 'dsh-session-live');
});

/* ---------------- 2. 复刻 resolveConfig 的 standard-schema 通道 ---------------- */

check('★ Config 具备 standard-schema 接口（resolveConfig 靠它验证配置）', () => {
  const record = registry.get(plugin);
  const std = record.Config['~standard'];
  assert.ok(std, 'Config["~standard"] 缺失 —— resolveConfig 会抛 TypeError');
  assert.equal(typeof std.validate, 'function');
});

check('★ resolveConfig 语义：合法配置直接通过', () => {
  const record = registry.get(plugin);
  const result = record.Config['~standard'].validate({ settings: { dense: true, recentCount: 7 } });
  assert.equal('then' in result, false, '不允许异步校验');
  assert.equal(result.issues, undefined, `校验报错：${JSON.stringify(result.issues)}`);
  assert.ok(result.value, '没有返回 value');
});

check('resolveConfig 语义：越界值被拒（recentCount 上限 12）', () => {
  const record = registry.get(plugin);
  const result = record.Config['~standard'].validate({ settings: { recentCount: 99 } });
  assert.notEqual(result.issues, undefined, '99 竟然通过了');
});

check('resolveConfig 语义：合法配置的解析值保留用户设置', () => {
  const record = registry.get(plugin);
  const result = record.Config['~standard'].validate({ settings: { dense: true, recentCount: 7 } });
  const value = result.value;
  // volatile 字段解析后是包装对象，dsh-settings 用 plainConfig 展开（:97-102）
  const readNum = (v) => (v && typeof v.get === 'function' ? v.get() : v);
  assert.equal(readNum(value.settings.recentCount), 7);
  assert.equal(readNum(value.settings.dense), true);
  assert.equal(readNum(value.settings.enabled), true, '未提供的字段吃到默认值');
});

/* ---------------- 3. 复刻 dsh-settings 的 describe 守卫 ---------------- */

check('★ describe 的 fiber 守卫能通过（schema 有、fiber 有、runtime 非空、state===2）', () => {
  const record = registry.get(plugin);
  const entry = {
    name: 'dsh-session-live',
    fiber: { runtime: record, state: 2 },
    options: { id: 'dsh-session-live' },
  };
  // dsh-settings/lib/index.js:516
  const guard = !(record === undefined || entry.fiber === undefined || entry.fiber.runtime === null || entry.fiber.state !== 2);
  assert.equal(guard, true, 'describe 会 return [] 把条目丢掉');
  // dsh-settings/lib/index.js:660-663
  const schema = entry.fiber?.runtime?.Config;
  assert.notEqual(schema, undefined);
  assert.equal(schema !== undefined && 'toJSON' in schema, true);
});

/* ---------------- 汇总 ---------------- */
console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} / ${checks}`);
  for (const failure of failures) console.error(` - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`全部通过 ${checks} 项 —— Config 在真 cordis registry 上存活且可校验`);
