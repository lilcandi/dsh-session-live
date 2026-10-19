/**
 * 复刻 cordis-plugin-loader 的加载链，证明 Config 真的能被宿主读到。
 *
 * 这是整条根因链的最后一环，也是唯一值得写死成回归测试的一环：
 *
 *   1. `unwrapExports`（cordis-plugin-loader/lib/index.js:667-672）会做
 *      `exports = exports.default ?? exports` —— **default 导出会顶替整个
 *      命名空间**，挂在具名导出上的 Config 就此消失。这是 409 的直接成因。
 *   2. `registry.resolve(plugin)`（cordis/lib/index.js:1533-1538）走
 *      `isApplicable`（:1446-1448：对象且 typeof apply === 'function'）取
 *      `plugin.apply`；函数形态则直接用函数本身。
 *   3. `runtime.Config = plugin.Config`（cordis/lib/index.js:1631）从**同一个
 *      容器对象**上读 Config。
 *
 * 因此本测试断言：unwrapExports 之后的容器上，name / inject / apply / Config
 * 四者俱全；并反证「加回 default 导出就会丢掉 Config」。
 *
 * 运行：node test/probe-config-export.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 复刻 dsh-settings 的 plainSchema / volatileForm 需要真 schema 构造函数。
const Schema = createRequire(import.meta.url)('@deepseek-ai/schemastery');

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

/* ---------------- 复刻宿主两个关键函数（逐行对照源码） ---------------- */

/** cordis-plugin-loader/lib/index.js:667-672 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}

/** cordis/lib/index.js:1446-1448 + 1533-1538 */
function isApplicable(object) {
  return object && typeof object === 'object' && typeof object.apply === 'function';
}
function resolvePlugin(plugin) {
  try {
    if (typeof plugin === 'function') return plugin;
    if (isApplicable(plugin)) return plugin.apply;
  } catch (_error) {
    /* 与宿主一致：静默 */
  }
  return undefined;
}

/* ---------------- 1. 真实模块经过 unwrapExports ---------------- */

const namespace = await import('../index.js');
const plugin = unwrapExports(namespace);

check('unwrapExports 之后 name / inject / apply 仍在', () => {
  assert.equal(plugin.name, 'dsh-session-live');
  assert.deepEqual([...plugin.inject], []);
  assert.equal(typeof plugin.apply, 'function');
});

check('★ unwrapExports 之后 Config 仍在（409 根因的判定点）', () => {
  assert.notEqual(plugin.Config, undefined, 'Config 丢了 —— 设置页会读到空对象并返回 409');
  assert.equal('toJSON' in plugin.Config, true, 'dsh-settings 的 schema(entry) 要求 toJSON in schema');
});

check('命名空间里不含 default 导出（default 会顶替整个命名空间）', () => {
  assert.equal(namespace.default, undefined, 'index.js 又导出了 default，Config 会被吃掉');
});

check('resolvePlugin 能取到 apply', () => {
  assert.equal(typeof resolvePlugin(plugin), 'function');
});

/* ---------------- 2. Config schema 本身合规 ---------------- */

const { Config } = namespace;
check('Config 是 { settings: {...} } 形状，与 profile 条目 config 一致', () => {
  // 注意：不能读 `Config.toJSON().dict` —— toJSON 走 refs 展开形态，那里没有 dict
  // （这是本项目早前踩过的坑，已确证属正常行为，不是缺陷）。dict 直接在 schema 上读。
  assert.equal(Config.type, 'object');
  assert.ok(Config.dict.settings, 'Config.dict.settings 缺失 —— volatileForm 会返回 undefined');
  assert.equal(Config.dict.settings.type, 'object');
});

check('settings 下 12 个字段全部 volatile（否则条目被 describe 跳过）', () => {
  const keys = Object.keys(Config.dict.settings.dict);
  assert.deepEqual(keys.sort(), [
    'dense',
    'enabled',
    'recentCount',
    'showActivity',
    'showCompaction',
    'showError',
    'showImage',
    'showModel',
    'showPreview',
    'showRecent',
    'showTiming',
    'showUsage',
  ]);
  for (const key of keys) {
    assert.equal(Config.dict.settings.dict[key].meta.volatile, true, `${key} 未挂 volatile`);
  }
});

