# TaskDock 当前架构审计报告（CURRENT STATE AUDIT）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 0 审计基线） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 桌面前端 `src/`、Rust 后端 `src-tauri/src/`、移动端 `apps/mobile/`、工程基础设施 |
| 事实优先级 | 代码与可复现输出 > 测试/真机证据 > 文档。本文数字均为 2026-11-19 源码实测，与文档冲突处以源码为准 |
| 审计方式 | 4 路只读子 Agent 并行审计 + 主架构师逐项复核纠错；未修改任何业务代码 |
| 相关文档 | [目标架构](TARGET_ARCHITECTURE.md)、[模块依赖](MODULE_DEPENDENCIES.md)、[重构路线图](../refactoring/REFACTOR_ROADMAP.md) |
| 相关 ADR | 见本文 §11「需新建 ADR」 |

---

## 0. 一页结论（给新 Agent 读）

TaskDock 是一个**模块化单体（Modular Monolith）**，不是微服务，也不应该拆成微服务。它已经具备不少**良好机制**：按需加载（`featureRuntime`/`featureRegistry`）、有界 Agent 事件管线、SQLite WAL + 只追加迁移、Tauri 多窗口独立 capability、移动端 domain/db 分层与本地优先 Outbox、Build Scheduler + Integration Snapshot + 多 Agent 文件所有权规范。

当前的主要工程风险不是"缺功能"，而是**边界腐化**：

1. **三个「上帝文件」**同时承载过多职责：`src/lib/bridge.ts`（7027 行 / 1028 导出 / 547 处 invoke）、`src-tauri/src/lib.rs`（2859 行 / 764 条命令注册）、`src-tauri/src/db/mod.rs`（7010 行 / 78 个迁移）。
2. **错误模型三处重复定义且契约不一致**（Rust / 桌面前端 / 移动端各一套 `AppError`），没有跨端单一事实源。
3. **一棵未被构建引用、已与主干分叉的平行前端树** `src-tauri/components/`（380 文件、153 处分叉），以及 `src-tauri/boot/`，均为未跟踪文件，疑似其他 Agent 在途工作，禁止删除。
4. **Command 层与 SQL 强耦合**：803 个命令中，`tasks.rs` 98 处、`backup.rs` 170 处、`data.rs` 108 处直接写 SQL；Repository 层只覆盖 8 个模块。
5. **工程治理工具缺位**：无 ESLint/Prettier/Biome，无循环依赖/架构边界检查工具；`tsconfig` 只覆盖 `src/`。
6. **文档与源码已漂移**：README 称迁移 v33 / 备份 43 表，源码实为 v78 / 143 表。

治理方向：**先补事实与工具（Phase 0–2），再按模块边界渐进重构（Phase 3+），每次只改一个边界、保持公开接口与行为不变。** 详见 [重构路线图](../refactoring/REFACTOR_ROADMAP.md)。

---

## 1. Git 基线与工作区保护事实（2026-11-19 实测）

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `7485d925bdafa4873fb0de410bca2449a62a4d92` |
| HEAD 提交 | `feat: 协作中心与按需加载等功能更新`（2026-11-19 09:52:45 +0800） |
| 已修改文件 | 22 个（均在工作区，暂存区为空） |
| 未跟踪项 | 14 个（目录/文件） |

**在途改动归属判断（只审计，不修改、不提交、不清理）：**

| 模块线索 | 涉及文件 | 判断 |
|---|---|---|
| files-workspace | `FilePane.tsx`、`FilesWorkspacePanel.tsx`、`useFilesWorkspaceStore.*`、`lib/filesWorkspace/*`、5 份 `docs/*/files-workspace.md`、`FilePane.*.test.tsx`、`FilesWorkspacePanel.layoutMenu.test.tsx` | 其他 Agent 在途功能 |
| boot 协议 | `src/boot/bootProtocol.ts`、`public/boot/boot-watchdog.js`、`docs/boot/README.md`、`src/test/bootSplash.test.ts` | 其他 Agent 在途功能 |
| workspace 窗口 | `workspace.html`、`src/workspace/main.tsx`、`src/workspace/bootstrap.ts`、`WorkbenchWindowControls.*` | 其他 Agent 在途功能 |
| personal-hub（未跟踪） | `src-tauri/src/personal_hub/`、`src-tauri/src/bin/taskdock-personal-hub.rs`、`src-tauri/boot/`、`src-tauri/components/`、`docs/personal-hub/`、`TaskDock_Personal_Hub_*.md` | 其他 Agent 在途功能；**重复源码目录疑点集中于此处** |
| 杂项未跟踪 | `.preview-pop/`、截图目录、`.md` 文档 | 归属未确认，只审计 |

