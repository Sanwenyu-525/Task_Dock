# Task Dock v0.4 交付报告 — 统一应用跳转、窗口唤醒、Agent 会话恢复与任务工作区

> 交付日期：2026-10-26 · 交付物：源码升级 + 测试 + 文档 + 正式安装包
> 环境实录：Windows 11 · Rust 1.95.0 (MSVC) · Node 22.22.2 · 全部测试与构建在本机真实执行

## 1. 架构修改摘要

Task Dock 从「悬浮任务栏 + Agent 监控器」升级为「任务驱动的桌面工作中枢」。核心是新增**统一导航系统**（`src-tauri/src/navigation/`），与既有 Agent 观测层（`agents/`）完全解耦——观测层只产生事件，导航层只负责把用户送到正确的窗口/页面/会话：

- **NavigationRouter（router.rs）**：`navigate(db, app, target_id, options)` 唯一入口，按目标类型分发四层动作（L1 启动软件 → L2 唤醒正确窗口 → L3 打开网页/文件/目录 → L4 恢复 Agent 会话），按用户偏好降级，每个结果携带 `verification_level` 与 `fallback_used`。
- **WindowManager（window_manager.rs）**：EnumWindows 顶层窗口枚举（排除工具窗口/UWP cloaked）、`QueryFullProcessImageNameW` 进程身份关联、最小化恢复 + SetForegroundWindow 前台切换（被拒时 ALT 解锁重试一次后如实报错）、前台句柄轮询核实。HWND/PID 只作运行时身份绝不落库。
- **AppDiscoveryService（app_discovery.rs）**：开始菜单 .lnk（lnk crate，catch_unwind 隔离畸形文件）+ 卸载注册表（winreg）+ UWP（Get-StartApps 单次调用 8s 超时）+ 常用软件路径。只扫明确位置、不全盘搜索；带 5 分钟缓存；浏览器渲染进程不构成独立应用。
- **TargetResolver（target_resolver.rs）**：目标持久化与任务关联。`navigation_targets` 保存用户确认过的启动配置（app_key 幂等去重），`task_navigation_targets` 让任务关联任意目标（顺序/默认/跳转行为），与既有 `task_agent_links` 并存互补。
- **AgentNavigationAdapter（agent_navigation.rs）**：每个 Agent 的启动/唤醒/工作区/会话恢复能力**全部证据化**（exe-found / cli-help-probed / baseline-verified / unsupported-interface），无官方接口的诚实降级，不臆造 Deep Link。
- **验证分级哲学**：`window-confirmed` > `process-spawned` > `launch-requested` > `delegated`，任何地方都不把「进程已启动」冒充「窗口已确认」。

## 2. 具体修改文件

**Rust 新增**
| 文件 | 内容 |
|---|---|
| `src-tauri/src/navigation/mod.rs` | 目标类型/动作常量/NavigationResult/验证级别 + 安全校验（exe/URL/AUMID/args/路径）+ 4 测试 |
| `src-tauri/src/navigation/window_manager.rs` | 窗口枚举/匹配/等待/焦点控制 + 5 测试（真机） |
| `src-tauri/src/navigation/app_discovery.rs` | 四源扫描/分类/中文标题提示/运行状态分级 + 5 测试（含真机扫描） |
| `src-tauri/src/navigation/target_resolver.rs` | 目标/关联/日志 CRUD + 校验 + 6 测试 |
| `src-tauri/src/navigation/router.rs` | L1~L4 执行与降级 + 5 测试（含真机 notepad 启动/禁启分支） |
| `src-tauri/src/navigation/agent_navigation.rs` | 证据化能力 + resume/launch/focus/workspace + 5 测试 |
| `src-tauri/src/commands/navigation.rs` | 17 个 nav_* 命令（重操作 spawn_blocking） |

