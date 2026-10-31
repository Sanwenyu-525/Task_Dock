# AGENTS.md — Task Dock 开发协作规范

本文件约束本仓库所有开发 Agent；若子目录出现 `AGENTS.md`，以更靠近目标文件的为准。
**事实优先级**：代码与可复现输出 > 测试/真机证据（命令、时间、退出码、证据路径）> 文档。
文档与代码冲突时以代码为准，不得按过期描述盲改实现；发现偏差应更新文档，超出本次范围则
写入验收报告。本文件只写稳定规则，动态事实以代码或正式文档为准。

## 1. 项目概览与文档导航
Task Dock 是 Windows 桌面任务/启动器/Agent 监控中枢：Tauri 2 + Rust（`src-tauri/`）、React +
TypeScript + Vite + Zustand（`src/`）、SQLite；能力与当前状态见 [README.md](README.md)。

**开工必做**：1）阅读本文件及适用的子目录级规范；2）执行 `git status`，查看已暂存、未暂存
与未跟踪改动；3）阅读与任务直接相关的代码、测试、迁移和命令定义。

按任务类型**按需**查阅（不无差别通读；涉及该模块时不得跳过其安全/兼容边界）：

| 任务类型 | 文档 |
|---|---|
| 架构、环境与构建 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| 测试、未验证项、性能、版本验收 | [docs/TESTING.md](docs/TESTING.md)、`docs/PERFORMANCE_*.md`、`docs/V0*_*.md` |
| Agent 接入、事件字段、应用导航 | [docs/AGENT_ADAPTERS.md](docs/AGENT_ADAPTERS.md)、[AGENT_COVERAGE_MATRIX.md](AGENT_COVERAGE_MATRIX.md)、[APP_NAVIGATION_MATRIX.md](APP_NAVIGATION_MATRIX.md) |
| 模块专项（剪贴板、UI/视觉） | [docs/clipboard/](docs/clipboard/)、[docs/ui-themes/](docs/ui-themes/) |

## 2. 基本开发原则
- 默认使用简体中文；修改前先读实际代码、相关测试与文档，不凭记忆或文档臆断实现现状；代码中的
  既有注释、文案保持原语言风格；保持任务范围最小：只改完成任务必需的代码，不顺手清理、不扩大
  重构、不整文件格式化；不擅自升级或引入依赖、不重构无关模块；保持现有架构与公开 API 兼容，
  破坏性变更必须先说明影响面、迁移方案与回退路径。
- 优先修根因，避免用 `setTimeout`、重试、吞异常堆补丁；确需兜底时说明根因层为何无法解决。
- **不得伪造测试结果、真机验证、性能数据或截图**：没执行写「未执行」，环境阻塞写
  `ENVIRONMENT BLOCKED`，证据不足写「证据不足」；不得用「应该」「理论上」代替证据。
- 非关键细节可合理判断并记录假设，关键需求不明确时先提问或给出可选方案；发现范围外的问题
  记录到验收报告并说明影响，不擅自修复，需修复先取得确认。

## 3. Git 安全与并行 Agent 协作
- 开工前和交付前各执行一次 `git status`；本仓库可能有多会话共享同一工作树，所有未提交、未跟踪
  改动默认属于其他任务或用户：不还原、不删除、不清理、不覆盖，编辑前后复核暂存区；不自动执行
  `git commit`、`git push`、打标签、改分支、强制推送或修改 Git 配置。
- 禁止 `git clean`、`git reset --hard`、`git checkout -- <path>`、`git restore <path>`、
  裸 `git stash`/`git stash pop`；需要暂存时用带唯一标签的 `git stash push -u -m <tag>`，
  并只恢复自己创建的条目。
- 不使用 `git add -A` / `git add .` / `git commit -a`；按精确路径暂存，暂存后用 `git status`
  复核，防止带入构建产物、数据库或证据日志。
- 同一文件被并行修改：先读双方 diff、确认意图与影响面再合并，不得整文件覆盖；无法安全合并时
  停止并报告，不猜测丢弃哪一方；不覆盖其他 Agent 的日志、截图、验收报告，新证据使用独立文件名
  （含日期/时间），历史结论被推翻时保留旧文件并新增更正记录；不试图「整理」不理解的暂存内容。
- 未经明确授权，不批量 `git rm --cached`、不删除构建目录或验收目录；发现应清理项时在报告中
  列出路径、体量与建议命令等待授权；最终如实列出本次实际修改、新增、删除的文件。

## 4. 架构与数据安全红线
以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 为准，以下不可破坏：

1. **技术栈与分层**：Tauri 2 + Rust 后端、React + TypeScript 前端、Vite、Zustand；UI 不直接访问数据库，React 不直接调用 Win32。
2. **IPC**：主窗口业务 IPC 统一经 [src/lib/bridge.ts](src/lib/bridge.ts) 类型化封装，导航封装在
   [src/lib/navigation.ts](src/lib/navigation.ts)；参数 camelCase，新增命令同步前端类型与 Rust 签名。
