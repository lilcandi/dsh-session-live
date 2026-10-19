/**
 * 用**真** dsh-session-projection 注册表验证零 I/O 梯级的内存行为。
 *
 * 已证命题（**限内存 registry，不含磁盘缓存**）：
 *   1. 从未被 drive 过 cell 的会话，`registry.cachedSnapshot()` 返回 undefined。
 *   2. 被 drive 过的会话，`cachedSnapshot()` 立刻有值（含 liveActivity）。
 *   3. `snapshot()`（= 插件自己 /overview、/detail 用的那条）对同一会话
 *      **有值**，因为它会 materializeCells 折叠全量日志。
 *
 * ⚠️ 本探针**不能**用于证明「冷会话的列表行没有 projections 块」。
 * 这条曾被我误判过，纠正如下（源码核实）：
 *   - `ApiSessionList.projectionsFor()`（dsh-api-session-controller/lib/types/list.js:271-288）
 *     对**热会话**才走 `registry.cachedSnapshot(session)`；
 *   - 对**冷会话**它走的是 `sessionProjectionCache.cachedSnapshot(header)`
 *     —— 那是**磁盘 checkpoint** 路径（`C:\Users\candi\.dsh\storages\
 *     session_projcache\sessions\`），与内存 cells 无关；
 *   - 磁盘上实测有 10 条会话带 `liveActivity` 行。
 *
 * 冷会话的**列表块**由磁盘路径补齐，判据在
 * `test/probe-persisted-block.mjs`（本探针不覆盖）。
 *
 * 运行：node test/probe-cold-block.mjs
 */
import assert from 'node:assert/strict';

const CORDIS = 'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
const PROJECTION = 'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';

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

/** 本插件的**真实**投影定义（不是复制品）。入口只导出 name/inject/apply/Config，故走 src。 */
const { createProjectionDefinition, PROJECTION_KEY } = await import('../src/index.js');
const definition = createProjectionDefinition();
console.log(`注册表: ${typeof Registry === 'function' ? 'ok' : 'FAILED'}   键: ${PROJECTION_KEY}`);

function makeSession(id) {
  return {
    id,
    header: { id, createdAt: 0 },
    inheritedEventCount: 0,
    seq: 0,
    snapshotEvents() {
      return [];
    },
    eventAt() {
      return undefined;
    },
  };
}

const ctx = new Context();
// cordis 的 plugin() 是**调度**而非立即执行：必须 await，否则 apply 还没跑，
// 服务名读出来是 undefined（我第一次就是这么踩的）。
await ctx.plugin(Registry);
const registry = ctx.get('sessionProjections', false);
assert.ok(registry, '注册表服务未挂上');

registry.register(definition);

const cold = makeSession('session-cold');
const live = makeSession('session-live-attached');

// live 会话在被 drive 之前同样没有 cell —— 这本身就是命题 1 的一半。
check('drive 之前：live 会话的 cachedSnapshot 也是 undefined（cell 尚未建立）', () => {
  assert.equal(registry.cachedSnapshot(live), undefined);
});

check('★ 内存 registry：未 drive 过的会话 cachedSnapshot 返回 undefined（这只说明内存 cells 未建立，不等于列表行没有块）', () => {
  const block = registry.cachedSnapshot(cold);
  assert.equal(block, undefined, '竟然有值，说明宿主会为未 drive 的会话建 cell');
});

// 模拟宿主 drive：一条已提交事件进入注册表。
live.seq = 1;
const event = { seq: 1, type: 'user/message' };
check('drive 之后：live 会话的 cachedSnapshot 带上 liveActivity', () => {
  registry.drive(live, event);
  const block = registry.cachedSnapshot(live);
  assert.ok(block, 'drive 后仍无 cell');
  assert.equal(block.asOfSeq, 1);
  assert.ok(block.values[PROJECTION_KEY], `${PROJECTION_KEY} 不在块里：${Object.keys(block.values)}`);
});

check('值已通过 viewSchema 校验（wire.viewSchema.parse 在 viewCell 里跑）', () => {
  const block = registry.cachedSnapshot(live);
  const view = block.values[PROJECTION_KEY];
  assert.equal(typeof view, 'object');
  assert.equal(typeof view.running, 'boolean');
  assert.ok(Array.isArray(view.recent));
});

check('★ 同一会话用 snapshot() 才有值（插件 /detail、/overview 走的正是这条）', () => {
  const snapshot = registry.snapshot(cold, [PROJECTION_KEY]);
  assert.ok(snapshot);
  assert.ok(snapshot.values[PROJECTION_KEY], 'snapshot 也没值');
  // asOfSeq 是 cursorBefore(session.seq)：seq=0 时是 -1（"还没有任何已提交事件"）。
  assert.equal(snapshot.asOfSeq, cold.seq - 1);
});

check('snapshot() 不会因为冷会话而抛（会 materializeCells 折叠全量日志）', () => {
  assert.doesNotThrow(() => registry.snapshot(cold, [PROJECTION_KEY]));
});

check('反证：未注册的 key 在 snapshot 里不会凭空出现', () => {
  const snapshot = registry.snapshot(live, ['definitely-not-registered']);
  assert.equal(snapshot.values['definitely-not-registered'], undefined);
  assert.deepEqual(Object.keys(snapshot.values), []);
});

console.log('');
if (failures.length > 0) {
  console.error(`失败 ${failures.length} / ${checks}`);
  for (const failure of failures) console.error(` - ${failure.label}: ${failure.error.message}`);
  process.exit(1);
}
console.log(`全部通过 ${checks} 项 —— 内存 registry 的零 I/O 语义符合预期（冷会话的列表块由磁盘 checkpoint 路径补齐，见 probe-persisted-block.mjs）`);