**Rust 修改**：`db/mod.rs`（迁移 v4 + nav_* 设置字段）、`commands/settings.rs`（白名单+校验）、`commands/agents.rs`（open_agent_session 走统一导航并返回结构化结果）、`commands/mod.rs`、`lib.rs`（模块注册 + 17 命令）、`agents/managed.rs`（进程名快照公开包装）、`agents/codex.rs`（旧 open_session 移除，职责归位）、`Cargo.toml`（windows-sys 0.60 对齐既有版本 / winreg 0.55 / lnk 0.5，零新增大型框架）。

**前端新增**：`lib/navigation.ts`（类型化桥接 + 展示纯函数）、`store/useNavigationStore.ts`（扫描缓存/任务关联映射，无轮询）、`components/navigation/TargetMenu.tsx`（键盘可操作快捷菜单 + 工作区入口）、`components/navigation/AppPicker.tsx`（搜索/分类/当前窗口/最近收藏/手动登记）、`components/navigation/WorkspaceLauncher.tsx`（顺序批量启动/独立反馈/可取消/部分成功区分）、`components/settings/AppManagement.tsx`（导航偏好/目标管理/跳转记录）、`lib/navigation.test.ts`（7 测试）。

**前端修改**：`TaskItem.tsx`（≤3 直列目标图标 + 折叠菜单 + 工作区按钮，点击应用≠任务完成）、`TaskEditor.tsx`（关联目标编辑区：行为/默认/排序/删除/添加）、`AgentPanel.tsx`（**修复 SessionNode 嵌套 button**——行容器改为 div + 兄弟按钮；Agent 行加「打开应用」、实例行加「唤醒窗口」、会话行跳转按能力降级展示）、`SettingsPanel.tsx`、`App.tsx`、`useUiStore.ts`（工作区弹窗状态）、`bridge.ts`（Settings 扩展 + openAgentSession 类型）、`styles.css`（+330 行导航样式，复用主题变量适配三模式×三主题）。

## 3. 数据库迁移说明（v3 → v4，幂等可验证）

- `navigation_targets`：`app_key + target_type` 幂等去重（同身份重复保存=更新）；类型 CHECK 约束五类。
- `task_navigation_targets`：`UNIQUE(task_id, target_id)`；`launch_behavior` CHECK（default/focus_or_launch/launch/resume_session/open）；任务删除级联。
- `navigation_log`：执行流水（失败记录供管理页回看），可清理保留 N 条。
- **既有数据不动**：`task_agent_links` 与全部 v0.1~0.3 表原样保留（迁移单测断言 + 真实库冒烟验证：9 条 agent_sessions 完整、外键零违反）。
- 迁移沿用既有原子机制（DDL + user_version 同事务，失败整体回滚可重试）。

## 4. UI 改进摘要

- 任务卡：关联目标图标行（类型图标+首字母色块头像+运行状态角标），最多 3 个直列，其余折叠「+N」进快捷菜单；菜单含「打开工作区」批量入口；失效目标以虚线红标呈现。
- 任务编辑器：新增「关联目标」区（添加/行为选择/默认星标/上下移序/解除关联），与原 Agent 会话关联区并存。
- Agent 监控树：三级行结构重构（消除嵌套 button，aria-expanded 语义保留）；Agent 级「打开应用」、实例级「唤醒窗口」、会话级跳转按钮按**动态探测的能力**启用/降级并带说明 tooltip。
- 设置页新增「应用与快捷方式」：6 项导航偏好、目标管理（收藏/隐藏/测试跳转/删除）、最近导航记录（含失败原因与降级标记）。
- 兼容 Minimal/Compact/Full × 浅色/深色/毛玻璃：全部复用既有 CSS 变量与断点（紧凑模式图标 16px、<360px 菜单左对齐）。预览 harness 已补导航 fixture（`node scripts/make-preview.mjs` 后 `npx vite preview` 可走查）。

## 5. 软件与 Agent 能力覆盖矩阵

详见 [APP_NAVIGATION_MATRIX.md](APP_NAVIGATION_MATRIX.md)（通用应用）与 [AGENT_COVERAGE_MATRIX.md](AGENT_COVERAGE_MATRIX.md)（Agent 跳转能力新增节）。要点：