check('空 config 解析出全部默认值（走 plainConfig 展开 volatile 包装）', () => {
  const resolved = plainConfig(Config({}));
  assert.equal(resolved.settings.enabled, true);
  assert.equal(resolved.settings.dense, false);
  assert.equal(resolved.settings.recentCount, 5);
});

/* ---------------- 3. 逐行复刻 dsh-settings 的表单派生链 ---------------- */

/**
 * 下面五个函数是对 `dsh-settings/lib/index.js` 的**逐行复刻**（行号即出处）。
 * 注意两个曾经的误读，都已在这里修正：
 *   - 解析结果里的 volatile 字段是**包装对象**，必须 `plainConfig` 展开（:97-102）
 *   - `volatileForm` 返回的是 `plainSchema` 重建的 schema，不是原 schema（:123）
 */
function isVolatile(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.get === 'function' && Symbol.for('cosmokit.volatile.write') in value;
}

/** dsh-settings/lib/index.js:97-102 */
function plainConfig(value) {
  if (isVolatile(value)) return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
  }
  return value;
}

/** dsh-settings/lib/index.js:103-117 */
function plainSchema(schema) {
  const result = new Schema(schema.toJSON());
  const walk = (node) => {
    delete node.meta.volatile;
    if (node.meta.role === 'secret') {
      delete node.meta.default;
      delete node.meta.required;
    } else if (node.meta.default !== undefined) node.meta.default = node.meta.default;
    for (const child of Object.values(node.dict ?? {})) walk(child);
    if (node.inner) walk(node.inner);
    for (const child of node.list ?? []) walk(child);
  };
  walk(result);
  return result;
}

/** dsh-settings/lib/index.js:122-131 */
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema);
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child);
        return field === undefined ? [] : [[key, field]];
      }),
    );
    return Object.keys(dict).length === 0 ? undefined : Schema.object(dict);
  }
  return undefined;
}

/** dsh-settings/lib/index.js:141-147 */
function projectForm(schema, value) {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = Reflect.get(value, key);
        return field === undefined ? [] : [[key, projectForm(child, field)]];
      }),
    );
  }
  return value;
}

/** dsh-settings/lib/index.js:153-158 */
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.dict?.[key];
  return child !== undefined && isVolatilePath(child, rest);
}

check('★ volatileForm(Config) 不为 undefined（否则 describe 直接 return []）', () => {
  const form = volatileForm(Config);
  assert.notEqual(form, undefined);
  assert.ok(form.dict.settings, 'form 里没有 settings 子树');
});

check('★ projectForm 把 config 投影成 12 个字段（设置页能显示的全部内容）', () => {
  const form = volatileForm(Config);
  const config = plainConfig(Config({}));
  const projected = projectForm(form, config);
  assert.deepEqual(Object.keys(projected.settings).sort(), [
    'dense',
    'enabled',
    'recentCount',
    'showActivity',
    'showCompaction',
    'showError',
    'showImage',
    'showModel',
    'showPreview',
    'showRecent',
    'showTiming',
    'showUsage',
  ]);
  assert.equal(projected.settings.enabled, true);
  assert.equal(projected.settings.recentCount, 5);
});

check('★ isVolatilePath 对 settings.<字段> 全部放行（写入才不会被拒）', () => {
  for (const key of Object.keys(Config.dict.settings.dict)) {
    assert.equal(isVolatilePath(Config, ['settings', key]), true, `settings.${key} 被拒`);
  }
  assert.equal(isVolatilePath(Config, ['nope']), false);
});

/* ---------------- 4. 反证：加回 default 就丢 Config ---------------- */

check('反证：若 index.js 同时导出 default 对象，Config 会被顶替掉', () => {
  const withDefault = {
    ...namespace,
    default: { name: 'dsh-session-live', inject: [], apply: namespace.apply },
  };
  const unwrapped = unwrapExports(withDefault);
  assert.equal(unwrapped.Config, undefined, '本应丢失 —— 说明这条约束是真的');
});

/* ---------------- 汇总 ---------------- */
console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} / ${checks}`);
  for (const failure of failures) console.error(` - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`全部通过 ${checks} 项 —— Config 在宿主加载链上存活`);