> **保护红线**：以上任何文件在本次架构治理中不得 reset / clean / checkout 覆盖 / stash / 删除 / 代为提交。若重构与其产生交集，暂停该模块并报告主 Agent。

---

## 2. 全局模块清单

### 2.1 桌面前端 `src/`（18 个一级项）

| 目录 | 文件数 | 职责 |
|---|---:|---|
| `components/` | 474 | 全部页面面板与自建 UI 基元（42 个子目录），最大模块 |
| `lib/` | 200 | bridge、注册表、工具函数、缓存与单例服务 |
| `workbench/` | 92 | 大型工作台外壳 + 五类专业创作页面（`WorkbenchShell.tsx` 在此，不在 `components/workbench`） |
| `store/` | 53 | Zustand 状态（26 个业务 store + 测试） |
| `hooks/` | 30 | 通用 hooks（如 `useEdgeSnap.ts` 3068 行） |
| `workspace/` | 21 | 独立 workspace 窗口入口与项目上下文 |
| `help/` | 21 | 帮助中心内容与测试 |
| `notifications/` | 12 | 通知窗口 |
| `i18n/` + `locales/` | 9 + 2 | 国际化运行时；`en-US`/`zh-CN` 语言包各约 4900 行 |
| `context-menu/`、`capture/` | 各 7 | 右键菜单、快速捕捉窗口 |
| `widgets/`、`test/`、`tab-hint/` | 5/4/4 | 微件窗口、测试基建、标签提示窗口 |
| `toolbar/`、`boot/` | 2/2 | 工具栏窗口、启动协议 |

根级另有 `App.tsx`、`main.tsx`、5 个 `styles-*.css`（`styles.css` 486 KB 聚合样式）。

### 2.2 Rust 后端 `src-tauri/src/`（31 个模块目录 + 25 个根级 `.rs`，合计约 53,615 行）

主要模块及文件数：`commands/` 50、`agents/` 27、`mcp/` 18、`collab/` 16、`agent_access/` 15、`shelf/` 13、`secure_vault/` 13、`dragdrop/` 11、`clipboard/` 9、`capability/` 9、`resource_cleanup/` 8、`personal_hub/` 7（未跟踪）、`navigation/` 7、`diagnostics/` 7、`recycle/` 6、`mobile_sync/` 6、`workflows/` 5、`focus/` 5、`db/` 2 等。根级大文件：`lib.rs`、`window_shape.rs`、`magnetic.rs`、`project_workspace_window.rs`、`scheduler.rs` 等。

### 2.3 移动端 `apps/mobile/`

| 目录 | 存在 | 文件数 | 职责 |
|---|---|---:|---|
| `domain/` | 是 | 26 | 纯函数：类型/筛选/时间/重复规则，**零平台依赖** |
| `db/` | 是 | 37 | 唯一 SQL 目录；schema/迁移/CRUD/同步落地 |
| `features/` | 是 | 41 | 按功能聚合页（capture/tools），`capture/service.ts` 1115 行 |
| `components/` | 是 | 52 | 展示组件 + `entry/`、`icons/` |
| `screens/` | 是 | 25 | 编排/交互（Home/Tasks/Capture/Life/Files/Pairing/Sync…） |
| `lib/` | 是 | 79 | `sync/`（协议/客户端/安全通道）、`net/`、`capture/`、`life/` |
| `notifications/` | 是 | 3 | 提醒通道与排期 |
| `theme/` | 是 | 5 | Token/主题上下文/动效 |

**注意**：用户清单中的 `services/` **实际不存在**；服务职责落在 `lib/sync/` 与 `features/capture/service.ts`。原生扩展 `modules/` 8 个（secure-http、share-intent、taskdock-widget、voice-recorder、network-state、launch-intent、clipboard、media-store），`plugins/` 5 个 config plugin。

### 2.4 工程基础设施

- `package.json`：38 条 scripts（构建/测试/守卫/集成/调度/预览）；依赖含 vitest 3、TS 5.9、Vite 7、Playwright、React 19；**无 ESLint/Prettier/Biome/dependency-cruiser**。
- `tsconfig.json`：`strict: true` + `noUnusedLocals/Parameters` 等；`include: ["src"]`（移动端与 `src-tauri/components/` 不在类型检查内）。
- `vite.config.ts`：8 个多页入口；`cssCodeSplit: false`；`watch.ignored: ["**/src-tauri/**"]`。
- `src-tauri/Cargo.toml`：版本 0.5.0、edition 2021、rust-version 1.85；3 个 bin；约 48 个直接依赖。
- `src-tauri/tauri.conf.json`：8 个多页入口对应窗口，静态声明 5 个；CSP 含 `'unsafe-inline'`。
- `capabilities/`：8 个权限文件，按窗口隔离；主窗 `default.json` 权限面偏宽。
- 已有守卫脚本：`build-guard.mjs`、`worktree-guard.mjs`、`rail-contract.mjs`、`check-entry-css.mjs`、`on-demand-audit.mjs`、`visual-audit.mjs`；**无架构边界/循环依赖检查工具**。
- 集成基础设施：`taskdock-integration.mjs`、`build-sched.mjs` + `scripts/sched/`、`worktree-guard.mjs` 均已存在并配套测试。

