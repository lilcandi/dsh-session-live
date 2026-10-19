/**
 * 本插件的 Config schema —— 设置持久化的**唯一权威声明**。
 *
 * ## 为什么必须有它
 * `@deepseek-ai/dsh-settings` 的 `schema(entry)` 读的是
 *   entry.fiber?.runtime?.Config
 * （`dsh-settings/lib/index.js:660-663`），并要求 `'toJSON' in schema`。
 * 而 `runtime.Config` 来自 `plugin.Config`（`cordis/lib/index.js:1627-1631`）。
 * 没有 Config 的插件在 SettingsForms 里**根本不存在条目**：
 * `describe()` 返回空、`update()` 抛 `No configurable plugin entry`。
 * 这正是设置页读到空对象、写入返回 409 的根因。
 *
 * ## 为什么每个字段都挂 `.volatile()`
 * `describe()` 里的 `volatileForm(schema)`（同文件 :122-131）会**过滤掉所有非
 * volatile 字段**，返回 undefined 时整个条目被跳过（:517-518）。官方 20 余处
 * 插件（dsh-client-locale、dsh-client-ui-settings、dsh-bash-local 等）一致采用
 * 逐字段 `.volatile()` 的写法。
 *
 * volatile 的语义（schemastery `src/index.ts:480-483`、`515-530`）：解析后该字段
 * 变成稳定引用（`.get()` 读值），宿主改配置时**只提交 volatile 字段**、不重挂
 * 插件（`cordis-plugin-loader/lib/index.js:382-383` 的 `equalExceptVolatile` 与
 * `_commitVolatile`）。这正是设置页要做到的「改完立即生效、不重启」。
 *
 * 放置禁忌（schemastery `src/index.ts:488-509` 的 `validateVolatileSchema`）：
 * volatile 字段必须落在**固定对象路径**上，不能嵌在数组里、也不能套在另一个
 * volatile 字段内部。本 schema 全部是固定路径字段，天然合规。
 *
 * ## 为什么用 createRequire 同步解析
 * `Config` 必须是模块**导出期的静态属性**——加载器在 `unwrapExports` 之后立刻
 * 读 `plugin.Config` 建 runtime 记录，拿不到就永远拿不到。所以不能用顶层
 * `await import()` 把它变成异步产物。用 `createRequire` 同步取，解析失败时
 * `Config = null`：cordis 的 `resolveConfig` 对 `!runtime.Config` 直接原样返回
 * 配置（`cordis/lib/index.js:957`），设置页退化为只读，但插件照常加载。
 *
 * ⚠️ 另一个已实测的坑：`unwrapExports`（`cordis-plugin-loader/lib/index.js:667-672`）
 * 会优先取 `exports.default`，再取 `exports.default.default`。所以 `Config`
 * **只能放在具名导出上**，塞进 `default` 对象里会被丢掉。
 *
 * ## 边界必须与设置页同源
 * 本文件的字段清单与数值边界**全部从 `shared.js` 的 `SETTINGS_SPEC` 派生**。
 * 设置页允许用户输入的任何值都必须能通过这里校验：否则用户存下的合法配置
 * 会在下次启动被 `resolveConfig` 拒绝（`ValidationError`），插件从「设置失效」
 * 恶化为「插件起不来」。这类漂移只允许发生零次。
 */
import { createRequire } from 'node:module';
import { SETTINGS_SPEC } from './shared.js';

/**
 * 设置字段的结构描述（不含 schema 对象），供两侧共享与单测断言。
 *
 * **从 `shared.js` 的 `SETTINGS_SPEC` 派生，不另立一份。** 曾经的教训：这里
 * 手写 `recentCount` 的边界与 `SETTINGS_SPEC` 漂移（`.min(1)` vs `min: 0`），
 * 而设置页按 `min: 0` 允许用户选 0（表示隐藏工具条）；一旦存进 profile，
 * 下次启动 `resolveConfig` 就抛 `ValidationError`，插件直接 failed。
 * 边界只有一个来源，就不会再有第二次。
 */
export const SETTINGS_FIELDS = SETTINGS_SPEC.map((spec) => [spec.key, spec.kind, spec.default]);

/** 设置默认值（客户端在宿主不可用时也用这一份）。 */
export const SETTINGS_DEFAULTS = Object.freeze(
  Object.fromEntries(SETTINGS_FIELDS.map(([key, , fallback]) => [key, fallback])),
);

/**
 * 同步解析 `@deepseek-ai/schemastery`。
 *
 * 两种运行位置都要覆盖：DSH 从 profile 的 node_modules 加载插件（那里是扁平化的），
 * 单测从源目录 `J:\plugin\dsh-session-live` 加载（本地已用 junction 补齐依赖）。
 * 全部失败返回 null —— 这是降级，不是崩溃。
 */
function resolveSchemaSync() {
  const require = createRequire(import.meta.url);
  const specifiers = ['@deepseek-ai/schemastery'];
  for (const specifier of specifiers) {
    try {
      const mod = require(specifier);
      // CJS 形态直接返回构造函数；ESM 互操作时可能挂在 .default 上。
      if (typeof mod === 'function' && typeof mod.object === 'function') return mod;
      if (mod && typeof mod.default === 'function' && typeof mod.default.object === 'function') {
        return mod.default;
      }
    } catch (_error) {
      /* 换下一个候选 */
    }
  }
  return null;
}

/** 构建 Config schema；schemastery 不可用时返回 null（设置页降级为只读）。 */
function buildConfig() {
  const Schema = resolveSchemaSync();
  if (!Schema) return null;

  const fields = {};
  for (const spec of SETTINGS_SPEC) {
    let base;
    if (spec.kind === 'number') {
      // 边界同样取自 SETTINGS_SPEC —— 设置页允许的任何值都必须能通过校验，
      // 否则用户存下的合法值会在下次启动把插件打成 failed。
      let numeric = Schema.natural().default(spec.default);
      if (typeof spec.min === 'number') numeric = numeric.min(spec.min);
      if (typeof spec.max === 'number') numeric = numeric.max(spec.max);
      base = numeric;
    } else {
      base = Schema.boolean().default(spec.default);
    }
    // 逐字段 volatile：官方惯例，也是条目能出现在设置表单里的前提。
    fields[spec.key] = base.volatile();
  }

  return Schema.object({ settings: Schema.object(fields) });
}

/**
 * 插件配置 schema，静态求值一次。
 *
 * 形状 `{ settings: {...} }` 与 profile 条目里的
 * `config: { settings: {...} }` 一致，因此 `dsh config` 与设置页看到的是同一份值。
 * 值为 null 时表示 schemastery 缺失，设置通道降级（读取走 describe 失败→空对象，
 * 写入返回 409 并由客户端回落到路由/localStorage）。
 */
export const Config = buildConfig();
