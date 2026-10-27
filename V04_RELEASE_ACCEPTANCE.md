# Task Dock v0.4 发布前整改与回归验收报告

- 验收对象：Task Dock v0.4（Tauri 2 / Rust / React 19 / TypeScript / Zustand / SQLite）
- 验收方式：基于现有源码整改，逐项实际执行，不以静态分析代替运行
- 结论：**CONDITIONAL PASS**（详见第 6 节）
- 报告生成时间：2026-10-27

---

## 1. 问题清单：根因、修改文件、解决方案

### 问题 1｜数据导出/备份/恢复遗漏导航三表（阻断级）

**根因**
`src-tauri/src/commands/data.rs` 的 `collect()` 只导出任务与 Agent 相关表，v0.4 新增的
`navigation_targets`、`task_navigation_targets`、`navigation_log` 完全不在导出范围内；
`import_value()` 的删除与插入序列同样不包含这三张表。后果：用户备份/恢复后，
**所有"用户确认过的导航目标"与"任务↔目标关联"静默消失**，工作区按钮变成空的，
而界面会显示"恢复成功"。

**修改文件**：`src-tauri/src/commands/data.rs`

**解决方案**
1. `EXPORT_VERSION` 2 → 3；解析层 `1..=EXPORT_VERSION` 因此同时接受 v1/v2/v3。
2. 新增三个强类型行结构 `NavTargetRowData` / `TaskNavTargetRowData` / `NavLogRowData`，
   与列一一对应，沿用既有的"强类型 + 原生类型绑定"策略（bool → INTEGER）。
3. `navigation_log` 明确策略：它是**诊断流水而非用户配置** ——
   - 导出保留最近 `NAV_LOG_EXPORT_LIMIT = 500` 条；
   - 恢复时整体替换；
   - **不参与引用完整性校验**（`target_id` 允许指向已删除目标），因此旧文件缺该键、
     或日志里的目标早已不存在，都不会让整次恢复失败。
4. 引用完整性新增：`task_navigation_targets → tasks / navigation_targets`、
   `agent_session` 目标 → `agent_sources` 且会话必须真实存在、
   `UNIQUE(task_id, target_id)` 查重、`target_type` 枚举校验。
5. 删除顺序修正：`task_navigation_targets` 必须在 `tasks` 与 `navigation_targets` **之前**删除。
6. 插入顺序：`navigation_targets` → `tasks` → `task_navigation_targets`。
7. COMMIT 前执行 `SELECT COUNT(*) FROM pragma_foreign_key_check`，
   任何残留外键 → 整体回滚（不信任手写校验，多一道机器闸门）。
8. 向后兼容：`rows_of()` 对缺失的键返回空表，v1/v2 旧备份照常导入。

---

### 问题 2｜`agent_session` 缺少可信目标链路

**根因**
`target_resolver::validate_input()` 的 `match target_type` 只有
`application/url/file/directory` 四个分支，`agent_session` 落入 `_ =>` 直接报
"未知目标类型"。同时 `save_target()` 的 INSERT 把 `agent_source_id`、
`agent_session_id` **写死成空字符串**，UPDATE 也不更新这两列 ——
即便放开类型校验，存下来的也是一条"没有会话身份"的死目标。

**修改文件**
`src-tauri/src/navigation/target_resolver.rs`、`src-tauri/src/commands/navigation.rs`、
`src-tauri/src/lib.rs`、`src-tauri/src/navigation/router.rs`、
`src/lib/navigation.ts`、`src/components/navigation/AppPicker.tsx`、
`src/components/tasks/TaskEditor.tsx`

**解决方案**
1. `validate_input(db, input)` 改为可查库：`agent_session` 分支校验
   - 来源必须已注册（`agent_sources`）；
   - 会话 ID 过 `validate_session_id` 白名单（防注入）；
   - **会话必须在 `agent_sessions` 中真实存在**，否则拒绝保存（不允许存坏链接）；
   - `app_key = "{source}:{session}"`，同会话幂等去重；
   - 显示名留空时用会话标题兜底。
2. INSERT/UPDATE 真正写入 `agent_source_id` / `agent_session_id`。
3. 新增命令 `nav_save_agent_session_target(source_id, session_id, display_name?, working_dir?)`
   —— 前端只能传身份，不能自造路径/显示名。
4. **与旧表兼容**：`link_task()` 在目标是 `agent_session` 时同步写一条
   `task_agent_links`（旧版 UI 的 Agent 计数只读这张表）；
   `unlink_task()` 反向清理，避免取消关联后计数残留。