---

## 3. 依赖关系图（实际观测）

### 3.1 前端依赖流向

```
外壳层  App.tsx / FullView.tsx / WorkbenchShell.tsx
   ├── 静态 import bridge.ts           ← IPC 封装被外壳直接依赖（紧耦合但属命令封装，不破坏拆包）
   ├── FeatureView → featureRuntime → featureRegistry（load: () => import(...) 按需加载，唯一页面入口）
   │      └── 例外：FullView.tsx:38 静态 import TasksPanel（默认页例外）
   └── 7+ store
          ├── useGlobalSearchStore → useUiStore + useScenarioStore + useTasksStore + useWorkflowsStore（最重，4 个）
          ├── usePlanningStore → useNotesStore + useTasksStore
          ├── useActionsStore → useSettingsStore + useUiStore
          └── ...
lib/errorReport.ts → store/useUiStore        ← ⚠ 层次倒置：lib 反向依赖 store
App.tsx → lib/errorReport.ts                ← 形成 App → errorReport → store
featureRuntime → (延迟 import) diagnostics   ← 用动态 import 打断 runtime↔diagnostics 循环
```

**4 条并行 IPC 出口**（边界分散）：
1. `src/lib/bridge.ts`（547 invoke，主键）
2. `src/workbench/creative/ipc.ts`（`creativeInvoke<T>()`，有注释声明刻意绕开 bridge）
3. `src/lib/widgets/desktopBridge.ts`（十余条窗口/微件命令）
4. `src/lib/dragCursorSession.ts` + `src/workbench/windowFrame.ts`（直连 invoke，边界模糊）

其中 2 条有明确设计理由，但构成"IPC 出口不唯一"的架构事实。

### 3.2 后端依赖流向

```
Tauri Command (commands/*.rs, 803 个)
   ├── 直接 SQL（tasks 98 / backup 170 / data 108 处）  ← ⚠ Command 与 SQL 强耦合
   ├── 部分经 store 层（8 个模块有类 Repository 的 store.rs）
   └── Db 闭包 API（with_read / with_conn / with_transaction）
          └── Mutex<写连接> + 3 个只读连接；journal_mode=WAL
lib.rs (2859 行)
   ├── 57 个 mod 声明
   ├── 17 处 manage() 状态装配
   ├── generate_handler![764 条命令]               ← ⚠ 上帝文件
   ├── 插件/托盘/窗口/退出握手/CLI/启动意图/单测
agents/pipeline.rs（有界 mpsc + Semaphore + 超时 + drain）
   └── origin 服务端判定（EventOrigin 五态，客户端不可伪造）
```

### 3.3 移动端依赖流向（健康）

```
screens / components / features
   └── db/ 函数（唯一 expo-sqlite 入口；screens 无一处直接写 SQL）
domain/（纯函数，无 react/db/平台依赖）
lib/sync/（secureFetch → 原生 secure-http；SPKI 固定）
notifications/（仅 expo-notifications + db 函数）
theme/（无反向依赖）
```

移动端分层是当前三端中**最干净**的，值得作为"分层正确"的参照。

### 3.4 跨端契约

- **桌面 ↔ 移动同步契约各自维护**：移动端 `apps/mobile/src/lib/sync/protocol.ts`（TS DTO）与桌面端 `src-tauri/src/mobile_sync/`（Rust DTO）**无共享事实源**、无 `shared/` 目录，存在字段漂移风险。
- 配对层版本 v2，但 HTTP 路由仍 `/v1/*`、加密 AAD 仍 `taskdock-sync-v1`——版本号语义不一致。

---

## 4. 超大型文件分析（重点文件逐一对照）

### 4.1 前端 Top 10（`.ts/.tsx`，排除测试）