3. **SQLite**：只在 [src-tauri/src/db/mod.rs](src-tauri/src/db/mod.rs) 的 `MIGRATIONS` 末尾追加，
   不修改已发布迁移，版本以 `PRAGMA user_version` 为准；新增设置项同时加入 `db::Settings` 与
   `commands::settings::ALLOWED_KEYS`；新增表必须登记到 `commands/backup.rs` 的 `BACKUP_TABLES`。
4. **Agent 接入**：事件必须进入有界管线（`src-tauri/src/agents/pipeline.rs`）；关键状态
   waiting/failed/completed 不得合并或静默丢弃，过载返回可重试错误；`origin` 由服务端判定，
   客户端不能自行声明为 real；禁止无界队列、同步阻塞写库、事务内广播/通知。
5. **剪贴板**：Win32 访问只允许在 `src-tauri/src/clipboard/platform.rs`；采集使用三线程 + 有界
   队列，丢弃必须计数；本进程所有访问经 `ACCESS_LOCK` 串行化，锁内比较内容后才写入，绝不覆盖
   用户新复制；配置读取 fail-closed；日志与事件绝不记录正文、完整图片、文件路径或密钥。
6. **窗口与多显示器**：保留贴边吸附、窗口位置恢复、DPI 换算与多显示器收敛；保存窗口矩形前验证可见性；HWND/PID 只作运行时身份，绝不落库。
7. **UI Token**：视觉预设、明暗、材质三者正交，统一落到 `html[data-preset|data-theme|data-material]`；
   组件只用语义 Token（`styles-themes.css`、`styles-ui.css`）；不写原生 `<select>`、裸 `z-index`，
   不绕过统一组件层与 overlay 栈。
8. **异步生命周期**：新增后台任务、轮询、订阅、定时器必须可取消、有超时、有上限、可回收；不得留下重复监听器或永不停止的轮询；既有取消/超时机制不得绕过。
9. **兼容性**：数据库 schema、备份 manifest 版本、命令签名、设置键都是公开契约；变更必须说明
   兼容范围、迁移方式与旧数据/旧备份的处理结果。

新增架构要求若与代码不一致：先核实代码与历史决策，记录差异；不要为迎合文档改实现。

## 5. 文件管理与验收产物
任务产物统一进入任务目录，仓库根不得新增零散验收文件：

```text
tmp/acceptance/<task-name>/{report.md,logs/,screenshots/,test-results/}
tmp/debug/<task-name>/          tmp/experiments/<task-name>/
```

- `<task-name>` 用短横线英文，一任务一目录，不复用其他任务目录；临时脚本、临时数据库、隔离
  实例数据、CDP 日志都放在本任务目录内，不要写到仓库根目录。
- 正式文档放 `docs/` 对应目录，不放 `tmp/`；长期证据归档到 `docs/clipboard/evidence/`、
  `docs/performance/results/`、`docs/screenshots/` 等并更新索引；不迁移、覆盖或删除历史验收资料
  （根目录历史报告与 `tmp/` 旧工作目录保持原位）。
- **不得把用户数据库、剪贴板正文/图片、密钥、令牌、个人路径或本机敏感日志写入可提交文件**；
  证据只保留类型、计数、耗时、退出码等可复核元数据，必要时脱敏。
- `tmp/` 已被 `.gitignore` 忽略（新文件不入库，既有已跟踪文件保持原状）；交付时给出产物的实际
  相对路径。

## 6. 测试与验证要求
按改动范围选择最小充分验证，命令必须在正确工作目录执行：

| 范围 | 命令 | 工作目录 |
|---|---|---|
| 前端单测 / 类型检查与构建 | `npm test`；`npm run build`（含 `tsc --noEmit`） | 仓库根 |
| 前端视觉回归（按需） | `npm run build && node scripts/make-preview.mjs`，再用 `scripts/serve-preview.mjs` + 对应 `scripts/visual-*.mjs` / `layout-regression.mjs` | 仓库根 |
| Rust | `cargo fmt --all -- --check`、`cargo clippy --all-targets --all-features`、`cargo test --all-targets --no-fail-fast` | `src-tauri/` |
| Tauri 可执行文件 / 安装包 | `npm run tauri build -- --no-bundle` / `npm run tauri build` | 仓库根 |

硬性规则：
- **cargo 必须在 `src-tauri/` 内运行**，不要从仓库根用 `--manifest-path` 调用（会绕过
  `src-tauri/rust-toolchain.toml` 的 MSVC 固定，可能落到 GNU 工具链并链接失败）；`npm run tauri ...`
  不受限。`cargo test` 需要 `dist/`（缺失先 `npm run build`）；**不得用 `cargo build --release` 代替 Tauri 发布验收**
  （缺 `custom-protocol`，启动行为不同）；安装/升级/卸载会改动用户机器，未经授权不执行并写「未执行」。
- `#[ignore]` 的性能/真机套件默认不在门禁内，运行方式见 `docs/TESTING.md`，**ignored 不得计为通过**；
  每条结论必须可追溯到「命令 + 工作目录 + 退出码 + 时间 + 证据路径」，测试数字以当次输出为准。
