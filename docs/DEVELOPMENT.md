# 开发与构建指南

## 一、环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（开发用 22） | 前端构建 |
| Rust | stable（rustup） | 后端；Windows 需 MSVC 工具链 |
| Windows SDK + MSVC C++ 生成工具 | Win10/11 | 链接 |
| WebView2 运行时 | 常驻 | Windows 10/11 一般已内置 |

> 国内网络：本项目已将 npm 切换到 `registry.npmmirror.com`、cargo 切换到
> `rsproxy.cn` 稀疏索引（见 `~/.npmrc` / `~/.cargo/config.toml`）。

## 二、常用命令

```bash
# 安装前端依赖
npm install

# 开发模式（Vite + Tauri，热更新）
npm run tauri dev

# 仅前端类型检查 + 构建（产物 dist/）
npm run build

# 单元测试（前端 vitest / 后端 cargo test）
npm test
cd src-tauri && cargo test

# 生成应用图标（scripts/gen-icons.mjs，零依赖 PNG/ICO 编码）
npm run icons

# 构建 Windows 安装包（NSIS + MSI）
npm run tauri build
# 产物：src-tauri/target/release/bundle/nsis/Task Dock_0.5.0_x64-setup.exe

# 仅构建可执行文件（跳过打包；等价于 npm run tauri build -- --no-bundle）
npm run tauri build -- --no-bundle
# 注意：不要用 `cargo build --release` 代替——那会漏掉 tauri 的 custom-protocol 特性，
# 导致 is_dev() 为真、启动时走「开发服务器预检」分支而弹框退出。

# v0.6 视觉走查（两套预设 × 明暗 × 材质 × 宽度 + 布局溢出审计）
node scripts/serve-preview.mjs        # 另开一个终端
node scripts/visual-themes.mjs
node scripts/theme-perf.mjs

# v0.6 交互场景走查（排序菜单 / 主题下拉 / 日期浮层 / 剪贴板页 / 关联抽屉 /
#                    深色菜单 / 320px 窄布局，两套预设 × 明暗）
node scripts/visual-v06.mjs

# v0.6 布局回归矩阵（37 组合：宽高 × DPR × 预设 × 明暗 × 材质 × 模式）
node scripts/layout-regression.mjs

# v0.6 原生窗口取证（真实 Win32 窗口截图，验证四角/材质）
powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 `
  -Out docs/screenshots/v06/native-dream.png -WaitSeconds 10
```

> 视觉走查的预览服务用 `scripts/serve-preview.mjs`，不要用 `npx vite preview`：
> `vite build` 会清空 `dist/`，并发的构建会让 `dist/preview.html` 消失，
> 走查页面于是退化成 404（拿不到 Tauri IPC mock，画面全白而断言仍全绿）。
> `serve-preview.mjs` 从 `.preview/` 提供 harness、从 `dist/` 提供产物，
> 不受并发构建影响；三个走查脚本还加了「白屏守卫」，`#root` 为空即判失败。

## 三、项目结构

