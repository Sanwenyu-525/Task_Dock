# AGENTS.md — Task Dock 开发协作规范

本文件约束本仓库所有开发 Agent；子目录若有 `AGENTS.md`，以更靠近目标文件的为准。
**事实优先级**：代码与可复现输出 > 测试/真机证据（命令、时间、退出码、证据路径）> 文档。
文档与代码冲突时以代码为准，不得按过期描述盲改实现；发现偏差应更新文档，超出本次范围则
写入验收报告。本文件只写稳定规则，操作细节见各正式文档。

## 1. 项目概览与开工流程
Task Dock 是 Windows 桌面任务/启动器/Agent 监控中枢：Tauri 2 + Rust（`src-tauri/`）、React +
TypeScript + Vite + Zustand（`src/`）、SQLite；能力与当前状态见 [README.md](README.md)。

**开工必做**：1）阅读本文件及适用的子目录级规范；2）执行 `git status`（本仓库可能有多会话
共享同一工作树，所有未提交、未跟踪改动默认属于其他任务，不还原、不删除、不覆盖）；3）阅读
与任务直接相关的代码、测试、迁移和命令定义。按任务类型**按需**查阅（涉及该模块时不得跳过
其安全/兼容边界）：

| 主题 | 文档 |
|---|---|
| 架构、环境、命令、构建产物管理 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| 测试矩阵、验收、性能 | [docs/TESTING.md](docs/TESTING.md)、`docs/PERFORMANCE_*.md`、`docs/V0*_*.md` |
| Agent 接入、应用导航 | [docs/AGENT_ADAPTERS.md](docs/AGENT_ADAPTERS.md)、[AGENT_COVERAGE_MATRIX.md](AGENT_COVERAGE_MATRIX.md)、[APP_NAVIGATION_MATRIX.md](APP_NAVIGATION_MATRIX.md) |
| 模块专项（剪贴板、UI/视觉） | [docs/clipboard/](docs/clipboard/)、[docs/ui-themes/](docs/ui-themes/) |

## 2. 基本开发原则
- 默认简体中文；修改前先读实际代码与测试，不凭记忆或文档臆断现状；既有注释与文案保持原语言风格。
- 任务范围最小：只改完成任务必需的代码，不顺手清理、不扩大重构、不整文件格式化、不擅自升级
  或引入依赖；保持现有架构与公开 API 兼容，破坏性变更先说明影响面、迁移方案与回退路径。
- 优先修根因，不用 `setTimeout`、重试、吞异常堆补丁；确需兜底时说明根因层为何无法解决。
- **不得伪造测试结果、真机验证、性能数据或截图**：没执行写「未执行」，环境阻塞写
  `ENVIRONMENT BLOCKED`，证据不足写「证据不足」，不用「应该」「理论上」代替证据。
- 非关键细节可合理判断并记录假设，关键需求不明先提问；范围外问题记录到验收报告，不擅自修复。

## 3. Git 安全与并行协作
- 开工前和交付前各执行一次 `git status`；编辑前后复核暂存区。
- 不自动执行 `git commit`/`push`/打标签/改分支/强制推送/修改 Git 配置；禁止 `git clean`、
  `git reset --hard`、`git checkout -- <path>`、`git restore <path>`、裸 `git stash`；需要暂存
  用 `git stash push -u -m <唯一标签>`，只恢复自己创建的条目。
- 不使用 `git add -A`/`git add .`/`git commit -a`；按精确路径暂存并复核，防止带入构建产物、
  数据库或证据日志。
- 同一文件被并行修改：先读双方 diff、确认意图与影响面再合并，不整文件覆盖；无法安全合并时
  停止并报告，不猜测丢弃哪一方。
- 不覆盖其他 Agent 的日志、截图、验收报告；新证据使用独立文件名（含日期）；历史结论被推翻时
  保留旧文件并新增更正记录。未经授权不批量 `git rm --cached`、不删除构建目录或验收目录；
  发现应清理项时列路径、体量与建议命令等待授权，最终如实列出本次实际修改、新增、删除的文件；
  不试图「整理」不理解的暂存内容。

## 4. 架构与数据安全红线
以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 为准，以下不可破坏：
1. **分层**：UI 不直接访问数据库，React 不直接调用 Win32。
2. **IPC**：主窗口业务 IPC 统一经 [src/lib/bridge.ts](src/lib/bridge.ts)，导航经
   [src/lib/navigation.ts](src/lib/navigation.ts)；参数 camelCase，新增命令同步前端类型与 Rust 签名。
