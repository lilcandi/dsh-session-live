/**
 * 端到端激活验收：用**真 cordis** 起 fiber，验证 client.js 的 apply 能跑完。
 *
 * 为什么必须用真 cordis 而不是手写 mock：
 * cordis 的 Context 是 Proxy，读「未 inject 且未提供」的服务名会直接抛
 *   cannot get property "X" without inject
 * 普通 JS 对象 mock 读不存在的属性只返回 undefined，永远复现不出这个 bug。
 * 插件首次上线即 failed 就是踩在这里。
 *
 * 三个场景：
 *   A 全服务齐备（真实浏览器环境）      → 必须激活，两个插槽都注册
 *   B 缺 sessions（宿主版本漂移）        → 按 inject 语义保持 pending，绝不 failed
 *   C 连 logger 都没有（最恶劣）         → 仍然不抛错
 *
 * 运行：node test/repro-apply.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CORDIS =
  'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
const { Context } = await import(CORDIS);

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let captured = null;
const reactStub = {
  createElement: (...a) => ({ type: a[0], props: a[1] }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useSyncExternalStore: (sub, get) => {
    try {
      sub(() => {});
    } catch (_error) {
      /* 订阅失败不影响取值 */
    }
    return get();
  },
  Fragment: 'Fragment',
};

const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  },
  document: {
    baseURI: 'http://127.0.0.1:3080/',
    head: { appendChild() {} },
    createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
    querySelector: () => null,
  },
  localStorage: (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  })(),
  fetch: () => Promise.reject(new Error('no network in repro')),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Symbol,
  Object,
  Array,
  JSON,
  String,
  Number,
  Boolean,
  Promise,
  Error,
  RegExp,
  Math,
  Date,
  Map,
  Set,
  WeakMap,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

const requireFn = (spec) => {
  if (spec === 'react') return reactStub;
  throw new Error(`require("${spec}") missed the module table`);
};
const exported = captured.factory(requireFn);

const failures = [];
function record(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * 起一个 fiber。`services` 指明本次提供哪些服务；
 * `expectActivation` 说明按 inject 语义该 entry 是否应当激活。
 */
async function scenario(label, services, expectActivation) {
  const root = new Context();
  const slotNames = [];
  let registerCalls = 0;

  if (services.includes('slots')) {
    root.provide('slots', {
      inject(name, cb) {
        slotNames.push(name);
        try {
          cb();
        } catch (error) {
          console.log(`    [slots.inject cb 抛错] ${error.message}`);
        }
        return () => {};
      },
      register() {
        registerCalls += 1;
        return () => {};
      },
    });
  }
  if (services.includes('locale')) {
    root.provide('locale', { bind: () => (k) => k, register: () => () => {} });
  }
  if (services.includes('sessions')) {
    root.provide('sessions', {
      list: {
        getSnapshot: () => ({ items: [], projectionsBySession: {} }),
        subscribe: () => () => {},
      },
      binding: () => undefined,
      get: () => undefined,
    });
  }

  const entry = root.plugin({
    name: 'dsh-session-live',
    inject: exported.inject,
    apply: exported.apply,
  });

  let activated = false;
  let errorMessage = '';
  try {
    // cordis 的 fiber await 会在插件「就绪」时 settle；
    // 缺 inject 服务时不会 settle，因此用竞速把「一直 pending」也测出来。
    activated = await Promise.race([
      entry.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 400)),
    ]);
  } catch (error) {
    errorMessage = error.message;
  }

  if (expectActivation) {
    record(`${label}：插件激活`, activated && errorMessage === '', errorMessage || `activated=${activated}`);
    if (activated) {
      record(
        `${label}：注册了 hover 与 settings 两个插槽`,
        registerCalls === 2 && slotNames.includes('sidebar.session.row.hover') && slotNames.includes('settings.section'),
        `register=${registerCalls} slots=${JSON.stringify(slotNames)}`,
      );
    }
  } else {
    record(`${label}：不抛错（允许 pending，绝不能 failed）`, errorMessage === '', errorMessage);
  }

  return { activated, errorMessage };
}

console.log('=== 场景 A：全服务齐备（真实浏览器环境）===');
await scenario('A', ['slots', 'locale', 'sessions'], true);

console.log('=== 场景 B：缺 sessions（宿主版本漂移）===');
await scenario('B', ['slots', 'locale'], false);

console.log('=== 场景 C：什么都没有（最恶劣）===');
await scenario('C', [], false);

console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join('; ')}`);
  process.exit(1);
}
console.log('端到端激活验收：全部通过');