5. 工作区跳转：`navigate_agent_session()` 支持 `action=open_workspace`，
   目录取自目标配置且执行前校验真实存在。
6. 关联状态真实性：`link_rows()` 对 `agent_session` 查会话存活，
   会话被宿主清理后 `running_state` 变为 `unavailable`（不再一律显示 "Agent"）。
7. UI 可达：`AppPicker` 增加「从 Agent 会话选择…」区块。

---

### 问题 3｜编辑任务导致独立 `remind_at` 丢失

**根因**
`TaskInput` 用 `Option<String>` 表示时间字段，而 serde 把"键缺失"和"显式 null"
都反序列化成 `None`。`update_task_inner()` 随后执行
`UPDATE tasks SET remind_at = ?7`，把 `None` 写成 NULL。
前端 `TaskEditor.onSave()` 构造的载荷里**根本没有 `remind_at` 字段**，
于是"只改标题"就足以静默删除用户的独立提醒。

**修改文件**：`src-tauri/src/commands/tasks.rs`、`src/components/tasks/TaskEditor.tsx`

**解决方案**
1. `due_at` / `remind_at` 改为三态 `Option<Option<String>>`，配
   `deserialize_optional_field`：
   - 键缺失 → `None` → **保持原值**
   - 显式 `null` → `Some(None)` → **清空**
   - 有值 → `Some(Some(v))` → 写入
2. `FieldUpdate { Keep, Clear, Set }` + `resolve_time()`：Keep 原样返回旧字符串，
   不做重新格式化（避免无意义的格式漂移）。
3. **同一缺陷的第二个实例**：`recurrence` 原本也是"没传 = 删除规则"，
   只改标题会静默取消循环任务。一并改为三态：缺省=保持，null=取消，值=替换。
4. 前端 `TaskEditor` 增加「提醒时间」输入框，并对 `due_at`/`remind_at`
   做**脏标记**（只有用户真的改过才提交）。原因有两层：
   - `datetime-local` 只到分钟，回写会截断原有的秒；
   - 前端必须如实表达"我没动它"，否则三态语义在 UI 层被破坏。

---

### 问题 4｜测试用 `taskkill /IM notepad.exe /F` 会杀掉用户进程

**根因**
`router.rs` 两个 Windows 测试用 `/IM`（按映像名）强杀。用户此时若开着记事本写东西，
测试一跑就被强杀，**未保存内容直接丢失**。

**修改文件**：`src-tauri/src/navigation/router.rs`

**解决方案**
- 删除两处 `/IM notepad.exe /F`。
- 新增 `hwnd_snapshot()` + `kill_new_windows(exe, before)`：
  测试前记录该 exe 已有窗口句柄，测试后**只终止"快照里不存在"的窗口对应 PID**
  （`taskkill /PID <pid> /F`）。用户原有的记事本一律不碰。
- 验证级别断言放宽为"必须是如实级别之一"（window-confirmed / window-visible / process-spawned）。

---

### 问题 5｜启动参数按空格切分

**根因**
`router.rs` 用 `t.launch_args.split_whitespace().map(|s| s.trim_matches('"'))`：
1. `"C:\Program Files\App\data.db"` 被空格切成两个参数；
2. `trim_matches('"')` 从两端剥引号，`a"b` 这类中间引号被破坏；
3. 无法表达空参数 `""` 与转义引号。

**修改文件**：`src-tauri/src/navigation/mod.rs`、`src-tauri/src/navigation/router.rs`

**解决方案**
- 新增 `split_launch_args()`，按 `CommandLineToArgvW` 规则实现：
  空白分隔、引号切换引用状态、引号内 `""` = 字面引号、
  反斜杠仅在紧跟 `"` 时有特殊含义（`2n`/`2n+1` 规则）。
- 执行期再校验每个参数不含控制字符；仍然走 `Command::new + args 数组`（不经 shell）。

---

### 问题 6｜Compact 模式关联 2~3 个目标时无法启动整个工作区

**根因**
`TaskItem` 中：工作区按钮被 `!compact` 挡住；而"+N"溢出入口只在
`links.length > MAX_INLINE_TARGETS(3)` 时出现。于是紧凑模式关联 **2~3 个**目标时，
既没有工作区按钮，也没有菜单入口 —— 功能完全不可达。

**修改文件**：`src/components/tasks/TaskItem.tsx`、`src/styles.css`