3. **SQLite**：只在 [src-tauri/src/db/mod.rs](src-tauri/src/db/mod.rs) 的 `MIGRATIONS` 末尾追加，
   不修改已发布迁移；新增设置项同步 `db::Settings` 与 `ALLOWED_KEYS`；新增表登记 `BACKUP_TABLES`。
4. **Agent 管线**：事件必须进入有界管线（`src-tauri/src/agents/pipeline.rs`）；关键状态
   waiting/failed/completed 不得合并或静默丢弃，过载返回可重试错误；`origin` 由服务端判定，
   客户端不能自行声明为 real；禁止无界队列、同步阻塞写库、事务内广播/通知。
5. **剪贴板**：Win32 访问只在 `src-tauri/src/clipboard/platform.rs`；采集三线程 + 有界队列，
   丢弃必须计数；全进程经 `ACCESS_LOCK` 串行化，锁内比较后才写入，绝不覆盖用户新复制；配置
   fail-closed；日志与事件绝不记录正文、完整图片、文件路径或密钥。
6. **窗口与多显示器**：保留贴边吸附、位置恢复、DPI 换算与多显示器收敛；保存窗口矩形前验证
   可见性；HWND/PID 只作运行时身份，绝不落库。
7. **UI Token**：视觉预设、明暗、材质三者正交，统一落到 `html[data-preset|data-theme|data-material]`；
   组件只用语义 Token（`styles-themes.css`、`styles-ui.css`）；不写原生 `<select>`、裸 `z-index`，
   不绕过统一组件层与 overlay 栈。
8. **异步生命周期**：后台任务、轮询、订阅、定时器必须可取消、有超时、有上限、可回收；不留重复
   监听器或永不停止的轮询，不绕过既有取消/超时机制。
9. **兼容性**：数据库 schema、备份 manifest 版本、命令签名、设置键是公开契约；变更必须说明
   兼容范围、迁移方式与旧数据/旧备份的处理结果。

## 5. 构建产物与磁盘空间管理
- 构建前检查磁盘空间与缓存占用（`npm run tauri` 已自动执行 `node scripts/build-guard.mjs
  precheck`）：空间不足时停止高占用构建并报告，先 `report` 取清理建议，不得盲目继续。
- 优先复用共享增量缓存 `src-tauri/target`；确需隔离构建时用**绝对路径** `CARGO_TARGET_DIR`
  指向任务专属 `target-*` 目录，并 `register` 登记归属（相对路径会随 cwd 产生嵌套缓存目录，
  precheck 会阻塞）。
- 本任务明确创建且已登记的临时构建缓存，任务结束（成功、失败、取消）后用
  `cleanup --dir <路径> --execute` 安全回收；默认 dry-run，不删除未登记目录。
- 不得清理其他 Agent 使用中的目录、正式发布产物、用户数据或验收证据；cleanup 自动校验目录
  归属、路径边界、命名白名单与进程占用，无法确认即跳过，历史遗留目录只报告、人工确认后处理。
- 目录清单、阈值、事故案例等操作手册见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第七章。

## 6. 文件与验收产物
- 任务产物统一进 `tmp/acceptance|debug|experiments/<task-name>/`（短横线英文，一任务一目录），
  仓库根不新增零散验收文件；临时脚本、临时数据库、隔离实例数据放本任务目录。
- 正式文档放 `docs/`；长期证据归档到 `docs/clipboard/evidence/`、`docs/performance/results/`、
  `docs/screenshots/` 等并更新索引；不迁移、覆盖或删除历史验收资料。
- **用户数据库、剪贴板正文/图片、密钥、令牌、个人路径或本机敏感日志不得写入可提交文件**；
  证据只保留类型、计数、耗时、退出码等可复核元数据，必要时脱敏。
- `tmp/` 已被 `.gitignore` 忽略；交付时给出产物的实际相对路径。

## 7. 测试与验证
- 命令矩阵与工作目录见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)、[docs/TESTING.md](docs/TESTING.md)。
  要点：cargo 必须在 `src-tauri/` 内运行（勿从仓库根用 `--manifest-path`）；`cargo test` 需要
  `dist/`；不得用 `cargo build --release` 代替 Tauri 发布验收；安装/升级/卸载未经授权不执行并写「未执行」。
