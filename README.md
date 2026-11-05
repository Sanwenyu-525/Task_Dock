# Task Dock

常驻 Windows 桌面的任务、启动器与 AI Agent 监控中枢。本地优先，任务、剪贴板与 Agent 数据默认不出本机。

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.85%2B-000000?logo=rust&logoColor=white)
![Windows](https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white)

Task Dock 把任务与提醒、应用启动与窗口切换、剪贴板历史、收集箱、文件暂存、专注计时、
工作流、全局搜索和 AI Agent 运行状态集中到一个可自由拖动、贴边停靠的悬浮入口。
主界面提供极简、紧凑、完整三种形态；完整模式带左侧导航，胶囊形态只保留一条轨道和按需展开的面板。
所有业务数据保存在本机 SQLite，不上传云端。

> **当前状态**：仅支持 Windows（当前构建与验收环境为 Windows 11 x64）。仓库内
> `package.json`、`Cargo.toml`、`tauri.conf.json` 的版本号仍为 `0.5.0`，功能迭代与验收记录
> 已推进到 v0.13，版本号尚未同步；文档中的 `v0.x` 是迭代记录，不是发行版本号。
> 功能状态统一按 **已实现 / 部分实现（写明限制）/ 规划中** 描述，依据见
> [功能规划目录](docs/ROADMAP.md) 与 [src/lib/featureCatalog.ts](src/lib/featureCatalog.ts)。

## 核心特色

- **常驻桌面的悬浮工作台**：极简 / 紧凑 / 完整三种形态，无边框、透明、置顶、可拖动缩放，靠近屏幕边缘自动吸附并停靠为胶囊。
- **任务与提醒闭环**：中文自然语言快速录入、优先级与分类、重复规则、桌面提醒、延后与撤销、完成趋势统计。
- **应用启动与窗口切换**：扫描本机已安装应用并读取真实图标，支持启动、唤醒窗口、打开工作区、恢复会话（按各 Agent 的公开接口能力降级）。
- **智能剪贴板**：文字 / 链接 / 富文本 / 图片 / 文件列表采集，连续截图自动分组，搜索筛选、批量复制、逐项粘贴、本地 OCR。
- **AI Agent 监控**：自动发现、Hooks / 插件 / 通用桥接接入，状态树、行动中心、事件历史与工作时间统计；只采信真实事件，不把「已安装」当成「已连接」。
- **本地优先**：SQLite + 本地文件，全量 / 快速备份可导出与恢复；剪贴板正文、图片和文件路径不写入日志。

## 界面预览

> 仓库目前没有与当前版本一致的正式截图，因此这里不嵌入历史图片。已有的视觉走查与验收截图保存在
> [docs/screenshots](docs/screenshots/)，仅代表当时版本；设计参考稿（非证据）在
> [docs/design-refs](docs/design-refs/)。

## 功能介绍

### 1. 桌面交互与外观

**已实现**

- **三种窗口形态**：完整（默认启动形态，左侧导航 + 主内容）、紧凑（约 400×560）、极简（仅保留标题栏与核心操作）。可在标题栏菜单、右键菜单与托盘中切换。
- **贴边胶囊**：拖到屏幕上、下、左、右边缘后停靠为一条 56×400 的轨道，按需展开 340×440 的功能面板；停靠期间窗口本身不移动，只切换 Win32 窗口区域，展开/收起不抖动。轨道提供任务、收集箱、剪贴板、应用四类入口，顶部 Agent 状态球直达 Agent 面板。
- **窗口行为**：无边框透明窗口、始终置顶、跳过任务栏、可拖拽与缩放；保存位置前校验窗口仍可见，重启后恢复。
- **主题体系**：明 / 暗 / 跟随系统 × 视觉预设「柔光玻璃 / 梦幻渐变」× 窗口材质「实色 / 玻璃」（默认跟随系统 + 柔光玻璃 + 玻璃材质）。三者正交，统一落到语义 Token；玻璃材质优先尝试系统原生效果，不可用时自动回退并提示实际生效效果。
- **导航自定义**：完整模式左侧导航的入口显隐与顺序可在设置中调整并持久化；应用与微件是新增入口，不占用既有数字快捷键，避免快捷键语义漂移。