| 行 | 文件 | 主要职责 | 多职责 |
|---:|---|---|---|
| 7027 | `src/lib/bridge.ts` | 全后端命令封装 + DTO 类型（1028 导出 / 547 invoke） | 是（上帝模块，横跨所有业务域） |
| 4917/4893 | `src/locales/{en-US,zh-CN}/index.ts` | 语言包数据 | 否（数据型） |
| 3068 | `src/hooks/useEdgeSnap.ts` | 贴边吸附交互逻辑 | 是 |
| 2997 | `src/components/shelf/ShelfWorkspace.tsx` | 暂存架工作区 | 是 |
| 2847 | `src/components/files/FilesWorkspacePanel.tsx` | 工具栏+递归分割+拖放+几何+对外命令 API | 是 |
| 2839 | `src/components/agents/AgentPanel.tsx` | Agent 状态树/行动/历史 | 是 |
| 2646 | `src/workbench/WorkbenchShell.tsx` | 工作台外壳（导航/窗口/跨窗路由/搜索/门禁） | 部分（外壳层合理聚合） |
| 2464 | `src/lib/featureCatalog.ts` | 62 项规划目录数据 | 否（数据型） |
| 2344 | `src/components/files/FilePane.tsx` | 文件窗格 | 是 |
| 2019 | `src/components/clipboard/ClipboardWorkspace.tsx` | 筛选/分页/多选/分组/粘贴/灯箱/详情 | 是 |

> 说明：大文件≠必须拆分。语言包/`featureCatalog` 是数据文件，不拆。UI 面板巨型化是真问题（第 4.4 节给拆分方向）。

### 4.2 后端 Top 10（`.rs`）

| 行 | 文件 | 主要职责 |
|---:|---|---|
| 7010 | `src-tauri/src/db/mod.rs` | 连接管理 + WAL + 78 个迁移（内联 SQL + 外部常量）+ 设置 + 事务 |
| 6346 | `src-tauri/src/clipboard/store.rs` | 剪贴板数据访问（190 处 SQL） |
| 6315 | `src-tauri/src/commands/backup.rs` | 备份命令（170 处 SQL，143 张备份表规则） |
| 4880 | `src-tauri/src/clipboard/platform.rs` | Win32 剪贴板采集（三线程+锁+队列） |
| 3966 | `src-tauri/src/agents/mod.rs` | Agent 事件模型 + origin 判定 + 分流 |
| 3895 | `src-tauri/src/file_workspace/mod.rs` | 文件工作区 |
| 3745 | `src-tauri/src/window_shape.rs` | 窗口区域/DWM 圆角裁剪 |
| 3398 | `src-tauri/src/shelf/fsops.rs` | 暂存架文件操作 |
| 3339 | `src-tauri/src/commands/data.rs` | 数据命令（108 处 SQL） |
| 3171 | `src-tauri/src/commands/tasks.rs` | 任务命令（98 处 SQL + 业务规则） |

### 4.3 三个「上帝文件」深度对照表

#### `src/lib/bridge.ts`（前端 IPC 边界）

| 项目 | 内容 |
|---|---|
| 当前职责 | 类型化 IPC 桥接：所有后端命令封装 + DTO 类型定义 |
| 主要导出 | 1028 个 `export`；547 处 `invoke<`；覆盖 task/agent/clipboard/resource/planning/mcp/workspace/capture/voice/tts 等 |
| 依赖 | `./errors`（`invokeCommand`）、`@tauri-apps/api/event`（listen） |
| 被依赖 | 几乎全部 store + 所有面板 + 外壳（`App.tsx:62`、`WorkbenchShell.tsx:129-150`、`TitleBar.tsx:21` 等） |
| 职责问题 | 单一职责（IPC 封装）但横跨所有业务域，任一业务线改动都碰同一文件；`creative/ipc.ts:3-6` 注释承认另起出口是为避免并行冲突 |
| 拆分方案 | 保留 `bridge.ts` 作为 Facade 继续导出全部符号；内部按域拆 `bridge/{tasks,agents,clipboard,files,system}.ts`；新增 `contracts/commands.ts` 定义 `CommandContracts`（命令→args/result 类型） |
| 兼容方案 | 公开导出零变化（re-export）；调用方零改动；`@deprecated` 不提前加 |
| 测试方案 | 现有 `npm run typecheck` + `npm test`；新增契约测试校验 `CommandContracts` 与 Rust `#[tauri::command]` 签名 |

#### `src-tauri/src/lib.rs`（应用装配）

| 项目 | 内容 |
|---|---|
| 当前职责 | 模块声明(57)、run()(572，约 1600 行)、插件装配、17 处状态 manage、命令注册(764)、窗口/托盘/事件/退出握手/CLI/启动意图/单测 |
| 主要函数 | `run()`、`setup_tray()`、`refresh_tray()`、`restore_window()`、`request_exit()`、`flush_workbench_before_exit()`、`startup_intent_from_args()`、`agentctl()` |
| 职责问题 | 上帝文件：任何命令增删都改此文件；装配逻辑与业务生命周期混杂 |
| 拆分方案 | 拆 `app/bootstrap/`（插件与状态装配）、`app/commands.rs`（`generate_handler!`）、`app/windows/`（窗口/托盘）、`app/lifecycle.rs`（退出握手/启动意图）、`app/cli.rs`；`lib.rs` 只保留 mod 声明与 `run()` 编排 |
| 兼容方案 | 全部为 `pub(crate)` 内部重组，不改 Tauri 对外命令名与行为 |
| 测试方案 | `cargo test`（需先 `npm run build` 生成 dist）；启动/退出握手需真机验收 |

