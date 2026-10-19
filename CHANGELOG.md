# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 1.0.1 — 2026-10-19

### 修复

- **设置页在宿主设置导航里是一条空白项，用户根本点不到**：`settings.section` 的导航标题由宿主直接渲染注册描述里的 `label`，本插件注册时没给这个字段。补上 `label: () => t('settings.nav')`（中文「会话预览」，英文「Session preview」）。
  - 修复前实测：设置弹窗导航末位只有一个无文字齿轮图标，点开是空面板。
  - 修复后实测：导航出现「会话预览」并高亮，右侧渲染出 12 项设置，值全部读自 profile。

### 技术说明

- `label` 是**注册期元数据**，改客户端 bundle 后必须重启 dsh web 才生效（HMR 只重建 bundle，不重放已有注册）。
- 官方各节（`dsh-client-ui-settings-models` 等）一律给 `label`，写法为 `label: () => t("nav")`，本插件与之对齐。
- 新增断言 `设置区提供导航标题 label`（`test/load-check.mjs`），验证 `typeof options.label === 'function'` 且返回中文标题，防止该缺陷复发。

## 1.0.0 — 2026-10-19

首个稳定版。悬停卡片里的会话实时预览从「能看到在干什么」变成「一眼看完一轮对话」。

### 新增

- **用量概览行**：`轮数 · token 合计 · 模型短名`，一行读完，如 `131 轮 · 6.9M · deepseek-v4.1-flash`。
- **图片缩略图**：会话最近一张附件的缩略图，点击放大看原图（原生 DOM 遮罩，Esc 或点空白关闭）。
- **模型名**：会话当前使用的模型，支持推理力度标注。

### 变更

- 独立的模型行与「最近 ›」标题行合并进用量概览行，最坏情况面板行数 7 → 4。
- 缩略图默认高度 96 → 72px，紧凑模式 56px。
- 设置项从 9 个增至 12 个（`showUsage` 新增；`showImage`、`showModel` 独立开关）。

### 修复

- **问答直白化**：成对注入块（`<system-reminder>`、`<untrusted-memory>`、`<available_skills>` 等）整块丢弃；宿主包装的英文元数据行（`Image "…"`、`Normalized copy`、`[folded images:…]`）整行丢弃；再剥裸标签、代码围栏与 markdown 记号。
- **机器注入不再冒充提问**：`current runtime context.`、`[compressed conversation section]`、`[model changed:`、`[schedule reminder`、`background job <id> (<cmd>)` 这五类系统标记被识别并跳过，保持「问」是用户真正打进去的那句话。反向守卫：`background job 跑完了吗`、`[model changed] 这个提示能改吗` 这类真话原样保留。
- **工具结果不再污染「答」行**：`tool/result` 分支不再覆写 `reply`。
- `META_LINE` 正则补 `i` 标志，大写系统标记行（如 `[SCHEDULE REMINDER`）此前删不掉。

### 技术说明

- **token 用量不自己算**：直接读宿主 `dsh-token-meter` 注册的 `tokenUsage` 投影，`row.projectionValues.tokenUsage` 一次到手 —— 零新路由、零新折叠、零额外请求。
- **轮数**用自身折叠的 `liveActivity.turn`，与宿主权威 `sessionStats.turns` 逐条比对 24/24 吻合。
- **`stateVersion` 保持 2**：v4 只改取值语义、行结构未变，旧行过 `stateSchema.parse` 依然合法。升版本会让老会话磁盘行在直读路径被丢弃（`viewCheckpoint` 先比 `ver`），画面永久空白。
- **视图层净化**：`stateVersion` 不升意味着宿主不重放旧行，历史 checkpoint 里的注入文本会永久留存；故 `buildView` 在只读路径上再洗一遍 `prompt`/`reply`，状态本身不动，`Object.is` 发布抑制不受影响，清洗幂等。

### 验证

29 套自检全部通过（`node test/*.mjs`，逐套 exit code 判定）：

- 宿主折叠与路由 + 视图净化 47 项
- 客户端 bundle 27 项
- token 用量快照链路 15 项
- 图片路由 14 项（含字节级比对与 5 种路径穿越尝试全 400）
- 缩略图放大 20 项
- 宿主/客户端端到端、配置导出链、边界同源、三方同源、状态 schema、combo 字节比对等 23 套

## 0.1.0

初始开发版（未公开发布）。会话悬停卡片实时活动预览 + 独立设置页 + 图片缩略图 + 模型名。
