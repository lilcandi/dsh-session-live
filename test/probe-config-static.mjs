/**
 * 探针：验证「同步解析 schemastery + 构建静态 Config」这条路径可行。
 *
 * 为什么不用 `await import()` / 顶层 await：
 * 加载器在 `cordis/lib/index.js:1627-1631` 处读 `plugin.Config` 建 runtime 记录，
 * 而 `plugin` 是 `unwrapExports(moduleNamespace)` 的产物。顶层 await 虽然合法，
 * 但会把「模块加载成功」与「schemastery 解析成功」绑死——源目录解析不到依赖时
 * 整个模块会加载失败（failed），而不是降级。用 createRequire + try/catch
 * 同步取，解析不到就 Config=null（降级为只读设置页）。
 *
 * 同时验证 unwrapExports 的真实语义：default 导出会被优先取走。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

console.log('=== A. createRequire 解析 schemastery ===');
let Schema = null;
try {
  const mod = require('@deepseek-ai/schemastery');
  console.log('  require() 返回类型 :', typeof mod);
  console.log('  有 .object() 方法  :', typeof (mod && mod.object) === 'function');
  console.log('  有 .default        :', mod && typeof mod.default);
  Schema = mod && typeof mod.object === 'function' ? mod : (mod && mod.default) || null;
  console.log('  最终取到的 Schema  :', typeof Schema, '| .object =', typeof Schema.object);
} catch (error) {
  console.log('  解析失败:', error.code || error.message);
}

console.log('\n=== B. 用同步拿到的 Schema 构建 Config（逐字段 volatile）===');
if (Schema) {
  const fields = {
    enabled: Schema.boolean().default(true).volatile(),
    recentCount: Schema.natural().min(1).max(12).default(5).volatile(),
  };
  const Config = Schema.object({ settings: Schema.object(fields) });
  console.log("  'toJSON' in Config       :", 'toJSON' in Config);
  console.log('  Config.meta.volatile     :', Config.meta.volatile);
  console.log('  settings 子节点 volatile :', Config.dict.settings.dict.enabled.meta.volatile);
  const parsed = Config({ settings: { enabled: false } });
  const plain = (v) => (v && typeof v.get === 'function' ? plain(v.get()) : v);
  console.log('  空 config 解析出默认值   :', JSON.stringify({ settings: { enabled: plain(parsed.settings.enabled), recentCount: plain(parsed.settings.recentCount) } }));
}

console.log('\n=== C. unwrapExports 的真实语义（复刻 loader :667-672）===');
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}
const nsWithDefault = { name: 'p', apply() {}, Config: 'X', default: { name: 'p', apply() {} } };
const nsWithoutDefault = { name: 'p', apply() {}, Config: 'X' };
const afterWith = unwrapExports(nsWithDefault);
const afterWithout = unwrapExports(nsWithoutDefault);
console.log('  含 default 导出 → 拿到的 Config :', String(afterWith.Config));
console.log('  仅具名导出     → 拿到的 Config :', String(afterWithout.Config));
console.log('  结论：Config 必须放在具名导出上，default 对象里放什么都不算。');

console.log('\n=== D. cordis resolve 接受的形态 ===');
const resolved = typeof nsWithoutDefault === 'function' ? 'function' : (nsWithoutDefault && typeof nsWithoutDefault.apply === 'function' ? 'object-with-apply' : 'invalid');
console.log('  仅具名导出的 namespace 形态 :', resolved);