#### `src-tauri/src/db/mod.rs`（数据边界）

| 项目 | 内容 |
|---|---|
| 当前职责 | `Db`（1 写 + 3 读连接）、WAL 配置、78 个迁移（内联元组 + `crate::*::MIGRATION_N` 外部常量混合）、设置表、事务 API、回填 |
| 主要函数 | `open()`、`with_read()`、`with_conn()`、`with_transaction()`、`apply_migrations()`、`get/set_setting()`；`MIGRATIONS: &[(i64,&str)]` |
| 职责问题 | 7010 行单文件；迁移 SQL 全内联或分散在业务模块的 `MIGRATION_N` 常量，缺乏统一迁移目录；无独立 Repository 层，`Db` 闭包被命令直接调用 |
| 拆分方案 | **保持 `MIGRATIONS` 数组与版本号不变（红线）**；将 SQL 定义迁到 `infrastructure/sqlite/migrations/`（每版本一文件，`include_str!` 引用，数组顺序与版本不变）；新增 `ConnectionManager` 与 `Repository` trait，逐步承接 `with_read/with_conn` 调用 |
| 兼容方案 | 迁移版本号、`user_version`、表结构完全不变；旧 `Db` API 保留为 Facade |
| 测试方案 | 现有迁移原子性测试（`db/mod.rs:5066`）；新增隔离测试库迁移回放测试；验证备份 143 表与恢复 |

> **纠错记录**：子 Agent 曾报"58 个迁移 v58"与"v78"冲突。主架构师实测：`MIGRATIONS` 是「内联 SQL 元组 + 外部常量」混合数组，版本 1→78，末项为 `crate::project_hub::schema::MIGRATION_78`。**以 v78 为准**。README 的 v33 已过时 45 个版本。

### 4.4 大型 UI 业务组件拆分方向（Phase 4 预案，本次不动）

- `FilesWorkspacePanel.tsx`（2847）：拆 `components/`（渲染）+ `hooks/`（拖放仲裁/锚点几何）+ `services/`（文件操作编排）+ 保留 `openFilesWorkspacePath` 对外入口。
- `ClipboardWorkspace.tsx`（2019）：筛选/分页/多选/分组逻辑下沉到 hook 与 store，组件只做编排。
- `AgentPanel.tsx`（2839）：状态树/行动/历史拆分为子组件域。
- **红线**：不得把业务逻辑简单搬进更多 Hook 形成新职责混乱；每个拆分写明数据来自谁、状态归谁、卸载释放什么。

---

## 5. 重复代码分析

### 5.1 错误模型三处重复（P0）

| 端 | 文件 | 模型 | 码集 |
|---|---|---|---|
| Rust | `src-tauri/src/error.rs:16-47` | `enum AppError`（12 变体）+ `ErrorCategory` + `ErrorSeverity` | PascalCase 14 码 |
| 桌面 | `src/lib/errors.ts:14-34,76-148` | `class AppError` + `ERROR_CODES` + `CODE_META` | 17 码白名单 |
| 移动 | `apps/mobile/src/lib/errors.ts:22-60` | `AppErrorKind` + `AppErrorCode` + `class AppError` | 小写码集 |

三套同名但字段/码集/语义各异，无共享事实源、无跨端契约测试。后端 `meta()` 不产生前端白名单中的 `CONFIG_ERROR`/`UNSUPPORTED`/`UNKNOWN_ERROR`。前端另有 `errorReport.ts`、`globalErrors.ts`、`i18n/errors.ts` 分担错误职责（有分层意图但概念重叠）。

### 5.2 平行源码树（P0，禁止删除）

| 目录 | Git 跟踪 | 文件数 | 与主干关系 | 构建引用 |
|---|---|---:|---|---|
| `src-tauri/components/` | **未跟踪** | 380（354 个 `.ts/.tsx`） | 153 处分叉；0 个独有文件，50 个仅主干有；约 103 个同名不同内容 | 未被引用 |
| `src/components/` | 已跟踪 | 474 | 主干 | 是 |
| `src-tauri/boot/` | **未跟踪** | 2 | `bootProtocol.ts` 与主干不同；test 相同 | 未被引用 |
| `src/boot/` | 已跟踪 | 2 | 主干 | 是 |
| `public/boot/` | 已跟踪 | 1 | 契约基准 `boot-watchdog.js` | 是 |