**限制**

- 多显示器插拔、非 100% DPI 的极端组合仍在补齐真机走查，自动化测试不能替代桌面合成与命中测试。
- 贴边吸附的“手感”只能通过原生窗口验收，隔离浏览器预览只代表 harness 渲染。

### 2. 任务、提醒与效率

**已实现**

- **任务管理**：标题、描述、优先级、分类、标签、截止时间、提醒、重复规则、完成状态；任务详情可关联剪贴板素材、工作现场与专注记录。
- **快速录入**：中文自然语言解析（如“明天下午三点交周报”），创建前显示解析结果供确认；`Ctrl+K` 在窗口内唤起。
- **提醒**：相对时间（“N 分钟后”）、工作日、每月第 N 个星期 X、每月最后一个工作日、每 N 月等规则；支持提前提醒、延后（可撤销）、漏触发补偿、通知内“查看 / 稍后 / 完成”。
- **重复任务与统计**：按日 / 周 / 月查看完成率、逾期率、分类效率与趋势；无法还原的重复期次会标注“不完整统计”，不伪造分母。
- **专注与休息**：番茄钟与正计时，支持暂停 / 继续 / 完成 / 取消、休息与久坐提醒、每日记录与历史、任务关联，胶囊徽标同步剩余时间。
- **快速捕获**：独立小窗（`Ctrl+Shift+Space` 或托盘“快速捕获”），五种类型（快速任务 / 简单待办 / 想法 / 文字片段 / 链接）分别进入任务或收集箱；草稿自动保存与恢复，重复提交幂等。
- **全局搜索**：`Ctrl+Shift+F`（应用内）一次检索任务、剪贴板、收集箱、暂存架、应用目标、Agent 会话、工作现场、规划中心八类数据，并定位到具体条目。
- **历史**：通知与 Agent 事件统一时间轴，按日分组、连续重复聚合、来源 / 类型 / 时间筛选、分页加载。

**部分实现 / 限制**

- **智能日程提醒**：不接法定节假日 / 调休数据（有意为之），也不与场景、工作现场联动。
- **生活例行事项**：复用重复任务引擎；暂无独立的“今日待办 / 打卡 / 连续记录”视图。
- **全局搜索**：暂不搜“已发现但未登记”的应用；未引入 FTS5 索引，万级数据下的性能以实测为准。
- **通知聚合**：有双额度限流、完成合并摘要、静音与历史持久化；暂无跨来源聚合视图与逐条优先级。

### 3. 应用启动与窗口切换

**已实现**

- **本机应用扫描**：从开始菜单、卸载注册表、常见安装路径与 UWP 应用目录发现应用，合并去重；读取真实图标，不使用占位图。
- **导航目标**：可登记应用、文件、目录、网页、Agent 会话等目标；收藏项优先出现在胶囊的“应用”面板。
- **四级导航**：启动软件 → 唤醒已有窗口 → 打开工作区 / 目录 → 恢复会话。每一级只在目标 Agent 存在公开接口时启用，否则如实降级并标注，不臆造 Deep Link。
- **批量启动**：工作现场快照可保存一组导航目标并按顺序启动，逐项反馈成功 / 跳过 / 失败，支持取消未执行项。

**限制**

- L3“打开工作区”仅对提供 CLI 目录参数的 Agent 尝试（Trae / Qoder 等，属约定推断，未逐项核验帮助文本）。
- L4“恢复会话”目前以 Codex 为主要验证对象（`codex resume`），OpenCode 通过运行时探测 `--session` 动态启用；其他 Agent 诚实标注不支持。
- 多窗口应用只能唤醒“其中一个”窗口，无法精确锁定原实例。
- 全局搜索只覆盖已保存的导航目标，未登记应用暂不参与搜索。

### 4. 智能剪贴板

**已实现**

