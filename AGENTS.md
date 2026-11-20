# AGENTS.md — Task Dock 开发协作规范

本文件是所有开发 Agent 的**入口规范**：只写「必须遵守什么」与路由，「具体怎么做」见专项文档。
子目录 `AGENTS.md`（目前只有 `apps/mobile/`）在自身路径下优先，未覆盖的仍按本文件。

**事实优先级**：代码与可复现输出 > 测试/真机证据（命令、时间、退出码、证据路径）> 文档。文档
与代码冲突以代码为准；发现偏差更新文档，超出本次范围写入验收报告。

## 1. 项目定位、开工检查与按任务加载

Task Dock 是 Windows 桌面任务/启动器/Agent 监控中枢：Tauri 2 + Rust（`src-tauri/`）、React +
TypeScript + Vite + Zustand（`src/`）、SQLite；Android 客户端 `apps/mobile/` 以本地 SQLite
为主，支持用户显式发起的局域网配对、手动与前台自动同步、文件互传（TLS-only + SPKI 指纹固定）。能力与
状态见 [README.md](README.md)。

**开工必做**：1）读本文件（改移动端同读其 `AGENTS.md`）；2）`git status`——本仓库多会话共享
同一工作树，**未提交/未跟踪改动默认属于其他任务**，不还原、不删除、不覆盖、不代为提交；
3）按任务查表并**实际读取**对应文档与相关代码/测试/迁移/命令定义。不求通读手册，但涉及某模块时
不得跳过其安全与兼容边界。

