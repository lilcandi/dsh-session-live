/**
 * 探针 2：盯住上一轮未解释的现象 —— `volatileForm` 重建出的 form 里字段列表为空。
 * 如果 form 真的没字段，`projectForm(form, value)` 会返回 `{}`，设置页将永远读到空值。
 */
const SCHEMASTERy = 'file:///C:/Users/candi/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
const Schema = (await import(SCHEMASTERy)).default;

const leaf = Schema.object({
  enabled: Schema.boolean().default(true),
  recentCount: Schema.natural().min(1).max(12).default(5),
});
const leafVolatile = leaf.volatile();
const Config = Schema.object({ settings: leafVolatile });

console.log('=== leafVolatile.toJSON() 完整结构 ===');
console.log(JSON.stringify(leafVolatile.toJSON(), null, 2));

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

const form = plainSchema(leafVolatile);
console.log('\n=== plainSchema(leafVolatile) 重建结果 ===');
console.log(JSON.stringify(form.toJSON(), null, 2));
console.log('form.type  =', form.type);
console.log('form.dict  =', form.dict === undefined ? 'undefined' : Object.keys(form.dict));
console.log('form.toJSON().dict =', form.toJSON().dict === undefined ? 'undefined' : Object.keys(form.toJSON().dict));

console.log('\n=== 直接 new Schema(toJSON) 的对照（不 walk）===');
const raw = new Schema(leafVolatile.toJSON());
console.log('raw.type   =', raw.type);
console.log('raw.toJSON().dict =', raw.toJSON().dict === undefined ? 'undefined' : Object.keys(raw.toJSON().dict));

console.log('\n=== projectForm(form, value) 实测 ===');
function plainConfig(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, c]) => [k, plainConfig(c)]));
  }
  return value;
}
function projectForm(schema, value) {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = value[key];
        return field === undefined ? [] : [[key, projectForm(child, field)]];
      }),
    );
  }
  return value;
}

const parsed = Config({ settings: { enabled: false, recentCount: 9 } });
console.log('解析值(展开后) =', JSON.stringify(plainConfig(parsed)));
console.log('form 投影结果  =', JSON.stringify(projectForm(form, plainConfig(parsed))));

console.log('\n=== 若顶层 volatile（错误写法）会怎样 ===');
const wrong = Config.toJSON ? Schema.object({ settings: leaf }).volatile() : null;
const wrongForm = plainSchema(wrong);
console.log('wrongForm.toJSON() =', JSON.stringify(wrongForm.toJSON()));
console.log('wrong 投影结果     =', JSON.stringify(projectForm(wrongForm, plainConfig(wrong({ settings: { enabled: false, recentCount: 9 } })))));
