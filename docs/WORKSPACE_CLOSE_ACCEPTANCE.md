# 工作台窗口关闭 · 真机验收

> 适用版本：2026-11-19 关闭专项（P0）之后；2026-11-22 增补关闭策略（`window_close_behavior`）、
> 关闭保护就绪状态与托盘唤回（ADR-0009）。
> 目标：证明「任何正常关闭入口都能可靠关闭」，且**未保存正文不会丢**，
> 同时**不允许**通过 destroy、绕过保存或关闭 Rust 生命周期保护来换取表面成功。

## 0. 前置

1. 用 `npm run tauri build` 构建（**禁止** `cargo build --release`：会漏
   `custom-protocol` 特性，启动即走开发服务器预检而退出）。
2. 以 `RUST_LOG=info` 启动，**保留终端输出**（`CLOSE_GUARD_*` 与 Rust 的
   `CLOSE_REQUESTED / CLOSE_GEOMETRY_* / WINDOW_DESTROYED` 在同一条 tracing 流里）。
   需要同时留证据时，把终端重定向到文件；诊断中心的
   `diagnostics-active.jsonl` 也能作为输入。
3. 汇总指标（脚本可同时吃终端文本与 jsonl）：

   ```
   node scripts/close-metrics.mjs <终端日志> [诊断.jsonl]
   ```

   退出码 0 表示没有「无解释终止」；非 0 会直接列出问题记录。

## 1. 场景表（11 项）

| # | 操作 | 期望界面 | 必须出现的日志序列 | 失败判定 |
|---|---|---|---|---|
| 1 | 无正文模块，点自绘 X | 窗口立即关闭 | `CLOSE_REQUESTED → CLOSE_GUARD_NO_FLUSH → CLOSE_GEOMETRY_SNAPSHOT_COMPLETED → WINDOW_DESTROYED` | 出现 `CLOSE_GUARD_PREVENTED` 后无后续；或 5s 内无 `WINDOW_DESTROYED` |
| 2 | 无正文模块，Alt+F4 | 同上 | 同上（`CLOSE_GUARD_NO_FLUSH` 的 `detail=native`） | 同上 |
| 3 | 正文有未保存草稿，点 X | 先出现「正在保存并关闭工作台」，随后关闭 | `CLOSE_REQUESTED → CLOSE_GUARD_PREVENTED → CLOSE_GUARD_REQUESTED → CLOSE_GUARD_FLUSH_STARTED → MANUSCRIPT_FLUSH_STARTED → MANUSCRIPT_SAVE_COMPLETED → MANUSCRIPT_FLUSH_COMPLETED → CLOSE_GUARD_FLUSH_COMPLETED → CLOSE_GUARD_RETRY_CLOSE_STARTED → CLOSE_GUARD_RETRY_CLOSE_ACCEPTED → CLOSE_GUARD_ALLOWED → WINDOW_DESTROYED` | 缺 `MANUSCRIPT_SAVE_COMPLETED` 就关窗＝丢稿；`CLOSE_GUARD_FLUSH_COMPLETED` 与 `WINDOW_DESTROYED` 之间缺 `ALLOWED` |
| 4 | 正文有未保存草稿，Alt+F4 | 同 3（与 X 共用同一笔事务） | 同 3，`CLOSE_GUARD_REQUESTED` 的 `detail=native` | 出现两次 `FLUSH_STARTED`（重复保存） |
| 5 | 保存进行中连点 X 五次 | 按钮保持 disabled，提示不消失；只保存一次 | 第一条链路同 3，其余四条只有 `CLOSE_GUARD_DUPLICATE`（`detail=saving`） | 出现第二条 `CLOSE_GUARD_FLUSH_STARTED`；或按钮恢复可点 |
| 6 | 保存在途时继续输入新内容 | 关闭前落盘的是**最新**草稿 | `MANUSCRIPT_SAVE_COMPLETED` 后仍有第二次 `MANUSCRIPT_SAVE_STARTED/COMPLETED`（正文变脏才触发） | 关闭后重开，最后一段输入丢失 |
| 7 | 保存 IPC 永久挂起（模拟：断点/阻塞数据库） | 15s 后提示「正文保存仍在进行……可以继续等待，或稍后重试」，窗口保持打开 | `CLOSE_GUARD_FLUSH_STARTED → CLOSE_GUARD_FLUSH_TIMEOUT (duration_ms≈15000)` | 无任何反馈；或窗口被强制关闭 |
| 8 | 保存失败（false 或抛错） | Toast 报错，窗口保持打开，草稿仍在 | `CLOSE_GUARD_FLUSH_FAILED (result=false/error)` | 窗口关闭但正文未落盘 |
| 9 | 已归档项目 + 脏稿，点 X | 提示「项目已归档，未保存的正文无法写入」，不关闭 | `MANUSCRIPT_FLUSH_COMPLETED (result=archived) → CLOSE_GUARD_FLUSH_FAILED (result=false)` | 静默关窗（等于丢稿） |
| 10 | 关闭工作台后查看主程序 | 工作台窗口消失，主窗口/托盘/后台任务继续运行 | `WINDOW_DESTROYED`，**无**主进程退出日志 | 整个 TaskDock 退出 |
| 11 | 关闭后立即重开工作台 | 窗口按上次位置/尺寸出现，无黑角、无错位 | `WINDOW_DESTROYED` 后新会话出现 `CLOSE_REQUESTED` 之前的 `workbench` 建窗日志；无 `CLOSE_GEOMETRY_PERSIST_FAILED` | 几何回退到默认；或出现 `CLOSE_GEOMETRY_PERSIST_FAILED` 且重开位置丢失 |

