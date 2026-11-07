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

# 说明：Vite HMR 只更新前端资源，**不会**重新编译 Rust。
# 若前端新增了 IPC 命令（如 lifecycle_status / hide_tab_hint）而 Rust 进程仍是旧构建，
# 会得到 `Command <name> not found`；这不是命令未注册，而是运行实例版本落后。
# 核对运行实例路径/启动时间与源码修改时间，重启 `npm run tauri dev` 或重新构建后再验收。
# 诊断日志中的 IPC failed 不应当作“注册缺失”直接改代码。

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

# 布局回归矩阵（38 组合：宽高 × DPR × 预设 × 明暗 × 材质 × 模式 +
#                 导航显隐后高度稳定性；含高度填充与「设置」固定区贴底断言）
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
├── scripts/build-guard.mjs     # 构建空间/缓存登记与安全回收（§7）
├── scripts/worktree-guard.mjs  # 多 Agent Worktree 创建/状态/集成预检/安全清理（§8）
├── scripts/make-preview.mjs    # 视觉预览 harness（IPC mock）→ dist/ 与 .preview/
├── scripts/serve-preview.mjs   # 视觉走查静态服务（harness 取 .preview/，产物取 dist/）
├── scripts/visual-audit.mjs    # Playwright 320/400 视觉走查
├── scripts/visual-themes.mjs   # v0.6 双预设视觉走查（18 场景 + 布局溢出审计）
├── scripts/visual-v06.mjs      # v0.6 交互场景走查（26 场景）
├── scripts/layout-regression.mjs # 布局回归矩阵（38 组合 + 高度填充/导航切换稳定性）
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
| `nav_scan_apps(force?, scanId?)` | 软件扫描（开始菜单/卸载注册表/App Paths/UWP/常用路径；按来源分批推送 `nav-scan-batch`，来源内每 60 条一片；返回 `diagnostics` 标记截断/来源失败/超时；`cancelled=true` 表示中途取消且不写缓存；后端 5 分钟缓存） |
| `nav_cancel_scan(scan_id)` | 取消在途扫描（只置标志并立即返回；扫描在来源/条目/子进程检查点退出，结果以 `nav_scan_apps` 返回的 `cancelled` 为准） |
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

`report` 除固定清单外，还会动态扫描仓库根与 `src-tauri/` 下所有 `target-*` 目录，并显示
归属 `task`/`pid`（无标记显示 `[未登记]`）；动态扫描仅用于统计展示，不改变 `cleanup`
的白名单与归属校验。

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

### 7.6 dev profile 的调试信息级别（2026-11-05）

`src-tauri/Cargo.toml` 现在设置：

```toml
[profile.dev]
debug = "line-tables-only"
```

**为什么**：dev/debug 构建默认写完整调试信息（类型、局部变量、内联信息），在 MSVC 目标上
会为每个 crate 生成大体积 `.pdb`；2026-11-05 检查 `src-tauri/target` 时 `.pdb` 共 528 个、
合计约 15.5 GiB，是构建缓存的第二大开销。`line-tables-only` 只保留文件/行号表，
panic 栈与调试器仍能定位到**文件和行号**，但看不到局部变量值、结构体字段与内联帧。

**影响范围**：`cargo build` / `cargo check` / `cargo test` / `tauri dev` 都走 dev profile，
因此测试二进制与调试构建的 PDB 一并变小；`[profile.release]` 未改动，发布包行为不变。

**磁盘提醒**：
- 体积下降对**下次**构建生效，属预期值，本仓库尚无实测对比数据（未执行全量对比构建）。
- 已存在的 `.pdb` 不会被 Cargo 自动清理；需要回收空间时，先确认没有正在运行的调试实例，
  再删除 `src-tauri/target/debug` 下的陈旧 `.pdb`（或用 `cargo clean` 清空整个缓存）。
  清理前按 §7.3 用 `build-guard` 检查是否被并行会话占用。

**需要完整变量时临时覆盖**（环境变量优先级高于 Cargo.toml）：

```powershell
$env:CARGO_PROFILE_DEV_DEBUG = "2"; cargo build    # PowerShell
CARGO_PROFILE_DEV_DEBUG=2 cargo build              # bash / Git Bash
```

覆盖后会重新编译受影响的 crate，PDB 也随之回到完整体积；用完删除该环境变量即可恢复。
`CARGO_PROFILE_DEV_DEBUG = 0` 可临时得到最小体积（但栈只有地址，无文件名/行号）。

### 7.7 构建溯源诊断

