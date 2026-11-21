# AGENTS.md — Task Dock 开发协作规范

本文件只保留每次任务必需的约束；操作步骤按任务读取。子目录 `AGENTS.md` 在自身路径下优先。
事实优先级：代码与可复现输出 > 测试/真机证据 > 文档；偏差按本次范围修正文档或登记。

## 1. 项目定位、开工检查与按任务加载

Windows 桌面任务/启动器/Agent 监控中枢：Tauri 2 + Rust、React + TypeScript + Vite + Zustand、SQLite；
Android 客户端见 [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md)。产品介绍见 [README.md](README.md)。

开工：`git status --short` + 检查暂存区 → 明确写入范围 → 按下表读取相关章节及源码/测试。
未提交/未跟踪改动默认属于其他任务。**不要默认通读 README、架构、开发、测试、规划与历史报告**；
较大任务先定位相关需求、架构、ADR、已知问题，再读取命中章节，不跳过模块安全与兼容边界。

| 任务 | 必读入口（只读相关章节；不递归展开所有链接） |
|---|---|
| 普通代码修改 | 本文件 + 相关源码/测试；文档不明时查 [文档索引](docs/README.md) |
| Rust / Tauri / IPC / 数据库 | [ARCHITECTURE](docs/ARCHITECTURE.md) 对应模块/安全/数据模型；[DEVELOPMENT](docs/DEVELOPMENT.md) 对应命令/规范 |
| Dev 功能验收 | [DEVELOPMENT §2.3](docs/DEVELOPMENT.md#23-dev-功能验收操作规范)；[验收路由](docs/ACCEPTANCE_ROUTING.md) 对应通道 |
| Release 交付 / 集成 / 安装包 | [INTEGRATION_BUILD](docs/INTEGRATION_BUILD.md) 对应阶段 |
| 并行 / Worktree / 缓存与磁盘 | 本文件 §3、§5；[DEVELOPMENT](docs/DEVELOPMENT.md) 第七/八章相关小节 |
| UI / 交互 / 弹层 | 本文件 §6；[ui-themes](docs/ui-themes/01-design-spec.md)、[Skill 路由](docs/AGENT_SKILL_ROUTING.md) 相关条目 |
| 新增页面 / 加载与生命周期 | [ON_DEMAND_LOADING](docs/ON_DEMAND_LOADING.md) §9 及对应策略 |
| Agent 接入 / 导航 | [AGENT_ADAPTERS](docs/AGENT_ADAPTERS.md)、[覆盖矩阵](AGENT_COVERAGE_MATRIX.md)、[导航矩阵](APP_NAVIGATION_MATRIX.md) 对应来源 |
| 战略 / 功能架构规划 | [战略](docs/AGENT_ERA_STRATEGY.md) + [事实核对](docs/AGENT_ERA_STRATEGY_FACTCHECK.md)；区分 Proposed 与 Accepted |
| Android | `apps/mobile/AGENTS.md` + [mobile 索引](docs/mobile/README.md) 对应专题 |

## 2. 基本开发原则

- 简体中文；先读实际代码与测试，保留既有注释/文案语言。关键需求不清先问，非关键假设说明后执行。
- 最小改动，不顺手重构、清理、升级或加依赖。保持架构与公开契约兼容；破坏性变更先说明影响、迁移和回退。
- 优先修根因，不用 `setTimeout`、重试或吞异常掩盖问题；必要兜底说明根因层为何不能解决。
- 不伪造结果：未执行写「未执行」，阻塞写 `ENVIRONMENT BLOCKED`，证据不足如实说明。
- 检查通过后立即只提交本任务改动：精确路径 `git add` → 复核 `git diff --cached` → `git commit`。
  不提交他人改动、产物、数据库或证据日志；交付提交需可追溯，不 push、不打标签、不改分支。

## 3. 多 Agent 并行、Git 安全与统一集成

### 3.1 并行与隔离判定

独立文件共享工作区；同文件指定唯一所有者串行或按需 Worktree；公共契约先定负责人、顺序和兼容边界。
跨模块、耗时长、Agent 数量本身不是隔离理由。稳定安装包只从集成快照生成。

### 3.2 共享工作区安全边界

- 开工/交付检查 Git，编辑前后复核暂存区；不还原、删除、覆盖、代交他人改动，不清理他人缓存/证据。
- 禁止 `git clean`、`reset --hard`、`checkout -- <path>`、`restore <path>`、`add .`、`add -A`、`commit -a`；
  不自行 merge/rebase、切换/创建分支、改 Git 配置或清理暂存区。
- 默认禁止 stash；确需使用须路径全部属于本任务、无人使用并获授权，仅可
  `git stash push -u -m <唯一标签> -- <精确路径>`，恢复前复核。
- 目录所有权不等于永久独占；写入交集立即协调。同文件先读双方 diff，不整文件覆盖；不能安全合并则停止冲突部分。
- 共享枢纽（bridge、navigationRegistry、featureCatalog、useUiStore、Rust lib/commands/db、全局样式、
  i18n、依赖/构建配置、迁移/版本）同时写必须唯一所有者串行；越界先重新分配。
- 外部定时提交可能含在途改动，`main`/工作区不代表完成集合；不要用其替代集成快照。

### 3.3 任务状态与交付

交付提供任务/模块、写入范围、改动、实际检查、遗留问题、公共接口/依赖、交付提交。
统一台账用 `npm run integrate -- task add|verify|ready`，详见 [交付规则](docs/INTEGRATION_BUILD.md)。
`task verify` 必须在隔离工作区真实执行指定提交；`task check` 无证据不能代替，禁止手改台账 JSON。
`ready` 仅代表待集成，不自动出包；额外声明路径会真实进入快照并参与冲突判定。

### 3.4 集成、构建与验收职责

Dev 功能验收不推进 Release 状态机、不生成 `buildId`。Release 才走
`task ready → snapshot create → build → accept`，按同一 `buildId` 分任务留证；返工后新提交重新验证。
快照只集成已 ready 的声明路径，静态检查用 `typecheck`；不把旧通过结论复制到新版本。
职责、批次、记录字段与失败处理归 [INTEGRATION_BUILD](docs/INTEGRATION_BUILD.md)，执行该阶段前必读。

### 3.5 Worktree（按需隔离）

走 `scripts/worktree-guard.mjs`，清理默认 dry-run；操作前读 [DEVELOPMENT 第八章](docs/DEVELOPMENT.md)。
工具自有的 integration / integration-build / integration-verify 工作区不可手工开发/验收，必须有有效身份记录；
异常保留现场，不重建、删除、reset/clean 或切分支，旧工作区按手册非破坏 adopt。

## 4. 架构与数据安全红线

以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 为准，以下不可破坏：
1. **分层**：UI 不直接访问数据库，React 不直接调用 Win32。
2. **IPC**：业务 IPC 统一经 `src/lib/bridge.ts`，导航经 `src/lib/navigation.ts`；参数 camelCase，
   新增命令同步前端类型与 Rust 签名。
3. **SQLite**：只在 `src-tauri/src/db/mod.rs` 的 `MIGRATIONS` 末尾追加，不改已发布迁移；新设置项
   同步 `db::Settings`/`ALLOWED_KEYS`；新表登记 `BACKUP_TABLES`。
4. **Agent 管线**：事件必须进入 `agents/pipeline.rs` 有界管线；waiting/failed/completed 不得合并
   或静默丢弃，过载返回可重试错误；`origin` 由服务端判定；禁止无界队列、同步阻塞写库、事务内广播。
5. **剪贴板**：Win32 访问只在 `clipboard/platform.rs`；三线程 + 有界队列且丢弃必须计数；
   `ACCESS_LOCK` 串行化、锁内比较后才写入，绝不覆盖用户新复制；配置 fail-closed；日志与事件
   不记录正文、完整图片、文件路径或密钥。
6. **窗口与多显示器**：保留贴边吸附、位置恢复、DPI 换算与多显示器收敛；保存矩形前验证可见性；
   HWND/PID 只作运行时身份，绝不落库。
7. **UI Token**：预设/明暗/材质正交并落到 `html[data-preset|data-theme|data-material]`；只用语义
   Token（`styles-themes.css`/`styles-ui.css`）；不写原生 `<select>`、裸 `z-index`，不绕过统一
   组件层与 overlay 栈。
8. **异步生命周期**：后台任务、轮询、订阅、定时器必须可取消、有超时、有上限、可回收；不留重复
   监听器或永不停止的轮询。
9. **兼容性**：DB schema、备份 manifest 版本、命令签名、设置键是公开契约；变更必须说明兼容范围、
   迁移方式与旧数据/旧备份处理结果。
10. **按需加载**：页面代码必须经 `featureRegistry` 登记并由 `FeatureView` 首次可见时加载，
    **禁止**在导航/外壳里静态 import 页面组件；新增功能必须按
    [docs/ON_DEMAND_LOADING.md](docs/ON_DEMAND_LOADING.md) §9 回答「代码/数据/服务何时初始化、
    离开后如何处理、资源谁释放、是否允许预加载」。隐藏入口不得等于停止常驻服务。

## 5. 构建、测试与验收

### 5.1 构建执行

命令直接执行，调度器与 `sched*` 已移除；`:raw` 为兼容别名。先定向检查，必要时扩大。
协调 Cargo target、dist、端口与资源，不终止他人进程；失败按实际退出码记录，不自动重试。
Cargo 在 `src-tauri/` 内执行（`npm run cargo -- <参数>`）；`cargo test` 需要 `dist/`。
命令归 [DEVELOPMENT 第二章](docs/DEVELOPMENT.md)，定义以 `package.json`/对应脚本为准。

### 5.2 统一构建与安装包

正式包只用 `npm run integrate -- build --snapshot <快照> --platform <平台>`。
先 `integrate:status` / `batch plan`，对齐快照提交、累计任务和当前交付提交；缺目标代码不能复用旧包。
同提交/平台/配置/架构/输入指纹成功产物校验后复用，默认合批；构建前必读
[INTEGRATION_BUILD](docs/INTEGRATION_BUILD.md) 的快照、依赖、缓存登记、构建记录及验收准入规则。
临时工作树包必须明示，不能作为正式验收或复用依据；dirty/零产物不能记成功。
不以 `cargo build --release` 替代 Tauri 发布验收；安装/升级/卸载须授权。

### 5.3 磁盘、命令与证据

- 构建前磁盘预检（`npm run tauri` 自动执行），不足停止并 report；独立 `CARGO_TARGET_DIR` 用绝对路径、
  `target-*` 命名并 register；回收依 [DEVELOPMENT 第七/八章](docs/DEVELOPMENT.md)，不自行清理他人数据。
- 证据含命令、工作目录、时间、退出码和路径；ignored 不算通过。性能须附二进制 SHA256、构建模式、
  工具链、隔离数据、样本数、机器空闲状态、p50/p95，不能短采样宣称无泄漏。
- 真实窗口/通知/剪贴板/焦点/DPI/多屏/吸附须原生真机；jsdom、浏览器/CDP 不能证明 Win32/DWM 效果。
  视觉走查用 `scripts/serve-preview.mjs`。按 [ACCEPTANCE_ROUTING](docs/ACCEPTANCE_ROUTING.md) 选通道。
- CDP 只连 `127.0.0.1`，优先低干扰；物理操作最后使用，移动光标/抢前台/操作他应用先获授权。
  环境失败单列 `ENVIRONMENT BLOCKED`，不标通过、不臆断代码缺陷，同条件复跑保留记录。

### 5.4 两种验收模式

#### 5.4.1 A. Dev 功能验收（默认）

普通功能用真实 `npm run tauri dev`，按 [DEVELOPMENT §2.3](docs/DEVELOPMENT.md#23-dev-功能验收操作规范)
执行隔离、实例版本核对与取证，记录进 `tmp/acceptance/<task-name>/`。
只写「Dev 功能验收通过 / 部分通过 / 不通过 / 证据不足」，不调用 snapshot/build/accept、不改正式状态机。
Debug 不能证明正式性能、安装包、升级/卸载、签名/更新或生产资源加载。

#### 5.4.2 B. Release 正式验收

仅 Release 专属需求走 §5.2；结论绑定含当前任务代码的 `buildId`，操作及证据见集成手册。

#### 5.4.3 Dev 实例使用纪律

启动前查已有进程；dev-launch 发现实例时只唤醒退出，**不会重编译**。前端优先 HMR，Rust 核对编译/重启日志；
仅正常关闭本会话实例。必须隔离 `TASK_DOCK_DATA_DIR=tmp/debug/<task-name>/`，必要时隔离 WebView2 缓存。
共享实例由主/指定 Agent 管理；第二实例需独立 Worktree、端口、数据与输出目录，避免 Vite 1420 冲突。

## 6. UI/UX 与 Skill 路由

- 复用 `src/components/ui/` 与语义 Token，不新增平行组件或硬编码颜色/圆角/阴影。
- 新弹层接入 `overlayStack.ts`，一次按键关一层；图标按钮有 `aria-label`，提示用 `data-tip`，不用 `title`。
- 检查明暗/两套预设、320/400 窄窗、DPI、长文本、遮挡、焦点/键盘/Escape；轻量动画尊重 reduced-motion。
- 轮询/订阅不重复，隐藏/恢复不重复全量刷新，高频 IPC 合并/节流，取消/异常/超时后资源释放、状态正确。

### 6.1 前端 Skill 路由

只按任务加载适用 Skill 并实际读取，不凭名称宣称使用；具体清单与现代 Web 指南查询规则统一维护在
[AGENT_SKILL_ROUTING](docs/AGENT_SKILL_ROUTING.md)（前端指南见 §6）。项目 Token、组件、已确认参考图优先。

### 6.2 弹层定位（强制）

普通菜单/下拉/面板复用 `Popover` 及适配器，右键菜单复用 `PointerMenu`；不在业务页自算边界或固定偏移补洞。
默认 side/alignment 写在组件内；尺寸走 `minWidth/maxWidth/maxHeight` + `constrainPopupSize`，不能用 CSS 最小宽压过最大宽。
`positionOverride` / `flipToSide={false}` / `layer={null}` 仅提示条专用；`trapFocus={false}` 仅焦点需留原控件时使用。
特殊定位须登记业务理由并有测试。详细参数与测试要求见
[定位规范](docs/architecture/ui/global-popup-positioning-standard.md)；改定位前必读，现状见
[分类审计](docs/architecture/ui/global-popup-positioning-audit.md)。改后运行 positioning、Popover.edge、PointerMenu
及受影响组件测试，几何断言不能只看 CSS 类名。

## 7. 文档、验收产物与交付

- 文档归属与局部读取方法见 [docs/README.md](docs/README.md)。行为/接口/数据变化同步原归属文档，说明原因、
  兼容/迁移及实际验证；不靠验收报告代替规范，不新增重复手册。重要架构取舍记 `docs/adr/`。
- 当前规则与历史证据分开；更正历史结论保留原记录并标注更正，不在当前规范无限追加任务流水。
- 临时产物进 `tmp/acceptance|debug|experiments/<task-name>/`（短横线英文）；台账在 `tmp/integration/`。
  正式证据归档 `docs/` 并更新归属索引，不迁移/覆盖/删除历史资料，根目录不新增零散验收文件。
- 验收报告字段、Dev/Release 证据与分级按 [ACCEPTANCE_ROUTING §六–九](docs/ACCEPTANCE_ROUTING.md)；
  须含范围/依据、问题现象/根因/影响/证据、修改位置、命令/工作目录/退出码、已验/未验及原因、风险与结论。
  P0 数据丢失/泄露/崩溃/核心不可用；P1 主要功能或严重仓库/数据风险；P2 边界/次要错误/文档偏差；P3 低风险体验/格式。
- 不提交用户数据库、剪贴板正文/图片、密钥/令牌、个人路径或敏感日志；证据保留脱敏可复核元数据。
- 交付前检查文档影响、精确路径提交、暂存区与剩余工作树、敏感数据及证据；汇报修改、验证与未覆盖项、
  文档同步、残余风险、证据/产物路径与提交哈希。仅文档修改执行链接/规则检查，无需启动应用或打包。
