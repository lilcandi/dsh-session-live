# 会话实时预览 · dsh-session-live

> 在 DSH 侧边栏的会话悬停卡片里，直接看到**这个会话此刻在干什么**。

DSH 自带的悬停卡片只显示：标题、相对时间、一个圆点、`运行中/空闲`。
本插件在「相对时间」与「状态行」之间插入一块实时活动面板，回答这些问题：

- **现在在跑什么工具**（名称 + 参数摘要 + 已运行多久）
- **最近都干了什么**（最近工具调用序列）
- **内容说到哪了**（最近一条提问与回复的单行摘要，只取人真正打进去的那句，注入的系统文本会被剥掉）
- **聊了多少、烧了多少、用哪个模型**（对话轮数 · 累计 token 用量 · 模型短名，压成一行；悬停该行可看输入/输出细分与推理力度）
- **发过什么图**（会话最近一张用户上传图片的缩略图，**点击可放大看原图**）

面板刻意保持小而快：一行概况取代了原先独立的模型行与工具条标题行，缩略图默认尺寸也收紧了。

外加一个**独立设置页**，可逐项开关、调密度、调最近工具条长度，改动即时生效并随 profile 持久化。

![悬停面板示意](docs/hover-mock.txt)

---

## 与同类插件的区别

| 插件 | 回答的问题 |
|---|---|
| `@comecaramelos/dsh-hover-information` | 这个会话**花了多少**（turns / tokens / cache / context window） |
| `dsh-ballast` | 上下文窗口占用多满 |
| `dsh-git-badge` | 这个会话需要你**做什么动作** |
| **dsh-session-live**（本插件） | 这个会话**此刻正在做什么、卡在哪**，顺带一行总量（轮数 / token 合计 / 模型短名） |

总量只取一行，且刻意不做 cache 明细、上下文占用条与成本计算 —— 那是别人的地盘，同时装也不会出现两份一样的数字。token 值直接读宿主内置的 `tokenUsage` 投影（`@deepseek-ai/dsh-token-meter`），本插件不自己算、不自己折、不新增取数请求。

---

## 安装

### 方式一：官方命令（推荐）

```powershell
dsh plugin --profile web add file:J:/plugin/dsh-session-live
```

### 方式二：手工

在 `%DSH_HOME%\profiles\web\package.json` 里做两件事，**两件都要做**：

1. `dependencies` 增加 `"dsh-session-live": "file:J:/plugin/dsh-session-live"`
2. `dsh.profile.bundles` 数组追加 `"dsh-session-live"`

漏掉第 2 步是这类插件"装了但没跑"的经典坑：`cordis.patch.yml` 只能 patch 一个**已被插入**的条目，从未 insert 的行 patch 了也不会启动。

安装完重启 DSH（`dsh web`），刷新页面。

---

## 设置

`设置 → 会话实时预览`，共 12 项：

| 项 | 默认 | 说明 |
|---|---|---|
| 启用悬停实时预览 | 开 | 总开关，关掉后卡片不插入任何内容 |
| 显示当前活动行 | 开 | 正在跑的工具 + 参数摘要 + 已运行时长 |
| 显示最近工具序列 | 开 | 最近若干次工具调用的小图标条 |
| 显示内容预览 | 开 | 最近一条提问与回复摘要 |
| 显示耗时 | 开 | 本轮 / 当前步 / 当前工具的时间 |
| 显示异常 | 开 | 工具失败、轮次异常终止、被中断 |
| 显示压缩标记 | 开 | 上下文压缩时给一条提示 |
| 显示图片缩略图 | 开 | 会话最近一张用户上传图片的缩略图 |
| 显示模型名称 | 开 | 用量行里的模型短名（关掉后该行不含模型） |
| 显示用量概况 | 开 | 一行概况：对话轮数 · 累计 token · 模型短名 |
| 紧凑模式 | 关 | 更小字号与间距 |
| 最近工具条长度 | 5 | 0–12，0 表示隐藏 |

设置写入 profile 的插件条目（`ctx.settings`，与 `dsh config` 同源），因此**跨浏览器、跨设备一致**。宿主的 SettingsForms 不可用时自动降级到插件自己的路由，再不可用则退回 `localStorage`，设置页底部会显示当前用的是哪条通道。