| 任务类型 | 按需阅读 |
|---|---|
| 通用代码修改 | 本文件 + 相关源码与测试 |
| Rust / Tauri / IPC / 数据库 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 对应章节 + [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| 移动端（Android） | [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md) + [docs/mobile/](docs/mobile/) |
| 多 Agent 并行 / Worktree 隔离 | 本文件第 3 节 + [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第八章 |
| 任务交付 / 统一集成 / 统一构建 / 联合验收 | 本文件 §3.3–3.4、§5.2 + [docs/INTEGRATION_BUILD.md](docs/INTEGRATION_BUILD.md) |
| 并发构建与命令执行 | 本文件 5.1 + [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §7.8 |
| 构建产物、缓存、磁盘 | 本文件 5.3 + [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第七章 |
| 测试、验收、真机、性能 | [docs/TESTING.md](docs/TESTING.md)、[docs/ACCEPTANCE_ROUTING.md](docs/ACCEPTANCE_ROUTING.md)、`docs/PERFORMANCE_*.md` |
| 日常功能验证 / Dev 验收 | 本文件 §5.4（两种验收模式）+ [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第二章（命令与 Dev 验收操作规范） |
| UI/UX、视觉 | 本文件第 6 节 + [docs/ui-themes/](docs/ui-themes/) + [docs/AGENT_SKILL_ROUTING.md](docs/AGENT_SKILL_ROUTING.md) |
| 新增页面 / 页面加载 / 启动体积 | [docs/ON_DEMAND_LOADING.md](docs/ON_DEMAND_LOADING.md)（四层架构、生命周期、策略矩阵、检查清单） |
| Agent 接入、导航 | [docs/AGENT_ADAPTERS.md](docs/AGENT_ADAPTERS.md)、[AGENT_COVERAGE_MATRIX.md](AGENT_COVERAGE_MATRIX.md)、[APP_NAVIGATION_MATRIX.md](APP_NAVIGATION_MATRIX.md) |
| Agent 时代产品战略、功能架构规划 | [docs/AGENT_ERA_STRATEGY.md](docs/AGENT_ERA_STRATEGY.md)（定位、边界、阶段轴 S0–S6、功能矩阵）+ [docs/AGENT_ERA_STRATEGY_FACTCHECK.md](docs/AGENT_ERA_STRATEGY_FACTCHECK.md)（事实核对与偏差） |

链接不会自动加载，执行对应任务时必须实际读取；本规范不依赖特定 Agent 工具。

## 2. 基本开发原则
- 默认简体中文；先读实际代码与测试，不凭记忆或文档臆断；既有注释与文案保持原语言风格。
- **范围最小**：只改必需代码，不顺手清理、不扩大重构、不整文件格式化、不擅自升级或引入依赖；
  保持架构与公开 API 兼容，破坏性变更先说明影响面、迁移方案与回退路径。
- **改完即提交**：完成代码修改并通过本任务检查后，立即提交自己的改动——只 `git add` 本任务实际
  改动的精确路径，复核 `git diff --cached` 后 `git commit`，提交信息写明任务与改动要点。不提交
  他人改动、构建产物、数据库或证据日志；不 `push`、不打标签、不改分支。交付时的「交付提交」
  就是这次提交，后续 `task verify` / `task ready` 一律引用它。
- 优先修根因，不用 `setTimeout`、重试、吞异常兜底；确需兜底说明根因层为何无法解决。
- **不得伪造测试结果、真机验证、性能数据或截图**：未执行写「未执行」，环境阻塞写
  `ENVIRONMENT BLOCKED`，证据不足写「证据不足」，不用「应该/理论上」代替证据。
- 非关键细节可判断并记录假设，关键需求不明先问；范围外问题写入报告，不擅自修复。

## 3. 多 Agent 并行、Git 安全与统一集成

总原则：**共享工作区优先、文件所有权优先、Worktree 按需使用、验收 Dev-First、交付与正式验收走
统一集成线**。并行本身不是创建 Worktree 的理由；是否隔离取决于写入范围、共享资源与 Git 状态风险。
「Agent 声称完成」不等于「已集成」；**只有集成快照可以生成正式测试安装包**（§5.2）。
**日常功能验证不需要安装包**——默认在 Dev 实例上验收（§5.4.1）。

### 3.1 并行与隔离判定（四类情况）

| 情况 | 处理 |
|---|---|
| A 完全独立文件/模块 | 共享工作区并行；文件所有权明确、不互相覆盖 |
| B 可能同时改同一文件 | 独立 Worktree，或指定唯一所有者后串行写入 |
| C 改公共配置/全局类型/共享架构 | 先定负责人、顺序与兼容边界（必要时 Worktree），由主 Agent 协调 |
| D 他人仍在开发，但要出稳定安装包 | **从已集成快照构建**（`integration` 分支的提交），不得直接打包共享工作区 |

- 工作区里的 Git 暂存区、工作树状态、依赖目录、构建产物同样共享：即使改动不重叠，也必须避免
  误提交、误清理与构建期文件竞争（判据与检查清单见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §8.10）。
- **跨模块**「耗时长」「Agent 数量 > 1」都不是必须隔离的理由；**Worktree 不自动解决冲突**。

### 3.2 共享工作区安全边界

- 开工前、交付前各 `git status`；编辑前后复核暂存区；只提交自己的改动（§2），不自动 push/
  打标签/改分支/强制推送/改 Git 配置；禁止 `git clean`、`git reset --hard`、
  `git checkout -- <path>`、`git restore <path>`。
- **默认禁止 Git stash**：禁止裸 `git stash`、无路径限制的 `push`/`push -u`；不得 stash 他人
  修改或未跟踪文件。确需暂存须确认路径完全属于本任务、无其他 Agent 使用并取得授权，执行
  `git stash push -u -m <唯一标签> -- <精确路径>`，恢复前复核；归属无法确认即停止并交主 Agent。
- 不用 `git add -A`/`git add .`/`git commit -a`；按精确路径暂存并复核，防止带入构建产物、
  数据库或证据日志。同一文件被并行修改：先读双方 diff 再合并，不整文件覆盖，无法安全合并时停止。
- **各任务提交自己的改动**：每个 Agent 改完代码后立即按精确路径 add + commit 自己拥有的文件
  （§2），不承担他人改动的提交；不执行 stash/merge/rebase、不切换或创建分支、不清理暂存区。
  共享枢纽文件的并发写入仍按「唯一所有者串行」执行，提交范围与写入范围不一致时停止并交主
  Agent 协调；跨模块集成仍由主 Agent 负责，不因此绕过快照与统一集成线（§3.3–3.4）。
- **目录所有权≠目录下全部文件的永久独占**；写入集合出现交集立即重新协调，交集文件按「唯一
  所有者」处理。共享枢纽文件（`src/lib/bridge.ts`、`navigationRegistry.ts`、`featureCatalog.ts`、
  `useUiStore.ts`、`src-tauri/src/lib.rs`、`commands/mod.rs`、`db/mod.rs`、全局样式与主题 Token、
  i18n、依赖与构建配置、数据库迁移与版本定义）可同时读，**同时写必须由唯一所有者串行**。
- 需改未授权文件：不越界 → 说明文件与原因 → 主 Agent 重分配或亲自集成 → 继续无冲突部分。
  越界写入、覆盖他人改动、自行清理缓存均视为事故。
- 不覆盖他人日志、截图、验收报告；新证据用含日期独立文件名；应清理项只列路径、体量与建议命令。
- **外部定时提交**（`chore: 定时提交 …（N 个文件）`，非本仓库脚本产生）会把在途改动整体写进
  历史，因此**不能用 `main` 的提交或当前工作区来判断「哪些任务已完成」**——那是集成快照的职责。

### 3.3 任务状态与交付

**两种验收模式（Dev-First）**：本项目的验收分「Dev 功能验收」与「Release 正式验收」两套，
**默认走 Dev 功能验收**，普通功能开发不必等安装包。

| 模式 | 运行环境 | 结论落点 | 推进任务状态机 |
|---|---|---|---|
| **A. Dev 功能验收** | `npm run tauri dev`（真实 Tauri Debug 桌面应用，非 Mock、非浏览器预览） | `tmp/acceptance/<task-name>/` 独立记录 | **否**——不改 `verifying` / `accept-passed` / `accept-failed`，不生成 `buildId` |
| **B. Release 正式验收** | Integration Snapshot 产出的安装包 | `npm run integrate -- accept --build <buildId> ...` | 是（按 §3.4 状态机推进） |

下表是**任务台账状态机**，服务于 Release 正式验收（`task add` → `ready` → `snapshot create`
→ `build` → `accept`）：

| 状态 | 含义 | 推进方式 |
|---|---|---|
| 开发中 | 正在改代码 | 负责人 `task add` / `task update` |
| 待集成 | 代码完成且模块级检查**真实执行**通过 | 负责人 `task ready`（需交付提交 + `task verify` 通过记录） |
| 已集成 | 改动进入快照提交 | 工具 `snapshot create` 成功 |
| 待验收 | 代码在可测产物中 | 工具 `build` 成功（一个构建可包含多个累计任务） |
| 验收通过 / 验收失败 | 在指定构建版本上的结论 | 验收 Agent `accept --status pass 或 fail`（按 `buildId` 各写记录） |

**Dev 功能验收与状态机解耦**：Dev 验收在共享工作区的开发实例上完成，**不调用** `snapshot create`
/ `build` / `accept`，**不修改**上述任何状态，**不伪造** `buildId`。它的结论只写进
`tmp/acceptance/<task-name>/`，标题只能写「Dev 功能验收通过 / 部分通过 / 不通过 / 证据不足」，
**不得**写成「Release 正式验收通过」。Dev 验收失败同样要回到 `developing` 修代码，修完重新走
`task ready → snapshot create → build → accept` 才能得到正式结论。

交付时必须提供：**任务标识与模块、写入范围、主要改动、实际执行的检查与结果、未解决问题、
是否改公共接口、是否需其他模块配合、交付提交（可追溯）**。用统一台账登记，不另建数据库：

```bash
npm run integrate -- task add --id <任务> --owner <agent> --module <模块> --paths <写入范围> \
  [--note "<主要改动/未解决问题>"] [--public-interface] [--needs <依赖任务>]
npm run integrate -- task verify --id <任务> --commit <提交> --cmd "<真实命令>"
npm run integrate -- task ready --id <任务> --commit <交付提交>
npm run integrate:status
npm run integrate -- batch plan --platform desktop   # 只读：查看下一验收批、阻塞、复用与建议
```

任务完成（`ready`）只代表可进入下一验收批次，**默认不立即触发正式安装包构建**。默认 `batch`
模式按 `min-ready`（默认 2）合批；`urgent` 用于阻塞性故障/安全修复，`manual` 用于人工指定任务或
固定快照。`batch plan` 不写台账、不加锁、不构建，正式构建仍走 `build --snapshot`。
**`task ready` 之前不必先出安装包**：模块级检查与功能验证可以先在 Dev 实例上做（见 §5.4 的
Dev 验收流程）；`task verify` 仍要求在隔离工作区对该交付提交**真实执行**命令，二者不是一回事。
写入范围是集成与冲突判定的唯一依据：交付提交里出现未声明路径会被拒绝（防串味）；确属本任务时
用 `--allow-extra-paths` 显式放行，**这些路径会一并进入快照、参与交集判定**并记入
`includedExtraPaths`，不是“只记录不应用”。**`task verify` 才是在隔离工作区对指定提交真实执行检查**；
`task check` 只是 `source=external` 的人工登记，无证据不能作为正式集成资格。`task ready` 只认同一
交付提交上的真实执行（或带证据的外部）通过记录。任务台账按任务加锁并带修订号，禁止绕过工具手改 JSON。

### 3.4 集成、构建与验收职责

- **开发与 Dev 功能验收（任务负责人 / 各任务 Agent）**：日常功能改动默认在 Dev 实例
  （`npm run tauri dev`）上验证，证据写入 `tmp/acceptance/<task-name>/`；Dev 验收**不产生**
  `buildId`、**不推进**任务状态机。Dev 验收通过只说明「该功能在当前代码与隔离数据目录下按预期
  工作」，**不构成**安装包、升级/卸载、生产资源加载或正式性能结论。
- **集成（主 Agent / 集成负责人）**：只把「待集成」任务的声明路径改动叠加到 `integration` 分支，
  生成带 `TaskDock-Snapshot/Tasks` 提交信息的快照；检查交集、越界、冲突，执行集成静态检查
  （类型检查 `npm run typecheck`，不重复 Vite 打包）。不等待未完成任务；已完成任务按批次集成。
  失败时快照工作区回到基线，日志与台账记录保留供复现，不会把半个补丁留在工作区。
- **构建（集成负责人）**：**只有快照提交能出正式测试安装包**；在独立的干净构建工作区直接执行，桌面与移动端分别构建；同一「提交+平台+配置+依赖/工具链指纹」复用已有产物，不因第二个
  Agent 要验收重打。默认按 `batch` 合批，任务刚 `ready` 不自动出包；`build` 记录 `mode`、累计
  `includedTasks`、失败分类与资源快照，失败不自动重试。
- **Release 正式验收（各任务 Agent + 集成验收 Agent）**：仅在需要 Release 专属结论时执行——安装包
  生成、安装/升级/卸载、签名与更新机制、生产环境资源加载、Release 专属行为、正式性能基线与正式
  交付版本。多 Agent 可基于**同一 `buildId`** 并行验收各自模块，
  各写自己的验收记录（不改他人结论），记录以 `buildId + taskId` 保留 revision/history；
  只要任务代码仍在构建的累计 `includedTasks` 中，旧任务可在包含其代码的新构建上首次/回归验收；
  历史通过结论不能自动复制成新版本通过。跨模块链路与回归由集成验收 Agent 负责。
  并行验收的共享资源（同一窗口/实例、手机、剪贴板、CDP 端口、数据库目录）按
  [docs/ACCEPTANCE_ROUTING.md](docs/ACCEPTANCE_ROUTING.md) §5.4–5.5 串行或隔离。
- **验收失败**：记录构建版本、现象与复现 → 负责人修复 → 新交付提交 → 下一个快照与构建 →
  定向复测 + 受影响链路回归。**不得用旧版本的通过结论证明新版本通过**。Dev 验收失败先在 Dev 上修复
  并重做 Dev 验收，再走正式验收流程。
- 命令、状态机、记录字段、构建平台与复用规则、清理方式见
  [docs/INTEGRATION_BUILD.md](docs/INTEGRATION_BUILD.md)。

### 3.5 Worktree（按需隔离）

- 创建/状态/冲突预检/安全清理统一走 `scripts/worktree-guard.mjs`（`npm run worktree:*`）；
  `create` 只在 3.1 判定需要隔离后执行，`cleanup` 默认 dry-run，`--execute` 的准入见
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §8.7。
- 工具不自动创建/提交/合并/删除；异常保留现场上报，冲突先读双方 diff，无法安全合并时停止。
- 集成、构建与真实检查使用工具自有的三个工作区：`<仓库父目录>/<仓库名>-integration`（分支
  `integration`，只做快照）、`<仓库父目录>/<仓库名>-integration-build`（detached HEAD，只做构建）、
  `<仓库父目录>/<仓库名>-integration-verify`（detached HEAD，只做 `task verify`）。每个工作区必须有
  `tmp/integration/worktrees/<role>.json` 身份记录；缺记录/被改/指向其他仓库/被普通 Agent Worktree
  占用时工具拒绝操作，**不重建、不删除、不 reset/clean、不切分支**。旧工作区先 `worktree adopt --role ...`
  做非破坏登记。三者用独立锁，可并行；与 Agent 任务 Worktree 分开管理，不得手工用于开发或验收。

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

### 5.1 构建执行（2026-11-19）

- 按用户要求移除构建调度器；开发、测试、构建命令直接执行，不再排队、分配槽位或维护调度台账。
- 优先定向检查再全量；并行任务自行协调 CPU、磁盘、Cargo target、dist 与端口，避免共享输出竞争。
- `npm run cargo -- <参数>` 在 `src-tauri/` 内执行 Cargo；`npm run tauri` 保留磁盘预检与 Dev 实例复用。
- Vite 默认端口仍为 1420（strictPort）；第二个实例需独立端口、数据目录和输出目录。
- 不清理他人缓存，不终止他人进程；构建失败按真实子进程退出码与日志判断，不自动重试。
- `:raw` 命令保留为兼容别名，与普通入口执行相同工具；已删除 `sched*` 命令。

### 5.2 统一构建与安装包
- **正式测试安装包只从集成快照构建**：`npm run integrate -- build --snapshot <快照> --platform
  desktop|web|android`。共享工作区里的未提交改动、`main` 上更晚的提交都不进入产物。
- **构建不是日常开发的门槛**：普通功能验证在 Dev 实例上完成（§5.4），**不为每个普通功能出安装包**。
  只有需要 Release 专属结论（安装包生成、安装/升级/卸载、签名与更新、生产资源加载、正式性能基线、
  正式交付版本）时才走本节的正式构建流程；一次 Release 构建应尽量覆盖多个已完成任务。
- **构建前先对齐“最新代码”**：执行 `npm run integrate:status` 与 `batch plan`，在不违反批次和资源规则的
  前提下，把本轮所有已 `ready` / 待验收任务尽量纳入同一快照批次；核对快照 `commit`、`includedTasks` 与
  各任务当前交付提交。目标任务代码不在最新快照内时，先集成并生成新快照，**不得复用缺代码的旧快照或
  旧安装包**。正式包不以共享工作区未提交改动为准；确需从工作树打临时包时，必须在构建记录/验收报告中
  标注“临时工作树包，非正式集成包”，且不得作为正式验收、发布或后续复用依据。
- 每个「快照提交 + 平台 + 配置 + 架构 + 构建输入指纹」只构建一次；已有成功产物**重新校验**后才复用，
  不因不同 Agent 分别验收而重复打包。构建前先 `batch plan` 判断是否需要新构建；默认 `batch` 合批，
  不为单个普通任务自动出包。桌面端与移动端、不同架构/配置**不能视为同一个安装包**。
  构建依赖必须与快照代码一致（已存在 junction 也每次核对）；桌面缓存登记失败（build-guard register）
  必须阻止构建，不能产生无法追踪的大缓存。桌面 release 构建默认 `CARGO_BUILD_JOBS=2`，失败按
  `source/dependency/resource/environment/packaging/unknown` 分类；资源不足先等空闲/降并发，不无限重试。
- 构建记录必须含：构建 ID、Git commit（`dirty` 为构建前后实测，不得硬编码 false）、平台与配置、
  架构与构建输入指纹、时间、包含的任务（声明路径与显式放行的额外路径；`snapshotChain` /
  `includedTasks` 给出累计来源）、退出码、产物路径与 sha256、
  构建日志路径；`status=succeeded` 还必须
  至少有一个平台可用产物（web `dist/index.html`、桌面安装包、Android apk），零产物或 dirty 构建
  一律记失败。记录位置与字段见 [docs/INTEGRATION_BUILD.md](docs/INTEGRATION_BUILD.md) §5。
- 集成构建由 `taskdock-integration.mjs` 在 `<仓库>-integration-build` 直接执行；保留构建锁、
  commit/dirty 校验、产物 SHA256 与 `build.json`。不再生成调度 provenance；历史证据保留。
- 未构建/构建失败写「未执行」或失败记录，不得用历史产物冒充本轮结果；只有 `status=succeeded`
  且 `dirty=false` 的构建才能进入 `verifying`，`accept pass|fail` 还必须匹配任务当前交付提交
  并出现在该构建的累计 `includedTasks` 中（旧任务可在新构建上验收，返工未入构建时拒绝）。

### 5.3 磁盘、命令与证据
- 构建前检查磁盘与缓存（`npm run tauri` 自动 `build-guard precheck`），不足先停止并 `report`；
  隔离缓存用**绝对路径** `CARGO_TARGET_DIR`（`target-*` 命名）并 `build-guard register`，结束按
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第七/八章回收；不清理他人目录、发布产物、用户数据。
- 命令矩阵见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)、[docs/TESTING.md](docs/TESTING.md)：
  cargo 在 `src-tauri/` 内运行；`cargo test` 需要 `dist/`；不得用 `cargo build --release` 代替
  Tauri 发布验收；安装/升级/卸载未经授权不执行并写「未执行」。
- 结论必须可追溯：命令 + 工作目录 + 退出码 + 时间 + 证据路径；数字以当次输出为准；
  `#[ignore]` 的性能/真机套件不计为通过。
- **真实窗口、系统通知、系统剪贴板、前台焦点、DPI、多显示器、贴边吸附必须原生真机验收**；
  jsdom/单测/预览截图不能替代；视觉走查用 `scripts/serve-preview.mjs`。
- 验收按 [docs/ACCEPTANCE_ROUTING.md](docs/ACCEPTANCE_ROUTING.md) 的 A–F 通道选择；CDP 不证明
  Win32 裁剪、吸附手感、系统级命中、通知真实展示与桌面合成；物理操作仅作最后手段，移动光标/
  抢前台/操作他应用前取得授权；CDP 只连 `127.0.0.1`，默认低干扰，隔离实例用 `TASK_DOCK_DATA_DIR`。
- 性能结论必须附可复核条件（二进制 sha256、构建模式、工具链、数据目录隔离、样本数、机器空闲
  状态、p50/p95 与证据文件）；不得用单次短采样宣称「无泄漏」。
- 环境失败（锁屏、前台锁拒绝、权限不足、磁盘满）记 `ENVIRONMENT BLOCKED`，不标记通过，也不臆断
  为代码缺陷；同条件复跑结果一并保留。

### 5.4 两种验收模式：Dev 功能验收（默认） / Release 正式验收

**默认用 Dev 功能验收，不要每改一处就打包。**

#### 5.4.1 A. Dev 功能验收

- **适用**：UI 样式与布局、页面交互、组件功能、前后端 IPC、Rust 业务逻辑、SQLite 数据读写、
  普通桌面功能、普通原生窗口行为、模块级功能与跨模块业务链路。
- **默认命令**：`npm run tauri dev`（经 `scripts/dev-launch.mjs` 直接执行 Tauri CLI）。
  Dev 模式运行的是**真实的 Tauri Debug 桌面应用**（真实 WebView2、真实 SQLite、真实 IPC、
  真实 Win32 窗口），不是 Mock，也不是浏览器预览。
- **允许在 Dev 模式下完成模块功能验收**，真实运行结果可作为验收证据记录在
  `tmp/acceptance/<task-name>/`。
- **Dev 验收不碰正式状态机**：不调用 `snapshot create` / `build` / `accept`，不生成 `buildId`，
  不修改 `verifying` / `accept-passed` / `accept-failed`，不新建未经实现的状态。
  结论只写「Dev 功能验收通过 / 部分通过 / 不通过 / 证据不足」，**不能**写成「Release 正式验收通过」。
- **Dev 结论的边界**：Debug 构建未优化，**不能**给出性能、内存、动画流畅度、启动耗时等正式结论，
  也**不能**证明安装包生成、安装/升级/卸载、签名与更新、生产环境资源加载。这些必须走 §5.2 的
  Release 正式验收。

**Dev 验收标准流程**：

```
检查 Git 状态 → 确定任务修改范围 → 执行定向自动化测试 → 检查 Dev 实例是否运行
→ 设置独立数据目录 → 启动或复用 npm run tauri dev → 检查是否运行最新代码
→ 真实操作与业务链路验证 → 记录截图、日志与执行证据 → 输出 Dev 功能验收结论
→ （必要时）进入 Release 正式验收
```

**Dev 验收证据（每次至少记录）**：完整命令、工作目录、Git HEAD、Git dirty 状态与相关修改文件、
运行模式（Debug/Release）、实际运行的 exe 路径（必要时附 SHA256）、开始与结束时间、隔离数据目录、
实际操作步骤、可观察结果、截图或日志路径、未覆盖边界。不得伪造证据。

#### 5.4.2 B. Release 正式验收

- **适用**：安装包生成、安装/升级/卸载、签名与更新机制、生产环境资源加载、Release 专属行为、
  正式性能基线、内存/CPU/启动性能等正式结论、正式交付版本。
- **必须**使用 Integration Snapshot：
  `task ready → snapshot create → build → accept`，验收记录绑定 `buildId`。
- 其余机制（快照复用、多 Agent 共享同一 `buildId`、各写各的记录、修复后定向复测与回归、
  不得拿旧版本结论证明新版本）见 §3.4 与
  [docs/INTEGRATION_BUILD.md](docs/INTEGRATION_BUILD.md)。

#### 5.4.3 Dev 实例使用纪律

- **复用优先**：启动前先检查本仓库是否已有 Dev 实例在跑（可用 `Get-Process task-dock -ErrorAction SilentlyContinue` 核对进程路径）。
  `scripts/dev-launch.mjs` 探测到本仓库 `target/debug/task-dock.exe` 正在运行时，**只会唤醒该实例**
  （单实例回调聚焦工作台）并退出——**不会重新编译、不会启动第二个窗口**。因此：
  - **不要误以为再次执行 `npm run tauri dev` 一定会重新编译**；
  - 需要按新 Rust 代码重启时，**先正常关闭本会话自己的实例**，再重新执行 `npm run tauri dev`；
  - 前端改动优先用 Vite HMR；Rust 改动看 Tauri 的实际增量编译与重启日志，确认跑的是新代码再操作。
- **只操作本会话的实例**：不结束非本会话启动的进程；发现别的实例在跑时优先复用而不是再起一个。
- **独立数据目录**：Dev 实例必须用独立数据目录，`TASK_DOCK_DATA_DIR` 指向
  `tmp/debug/<task-name>/`（必要时 `WEBVIEW2_USER_DATA_FOLDER` 隔离 WebView2 缓存），
  避免读写用户数据或其他会话正在使用的数据目录。注意：未显式设置 `TASK_DOCK_DATA_DIR` 时，
  Debug 构建会自动使用 `%APPDATA%\com.taskdock.desktop\dev-instance` 作为开发实例目录；
  **显式设置时以显式值为准**，并据此派生独立的应用标识与单实例锁。
- **多 Agent 并行**：默认由主 Agent 或指定集成 Agent 管理共享的 Tauri Dev 实例，
  **不允许所有子 Agent 同时启动自己的 Dev 实例**造成端口/数据目录冲突。需要独立实例的 Agent
  必须使用独立 Worktree、数据目录和不冲突的端口，并遵守构建执行规范（§5.1）。
- 完整操作规范与命令对照见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第二章；
  验收通道对应关系见 [docs/ACCEPTANCE_ROUTING.md](docs/ACCEPTANCE_ROUTING.md)。

## 6. UI/UX 与 Skill 路由
- 复用 `src/components/ui/` 基元与语义 Token，不新增平行组件、不硬编码颜色/圆角/阴影；不产生重复
  输入框、弹层、事件监听，订阅逻辑确认引用计数。
- 新弹层接入 `src/lib/overlayStack.ts`，一次按键只关一层；图标按钮必须有 `aria-label`，提示统一
  `data-tip`（不用原生 `title`）；检查遮挡、溢出、焦点顺序、键盘与 Escape。
- 覆盖深/浅主题、两套视觉预设、320/400 窄窗与不同 DPI；长文本截断或换行而非撑破布局；动画轻量
  并尊重 `prefers-reduced-motion`，液态玻璃不得牺牲可读性与操作效率。
- 性能红线：轮询/订阅不重复，窗口隐藏/恢复不重复全量刷新；IPC 高频通信合并或节流；异常、取消、
  超时、强杀后状态正确；大事件/历史/图片下内存与 CPU 有平台期。
- **开发前按任务判断是否需要 Skill**：只加载适用项并实际读取 `SKILL.md`，不凭名称宣称已使用；
  **项目规范优先于 Skill**，Skill 不替代真机验收，不得另造设计语言或推翻已确认的参考图与 Token。

### 6.1 前端 Skill 路由（modern-web-guidance / chrome-extensions）

两个技能装在**用户级** `C:\Users\ASUS\.agents\skills\`，不提交进仓库；换机器缺失时退化为
`npx -y modern-web-guidance@latest search "<query>"`。上游 `description` 要求「所有 HTML/CSS 任务
MANDATORY 先查」并输出 `### Modern Web Guidance` 披露段，**本项目不采纳**：只在下列信号命中时检索，
单个任务检索 1–2 次为限，不写披露段（除非任务明确要求）。

| 任务信号（命中才检索） | `search` 查询示例 | 典型 guide id |
|---|---|---|
| dialog / modal / popover / tooltip / 抽屉、轻关闭、Esc 或点击遮罩关闭、焦点陷阱、滚动穿透、`inert` | `light dismiss dialog` | `dialog`、`light-dismiss-a-dialog` |
| 容器查询、`subgrid`、anchor positioning、320/400 窄窗、流式字号、`text-wrap` 平衡、安全区 | `container query card` | `css-layout`、`responsive-design` |
| view transitions、scroll-driven animation、入场/退场、视差、scroll snap、`prefers-reduced-motion` | `animate dialog top layer` | `motion`、`animate-to-from-top-layer` |
| 校验时机、`:user-invalid`、autofill、自定义 `<select>`、switch、range、自动伸缩输入框、IME 回车提交 | `validation after interaction` | `validate-input-after-interaction` |
| 深/浅主题、`light-dark()`、`color-mix()`、`oklch`、滚动条配色、`prefers-contrast`、强制色彩 | `dark mode scrollbar` | `dark-mode`、`color` |
| LCP / INP / CLS、`content-visibility`、`fetchpriority`、`scheduler.yield`、长任务拆分、预取预渲染 | `identify inp causes` | `identify-inp-causes` |
| aria 状态、屏幕阅读器、`focus-visible`、键盘可达、生成内容替代文本、OS 文字缩放 | `accessible error announcement` | `accessibility`、`accessible-error-announcement` |
| Trusted Types、HTML 消毒、SRI、passkey、客户端加密、Permissions Policy、本地网络访问 | `sanitize untrusted html` | `trusted-types`、`sanitize-untrusted-html` |
| Temporal、时区、DST、`Intl.DurationFormat`、非公历 | `timezone dst event` | `js`、`coordinate-global-events` |
| 自定义元素、Shadow DOM、声明式 Shadow DOM、表单关联元素、跨 shadow 样式 | `shadow dom slots` | `web-components`、`shadow-dom` |
| 浏览器内置 AI（Translator / Summarizer / LanguageModel / LanguageDetector） | `on device summarizer` | `summarizer`、`prompt-api` |
| Manifest V3、扩展 service worker、content script、消息传递、side panel、declarativeNetRequest、omnibox、userScripts、商店上架 | 无需 `search` | `chrome-extensions` 技能的 `references/extensions/*.md`、`references/webstore/*.md` |

- **调用方式**（离线本地 CLI，不依赖 npx 联网）：`$env:DISABLE_TELEMETRY="1"` 后执行
  `node <技能目录>\modern-web.mjs search "<2–5 词英文动作+组件名>"`，命中后
  `retrieve "<id>"`（可逗号传多个）。查询词不带框架名（React/Vue/Tailwind）与业务名词；
  一次说多个能力就拆多次 `search`；结果为空或弱相关时换同义词重试一次即放弃，不硬凑。
- `chrome-extensions` **无 CLI**，按需 `Read` 其 `references/extensions/<topic>.md`（约 2–9 KB/篇），
  不要把 20 篇一次性读进上下文。
- **优先级**：本节前四条（语义 Token / `overlayStack` / `data-tip` / 320·400 窄窗）与
  `docs/ui-themes/` 高于指南文本；指南只提供实现方式与兼容数据，不得据此推翻已确认 Token、另造
  组件层或绕过统一弹层栈。
- 本项目前端跑在 Tauri/WebView2：指南中**非 Baseline Widely available** 的特性必须按其 fallback
  要求实现，fallback 控制在 ≤50 行且不新增依赖；否则改用插件内的等价基线方案。
- 上述信号之外（后端 SQL/ORM/API 路由、CI·Docker、Python/Go、Vite·tsconfig·ESLint、纯改名与文案、
  纯 Rust/Tauri 后端侧、真机验收项）**不加载这两个技能**；真机与视觉验收仍按 §5.3 执行。

### 6.2 弹层定位（强制）

规范全文：[docs/architecture/ui/global-popup-positioning-standard.md](docs/architecture/ui/global-popup-positioning-standard.md)；
现状与分类：[global-popup-positioning-audit.md](docs/architecture/ui/global-popup-positioning-audit.md)。

1. **普通下拉/操作菜单/大型内容面板**必须复用 `Popover`（或 `Select` / `Combobox` /
   `DropdownMenu` / `DatePicker` 这些适配器），**右键菜单**必须复用 `PointerMenu`。
2. **禁止**业务页面自己写 `window.innerWidth/innerHeight`、`getBoundingClientRect` 做边界计算，
   禁止用固定 `left/right/top/bottom` 或固定 `transform` 偏移「修补」越界。
3. 新增弹层必须显式声明默认 `side` 与 `alignment`；靠右控件用 `end`，表单/列表用 `start`，
   需要按空间切换才用 `auto`。默认值写在组件里，不写在调用方。
4. `Popover` 的 `positionOverride` / `flipToSide={false}` / `layer={null}` 属于**提示条专用**，
   普通菜单不得使用；`PointerMenu` 的 `trapFocus={false}` 只用于「焦点必须留在原控件」的场景
   （如分割线比例菜单）。
5. 弹层尺寸约束统一走 `minWidth/maxWidth/maxHeight` + `constrainPopupSize`；不得在组件内
   用 CSS `min-width` 压过 `max-width` 制造越界。
6. 凡保留特殊定位（原生独立窗口、投屏工具栏、拖拽跟随层、模态居中）的组件，必须在规范文档
   「保留特殊实现」清单登记**业务理由**，并至少有对应测试。
7. 改动弹层定位后，必须运行 `src/components/ui/positioning.test.ts`、
   `Popover.edge.test.tsx`、`PointerMenu.test.tsx` 及受影响组件测试；几何断言不能只看 CSS 类名。

## 7. 文档、验收产物与交付
- 正式文档按模块归属维护（见第 1 节路由）；功能、接口或数据结构变化必须同步对应文档并说明兼容性
  与迁移要求，不能只写在验收报告里。
- 同一主题在原文档追加带日期记录，推翻历史结论时保留原文并标注更正；历史记录与当前规则分开表述。
- 任务产物进 `tmp/acceptance|debug|experiments/<task-name>/`（短横线英文，一任务一目录；`tmp/` 已
  gitignore）；集成台账在 `tmp/integration/`；仓库根不新增零散验收文件；正式证据归档 `docs/` 并
  更新索引，不迁移、覆盖或删除历史资料。
- **Dev 功能验收**的记录同样进 `tmp/acceptance/<task-name>/`，并注明运行模式（Debug/Release）、
  Git HEAD/dirty、隔离数据目录与实际命令；**Release 正式验收**的结论以
  `npm run integrate -- accept` 写入构建目录为准。两者结论必须分别标注，不得混写。
- 任务级报告 `tmp/acceptance/<task-name>/report.md` 必含：任务范围、检查依据、P0–P3 问题清单
  （现象/根因/影响/证据）、修改文件与关键位置、命令与结果（工作目录/退出码）、已验证/未验证项及
  原因、遗留风险、结论、真实证据路径。P0 数据丢失/安全泄露/崩溃/核心流程不可用；P1 主要功能错误
  或严重仓库/数据风险；P2 边界错误/次要缺陷/文档与实现不一致；P3 体验/格式/低风险改进。
  结论只用 **通过 / 部分通过 / 不通过 / 证据不足**；环境阻塞单列。
- **用户数据库、剪贴板正文/图片、密钥、令牌、个人路径、本机敏感日志不得写入可提交文件**；证据只
  保留类型、计数、耗时、退出码等可复核元数据，必要时脱敏。
- 交付前自检：本次改动已按精确路径提交，工作区剩余改动均属他人/其他任务；无敏感数据进入可提交
  文件；临时产物在任务目录；报告字段齐全；未推送或执行破坏性 Git 操作。交付时如实说明完成内容
  与范围、主要修改文件、根因与解决层、测试与构建结果、未验证项与残余风险、报告路径、产物位置与
  清理结果，并给出交付提交哈希。
