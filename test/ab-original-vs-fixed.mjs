/**
 * 原始版本 vs 修复版本 —— 真 cordis 下的 A/B 判定。
 *
 * 这是「根因诊断是否成立」的唯一硬证据：拿运行时曾实际加载的那份原版代码
 * （profile 里的备份副本）在真 cordis 下跑，看它是否必然 failed；
 * 再拿修复版跑同一场景，看它是否不再 failed。
 *
 * 失败现场：C:\Users\candi\.dsh\profiles\web\node_modules\dsh-session-live
 * 备份：   同目录 .bak-<timestamp>
 *
 * 运行：node test/ab-original-vs-fixed.mjs
 */
import { Context } from 'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const RUNTIME_DIR = 'C:\\Users\\candi\\.dsh\\profiles\\web\\node_modules\\dsh-session-live';
const NM_DIR = path.dirname(RUNTIME_DIR);

/** 找到最近一次备份目录。 */
function findBackup() {
  const base = path.basename(RUNTIME_DIR);
  const candidates = readdirSync(NM_DIR)
    .filter((n) => n.startsWith(`${base}.bak-`))
    .map((n) => path.join(NM_DIR, n))
    .filter((p) => existsSync(path.join(p, 'src', 'index.js')))
    .sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

const backup = findBackup();
console.log(`原版目录: ${backup || '(未找到备份)'}`);
console.log(`修复目录: ${RUNTIME_DIR}`);
console.log('');

if (backup === null) {
  console.error('找不到备份，无法做 A/B 对照。');
  process.exit(2);
}

const failures = [];
function record(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** 按真实 DSH 宿主的方式起一个 fiber：服务由 root.provide 提供。 */
async function boot(label, modulePath, services, ms = 500) {
  const mod = await import(pathToFileURL(modulePath).href);
  const root = new Context();
  const units = [];
  const routes = [];

  if (services.includes('sessionProjections')) {
    root.provide('sessionProjections', {
      register(definition) {
        units.push(definition);
        return () => {};
      },
      snapshot: () => ({ asOfSeq: 1, values: {} }),
      stateOf: () => ({ seq: 1 }),
    });
  }
  if (services.includes('webServer')) {
    root.provide('webServer', {
      register(route) {
        routes.push(route.path);
        return () => {};
      },
    });
  }
  if (services.includes('settings')) {
    root.provide('settings', { describe: () => [], update: () => Promise.resolve() });
  }
  if (services.includes('sessions')) {
    root.provide('sessions', { list: () => [], get: () => undefined });
  }

  const entry = root.plugin({ name: mod.name, inject: mod.inject, apply: mod.apply });
  let activated = false;
  let errorMessage = '';
  try {
    activated = await Promise.race([
      entry.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  } catch (error) {
    errorMessage = error.message;
  }

  console.log(`  [${label}] inject=${JSON.stringify(mod.inject)} services=${JSON.stringify(services)}`);
  console.log(`         activated=${activated} error=${errorMessage || '(无)'} units=${units.length} routes=${routes.length}`);
  return { activated, errorMessage, units, routes, mod };
}

console.log('=== 对照 1：宿主半边在「服务尚未齐备」的真实启动时序下 ===');
console.log('（模拟：boot 那一刻 sessionProjections 还没挂上，只有 logger 内置）');
const original1 = await boot('原版 boot 时序', path.join(backup, 'src', 'index.js'), []);
const fixed1 = await boot('修复版 boot 时序', path.join(RUNTIME_DIR, 'src', 'index.js'), []);

record(
  '原版在服务未齐备时 failed（这就是用户看到的报错）',
  original1.errorMessage !== '',
  original1.errorMessage || '原版没有抛错 —— 根因判断有误',
);
record(
  '修复版在同一场景不 failed（降级等待而非崩溃）',
  fixed1.errorMessage === '',
  fixed1.errorMessage || '修复版确实不抛',
);

console.log('');
console.log('=== 对照 2：宿主半边在服务齐备时的正常态 ===');
const allServices = ['sessionProjections', 'webServer', 'settings', 'sessions'];
const original2 = await boot('原版 服务齐备', path.join(backup, 'src', 'index.js'), allServices);
const fixed2 = await boot('修复版 服务齐备', path.join(RUNTIME_DIR, 'src', 'index.js'), allServices);

record(
  '修复版在服务齐备时完整激活并注册投影 + 5 条路由',
  fixed2.errorMessage === '' && fixed2.units.length === 1 && fixed2.routes.length === 5,
  `units=${fixed2.units.length} routes=${fixed2.routes.length} err=${fixed2.errorMessage || '-'}`,
);
record(
  '原版在服务齐备时同样能激活（说明原版只在启动时序上脆弱）',
  original2.errorMessage === '' && original2.units.length === 1,
  `units=${original2.units.length} err=${original2.errorMessage || '-'}`,
);

console.log('');
console.log('=== 对照 3：原版 vs 修复版 的 inject 声明 ===');
console.log(`  原版   inject = ${JSON.stringify(original1.mod.inject)}`);
console.log(`  修复版 inject = ${JSON.stringify(fixed1.mod.inject)}`);
record(
  '两者 inject 一致（修复不是靠改 inject，而是靠 readService 兜底）',
  JSON.stringify(original1.mod.inject) === JSON.stringify(fixed1.mod.inject),
  `${JSON.stringify(original1.mod.inject)} vs ${JSON.stringify(fixed1.mod.inject)}`,
);

console.log('');
console.log('=== 对照 4：修复版导出形态完整 ===');
record('导出 readService', typeof fixed2.mod.readService === 'function');
record('导出 __test', typeof fixed2.mod.__test === 'object');
record('导出 apply', typeof fixed2.mod.apply === 'function');
record('name 正确', fixed2.mod.name === 'dsh-session-live', String(fixed2.mod.name));

console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join('; ')}`);
  process.exit(1);
}
console.log('A/B 判定：根因诊断成立，修复有效');
