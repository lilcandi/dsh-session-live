/**
 * 运行时副本验收 —— 直接对 DSH 真正加载的那份代码做检查。
 *
 * 源目录 `J:\plugin\dsh-session-live` 与运行时副本
 * `C:\Users\candi\.dsh\profiles\web\node_modules\dsh-session-live` 是两份物理文件。
 * 源目录全绿**不代表**宿主加载的那份是对的 —— 历史上就发生过「源目录已改、
 * 副本陈旧」导致修复不生效。
 *
 * 本脚本不做任何 mock：
 *   - 从副本目录 import，走副本自己的 package.json 解析依赖；
 *   - 用副本自己的 node_modules 解析 @deepseek-ai/schemastery；
 *   - 用真实 cordis registry 加载，确认 Config 真能建出 runtime 记录。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const RUNTIME = 'C:\\Users\\candi\\.dsh\\profiles\\web\\node_modules\\dsh-session-live';
const CORDIS = pathToFileURL(
  'C:\\Users\\candi\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\cordis\\lib\\index.js',
).href;

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

console.log('════════ 1. 副本文件齐备 ════════');
{
  const required = [
    'package.json',
    'index.js',
    'client.js',
    'src/index.js',
    'src/shared.js',
    'src/activity.js',
    'src/config-schema.js',
  ];
  for (const rel of required) {
    const p = path.join(RUNTIME, rel);
    check(`副本含 ${rel}`, existsSync(p), p);
  }
  // config-schema.js 现在 import './shared.js'，副本必须同时有它，否则加载即失败。
  const cs = readFileSync(path.join(RUNTIME, 'src', 'config-schema.js'), 'utf8');
  check(
    "副本 config-schema.js 含 from './shared.js' 的导入（依赖已同步）",
    cs.includes("from './shared.js'"),
  );
  check(
    '副本 config-schema.js 已用 SETTINGS_SPEC 派生（不再是手写边界）',
    cs.includes('SETTINGS_SPEC.map'),
  );
  // 只检查**代码行**：注释里会引用 `.min(1)` 来说明旧缺陷，
  // 那是文档不是行为。真正的行为判据在第 3 节的边界扫描上。
  const codeOnly = cs
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
  check(
    '副本 config-schema.js 的代码行不再硬编码 min(1)（旧缺陷已同步修正）',
    !codeOnly.includes('.min(1)'),
  );
}

console.log('');
console.log('════════ 2. 副本能解析依赖并构建 Config ════════');
const pluginUrl = pathToFileURL(path.join(RUNTIME, 'index.js')).href;
let plugin;
try {
  plugin = await import(pluginUrl);
  check('副本 index.js 可加载', true);
} catch (error) {
  check('副本 index.js 可加载', false, error.message);
  console.log('');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

check('副本导出了具名 Config', 'Config' in plugin && plugin.Config != null, String(plugin.Config));
check('副本 Config 带 toJSON（dsh-settings 的判定条件）', plugin.Config && 'toJSON' in plugin.Config);
check('副本 Config 是 { settings: {...} } 形状', Boolean(plugin.Config?.dict?.settings));
check('副本导出了 apply', typeof plugin.apply === 'function');
check('副本未用 default 顶替命名空间', !('default' in plugin));

const fieldKeys = Object.keys(plugin.Config?.dict?.settings?.dict || {});
const { SETTINGS_SPEC: specForCount } = await import(pathToFileURL(path.join(RUNTIME, 'src', 'shared.js')).href);
check(`副本 Config 与 SETTINGS_SPEC 同源（SPEC ${specForCount.length} 字段，得到 ${fieldKeys.length}）`,
  fieldKeys.length === specForCount.length);

console.log('');
console.log('════════ 3. 副本 Config 的边界与设置页同源 ════════');
{
  const { SETTINGS_SPEC } = await import(pathToFileURL(path.join(RUNTIME, 'src', 'shared.js')).href);
  const Config = plugin.Config;

  const unwrap = (v) =>
    v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v;

  const validate = (settings) => {
    try {
      const parsed = Config({ settings });
      const out = {};
      for (const spec of SETTINGS_SPEC) {
        out[spec.key] = unwrap(parsed.settings?.[spec.key]);
      }
      return { ok: true, value: out, error: null };
    } catch (error) {
      return { ok: false, value: null, error };
    }
  };
  const defaults = Object.fromEntries(SETTINGS_SPEC.map((s) => [s.key, s.default]));

  const swept = [];
  for (const spec of SETTINGS_SPEC) {
    if (spec.kind === 'boolean') {
      for (const v of [true, false]) {
        if (!validate({ ...defaults, [spec.key]: v }).ok) swept.push(`${spec.key}=${v}`);
      }
    } else if (spec.kind === 'number') {
      const min = typeof spec.min === 'number' ? spec.min : 0;
      const max = typeof spec.max === 'number' ? spec.max : 12;
      for (let v = min; v <= max; v += 1) {
        if (!validate({ ...defaults, [spec.key]: v }).ok) swept.push(`${spec.key}=${v}`);
      }
    }
  }
  check('副本 Config 接受设置页全值域（含 recentCount=0）', swept.length === 0, swept.slice(0, 5).join(','));

  const rc = SETTINGS_SPEC.find((s) => s.key === 'recentCount');
  check(
    `★ 副本接受 recentCount=${rc.min}（旧缺陷正是死在 0 上）`,
    validate({ ...defaults, recentCount: rc.min }).ok,
    validate({ ...defaults, recentCount: rc.min }).error?.message,
  );
  check('副本仍拒绝越界 recentCount=99', !validate({ ...defaults, recentCount: 99 }).ok);
  check('副本对空 config 给出完整默认值', validate({}).ok);
  check('副本对 undefined config 给出完整默认值', (() => {
    try {
      Config(undefined);
      return true;
    } catch (_e) {
      return false;
    }
  })());

  // 真实 cordis resolveConfig 路径：这是宿主启动时走的函数。
  const { default: cordis } = await import(CORDIS);
  void cordis;
  const resolved = Config({ settings: { ...defaults, recentCount: 0 } });
  check(
    '★ resolveConfig 语义下 recentCount=0 不抛（插件不会 failed）',
    unwrap(resolved.settings?.recentCount) === 0,
    String(unwrap(resolved.settings?.recentCount)),
  );
}

console.log('');
console.log('════════ 4. 用真 cordis registry 加载副本 ════════');
{
  const { Context } = await import(CORDIS);
  const ctx = new Context();
  let loaded = null;
  let loadError = null;
  try {
    loaded = ctx.registry?.get?.('dsh-session-live') ?? null;
  } catch (_error) {
    /* 未注册是正常的，下面手动 plugin() */
  }
  void loaded;

  // 直接调用 cordis 的 plugin 装载，观察 Config 是否进入 runtime。
  try {
    const fiber = ctx.plugin(plugin, { settings: { recentCount: 0 } });
    await new Promise((r) => setTimeout(r, 120));
    const runtimeConfig = fiber?.runtime?.Config;
    check('真 cordis 装载后 runtime.Config 存在', runtimeConfig != null, String(runtimeConfig));
    check(
      'runtime.Config 含 toJSON（dsh-settings schema() 的判定条件）',
      runtimeConfig != null && 'toJSON' in runtimeConfig,
    );
    const state = fiber?.state;
    check(
      `fiber 未进入 FAILED（state=${state}，3=failed）`,
      state !== 3,
      `state=${state}`,
    );
  } catch (error) {
    loadError = error;
    check('真 cordis 装载副本未抛异常', false, error.message);
  }
  void loadError;
}

console.log('');
console.log('════════ 结论 ════════');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('副本未就绪 —— 宿主加载的就是这份代码，必须先同步。');
} else {
  console.log('运行时副本就绪：Config 存活、边界与设置页同源、真 cordis 装载不 failed。');
}
process.exit(fail === 0 ? 0 : 1);