```
task_dock/
├── src/                        # React 前端
│   ├── lib/bridge.ts           # 类型化 IPC 桥接（唯一 invoke 入口）
│   ├── lib/navigation.ts       # 导航桥接 + 展示辅助纯函数（含单测）
│   ├── lib/clipboardUi.ts      # 剪贴板类型/时间/状态展示纯函数
│   ├── lib/format.ts           # 纯函数时间/文本格式化（含单测）
│   ├── lib/theme.ts            # 视觉预设 / 明暗 / 材质解析（纯函数，含单测）
│   ├── lib/datetime.ts         # 本地日期时间解析/格式化/日历网格纯函数
│   ├── lib/overlayStack.ts     # 全局弹层栈 + Escape 优先级分发（单例）
│   ├── styles.css              # v0.5 组件样式
│   ├── styles-themes.css       # v0.6 视觉预设 Token 与结构层（双主题皮肤）
│   ├── styles-ui.css           # UI 基元结构层 + --z-* 层级刻度
│   ├── store/                  # Zustand：tasks / agents / actions / clipboard / settings / ui / navigation
│   ├── hooks/useEdgeSnap.ts    # 贴边吸附 + 窗口持久化
│   ├── hooks/useGlobalShortcuts.ts  # Ctrl+1…8 / Ctrl+K / Ctrl+Shift+C（可单测）
│   ├── lib/featureCatalog.ts    # 统一功能规划目录（12 项核心功能固定 ID，测试锁定）
│   ├── components/roadmap/      # 「规划中心」面板：目录展示层（分类/筛选/详情）
│   ├── components/ui/          # v0.6 UI 基元：Select / Combobox / DropdownMenu / Popover /
│   │                           #   DateTimePicker / Dialog / Toggle / NumberInput / Tooltip
│   ├── components/navigation/  # TargetMenu / AppPicker / WorkspaceLauncher
│   ├── components/actions/     # 动作中心（筛选/覆盖度/确认）
│   ├── components/clipboard/   # 剪贴板工作区（页面 / 抽屉共用）、详情、粘贴与现场/任务关联
│   ├── components/context/     # 任务上下文抽屉（现场 / Agent / 关联 / 素材 / 动作）
│   └── components/             # TitleBar / 三模式视图 / 任务 / Agent / 历史 / 设置
├── src-tauri/                  # Rust 后端
│   ├── src/commands/           # 命令层（tasks/agents/navigation/settings/data/system/
│   │                           #   actions/workspace/context/clipboard）
│   ├── src/db/                 # SQLite + 迁移（当前 v9）+ 设置
│   ├── src/agents/             # Agent 事件总线 + 有界管线 + 保留 + Adapter（只观测，不导航）
│   ├── src/navigation/         # 统一导航（router/app_discovery/window_manager/
│   │                           #   target_resolver/agent_navigation）
│   ├── src/clipboard/          # 智能剪贴板（platform/engine/store/paste/agent_bridge）
│   ├── src/actions/            # 行动中心只读读模型（合并/分类/覆盖度）
│   ├── src/workspace/          # 工作现场快照/捕获/恢复
│   ├── src/scheduler.rs        # 提醒调度引擎
│   ├── src/nlp.rs              # 中文自然语言解析（含单测）
│   ├── src/recurrence.rs       # 重复规则计算（含单测）
│   ├── src/lib.rs              # 窗口/托盘/热键/自启动装配
│   └── icons/                  # 应用图标与托盘状态图标（脚本生成）
├── src-tauri/tests/            # 集成测试；ingest_perf / actions_perf / clipboard_perf 为手动压测
├── scripts/gen-icons.mjs       # 图标生成器
├── scripts/make-preview.mjs    # 视觉预览 harness（IPC mock）→ dist/ 与 .preview/
├── scripts/serve-preview.mjs   # 视觉走查静态服务（harness 取 .preview/，产物取 dist/）
├── scripts/visual-audit.mjs    # Playwright 320/400 视觉走查
├── scripts/visual-themes.mjs   # v0.6 双预设视觉走查（18 场景 + 布局溢出审计）
├── scripts/visual-v06.mjs      # v0.6 交互场景走查（26 场景）
├── scripts/layout-regression.mjs # v0.6 布局回归矩阵（37 组合）
├── scripts/theme-perf.mjs      # v0.6 主题性能测量（空闲占用/布局/backdrop-filter/切换耗时）
├── scripts/native-verify.ps1   # v0.6 原生窗口取证（桌面合成像素 + PrintWindow）
├── scripts/capture-native.ps1  # 原生窗口截图（仅抓屏）
├── scripts/seed-settings.py    # 验收用：写入本地设置（预设/明暗）
├── scripts/render-perf.mjs     # 真实 Chromium 300 行渲染采样
├── docs/                       # 架构 / 许可证 / Adapter / 测试 / 性能 / 路线图
└── docs/ui-themes/             # v0.6 视觉主题专项文档（设计规范/架构/窗口合成/性能/测试/报告/验收）
```

### 导航系统命令速查（v0.4）