设置页的位置：**账号菜单 → 设置 → 侧栏最末的「会话预览」**。这一节靠 `settings.section` 注册描述里的 `label` 出现在导航中，缺了 `label` 就是一条点不到的空白项 —— 官方各节（`dsh-client-ui-settings-models` 等）写的是 `label: () => t('nav')`，本插件与之对齐。改这个字段属于注册期元数据，**必须重启 dsh web** 才生效。

---

## 架构

```
┌─────────────────── 宿主（Node） ───────────────────┐
│  index.js / src/index.js                           │
│   ├─ src/activity.js   折叠器：事件流 → 活动状态    │
│   ├─ 注册 liveActivity 投影单元（wire → 客户端）     │
│   └─ 挂 /session-live/api/{health,overview,detail,settings,image}
└────────────────────────────────────────────────────┘
                     │ 投影值随会话列表快照下发
┌─────────────────── 浏览器 ─────────────────────────┐
│  client.js（手写 CJS，零构建）                      │
│   ├─ sidebar.session.row.hover → 实时活动面板       │
│   ├─ settings.section          → 独立设置页         │
│   └─ 读 byId[sessionId].projectionValues.liveActivity│
└────────────────────────────────────────────────────┘
```

### 为什么走"宿主投影 + 列表快照"而不是 `useProjection`

`sidebar.session.row.hover` 插槽的 owner **只给 `sessionId`**（官方注释解释了原因：Session 作用域的 seat 会强制激活列表里每一个会话）。而 `useProjection(key)` 绑定的是"当前会话"，拿不到任意会话的值。

所以数据必须由宿主提前算好、按 sessionId 随列表快照推送 —— 这也正好满足"悬停不引发 I/O"的纪律：打开卡片时读的是已在内存里的整值，零往返。

### 折叠器纪律

- `apply` 同步、纯函数、返回纯 JSON。
- 与本单元无关的事件**返回同一引用**，让宿主按 `Object.is` 抑制发布。
- `wire.view` 也做引用缓存，状态不变时返回同一个对象。
- 状态里不放 `Date.now()`：耗时字段交给客户端用边界时间戳现算。

### 图片缩略图与模型名（v2）

- 折叠器监听 `user/message`（扫 `data.content` 里的 `{type:'image', attachment}`，取最后一张）与 `model/selection`（`data.provider/model/reasoningEffort`），状态新增 `image` / `model` 两字段，**`stateVersion` 1→2**。旧 checkpoint 行 ver 不匹配时宿主从 seq 0 全量重放 —— 零误杀，冷会话在下一次事件推进后自愈。
- 缩略图经 `/session-live/api/image?ref=sha256:<64hex>&type=<mediaType>` 直读 `$DSH_HOME/attachments/v1/objects/<前2位>/<sha>`：ref 整体匹配白名单正则（无任何用户可控路径成分，穿越不可能），type 过 MIME 白名单否则回落 `image/png`，内容寻址字节永不变化故带 `immutable` 缓存头。该路由**不依赖宿主附件服务**，插件自己读文件。
- 设置页新增「显示图片缩略图」「显示模型名称」两项（11 字段），`src/shared.js` 的 SETTINGS_SPEC 是唯一真源，宿主 Config 与客户端文案全部从它派生。

### 缩略图点击放大（v3）

- 点缩略图放大到原图，**遮罩是原生 DOM，不挂 React 树**（`src/client/viewer.js`）。原因：宿主的悬停卡片在鼠标离开会话行时会卸载整棵插件组件树——遮罩若挂在树里，用户连大图都来不及看就会跟着消失。遮罩直接 `appendChild` 到 `body`，生命周期自己管：Esc / 点遮罩空白处关闭，关闭时摘掉 `keydown` 监听（不摘就是泄漏，自检里有一条专门盯它）。
- 点图片本身**不**关闭（用户可能正在看图）；同一时刻只允许一张遮罩，新开的先把旧的摘掉。
- 点击时 `preventDefault` + `stopPropagation` **两者都必须**：会话行自身带点击处理，冒泡过去会顺带把会话打开。
- 层级 `z-index:1300`，高于宿主全部客户端包的最大值（实测聚合宿主最高 1250）。
- 遮罩底色取宿主主题变量 `--dsw-alias-bg-mask-drop`——这是本插件**唯一**主题感知的颜色。遮罩底下是整页，必须跟随明暗主题；而悬停面板必须钉死颜色，因为宿主卡片自己硬编码深色底。两处规则相反，别照抄。
### 轻量化与一行概况（v4）