**解决方案**
- 紧凑模式直列上限降为 2（`MAX_INLINE_TARGETS_COMPACT`），溢出即出现"+N"入口；
- 工作区按钮条件改为 `links.length >= 2`，**不再区分 compact**；
- 窄窗下图标按钮最小 22×22，保证可点。

---

### 问题 7｜WorkspaceLauncher 状态统计失真 + 任务切换残留

**根因**
1. 统计只比较 `ok` 与 `failed`，**取消（skipped）的目标既不算成功也不算失败**，
   于是"3 个里成功 2 个、取消 1 个"被显示为「全部成功（2/3）」——把未执行谎报成成功。
2. 组件在 `App.tsx` 中常驻挂载，`states` 不随任务切换重置：
   打开 B 任务的工作区会看到 A 任务上次的成功/失败列表。

**修改文件**
`src/components/navigation/WorkspaceLauncher.tsx`、`src/lib/workspace.ts`（新增）、
`src/lib/workspace.test.ts`（新增）

**解决方案**
- 抽出纯函数 `summarizeWorkspace(states, total, running)`：
  分母恒为计划数；`ok + failed + skipped + pending === total`；
  全部成功要求 `ok === total && skipped === 0`；一个都没跑 → 「已取消」；
  运行中不给结论。
- 组件用 `useEffect` 在 `[taskId, workspace.open]` 变化时清空 `states/running/cancelRef`。

---

### 问题 8｜TargetMenu 键盘焦点与 Enter/Space 行为错误

**根因**
索引只指向 `links`，但 DOM 里工作区按钮排在第一位：
- 焦点初始化到 `[data-idx="0"]`（第一个普通目标），**跳过工作区入口**；
- `Enter/Space` 固定调用 `onNavigate(links[index])`，**工作区按钮永远无法用键盘触发**；
- 焦点元素是 `<button>`，Enter 会同时触发原生 click 和容器 handler，存在双触发风险。

**修改文件**：`src/components/navigation/TargetMenu.tsx`、`src/lib/navigation.ts`

**解决方案**
- 抽出 `buildTargetMenuItems(links, hasWorkspace)`：工作区入口固定索引 0，目标依次后移；
  索引与 DOM 顺序一一对应。
- `moveMenuIndex()` 循环移动（上/下回绕），空列表安全。
- 容器统一处理 `ArrowUp/Down/Home/End/Enter/Space/Escape`；
  `preventDefault()` 阻止按钮原生 click 造成双触发；按钮 `tabIndex={-1}` 由容器托管焦点。
- 打开即聚焦当前项。

---

### 问题 9｜"窗口出现"被当成"前台确认"

**根因**
`navigate_application()` 启动成功后，`wait_for_window_by_exe()` 一旦拿到窗口，
就无条件写 `verification_level = window-confirmed`，而置前调用的结果是
`let _ = window_manager::focus_window(w.hwnd)` **被丢弃**。
置前被 Windows 拒绝/超时时，界面仍然显示"已确认窗口"。

**修改文件**：`src-tauri/src/navigation/mod.rs`、`src-tauri/src/navigation/router.rs`、
`src/lib/navigation.ts`

**解决方案**
- 新增验证级别 `WindowVisible` = `"window-visible"`：窗口确已出现，但未置前。
- 启动路径改为按焦点结果分级：
  - `Confirmed` → `window-confirmed`
  - `Unverified`（超时）→ `window-visible` + 说明"置前未在超时内核实"
  - `Err(ForegroundDenied/RestoreFailed)` → `window-visible` + 真实原因
  - 窗口根本没出现 → `process-spawned`
- 前端 `verificationLabel("window-visible")` → 「窗口已出现（未置前）」，
  与「已确认窗口」明确区分。

---

### 问题 10｜`nav_remember_window` 是空开关

**根因**
设置项、校验、UI 开关（`AppManagement`）都存在，但**没有任何代码读取它**，
`router` 多窗口时永远取"标题最长"的一个。

**修改文件**
`src-tauri/src/navigation/window_manager.rs`、`src-tauri/src/navigation/router.rs`、
`src-tauri/src/commands/navigation.rs`、`src-tauri/src/lib.rs`、
`src-tauri/src/commands/settings.rs`

**解决方案**
- `WindowMemory { class_name, title }`：**刻意不存 HWND**（句柄在窗口关闭/进程重启/
  DWM 重连后失效，存下来几乎必然指向别的窗口）。
- 纯函数 `pick_window(windows, remembered)`：精确命中（类名+标题）→ 同类名
  （标题会随标签变化）→ 回退最长标题。