- 性能结论必须附可复核条件：被测二进制（含 sha256）、构建模式、工具链、数据目录隔离方式、
  样本数/时长、机器是否空闲、p50/p95 等分位与证据文件。
- jsdom/vitest、Rust 单测、Playwright 预览 harness 不能证明真实窗口、系统通知、系统剪贴板、前台
  焦点、DPI、多显示器、贴边吸附等系统级行为；这些必须原生真机验收，不得用 mock 截图或预览
  截图替代。
- 锁屏、前台锁拒绝、权限不足、磁盘写满等环境失败记 `ENVIRONMENT BLOCKED`，不直接标记通过，
  也不臆断为代码缺陷；同条件复跑结果一并保留；历史结论被新证据推翻时，保留旧记录并新增带
  日期的更正（写明原因、新旧证据），不静默改写。

## 7. UI/UX 与性能基本规范
- 复用 `src/components/ui/` 的基元与 `styles-themes.css` / `styles-ui.css` 的语义 Token；不新增
  平行组件或硬编码颜色、圆角、阴影。
- 不产生重复输入框、重复弹层、重复事件监听；订阅类逻辑确认引用计数（如剪贴板变更监听全应用
  只保留一条）。
- 新弹层必须接入 `src/lib/overlayStack.ts` 的层级分发，一次按键只关一层；图标按钮必须有
  `aria-label`，提示用统一 `data-tip`，不用原生 `title`。
- 检查遮挡、溢出、焦点顺序、键盘操作与 Escape；覆盖深/浅主题、两套视觉预设、320/400 窄窗与
  不同 DPI；下拉框和浮层宽度合理，长文本截断或换行而非撑破布局；动画轻量并尊重
  `prefers-reduced-motion`，液态玻璃不得牺牲文字可读性与操作效率。
- 视觉走查使用 `scripts/serve-preview.mjs`，不要用 `npx vite preview`（`vite build` 会清空
  `dist/`，并发构建会让页面 404 且「全白但断言全绿」）。
- 性能：Agent 队列有界且过载返回可重试错误；轮询/订阅不重复，窗口隐藏/恢复不重复全量刷新；
  定时器、监听器、后台任务、线程/句柄在退出或取消时释放；大事件/历史/图片下内存与 CPU 有平台
  期；剪贴板磁盘配额与清理有效；异常恢复、取消、超时、强杀后状态正确（不清空用户数据、不重复
  写入）；IPC 高频通信应合并、节流或单飞。不得用单次短采样宣称「无泄漏」，只能表述为「在 X
  条件下未观察到泄漏型增长」；结论必须附测试条件与证据路径。

## 8. 文档维护
- 文档归属：架构 → `docs/ARCHITECTURE.md`；开发/命令 → `docs/DEVELOPMENT.md`；测试 →
  `docs/TESTING.md`；性能 → `docs/PERFORMANCE_*.md`；模块 → `docs/<module>/`；视觉 → `docs/ui-themes/`；
  功能、接口或数据结构变化必须同步更新对应文档，不能只写在验收报告里；Agent 事件字段、导航目标
  类型的同步清单见 `docs/DEVELOPMENT.md`。
- 数据或接口变化必须说明兼容性与迁移要求（SQLite 迁移、备份 manifest、命令签名、设置键）；
  同一主题在原文档追加带日期记录，推翻历史结论时保留原文并标注更正；不重复生成同主题正式
  报告；不把长期正式文档放 `tmp/`，根目录历史验收报告与 `tmp/` 历史目录保持原位。

## 9. 验收与最终交付
任务级报告写入 `tmp/acceptance/<task-name>/report.md`，版本级报告放 `docs/`。报告必须包含：任务
范围（做什么/不做什么）、检查依据、P0–P3 问题清单（现象/根因/影响/证据）、修改文件与关键位置、
命令与结果（工作目录/退出码）、已验证项（证据路径）、未验证项及原因、遗留风险、结论、证据路径。

- P0：数据丢失/安全泄露/崩溃/核心流程不可用；P1：主要功能错误或严重仓库/数据风险且无合理绕行；
  P2：边界错误、次要缺陷、文档与实现不一致；P3：体验、格式、低风险改进。结论只能用
  **通过 / 部分通过 / 不通过 / 证据不足**；环境阻塞用「部分通过」或「证据不足」并单列阻塞项；证据路径必须真实存在，不得编造日志/截图/数字，测试数字注明日期与命令。

结束任务时按以下顺序交付：完成内容与范围；主要修改文件（新增/修改/删除）；根因与解决层；测试/
构建结果（命令、目录、退出码、通过/失败/忽略数量）；未验证项与残余风险；验收报告路径；是否需要
进一步操作（授权清理、真机验证、后续任务）。

交付前自检：`git status` 只含本次预期改动；无数据库、剪贴板内容、令牌、密钥或本机敏感日志进入
可提交文件；临时产物在任务目录；测试与验收数字如实、未执行项已说明；报告字段齐全；未自动提交、
推送或执行破坏性 Git 操作。