| 命令 | 用途 |
|---|---|
| `nav_scan_apps(force?)` | 软件扫描（开始菜单/卸载注册表/App Paths/UWP/常用路径；返回 `diagnostics` 标记截断或来源失败；后端 5 分钟缓存） |
| `nav_app_icon(target_id?, app_key?)` | 按需提取真实 Windows 图标（`data:image/png;base64`；只接受已保存目标 id 或扫描登记过的 app_key） |
| `nav_list_windows()` | 当前可交互顶层窗口（窗口选择器） |
| `nav_list_targets` / `nav_save_target` / `nav_update_target` / `nav_delete_target` | 目标 CRUD（保存时全量安全校验 + app_key 幂等去重） |
| `nav_target_running_states(ids)` | 已保存应用目标的实时运行态（`has_window/process_only/not_running/unavailable`；按需查询，不轮询） |
| `nav_link_task` / `nav_unlink_task` / `nav_update_task_link` / `nav_task_targets` / `nav_all_task_links` | 任务关联管理 |
| `nav_navigate(target_id, options?)` | **统一跳转入口**（前端只传目标 ID；结果含 verification_level / fallback_used） |
| `nav_agent_capabilities(source_id)` | Agent 跳转能力（证据化，动态探测） |
| `nav_agent_action(source_id, "open_app"|"focus_window")` | Agent 树按钮动作 |
| `nav_agent_open_workspace(source_id, dir)` | IDE 类 Agent 打开工作区目录 |
| `nav_recent_logs` / `nav_prune_logs` | 导航执行流水 |

### 行动中心 / 现场 / 上下文命令速查（v0.5）

| 命令 | 用途 |
|---|---|
| `actions_feed(filter)` / `actions_ack(ids)` / `actions_unack(ids)` | 动作列表、批量确认、撤销确认 |
| `actions_open_session(source_id, session_id)` | 跳转 Agent 会话（能力不支持时返回明确失败） |
| `workspace_list` / `workspace_get` / `workspace_create` / `workspace_rename` / `workspace_delete` | 现场快照 CRUD |
| `workspace_capture_windows` / `workspace_capture_task` | 枚举可见窗口 / 从任务关联目标捕获 |
| `workspace_restore(id)` / `workspace_restore_cancel` / `workspace_restore_status` | 顺序恢复（逐项验证级别）、取消、状态 |
| `workspace_detach_task` / `workspace_prune` | 解绑任务（降级手动快照）/ 清理上限 |
| `task_context(task_id)` | 统一上下文聚合（任务/现场/Agent/关联/素材/动作） |
| `clipboard_link_snapshot` / `clipboard_unlink_snapshot` / `clipboard_snapshot_links` | 剪贴板素材 ↔ 现场快照关联 |

### 规划中心命令速查（v0.7）

前端封装在 `src/lib/bridge.ts`（planning 段），参数顶层 camelCase、返回字段 snake_case。
数据边界：只服务用户自建项目；内置路线图（`featureCatalog.ts`）不入库、不可经这些命令修改。

| 命令 | 用途 |
|---|---|
| `planning_list_projects(include_archived?)` | 项目列表（含功能统计与整体进度；空项目 has_features=false） |
| `planning_create_project` / `planning_update_project` / `planning_delete_project` | 项目 CRUD（删除级联功能/步骤/历史；前端必须先确认） |
| `planning_archive_project(id, archived)` | 归档 / 恢复（与项目状态相互独立） |
| `planning_reorder_projects(ids)` | 项目排序 |
| `planning_list_features(project_id)` | 功能列表（含步骤与步骤进度） |
| `planning_create_feature` / `planning_update_feature` / `planning_delete_feature` | 功能 CRUD；状态变化同事务写入 status_change 历史 |
| `planning_reorder_features(project_id, ids)` | 功能排序（限定同一项目） |
| `planning_add_step` / `planning_update_step` / `planning_delete_step` / `planning_reorder_steps` | 步骤 CRUD；勾选/重开同事务写入 step_done 历史 |
| `planning_list_milestones` / `planning_create_milestone` / `planning_update_milestone` / `planning_delete_milestone` | 里程碑管理（删除时功能关联 SET NULL） |
| `planning_activity_page(project_id, feature_id?, limit?, offset?)` | 进度历史分页（时间倒序，limit≤100） |
| `planning_add_note(project_id, feature_id?, message)` | 用户开发日志（kind=note；不解析内容、不推断进度） |

### 一键工作流命令速查（v0.9）

前端封装在 `src/lib/bridge.ts`（workflow 段）；数据模型、白名单与状态机详见
[docs/workflows/README.md](workflows/README.md)。

