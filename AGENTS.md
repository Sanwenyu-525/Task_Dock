# AGENTS.md — Task Dock 开发协作规范

本文件是所有开发 Agent 的**入口规范**：规定「必须遵守什么」，「具体怎么做」见专项文档（第 1
节路由）。子目录 `AGENTS.md`（目前只有 `apps/mobile/`）在自身路径下优先，未覆盖的仍按本文件。

**事实优先级**：代码与可复现输出 > 测试/真机证据（命令、时间、退出码、证据路径）> 文档。文档
与代码冲突以代码为准，不按过期描述盲改实现；发现偏差更新文档，超出本次范围写入验收报告。

## 1. 项目定位、开工检查与按任务加载

Task Dock 是 Windows 桌面任务/启动器/Agent 监控中枢：Tauri 2 + Rust（`src-tauri/`）、React +
TypeScript + Vite + Zustand（`src/`）、SQLite；Android 客户端 `apps/mobile/` 以本地 SQLite
为主，支持用户显式发起的局域网配对、手动同步与文件互传（TLS-only + SPKI 指纹固定），不是
「完全离线独立运行」。能力与状态见 [README.md](README.md)。

**开工必做**：1）读本文件（改移动端同读其 `AGENTS.md`）；2）`git status`——本仓库可能多会话
共享同一工作树，**未提交/未跟踪改动默认属于其他任务**，不还原、不删除、不覆盖、不代为提交；
3）按任务查表并**实际读取**对应文档与相关代码/测试/迁移/命令定义。不求通读全部手册，但涉及
某模块时不得跳过其安全与兼容边界。