## 2. 通过标准

- 11 项全部符合「期望界面」，且日志序列齐全。
- `node scripts/close-metrics.mjs <日志>` 输出 `✓ 每次关闭请求都有明确结局`，
  且「未解释」为 0。
- 任何一次失败都必须有 `CLOSE_GUARD_FLUSH_FAILED` 或 `CLOSE_GUARD_FLUSH_TIMEOUT`
  解释；**不允许**出现只有 `CLOSE_REQUESTED`、没有任何后续记录的情况。
- 场景 3/6 关闭后重开，正文与最后一次输入一致（逐字比对）。
- 场景 10 证明关闭工作台不影响主程序生命周期。

## 3. 已知边界（不是缺陷）

- 关闭等待上限 15s 到期只停止**等待**，不取消底层保存；此时再点 X 会复用在途
  保存，不会产生第二次写入。
- `CLOSE_GEOMETRY_PERSIST_DEFERRED` 表示几何写入被推迟到后台线程（300ms 内未完成），
  窗口仍会正常关闭，下次启动读内存快照，不应视为失败。
- Win10 上圆角裁剪没有外部投影，属已知视觉差异。
- **close_window 模式下启动极早期（关闭协调器安装完成前）按 Alt+F4**：窗口按原生
  关闭，不等正文 flush（协调器尚未注册）。正文有输入防抖/切换落盘兜底，丢稿风险
  限于最近未落盘输入；X 按钮在此窗口期不可用并显示「初始化中」。
- **quit_app 模式下正文保存时限是退出握手的 5 秒**（`EXIT_HANDSHAKE_TIMEOUT_MS`），
  非 close_window 的 15s：超时取消退出并广播 `app-exit-blocked`，用户可重试。

## 4. 2026-11-22 场景表（关闭策略 + 就绪状态 + 托盘唤回，14 项）

> 使用 `npm run tauri dev`（Debug）+ `TASK_DOCK_DATA_DIR` 隔离数据目录，
> `RUST_LOG=info` 保留终端 tracing。设置路径：设置中心 → 窗口与快捷键 →
> 「关闭窗口时的行为」。

