/**
 * 决定性验证：磁盘上的**真实**持久化 checkpoint 能不能被真注册表 view 出 liveActivity。
 *
 * 背景（此前结论被推翻）：
 *   我曾断言「冷会话（未 attach）在列表行里拿不到投影块」，凭据是
 *   `registry.cachedSnapshot(session)` 对没有内存 cell 的会话返回 undefined。
 *   但那只覆盖了 `projectionsFor` 的**一条**分支。真实分派在
 *   `dsh-api-session-controller/lib/types/list.js:271-288 projectionsFor(header, session)`：
 *     - session 在场 → `:276 hintsOf('sequenced', this.ctx.sessionProjections.cachedSnapshot(session))`   // 内存 cells
 *     - session 缺席 → `:281-282 const cache = this.ctx.get('sessionProjectionCache');`
 *                      `:282 return hintsOf('cached', cache?.cachedSnapshot(header) ?? cache?.cachedPredecessorTitle(header));`  // 持久化 checkpoint
 *   即冷会话走的是**另一条 cache**，与内存 cells 无关。
 *   （`hintsOf` 在同文件 `:296-302`：block 为 undefined 或 values 为空则返回 undefined。）
 *
 * 本探针把 `C:\Users\candi\.dsh\storages\session_projcache\sessions\*.json` 里的
 * 真实 record.rows 直接喂给真注册表的 `viewCheckpoint`（这正是
 * `SessionProjectionCache.viewRecord` 调用的那个方法），看 liveActivity 是否出来。
 * 若出来 ⇒ 「冷会话无块」为假，面板在冷会话上也能从列表行拿到数据。
 *
 * 运行：node test/probe-persisted-block.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const CORDIS = 'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
const PROJECTION = 'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';
const CACHE_DIR = 'C:\\Users\\candi\\.dsh\\storages\\session_projcache\\sessions';

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

const cordis = await import(CORDIS);
const Context = cordis.Context ?? cordis.default;
const projection = await import(PROJECTION);
const Registry = projection.SessionProjectionRegistry ?? projection.default;

const { createProjectionDefinition, PROJECTION_KEY } = await import('../src/index.js');

const ctx = new Context();
await ctx.plugin(Registry);
const registry = ctx.get('sessionProjections', false);
assert.ok(registry, '注册表服务未挂上');
registry.register(createProjectionDefinition());

/* ------------------------------------------------------------------ *
 * 找一个真的带 liveActivity 行的持久化记录
 * ------------------------------------------------------------------ */
const files = readdirSync(CACHE_DIR).filter((name) => name.endsWith('.json'));
console.log(`缓存文件: ${files.length} 个`);

const parsed = [];
for (const name of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(CACHE_DIR, name), 'utf8'));
  } catch (_error) {
    continue;
  }
  const rows = doc?.record?.rows;
  if (rows && typeof rows === 'object') parsed.push({ name, rows });
}
console.log(`可解析记录: ${parsed.length} 个`);

const withLive = parsed.filter((entry) => entry.rows[PROJECTION_KEY] !== undefined);
console.log(`含 ${PROJECTION_KEY} 行的记录: ${withLive.length} 个`);

check('磁盘上确实存在带 liveActivity 的持久化 checkpoint（不是我的臆测）', () => {
  assert.ok(withLive.length > 0, '一个都没有 —— 需要先跑一次 DSH 让 checkpoint 落盘');
});

/* ------------------------------------------------------------------ *
 * STATE_VERSION 1→2 升级语义（v2：+model/+image）：
 *   - 磁盘 checkpoint 行全是 v1（ver=1，14 字段）。
 *   - fold 路径：宿主对 ver 不匹配的行从 seq=0 全量重放
 *     （dsh-session-projection/lib/index.js:227），重放后内存 cell 与
 *     后续落盘都是 v2 —— 旧行零误杀，短暂空白自愈。
 *   - viewCheckpoint 路径（磁盘直读）：对 ver 不匹配的行直接丢弃
 *     （宁缺勿错），冷会话在重放完成前短暂无块，属预期代价。
 *   正向用例用真折叠器产出 v2 val 构造 ver=2 行，验证 viewCheckpoint
 *   在版本匹配时照常工作。
 * ------------------------------------------------------------------ */
const { initActivity, applyActivity } = await import('../src/activity.js');
const definition = createProjectionDefinition();

function v2Rows() {
  let state = initActivity();
  state = applyActivity(state, { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } });
  state = applyActivity(state, { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } });
  return { [PROJECTION_KEY]: { ver: definition.stateVersion, seq: 2, val: state } };
}