| 任务类型 | 按需阅读 |
|---|---|
| 通用代码修改 | 本文件 + 相关源码与测试 |
| Rust / Tauri / IPC / 数据库 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 对应章节 + [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| 移动端（Android） | [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md) + [docs/mobile/](docs/mobile/) |
| 多 Agent 并行 / Worktree | 本文件第 3 节 + [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第八章 |
| 构建产物、缓存、磁盘 | 本文件第 5 节 + [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第七章 |
| 测试、验收、真机、性能 | [docs/TESTING.md](docs/TESTING.md)、[docs/ACCEPTANCE_ROUTING.md](docs/ACCEPTANCE_ROUTING.md)、`docs/PERFORMANCE_*.md` |
| UI/UX、视觉 | 本文件第 6 节 + [docs/ui-themes/](docs/ui-themes/) + [docs/AGENT_SKILL_ROUTING.md](docs/AGENT_SKILL_ROUTING.md) |
| Agent 接入、导航 | [docs/AGENT_ADAPTERS.md](docs/AGENT_ADAPTERS.md)、[AGENT_COVERAGE_MATRIX.md](AGENT_COVERAGE_MATRIX.md)、[APP_NAVIGATION_MATRIX.md](APP_NAVIGATION_MATRIX.md) |

链接不会自动加载，执行对应任务时必须实际读取；本规范不依赖特定 Agent 工具。

## 2. 基本开发原则
- 默认简体中文；先读实际代码与测试，不凭记忆或文档臆断；既有注释与文案保持原语言风格。
- **范围最小**：只改必需代码，不顺手清理、不扩大重构、不整文件格式化、不擅自升级或引入
  依赖；保持架构与公开 API 兼容，破坏性变更先说明影响面、迁移方案与回退路径。
- 优先修根因，不用 `setTimeout`、重试、吞异常兜底；确需兜底说明根因层为何无法解决。
- **不得伪造测试结果、真机验证、性能数据或截图**：未执行写「未执行」，环境阻塞写
  `ENVIRONMENT BLOCKED`，证据不足写「证据不足」，不用「应该/理论上」代替证据。
- 非关键细节可判断并记录假设，关键需求不明先问；范围外问题写入验收报告，不擅自修复。

## 3. Git 安全与多 Agent 并行协作

总原则：**共享工作区优先、文件所有权优先、Worktree 按需使用、最终统一集成验收**。并行本身
不是创建 Worktree 的理由；隔离取决于写入范围、共享资源与 Git 状态风险。命令、退出码、派发
模板、清理与阶段清单见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第八章。

### 3.1 Git 安全（所有协作方式共用）
- 开工前、交付前各 `git status`；编辑前后复核暂存区。
- 不自动 commit/push/打标签/改分支/强制推送/改 Git 配置；禁止 `git clean`、`git reset --hard`、
  `git checkout -- <path>`、`git restore <path>`。
- **共享工作区默认禁止 Git stash**：禁止裸 `git stash`、无路径限制的 `git stash push`/`push -u`；
  不得 stash 他人修改或未跟踪文件，不得因切换任务擅自清理共享工作区。确需暂存须先 `git status`、
  确认文件完全属于本任务且无其他 Agent 在使用、取得授权、路径规格不扩大匹配范围，再执行
  `git stash push -u -m <唯一标签> -- <精确路径>`（未跟踪文件单独确认归属）；恢复前复核目标
  状态，只恢复本任务内容。**唯一标签不是安全隔离的充分条件**；归属无法确认时停止并交主 Agent
  协调，必要时改用独立 Worktree。
- 不用 `git add -A`/`git add .`/`git commit -a`；按精确路径暂存并复核，防止带入构建产物、
  数据库或证据日志。
- 同一文件被并行修改：先读双方 diff 再合并，不整文件覆盖；无法安全合并时停止报告，不猜测丢弃。
- **共享工作区的 Git 写操作由主 Agent 统一协调**：未获授权时子任务只改自己拥有的文件，不执行
  add/commit/stash/merge/rebase、不切换或创建分支、不清理暂存区；落盘时报告路径，由主 Agent
  按精确路径暂存提交。
- 不覆盖他人日志、截图、验收报告；新证据用含日期的独立文件名，推翻历史结论时保留旧文件并追加
  更正。未经授权不批量 `git rm --cached`、不删除构建或验收目录；应清理项只列路径、体量、建议
  命令等待授权；交付时如实列出本次修改/新增/删除的文件，不「整理」不理解的暂存内容。

### 3.2 默认共享工作区与文件所有权
写入集合、构建输出、公共接口、分支与依赖版本、Git 写操作、运行时资源均不冲突时，多任务
**直接在主工作区并行，不创建 Worktree**；「跨模块」「耗时长」不构成例外（例：前端页面与独立
Rust 模块）。共享契约由唯一所有者集成，其余只读或等待接口确认。

派发必须书面声明：**允许写入白名单**、禁止写入的共享枢纽文件、需协调的公共接口（IPC/类型/
迁移/设置键）、依赖与集成顺序、隔离方式及判据、测试与验收责任（模板见
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §8.11）。

- **目录所有权≠目录下全部文件的永久独占**：声明只做粗筛，写入集合出现交集立即重新协调，交集
  文件按「唯一所有者」处理。
- 共享枢纽文件：`src/lib/bridge.ts`、`src/lib/navigationRegistry.ts`、
  `src/lib/featureCatalog.ts`、`src/store/useUiStore.ts`、`src-tauri/src/lib.rs`、
  `src-tauri/src/commands/mod.rs`、`src-tauri/src/db/mod.rs`，以及全局样式与主题 Token、i18n
  语言文件、依赖与构建配置、数据库迁移及版本定义。可同时读取；
  **同时写入必须由唯一所有者或主 Agent 串行协调**。
- 需改未授权文件：不越界 → 说明文件与原因 → 主 Agent 重分配或亲自集成 → 继续其余无冲突部分。
  越界写入、覆盖他人改动、自行清理缓存均视为事故。

### 3.3 Worktree 按需使用
Worktree 是**风险评估结果**，不是并行前置步骤：
- **必须隔离**：并发改同一批文件且无法指定唯一所有者；需要不同分支/依赖版本/提交基线；工作区
  状态冲突难以消除 → 一任务一 Worktree。
- **建议隔离**：长期实验可能污染稳定主工作区；需不受他人修改影响的环境独立复现/验收；需独立
  跑完整构建且资源隔离不足 → 优先 Worktree，或主工作区 + 资源隔离并记录理由。
- **无需隔离**：写入集合与共享资源均无冲突 → 主工作区并行。

「跨模块」「耗时长」「多 Agent 并行本身」不是必须隔离的理由。**Worktree 不自动解决冲突**：
两个 Worktree 改同一文件，合并时仍冲突。

### 3.4 并行数量与共享资源
- 不设固定 Subagent 上限：按独立性、依赖、实际能力与 CPU/内存/磁盘余量决定，紧密耦合部分
  串行；不超过执行器或额度限制，遇阻塞收敛报告、不重试放大；不为凑数量制造冲突。
- **文件不重叠不等于运行环境无冲突**（Git 见 3.1），派发前检查：
  - **前端**：同一时刻只允许一个构建写同一输出目录（`dist/`、`.preview/`）；不并发改同一
    `node_modules`；dev 端口单实例或显式改端口；只读检查与单测可并行。
  - **Rust/Tauri**：不并发争用同一 Cargo target；隔离时用绝对路径 `CARGO_TARGET_DIR` 指向
    `src-tauri/target-<task>` 并 `build-guard register`；共享 target 时接受文件锁串行。
  - **SQLite**：迁移 append-only，同一时刻唯一所有者改迁移并按合并顺序协调版本号；测试库与
    用户库隔离（`TASK_DOCK_DATA_DIR`/临时库）；Worktree 不能替代数据库与运行时隔离。
  - **验收证据**：各任务用 `tmp/acceptance/<task>/`，不覆盖他人报告、截图、日志与临时数据。

### 3.5 调度决策与最终集成
1. 拆分任务 → 列写入集合求交集 → 检查共享资源（构建输出、dev 端口、Cargo target、依赖目录、
   测试库、隔离实例目录、Git 状态/暂存区）→ 按 3.3/3.4 选择：共享并行 / 共享 + 资源隔离 /
   共享 + 唯一所有者 / Worktree / 先串行前置。
2. 执行中范围扩大、写入集合变化或出现新依赖时重新评估，不因初始无冲突忽略后续共享文件修改。
3. 主 Agent 最终集成验收：修改文件与所有权越界、公共接口一致性、TS/Rust 类型与协议、测试与
   构建结果、`git status`、他人未提交改动是否被带入。
4. [scripts/worktree-guard.mjs](scripts/worktree-guard.mjs) 保持现有命令与安全边界，不自动
   强制创建/提交/合并/删除；`create` 仅在 3.3 判定需要隔离后执行；`cleanup` 默认 dry-run，
   `--execute` 的准入条件与拒绝规则见
   [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §8.7。异常保留现场上报，冲突先读双方 diff，
   无法安全合并时停止。

## 4. 架构与数据安全红线
以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 为准，以下不可破坏：
1. **分层**：UI 不直接访问数据库，React 不直接调用 Win32。
2. **IPC**：业务 IPC 统一经 `src/lib/bridge.ts`，导航经 `src/lib/navigation.ts`；参数
   camelCase，新增命令同步前端类型与 Rust 签名。
3. **SQLite**：只在 `src-tauri/src/db/mod.rs` 的 `MIGRATIONS` 末尾追加，不改已发布迁移；新设置
   项同步 `db::Settings`/`ALLOWED_KEYS`；新表登记 `BACKUP_TABLES`。
4. **Agent 管线**：事件必须进入 `agents/pipeline.rs` 有界管线；waiting/failed/completed 不得
   合并或静默丢弃，过载返回可重试错误；`origin` 由服务端判定；禁止无界队列、同步阻塞写库、
   事务内广播/通知。
5. **剪贴板**：Win32 访问只在 `clipboard/platform.rs`；三线程 + 有界队列且丢弃必须计数；
   `ACCESS_LOCK` 串行化、锁内比较后才写入，绝不覆盖用户新复制；配置 fail-closed；日志与事件
   不记录正文、完整图片、文件路径或密钥。
6. **窗口与多显示器**：保留贴边吸附、位置恢复、DPI 换算与多显示器收敛；保存矩形前验证可见性；
   HWND/PID 只作运行时身份，绝不落库。
7. **UI Token**：预设/明暗/材质正交并落到 `html[data-preset|data-theme|data-material]`；只用
   语义 Token（`styles-themes.css`/`styles-ui.css`）；不写原生 `<select>`、裸 `z-index`，不
   绕过统一组件层与 overlay 栈。
8. **异步生命周期**：后台任务、轮询、订阅、定时器必须可取消、有超时、有上限、可回收；不留
   重复监听器或永不停止的轮询。
9. **兼容性**：DB schema、备份 manifest 版本、命令签名、设置键是公开契约；变更必须说明兼容
   范围、迁移方式与旧数据/旧备份处理结果。

## 5. 构建、测试与验收
- 构建前检查磁盘与缓存（`npm run tauri` 自动执行 `build-guard precheck`），空间不足先停止并
  `report`；缓存复用、隔离与回收按 3.4 与 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第七章
  执行；不清理他人目录、发布产物、用户数据或验收证据，无法确认归属即跳过。
- 命令矩阵见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)、[docs/TESTING.md](docs/TESTING.md)：
  cargo 必须在 `src-tauri/` 内运行（勿从仓库根用 `--manifest-path`）；`cargo test` 需要
  `dist/`；不得用 `cargo build --release` 代替 Tauri 发布验收；安装/升级/卸载未经授权不执行并
  写「未执行」。
- 结论必须可追溯：命令 + 工作目录 + 退出码 + 时间 + 证据路径；数字以当次输出为准；
  `#[ignore]` 的性能/真机套件不计为通过。
- **真实窗口、系统通知、系统剪贴板、前台焦点、DPI、多显示器、贴边吸附必须原生真机验收**；
  jsdom/单测/预览截图不能替代；视觉走查用 `scripts/serve-preview.mjs`（勿用
  `npx vite preview`）。
- 验收按 [docs/ACCEPTANCE_ROUTING.md](docs/ACCEPTANCE_ROUTING.md) 的 A–F 通道（静态 / 隔离
  预览 / CDP WebView2 / UIAutomation / Win32-DWM / 物理操作）选择，证据按项标注、跨层结论
  组合通道。CDP 不证明 Win32 裁剪、吸附手感、系统级命中、通知真实展示、实际音效与桌面合成；
  物理操作仅作最后手段，移动光标/抢前台/操作他应用前取得授权；CDP 只连 `127.0.0.1` 且不连
  来路不明 target。默认低干扰，隔离实例用 `TASK_DOCK_DATA_DIR`，结束释放实例/端口/进程。
- 性能结论必须附可复核条件（二进制 sha256、构建模式、工具链、数据目录隔离、样本数、机器空闲
  状态、p50/p95 与证据文件）；不得用单次短采样宣称「无泄漏」，只能写「在 X 条件下未观察到
  泄漏型增长」。
- 环境失败（锁屏、前台锁拒绝、权限不足、磁盘满）记 `ENVIRONMENT BLOCKED`，不标记通过也不臆断
  为代码缺陷；同条件复跑结果一并保留；推翻历史结论时保留旧记录并追加带日期更正。

## 6. UI/UX 与 Skill 路由
- 复用 `src/components/ui/` 基元与语义 Token，不新增平行组件、不硬编码颜色/圆角/阴影；不产生
  重复输入框、弹层、事件监听，订阅逻辑确认引用计数。
- 新弹层接入 `src/lib/overlayStack.ts`，一次按键只关一层；图标按钮必须有 `aria-label`，提示
  统一 `data-tip`（不用原生 `title`）；检查遮挡、溢出、焦点顺序、键盘与 Escape。
- 覆盖深/浅主题、两套视觉预设、320/400 窄窗与不同 DPI；长文本截断或换行而非撑破布局；动画
  轻量并尊重 `prefers-reduced-motion`，液态玻璃不得牺牲可读性与操作效率。
- 性能红线：轮询/订阅不重复，窗口隐藏/恢复不重复全量刷新；IPC 高频通信合并或节流；异常、
  取消、超时、强杀后状态正确（不清空用户数据）；大事件/历史/图片下内存与 CPU 有平台期。
- **开发前按任务判断是否需要 Skill**：只加载适用项并实际读取 `SKILL.md`，不凭名称宣称已使用；
  **项目规范优先于 Skill**，Skill 不替代真机验收，不得另造设计语言或推翻用户要求、确认的参考
  图与 Token 体系。路由、边界与跨 Agent 目录约定见
  [docs/AGENT_SKILL_ROUTING.md](docs/AGENT_SKILL_ROUTING.md)。

## 7. 文档、验收产物与交付
- 正式文档按模块归属维护（见第 1 节路由）；功能、接口或数据结构变化必须同步对应文档并说明
  兼容性与迁移要求，不能只写在验收报告里。
- 同一主题在原文档追加带日期记录，推翻历史结论时保留原文并标注更正，不重复生成同主题报告；
  历史记录与当前执行指令分开表述，当前规则以本文件为准。
- 任务产物进 `tmp/acceptance|debug|experiments/<task-name>/`（短横线英文，一任务一目录；
  `tmp/` 已 gitignore），临时脚本/数据库/隔离实例数据同目录；仓库根不新增零散验收文件；正式
  证据归档到 `docs/` 对应目录并更新索引，不迁移、覆盖或删除历史资料。
- 任务级报告 `tmp/acceptance/<task-name>/report.md` 必含：任务范围、检查依据、P0–P3 问题清单
  （现象/根因/影响/证据）、修改文件与关键位置、命令与结果（工作目录/退出码）、已验证/未验证
  项及原因、遗留风险、结论、真实证据路径。P0 数据丢失/安全泄露/崩溃/核心流程不可用；P1 主要
  功能错误或严重仓库/数据风险且无合理绕行；P2 边界错误/次要缺陷/文档与实现不一致；P3 体验/
  格式/低风险改进。结论只用 **通过 / 部分通过 / 不通过 / 证据不足**；环境阻塞单列。
- **用户数据库、剪贴板正文/图片、密钥、令牌、个人路径、本机敏感日志不得写入可提交文件**；
  证据只保留类型、计数、耗时、退出码等可复核元数据，必要时脱敏。
- 交付前自检：`git status` 只含本次预期改动；无敏感数据进入可提交文件；临时产物在任务目录；
  报告字段齐全；未自动提交、推送或执行破坏性 Git 操作。交付时如实说明完成内容与范围、主要
  修改文件、根因与解决层、测试与构建结果、未验证项与残余风险、报告路径、产物位置与缓存清理
  结果、是否需要进一步授权（清理、真机验证）。
