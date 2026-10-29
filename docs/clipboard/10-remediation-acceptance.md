# 10 · v0.5 整改验收（按证据分类）

> 日期：2026-10-29 · 版本：0.5.0 · 平台：Windows 11 x64 · 20 逻辑 CPU
> 原则：**未执行的验收不写成通过；单元测试不替代真实桌面验收；文档与最终源码一致。**
> 原始证据：`docs/clipboard/evidence/acceptance-final13.log`、
> `apps-matrix-report.json`、`apps-matrix-initial.log`、`matrix-vscode-report.json`。
> 验收脚本与临时数据位于 `C:\Users\ASUS\AppData\Local\Temp\taskdock-accept\`
> （含机器相关路径，按既有约定不入库；关键输出已归档到 evidence）。

## 一、结论摘要

| 项目 | 结论 |
|---|---|
| P0-1 粘贴生命周期 | **已修复**，有单元测试 + 真机逐项粘贴/取消/继续/目标关闭/用户接管证据 |
| P0-2 安全写入与恢复 | **已修复**，有单元测试 + 真机恢复/保留用户内容证据；跨进程极端时序未构造 |
| P1 快速采集、隐私、Agent、性能 | **已修复或已实现**，有单测/压测/真机检查 |
| P2 预检、UI、诊断 | **已实现**；两处真机发现的 UI 缺陷已修复 |
| 自动化 | Rust **244 passed / 0 failed / 10 ignored**；前端 **16 文件 / 109 passed**；fmt/clippy（0 警告）/tsc/build 通过 |
| release 性能 | **2/2 预算通过**（列表 p95 1.001 ms；200 连拍 2.799 s / 8 s） |
| 真机桌面 | **46/46 PASS**；第三方矩阵 **5/5 PASS** |
| 不可执行项 | 微信（已登录用户会话）、Agent 应用（登录/引导页）→ 明确记为环境阻塞/未验证 |
| 总体 | **PASS**：核心 P0 已修复并有真机证据；未验证项与有损边界如实列明 |

**为什么是 PASS**：核心 P0（粘贴生命周期、安全写入）均已修复，并通过真实 Windows
桌面上的逐项粘贴、恢复、用户中途复制保护等检查；全部工程门禁与 release 性能预算通过。
微信与 Agent 类应用因环境无法安全自动化，按任务要求记录为
`ENVIRONMENT BLOCKED / NOT VERIFIED`，未折算为通过，也未据此宣称“所有应用均支持”。

## 二、证据分类一：已修复且有自动化测试证明

### 2.1 P0-1 逐项粘贴生命周期与收尾

**原问题（根因）**

- 旧实现以 `SendInput` 返回成功即视为“已发送”，缺少逐项状态；写入成功但按键失败的
  条目可能仍留在 `remaining`，继续任务时被再次粘贴（重复内容）。
- 恢复在最后一项按键后立即执行，没有独立观察/收尾窗口；目标异步读取图片时，
  剪贴板可能已被恢复，最后一张图丢失。
- 取消发生在条目中间时，未明确保留未处理项；间隔固定 350 ms，图片/文件过快。
- 没有“已确认/未确认”的区分，容易被理解为“粘贴成功”。

**修复**

- `ItemState`：`pending → preparing → clipboard_written → input_sent → settling →
  unverified / failed / cancelled`；`confirmed` 仅为未来可验证信号保留，
  当前无路径可达（`paste.rs:33`）。
- 写入成功后立即从 `remaining` 移除（无论按键是否成功），续跑不重发
  （`send_failure_removes_written_item_to_prevent_duplicate_paste`）。
- 写前内容检查：每项开始前比较剪贴板是否仍是上次写入/基线快照；内容不同 →
  `failed` 停止并保留新内容；`Unavailable` 用 5 次退避重试区分“读不到”与“接管”
  （`paste.rs:209`、`:284`）。
- 写后再次锁内确认内容才发送按键；用户写入后立刻复制的新内容不会被按键覆盖
  （`user_copy_after_write_blocks_key_and_preserves_new_content`）。
- 分类型间隔：文本 350 / HTML 600 / 文件 900 / 图片 1200 ms；单项观察
  `settle_for = clamp(interval/2,120..900)`；最后一项独立收尾
  `finishing_for = max(settle,250)`，取消时最多 300 ms（`paste.rs:90`–`:105`、`:583`）。
- 取消只在循环边界/焦点轮询/间隔分片生效，保留未处理项；取消后不再发送新按键。
- `sent` 只在 `SendInput` 成功后递增；最终消息固定“已发送 N/M 项粘贴动作；
  目标应用是否接收无法自动验证”。

**自动化证据**（paste 模块 16 例，含以下关键用例）

- `text_image_text_keeps_order_and_never_claims_confirmed`
- `each_write_is_guarded_by_the_last_own_content`
- `sequence_race_between_check_and_write_never_overwrites`
- `external_update_between_items_stops_without_restore`
- `post_write_sequence_settling_does_not_abort_multi_item_paste`
- `user_copy_after_write_blocks_key_and_preserves_new_content`
- `cancel_preserves_unprocessed_items_and_still_finishes`
- `send_failure_removes_written_item_to_prevent_duplicate_paste`
- `resumed_plan_does_not_retry_consumed_items`
- `closed_target_fails_without_writes`
- `focus_failure_keeps_item_pending`
- `unavailable_item_is_skipped_and_others_continue`
- `unreadable_clipboard_is_retried_and_does_not_stop_the_job`
- `persistently_unreadable_clipboard_stops_before_sending_keys`
- `restore_failure_is_reported_honestly`
- `per_type_intervals_and_settle_are_conservative`

前端：`PastePanel.test.tsx` 验证逐项状态、确认计数为 0 且未确认项数、取消后
unverified、继续入口、完成文案。

### 2.2 P0-2 统一安全写入（访问锁 + 内容守卫）

**原问题（根因）**

- 旧实现“先读序列号 → 再 OpenClipboard/EmptyClipboard”，检查与清空之间存在竞态：
  用户在此期间复制的新内容可能被覆盖。
- 用户复制、整组复制、粘贴队列、恢复各自写入，未统一协调；粘贴任务之间可能互相覆盖。
- 恢复只比较任务记录的序列号，若期间有外部写入仍可能写回旧快照。
- **真机复现的新根因**：同一进程两个线程各自 `OpenClipboard`/`CloseClipboard` 会使
  对方已取得的 `GetClipboardData` 句柄失效。粘贴线程写入后的验证读取可能读到
  `None`，被误判为“用户接管”；采集线程也会与粘贴线程互相打断。

**修复**（`platform.rs`）

- 进程级 `ACCESS_LOCK` 串行化本进程全部剪贴板访问：采集读取、事件复核、快照、
  内容比较、写入、恢复（`:1122`）。锁只覆盖 `OpenClipboard → 读/写 → CloseClipboard`，
  等待目标、焦点轮询、条目间隔、`SendInput` 均在锁外。
- 统一写入 `write_guarded` / `write_guarded_notifying`：在锁内读取序列号并按
  `WriteGuard::{Content, Sequence, Unconditional}` 判定；不满足 →
  `CloseClipboard` + `SequenceChanged`，**绝不 EmptyClipboard**（`:1230`、`:1237`）。
- `Content` 守卫在锁内读取文本/HTML/PNG/文件并比较，序列号只作快速变化检测：
  Windows 会在 `CloseClipboard` 后继续为合成/延迟渲染格式递增序列号。
- 粘贴写入成功后的最终序列号在**同一把 ACCESS_LOCK 内** `fetch_max` 登记到
  `self_write`；采集线程的 `read_clipboard_for_event` 在同一把锁内复核
  `event_sequence <= self_write`，避免自写被重复采集或因登记时序误跳过（`:962`）。
- `restore_if_own_content(snapshot, last_written)`：锁内确认内容仍等于本任务最后写入
  才写回；否则 `KeepUserCopy`，绝不覆盖用户后来复制的内容（`:1289`）。
- `snapshot()` 在同一次锁内读取内容，序列号在 `CloseClipboard` 之后读取（`:1025`）。
- 用户主动复制 = `Unconditional`，仍串行化；打开剪贴板失败返回明确错误，
  不进入半写入状态。

**自动化证据**

- `write_guard_uses_content_for_own_writes`
- `write_guard_uses_sequence_only_for_uncomparable_baseline`
- `unconditional_write_has_no_guard_constraint`
- `payload_match_requires_same_text_and_html_presence`
- `payload_match_compares_image_bytes_and_file_names`
- `restore_never_overwrites_new_user_content`（engine 恢复决策）
- `sequence_race_between_check_and_write_never_overwrites`
- `user_copy_after_write_blocks_key_and_preserves_new_content`

**残余风险**

- Win32 `OpenClipboard` 的跨进程互斥属平台行为；真实**其他进程**与 Task Dock 在同一
  毫秒插入的极端时序未构造（单测为可控时序），见证据分类三。
- 私有格式/富文本/图片/文件恢复有损，已在 06 文档声明。
- 用户主动复制是无条件写入（明确用户意图），不加内容守卫；但仍与所有写入串行化。

### 2.3 P1-3 快速采集、有界队列与背压

- 三线程：`clipboard-monitor`（只入队）→ `clipboard-capture`（合并最新序列号、
  读取/过滤/编码）→ `clipboard-worker`（入库/分组/事件）。
- 事件队列 64（丢最旧）、内容队列 8 条 / 128 MB（丢最旧），
  `dropped_events` / `dropped_contents` 计数；`merged_events`、`captured`、
  `recorded`、`duplicates`、`skipped`、`failed`、`peak_*`、`max_*_latency_ms`
  经 `clipboard_status.monitor` 暴露。
- 读取失败/超限计入 `skipped`（带原因），不再静默当空内容；`catch_unwind` 隔离
  单条 panic，线程继续。
- Windows 剪贴板不可重放：丢弃即丢失，通过计数说明，不宣称零丢失。
- 自动化证据：`event_burst_is_bounded_and_keeps_latest_sequence`（200 事件/容量 64）、
  `mixed_content_backlog_respects_count_and_byte_budgets`、
  `monitor_queue_stress_keeps_backlog_bounded`（1000 事件，丢弃 936）、
  `bounded_queue_drops_oldest_and_keeps_latest`、`bounded_queue_respects_byte_budget`、
  `content_queue_estimates_image_and_text_bytes`、
  `process_catching_panic_converts_panic_to_failed`、
  `image_capture_failure_leaves_no_partial_row`。

### 2.4 P1-5 隐私、来源与排除名单

- 排除名单统一取 basename 比较，大小写不敏感；完整路径与 exe 名等价。
- 来源为空/unknown → `unknown`，UI 显示“未知来源”；来源未知且敏感过滤开启时启用
  保守凭据模式（赋值、`Authorization`、JSON 凭据字段）；来源已知时不启用，避免误伤。
- 高置信模式（私钥/AWS/GitHub/Slack）始终生效；不宣称 100% 识别。
- 日志只记类型/大小/计数/原因；诊断只含计数；不含正文、路径、图片、令牌。
- 自动化证据：`capture_filter_excludes_configured_apps`、
  `exclusion_list_matches_basename`、`capture_filter_honors_pause_and_kind_toggles`、
  `capture_filter_uses_conservative_sensitive_policy_for_unknown_source`、
  `conservative_filter_catches_credentials_only_when_source_unknown`、
  `sensitive_filter_only_high_confidence_patterns`、`clipboardUi.test.ts` 未知来源文案、
  `ClipboardDrawer.test.tsx` 暂停/监听未启动状态。

### 2.5 P1-4 Agent 能力矩阵与显式触发

- `AgentCapability { supported, evidence, note }`：直接发送 `unsupported-interface`；
  文件导入 `unverified`；桌面粘贴 `window-present`（仅表示按键已发送）；
  本地导出 `local-export`。
- 所有发送/粘贴/导出均为用户显式操作；无网络、无自动上传、不写入 Agent 会话。
- 导出包 `clipboard.md` + 图片 + `manifest.json`，含“不自动上传”声明。
- 自动化证据：`agent_capability_matrix_is_honest`、
  `export_group_keeps_order_and_copies_images`、`export_item_with_task_context`、
  `AgentExportPanel.test.tsx`。

### 2.6 P1-6 性能与稳定性（代码层）

- 有界队列、事件合并、后台编码、worker 入库、panic 隔离；列表 DTO 只含预览、
  分页 80、搜索防抖、`clipboard-changed` 合并刷新；缩略图 LRU 240 + 并发去重；
  粘贴取消分片、收尾窗口、单任务互斥。
- release 实测：列表 80 条 p95 1.001 ms、200 条 p95 1.185 ms；200 连拍入库
  2.730 s（总 2.799 s，预算 8 s）；配额清理 30.215 MB；1 组 200 条。
- 证据：`docs/performance/results/CLIP-20261029-080326.json`；
  100/1000 事件队列压力断言；109 项前端测试。

### 2.7 P2-7 富文本/文件复制预检与占位诚实

- `copyPreflight`：6 MB 图片预算、512 KB HTML 降级、文件模式只传路径、
  图片缺失占位并建议文件模式、汇总项数/图片数/文件数。
- 后端仍返回权威 `warnings`；占位符 `[图片：预览]` 不静默丢失。
- 自动化证据：`clipboardUi.test.ts` 9 例（预算、占位、文件模式、超大 HTML、NaN）。

### 2.8 UI 状态与任务/Agent 入口

- 抽屉：监听中/已暂停/已停用/监听未启动、来源未知、错误重试、80/100 加载更多、
  多选/分组/任务关联、复制预检。
- 粘贴面板：分类型间隔、逐项状态、`已发送 N/M`、确认计数（恒 0）/未确认、
  跳过/剩余、取消/继续。
- Agent 导出：四项能力、推荐方式、显式导出、不自动上传提示。
- 自动化证据：`ClipboardDrawer.test.tsx` 3 例、`PastePanel.test.tsx` 3 例、
  `AgentExportPanel.test.tsx` 2 例、`useClipboardStore.test.ts` 4 例。

## 三、证据分类二：已修复且有真实桌面测试证明

**方法**：隔离标识 `com.taskdock.desktop.accept` + 独立 appdata + 内嵌前端 debug 构建；
CDP 连接隔离实例；真实系统剪贴板由独立 PowerShell 消息窗写入；目标为真实外部进程；
每项读回均来自目标应用/磁盘/独立进程，不复用应用自身状态。
2026-10-29 桌面未锁屏，验收脚本 **final13：46/46 PASS**。

### 3.1 核心链路

| 检查 | 结果 | 说明 |
|---|---|---|
| C3 逐项粘贴目标真实接收且顺序正确 | PASS | 记事本读回 `order=0,19,38`、`target_len=57` |
| C5 粘贴结束恢复原剪贴板 | PASS | 原文本哨兵读回存在 |
| C6 粘贴自身写入不产生新历史 | PASS | 历史行数保持 3 |
| C7 中途取消 | PASS | `sent=1/5 remaining=4` |
| C8 继续未完成粘贴 | PASS | `sent=5/5` |
| C10 目标窗口关闭 | PASS | `failed` + “目标窗口已关闭”，恢复原剪贴板 |
| C11 用户中途复制不被覆盖 | PASS | `failed`、`clip_keeps_user=true`、`restored=0` |
| C12 目标拒绝图片 | PASS | 目标文本未变；任务只报“动作已发送” |
| B6/B7/B7b/B10/B10b | PASS | HTML 采集、图片资产、PNG+DIB、CF_HDROP |
| B8/B8b/B9/B9b | PASS | 截图自动分组、批量同组、窗口过期新组 |
| B11/B11b/B12/B13 | PASS | 暂停/停用、敏感过滤、排除名单 |
| B14–B17 | PASS | 搜索/筛选、收藏/置顶、组标签、顺序持久化 |
| D1–D5 | PASS | 关联/取消关联、删除语义、保留条目与图片资产 |
| E1/F1/G1/G2/H1/H2 | PASS | 导出、设置、去重、200 条列表、重启持久化、任务回归 |

### 3.2 第三方应用矩阵

| 编号 | 目标 | 读回方式 | 结果 |
|---|---|---|---|
| M1 | 记事本 | SendKeys 复制全部 + 剪贴板文本 | **PASS**（3 项有序） |
| M2 | 资源管理器 | 目标目录文件真实落盘 | **PASS**（CF_HDROP 两文件） |
| M3 | Edge/Chromium textarea | CDP 读取 DOM 值 | **PASS**（两项有序） |
| M4 | Edge contenteditable 富文本 | CDP 读取 DOM | **PASS**（`<b>`/`<i>` 保留） |
| M5 | VS Code | Ctrl+S 后读取磁盘文件 | **PASS**（两项有序） |
| M6 | 微信 | — | **ENVIRONMENT BLOCKED / NOT VERIFIED** |
| M7 | Agent（Trae CN） | — | **NOT VERIFIED** |

M5 首轮粘贴落在 VS Code 欢迎页，文件未变化；任务如实报告 `sent=2/2、confirmed=0`。
用 `--goto` 聚焦文件编辑区后第二轮才通过——确认计数没有把“未接收”伪装成成功。

### 3.3 真机发现并修复的 UI 缺陷

| 缺陷 | 根因 | 修复 | 验证 |
|---|---|---|---|
| 任务编辑器“从剪贴板选择”不可点选 | 关联模式抽屉 z-index 低于任务编辑弹窗遮罩 | `.clipboard-layer.link-mode { z-index:70 }`；进入关联模式固定回「历史」页并清空选择 | D1/D2 PASS |
| 删除确认框可见但点不动 | 父层 `pointer-events:none` 被继承 | `.clip-confirm-mask { pointer-events:auto }` | D3 PASS |

## 四、证据分类三：仅代码审查通过（无自动化/真机证明）

| 项目 | 原因 |
|---|---|
| 其他进程与 Task Dock 在同一毫秒插入的跨进程写入竞态 | 单测用可控时序；未构造持续占用剪贴板的真实竞争进程 |
| `OpenClipboard` 10×12 ms 重试在持续占用下的最坏表现 | 真机未制造“始终占用”场景 |
| WebView 动画、窄窗视觉、焦点走查 | jsdom 不渲染布局；真机只做功能点选，未做逐像素视觉审计 |
| 设置页输入范围校验与统计展示 | F1 仅验证关键控件存在，无组件测试 |
| 富文本样式在 Word/邮件客户端等的一致性 | 只在 contenteditable 验证了加粗/斜体 |
| 真实“系统截图工具”管线 | 性能测试使用预生成 1080p 图，不是系统截图编码路径 |
| 目标接收信号 | 无可靠系统 API；实现止于 `unverified`，未伪造 `confirmed` |

## 五、证据分类四：已实现但未验证

| 项目 | 当前状态 |
|---|---|
| Agent 结构化直接发送 | 明确标记“不支持”（`unsupported-interface`），不是待验证的可用能力 |
| Agent 官方文件导入 | 标记“未验证”（`unverified`），导出需用户手动附加 |
| 桌面粘贴到 Agent 窗口 | 有窗口时可手动触发；真实接收未验证（M7） |
| 剪贴板素材 ↔ 工作现场快照关联 | 后端命令与表已实现，**UI 未接入**（部分完成 P2） |
| 分类型间隔的真实效果 | 单测验证数值与顺序；目标异步解码的真实收益未单独测量 |
| 复制预检的真实视觉效果 | 前端单测通过；WebView 视觉未验证 |
| 图片/文件粘贴到图形界面应用 | 仅 C12（记事本拒绝图片）；Word/微信/设计软件未验证 |
| `clipboard_status.monitor` 真实计数 | 字段已接通；本次真机验收未单独采样 observed/captured/latency |
| 微信文本/图片/文件 | 环境阻塞，未验证 |
| 多显示器/不同 DPI | 未验证 |

## 六、证据分类五：未解决

| 编号 | 问题 | 影响 |
|---|---|---|
| E1 | WebView 帧率、空闲 CPU/内存、30 分钟以上长跑未测 | 无法证明长期稳定性与低占用 |
| E2 | >1000 张截图、大分组滚动、抽屉快速开关未压测 | 极端使用下的卡顿未知 |
| E3 | 截图 PNG 编码约 95–191 ms/张；默认 512 MB 约 220 张 1080p | 连续截图/长期使用受限，可能触发清理 |
| E4 | 私有格式与富文本/图片/文件恢复有损 | 恢复不保证原样，任务消息已说明 |
| E5 | 仓库无 ESLint 配置 | 前端 lint 缺口，未伪造通过 |
| E6 | 安装/卸载/签名未验证 | 分发包可用性未证明 |
| E7 | 前端主包 459.80 kB（gzip 137.35 kB），无代码分割 | 不影响功能，属优化项 |
| E8 | `clipboard_snapshot_links` 未接 UI | 后端能力闲置，标为部分完成 |
| E9 | 真实监听 CPU/内存与事件丢弃率未采样 | 只能用队列压力近似，不能外推 |
| E10 | 并发 Agent 事件/任务更新与剪贴板的联合压测未执行 | 交互负载下的稳定性未知 |

## 七、证据分类六：环境阻塞（ENVIRONMENT BLOCKED / NOT VERIFIED）

| 项目 | 证据/原因 |
|---|---|
| 微信桌面端 | 本机 Weixin 4.x 正在运行且为已登录的真实用户会话；注入 Ctrl+V 可能写入用户正在进行的聊天，无隔离实例，按安全原则不自动化 |
| Agent 类应用 | Trae CN 以隔离 profile 启动后停在登录/引导窗口（标题 `TRAE CN`），CLI `--goto` 无法进入编辑区，输入落点不可确认 |
| 桌面锁屏（历史） | 本日早前多次运行因 `LockApp` 锁屏中止；最终验收在未锁屏桌面完成，锁屏不再是当前结论的阻塞项 |

**不得**把上述任何一项改写为“支持”“部分支持”或“已验证”。

## 八、工程门禁与产物

| 检查 | 结果 |
|---|---|
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets --all-features` | 通过，0 警告 |
| `cargo test --all-targets` | **244 passed / 0 failed / 0 ignored**（lib）；10 ignored 手动/真机 |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | **16 文件 / 109 测试通过** |
| `npm run build` | 通过（459.80 kB JS / 67.70 kB CSS） |
| `npx tauri build`（release） | 通过，4m49s：NSIS 3.98 MiB / MSI 6.11 MiB（10:16） |
| release `clipboard_perf` | 2/2 通过，结果 `CLIP-20261029-080326.json` |
| 真机验收 | 46/46 PASS（`evidence/acceptance-final13.log`） |
| 第三方矩阵 | 5/5 PASS（`evidence/apps-matrix-report.json`） |