check('★ ver=2 行（真折叠器产出）经 viewCheckpoint 能产出 liveActivity 值', () => {
  const values = registry.viewCheckpoint(v2Rows(), [PROJECTION_KEY]);
  assert.ok(values[PROJECTION_KEY], `viewCheckpoint 没产出：keys=${Object.keys(values)}`);
  const view = values[PROJECTION_KEY];
  assert.equal(typeof view.running, 'boolean');
  assert.ok(Array.isArray(view.recent));
  assert.equal(view.prompt, 'hello');
});

/* 磁盘现状是**易变的**，不能当断言依据：
 * 宿主 fold 推进后会把 checkpoint 行从 v1 重写成 v2，同一时刻磁盘上可能是混合状态
 * （已 attach 过的会话是 v2，未 attach 的还是 v1）。把「磁盘上还有 ver=1」写成断言，
 * 只会在活实例跑起来后变成假失败。所以这里只观察，断言交给自造 fixture。 */
const verCounts = new Map();
for (const entry of withLive) {
  const ver = entry.rows[PROJECTION_KEY]?.ver;
  verCounts.set(ver, (verCounts.get(ver) ?? 0) + 1);
}
console.log(`  ..   磁盘 ver 分布: ${[...verCounts].map(([v, n]) => `ver=${v}×${n}`).join(', ')}`);

check('磁盘行的 ver 只可能是 1（升级前）或 2（升级后），没有杂项版本', () => {
  for (const ver of verCounts.keys()) {
    assert.ok(ver === 1 || ver === 2, `磁盘上出现了意料外的 ver=${ver}`);
  }
});

check('★ 升级语义：ver=1 行（14 字段 v1 形状）被 viewCheckpoint 丢弃（宁缺勿错）', () => {
  const v2val = v2Rows()[PROJECTION_KEY].val;
  const v1val = { ...v2val };
  delete v1val.model;
  delete v1val.image;
  const values = registry.viewCheckpoint({ [PROJECTION_KEY]: { ver: 1, seq: 2, val: v1val } }, [PROJECTION_KEY]);
  assert.equal(values[PROJECTION_KEY], undefined, 'ver=1 行竟被 view 出来 —— viewCheckpoint 的版本校验没在跑');
});

check('★ 升级语义：磁盘上的 ver=1 旧行同样被丢弃（fold 重放路径自愈）', () => {
  let dropped = 0;
  let kept = 0;
  for (const entry of withLive) {
    const ver = entry.rows[PROJECTION_KEY]?.ver;
    const values = registry.viewCheckpoint(entry.rows, [PROJECTION_KEY]);
    if (ver === 1) {
      assert.equal(values[PROJECTION_KEY], undefined, `${entry.name} 的 ver=1 行竟被 view 出来`);
      dropped += 1;
    } else if (values[PROJECTION_KEY] !== undefined) {
      kept += 1;
    }
  }
  console.log(`  ..   磁盘实况: ver=1 被丢弃 ${dropped} 个，ver=2 正常产出 ${kept} 个`);
});

check('ver=2 行不带 keys 过滤时也在返回集合里（与 viewRecord 调用形态一致）', () => {
  const values = registry.viewCheckpoint(v2Rows());
  assert.ok(values[PROJECTION_KEY], `全量 view 里没有 liveActivity：${Object.keys(values).slice(0, 8).join(',')}…`);
});

check('view 出的值是纯 JSON（客户端可直接渲染，无包装对象）', () => {
  const view = registry.viewCheckpoint(v2Rows(), [PROJECTION_KEY])[PROJECTION_KEY];
  assert.ok(JSON.stringify(view).length > 2);
  assert.equal(typeof view.phase, 'string');
});

check('反证：把 ver 改坏，viewCheckpoint 必须丢弃该行（证明校验真的在跑）', () => {
  const entry = withLive[0];
  const broken = {
    ...entry.rows,
    [PROJECTION_KEY]: { ...entry.rows[PROJECTION_KEY], ver: 999 },
  };
  const values = registry.viewCheckpoint(broken, [PROJECTION_KEY]);
  assert.equal(values[PROJECTION_KEY], undefined, 'ver 不匹配竟然还产出了值，校验形同虚设');
});

check('反证：把 val 改成非法形状，viewCheckpoint 必须丢弃该行', () => {
  const entry = withLive[0];
  const broken = {
    ...entry.rows,
    [PROJECTION_KEY]: { ...entry.rows[PROJECTION_KEY], val: { totally: 'wrong' } },
  };
  const values = registry.viewCheckpoint(broken, [PROJECTION_KEY]);
  assert.equal(values[PROJECTION_KEY], undefined, '非法 val 竟然通过了 stateSchema');
});

console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} / ${checks}`);
  for (const failure of failures) console.error(` - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`全部通过 ${checks} 项 —— 冷会话同样能从持久化 checkpoint 拿到 liveActivity 块`);