- 每条结论必须可追溯：命令 + 工作目录 + 退出码 + 时间 + 证据路径；测试数字以当次输出为准；
  `#[ignore]` 的性能/真机套件不得计为通过。
- 真实窗口、系统通知、系统剪贴板、前台焦点、DPI、多显示器、贴边吸附必须原生真机验收，
  jsdom/单测/预览截图不能替代；视觉走查用 `scripts/serve-preview.mjs`（勿用 `npx vite preview`）。
- 性能结论必须附可复核条件（二进制 sha256、构建模式、工具链、数据目录隔离、样本数、机器是否
  空闲、p50/p95 等分位与证据文件）；不得用单次短采样宣称「无泄漏」，只能表述为「在 X 条件下
  未观察到泄漏型增长」。
- 环境失败（锁屏、前台锁拒绝、权限不足、磁盘写满）记 `ENVIRONMENT BLOCKED`，不标记通过也不
  臆断为代码缺陷；同条件复跑结果一并保留；推翻历史结论时保留旧记录并新增带日期的更正。

## 8. UI/UX 与性能
- 复用 `src/components/ui/` 基元与语义 Token，不新增平行组件、不硬编码颜色/圆角/阴影。
- 不产生重复输入框、弹层、事件监听；订阅类逻辑确认引用计数（如剪贴板变更监听全应用只一条）。
- 新弹层必须接入 `src/lib/overlayStack.ts` 层级分发，一次按键只关一层；图标按钮必须有
  `aria-label`，提示统一用 `data-tip`，不用原生 `title`。
- 检查遮挡、溢出、焦点顺序、键盘操作与 Escape；覆盖深/浅主题、两套视觉预设、320/400 窄窗与
  不同 DPI；下拉框和浮层宽度合理，长文本截断或换行而非撑破布局；动画轻量并尊重
  `prefers-reduced-motion`，液态玻璃不得牺牲文字可读性与操作效率。
- 性能红线：Agent 队列有界且过载返回可重试错误；轮询/订阅不重复，窗口隐藏/恢复不重复全量刷新；
  定时器、监听器、后台任务、线程/句柄退出或取消时释放；大事件/历史/图片下内存与 CPU 有平台期；
  IPC 高频通信合并、节流或单飞；异常恢复、取消、超时、强杀后状态正确（不清空用户数据）。

## 9. 文档维护
- 归属：架构 → `docs/ARCHITECTURE.md`；开发/命令 → `docs/DEVELOPMENT.md`；测试 →
  `docs/TESTING.md`；性能 → `docs/PERFORMANCE_*.md`；模块 → `docs/<module>/`；视觉 →
  `docs/ui-themes/`。功能、接口或数据结构变化必须同步对应文档，不能只写在验收报告里；
  Agent 事件字段、导航目标类型的同步清单见 `docs/DEVELOPMENT.md`。
- 数据或接口变化必须说明兼容性与迁移要求（SQLite 迁移、备份 manifest、命令签名、设置键）；
  同一主题在原文档追加带日期记录，推翻历史结论时保留原文并标注更正，不重复生成同主题正式报告。

## 10. 验收与最终交付
- 任务级报告写入 `tmp/acceptance/<task-name>/report.md`，版本级放 `docs/`。报告必含：任务范围、
  检查依据、P0–P3 问题清单（现象/根因/影响/证据）、修改文件与关键位置、命令与结果（工作目录/
  退出码）、已验证与未验证项及原因、遗留风险、结论、证据路径（必须真实存在）。
- 分级：P0 数据丢失/安全泄露/崩溃/核心流程不可用；P1 主要功能错误或严重仓库/数据风险且无合理
  绕行；P2 边界错误、次要缺陷、文档与实现不一致；P3 体验、格式、低风险改进。结论只能用
  **通过 / 部分通过 / 不通过 / 证据不足**；环境阻塞单列阻塞项。
- 交付时如实说明：完成内容与范围；主要修改文件；根因与解决层；测试与构建结果；未验证项与
  残余风险；验收报告路径；构建产物位置与缓存清理结果；是否需要进一步操作（授权清理、真机验证）。
- 交付前自检：`git status` 只含本次预期改动；无敏感数据进入可提交文件；临时产物在任务目录；
  报告字段齐全；未自动提交、推送或执行破坏性 Git 操作。
