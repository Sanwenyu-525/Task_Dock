# 工作台窗口关闭 · 真机验收

> 适用版本：2026-11-19 关闭专项（P0）之后。
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