- **采集类型**：纯文本、URL、HTML 富文本、截图 / 图片、文件列表（含多文件）与混合内容；按内容哈希去重，再次复制只更新时间与使用次数。
- **来源信息**：类型、时间、大小、来源应用与窗口标题、识别方式、预览；图片落盘为独立资源，列表不直接传输二进制。
- **自动分组**：连续截图在默认 45 秒窗口内（可配 5–600 秒）进入同一分组，文字条目按实际发生顺序插入；分组可重命名、重排、拆分、合并。
- **整理与查看**：搜索（正文 / 来源 / 文件名）、类型与收藏筛选、分页加载；HTML 白名单只读阅读器、图片灯箱（缩放 / 平移 / 双击 / 另存为）、文件预览、URL 详情。
- **复制与粘贴**：整组富文本或文件一键复制；选择目标窗口后逐项粘贴，带队列进度与取消，失败时停止并报告。
- **OCR**：按需调用本机 `Windows.Media.Ocr` 识别图片文字，全程不上传；有超时、像素与内存上限，结果缓存随条目清理失效。
- **任务与 Agent 集成**：条目或分组可手动关联任务；可导出为本地 Agent 导入包（Markdown + 图片 + manifest），由用户自行交给 Agent，Task Dock 不自动发送。
- **隐私控制**：采集总开关；识别系统 / 应用敏感标记，并默认开启高置信敏感特征过滤；来源未知时进入保守凭据模式；配置异常时 fail-closed；日志只记录原因与计数，不记录正文、完整图片、路径或密钥。

**限制**

- 敏感过滤覆盖 Windows 常见标记与高置信特征，**不能保证**识别所有密码、验证码或密钥；这是启发式防线，不是数据防泄漏产品。
- 采集仅在 Task Dock 运行时生效；部分前台锁 / 权限条件下来源窗口信息可能缺失，界面会如实标注而不是伪造来源。
- 分组与保留策略按本地配额执行，收藏条目不会被自动清理。

### 5. AI Agent 集成

**已实现**

- **自动发现**：配置根、可执行文件路径、进程与安装目录多路探测；「已安装 ≠ 已连接」，健康状态只由真实事件证据决定。
- **接入向导**：安装 / 验证 / 卸载 Hooks 或宿主插件，多文件事务写入、幂等、失败回滚；卸载只移除 Task Dock 自己写入的条目。
- **统一事件模型**：`idle / running / waiting / completed / failed / disconnected` 六态；`waiting` 与 `failed` 进入行动中心并触发通知；默认 15 分钟无更新转 `disconnected`；`completed` 表示一轮执行结束，**不**等同于普通任务完成。
- **来源归属服务端判定**：事件载荷不采信客户端自报的“真实 / 测试”标记；自测与压测使用保留前缀或隔离来源，不会污染真实状态。
- **状态树**：Agent → 实例 → 会话 → 轮次，展示任务标题、待处理事项与最近事件；会话缺少实例信息时直接挂在 Agent 下，不伪造实例。
- **行动中心**：需介入 / 通知 / 历史三层，幂等确认、去重、全局计数、跳转会话；监控覆盖度单独展示，未接入或未验证的来源明确说明。
- **统计与历史**：Agent 工作时间统计、事件历史与通知时间轴；通知窗口支持查看 / 稍后 / 完成。
- **跳转**：启动应用、唤醒窗口、打开工作区、恢复会话（按公开接口能力分级）。

**支持情况**（以真实事件联调为准，完整矩阵见
[AGENT_COVERAGE_MATRIX.md](AGENT_COVERAGE_MATRIX.md) 与 [导航矩阵](APP_NAVIGATION_MATRIX.md)）

| Agent | 接入方式 | 真实事件联调 |
|---|---|---|
| Codex（CLI / App，共用 `~/.codex`） | Hooks | 已通过 |
| WorkBuddy / CodeBuddy | Hooks | 已通过 |
| Qoder | Hooks | 已通过 |
| DeepSeek Harness（DSH） | 宿主插件 | 已通过 |
| OpenCode | 宿主插件 | 已通过 |
| ZCode | 配置式 Hooks | 未观测到真实会话事件 |
| Trae / Trae CN | Hooks | 未通过；需在 Trae 内手动开启全局 Hooks |
| Claude Code / Cursor / Gemini CLI | Hooks / 配置 | 适配器已实现，真实会话事件未验证 |
| Windsurf、Cline、Roo Code、Continue、Augment、Copilot、Antigravity、Kiro、Aider、OpenHands、OpenClaw | 仅安装 / 运行发现 | 无自动事件通道，需通用桥接 |
| 任意 Agent | 本地 HTTP Bridge / 文件投递 | 可用（需 Agent 侧自行上报） |