面板变小的方式是**合并**而不是堆叠：原先独立的模型行、以及「最近 ›」独立标题行都去掉了，改成尾部一行概况；缩略图默认从 96px 收到 72px（紧凑模式 56px）。行数从最多 7 行降到 4 行。

- **一行概况**（`UsageLine`）：`轮数 · token 合计 · 模型短名`，例：`131 轮 · 6.9M · deepseek-v4.1-flash`。悬停该行看细分（输入 / 输出 / 推理力度）。
- **token 不自己算**：直接读列表快照里的 `row.projectionValues.tokenUsage`（宿主内置 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` 投影，key `tokenUsage`，`stateVersion` 2）。输入 = `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`，输出 = `outputTokens`。**零新路由、零新折叠、零新请求**。
  - 依据：`dsh-api-session-controller/lib/types/list.js:282` 调 `projectionsFor` 时**不传 keys**，而 `dsh-session-projection/lib/index.js:243-261 viewCheckpoint` 在 keys 省略时**全量返回所有带 `wire` 的注册投影** —— 宿主已把 `tokenUsage` 算好放在同一份快照里。
  - 缺失即不显示：热会话首帧可能还没这个 cell，`tokenUsageOf` 返回 `null` 时该行少一项，**绝不因缺数据让整块消失**（`hasContent` 里 token 只是加分项，不是必需项）。全零也当「还没用量」处理，不显示 `0`。
- **轮数用自己折的** `liveActivity.turn`（`turn/start` 计数）。已与宿主权威 `sessionStats.turns` 逐条比对（24/24 吻合）；唯一差异是宿主只计「有闭合 step 的轮」，本插件计 `turn/start` 次数，一轮差属正常。
- **问答直白化**（`plainText` / `isInjectedText`）：
  - 成对注入块整块丢弃：`<system-reminder>` / `<untrusted-memory>` / `<available_skills>` / `<project_instructions>` / `<skill_content>` 等。
  - 宿主包装的英文元数据行整行丢弃：`Image "…"`、`Normalized copy`、`Source dimensions`、`[folded images:…]`、`[Compressed conversation section]`。
  - 再去掉裸标签、代码围栏行、表格行、markdown 记号与列表符号，折叠空白 —— 「问」栏于是显示人真正打进去的那句话。
  - **机器注入的消息不覆盖上一条真人提问**：`user/message` 里先用 `isInjectedText` 判定，整条都是注入就跳过，保持「问」是他说的话。已覆盖四大类（均于 2026-10-19 在真实会话输出里实测命中）：
    - 运行时上下文：`current runtime context.` / `this snapshot supersedes earlier runtime-context snapshots.` / `time sampled while preparing turn` / `current working directory:`
    - 压缩段占位：`[compressed conversation section]`（这类标记行会被元信息过滤先删掉，所以判定必须发生在剥壳**之前**）
    - 模型切换：`[model changed:`
    - 定时提醒：`[schedule reminder`（大小写都算）
    - 后台任务回执：`background job <id> (<cmd>)`
- **`stateVersion` 保持 2**：v4 只改**取值语义**，行结构（字段集合与类型）没变，旧 v2 行经 `stateSchema.parse` 依然合法，因此**不升版本号**。升版本会让所有老会话的磁盘行在直读路径被丢弃（`viewCheckpoint` 先比 `ver`），造成画面永久空白。旧行里的注入文本会在下一次 `user/message` 到达时被新值覆盖，自愈。
- **视图层净化**（`cleanPreview`）：`stateVersion` 保持 2 意味着宿主**不会重放**旧行，v2 时期写进 checkpoint 的注入文本会永远留在里面。所以 `buildView` 在**只读路径**上对 `prompt` / `reply` 再洗一遍（`isInjectedText` 为真直接置空，否则 `plainText` + 截断），状态本身不动 —— 历史脏值立刻干净，`Object.is` 发布抑制也不受影响。清洗是幂等的，新折叠器产出的干净值原样透出。
- **两个新函数是纯的**：`formatTokens`（0 / 999 / 1K / 15K / 1.2M）与 `shortModel`（`provider/a/b/model` 取末段、去掉 `-YYYYMMDD` 与 `-YYYY-MM-DD` 后缀、超 20 字符截断）—— 都不碰 DOM，`test/load-check.mjs` 与 `test/probe-usage-snapshot.mjs` 直接断言。

---

## 开发

```powershell
cd J:\plugin\dsh-session-live
# 全量 29 套（推荐）
Get-ChildItem test -Filter *.mjs | Where-Object { $_.Name -notmatch 'probe-ctx' } | ForEach-Object { node $_.FullName }

# 或跑主要几套
node test/load-check.mjs              # 客户端 bundle 27 项
node test/activity-check.mjs          # 宿主折叠与路由 + 视图净化 47 项
node test/host-e2e.mjs                # 宿主端到端
node test/probe-image-route.mjs       # 图片路由实测（字节级比对 + 穿越拦截）
node test/probe-usage-snapshot.mjs    # token 用量与轮数在真实链路上可读 15 项
node test/probe-zoom.mjs              # 点击放大：假 DOM 行为断言 20 项
node test/accept-live-render.mjs      # 真实宿主值 → 真 bundle → 渲染闭环（需 DSH 在跑）
```

绝大多数自检不需要启动 DSH：客户端用 `node:vm` + mock `__ModuleLoader__`/`require('react')`，宿主用 mock `ctx`。只有 `accept-live-render.mjs` 依赖活实例（不可达时 SKIP 而非 FAIL）。

### 本地改动怎么生效

- **宿主半边**（`index.js` / `src/*.js`）：`dsh-client-hmr` 会在文件变更时重建，但**投影注册这类宿主侧变更仍建议重启** `dsh web` 以确保干净。
- **客户端半边**（`client.js`）：HMR 会重算 artifact revision 并发布给浏览器，**通常无需重启**。
- 判断代码是否真的生效，**权威方法只有两条**：① combo 端点字节比对（`test/probe-bundle.mjs`）；② 响应体形状。**不要用 PID / 启动时间推断** —— 本插件曾因此误判「未生效」，实际早已生效。

### 改动后必做：同步运行时副本

DSH 加载的是 `C:\Users\candi\.dsh\profiles\web\node_modules\dsh-session-live`（**实体目录，不是 junction**），源码目录的改动**不会自动过去**：

```powershell
Copy-Item J:\plugin\dsh-session-live\client.js `
          C:\Users\candi\.dsh\profiles\web\node_modules\dsh-session-live\client.js -Force
# 其余文件同理；可先跑 test/accept-runtime-copy.mjs 验收副本
```

### 目录

```
dsh-session-live/
├─ index.js                  宿主入口（纯具名 re-export，禁止 default）
├─ client.js                 浏览器 bundle（零构建 CJS）
├─ src/
│  ├─ index.js               投影注册 + 路由 + 设置通道
│  ├─ activity.js            事件 → 活动状态折叠器
│  ├─ shared.js              两侧共享的设置规格（SETTINGS_SPEC，唯一真源）
│  ├─ config-schema.js       宿主 Config（从 SETTINGS_SPEC 派生，逐字段 volatile）
│  └─ client/                组件、样式、文案、store（参考实现）
├─ cordis.patch.yml          bundle patch
├─ package.json
└─ test/                     29 套零依赖自检
```

> `src/client/*` 是同一份逻辑的可读版本，实际交付的浏览器代码是 `client.js`（手写 CJS）。改逻辑时两处都要动，或只改 `client.js` 并跑 `test/load-check.mjs` 验证。

> **`Config` 必须静态求值 + 具名导出**：宿主 `cordis-plugin-loader` 的 `unwrapExports` 会执行 `exports = exports.default ?? exports`，一旦加了 `default` 导出，`Config` 立刻丢失 → 设置页读空 + 写入报错。`src/config-schema.js` 用 `createRequire` 同步解析 schemastery，不能用顶层 await。

---

## 兼容性

- DSH `>=0.2.0-rc.1 <0.3.0-0`（在 `0.2.1-rc.2` 上开发与验证）。
- 只用稳定服务：`slots` / `locale` / `webServer` / `settings` / `sessionProjections` / `sessions`。
  任何一项缺失时对应能力静默降级，不会让插件卡在 pending。
- 客户端只 `require` 宿主 seed 白名单里的 `react`，不 value-import 任何 `@deepseek-ai/*` 包。

---

## 已知边界

- 流式吐字的**未落盘增量**（`assistant/assistant-stream` 帧）暂未接入，面板显示的是最后一次落盘的状态。接它是下一步（见路线图 P1 后半）。
- 悬停卡片自身有 800ms 打开延迟（宿主行为），面板内容在卡片出现时即已就绪，不会再等。
- 面板只在卡片打开时挂载，不活跃会话零开销。

---

## 许可

MIT