| 命令 | 用途 |
|---|---|
| `workflow_list` / `workflow_get` / `workflow_create` / `workflow_update` / `workflow_delete` / `workflow_duplicate` | 定义 CRUD + 复制（删除级联步骤/运行/回执） |
| `workflow_reorder(ordered_ids)` | 卡片排序（必须包含全部工作流 id） |
| `workflow_replace_steps(id, steps)` | 整表替换步骤编排（原子事务；增删改排序共用） |
| `workflow_run(id)`（async） | 启动运行；全局单槽，冲突返回可读错误 |
| `workflow_pause` / `workflow_resume` / `workflow_cancel` / `workflow_active` | 运行控制与活动概览（只置位，不等引擎） |
| `workflow_run_detail(run_id)` / `workflow_last_run(id)` / `workflow_last_run_summary(id)` | 运行详情 / 最近一次运行 |
| `workflow_list_runs(id, limit?, offset?)` | 运行历史分页（limit≤100，新→旧；每工作流保留最近 50 条） |

### 任务统计 / 快速笔记 / 快捷键 / Agent 工作时间命令速查（v0.9）

前端未接线前可直接用 `invoke` 调用；参数 camelCase，嵌套结构体字段保持 snake_case。

| 命令 | 用途 |
|---|---|
| `task_analytics(range?)` | 任务统计趋势与分类/优先级分布（`day\|week\|month`，默认 `day`；只读） |
| `notes_list(query?, pinnedOnly?, favoriteOnly?, taskId?, workspaceId?, limit?, offset?)` | 笔记列表 / 本地搜索（limit 1~200，默认 50） |
| `notes_get(id)` / `notes_create(input)` / `notes_update(id, input)` / `notes_delete(id)` | 笔记 CRUD（删除幂等，返回是否实际删除） |
| `notes_set_flags(id, pinned?, favorite?)` / `notes_set_task(id, taskId?)` / `notes_set_workspace(id, workspaceId?)` | 置顶/收藏、弱关联任务或工作现场（传 null 解除） |
| `notes_templates()` | 内置模板列表（纯常量，不落库） |
| `notes_search(query, limit?)` | 与 `notes_list(query)` 同一语义的快捷入口 |
| `notes_convert_capture(captureId)` | 捕获箱条目复制为笔记（原条目不变；重试幂等返回 `duplicate=true`） |
| `hotkeys_snapshot()` | 动作清单 + 实际注册状态 + 失败原因（启动/变更后读取） |
| `hotkeys_change(action, accelerator?, enabled?)` | 修改单个动作的组合或启用态；省略字段保持不变 |
| `hotkeys_reset(action?)` | 恢复默认组合（省略 `action` 表示全部重置） |
| `agent_work_time_stats(query: { from, to, origin?, source_id?, bucket? })` | Agent 工作时间聚合（只读；`from/to` RFC3339，`origin` 默认 `real`，`bucket` 默认 `day`） |

### 专注与休息命令速查（core.focus-timer，v0.10）

状态在 Rust 侧权威维护；前端只读快照 + 共享时钟。除 `focus_update_prefs` 返回
`FocusPrefs` 外，其余变更命令返回最新 `FocusSnapshot`。

| 命令 | 用途 |
|---|---|
| `focus_snapshot()` | 当前会话 / 今日统计 / 偏好 / 久坐计划 |
| `focus_history(limit?)` | 最近会话历史（默认 20，任务删除后保留标题快照） |
| `focus_start(taskId?)` | 开始专注（可关联任务；已有活跃会话时幂等返回当前状态） |
| `focus_start_break()` | 开始休息（短休/长休由轮次自动选择） |
| `focus_pause()` / `focus_resume()` / `focus_finish()` / `focus_cancel()` | 暂停 / 继续 / 完成（计轮次）/ 放弃（不计轮次） |
| `focus_extend_break(minutes)` / `focus_skip_break()` | 延长休息 / 跳过休息（非休息会话返回 Conflict） |
| `focus_update_prefs(patch)` | 更新专注/休息时长、自动开始、久坐开关与间隔 |
| `focus_snooze_sedentary(minutes)` | 延后久坐提醒 |

迁移版本：v24 任务完成事件、v25 快速笔记、v26 Agent 统计索引、**v27 专注会话与日聚合**、
**v28 完成事件期次幂等索引**（最新版本以 `src-tauri/src/db/mod.rs` 的 `MIGRATIONS` 为准）。

### 性能测试（需手动运行，不进入 CI）