- **通道**：本机 `POST 127.0.0.1:47821/api/v1/events`（Bearer 令牌），或向 `agent-inbox` 目录投递事件文件；Hooks / 插件只是把事件送进同一管线的方式。
- **真实联调计数：5 / 7**（7 个配置式 Hooks / 插件来源中，Codex、WorkBuddy、Qoder、DSH、OpenCode 通过；ZCode、Trae 不计入）。

**限制**

- 只保存 Agent 主动上报的运行状态、任务标题与轮次元数据，**不保存对话正文或完整聊天记录**；不能据此还原 Agent 的完整任务内容。
- Hooks 是否被宿主加载由宿主控制（如 WorkBuddy 需人工确认、Trae 需开启全局开关、ZCode 仅新会话加载）；Task Dock 不绕过这些安全确认。
- Codex App Server（stdio JSON-RPC）深度接入仍为规划缺口；当前只有 Hooks + `codex resume`。
- 通用桥接需要 Agent 自行实现上报，未接入的 Agent 不会被“自动监控”。

### 6. 收集、笔记与资料

**已实现**

- **收集箱**：快速捕获的五类内容进入未处理列表，可转为任务、转为笔记、标记处理或删除。
- **快速笔记**：自动保存、收藏 / 置顶、搜索、内置模板、关联任务与工作现场，支持全局搜索定位。
- **文件暂存架**：主动收纳文件、文件夹、图片、截图、链接与文本片段；引用模式只记录原路径，托管模式复制为 Task Dock 自有副本；支持搜索筛选、批量操作、过期清理、任务关联与备份。
- **一键工作流**：白名单步骤（打开应用 / 网页 / 文件目录、创建任务、恢复工作现场），顺序执行、暂停 / 继续 / 取消、逐步状态与失败策略；同一时刻只允许一个运行，操作 ID 保证幂等，异常退出标 `interrupted` 且不重放。
- **规划中心**：内置功能目录（只读，与 `featureCatalog.ts` 同源）+ 用户自建项目 / 特性 / 里程碑，可创建、编辑、归档。
- **桌面微件**：今日任务、下一条提醒、Agent 状态、快捷操作、专注倒计时、今日效率六类；可加入主窗看板，也可放入独立桌面轻量窗口，支持尺寸、置顶、拖动保存与备份迁移。

**部分实现 / 限制**

- **场景工作区**：已有工作现场快照与批量启动；独立的“场景”实体、场景管理界面和一键进入场景尚未实现。
- **工作现场恢复**：恢复能力按项标注验证级别；窗口位置尺寸、浏览器多标签的完整恢复仍是缺口。
- **文件暂存架**：暂不支持从暂存架拖出到资源管理器（OLE 通道未实现），也不与场景联动。
- **工作流**：没有任意脚本执行；“进入场景”步骤等待场景模块，真机窗口跳转仍有未验证项。
- **桌面微件**：独立窗口的多显示器插拔、100–200% DPI、重启恢复尚未完成真机验收。

### 7. 系统集成与数据

**已实现**

- **托盘与自启动**：托盘与主窗共用右键菜单，提供显示 / 隐藏、快速添加任务、快速捕获、极简 / 紧凑 / 完整模式、明 / 暗 / 跟随系统主题、胶囊 / 完整吸附方式、开机自启与退出；单实例运行。
- **全局快捷键**：可录制、修改、重置；分组展示应用内 / 系统级；冲突与系统占用会提示并降级，配置即时生效、重启保持，随备份迁移。
- **通知**：独立通知窗口 + Windows 原生通知；任务到期与 Agent 状态迁移可触发；支持稍后、完成、合并摘要、限流与静音。
- **提示音与语音播报**：Web Audio 合成提示音 + 本机 WinRT TTS，事件驱动、串行调度、有界队列、持久缓存；不接云端 TTS。
- **备份与恢复**：完整 / 快速备份、导出、恢复；覆盖业务表（当前 43 张，含 Clipboard / Shelf / Notes / Focus / Workflows / Planning）、设置、剪贴板图片与暂存文件；恢复有状态机，异常退出可续跑或回滚。
- **国际化**：简体中文与 English（`zh-CN` / `en-US`）词条，语言可在设置中切换。**部分实现**：英文覆盖尚未完整。

