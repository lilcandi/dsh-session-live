/**
 * 探针 3：严格复刻 dsh-settings 的真实链路，判定哪种 Config volatile 写法可用。
 *
 * 复刻的三个函数来自 `@deepseek-ai/dsh-settings/lib/index.js`：
 * - volatileForm(schema)          :122
 * - projectForm(schema, value)    :141
 * - isVolatilePath(schema, path)  :153
 * 链路来自：
 * - describe()  :512-554  → value = projectForm(form, plainConfig(entry.fiber.config))
 * - write()     :623-657  → next 经 validatePaths 后 mergeLayers(strip(raw, form), next)
 */
const SCHEMA_PATH = 'file:///C:/Users/candi/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
const Schema = (await import(SCHEMA_PATH)).default;

// ---------- 字段集：与插件真实设置一一对应 ----------
const fields = () => ({
  enabled: Schema.boolean().default(true),
  showActivity: Schema.boolean().default(true),
  showRecent: Schema.boolean().default(true),
  showPreview: Schema.boolean().default(true),
  showTiming: Schema.boolean().default(true),
  showError: Schema.boolean().default(true),
  showCompaction: Schema.boolean().default(true),
  dense: Schema.boolean().default(false),
  recentCount: Schema.natural().min(1).max(12).default(5),
});

// ---------- 三种候选写法 ----------
const 写法A = Schema.object({ settings: Schema.object(fields()).volatile() });        // 子节点 volatile
const 写法B = Schema.object({ settings: Schema.object(fields()) }).volatile();        // 顶层 volatile
const 写法C = Schema.object({ settings: Schema.object(fields()).volatile().default({}) }); // 子节点 volatile + 默认

// ---------- 复刻 dsh-settings 内部 ----------
function plainSchema(schema) {
  const result = new Schema(schema.toJSON());
  const walk = (node) => {
    delete node.meta.volatile;
    if (node.meta.role === 'secret') {
      delete node.meta.default;
      delete node.meta.required;
    }
    for (const child of Object.values(node.dict ?? {})) walk(child);
    if (node.inner) walk(node.inner);
    for (const child of node.list ?? []) walk(child);
  };
  walk(result);
  return result;
}
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
function isExpression(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 1 && typeof Reflect.get(value, '__jsExpr') === 'string';
}
function projectForm(schema, value) {
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !isExpression(value)) {
    return Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = Reflect.get(value, key);
        return field === undefined ? [] : [[key, projectForm(child, field)]];
      }),
    );
  }
  return value;
}
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.dict?.[key];
  return child !== undefined && isVolatilePath(child, rest);
}
function plainConfig(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, c]) => [k, plainConfig(c)]));
  }
  return value;
}

// ---------- 逐写法判定 ----------
const rawConfig = { settings: { enabled: true, showActivity: true, showRecent: true, showPreview: true, showTiming: true, showError: true, showCompaction: true, dense: false, recentCount: 5 } };

for (const [名字, Config] of [['A 子节点 volatile', 写法A], ['B 顶层 volatile', 写法B], ['C 子节点 volatile + default', 写法C]]) {
  console.log(`\n──────── ${名字} ────────`);
  let entryConfig;
  try {
    entryConfig = Config(rawConfig);
  } catch (error) {
    console.log(`  ✗ 解析失败: ${error.message}`);
    continue;
  }
  const form = volatileForm(Config);
  console.log(`  'toJSON' in Config        : ${'toJSON' in Config}`);
  console.log(`  volatileForm(Config)      : ${form === undefined ? 'undefined → describe 会跳过条目' : 'OK'}`);
  if (form === undefined) continue;

  const value = projectForm(form, plainConfig(entryConfig));
  console.log(`  projectForm 投影结果       : ${JSON.stringify(value)}`);
  const 投影结构完好 = JSON.stringify(value) === JSON.stringify(rawConfig);
  console.log(`  投影 == 原始 config        : ${投影结构完好 ? '是 ✓' : '否 ✗'}`);

  // write() 的 validatePaths 等价判定：next 的每个 key 必须是 volatile path
  const next = { ...value };
  const 全部可写 = Object.keys(next).every((key) => isVolatilePath(Config, [key]));
  console.log(`  validatePaths 通过         : ${全部可写 ? '是 ✓' : '否 ✗'}`);
  const 子字段可写 = Object.keys(next.settings ?? {}).every((key) => isVolatilePath(Config, ['settings', key]));
  console.log(`  子字段全部 volatile        : ${子字段可写 ? '是 ✓' : '否 ✗'}`);
}

console.log('\n════════ 结论 ════════');