`src-tauri/build.rs` 在构建时注入 Git 短 commit 与 Unix 构建时间；`performance_diagnostics`
的 `build` 段同时返回 debug/release profile 和当前运行 exe 路径。构建脚本通过
`git rev-parse --git-path` 解析并监听 `.git/HEAD`、当前分支 ref 与 `packed-refs`，因此同一
分支前进到新 commit 时会重新生成诊断信息，也兼容 worktree 的 `.git` 指针文件。

`commit` 只标识 Git 提交，不是工作区内容哈希；诊断的 `dirty` 字段只表示构建时
是否存在未提交的已跟踪修改（`git status --porcelain --untracked-files=no`，
未跟踪文件不计，未提交内容本身不做哈希）。`dirty=true` 的构建不应视为干净快照。
exe 路径只通过本机诊断 IPC 返回，不写入应用日志。

## 八、多 Agent Worktree 隔离与集成

多 Agent 并行时默认**一任务一 Worktree**；共享同一工作树只适用于单 Agent 独占且无并行冲突的
简单任务。主工作区承担集成、验收与稳定版本管理。工具 `scripts/worktree-guard.mjs`（零依赖
Node，与 `build-guard.mjs` 同级）负责创建、状态、冲突预检与安全清理，**不执行 commit / merge /
rebase / push**，所有 Git 写操作仍由任务所有者按授权执行。

### 8.1 目录与分支约定

- Worktree 根默认在仓库同级：`<仓库父目录>/<仓库名>-worktrees/`（当前即
  `D:\Develop\task_dock-worktrees\`），一任务一目录，目录名 = 任务名。
- 任务名只允许小写字母/数字与单个短横线连接，长度 1–48，例如 `capsule-drag`。
- 分支默认 `agent/<task>`；创建前同时检查本地与 `origin` 同名分支，已存在即拒绝。
- Worktree 不得放在仓库内部（会污染工作树、`git status` 与构建缓存统计），工具直接拒绝。
- 历史 Worktree（如第五轮验收的 `D:\Develop\task_dock-r2-acc`，detached HEAD）保持原状：
  `status` 会列出，但 `cleanup` 只处理显式 `--task` 匹配项，不自动 prune 或删除。

### 8.2 命令与退出码

```bash
node scripts/worktree-guard.mjs status   [--target main] [--json]
node scripts/worktree-guard.mjs create   --task <name> [--base <ref>] [--branch <name>] \
                                         [--root <绝对目录>] [--link-node-modules] [--json]
node scripts/worktree-guard.mjs check    --task <name> [--target main] [--json]
node scripts/worktree-guard.mjs cleanup  --task <name> [--target main] \
                                         [--delete-branch] [--execute] [--json]