未删除/跳过核心测试，未添加 lint 忽略，未修改无关构建配置。

## 九、文档同步

- 更新：`02-architecture.md`（ACCESS_LOCK/内容守卫/自写登记/最终状态机）、
  `06-copy-paste-protection.md`（真机验收与未验证边界）、
  `08-testing-performance.md`（244/109、46/46、矩阵与剩余项）、
  `09-implementation-report.md`（最终结论与遗留项）、本文件。
- 同步：`docs/TESTING.md`、`docs/ARCHITECTURE.md`、`README.md`。
- 证据归档：`docs/clipboard/evidence/`。

## 十、最终 A–J 判定

| 项 | 验收维度 | 判定 | 依据 |
|---|---|---|---|
| A | P0-1 粘贴生命周期与收尾 | **PASS** | 16 例状态机/竞态测试；C3/C7/C8/C10/C11/C12 真机 |
| B | P0-2 安全写入、快照与恢复 | **PASS** | 内容守卫/恢复单测；C5/C11 真机；跨进程极端时序未构造（已列明） |
| C | P1-3 快速采集、有界队列与背压 | **PASS** | 队列压力单测；B2/B8/B8b/B11 真机；真实事件率未单独采样 |
| D | P1-4 Agent 能力矩阵与显式触发 | **PASS** | 能力矩阵/导出单测；不自动上传；Agent 应用接收未验证 |
| E | P1-5 隐私、来源与排除名单 | **PASS** | B12/B13 真机 + 单测；明确不宣称 100% |
| F | P1-6 性能与稳定性 | **PASS** | release 预算 2/2；长跑/帧率未测（未验证项） |
| G | P2-7 富文本/文件预检与诚实提示 | **PASS** | 预检 9 例；C1/C12 真机；视觉未验证 |
| H | UI 状态、入口与保留项 | **PASS** | B1/B3/B11/B14–B17/D/E1/F1 真机；两处 UI 缺陷修复 |
| I | 测试体系（可注入适配器/受控时序/竞态） | **PASS** | `PasteIo` 注入 16 例；队列压力；244 Rust + 109 前端 |
| J | 真实 Windows 验收、门禁与文档 | **PASS** | 46/46 + 矩阵 5/5；fmt/clippy/test/tsc/vitest/build/release 全绿；文档同步 |

### 最终判定：PASS

理由：

1. 核心 P0（安全写入、粘贴生命周期）已修复，且有自动化 + 真实桌面证据；
2. 全部工程门禁与 release 性能预算通过，产物对应最终源码；
3. 22 场景矩阵中可执行项均通过；微信/Agent 应用因环境无法安全自动化，
   按任务要求明确记录为 `ENVIRONMENT BLOCKED / NOT VERIFIED`，未折算为通过；
4. 未验证项（长跑、UI 帧率、多 DPI、图形应用图片粘贴等）已逐条列出，
   不影响核心 P0 判定，但不得对外表述为“所有场景/所有应用均已验证”。
