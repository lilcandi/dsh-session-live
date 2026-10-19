/**
 * 宿主半边端到端激活验收：用**真 cordis** 起 fiber。
 *
 * 关键对照（这就是插件首次上线 failed 的机理）：
 *   inject = []            → apply 立刻执行，裸读 ctx.logger 抛
 *                            `cannot get property "logger" without inject` → **failed**
 *   inject = ['logger']    → logger 未就绪时 apply 不执行 → **pending**（安全等待）
 *
 * 同时验证 child fiber（ctx.inject(['webServer'], …) 里拿到的 inner）
 * 能否通过 readService 看到 root 上提供的服务——这决定路由内部
 * （createApi 读 sessions / sessionProjections / settings）能不能拿到数据。
 *
 * 运行：node test/host-e2e.mjs
 */
import { Context } from 'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { apply, inject, name, readService, __test } from '../index.js';

const failures = [];
function record(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** 起一个宿主 fiber。`services` 指明本次提供哪些服务。 */
async function scenario(label, services, expect) {
  const root = new Context();
  const units = [];
  const routes = [];

  if (services.includes('logger')) {
    root.provide('logger', { debug() {}, info() {}, warn() {}, error() {} });
  }
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

  const entry = root.plugin({ name, inject, apply });

  let activated = false;
  let errorMessage = '';
  try {
    activated = await Promise.race([
      entry.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
  } catch (error) {
    errorMessage = error.message;
  }

  if (expect === 'failed') {
    record(`${label}：应 failed 但不是 pending`, errorMessage !== '', errorMessage || '没有抛错');
    return { activated, errorMessage };
  }

  record(`${label}：不 failed（pending 或 activated 都算安全）`, errorMessage === '', errorMessage);

  if (expect === 'activated') {
    record(`${label}：插件激活`, activated, `activated=${activated}`);
  }

  return { activated, errorMessage, units, routes };
}

console.log('=== 场景 A：全服务齐备（真实宿主）===');
const a = await scenario(
  'A',
  ['logger', 'sessionProjections', 'webServer', 'settings', 'sessions'],
  'activated',
);
if (a.activated) {
  record('A：注册了 liveActivity 投影单元', a.units.length === 1 && a.units[0].key === 'liveActivity', `units=${a.units.length}`);
  record(
    'A：挂载了 5 条插件路由',
    a.routes.length === 5,
    JSON.stringify(a.routes.sort()),
  );
  if (a.units.length === 1) {
    const definition = a.units[0];
    const state = definition.init();
    record('A：投影单元 init 返回纯 JSON', definition.stateSchema.safeParse(state).success === true);
    record('A：投影单元 view 可渲染', typeof definition.wire.view(state) === 'object');
  }
}

console.log('=== 场景 B：只有 logger（其余能力缺失，宿主版本漂移）===');
await scenario('B', ['logger'], 'pending');
console.log('=== 场景 C：连 logger 都没有（最恶劣）===');
await scenario('C', [], 'pending');

console.log('=== 场景 D：对照实验 —— 裸读 sessionProjections（inject=[]）确实 failed ===');
{
  const root = new Context();
  root.provide('logger', { debug() {}, warn() {}, error() {} });
  // 还原修复前的写法：inject=[] 且直接裸读服务。
  // 注意不能拿现在的 apply 当对照——它已经全程走 readService，读什么都安全。
  const broken = root.plugin({
    name: 'broken-copy',
    inject: [],
    apply(ctx) {
      ctx.sessionProjections; // eslint-disable-line no-unused-expressions
    },
  });
  let errorMessage = '';
  try {
    await Promise.race([
      broken.then(() => true),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch (error) {
    errorMessage = error.message;
  }
  record(
    'D：裸读未提供且未声明的服务确实抛 without inject —— 证明根因判断正确',
    /without inject/.test(errorMessage),
    errorMessage || '没有抛错',
  );
}

console.log('=== 场景 D2：logger 是内置服务，裸读不抛（避免误判根因）===');
{
  const root = new Context();
  const probePlugin = root.plugin({
    name: 'logger-probe',
    inject: [],
    apply(ctx) {
      ctx.logger; // eslint-disable-line no-unused-expressions
    },
  });
  let errorMessage = '';
  try {
    await Promise.race([
      probePlugin.then(() => true),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch (error) {
    errorMessage = error.message;
  }
  record(
    'D2：裸读 ctx.logger 不抛（内置服务）—— 证明崩溃点不是 logger',
    errorMessage === '',
    errorMessage || '确实不抛',
  );
}

console.log('=== 场景 E：inject 是等待闸门 —— 声明缺失服务会让 apply 永不执行 ===');
{
  const missingDeclared = await new Promise((resolve) => {
    const root = new Context();
    let ran = false;
    const entry = root.plugin({
      name: 'gate-probe',
      inject: ['neverProvidedService'],
      apply() {
        ran = true;
      },
    });
    setTimeout(() => resolve({ ran, entryStarted: Boolean(entry) }), 400);
  });
  record(
    'E：声明了未提供的服务时 apply 不执行（成为永久 pending，而非 failed）',
    missingDeclared.ran === false,
    `applyRan=${missingDeclared.ran}`,
  );

  // 对照：不声明时 apply 立刻执行
  const noDeclare = await new Promise((resolve) => {
    const root = new Context();
    let ran = false;
    root.plugin({
      name: 'no-declare-probe',
      inject: [],
      apply() {
        ran = true;
      },
    });
    setTimeout(() => resolve({ ran }), 400);
  });
  record(
    'E2：inject=[] 时 apply 立即执行（这就是宿主半边选 inject=[] + readService 的理由）',
    noDeclare.ran === true,
    `applyRan=${noDeclare.ran}`,
  );
}

console.log('=== 场景 F：child fiber 读服务 —— 裸读抛、readService 安全 ===');
{
  const root = new Context();
  const sentinel = { tag: 'sessions-from-root' };
  root.provide('sessions', sentinel);
  root.provide('webServer', { register: () => () => {} });

  const seen = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    setTimeout(() => done({ state: 'timeout' }), 500);
    root.plugin({
      name: 'fiber-probe',
      inject: [],
      apply(ctx) {
        ctx.inject(['webServer'], (inner) => {
          const viaReadService = readService(inner, 'settings'); // 未提供
          let viaBareRead;
          try {
            viaBareRead = String(inner.settings);
          } catch (error) {
            viaBareRead = `THREW: ${error.message}`;
          }
          const providedViaReadService = readService(inner, 'sessions');
          done({
            state: 'done',
            viaReadService,
            viaBareRead,
            providedOk: providedViaReadService === sentinel,
          });
        });
      },
    });
  });

  if (seen.state === 'timeout') {
    record('F：child fiber 服务读取', false, 'inject 回调没有执行');
  } else {
    record(
      'F：readService 对未提供服务返回 undefined 而不抛',
      seen.viaReadService === undefined,
      `值=${String(seen.viaReadService)}`,
    );
    record(
      'F：同一个未提供服务，裸读会抛 —— 这就是统一走 readService 的理由',
      typeof seen.viaBareRead === 'string' && seen.viaBareRead.startsWith('THREW'),
      String(seen.viaBareRead),
    );
    record(
      'F：readService 能读到已提供的服务（root 服务对 child 可见）',
      seen.providedOk === true,
      `providedOk=${seen.providedOk}`,
    );
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join('; ')}`);
  process.exit(1);
}
console.log('宿主端到端验收：全部通过');