**数据位置**

```
%APPDATA%\com.taskdock.desktop\
├── task-dock.db          # SQLite 主库（迁移至 v33）
├── clipboard\            # 剪贴板图片 / 缩略图
├── shelf\                # 暂存架托管副本
├── agent-inbox\          # Agent 文件投递
├── backups\              # 备份产物
└── hotkeys.json          # 自定义快捷键
```

设置环境变量 `TASK_DOCK_DATA_DIR` 可把数据目录指向隔离位置，用于便携或验收实例；
优先级高于默认的 `%APPDATA%` 路径。

## 安装与快速开始

### 系统要求

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows x64 | 当前构建与验收环境为 Windows 11；Windows 10 未单独验证 |
| WebView2 | 系统自带或安装 Evergreen Runtime | Windows 11 默认包含 |
| Node.js | 20.19+ / 22.12+ | Vite 7 的最低要求；验收环境使用 Node 24 |
| Rust | 1.85+ | `Cargo.toml` 的 `rust-version` |
| MSVC | Visual Studio Build Tools + Windows SDK | 编译 Tauri / Win32 依赖 |
| 磁盘 | 预留充足空间 | `npm run tauri` 会在构建前自动检查磁盘与缓存 |

macOS / Linux 目前**不可用**，仅为规划项；规划中需补齐窗口材质、托盘与剪贴板平台层。

### 从源码运行

```powershell
npm install
npm run tauri dev
```

- 开发端口 `1420`（Vite），Agent Bridge 端口 `47821`。端口被占用时先释放，不要改到其他用户正在使用的端口。
- 首次构建会编译全部 Rust 依赖，耗时明显更长。
- `npm run tauri dev` 会先执行构建守卫 precheck；磁盘不足时会阻止高占用构建并给出清理建议。

常用命令：

```powershell
npm run build            # 类型检查 + 前端构建（生成 dist/）
npm test                 # 前端 vitest
npm run tauri build      # 构建 NSIS / MSI 安装包
npm run tauri build -- --no-bundle   # 只构建可执行文件
```

构建产物：

```
src-tauri/target/release/task-dock.exe
src-tauri/target/release/bundle/nsis/*.exe
src-tauri/target/release/bundle/msi/*.msi
```

仓库不托管安装包下载；请以本地实际构建产物为准。

### 构建缓存与磁盘

```powershell
npm run guard:precheck   # 空间与缓存检查
npm run guard:report     # 清理建议（只报告）
npm run guard:register   # 登记任务专属 target 目录
npm run guard:cleanup    # 默认 dry-run，需 --execute 才删除
```

优先复用共享增量缓存 `src-tauri/target`。确需隔离构建时，用**绝对路径**设置
`CARGO_TARGET_DIR` 指向任务专属目录并登记归属；相对路径会随 `cwd` 产生嵌套缓存。
细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第七章。

## 基本使用

### 首次启动

1. 启动后主窗口以完整模式显示，并在 `%APPDATA%\com.taskdock.desktop` 创建数据库与资源目录。
2. 在任务页用 `Ctrl+K` 或快速录入框添加第一条任务；自然语言解析结果会先展示，确认后创建。
3. 打开“应用”页扫描本机应用；收藏常用目标后会出现在胶囊的应用面板。
4. 在设置中开启剪贴板采集、开机自启或自定义快捷键。
5. 需要 Agent 监控时，到“Agent”页运行接入向导；宿主的安全确认（如 WorkBuddy 的 `/hooks`）仍需手动完成。

### 胶囊、工具面板与完整模式