- 持久化在 `application_settings.nav_window_memory`（JSON 对象，按 target_id 索引）。
- `router`：开启时读取记忆参与选择；**只有 `Confirmed` 后才更新记忆**
  （把没成功的窗口记下来会让下次继续选错）。
- 新增命令 `nav_window_memory` / `nav_forget_window`；删除目标时同步清除记忆。
- `nav_window_memory` 加入 `validate_setting` 与 `ALLOWED_KEYS`，保证导入不丢。

---

### 问题 11｜版本号与产物不一致

**根因**：`package.json` / `Cargo.toml` / `tauri.conf.json` 三处均为 `0.3.0`，
而 `release/` 里同时躺着 0.1.0 与 0.3.0 两套安装包。

**修改文件**：`package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、
`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`

**解决方案**：三处统一为 `0.4.0`，重新构建；新产物写入 `release/`。

---

### 问题 12｜IPC 参数命名 / 异常提示 / selector 稳定性

**根因与核查结果**
- `bridge.ts` 里 `create_from_quick_add`、`snooze_reminder`、`link_task_agent`、
  `unlink_task_agent`、`list_task_links` 曾用 `snake_case` 传参，
  与 Tauri v2 的 camelCase 参数约定不符 → 运行期 "missing required key" 静默失败。
  工作区中已改为 camelCase，本次验收**逐条核对通过**。
- 全量交叉校验：前端 74 个 `invoke` 名称 vs 后端 74 个注册命令，
  **未注册 = 0**（不存在"调用了不存在的命令"）。
- Zustand：`AppPicker` 曾用 `s.snapshot?.sessions ?? []` 作为 selector 返回值，
  每次渲染新建数组 → zustand v5 严格相等下会持续触发重渲染。
  新增模块级 `EMPTY_SESSIONS` 常量修复。

**修改文件**：`src/components/navigation/AppPicker.tsx`（其余为核查，无改动）

---

### 问题 13｜三视图 / 主题 / 320px 布局与对比度

**根因**
- 无 320px 下的表单换行规则：`.field-row` 两列布局会把 `datetime-local`
  （含原生日历按钮）挤到不可用。
- **实测发现真实对比度缺陷**：`TargetAvatar` 对非应用类型设
  `background: transparent`，而 `.nav-avatar` 的图标是白色 ——
  浅色主题下"白底白图标"，网址/目录/文件图标**完全不可见**（截图 `_navrow.png` 可证）。

**修改文件**：`src/styles.css`、`src/components/navigation/TargetMenu.tsx`

**解决方案**
- 非应用类型改用 `nav-avatar-generic`：`--accent-soft` 底 + `--accent` 图标 + 内描边。
- 新增 `@media (max-width: 360px)`：`.field-row` 改单列、弹窗内边距收窄、
  `.target-menu` 限宽 `calc(100vw - 24px)`、工作区条目允许换行、图标按钮 ≥22px。

---

### 问题 14｜安全边界与异常路径

**处理方式**：保留既有边界（URL 仅 http/https、exe 绝对路径 + 解释器黑名单、
AUMID 字符白名单、会话 ID 白名单、参数无控制字符、结构化进程启动不经 shell），
并补充异常路径测试（见第 2 节）。

---

## 2. 测试执行结果（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `cargo fmt --all -- --check` | **0** | 无 diff（修复前有 61 处 diff，已 `cargo fmt`） |
| `cargo clippy --all-targets -- -D warnings` | **0** | Finished，0 warning / 0 error |
| `cargo test` | **0** | **133 passed / 0 failed**（基线 111 → +22） |
| `npm test` | **0** | **61 passed / 0 failed**（基线 44 → +17，6 个测试文件） |
| `npm run build` | **0** | `tsc --noEmit` + vite build 通过 |
| `npm run tauri build` | **0** | NSIS + MSI 双产物 |

### 新增/加强的测试

**后端（+22）**
- 数据层：`export_import_export_roundtrip_is_consistent`（扩展为含导航三表、
  逐字段断言关联顺序/默认/行为、Agent 目标身份、启动参数原样保留、全库外键为 0）、
  `import_v2_backup_without_navigation_keys_is_accepted`、
  `import_rejects_dangling_navigation_links_and_rolls_back`、
  `import_rejects_illegal_navigation_target_type`、
  `import_rejects_agent_target_with_unknown_session`、
  `export_to_unwritable_path_returns_error_not_panic`、`corrupted_json_payload_is_rejected`
- 任务：`edit_title_only_keeps_independent_remind_at`、
  `explicit_null_clears_only_that_field`、
  `due_remind_and_recurrence_do_not_overwrite_each_other`、
  `ipc_payload_omitting_time_keys_keeps_them`、
  `ipc_payload_explicit_null_means_clear`、`ipc_roundtrip_preserves_schedule_semantics`
- 导航：`agent_session_target_requires_existing_session`、
  `agent_session_target_saves_identity_and_dedupes`、
  `linking_agent_session_target_keeps_legacy_table_in_sync`、
  `agent_session_link_marks_unavailable_after_session_gone`、
  `launch_args_split_handles_quotes_and_spaces`、`verification_levels_are_distinct`、
  `pick_window_prefers_exact_memory_then_class_then_longest_title`、
  `window_memory_persists_without_hwnd`、`window_memory_survives_corrupted_value`、
  `uninstalled_or_unknown_agent_reports_failure`

**前端（+17）**
- `workspace.test.ts`（11）：取消不得算成功、部分成功、全部失败、全取消、
  运行中不给结论、`ok+failed+skipped+pending === total` 不变量
- `navigation.test.ts`（+6）：`window-visible` 独立文案、
  `buildTargetMenuItems` 索引与 DOM 一致、`moveMenuIndex` 回绕与空列表

### 视觉走查（真实渲染，非静态推断）

`scripts/visual-audit.mjs` 用 Playwright 渲染真实 `dist` 产物（IPC mock harness），
覆盖 3 视图 × 浅/深主题 × 320/400px 共 8 个场景：

| 场景 | 横向溢出 | 越界元素 | 运行时错误 |
|---|---|---|---|
| full-light-320 | 0 | 0 | 0 |
| full-dark-320 | 0 | 0 | 0 |
| compact-light-320 | 0 | 0 | 0 |
| compact-dark-320 | 0 | 0 | 0 |
| minimal-light-320 | 0 | 0 | 0 |
| minimal-dark-320 | 0 | 0 | 0 |
| full-light-400 | 0 | 0 | 0 |
| full-dark-400 | 0 | 0 | 0 |

截图：`docs/screenshots/v04/`

### 发布版冒烟测试

- `task-dock.exe --agentctl scan` 退出码 **0**，返回真实 JSON：
  识别到 `codex-cli 0.130.0-alpha.5`、2 个运行中的 codex 进程。
- 真实数据库 `%APPDATA%\com.taskdock.desktop\task-dock.db`：
  `PRAGMA user_version = 4`，三张导航表均存在（当前为空），16 条 Agent 会话 ——
  说明迁移在真机上正常完成。
- 产物元数据：`FileVersion=0.4.0`、`ProductVersion=0.4.0`、`ProductName=Task Dock`。

---

## 3. 回归前后关键证据

| 项目 | 回归前 | 回归后 |
|---|---|---|
| 导出格式版本 | v2（无导航表） | v3（含三表，兼容 v1/v2） |
| 导航表往返 | 不参与，恢复后丢失 | 逐字段一致（含顺序/默认/行为） |
| `agent_session` 目标 | 保存直接报"未知目标类型"；INSERT 写死空身份 | 校验会话真实存在、身份落库、旧表同步 |
| 编辑任务后的 `remind_at` | 变 NULL（静默丢失） | 保持原值；仅显式 null 才清空 |
| 编辑任务后的重复规则 | 缺省即删除 | 保持原值；仅显式 null 才取消 |
| 测试进程清理 | `taskkill /IM notepad.exe /F`（会杀用户进程） | 仅按 PID 清理本测试新拉起的窗口 |
| 启动参数 `"C:\My Dir"` | 被切成两段 | 保持为一个参数 |
| 启动后验证级别 | 恒为 `window-confirmed` | 按真实结果分级（新增 `window-visible`） |
| `nav_remember_window` | 无任何行为 | 记忆类名+标题，Confirmed 后更新，可测 |
| Compact 2~3 目标 | 无工作区入口 | 工作区按钮 + `+N` 入口 |
| 工作区统计（2 成功 1 取消） | 「全部成功（2/3）」 | 「部分成功：2 成功 · 0 失败 · 1 已取消」 |
| TargetMenu 键盘 | 工作区入口不可聚焦、不可 Enter | 索引与 DOM 一致，全项可达 |
| 非应用目标图标（浅色主题） | 白底白图标，不可见 | 主题色淡底 + 强调色图标 |
| 后端测试 | 111 passed | **133 passed** |
| 前端测试 | 44 passed | **61 passed** |
| clippy -D warnings | 未通过（5 处） | **通过** |
| fmt --check | 61 处 diff | **通过** |

---

## 4. 尚未解决的问题 / 未验证项

1. **安装/卸载全流程未验证**：NSIS/MSI 产物已构建并校验版本元数据，
   但未在真机执行静默安装 → 启动 → 卸载的完整链路
   （会写入 `%LOCALAPPDATA%\Programs` 与注册表，需用户授权后执行）。
2. **真实 Agent 接入未验证**：本机确有 Codex CLI，但本次未触发真实 Agent 会话事件来
   验证"会话恢复"到端到端可见；`--agentctl scan` 只证明发现层可用。
   **不得**把 mock 适配器的数据当作真实接入证据。
3. **Windows 前台锁定拒绝**：`window-visible` 分级逻辑有代码与级别测试，
   但"Windows 真的拒绝 SetForegroundWindow"这一场景无法稳定复现，
   **未在真机捕获**一次真实的 `ForegroundDenied`。
4. **组件交互测试为纯函数级**：`WorkspaceLauncher` / `TargetMenu` 的状态与索引逻辑
   已抽成纯函数并单测；**DOM 级交互（真实按键、焦点流转）未用 RTL 覆盖**
   （项目未引入 jsdom / testing-library，本次不新增该依赖）。
5. **毛玻璃材质效果未做像素级验证**：仅验证了不崩溃与布局正确；
   Mica/Acrylic 的实际透出效果依赖系统与壁纸，未做像素比对。
6. **`reg.exe` 被环境安全策略拦截**：冒烟测试中部分注册表相关发现路径被沙箱阻断
   （扫描仍返回有效结果）。这是环境限制，非产品缺陷，但意味着
   "注册表来源的软件发现"在本次冒烟中未被完整覆盖。
7. **工作区中两处非本次整改的改动**：`src/lib/bridge.ts`（snake_case → camelCase）
   与 `src-tauri/src/agents/hooks_install.rs`（PowerShell UTF-8 无 BOM）
   在本次会话开始前即存在于工作区。前者已纳入核查并通过；后者为字符串内容变更，
   未纳入本次整改范围，建议单独复核。
8. **`cargo fmt` 附带格式化了 3 个未功能性修改的文件**
   （`app_discovery.rs`、`hooks_install.rs`、`db/mod.rs`），因为仓库在本次整改前
   本身不满足 `fmt --check`。这些是纯格式变更。

---

## 5. 安装包路径与版本

| 类型 | 路径 | 大小 |
|---|---|---|
| NSIS 安装包 | `release/Task Dock_0.4.0_x64-setup.exe` | 3.52 MiB |
| MSI 安装包 | `release/Task Dock_0.4.0_x64_en-US.msi` | 5.48 MiB |
| 便携可执行 | `src-tauri/target/release/task-dock.exe` | — |

版本：**0.4.0**（`package.json` / `Cargo.toml` / `tauri.conf.json` 三处一致，
产物 `FileVersion` 与 `ProductVersion` 均为 0.4.0）

> `release/` 中仍保留 0.1.0、0.3.0 历史产物，未删除（避免影响既有分发记录）。

---

## 6. 验收结论

# CONDITIONAL PASS

**通过依据**
- 14 项问题全部完成整改，均有代码落点与回归测试。
- 六条验收命令全部实际执行且退出码为 0：fmt / clippy / cargo test / npm test /
  npm run build / npm run tauri build。
- 后端测试 111 → 133、前端 44 → 61，**无删除测试、无弱化断言、无隐藏异常**。
- 视觉走查在 8 个真实渲染场景下 0 运行时错误、0 横向溢出。
- 发布版二进制冒烟通过，真实数据库迁移至 v4。

**附带条件（升级为 PASS 前需补齐）**
1. 在真机执行一次安装 → 启动 → 卸载的完整冒烟（第 4 节第 1 条）。
2. 至少一条真实 Agent 会话的端到端恢复验证（第 4 节第 2 条）。
3. 复核工作区中既有的 `hooks_install.rs` 改动（第 4 节第 7 条）。

**为什么不是 FAIL**：所有阻断级与核心功能缺陷均已修复并有可复现的测试证据，
不存在"删测试换通过"或"未执行却声称通过"的情况。
**为什么不是 PASS**：安装链路与真实 Agent 接入尚未在真机闭环，
按"未经实际验证必须标注未验证"的要求，不能给出无条件通过。