```bash
cd src-tauri
cargo test --release --test ingest_perf --no-run
TD_PERF_A_SECS=180 cargo test --release --test ingest_perf scenario_a -- --ignored --nocapture
cargo test --release --test ingest_perf scenario_b scenario_c scenario_d scenario_baseline -- --ignored --nocapture
cargo test --release --test actions_perf -- --ignored --nocapture
cargo test --release --test clipboard_perf -- --ignored --nocapture
```

前端渲染采样（需先构建并生成预览 harness）：

```bash
npm run build && node scripts/make-preview.mjs && node scripts/render-perf.mjs
```

方法和判定标准见 [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md)，本次实测见
[PERFORMANCE_ACCEPTANCE_REPORT.md](PERFORMANCE_ACCEPTANCE_REPORT.md)。

## 四、代码规范

- TypeScript：`strict` + `noUnusedLocals` + `noUnusedParameters`，提交前 `npm run build` 必须通过。
- Rust：正常错误处理（`AppError` 统一出口），不 `unwrap` 用户输入；`cargo clippy` 建议通过。
- 新增设置项必须同时加入：`db::Settings` 字段、`commands::settings::ALLOWED_KEYS` 白名单。
- 新增数据库变更：只在 `MIGRATIONS` 末尾追加新版本 SQL，不修改已发布版本。
- 新增 Agent 事件字段：同步更新 `AgentEvent`、`validate_event`、`docs/AGENT_ADAPTERS.md`。
- 导航新增目标类型：同步 `NavigationTargetType`、`target_resolver::validate_input`、
  `router::execute_with_ctx` 分支与 `APP_NAVIGATION_MATRIX.md`；新增 Agent 跳转能力必须给证据标注。

### 错误处理接入规范（2026-11-04）

- 后端新增命令返回 `AppResult<T>`/`AppError`，不要返回字符串错误；错误分类由
  `error.rs` 的 `code()/user_message()/detail()` 统一决定。新增错误变体必须同时补
  `meta()` 映射（code/category/severity/retryable）与单测。禁止把 SQL、堆栈、剪贴板
  正文、账户名写进 `message`/`detail`。
- 前端所有窗口的 Tauri 调用都走 `import { invokeCommand as invoke } from "./errors"`，
  不得直接 `import { invoke } from "@tauri-apps/api/core"`；这样错误码与可读文案才稳定。
- 用户主动操作失败用 `reportError(e, { operation, retry })`：必须能回答「哪个操作失败、
  为什么、下一步做什么」；可安全重试时才给 `retry`。表单错误优先字段级提示，
  不要用全局 Toast 代替。
- 后台轮询/事件失败用 `recordBackgroundError`（或 store 内 `errorMessage`），写入模块
  错误状态并在面板内联展示；禁止每次轮询都 Toast。读取失败一律不要展示成空数据，
  保留旧数据时必须标记「可能不是最新」并给重试入口。
- 全局兜底：渲染异常交给 `components/ErrorBoundary.tsx`，未处理 Promise rejection
  由 `lib/globalErrors.ts` 处理；不要在模块内重复监听 window error/unhandledrejection。
- 新增错误提示的验收至少覆盖：分类正确、提示出现在正确窗口、重试真实执行、重试成功
  后状态消除、失败后用户数据安全、无重复弹窗/重复订阅。

#### 刷新结果契约（2026-11-04 第二轮）

- `useNavigationStore` 的 `loadApps` / `loadTargets` / `loadTaskLinks` 返回
  `RefreshOutcome = "ok" | "stale" | "error"`，**禁止** `await` 后读 store 旧字段推断本次
  是否成功。`stale` 表示本次结果已被更新的请求（代际 token 更大）取代，调用方不得报错、
  也不得重复提示成功。
- 用户主动保存/删除后必须分阶段说明：持久化成功、关联成功、界面刷新成功三段独立；
  刷新失败保留旧数据、给板块内重试，且不得因刷新失败重复创建已保存数据。
- 后台自动刷新（挂载、窗口打开、面板切换）失败只写对应 `*Error` 字段供内联展示，
  不逐次 Toast；成功一次即清除错误。
- 用户主动操作失败统一先 `normalizeError`/`errorMessage`，按「操作名 + 具体原因」展示；
  只有可安全重试的读操作才给重试，写入/删除/粘贴不提供盲目自动重试。
- 读取失败 ≠ 空数据：列表为空且存在读取错误时必须区分「确实没有」与「读取失败」，
  保留旧数据时标注「可能不是最新」。