`vite.config.ts:61` 忽略 `src-tauri/**`，HTML 入口仅引用 `/src/*`，Rust 主程序不引用 `components/`。**结论：这两棵未跟踪树当前不参与构建，属在途/残留副本；因所有权未确认，只审计，不删除。**

### 5.3 多套注册表/catalog（P2）

`featureRegistry`（页面代码）、`navigationRegistry`（导航项）、`commandRegistry`（命令短语）、`featureCatalog`（62 项规划）、`settingsSections/Categories`、`lifecycleCatalog`、`help/registry`、`creative/moduleRegistry`、移动端 `entryRegistry`/`toolCatalog`。职责不同但均属"登记中心"，命名相近，新人易混淆。需逐一确认是否存在重复登记。

### 5.4 其他重复

- `formatBytes` 疑似在 `lib/clipboardUi.ts` 与 `lib/format.ts` 重复定义（待人工确认）。
- 模块级单例与事件总线面很大：`featureRuntime.ts:181-200`、`audioNotification.ts:1331`、`fileDrop.ts:123-157`、`diagnostics.ts:54-66`，均配套 `__reset*ForTests`（有意为之，但全局态面广）。

---

## 6. 架构问题分级清单（P0/P1/P2）

> P0 = 架构级/安全/数据风险，优先治理；P1 = 可维护性/结构；P2 = 规范一致性/技术债。

### P0（8 项）

1. **三个上帝文件**：`bridge.ts`(7027/547 invoke)、`lib.rs`(2859/764 命令)、`db/mod.rs`(7010/78 迁移)。证据：见 §4.3。
2. **错误模型三处重复定义、契约不一致、无单一事实源**。证据：§5.1。
3. **平行前端树 `src-tauri/components/`(380 文件/153 处分叉) 与 `src-tauri/boot/` 未跟踪且已分叉**。证据：§5.2（不删除，需确认所有权后处置）。
4. **Command 与 SQL 强耦合**：803 命令中 tasks 98、backup 170、data 108 处直接 SQL，Repository 仅覆盖 8 模块。证据：§3.2。
5. **IPC 出口不唯一**：4 条并行出口（bridge / creative/ipc / desktopBridge / dragCursorSession）。证据：§3.1。
6. **`lib/errorReport.ts:14` 反向依赖 `store/useUiStore`**，形成 `App → errorReport → store` 层次倒置。证据：§3.1。
7. **README 关键数据失实**：迁移 v33（实 v78）、备份 43 表（实 143）。证据：§8。
8. **跨端同步契约双份维护、无共享事实源**，字段/版本易漂移。证据：§3.4。

### P1（9 项）

9. 组件巨型化：`FilesWorkspacePanel`(2847)、`WorkbenchShell`(2646)、`AgentPanel`(2839)、`ClipboardWorkspace`(2019)、`ShelfWorkspace`(2997)、移动端 `CaptureScreen`/`LifeScreen`(≈1800)。
10. Store 承载过多业务逻辑：`useFilesWorkspaceStore`(1480)、`useShelfStore`(1166)、`useNotesStore`(874)、`useClipboardStore`(846)。
11. Store 间隐式耦合：`useGlobalSearchStore:39-42` 组合 4 个 store；`usePlanningStore`、`useActionsStore`、`useAgentOnboardingStore`、`useHotkeysStore` 互相依赖。
12. CSP 含 `'unsafe-inline'`（script/style）。证据：`tauri.conf.json:101-102`。
13. 持 tokio Mutex 跨 `.await`：`agents/pipeline.rs:632,650`（`shutdown_lock` 持锁期间 `wait_for_stopped().await`），幂等设计使其可控但属可疑模式。
14. 37 处 shell 进程调用（`powershell.exe`/`cmd.exe`），参数来源未逐一验证。证据：`agents/hooks_install.rs:1161,1188`。
15. 手动输码配对为 TOFU 首用信任，首次连接存在中间人窗口（同步阶段已 fail-closed）。证据：`pairClient.ts:148-149,214-217`。
16. 移动端测试盲区：`notifications/` 3 文件 0 测试、`App.tsx` 0 测试、原生 `SecureHttpModule.kt` 无单测；超大页面无测试。
17. 无 ESLint/Prettier/Biome；无循环依赖/架构边界检查工具；`tsconfig` 只覆盖 `src/`。

### P2（8 项）

18. 页面静态导入绕过 registry：`FullView.tsx:38,481`（默认页例外，破坏"load 唯一入口"一致性）。
19. 错误职责分散 4 处：`errors.ts`、`errorReport.ts`、`globalErrors.ts`、`i18n/errors.ts`。
20. 多套注册表/catalog 并存（§5.3）。
21. 39 个 `#[tauri::command]` 未出现在 764 条注册清单（潜在死代码/遗漏注册，需复核）。
22. 42 处 SQL 用 `format!` 拼接（多为常量列名），缺统一参数化约束；`actions/mod.rs:603,685,783` 动态过滤来源待复核。
23. 路径边界部分仅用 `starts_with(root)` 未见 canonicalize，符号链接逃逸待查：`mobile_sync/files.rs:255`。
24. 协议版本语义不一致：配对 v2 vs HTTP 路由/AAD v1；`HostnameVerifier` 恒 true（SPKI 固定补偿，需补文档）。
25. 模块级单例/全局可变状态面过大（§5.4）。