| 能力 | 状态 | 证据 |
|---|---|---|
| 任意 Win32 应用启动/唤醒 | ✅ 已实现+真机单测 | notepad 真机 spawn→窗口确认；禁启分支验证 |
| 微信/QQ/酷狗等 | ✅ 通道级实现（启动+唤醒） | 标题提示匹配「微信/酷狗」等；内部定位明确不做 |
| 浏览器打开 URL | ✅ 实现 | 指定浏览器 exe 参数传递 / 系统默认委托 opener；标签页定位不做 |
| 文件/目录/资源管理器定位 | ✅ 实现 | opener 委托 / `explorer /select,` |
| UWP 商店应用 | ✅ 实现 | shell:AppsFolder（AUMID 白名单校验） |
| Codex 会话恢复 | ✅ | `codex resume <id>`，0.130.0 实测基线；无 CLI 时降级唤醒 App |
| OpenCode 会话恢复 | ⚠️ 动态 | CLI 帮助探测支持会话 ID 参数才启用，否则降级打开 TUI |
| Trae/Qoder/WorkBuddy/DSH/ZCode | 启动+唤醒 ✅；工作区 ⚠️（CLI 惯例）；会话恢复 ❌ 诚实不支持 | 证据化标注，不臆造 |

## 6. 安全检查结果

- 恶意命令参数被拒绝 ✅（单测：相对路径/非 exe/不存在/cmd、powershell、mshta 等黑名单全拒）
- 危险协议不执行 ✅（单测：file:/javascript:/ms-settings:/控制字符/超长 URL 全拒；库内篡改后执行时重校验拦截）
- 非法路径正确处理 ✅（绝对路径+存在性双重校验；失效目标标 unavailable 并拒绝执行）
- 不可信 Agent 事件不能控制进程启动 ✅（导航只读用户确认的 DB 配置；resume 要求会话存在于本地观测库；事件携带路径/命令永不执行）
- 不因任务通知意外启动软件 ✅（提醒调度路径与导航零交集）
- 全程结构化进程参数（args 数组），不拼接 shell 字符串 ✅；批量启动数量上限（默认 8，1~20 可调）✅

## 7. 性能影响

- 扫描低频：四源扫描仅在用户打开选择器（缓存 5 分钟）或手动刷新时执行，本机实测整轮 <4s（进程内缓存后 0ms）。
- 运行状态按需刷新：仅在任务列表刷新/选择器打开时计算，无定时器、无高频轮询；悬浮栏空闲 CPU 零新增。
- 三级缓存：窗口枚举 1.2s TTL / 进程快照 3s TTL（复用既有 tasklist 缓存）/ 扫描 5 分钟 TTL。
- 重操作（扫描/跳转等待窗口）在 spawn_blocking 线程池，不阻塞 IPC 与 UI。
- 内存：新增均为轻量结构（目标行/窗口快照/扫描缓存），无常驻自动化框架（新依赖仅 windows-sys[对齐版本]/winreg/lnk 三个小 crate）。

## 8. 构建与测试结果（全部真实执行）

| 项 | 结果 |
|---|---|
| `cargo test --lib` | ✅ **111 通过 / 0 失败**（v0.3 80 例全保留 + 新增 31 例导航） |
| `npx tsc --noEmit`（strict） | ✅ 0 错误（`cargo check` 0 警告） |
| `npm test`（vitest） | ✅ **44 通过 / 0 失败**（新增 7 例导航纯函数） |
| `npm run build` | ✅ dist 产出（JS 353KB / gzip 108KB） |
| `npm run tauri build` | ✅ **Task Dock_0.3.0_x64-setup.exe（NSIS 2.81MB）+ msi（4.42MB）** |
| 正式 exe 真机冒烟 | ✅ 启动完整（调度器/三 Adapter/HTTP 47821 全部就绪） |
| 真实数据库迁移 | ✅ v3→v4 原子完成，`PRAGMA foreign_key_check` 零违反，旧数据完整 |
| 真机 HTTP ingest 回归 | ✅ bridge 来源事件 → 流水(http) → 会话 → 轮次状态机 completed 全链路正确 |