| # | 操作 | 期望界面 | 必须出现的日志/信号 | 失败判定 |
|---|---|---|---|---|
| 1 | 启动后立即点 X（1 秒内） | 按钮短暂「关闭保护初始化中」；就绪后可正常关闭 | 就绪前点击：`close-guard-not-ready`（WARN）；就绪后走场景表第 1/3 项链路，含 `CLOSE_GUARD_INSTALLED` | 按钮永久禁用且无原因；或未就绪时仍发起关闭 |
| 2 | 启动完成后点 X（close_window） | 窗口按正文守卫链路关闭 | `CLOSE_GUARD_INSTALLED → CLOSE_GUARD_REQUESTED → … → WINDOW_DESTROYED` | X 无反应 |
| 3 | 无正文模块关闭 | 窗口立即关闭 | `CLOSE_GUARD_NO_FLUSH → CLOSE_REQUESTED → WINDOW_DESTROYED` | 出现 `CLOSE_GUARD_PREVENTED` 后无后续 |
| 4 | 有未保存正文关闭 | 先「正在保存并关闭工作台」，随后关闭 | `CLOSE_GUARD_PREVENTED → FLUSH_STARTED → MANUSCRIPT_SAVE_COMPLETED → FLUSH_COMPLETED → WINDOW_DESTROYED` | 缺 `MANUSCRIPT_SAVE_COMPLETED` 即关窗 |
| 5 | Alt+F4（close_window，正文有草稿） | 同 4（同一笔事务） | 同 4，`CLOSE_GUARD_REQUESTED` 的 `detail=native` | 两次 `FLUSH_STARTED` |
| 6 | 设置切到 quit_app，点 X | 按钮「正在保存并退出应用…」，进程退出 | `quit-app-requested`；终端出现接入管线退出排空完成日志；进程消失 | 窗口关闭但进程驻留；或退出无保存 |
| 7 | quit_app + 有未保存正文，点 X | 先保存后退出；保存失败时 toast「应用退出已取消」且按钮恢复可重试 | `app-before-exit` 握手（前端 flush 回执）；失败路径出现 `app-exit-blocked` | 退出成功但草稿丢失；或取消后按钮永久禁用 |
| 8 | quit_app + Alt+F4 | 同 6（Rust 接管） | `CLOSE_REQUESTED_QUIT_APP`；无 `CLOSE_GUARD_PREVENTED`（协调器让路，`CLOSE_GUARD_YIELD_TO_QUIT_EXIT`） | 前端事务与退出握手互相等待 |
| 9 | close_window：托盘左键 | 打开/聚焦完整工作台 | 工作台建窗日志或 `reveal`；窗口出现并聚焦 | 打开的是快捷工具面板 |
| 10 | close_window：托盘右键「打开完整工作台」 | 同 9，失败时菜单行内报错 | `open_or_focus_workbench_with_result` 成功（菜单收起） | 主窗未就绪时误报失败 |
| 11 | 关闭工作台后托盘重新打开 | 工作台重建并恢复上次位置/尺寸/最大化 | `WINDOW_DESTROYED` 后新 `window-create` 日志；无 `CLOSE_GEOMETRY_PERSIST_FAILED` | 几何回退默认；或重建出第二个工作台 |
| 12 | 最小化后托盘左键唤回 | 还原并聚焦 | `reveal_workbench`（unminimize+show+focus） | 唤回后仍最小化 |
| 13 | quit_app：托盘右键「退出」 | 进程结束（tasklist 无 task-dock.exe） | 管线排空完成日志；`last-shutdown-report.json` 更新 | 进程残留；或后台线程未收尾 |
| 14 | 退出后后台收尾核对 | 无遗留粘贴/语音/管线线程 | `接入管线退出排空完成`、`剪贴板退出收尾完成` 日志 | 缺任一收尾日志 |

通过标准：14 项全部符合；`close-metrics.mjs` 对 close_window 轮次输出
「每次关闭请求都有明确结局」且「未解释」为 0；quit_app 轮次进程确认结束。

## 5. 2026-11-22 真机验收记录（Debug 包）

> 隔离实例：`target-close-lifecycle/debug/task-dock.exe` + 独立 `TASK_DOCK_DATA_DIR` /
> WebView2 profile / CDP 端口；日志 `tmp/acceptance/close-lifecycle-20261122/terminal.log`。
> 结论：**Dev 功能验收通过**（14/14，含两期真机修复）；`close-metrics.mjs` 输出
> 「每次关闭请求都有明确结局，未发现无解释终止」。

**P0 原始根因（真机定位，两期修复，提交 52433f7 / c75c7ab）**：

1. **workspace capability 缺 `core:window:allow-destroy`**：tauri v2 契约是前端注册
   `onCloseRequested` 后 Rust 无条件 `prevent_close`（`tauri-2.12.5/src/manager/window.rs`
   `has_js_listener` 分支），放行路径由 JS API 调 `destroy()`；该命令被 ACL 拒绝
   （`window.destroy not allowed`），窗口永不销毁 → Debug 包点 X 无反应、日志只有
   `CLOSE_GUARD_RETRY_CLOSE_ACCEPTED → CLOSE_GUARD_DESTROY_TIMEOUT`。
2. **quit_app 让路缺陷**：guard 对 CloseRequested 直接 return（不 preventDefault）时，
   tauri JS 包装在 handler 放行后自动调 `window.destroy()` → 窗口先于退出握手销毁 →
   正文保存回执无人应答 → 5s 超时取消退出且窗口已死。修复为同步 `preventDefault`
   （只阻止 JS destroy，Rust quit 分支自行接管）。

