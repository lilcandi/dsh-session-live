/**
 * 探针：验证 Schemastery 的 volatile 放置规则，以及 dsh-settings 的
 * `volatileForm` / `isVolatilePath` 对本插件 Config 的判定结果。
 *
 * 直接用绝对路径 import schemastery —— 源目录（J:\plugin）不在 profile 的
 * node_modules 解析链上，而运行时副本（profiles\web\node_modules 下）能解析。
 */
const SCHEMASTERy = 'file:///C:/Users/candi/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
const Schema = (await import(SCHEMASTERy)).default;

function line(label, value) {
  console.log(`  ${label.padEnd(38)} ${value}`);
}

console.log('=== A. 顶层 volatile 与子节点 volatile 的区别 ===');
const leaf = Schema.object({
  enabled: Schema.boolean().default(true),
  recentCount: Schema.natural().min(1).max(12).default(5),
});
const leafVolatile = Schema.object({
  enabled: Schema.boolean().default(true),
  recentCount: Schema.natural().min(1).max(12).default(5),
}).volatile();
const topVolatile = Schema.object({ settings: leaf }).volatile();
const childVolatile = Schema.object({ settings: leafVolatile });

line('leaf.meta.volatile', leaf.meta.volatile);
line('leafVolatile.meta.volatile', leafVolatile.meta.volatile);
line('topVolatile.meta.volatile', topVolatile.meta.volatile);
line('childVolatile.meta.volatile', childVolatile.meta.volatile);
line('childVolatile.dict.settings.meta.volatile', childVolatile.dict.settings.meta.volatile);
line("'toJSON' in childVolatile", 'toJSON' in childVolatile);

console.log('\n=== B. 复刻 dsh-settings 的 volatileForm / isVolatilePath ===');
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
function plainSchema(schema) {
  const result = new Schema(schema.toJSON());
  const walk = (node) => {
    delete node.meta.volatile;
    for (const child of Object.values(node.dict ?? {})) walk(child);
    if (node.inner) walk(node.inner);
    for (const child of node.list ?? []) walk(child);
  };
  walk(result);
  return result;
}
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.dict?.[key];
  return child !== undefined && isVolatilePath(child, rest);
}

for (const [name, schema] of [['leaf（无 volatile）', leaf], ['topVolatile', topVolatile], ['childVolatile', childVolatile]]) {
  const form = volatileForm(schema);
  line(`${name} → volatileForm`, form === undefined ? 'undefined（describe 会跳过本条目）' : 'OK');
  if (form !== undefined) {
    line('  form.toJSON().type', form.toJSON().type);
    line('  form 字段', JSON.stringify(Object.keys(form.toJSON().dict ?? {})));
  }
  line(`${name} → isVolatilePath(['settings','enabled'])`, isVolatilePath(schema, ['settings', 'enabled']));
}

console.log('\n=== C. childVolatile 解析真实 config ===');
const value = childVolatile({ settings: { enabled: false, recentCount: 9 } });
const ref = value.settings;
line('settings 是 volatile 引用', typeof ref === 'object' && typeof ref.get === 'function');
line('ref.get()', JSON.stringify(typeof ref.get === 'function' ? ref.get() : ref));

console.log('\n=== D. volatile 放置禁忌（validateVolatileSchema）===');
try {
  const bad = Schema.object({ list: Schema.array(leafVolatile).default([]) });
  bad({ list: [] });
  line('数组内套 volatile 应抛错', '没有抛 —— 与预期不符');
} catch (error) {
  line('数组内套 volatile 抛错', error.message);
}
try {
  const bad2 = Schema.object({ outer: Schema.object({ inner: leafVolatile }).volatile() });
  bad2({ outer: { inner: { enabled: true, recentCount: 1 } } });
  line('volatile 套 volatile 应抛错', '没有抛 —— 与预期不符');
} catch (error) {
  line('volatile 套 volatile 抛错', error.message);
}

console.log('\n=== E. 缺字段时的默认值与 safeParse ===');
const partial = childVolatile({});
line('空 config 解析结果', JSON.stringify(partial.settings?.get?.() ?? partial.settings));
line('safeParse 可用', typeof childVolatile['~standard']?.validate === 'function' || '无 ~standard');