- 把窗口拖近屏幕边缘即可贴边吸附；停靠后只保留轨道，点击轨道图标展开对应工具面板。
- 顶部 Agent 状态球汇总等待与失败数量；颜色表示运行 / 等待 / 失败 / 失联，数字只统计需要处理的事项。
- 需要左侧导航与完整页面时，从标题栏、右键菜单或托盘切换到完整模式。
- 右键菜单与托盘可切换极简 / 紧凑 / 完整、明 / 暗 / 跟随系统主题、吸附方式与开机自启；视觉预设与窗口材质在设置中调整。

### 默认快捷键

| 操作 | 默认快捷键 | 范围 |
|---|---|---|
| 显示 / 隐藏主窗口 | `Ctrl+Alt+T` | 系统级 |
| 打开快速捕获 | `Ctrl+Shift+Space` | 系统级 |
| 快速添加任务 | `Ctrl+K` | 应用内 |
| 打开剪贴板 | `Ctrl+Shift+C` | 应用内 |
| 全局搜索 | `Ctrl+Shift+F` | 应用内（窗口聚焦时） |
| 切换任务 / Agent / 行动 / 剪贴板 | `Ctrl+1` … `Ctrl+4` | 完整模式 |
| 收集箱 / 文件暂存 / 工作流 / 历史 | `Ctrl+5` … `Ctrl+8` | 完整模式 |
| 规划中心 / 设置 | `Ctrl+9` / `Ctrl+0` | 完整模式 |

快捷键均可在“设置 → 窗口与快捷键”中修改；应用与微件入口不占用数字键。

### 数据与隐私

- 所有业务数据在本机；Agent Bridge 只监听 `127.0.0.1` 并要求 Bearer 令牌。
- 剪贴板日志不记录正文、完整图片、文件路径或密钥；敏感过滤默认开启，但属于启发式防线。
- 备份包含剪贴板图片与暂存文件，导出前请自行确认内容敏感度。
- 暂无云同步；WebDAV / 文件同步仍是规划项。

## 技术架构

| 层 | 实现 |
|---|---|
| 桌面壳 | Tauri 2（Windows WebView2），多窗口：主窗、快速捕获、右键菜单、通知、桌面微件 |
| 前端 | React 19 + TypeScript 5.9 + Vite 7；自建组件层与语义 Token，无第三方 UI 框架 |
| 状态 | Zustand 5，按业务拆分为多个 store（任务 / Agent / 剪贴板 / 布局 / 设置等） |
| IPC | 统一经 [src/lib/bridge.ts](src/lib/bridge.ts)，参数 camelCase；导航经 [src/lib/navigation.ts](src/lib/navigation.ts) |
| 后端 | Rust：命令层、Agent 管线、剪贴板、应用扫描 / 窗口、热键、工作流、搜索、备份 |
| 持久化 | SQLite（rusqlite bundled，WAL + 只读连接池），迁移只追加到 v33；图片与暂存文件落盘 |
| 系统集成 | Win32 窗口区域与贴边、DWM / window-vibrancy 材质、WinRT 通知 / TTS / OCR、注册表与开始菜单扫描 |

关键约束：

- UI 不直接访问数据库，React 不直接调用 Win32；能力全部经 IPC 暴露。
- Agent 事件进入有界管线，`waiting / failed / completed` 不合并、不静默丢弃；过载返回可重试错误。
- 剪贴板采集使用多线程 + 有界队列 + 全局访问锁，锁内比较后才写入，不覆盖用户的新复制。
- 时间、监听器、轮询与后台任务必须可取消、有上限、退出时回收。

详见 [架构说明](docs/ARCHITECTURE.md)、[开发指南](docs/DEVELOPMENT.md)、
[测试矩阵](docs/TESTING.md)、[验收通道说明](docs/ACCEPTANCE_ROUTING.md)、
[Agent Adapter](docs/AGENT_ADAPTERS.md)。

## 项目结构