**场景结果**：1 ✓（就绪门控由单测锁定；真机 guard 安装 <2s 未采到初始化窗口期）；
2 ✓；3 ✓（`NO_FLUSH → WINDOW_DESTROYED`）；4 ✓（`MANUSCRIPT_SAVE_COMPLETED` +
`FLUSH_COMPLETED` + destroyed，防抖自动保存先落库 → clean flush）；5 ✓（WM_CLOSE 与
Alt+F4 同链：`detail=native` 同一笔事务）；6 ✓（Rust 接管 → `CLOSE_GEOMETRY_EXIT_FLUSH`
→ 排空 → 进程消失）；7 ✓（首轮真机复现「回执超时 → 取消退出」fail-safe；正常路径由
6/8 覆盖；显式注入保存失败未做，前端握手失败回执由 workbenchExitGuard 单测锁定）；
8 ✓（复测：`YIELD_TO_QUIT_EXIT` + 握手回执 + 排空 + 进程退出）；9 ✓（真实鼠标点击托盘
图标 → 重建 + 聚焦）；10 ✓（物理右键菜单弹出 + 菜单项真实点击 → `open_or_focus_workbench_
with_result` ok:true + 窗口聚焦）；11 ✓（重开精确恢复 (100,80,1600×1000) 内存快照）；
12 ✓（最小化 → 托盘左键还原；focused=False 为 Windows 托盘点击前台锁既有限制）；
13 ✓（tasklist 无本实例进程 + `last-shutdown-report.json` 更新）；14 ✓（管线排空/剪贴板/
手机接入收尾日志齐全）。

**发现的既有缺陷（非本任务回归，待另行整改）**：

- `workspace_window_rect` DB 存储值比实测窗口物理矩形大 1.25×（125% DPI 下物理像素被
  再乘 scale_factor 落库）；内存快照优先路径使同进程重开正确恢复（roundtrip 抵消），
  但跨进程重启走 DB 路径时窗口会比关闭前大 25%。修复涉及 `resolve_geometry_snapshot`
  的 DPI 换算，超出本次范围。
- 托盘点击唤回后 `set_focus` 受 Windows 前台锁限制可能不抢前台（第二实例路径正常），
  与主窗 `show_and_focus` 同一既有行为。

**环境说明**：验收期间存在并行会话实例与定时提交（689b1a7 把工作区在途改动打包入库），
一次实例被外部终止后重启继续；窗口枚举按 PID 过滤消除干扰。托盘图标经
`NotifyIconSettings\IsPromoted` 临时提升为常驻以稳定真机点击，验收后已恢复。

## 6. 2026-11-22 第二轮：主窗 / 工作台 / 进程三生命周期（14 项）

> 目标：证明主窗、工作台、进程三个生命周期都按 `window_close_behavior` 收敛：
> 主窗自绘 X 与 Alt+F4 不再绕过设置；工作台退出监听失败可恢复；退出失败不会
> 留下「窗口已销毁但进程驻留」的状态。**进程退出以 PID 消失判定**，不以窗口消失代替。