### UI 组件（v0.6）

- **不要写原生 `<select>`**：用 `src/components/ui/` 的 `Select` / `Combobox`。
  `src/styles-themes.test.ts` 会扫描 `src/` 拦截回归。
- **不要写裸 `z-index` 数字**：用 `src/styles-ui.css` 的 `--z-*` 刻度。
  层级问题要靠结构解决，不靠堆数字。
- **新弹层必须调 `useOverlayLayer(kind, active, onClose)`**：
  否则 Escape 不会关它，而是直接隐藏整个窗口。
  优先级：`dialog` > `sublayer` > `menu` > `drawer` > 主窗口。
- **图标按钮必须给 `aria-label`**（窄窗下文字标签会被隐藏），
  提示文案同时写 `data-tip`（走统一提示条，不用原生 `title`）。
- **浮层定位交给 `Popover`**，不要自己算坐标——翻转与边界收敛已由 floating-ui 处理。
- 详情见 [ui-themes/08-interaction-spec.md](ui-themes/08-interaction-spec.md)、
  [ui-themes/09-component-api.md](ui-themes/09-component-api.md)。

## 五、调试技巧

- 日志：默认 `info` 级别，`RUST_LOG=debug npm run tauri dev` 看详细日志；
  HTTP 接入日志**不含请求体**（脱敏设计，请勿改为打印 body）。
- 数据库位置：`%APPDATA%\com.taskdock.desktop\task-dock.db`（可用任何 SQLite 客户端打开）。
- Agent 测试：无真实 Agent 时用「模拟控制台」；有真实 Agent 时先
  `GET /api/v1/health` 确认端点存活，再发单条事件。
- 卸载 Codex 钩子：「Agent → Codex 卡片 → 卸载钩子」（只移除 Task Dock 写的条目）。
- 单实例：应用按 `identifier`（`com.taskdock.desktop`）加互斥锁，重复启动只会聚焦已有窗口后退出。
  所以「启动后没反应」先看任务管理器里是不是已有实例（debug 与 release 共用同一把锁）。
  确实需要并行跑两个实例做对照时，用临时配置换 identifier（注意数据目录也会跟着变）：
  `src-tauri/tauri.dev.conf.json` 写 `{ "identifier": "com.taskdock.desktop.dev" }`，
  再 `npm run tauri dev -- --config src-tauri/tauri.dev.conf.json`。
- **数据目录即实例边界**（v0.5）：设置 `TASK_DOCK_DATA_DIR` 时，应用标识会按
  **数据目录路径的哈希**派生为 `{identifier}.iso.{hash}`（`src-tauri/src/lib.rs` →
  `instance_identifier_for`），单实例互斥锁与通知 AUMID 都随之区分。
  因此压测/验收用的隔离实例不会再被正式安装实例顶掉，两边数据也天然不串；
  未设置 `TASK_DOCK_DATA_DIR` 时标识**一字不变**，正式安装的单实例保护行为不受影响。
  指向同一目录的两个隔离实例仍会互相拦下（哈希一致）。

## 六、已知构建注意

- **必须在 `src-tauri/` 目录内运行 cargo**（或用 `npm run tauri ...`）：`src-tauri/rust-toolchain.toml`
  固定 MSVC 工具链；在仓库根目录用 `--manifest-path` 会绕过该固定，落到默认 GNU 工具链，
  release 链接可能报 `export ordinal too large`（MinGW ld 的 DLL 导出序数上限），且 WebView2 依赖不可用。
- 首次 Rust 编译 5–15 分钟（取决于镜像与机器）；后续增量约 1–2 分钟。release 开启 LTO，
  链接阶段可能需要数分钟，属正常。
- `cargo test` 会执行 `tauri::generate_context!()`，需 `dist/` 存在（先 `npm run build`）。
  若遇「拒绝访问」写入缓存，删除 `src-tauri/target/debug/build/task-dock-*` 后重试。

## 七、构建产物与磁盘空间管理

Rust 构建缓存是本仓库最大的磁盘开销项（2026-10-31 实测各隔离缓存合计约 52 GB，而 D 盘
剩余约 37–40 GB）。`scripts/build-guard.mjs`（零依赖 Node）与 package.json 的 `pretauri`
钩子构成构建产物的生命周期机制：构建前检查、任务专属缓存登记、任务后安全回收。

