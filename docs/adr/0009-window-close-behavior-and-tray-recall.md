# ADR-0009：窗口关闭策略与托盘唤回入口

- 状态：Accepted（2026-11-22）
- 决策者：窗口生命周期专项
- 影响范围：`src/workbench/workbenchCloseGuard.ts`、`WorkbenchShell.tsx`、
  `WorkbenchWindowControls.tsx`、`src-tauri/src/lib.rs`（主窗 CloseRequested / 托盘）、
  `src-tauri/src/project_workspace_window.rs`（workspace CloseRequested / 统一创建入口）、
  `src-tauri/src/context_menu.rs`（托盘右键菜单）、`db::Settings` / `commands/settings.rs`
  （`window_close_behavior` 设置）

## 背景

2026-11-19 关闭专项建立了工作台窗口的**统一关闭协调器**（`workbenchCloseGuard`），
但仍有三个缺口：

1. **P0 竞态**：协调器是异步安装的（`onCloseRequested` IPC 注册完成前返回句柄）。
   安装完成前点击自绘 X 只有一条 WARN 日志、没有任何 UI 反馈；安装失败则
   `closeGuardRef` 永远为 null，X 永久失效——用户视角是「Debug 包点 X 关不掉窗口」，
   且失败是静默的。
2. **关闭行为单一**：工作台关闭只支持「关窗驻留托盘」，无法让用户选择「关窗即退出整个应用」；
   托盘「退出」是唯一的退出入口。
3. **托盘入口错位**：托盘左键 `toggle_main` 切换的是旧版快捷工具面板（main 窗），
   右键「打开完整工作台」经 `run_tab_action` 转发给主窗前端——主窗未就绪时误报失败，
   且不是与启动/第二实例相同的统一创建入口。

## 决策

### 1. 关闭保护就绪状态是显式契约（P0）

- `WorkbenchShell` 持有 `closeGuardReady` 状态：初始 false → 安装成功 true →
  安装失败保持 false 并把原因写入 `closeMessage`（tooltip + Toast，不静默）→
  卸载时复位。
- `WorkbenchWindowControls` 接收 `closeReady`：未就绪时按钮 disabled、tooltip
  显示「初始化中/失败原因」，点击绝不发起关闭请求。
- `clickLock` 由 `busy`（closing || quitBusy）复位，不允许永久锁定；关闭请求未被
  协调器接受（failed）时恢复交互；`close()` Promise resolve ≠ 窗口销毁的既有契约不变。

### 2. 关闭行为由设置 `window_close_behavior` 决定（P1）

枚举：`close_window`（默认）| `quit_app`。旧库缺键由 serde 默认补齐；读侧
`normalized_window_close_behavior` 把非法值（旧备份/手工改库）收敛回默认，
不做破坏性迁移。

| 入口 | close_window（默认） | quit_app |
|---|---|---|
| 工作台自绘 X | 协调器事务：正文 flush → `close()`，Rust 保存几何后销毁 | 调 `quitApp` 命令 → `request_exit` |
| 工作台 Alt+F4 | 同上（同一笔事务） | Rust CloseRequested：`prevent_close` + `request_exit`；协调器经 `isQuitExit` 让路 |
| 主窗 X / Alt+F4 | `prevent_close` + hide 到托盘（含保险箱锁定） | `prevent_close` + `request_exit` |
| 托盘右键「退出」 | 恒 `request_exit`，不受设置影响 | 同左 |

- `request_exit` 是唯一退出实现：`persist_geometry_on_exit` → app-before-exit 正文
  保存握手（5s 有界，失败/超时广播 `app-exit-blocked` 并取消退出）→ 接入管线排空 →
  剪贴板/语音/诊断收尾 → `EXIT_READY` → `app.exit(0)`。**禁止**任何入口直接调
  `app.exit(0)` 替代该流程；**禁止**创建第二套正文保存服务。
- 前端协调器新增 `isQuitExit` 动态回调：quit_app 模式下 CloseRequested 处理器
  **不 preventDefault、不跑事务**（trace `CLOSE_GUARD_YIELD_TO_QUIT_EXIT`，已登记
  Rust `CLOSE_TRACE_STAGES` 白名单），由 Rust 统一接管，两条入口不会互相等待。
- quit_app 下 X 按钮的就绪依据是 `app-before-exit` 监听注册完成（`exitListenerReady`）；
  退出请求在途用 `quitBusy` 保持按钮 busy，`app-exit-blocked` 后复位可重试。

### 3. 托盘唤回与统一创建入口（P1）

- **托盘左键** = 打开/聚焦完整工作台：复用 `focus_or_open_workbench`（原
  `focus_or_open_workbench_from_second_instance` 更名，启动/第二实例/托盘共用）。
  已存在 → 还原最小化/显示并聚焦（`reveal_workbench` 兑现保存的最大化状态）；
  已销毁 → 经 `open_or_focus_workbench`（`OPEN_LOCK` 串行 + 唯一性计划）重建，
  `restore_geometry` 恢复尺寸/位置/最大化，`window_layout` 收敛显示器变化。
  不再切换快捷工具面板。
- **托盘右键「打开完整工作台」** = `open_or_focus_workbench_with_result`：同一创建
  路径 + oneshot 等待真实结果（12s 有界），成功才收菜单、失败保留行内反馈；
  不再经主窗转发（主窗未就绪不再误报失败）。
- **「显示 / 隐藏」更名为「显示/隐藏快捷工具面板」**，动作（`toggle_main`）不变；
  右键菜单其余项（快速添加/快速捕获/模式/主题/吸附/自启动/退出）保留。

## 窗口与进程生命周期边界

- 工作台窗口销毁 ≠ 应用退出：close_window 下窗口销毁后托盘/主窗/后台 Agent 继续
  运行；quit_app 下所有窗口随进程一起销毁。
- 几何持久化：close_window 的 CloseRequested 走工作台自有的快照/落库链路；
  quit_app 由 `request_exit` 开头的 `persist_geometry_on_exit` 兜底，两条路径
  共享同一几何存储（`workspace_window_rect` 内部键），不新增第二套。
- 失焦收起（未置顶点窗口外最小化）与托盘唤回正交：唤回路径全部带
  unminimize/show/focus，吸附隐藏态由 `snap-recall` 事件通知前端展开。

## 后果

- 「启动早期 Alt+F4（close_window、协调器未装完）」仍是已知边界：窗口按原生关闭、
  不等正文 flush。正文自动保存（模块切换/输入防抖落盘）使其丢稿风险限于未落盘的
  最近输入；验收文档单列该场景。
- quit_app 模式下正文保存的时限是退出握手的 5s（非协调器的 15s）：超时取消退出并
  提示，用户可重试。
- 托盘左键不再提供「隐藏主窗」能力；隐藏快捷工具面板仍可经面板按钮/右键菜单完成。