**前置**：
1. 独立 Debug 实例：每轮独立 `TASK_DOCK_DATA_DIR=tmp/debug/close-r*/` + 该目录下
   `WEBVIEW2_USER_DATA_FOLDER` + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=19332`。
   二进制可直接用 `src-tauri/target/debug/task-dock.exe`，不必另建 target 目录。
2. `RUST_LOG=info`，每轮输出保存为 `tmp/acceptance/close-lifecycle-round2/round<轮次>.log`
   （同目录 `.stderr.log` 一并保留）。
3. 结构化校验（第二阶段脚本，拒绝「字符串出现过就算通过」）：

   ```
   node tmp/acceptance/close-lifecycle-20261122/verify-stages.mjs \
     <round<轮次>.log> --expect tmp/acceptance/close-lifecycle-round2/round<轮次>-expect.json
   ```

   脚本按 window label / attemptId / requestId / 时间窗还原每笔事务，校验顺序与失败路径；
   `--expect` 校验实际执行次数与计划一致。`--self-test` 用合成日志锁定
   「先销毁后保存」「quit 提前销毁」「主窗 close_window 未隐藏」会被判失败。
   本轮实际使用 `round{3,4,5b,6,6b,7b,8,9,10}-expect.json`（见 6.1）。

| # | 操作 | 期望界面 | 必须出现的日志/信号 | 失败判定 |
|---|---|---|---|---|
| 1 | 工作台 X + close_window（含未保存正文） | 保存后关闭，进程/托盘继续 | `CLOSE_REQUESTED → CLOSE_GUARD_PREVENTED → FLUSH_STARTED → MANUSCRIPT_SAVE_COMPLETED → FLUSH_COMPLETED → RETRY_CLOSE_STARTED → ALLOWED → WINDOW_DESTROYED`；PID 仍存在 | 先销毁后保存；无 ALLOWED；进程退出 |
| 2 | 工作台 X + quit_app（含未保存正文） | 保存后退出整个应用 | `QUIT_APP_REQUESTED → APP_BEFORE_EXIT → MANUSCRIPT_FLUSH_COMPLETED → APP_EXIT_HANDSHAKE_COMPLETED result=true → PIPELINE_DRAIN_COMPLETED → CLIPBOARD_SHUTDOWN_COMPLETED → PROCESS_EXIT` | 窗口先消失、进程仍在；缺保存完成 |
| 3 | 工作台 Alt+F4（close_window / quit_app 各一次） | 与 X 同策略 | close：`CLOSE_GUARD_REQUESTED detail=native` 同一笔事务后销毁；quit：`CLOSE_REQUESTED_QUIT_APP → CLOSE_GUARD_YIELD_TO_QUIT_EXIT detail=native → APP_BEFORE_EXIT` | 两次 `FLUSH_STARTED`；quit 提前销毁 |
| 4 | 主窗 X（close_window / quit_app 各一次） | close：主窗隐藏到托盘、锁保险箱；quit：保存后退出 | close：`MAIN_CLOSE_REQUESTED source=command behavior=close_window → MAIN_HIDDEN_TO_TRAY → MAIN_VAULT_LOCKED`；quit：`… behavior=quit_app → MAIN_QUIT_REDIRECTED → PROCESS_EXIT` | close 后进程退出；quit 只隐藏不退出 |
| 5 | 主窗 Alt+F4（close_window / quit_app 各一次） | 同 4 | close：`MAIN_CLOSE_REQUESTED source=native behavior=close_window` + 隐藏/锁定；quit：`source=native behavior=quit_app → MAIN_QUIT_REDIRECTED → PROCESS_EXIT` | 原生销毁未被阻止；两条策略混用 |
| 6 | 正文保存失败（项目归档 + 脏稿）+ quit_app | Toast「退出已取消」，工作台保持可见；按钮恢复 | `APP_BEFORE_EXIT → MANUSCRIPT_FLUSH_COMPLETED result=archived → APP_EXIT_HANDSHAKE_COMPLETED result=false → APP_EXIT_BLOCKED`；无 `PIPELINE_DRAIN_COMPLETED` / `PROCESS_EXIT` | 退出成功但草稿丢失；或按钮永久禁用 |
| 7 | 保存 IPC 超时（外部持有 SQLite 写锁）+ quit_app | 约 5s 后提示退出取消，工作台保持 | `APP_BEFORE_EXIT request_id=N → APP_EXIT_HANDSHAKE_TIMEOUT → APP_EXIT_BLOCKED`；无提前销毁 | 无反馈；窗口被关掉；进程退出 |
| 8 | 6/7 取消后工作台存活并重试 | 窗口可聚焦，释放阻塞后再次 X 能正常退出 | 取消后再次 `PROCESS_EXIT_REQUESTED` 且最终 `PROCESS_EXIT`；PID 消失 | 工作台已销毁；重试无入口 |
| 9 | close_window：托盘左键 | 打开/聚焦完整工作台 | `TRAY_LEFT_OPEN_WORKBENCH → WORKBENCH_REVEALED`（或 `WORKBENCH_WINDOW_CREATED`） | 打开快捷工具面板；无窗口出现 |
| 10 | close_window：托盘右键「打开完整工作台」 | 同 9，失败行内报错 | 同上（经 `open_or_focus_workbench_with_result`） | 主窗未就绪时误报失败 |
| 11 | 托盘右键「退出」 | 进程结束 | `TRAY_RIGHT_QUIT → PROCESS_EXIT_REQUESTED → … → PROCESS_EXIT`；PID 消失 | 进程残留 |
| 12 | 主窗隐藏后唤回 | 主窗重新显示/聚焦 | `MAIN_HIDDEN_TO_TRAY … MAIN_WINDOW_TOGGLED action=show` | 隐藏后无任何显示入口 |
| 13 | 关闭工作台后重新打开 | 按上次位置/尺寸恢复，只有一个实例 | `WINDOW_DESTROYED` 后 `WORKBENCH_WINDOW_CREATED`/`WORKBENCH_REVEALED`；无 `CLOSE_GEOMETRY_PERSIST_FAILED` | 几何回退默认；重建出第二个工作台 |
| 14 | 退出后进程与后台服务核对 | 无 task-dock.exe、无管线/剪贴板/语音遗留 | `PIPELINE_DRAIN_COMPLETED`、`CLIPBOARD_SHUTDOWN_COMPLETED`、`PROCESS_EXIT`；`Get-Process -Id <PID>` 失败 | 缺任一收尾；PID 仍存在 |

> 行 3 quit 的 `CLOSE_GUARD_YIELD_TO_QUIT_EXIT` 是前端异步上报的 trace：同步
> `preventDefault()` 在原生销毁前已完成，但 trace 落盘可能与 `APP_BEFORE_EXIT`
> 同毫秒（本轮实测 11:19:08.187107 → .187848）。硬约束是握手完成前不得出现
> `WINDOW_DESTROYED`；校验器按毫秒精度要求 yield 不晚于 `APP_BEFORE_EXIT`。
>
> 行 7 本轮实际以「工作台渲染线程阻塞 9 秒」触发 5 秒握手超时；外部 SQLite
> 写锁变体未执行，见 6.1 未验项。

**通过标准**：14 项全部符合；`verify-stages.mjs` 对全部日志退出码 0，且实际计数与
对应的 `round<轮次>-expect.json` 一致；6/7 的取消路径没有 `WINDOW_DESTROYED` 早于握手结束；
quit_app 轮次以 PID 消失为准。只有主窗、工作台、进程三个生命周期全部通过才记 PASS。

### 6.1 第二轮执行记录

> 状态：**Dev 功能验收通过（PASS）**。执行于 2026-11-22 19:01–19:37（日志 UTC 11:01–11:37），
> Debug 构建；主窗、工作台、进程三个生命周期均按 `window_close_behavior` 收敛，14 项全部有
> 本轮独立证据。历史 §5 的结论未复用；本轮未做 Release 包、升级/卸载与性能验收。

**环境与操作方式**

- 二进制：本轮 9 个实例均在 19:01–19:37 从当时的 `src-tauri/target/debug/task-dock.exe` 启动；
  构建记录 `build.log` 为 18:46 开始，产物晚于 18:54 的最后源码改动。19:38 该共享路径被并行
  构建刷新（R10 已于 19:37 退出），当前文件不代表本轮被测产物，本轮未留二进制哈希。
- 数据隔离：`close-r3/r4/r5b/r6/r6b/r7b/r8/r9` 各自 `TASK_DOCK_DATA_DIR` 与 WebView2 目录；
  13 的恢复侧复用 `close-r3`（`close-r10` 日志）。CDP 仅连 `127.0.0.1:19332`。
- 输入方式：工作台/主窗页内按钮用 CDP 在真实元素坐标点击；托盘左/右键向托盘隐藏窗口投递
  真实 `WM_USER_TRAYICON`(6002) 回调（uid 与 lparam 与 Shell 一致），右键菜单项在
  `context-menu` 页用 CDP 点击；主窗 Alt+F4 向枚举出的 `Tauri Window / Task Dock` 句柄投递
  `WM_CLOSE`。系统级鼠标注入不可用（`SetCursorPos` 的 Y 被钳到 0，`SendInput` 被 UIPI 拒绝），
  见未验项。
- 证据目录 `tmp/acceptance/close-lifecycle-round2/`：`round*.log`、`*.stderr.log`、
  `*-expect.json`、`main-x-dirty.mjs`、`alt-f4-dirty.mjs`、`r8-timeout.mjs`、`ui-state.mjs`、
  `main-probe.mjs`、`list-class.ps1` 等。日志为终端原文，未改写。

**实例与 PID**

| 轮次 | PID | 数据目录 | 覆盖项 | 结局 |
|---|---|---|---|---|
| round3 | 63672 | close-r3 | 1、3(close×2)、4(close)、5(close)、9、10、11、12、13(生成侧)、14 | 托盘退出，PID 消失 |
| round4 | 85504 | close-r4 | 2(干净稿先导)、9(已开窗聚焦) | 工作台 X 退出，PID 消失 |
| round5b | 77832 | close-r5b | 6、3(quit)、8 | 取消后 Alt+F4 重试成功，PID 消失 |
| round6 | 73776 | close-r6 | 4(quit，脏稿)、14 | 主窗 X 退出，PID 消失 |
| round6b | 61620 | close-r6b | 4(quit，复跑+持久化确认) | 主窗 X 退出，PID 消失 |
| round7b | 75296 | close-r7b | 5(quit) | 主窗 Alt+F4 退出，PID 消失 |
| round8 | 61996 | close-r8 | 7、8、4(超时后重试) | 重试退出，PID 消失 |
| round9 | 25824 | close-r9 | 2(脏稿) | 工作台 X 退出，PID 消失 |
| round10 | 80260 | close-r3 | 13(恢复侧)、11、14 | 托盘退出，PID 消失 |

round7（PID 77432）因端口仍被 round6b 实例占用、`WM_CLOSE` 投到错误句柄而作废，仅用托盘退出
清理现场；产品侧无异常，成功用例在 round7b 独立重跑。

**14 项结果**

| # | 本轮证据（UTC） | 结果 |
|---|---|---|
| 1 | R3 11:01:58.321 `CLOSE_GUARD_REQUESTED detail=button` → flush → SAVE ok 111ms → RETRY → ALLOWED → DESTROYED .528；进程存活 | 通过 |
| 2 | R9 11:36:57.188 `QUIT_APP_REQUESTED source=command` → `APP_BEFORE_EXIT req=1` → `EXIT_BEFORE_EXIT_RECEIVED` → SAVE ok 79ms → handshake true → drain → clipboard → PROCESS_EXIT；PID 25824 消失（R4 11:15:13 干净稿同链） | 通过 |
| 3 | close：R3 11:02:42 / 11:11:22 `CLOSE_GUARD_REQUESTED detail=native`，各一笔 flush → ALLOWED → DESTROYED；quit：R5b 11:19:08.184 `CLOSE_REQUESTED_QUIT_APP` + YIELD detail=native → 握手 true → 收尾；PID 77832 消失 | 通过 |
| 4 | close：R3 11:12:30.016 `main source=command behavior=close_window` → HIDDEN .042 → VAULT_LOCKED locked=false .042，进程存活；quit：R6 11:21:21.371 `behavior=quit_app` 脏稿 SAVE ok 9ms → 握手 true → 收尾，PID 消失；R6b 11:22:30 复跑通过 | 通过 |
| 5 | close：R3 11:13:07.117 `main source=native behavior=close_window` → HIDDEN .143 → LOCKED false；quit：R7b 11:25:51.970 `source=native behavior=quit_app` → MAIN_QUIT_REDIRECTED → 脏稿 SAVE ok 9ms → 握手 true；PID 75296 消失 | 通过 |
| 6 | R5b 11:18:43.970 QUIT → flush result=archived（chapter d79cb4e8）→ handshake **false** .055 → `APP_EXIT_BLOCKED` → 前端 `EXIT_BLOCKED_RECEIVED` .060「工作台正文保存失败，退出已取消」；无 drain/clipboard/PROCESS_EXIT，无 WINDOW_DESTROYED；PID 保持存活，随后重试成功 | 通过（Toast 视觉未单独截图，见未验项） |
| 7 | R8 11:26:45.370 主窗 X quit → APP_BEFORE_EXIT req=1 → 11:26:50.382 `APP_EXIT_HANDSHAKE_TIMEOUT timeout_ms=5000` → BLOCKED .384；全程 0 个 WINDOW_DESTROYED，无收尾。解除阻塞后 11:26:54.282 迟到回执 + `EXIT_BLOCKED_RECEIVED`「…回执超时（5 秒），退出已取消」，未复活退出 | 通过 |
| 8 | R8 取消后：按钮 disabled=false、提示原因为超时、工作台可见 424,172,1624,932、草稿保留；11:27:07.038 再次 X（request_id=2）→ 握手 true → 收尾，PID 61996 消失。R5b 也完成取消→重试 | 通过 |
| 9 | R3 11:10:44.298 `TRAY_LEFT_OPEN_WORKBENCH` → CREATED .597 → REVEALED 11:10:48.265（完整工作台，不是快捷面板） | 通过 |
| 10 | R3 托盘右键「打开完整工作台」11:11:28 触发 → CREATED 11:11:30.889 → REVEALED 11:11:31.195 | 通过 |
| 11 | R3 11:13:22.338 `TRAY_RIGHT_QUIT` → PROCESS_EXIT .606；R10 11:37:41 同链；两次 PID 均消失 | 通过 |
| 12 | R3 隐藏 11:12:30 后 11:12:57.986 `MAIN_WINDOW_TOGGLED action=show`；另见 11:12:12 / R8 11:26:34 | 通过 |
| 13 | close-r3 库中 `workspace_window_rect={"h":950,"maximized":false,"w":1500,"x":530,"y":215}`（物理，125%）→ R10 同数据启动 11:37:31.144 CREATED reveal=WhenReady → REVEALED 11:37:34.310；原生枚举仅一个工作台，rect=424,172,1624,932（DPI 虚拟化显示值，等价），无 `CLOSE_GEOMETRY_PERSIST_FAILED` | 通过 |
| 14 | 上述每次成功退出均含 `PIPELINE_DRAIN_COMPLETED timed_out=false unsaved=0` → `CLIPBOARD_SHUTDOWN_COMPLETED stopped=true` → `PROCESS_EXIT`；逐 PID `Get-Process -Id` 均报进程不存在 | 通过 |

**失败路径不会复现历史顺序**

- quit_app 的原生关闭在 Rust `CloseRequested` 先 `prevent_close()` 再 `request_exit`，工作台自绘 X
  在 quit 模式下直接走 `quitApp`，不经原生销毁；R5b/R8 的取消窗口内 `WINDOW_DESTROYED` 计数为 0，
  且无任何收尾/退出事件。取消只发生在握手阶段，工作台与进程都保持存活。
- R8 超时后迟到的 `EXIT_BEFORE_EXIT_RECEIVED`（request_id=1）没有触发握手完成或排空；重试使用
  request_id=2 后才完整退出，证明迟到回执不会把已取消的退出「复活」。
- `app-exit-blocked` 在两个监听均注册成功时才会被前端接收；R8 实测收到并复位按钮。监听注册失败
  路径由单测覆盖（见下），不会永久停在「初始化中」。

**结构化校验与自动化测试**

- `verify-stages.mjs` 自检 7/7；对 round3/4/5b/6/6b/7b/8/9/10 九份日志配对应 `*-expect.json`
  全部退出码 0，计数与预期一致（如 round3：close_window 成功 3、main close_window 2、
  tray left/right 各 1；round5b：save_failed 1 + 前端收到 1 + 取消后重试 1；round8：timeout 1 +
  重试 1；round10：托盘退出 1）。
- `npx vitest run src/workbench/WorkbenchWindowControls.test.tsx src/workbench/WorkbenchShell.test.tsx`
  → 2 文件 45 测试通过；新增用例覆盖「监听失败→按钮可点且点击只重试注册、不发起关闭→
  重试成功后恢复关闭」。
- `npm run typecheck` 通过。
- `npm run cargo -- test --lib commands::system::tests::main_close_plan` → 4 通过（其余用例被过滤）。
  完整 `cargo test` 因共享工作树中他人未提交的 `tests/project_creation_identity.rs` 编译错误
  （E0063 `principal`、E0308 `PlanId/String`）无法执行，记为 `ENVIRONMENT BLOCKED`，非本任务改动。

**未验项与环境限制**

1. 系统级鼠标注入不可用（Y 被钳 0 / SendInput 被 UIPI 拒绝），页内按钮为 CDP 点击、托盘为
   真实 Shell 回调消息、原生关闭为 `WM_CLOSE`；未做纯物理鼠标点击。
2. 保险箱未配置：`MAIN_VAULT_LOCKED locked=false`（幂等）；只验证了每次关闭恰好一条 HIDDEN/
   LOCKED、无重复，未验证已配置保险箱的真实锁定效果。
3. 行 7 以工作台渲染线程阻塞 9 秒触发 5 秒握手超时，未使用外部 SQLite 写锁变体。
4. 行 6 的 Toast 视觉未截图；其前端状态与 7 共用同一监听/恢复代码，并由单测与 R8 的
   `ui-state.mjs` 覆盖。
5. 仅 Debug 实例；Release 安装包、升级/卸载、签名与性能未在本轮范围。
6. round7（PID 77432）为作废试验：上一实例仍占用 19332，导致项目创建/IPC 落到旧实例、
   `WM_CLOSE` 投到空标题句柄；未产生 MAIN_CLOSE 日志，不据此判断产品缺陷。

**残余风险**

- 前端 YIELD trace 为异步上报，实测与 `APP_BEFORE_EXIT` 同毫秒且可晚数百微秒；同步
  `preventDefault` 已在销毁前完成，硬约束（握手完成前不销毁）由校验器强制。若未来调整
  trace 通道，不要再依赖其与 APP_BEFORE_EXIT 的严格先后。
- 工作台获得焦点时主窗按设计自动隐藏；主窗关闭后的唤回依赖托盘菜单，若托盘被系统隐藏，
  只能经托盘溢出区恢复（既有产品行为，非本轮引入）。
- 进程退出以 PID 消失 + 收尾日志判定；未单独枚举子进程/外部资源（如语音侧车）是否存在，
  本轮所有轮次退出后未观察到残留 task-dock.exe。