---

## 7. 最值得优先重构的 20 个位置

| # | 位置 | 问题 | 优先级 | 目标 |
|---:|---|---|---|---|
| 1 | `src/lib/bridge.ts` | 7027 行上帝桥接层 | P0 | Facade + 按域内拆 + CommandContracts |
| 2 | `src-tauri/src/lib.rs` | 2859 行上帝装配 | P0 | 拆 `app/bootstrap·commands·windows·lifecycle·cli` |
| 3 | `src-tauri/src/db/mod.rs` | 7010 行 + 内联迁移 | P0 | 保持版本红线，迁移文件化 + Repository |
| 4 | 三处 `errors.ts` | 错误模型不统一 | P0 | 跨端共享错误契约 + 单一码集 |
| 5 | `src-tauri/components/` | 平行源码树分叉 | P0 | 确认所有权→归档/删除（本次不动） |
| 6 | `src-tauri/boot/` | 启动协议镜像分叉 | P0 | 同上 |
| 7 | `commands/tasks.rs` | 98 处 SQL + 业务规则 | P0 | tasks Repository + Application Service |
| 8 | `commands/backup.rs` | 170 处 SQL | P0 | backup Repository + 143 表规则数据化 |
| 9 | `commands/data.rs` | 108 处 SQL | P1 | data Repository |
| 10 | `src/lib/errorReport.ts` | lib→store 层次倒置 | P0 | 依赖注入/事件上抛，去掉 store 反向依赖 |
| 11 | IPC 4 出口 | 边界不唯一 | P0 | 统一经 bridge，或契约化受控例外 |
| 12 | 跨端同步 DTO | 双份维护 | P0 | 共享契约文件 + 契约测试 |
| 13 | `clipboard/store.rs` | 6346 行 / 190 SQL | P1 | Clipboard Repository（已有雏形，完善） |
| 14 | `useFilesWorkspaceStore.ts` | 1480 行 store | P1 | 状态/业务分离 |
| 15 | `useGlobalSearchStore.ts` | 组合 4 store | P1 | 检索服务独立，store 只留状态 |
| 16 | `FilesWorkspacePanel.tsx` | 2847 行组件 | P1 | 组件/hook/service 分离 |
| 17 | `WorkbenchShell.tsx` | 2646 行外壳 | P1 | 外壳保留聚合，抽窗口/门禁子模块 |
| 18 | 移动端 `CaptureScreen`/`LifeScreen` | ≈1800 行 | P1 | 页面拆分 + 补测试 |
| 19 | `agents/pipeline.rs:632,650` | 持锁跨 await | P1 | 缩小锁粒度 |
| 20 | README 文档漂移 | v33/43 表失实 | P1 | 随治理同步更新并建一致性守卫 |

---

## 8. 文档与源码一致性抽查

| README 声称 | 源码实测（2026-11-19） | 结论 |
|---|---|---|
| 迁移至 v33（`README.md:207,329`） | `db/mod.rs` `MIGRATIONS` 末项 v78 | **严重过时**（差 45 版本） |
| 备份覆盖 43 张表（`README.md:200`） | `backup.rs:291-1036` `BACKUP_TABLES` 143 条规则/143 唯一表 | **严重过时**（约少 100 张） |
| featureCatalog 62 项（`README.md:407,414`） | `featureCatalog.ts` 62 个 `id:` 条目 | **一致** |
| 命令经统一 bridge（`README.md:327`） | 实测 4 条 IPC 出口 | **部分失实** |

> 治理要求：架构文档必须以源码为准；每次迁移/备份表变化同步更新 README 或建立自动一致性守卫（Phase 2）。

---

## 9. 目标目录结构（Phase 1 详述，此处给出方向）

```
src/                         src-tauri/src/                  apps/mobile/src/（保留现有）
  app/                         app/                            domain/   （保持纯净）
    bootstrap/                   bootstrap/                    db/       （唯一 SQL 入口）
    shell/                       state/                        features/
    providers/                   commands/  ← generate_handler  components/
    routing/                     windows/                      screens/
  features/                      plugins/                      lib/sync/ （共享契约）
    tasks/ files/ clipboard/   domains/<业务>/                services/ （可选，按需）
    agents/ workspace/ vault/  application/<用例>/
    workflows/ mobile/         infrastructure/sqlite/         notifications/ theme/
    navigation/                platform/windows/
  platform/tauri/              shared/errors·events·types/
  shared/ui·errors·contracts·utils·hooks/
```