## 9. 未解决问题与后续建议

**已知限制（如实）**：①「进程已启动但 5 秒未见窗口」按 process-spawned 如实报告（托盘/后台类应用属正常）；②多窗口应用未指定窗口时唤醒其一并标注「N 个窗口之一」；③UWP 应用无 exe 身份，仅支持启动不支持窗口级唤醒；④微信/QQ 内部聊天定位、播放器歌曲控制、浏览器标签页定位**明确不做**（无授权接口，不做 UI 模拟）；⑤真实 exe 图标提取未做（用类型图标+色块头像替代）。

**待真机手动验收清单**（自动化环境无法覆盖，见 APP_NAVIGATION_MATRIX.md 第四节）：微信/酷狗唤醒、Chrome 指定 URL、VS Code 打开目录、资源管理器定位文件、UWP 启动、多显示器前台切换、OpenCode resume 真实版本。

**后续建议**（按优先级）：P2 视觉走查（preview harness 已备好 fixture）；exe 图标提取（SHGetFileInfo）；`code file:line` 文件级定位；浏览器历史标签复用（仅在官方接口可用时）；导航窗口选择器记忆（nav_remember_window 已存设置，选择器 UI 可加强）。

## 10. 真机 UI 验收补记（Computer Use 驱动，2026-10-26）

交付报告初版完成后，使用 Windows UIA 自动化对**正式版 exe** 做了逐场景真机验收（详见
[docs/TESTING.md 第五节](docs/TESTING.md)）。结论：**12 个场景全部通过**，过程中发现并当场
修复了 **3 个 P0 + 1 个 P2 缺陷**——这正是「必须真机验收」的价值：

1. **P0 · panic=abort 吞掉异常隔离**：正式版扫描到用户开始菜单中的畸形 .lnk 时整个应用直接
   退出（catch_unwind 在 panic=abort 下失效；单测是 debug 构建所以未暴露）。修复：移除
   `panic = "abort"`。真机日志确认本机 5+ 个畸形快捷方式全部被安全隔离。
2. **P0 · 应用选择器无限渲染白屏**：zustand v5 selector 每次返回新 `Set`，严格相等比较失败
   触发无限重渲染。修复：selector 只取稳定引用。
3. **P0 · Tauri v2 invoke 参数命名**：v2 只认 camelCase 参数键，bridge 层的 snake_case 键使
   required 参数直接报错（`invalid args 'taskId'`）、Option 参数静默失效——**v0.3 的
   linkTaskAgent、快速添加时间参数等也一直受此影响**。修复：全部 invoke 键改 camelCase（约 20 处）。
4. **P2 · 关联失败无提示**：async 回调未 await 成为 unhandled rejection；修复后错误 toast
   反过来帮助定位了 #3。

关键验证结论（全部有数据库审计或进程实测佐证）：
- L1 启动：任务卡一键启动 Notepad.exe（真实进程）；
- L2 唤醒：Chrome 焦点切换 **window-confirmed**（前台句柄核实），重复点击复用现有窗口；
- 验证分级如实：Win11 商店版记事本（UWP 化，窗口不在自身 exe 名下）按设计报告
  process-spawned 而非谎报窗口确认；
- 工作区：两目标顺序批量启动、逐项独立反馈、use_count 与日志完整；
- Agent 跳转：未安装 Agent 的按钮按证据禁用；bridge 会话跳转诚实拒绝（「该 Agent 无已知
  窗口身份」），不冒充精准定位；
- 应用管理：偏好控件、目标管理、失败记录全部渲染正确。

验收残留数据已清理（演示任务/目标/日志删除，Agent 历史与用户设置未触碰）。