```

| 退出码 | 含义 |
|---|---|
| 0 | 正常（`check` 未发现冲突/覆盖风险；`cleanup` dry-run 或执行成功） |
| 1 | 用法/环境错误（参数非法、分支或目录已存在、`git` 失败） |
| 2 | `check` 发现冲突或覆盖风险，暂不可集成 |
| 3 | `cleanup` 拒绝执行（脏、未合入、锁定、主工作区、目录缺失） |
| 4 | 清理执行失败（移除 Worktree 或 `node_modules` 链接失败） |
| 5 | Worktree 已移除，但分支删除失败（如目标分支与主工作区当前分支不一致） |

`--json` 只输出机器可读结果，便于 Agent 判断；人类可读输出会把风险与建议逐条列出。

### 8.3 创建与依赖/构建缓存

1. 在仓库根执行 `create`。工具从 `--base`（默认 `HEAD`）解析固定提交，调用
   `git worktree add -b agent/<task> <目录> <commit>`；**不移动主工作区 HEAD，不切换当前分支**。
2. 目标目录、任务分支任一已存在即失败并保留现场；工具不自动删除冲突目录。
3. 前端依赖：只有 `package.json` 与 `package-lock.json` 与主仓库**逐字节一致**时才允许
   `--link-node-modules`，建立指向主仓库 `node_modules` 的 junction；否则必须在 Worktree 内
   独立 `npm ci`。这样避免两个任务对同一依赖目录做不同版本安装而互相污染。
4. Rust 缓存：**不要**让每个 Worktree 在自己目录下生成 `src-tauri/target`（不在主仓库报告范围，
   且每个 5–7 GB）。需要 Rust 构建时，在主仓库 `src-tauri/` 内使用绝对路径：

   ```bash
   CARGO_TARGET_DIR="D:/Develop/task_dock/src-tauri/target-<task>"
   node scripts/build-guard.mjs register --dir "$CARGO_TARGET_DIR" --task <task>
   # 任务结束（成功/失败/取消）后：
   node scripts/build-guard.mjs cleanup --dir "$CARGO_TARGET_DIR" --execute
   ```

   每个任务独立 target 目录可避免 Cargo 文件锁串行化；不要并发共享同一个 target（不同
   checkout 的源路径会让指纹反复失效，且锁竞争会串行构建）。共享 `node_modules` 的 junction
   在 `cleanup --execute` 前会先移除链接，不触碰主仓库依赖。
5. 并行 `tauri dev` 共用 1420 端口会冲突：同一时刻只保留一个 dev 实例，其他 Agent 使用
   `cargo test` / `vitest` / `npm run build`，或在各自任务中显式改端口。

### 8.4 状态解读

`status` 直接读取 `git worktree list --porcelain` 与每个工作树的 `git status --porcelain=v1`，
**不凭目录名推断**，输出路径、分支、HEAD、修改/未跟踪/冲突计数、Git 锁定与相对目标分支的
ahead/behind。当前没有任何进程/会话级证据，活跃状态统一显示「未知」；`locked` 只表示人工
锁定，**不能当作仍在工作的证据**。目录缺失的条目会标记为可 `prune`，但工具不自动执行。

### 8.5 集成流程（人工执行，工具只做预检）

1. 在 Worktree 内完成开发，按任务授权提交；未提交内容不算已集成。
2. 在 Worktree 内执行受影响测试与构建（前端 `npm test` / `npm run build`；Rust 在
   `src-tauri/` 内 `cargo test`）。
3. `node scripts/worktree-guard.mjs check --task <task>`：检查 ahead/behind、待集成文件、
   `git merge-tree` 冲突预测、源 Worktree 是否干净、目标工作区未提交文件是否与待集成文件重叠。
   退出码 2 表示存在阻塞/风险，先处理再合并。
4. 主 Agent 复核 `git log --oneline <target>..<branch>` 与 `git diff --stat <target>...<branch>`，
   确认依赖关系与集成顺序；跨模块改动按文件所有权串行合并。
5. 在目标分支执行合并（仅在获得授权时）：`git merge --no-ff agent/<task>`；冲突时停止，
   先读双方 diff 再决定，不整文件覆盖、不强制推送。
6. 合并后重新执行受影响测试；确认无回归后才考虑清理 Worktree。

### 8.6 冲突与共享文件

- Worktree 隔离**不等于**自动解决冲突：两个 Worktree 改同一模块，合并时仍会冲突。
- 共享枢纽文件（`src/lib/bridge.ts`、`navigationRegistry.ts`、`featureCatalog.ts`、
  `useUiStore.ts`、`src-tauri/src/lib.rs`、`commands/mod.rs`、`db/mod.rs`）、SQLite 迁移与
  构建缓存仍保持单一所有者；由主 Agent 决定集成顺序。
- 目标工作区有未提交改动时，`check` 会列出与待集成文件重叠的路径并返回 2；不得用 stash、
  reset 或整文件覆盖清理他人的现场，必须由该工作区所有者先提交或迁移改动。
- 一个任务未完成、另一个任务需要开始时，新任务从目标分支的稳定提交新建 Worktree，
  不等待、不 rebase 对方分支；集成时按提交顺序处理。

### 8.7 安全清理

`cleanup` 默认 dry-run，只有 `--execute` 才执行，且必须同时满足：Worktree 不是主工作区、
未被 Git 锁定、目录存在、状态干净（无修改/未跟踪/冲突）、HEAD 已合入 `--target`（默认
`main`）。不满足即返回 3 并保留目录。执行顺序为：复核状态 → 移除 `node_modules` 链接（若是
共享 junction）→ `git worktree remove`（不带 `--force`）→ 可选 `git branch -d`。
`--delete-branch` 只删除已合入的本地任务分支；不使用 `-D`，不删除远程分支。
目录已缺失的条目不会自动 `git worktree prune`：先人工确认该条目确已废弃，再手动执行。

### 8.8 异常恢复

| 现象 | 处理 |
|---|---|
| `status` 显示目录缺失 / prunable | 人工确认目录确已废弃后执行 `git worktree prune`；工具不自动 prune |
| Worktree 被锁定 | 确认无其他 Agent 使用后人工 `git worktree unlock`；工具拒绝自动解除 |
| 创建时目录/分支已存在 | 工具停止并保留现场；确认归属后复用或换任务名，不覆盖、不删未知分支 |
| `git worktree add` 中途失败 | 检查残留目录与 `.git/worktrees` 元数据后人工处理；工具不会自动删除 |
| 合并冲突 | 停止集成，保留双方提交与工作树，按 8.6 确认归属后解决；不 `reset --hard` |
| 磁盘空间不足 | 先 `node scripts/build-guard.mjs report`，按 7.4/7.5 清理已登记缓存 |

### 8.9 验证

```bash
node --test scripts/worktree-guard.test.mjs      # 9 个用例：创建/重复拒绝/隔离/junction/冲突/清理/退出码
node scripts/worktree-guard.mjs status           # 只读检查当前真实 Worktree
node scripts/build-guard.mjs precheck            # 现有构建守卫保持兼容
```

自动化用例在系统临时目录自建一次性 Git 仓库，不读写本仓库的工作树；真实仓库验收只创建
本任务自己的测试 Worktree，并在确认干净、已合入后清理。证据与结论见
`tmp/acceptance/agent-worktree-isolation/report.md`。

## 资源管理与清理

- 后端入口：`src-tauri/src/resource_cleanup/`、`commands/resource_cleanup.rs`；文件句柄验证在 `src-tauri/src/fs_safety.rs`。TTS 缓存复用 `audio/cache.rs`，不得另开缓存目录锁；剪贴板缩略图必须使用 `ClipboardRuntime.capture_gate`，Shelf 引用复查必须位于 SQLite writer transaction。
- 只允许检查服务端固定目录和命名白名单；`temporary` 只清理 Shelf 目录内规范 UUID 命名且超过 24 小时的 `.part` 文件。Agent spool、备份/恢复、用户原文件、语音包或构建缓存不扫描。
- 扫描最多处理每目录 10,000 个条目、条目间最长 5 秒；超过限制应返回部分结果，不能把子集总量标为完整。preview/execute 共用非阻塞作业闸；Shelf producer 与清理、过期孤儿回收共享写入/维护闸，冲突返回 `CLEANUP_BUSY`。
- 前端定向用例：`npx vitest run src/components/settings/ResourceCleanupSection.test.tsx src/components/settings/AudioSettings.test.tsx src/lib/settingsSections.test.ts src/components/settings/SettingsPanel.test.tsx`（工作目录仓库根）。Rust 用例从 `src-tauri/` 内按模块过滤运行；完整环境/验收限制见 [资源清理说明](RESOURCE_CLEANUP.md) 与 `tmp/acceptance/resource-cleaner/report.md`。

## 诊断日志命令速查（2026-11-06）

技术说明与字段/级别/隐私规范见 [DIAGNOSTICS.md](DIAGNOSTICS.md)。日常排查只需要其中一条命令：

| 命令 | 参数 | 用途 |
|---|---|---|
| `diagnostics_status` | — | 会话 ID、日志目录、容量、写入/丢弃/聚合/轮转计数、详细模式剩余时间 |
| `diagnostics_query` | `{ filter }`（`levels/modules/errorCodes/statuses/windowIds/operationId/text/since/until/limit/offset`） | 分页查询（新→旧） |
| `diagnostics_summary` | `{ filter }` | 按 模块+操作+错误码 聚合的异常摘要 |
| `diagnostics_export` | `{ filter }` | 生成脱敏报告到 `<日志目录>/exports/`，返回路径/字节/条数 |
| `diagnostics_clear` | — | 只删诊断日志文件 |
| `diagnostics_open_dir` | — | 资源管理器打开日志目录 |
| `diagnostics_set_mode` | `{ mode: "normal"\|"verbose", minutes? }` | 详细诊断（默认 30 分钟，最长 120，自动恢复） |
| `diagnostics_record` | `{ events }` | 前端批量上报（上限 256/批，非法条目计入 `rejected`） |

本地证据位置（隔离实例）：`TASK_DOCK_DATA_DIR=<dir>` 时全部落在 `<dir>/diagnostics/`；
Windows 正式运行默认 `%APPDATA%\com.taskdock.desktop\diagnostics\`。

**操作链查询**：诊断中心的「查看操作链」使用
`diagnostics_query({ operationId, limit: 200, offset: 0 })`，**不得**带 `levels`、
`anomaliesOnly` 或时间范围，否则 INFO/DEBUG 阶段会被过滤掉；结果为新→旧，UI 负责升序。
超过 200 条时只保留最新部分，界面必须提示更早事件（可能含 `started`）缺失。

**HTTP 接入日志**：401 鉴权失败按 10s 窗口聚合为一条 WARN（含累计次数），
`stats().rejected_auth` 保留安全审计计数；非 401 请求只在详细模式记 DEBUG。端口被占用时
适配器每 10s 重试，日志只记首次与每 30 次，避免每小时数百条同指纹 ERROR。

验收/排查常用检查：

```bash
# 最近 5 条错误（需要应用正在运行、主窗口已就绪的 CDP/脚本环境）
# 也可直接查看 JSONL（每行一个事件，字段见 docs/DIAGNOSTICS.md §3）
tail -n 5 "%APPDATA%\com.taskdock.desktop\diagnostics\diagnostics-active.jsonl"
```

注意：诊断日志默认不记录 INFO 以下的 `tracing` 事件；需要更细粒度时先在设置页开启
「详细诊断」，排查完会到期自动恢复，避免长期噪声。