```text
task_dock/
├── src/                       # React 前端
│   ├── components/            # 按功能分组的视图与自建 UI 基元
│   ├── store/                 # Zustand 状态
│   ├── lib/                   # bridge、导航、主题、搜索、布局等
│   ├── i18n/  locales/        # 词条与 zh-CN / en-US 资源
│   └── hooks/                 # 快捷键、订阅等复用逻辑
├── src-tauri/
│   ├── src/commands/          # Tauri IPC 命令层
│   ├── src/agents/            # Adapter、事件管线、Hooks 安装、通知
│   ├── src/clipboard/         # 采集、存储、分组、粘贴、OCR
│   ├── src/navigation/        # 应用扫描、窗口与四级导航
│   ├── src/{shelf,notes,focus,workflows,global_search,hotkeys,db,audio,workspace}/
│   ├── capabilities/          # Tauri 权限配置
│   └── tests/                 # 集成、性能与真机套件（部分 ignored）
├── scripts/                   # 构建守卫、预览、原生验收、性能
├── docs/                      # 架构、模块文档、验收与证据
├── index.html                 # 主窗口
├── capture.html               # 快速捕获窗口
├── context-menu.html          # 右键菜单
├── notification.html          # 通知窗口
├── widget.html                # 桌面微件宿主
└── AGENTS.md                  # 协作与工程规范
```

## 开发与贡献

开始前请阅读 [AGENTS.md](AGENTS.md)：工作树可能被多个会话共享，未提交 / 未跟踪改动默认属于
其他任务，不得还原、覆盖或清理。

### 验证命令

```powershell
npm test                 # 前端单元测试（vitest）
npm run build            # tsc --noEmit + vite build
cd src-tauri
cargo test               # 后端测试；需要先存在 dist/（先执行 npm run build）
cargo clippy             # 建议无新增告警
cargo fmt --check
```

- `cargo` 必须在 `src-tauri/` 内运行，不要从仓库根用 `--manifest-path`。
- 标了 `#[ignore]` 的性能 / 真机套件不计入普通通过的结论。
- 真实窗口、系统通知、系统剪贴板、前台焦点、DPI、多显示器与贴边吸附必须原生真机验收；
  jsdom、单测与预览截图不能替代。
- 视觉走查使用 `node scripts/serve-preview.mjs`，不要用 `npx vite preview`。
- 原生取证使用 `scripts/native-verify.ps1`；通道分级见
  [docs/ACCEPTANCE_ROUTING.md](docs/ACCEPTANCE_ROUTING.md)。

### 代码与文档约定

- 新增功能入口先在 [src/lib/navigationRegistry.ts](src/lib/navigationRegistry.ts) 登记，不另写入口数组。
- SQLite 迁移只在 [src-tauri/src/db/mod.rs](src-tauri/src/db/mod.rs) 的 `MIGRATIONS` 末尾追加；
  新表登记备份；新设置键同步 `Settings` 与允许列表。
- 视觉只用语义 Token，不硬编码颜色 / 圆角 / 阴影；新弹层接入 overlay 栈。
- 架构、开发、测试、模块文档的归属见 [AGENTS.md](AGENTS.md) 第 9 节。
- 仓库未配置 GitHub Actions；提交前请在本地完成类型检查、测试与构建。

## Roadmap

完整规划与状态口径见 [docs/ROADMAP.md](docs/ROADMAP.md)，应用内入口为“规划中心”；
唯一事实源是 [src/lib/featureCatalog.ts](src/lib/featureCatalog.ts)（当前 28 项：已实现 12、
部分实现 13、规划中 3）。

**规划中**

- 第三方插件系统与沙箱：Adapter / 视图插件，需先完成权限模型与沙箱。
- WebDAV / 文件目录同步：基于现有备份引擎，用户显式开启，默认永不开启。
- macOS / Linux 适配：补齐窗口材质、托盘、剪贴板平台层与真机验收。

**待补齐的部分实现**（摘要）

- 场景工作区实体与一键进入场景；工作现场恢复补窗口布局与浏览器标签。
- 文件暂存架系统级拖出；通知跨来源聚合；全局搜索 FTS 索引。
- Codex App Server 深度接入；微件独立窗口的多显示器 / DPI / 重启恢复验收。

## License

本仓库根目录**没有**独立的 `LICENSE` 文件，因此 README 不声明 MIT、Apache 或其他开源许可证。
版权与第三方依赖许可见 [NOTICE](NOTICE) 与 [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)。
复制、分发或商用前请先与仓库维护者确认授权。
