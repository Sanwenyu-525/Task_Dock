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
