/**
 * 配置兼容性验证：新加的 Config schema 会不会**拒绝**用户 profile 里已有的 config？
 *
 * 这是加 Config 前必须回答的问题。`cordis/lib/index.js:956-962` 的 resolveConfig
 * 在 `runtime.Config["~standard"].validate(config)` 报 issues 时**抛 ValidationError**，
 * 而 ValidationError 会让 entry 加载失败 —— 那就把「设置页 409」换成了「插件起不来」，
 * 是更坏的交换。所以必须逐一验证真实可能出现的 config 形态。
 *
 * 运行：node test/probe-config-compat.mjs
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const unwrapExports = (e) => {
  if (e === null || e === undefined) return e;
  e = e.default ?? e;
  if (!e.__esModule) return e;
  return e.default ?? e;
};

const namespace = await import('../index.js');
const Config = unwrapExports(namespace).Config;

/** 复刻 cordis 的 resolveConfig（lib/index.js:956-962）。 */
function resolveConfig(config) {
  if (!Config) return { threw: false, value: config };
  const result = Config['~standard'].validate(config);
  if ('then' in result) throw new TypeError('Async config validation is not supported');
  if (result.issues) throw new Error(`ValidationError: ${JSON.stringify(result.issues).slice(0, 200)}`);
  return { threw: false, value: result.value };
}

const CASES = [
  ['profile 当前形态（11 字段齐全）', {
    settings: {
      enabled: true, showActivity: true, showRecent: true, showPreview: true,
      showTiming: true, showError: true, showCompaction: true, showImage: true,
      showModel: true, dense: false, recentCount: 5,
    },
  }],
  ['空对象', {}],
  ['只给 settings 的一部分', { settings: { dense: true } }],
  ['顶层夹带未知字段', { settings: { enabled: true }, unknownTop: 1 }],
  ['settings 夹带未知字段', { settings: { enabled: true, noSuchField: 9 } }],
  ['recentCount 取边界 1', { settings: { recentCount: 1 } }],
  ['recentCount 取边界 12', { settings: { recentCount: 12 } }],
  ['recentCount 越界 99', { settings: { recentCount: 99 } }],
  ['recentCount 越界 0', { settings: { recentCount: 0 } }],
  ['enabled 类型错误（字符串）', { settings: { enabled: 'yes' } }],
  ['settings 是 null', { settings: null }],
  ['settings 是数组', { settings: [] }],
];

let fatal = 0;
console.log('用例                                  | 结果');
console.log('-'.repeat(72));
for (const [label, config] of CASES) {
  let line;
  try {
    const { value } = resolveConfig(config);
    const read = (v) => (v && typeof v.get === 'function' ? v.get() : v);
    const s = value && value.settings;
    const summary = s && typeof s === 'object'
      ? `enabled=${read(s.enabled)} dense=${read(s.dense)} recentCount=${read(s.recentCount)}`
      : 'no-settings';
    line = `ok    ${summary}`;
  } catch (error) {
    line = `THROW ${error.message.slice(0, 90)}`;
    fatal += 1;
  }
  console.log(`${(label + '                                    ').slice(0, 36)} | ${line}`);
}

console.log('');
/* 关键断言：用户 profile 里现存的那份 config 必须能通过。 */
const live = CASES[0][1];
let liveOk = true;
let liveDetail = '';
try {
  resolveConfig(live);
  liveDetail = '通过';
} catch (error) {
  liveOk = false;
  liveDetail = error.message;
}
console.log(`★ profile 现存 config 能否通过：${liveOk ? '能' : '不能 —— ' + liveDetail}`);
console.log(`★ 严格拒绝的用例数（越界/类型错误）：${fatal} 个`);
console.log('');
console.log('说明：越界与类型错误被拒是**设计意图** —— 那是宿主该拦下的非法配置。');
console.log('真正致命的只有一种情况：profile 里现存的合法 config 被拒。若上面显示「能」，');
console.log('则加 Config 不会让插件从「设置页 409」恶化成「插件起不来」。');

process.exit(liveOk ? 0 : 1);