**原则**：模块化单体 + 端口/适配器（Hexagonal）轻量化落地；**不强制**所有简单 CRUD 走满五层；不把桌面端与移动端强行耦合；不更换数据库/状态管理/UI 框架。

---

## 10. 设计模式使用矩阵（Phase 1 详述，此处给出结论）

| 模式 | 是否采用 | 适用点 | 理由/约束 |
|---|---|---|---|
| Repository | ✅ 采用 | SQLite、任务/剪贴板/文件/工作区/移动本地数据 | UI 不直连 DB；不为内存操作强建 |
| Unit of Work | ✅ 采用 | 多表写入、跨实体事务、备份恢复 | 明确事务边界，失败回滚，避免嵌套 |
| Strategy | ✅ 采用 | Agent Provider、文件操作、平台适配、同步策略 | 已有 Adapter 雏形，收敛 if/else |
| Adapter | ✅ 采用 | Tauri、Win32、外部 Agent/MCP/CLI、跨端通信 | 外部技术不污染业务域 |
| Registry | ✅ 复用已有 | Feature/Agent/插件/工具/导航/工作流节点 | 复用 `featureRegistry` 理念，合并概念相近的注册表 |
| State Machine | ✅ 采用 | 文件操作、配对、投屏、工作流、Agent 执行、备份恢复、移动同步、启动 | 复杂状态禁用 Boolean 拼接 |
| Observer/Event | ⚠ 受限采用 | 跨模块通知、后台完成 | 事件有类型/版本/释放；高频合并；禁全局 EventBus 耦合 |
| Command | ⚠ 评估 | 文件删除/移动/复制/恢复为可追踪操作对象 | 渐进，不为普通 CRUD 引入 |
| Decorator | ⚠ 采用 | 日志/性能/错误归一化/超时/重试横切 | 统一横切，避免每方法重复 |
| CQRS | ❌ 拒绝（当前） | 仅统计聚合可评估 | 不为 CRUD 造读写模型 |
| Outbox | ✅ 已是事实 | 移动同步（已实现 outbox 表+三态补丁） | 保持并文档化，桌面侧评估 |

---

## 11. 风险清单 & 需其他 Agent 配合的文件所有权调整

### 11.1 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 重构触碰在途文件 | 覆盖他人工作 | 文件所有权登记；交集暂停并报告 |
| bridge/lib/db 拆分改变公开接口 | 全项目编译失败 | Facade + re-export，公开符号零变化 |
| 迁移文件化改动 `MIGRATIONS` | 用户库升级失败/数据丢失 | 版本与顺序红线；隔离测试库回放；备份恢复验证 |
| 错误码统一 | 前端错误提示错乱 | 码集兼容映射；契约测试 |
| 删除平行源码树 | 误删在途功能 | 所有权未确认前禁止删除；先归档证据 |
| 全局状态/事件重构 | 隐藏窗口后台行为变化 | 逐模块，保留 `__reset*ForTests`，真机回归 |

### 11.2 文件所有权调整请求（需主 Agent 协调）

1. **`src-tauri/components/`、`src-tauri/boot/`、`src-tauri/src/personal_hub/`、`src-tauri/src/bin/taskdock-personal-hub.rs`**：确认是否 personal-hub 任务在途。若是，指定唯一所有者，完成后由所有者归档/删除；治理线不得触碰。
2. **`src/lib/bridge.ts`、`src-tauri/src/lib.rs`、`src-tauri/src/db/mod.rs`**：声明为**共享枢纽文件**，Phase 3 重构期间设唯一所有者串行写入，禁止多 Agent 并行改。
3. **`README.md`**：文档漂移修正由主 Agent 统一执行，避免与其他文档任务冲突。
4. **files-workspace / boot / workspace 三组在途文件**：本次治理完全避开；若后续重构涉及其依赖的 bridge 命令，先与其所有者协调。

---

## 12. 审计结论

| 结论项 | 结果 |
|---|---|
| 审计范围完成度 | 完成（四端 + 基础设施全覆盖） |
| 业务代码改动 | 无 |
| 在途工作触碰 | 无 |
| 事实纠错 | 2 处（迁移 v78 非 v58；README v33/43 表失实） |
| 下一步门禁 | Phase 1 架构方案完成后需一次架构评审，评审通过再进 Phase 2/3 |
| 结论 | **通过**（Phase 0 事实基线已建立，可支撑后续决策） |

> 所有结论均可复现：命令与实测输出见本文各节证据路径。未执行真机/性能验证的项目已明确标注，不用历史结果冒充。