### 7.1 CARGO_TARGET_DIR 纪律（历史事故根因）

- **必须用绝对路径**：`export CARGO_TARGET_DIR="$REPO_ROOT/src-tauri/target-xxx"`。
  相对路径会随 cwd 漂移——2026-10-31 事故：在 `src-tauri/` 内用相对路径
  `src-tauri/target-accept` 执行构建，产生嵌套目录 `src-tauri/src-tauri/target-accept`（约 1.9 GB）。
- 环境变量 `CARGO_TARGET_DIR` 为相对路径时 precheck 直接阻塞（exit 2）。
- 默认（未设置）使用 `src-tauri/target` 共享增量缓存，**优先复用**；只有需要隔离
  （真机验收、性能门禁互相锁文件）才建 `target-<name>` 隔离目录。

### 7.2 已知缓存目录（`node scripts/build-guard.mjs report` 实测）

| 目录 | 用途 | 占用（2026-10-31） |
|---|---|---|
| src-tauri/target | 共享增量缓存（dev/debug/test） | 19.74 GB |
| src-tauri/target-accept | 第四轮剪贴板验收 release 门禁 | 18.37 GB |
| src-tauri/target-accept-dbg | 第四轮验收 debug 门禁 | 6.59 GB |
| src-tauri/target-measure | 性能测量 | 1.90 GB |
| target-test（仓库根） | 历史 debug 测试缓存 | 3.68 GB |
| src-tauri/src-tauri | ⚠️ 嵌套事故产物，人工确认后删除 | 1.91 GB |

全部被 `.gitignore` 忽略（`/target-*/` 与 `src-tauri/target-*/` 通配），新建任何
`target-<name>` 隔离目录不会误入 Git。

### 7.3 build-guard.mjs 用法

```bash
node scripts/build-guard.mjs precheck            # 空间+缓存检查；npm run tauri 前自动执行
node scripts/build-guard.mjs precheck --min-free-gb 8 --warn-free-gb 20   # 自定义阈值
node scripts/build-guard.mjs report              # precheck + 各缓存目录大小统计
node scripts/build-guard.mjs register --dir <绝对路径> --task <任务名>     # 登记隔离目录归属
node scripts/build-guard.mjs cleanup --dir <绝对路径>            # dry-run（默认）
node scripts/build-guard.mjs cleanup --dir <绝对路径> --execute  # 真删
```

退出码：0 正常；2 precheck 阻塞（空间不足 / CARGO_TARGET_DIR 相对路径）；3 cleanup 目标被
拒绝（边界、白名单、标记、占用）；4 删除失败（可能被进程占用）。

### 7.4 隔离目录生命周期（多 Agent 并行安全）

1. **建**：以绝对路径 `CARGO_TARGET_DIR` 创建 `src-tauri/target-<task>`（或 `tmp/` 下任务目录）。
2. **登记**：`register --dir ... --task ...` 写入 `.build-guard-owner.json`（task/pid/时间/用途）。
3. **用**：正常构建；cleanup 只认有登记标记的目录。
4. **收尾**：构建成功、失败、取消后都执行 `cleanup --dir ... --execute`；清理失败不掩盖构建结果。
5. **安全边界**（cleanup 全部满足才删）：显式绝对路径、realpath 后仍在仓库内、目标非符号链接/
   联接点、目录名为 `target-*` 或位于 `tmp/` 下、存在归属标记、标记 PID 已退出。任一不满足即跳过并记录。
6. **历史遗留目录**（无标记，如 `src-tauri/src-tauri`）永不自动删除，只在 report 中列出，
   人工确认后手动处理。
7. **清理记录**：`tmp/build-guard/cleanup-log.jsonl`（不入库）。

### 7.5 空间阈值

- 硬阈值（默认 12 GB，`--min-free-gb`）：低于则禁止完整 Release/打包构建（exit 2），先清理再构建。
- 预警阈值（默认 25 GB，`--warn-free-gb`）：低于则警告并建议先 `report`。
- `scripts/perf/gate-run.sh`、`gate-fourth-round.sh` 已在开头接入 precheck（失败 exit 2 中止门禁）。
- 未签名安装包首次运行会被 SmartScreen 拦截（「更多信息 → 仍要运行」），属预期现象。
