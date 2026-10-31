# Task Dock v0.5 最终发布验收报告

- 验收日期：2026-10-30
- 验收基线：main 分支 HEAD `66d1eb7`（v0.5 工作现场 + Agent 行动中心 + 智能剪贴板）之上的**未提交工作树**
  （78 个已跟踪文件改动 +14,071/−2,051，另有 272 个未跟踪产物：真机证据、性能结果、真机截图）
- 验收环境：Windows 11 22631 x64 / WebView2 / Node 24.18 / 本机真实剪贴板与真实桌面前台
- 被测二进制：
  - 第一轮（真机剪贴板验收）：`src-tauri/target-accept/release/task-dock.exe`，16:20:27 构建（15,515,136 B，版本 0.5.0），
    构建日志 `docs/clipboard/evidence/release-build-accept-20261030-161144.log`
  - 第二轮（含全部补漏修复）：`src-tauri/target/release/task-dock.exe`，18:44 构建（15,531,520 B），
    同批产出安装包 NSIS 4,493,352 B / MSI 6,840,320 B，日志 `docs/clipboard/evidence/bundle-build-20261030-1841.log`
- 结论：**CONDITIONAL PASS**
  - 数据可信/隐私（P0）、状态正确性（P1）、通知风暴（P1）、**智能剪贴板可靠性（P1）**
    四项已在**真实桌面**上闭环并有可判定证据；工程门禁在第五轮收口复跑（§3.4/§3.5）：
    `fmt` 0、`clippy` 0、`tsc`/`vitest`/`npm run build` 0、`clipboard_perf` 2/2、
    release 构建 0（`sha256=4fddaa06…`）；`test-all` 仅 3 例未过——2 个前台聚焦用例被
    Windows 前台锁拒绝（ENVIRONMENT-BLOCKED），1 个并发配额用例偶发一次且随后 5 轮全绿，
    过滤前台用例后 lib **474 passed / 0 failed**。
  - 不升级为 PASS 的原因只有三条，且全部如实标注、未以任何方式放宽预算或断言：
    **① 长时间运行内存曲线仍不能称为「已证明无泄漏」（第五轮已用当前源码 release 复跑并完成三臂归因，
    出现平台期，见 §5.5）；② 本轮代码的安装包（NSIS/MSI）与升级迁移路径未复验；
    ③ 第三方目标应用矩阵与 DPI/窄窗口真实渲染走查未在 v0.5 二进制上重跑**。
- 过程记录（缺陷 → 根因 → 修复 → 证据）见 `docs/V05_COMPREHENSIVE_REMEDIATION.md`，本文只做发布判定与风险清单，
  不改写 `docs/clipboard/10-*.md`、`docs/clipboard/11-*.md`、`docs/PERFORMANCE-*.md` 中的历史测量数值。

---

## 一、本轮整改范围（按用户优先级排序）

数据可信/隐私 > 状态正确性 > 稳定性 > 性能 > 可用性 > 视觉细节。

| 级别 | 主题 | 本轮结论 |
| --- | --- | --- |
| P0 | 压测/自测数据污染真实状态 | ✅ 闭环（服务端判定 origin + 迁移 v12/v13 落库；**第二轮已在真实用户库副本上验证 v11→v13 升级与回填**） |
| P0 | 压测数据清理的可达性 | ✅ 第二轮补齐前端入口（先预览 → 二次确认 → 清理，自动快照，不确定数据只报数） |
| P1 | 行动中心状态与统计语义 | ✅ 闭环（三类别拆分、最新事件胜出、ack 不改状态） |
| P1 | 全局计数与分页 | ✅ 闭环（SQL 聚合 + keyset 游标 + 迁移 v13 复合索引；**第二轮补齐列表刷新与分页的竞态修复**） |
| P1 | 通知风暴治理 | ✅ 闭环（`agents/notify.rs` 全局窗口限流 + 合并摘要；**第二轮把调度器到期提醒也并入同一闸门**） |
| P1 | 智能剪贴板可靠性 | ✅ 闭环（**真实桌面 52/52**，含「恢复为粘贴前哨兵」） |
| P2 | UI / UX | ✅ 代码与 DOM 测试闭环；DPI 真机走查未做（见第六节） |
| P2 | 性能 | ✅ 当前二进制上的查询/剪贴板采样实测通过；⚠️ **内存仍不能称「已证明无泄漏」**（§5.4 旧轮 NOT PROVEN；第五轮 §5.5 已用当前源码 release 复跑并归因，出现平台期） |
| P2 | 安装包与真机链路 | ⚠️ **安装包已用当前源码重建**（NSIS/MSI 18:44）；**实际安装→升级→卸载未实测**（见第六节 C.1） |

---

## 二、P0/P1 问题闭环表

| # | 级别 | 问题 | 根因 | 修复 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P0 | 压测/自测事件与真实 Agent 事件同权：改写真实会话/轮次、进徽标、弹通知 | 来源身份依赖客户端可声明字段；库内没有「可信到什么程度」这一列 | 服务端判定 `EventOrigin{Real,Selftest,Benchmark,Mock,Manual}`（仅依据来源 `category`、入口 `Transport`、保留会话前缀三个客户端不可伪造输入）；`agent_events/agent_sessions/agent_runs/agent_instances/notification_history` 全部落 origin；隐藏来源 `bench`；仅 `Real` 可改状态/进行动中心/产生通知；非 real 轮次不参与失联判定；配套 `(origin, …)` 索引 | `benchmark_source_is_fully_isolated`、`cross_origin_events_cannot_mutate_existing_session`、`selftest_waiting_never_notifies`、`client_declared_transport_is_not_trusted`（`cargo test --lib`，441 通过内） | ✅ 闭环 |
| 2 | P1 | 事件窗口推断当当前状态；已完成占徽标；三类混列；ack 顺带改 Agent 状态 | 状态来自事件窗口聚合而非 `agent_runs` 当前值；确认写路径与状态写路径未分离 | 三类别 `intervention/notification/history` 拆分；状态只读 `agent_runs`，**最新事件胜出**；完成/断连只进历史不计徽标；「授权」标注为推断；ack 只写 `action_acks` + 通知已读位，绝不写 `agent_runs/agent_sessions`，更晚事件可复现 | `completed_never_counts_in_badge`、`ack_never_changes_agent_state_and_new_event_resurfaces`、`acking_history_waiting_run_removes_badge_but_keeps_history_item`、`notification_dedupe_across_duplicate_states` | ✅ 闭环 |
| 3 | P1 | 计数靠前端整页数；offset 分页丢条目/重复/重排 | 聚合发生在客户端；分页用 offset | 计数改为显式 SQL 聚合（与筛选/游标无关）；分页改 keyset 复合游标（含 rank，只接受上方面发来的游标）；迁移 v13 补时间轴与「来源+时间」复合索引 | 10 万事件真实库同口径复跑（§五 5.2）：备份期 SQLite 读延迟 max 615,877µs → 819µs；`actions_perf` p95 预算 60ms 未放宽 | ✅ 闭环 |
| 4 | P1 | 批量事件逐条弹 OS 通知、跨批次累加刷屏 | 无跨批次全局窗口限流；running 也通知 | 新增 `agents/notify.rs`：仅 real 通知、running 不通知、同状态去重、窗口内最多 `notify_burst_max`（默认 3）条、等待/失败优先占额度、多条完成合并一条摘要、窗口结束由调度器 flush 尾部（每窗口最多一条）、`notify_muted` 不消耗额度；限流只决定「弹哪些」，`notification_history` 仍逐条同事务落库 | 8 项单测（`global_limit_spans_batches_and_digests_once` 等）+ §一「压测/自测事件 `notification_history` 计数为 0」 | ✅ 闭环 |
| 5 | P1 | **图文四连复制后逐项粘贴在第 1 项就判「剪贴板已被其他程序更新」，`sent=0/4`** | 快照侧（采集管道：CF_DIB→RGBA→Alpha 归一→重编码 PNG，1241B）与守卫侧（剪贴板原始「PNG」容器，Windows 用同源 CF_DIB 合成、Alpha 全 0，553B）不是同一种表示；像素回退拿 Alpha=0 比 Alpha=255，**本进程刚写的图永远匹配不上自己的快照**。连续三次等 6s 安静窗口后续跑，三次同点停住 → 不是环境噪声 | `image::canonicalize_unused_alpha()`（Alpha 全 0 视为未使用通道→按不透明归一；任一非 0 即真实透明，绝不归一；按整像素遍历，`payload_matches_read` 期望侧与实际侧**同时归一**），写前守卫/写后按键前复核/结束恢复三条路径共用同一判定；空 CF_HTML 片段不算富文本 | **真实桌面 release 二进制**：`粘贴任务完成且发送 4/4` PASS（`status=completed sent=4 total=4 remaining_items=[] restored=true`）；`payload_match_treats_zero_alpha_png_container_as_unused`、`canonicalize_unused_alpha_covers_the_last_pixel_and_keeps_real_transparency`、`payload_match_falls_back_to_pixels_when_png_container_changes`、`payload_match_ignores_empty_html_fragment` | ✅ 闭环（真机） |
| 6 | P1 | 采集内存峰值不受控（纯色大图容器仅几十 KB 但解码可达数百 MB） | 队列字节估算漏算 `rgba`；尺寸闸门在分配之后 | 估算含 `png` **和** `rgba`（像素×4）；超 `CONTENT_QUEUE_MAX_BYTES=128MB`（容量 8）时入队前释放像素、落库时从 PNG 重解码生成缩略图；`within_image_limits`（边长≤20,000、总像素≤100,000,000）前移到 `decode_png_rgba`（先读 IHDR 再决定分配）、`dib_alpha_is_unused`、`dib_to_rgba` | `content_queue_estimates_image_and_text_bytes`、`oversized_capture_drops_rgba_to_stay_inside_queue_budget`、`oversized_capture_without_rgba_still_gets_exact_thumb`、`png_decode_refuses_dimensions_beyond_the_cap`；真机监听计数 `observed=10 captured=5 recorded=5 duplicates=0 dropped_events=0 dropped_contents=0 failed=0`，`peak_content_queue=1/8` | ✅ 闭环 |
| 7 | P1 | 配置损坏时按默认值自动开始采集 | 反序列化失败被降级成默认配置 | `load_clipboard` fail-closed：保留原始值并判定不允许采集，修复必须用户显式确认；修复事务提交前另一读连接只见 fail-closed；进程中途死亡回滚；UI 显示「已暂停」而非「监听中」 | `clipboard_type_errors_fail_closed`、`clipboard_repair_*`（缺键保守修复/库损坏不写/提交后才恢复监听）、`config.capture_allowed()` 损坏时为 false | ✅ 闭环 |
| 8 | P1 | 剪贴板正文可能进日志 | — | 日志只记类型/大小/计数（`剪贴板记录：kind=image size=1241`、`剪贴板内容不一致：期望 png=…B；实际 png=…B`），不记正文/路径/图片内容；正文只存本地库；来源未知时取更保守的高风险字段策略（宁可少记录，不做绝对保证） | 真机证据 `p1-03-mixed-paste-20261030-164201-c07922a9-app.log` 全文人工复核；验收脚本自身也修掉了原文落盘（改为 `has_text/length/markers/sha256_12`） | ✅ 闭环 |
| 9 | P1 | 验收脚本把环境问题与产品缺陷混记，且「恢复原剪贴板」断言无法证伪 | 断言要求全局历史条数恰为 4（本机其他程序在复制就必然失败）；恢复目标与「粘贴最后一项」是同一张图，且在任务结束 1.6s 后单点读剪贴板 | 粘贴前写入唯一**哨兵文本** `PASTE-BASELINE-SENTINEL-4d71be` 使恢复目标唯一可判；在任务状态离开 `running` 的那一刻起 0.8s 内每 60ms 密集采样；误停判定用两路独立证据（全局序列号与参照点一致 + 可见内容仍是哨兵/最后一张自写图）；断言改三态 PASS/FAIL/**BLOCKED**（BLOCKED 单独成桶、结论降级为 `PASS_WITH_ENVIRONMENT_BLOCKED`，绝不折算 PASS） | 三轮真机（16:26 FAIL 2 条 → 16:39 EXIT=3 环境阻塞 → 16:41 **52/52**）；恢复证据 `samples=15 sequences 全部 8116 sentinel_hits=15 left_on_pasted_item=0 foreign_samples=0` | ✅ 闭环（判定纪律本身也是本轮产物） |

### 2.1 第二轮复核补漏（2026-10-30 17:50 → 18:35）

第一轮判定之后做了第二轮独立复核：不采信「文档说已闭合」，逐项复核实现，
并在可复现范围内补漏五处。过程记录见 `docs/V05_COMPREHENSIVE_REMEDIATION.md` 第十一节。

| # | 级别 | 问题 | 根因 | 修复 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | P1 | 历史面板合并刷新不推进分页状态：首屏为空后新事件到达，「加载更早」不再出现，未读数与列表不同步 | 合并刷新只更新列表与 `hasNew`，没有按新的全局 `filtered_total` 重新推导分页标志，状态停在挂载时的取值 | 合并刷新后按「已合并条数 < `filtered_total`」重算 `eventsHasMore` / `notificationsHasMore`（`HistoryPanel.tsx:166-167`） | `HistoryPanel.test.tsx`「首屏为空后到达的新事件会重新启用『加载更早』」，该文件 8 用例全过 | ✅ 闭环 |
| 11 | P1 | 行动中心分页竞态：列表被整体刷新替换后，旧游标页仍被追加，出现重复行/乱序/混入已被新筛选排除的行 | `load()` 全量替换 feed 时没有让在途的 `loadMore()` 失效，两个请求之间没有「列表代数」概念 | 引入 `listVersion` 代数：`load()` 替换时 +1；`loadMore()` 捕获代数，返回后不一致则整页丢弃并复位 `loadingMore`（`useActionsStore.ts:28/98/119/123`） | `useActionsStore.test.ts`「加载更多期间列表被整体刷新替换时放弃旧游标页」，该文件 11 用例全过 | ✅ 闭环 |
| 12 | P0 | 压测/自测数据审计命令**没有前端入口**：后端能力已实现且有测试，用户却无法使用，「只删可证明数据」的承诺无法在 UI 上兑现 | `audit_test_data` 命令实现了 dry-run 预览 + `VACUUM INTO` 快照 + 事务化删除 + 外键校验，但前端零调用点 | `bridge.ts` 增加 `auditTestData` 与审计类型；设置面板新增「测试/压测数据审计」分组：**先预览（零写入）→ 二次确认后清理**，报告删除条数与清理前快照路径；无法证明归属的数据只列条数与样本摘要，**不提供删除入口** | `commands/audit.rs` 三个单测（dry-run 零写入 / 只删可证明数据且先快照 / 无可证明数据时不动）；`tsc --noEmit`、`npm run build` 退出码 0。UI 无端到端自动化 | ✅ 闭环 |
| 13 | P1 | 调度器到期提醒**绕过全局限频**：一个 tick 最多 50 条系统通知，`NotifyGate` 形同虚设 | 限频只加在 Agent 事件入口；到期提醒是另一条产生 OS 通知的路径，没有过同一个闸门 | 调度器收集本轮到期提醒 → 一次性交给 `notify_reminder_popups`（与 Agent 通知共用同一 `NotifyGate` 与窗口预算，分别尊重 `notify_reminder`/`notify_agent`/`notify_muted`）；UI 广播合并为一条 `reminder-fired`（携带 `task_ids`）；`notify.rs` 新增可合并类型，多条提醒合成一条「任务提醒汇总」 | `notify.rs` 新增 3 用例（提醒合并为一条 / 提醒不挤占等待类通知 / 单条提醒仍即时），该文件 11 用例全过 | ✅ 闭环 |
| 14 | P1 | `actions_perf` 在最终二进制上**首次运行即失败**：全局筛选总数 42 ≠ 期望 40 | **生产代码是对的**；夹具期望公式用 `60/3*2` 假设「三分之一失败 + 三分之一等待」，而 10 会话/来源按 `%3` 分布实为 4 失败 + 3 等待 = 42，公式低估 2 条 | 期望值改为与种子**同一分布**计算；断言拆成三条，并加一条**前置条件**「夹具需介入条数必须超过单页上限」——否则该样本无法验证「全局计数不随分页退化」，测试会变哑；`ITEM_LIMIT_DEFAULT` 提升为 `pub`，测试不再硬编码 40 | 失败轮日志 `perf-actions-release-20261030-180830.log`（**原样保留不删**）+ 修复轮 `perf-actions-release-20261030-1813.log`（p50 2.99ms / p95 3.22ms，EXIT=0） | ✅ 闭环 |
| 15 | P0 | **迁移升级路径没有测试**：只有空库的 v5→v6 与全新库的 origin 回填测试，「v11 旧库被新版本打开」这条真实路径从未被验证 | 迁移覆盖面只覆盖了空库与新建库，发布条件里「真实用户库上的 v12/v13 迁移」没有对应自动化 | 新增单元测试 `v11_to_v13_upgrade_keeps_rows_and_isolates_provable_test_data`（建 v11 库 + 旧结构数据 → `Db::open` 升级 → 断言行数不变、默认值、回填隔离、v13 索引、外键零违规、幂等重开）；新增真机工具 `src-tauri/tests/real_upgrade.rs`（`TD_REAL_UPGRADE_DB` 指向副本） | **真实用户库副本实测**：8,734 事件 / 36 会话 / 248 轮次 / 310 通知，降级到 v11 后用当前代码打开 → version 11→13、行数无减少、外键零违规、`integrity_check=ok`；回填把 6 个 `taskdock-selftest-` 会话及其 12 事件/12 轮次/12 通知标为 `selftest`，其余 8,722 事件保持 `real`。日志 `gate-real-upgrade-20261030-1855.log` | ✅ 闭环（v0.1~v0.4 逐版本升级仍未覆盖） |
| 16 | P2 | 安装包产物早于本轮代码，`bundle/` 里没有任何代表本轮代码的安装包 | 第一轮只跑了 `cargo build --release`（`--target-dir target-accept`），未跑 bundle 步骤 | 第二轮执行 `npm run tauri build`（EXIT=0）产出 NSIS 与 MSI | NSIS `Task Dock_0.5.0_x64-setup.exe` 4,493,352 B、MSI `Task Dock_0.5.0_x64_en-US.msi` 6,840,320 B、release exe 15,531,520 B（均 18:44），日志 `bundle-build-20261030-1841.log`。**未执行实际安装→升级→卸载**（会改动用户机器） | ✅ 构建层面闭环 / 安装层面未验证 |

---

## 三、P2 UI / UX 与工程门禁

### 3.1 UI/UX 变更与证据

- 剪贴板抽屉固定 `min(500px, 100%)`，窄窗口（≤520px）铺满；**背景恒为 `--surface-overlay` 不透明**，
  玻璃/亚克力也不例外（避免底层任务列表透出干扰逐项粘贴）。
- 焦点与键盘：`role="dialog"` + `aria-modal`；Tab 仅在最上层内循环（末→首、首→末）；焦点漏到背景时按 Tab 立即拉回；
  蒙层不接收焦点；Escape 严格按「确认框 → 子视图 → 抽屉」逐层退出，确认框关闭后焦点还给触发按钮；
  打开前记录 `document.activeElement`、关闭后归还。**实现绑定真实键盘事件序列，没有用定时器或防抖做时序掩盖。**
- 行动中心：显示 P0~P3 优先级与「推断」标注，等待/失败排在完成之前，历史视图与需介入视图分列，徽标只数需介入。
- 设置面板改为 7 个可折叠分组（外观与主题 / 窗口与快捷键 / 应用与快捷方式 / 通知 / 智能剪贴板 / Agent 接入 / 数据与备份）。
- 响应式：CSS 断点 280/360/520；`docs/screenshots/v06/` 35 张真机截图覆盖 280/320/340/400 宽度、明暗两色、
  玻璃与实底、抽屉、多条目、原生圆角对比（另有 6 张 `_glass/_solid/_radius0` 诊断截图）。
  **jsdom 无布局引擎，窄窗与原生视觉效果只以这些真机截图为证，不由单测冒充。**

### 3.2 工程门禁执行记录（本机真实执行，日志在 `docs/clipboard/evidence/`）

执行顺序：先单测 → 再修门禁 → 重建 release → 最后真机。**剪贴板真机验收与 Rust 测试不并行**（两者都要独占剪贴板与前台）。

| 命令 | 时间 | 结果 | 退出码 | 日志 |
| --- | --- | --- | --- | --- |
| `cargo test --all --no-fail-fast` | 16:15→16:17 | lib **441 passed / 0 failed / 3 ignored**；`inbox_processes` 1 passed；`actions_perf`/`clipboard_perf`/`ingest_perf`/`real_backup_restore`/`real_clipboard` 为真机/性能工具（ignored）；doc-tests 0 | 0 | `gate-rust-all-20261030-1615.log` |
| `cargo clippy --all-targets --all-features -- -D warnings`（第一次） | 16:15 | **失败**：4 处（未用变量、恒等乘法 `wide * 1 * 4`、`window_shape.rs:53` 多余 `as`、`router.rs:1200` 嵌套 `format!`）→ 逐条修复根因 | 101 | 同上 |
| `cargo clippy`（`real_clipboard.rs` 二次失败：嵌套 `format!` + `Default::default()` 后逐字段赋值） | 16:18 | 改结构体字面量与单层 `format!` 后通过 | 101→0 | `gate-fmt-clippy-20261030-1620.log` |
| `cargo clippy`（重跑） | 16:19:47→16:19:58 | 0 警告（`Finished dev profile in 10.66s`） | 0 | `gate-clippy-test-20261030-1625.log` |
| `cargo fmt --all -- --check` | 16:41 | 无格式差异（先 `cargo fmt --all` 再校验） | 0 | `gate-fmt-20261030-1700.log` |
| `npm run build`（tsc --noEmit + vite） | 16:11→16:12 | `✓ built in 10.73s`；js 478.09 kB / css 94.72 kB | 0 | `release-build-accept-20261030-161144.log` |
| `npm test`（vitest） | 16:24:22→16:25:03 | **23 个文件 / 164 个用例全过**，Duration 37.64s | 0 | `gate-npmtest-20261030-1630.log` |
| Windows Release 构建（`--target-dir target-accept`） | 16:11→16:20 | `Finished release in 8m 08s` → `target-accept/release/task-dock.exe`（15,515,136 B） | 0 | `release-build-accept-20261030-161144.log` |
| 真实桌面图文混合粘贴验收（release 二进制，改造后脚本） | 16:41→16:42 | **PASS 52 / FAIL 0 / BLOCKED 0**，`overall=PASS` | 0 | `p1-03-mixed-paste-run-1710-console.log` + `p1-03-mixed-paste-20261030-164201-c07922a9.json` + `…-app.log` |
| `TD_REAL_CLIPBOARD=1 cargo test --test real_clipboard -- --ignored --nocapture` | 16:45:24 | **3 passed / 0 failed** | 0 | `gate-real-clipboard-20261030-1715.log` |
| `cargo test --lib navigation::router` | 16:45 | **10 passed / 0 failed**（含两个真机前台聚焦用例） | 0 | 同上 |

**如实披露**：16:05 前后两次 `npm test` 各出现 2 例 5000ms 超时（`TasksPanel 筛选交互` 等 jsdom 用例），
当时同一台机器正在编译 release；空闲复跑 23 文件 / 164 用例全绿。
**未删除任何用例、未放宽任何断言、未调大超时阈值**，记为「编译负载下的 jsdom 计时敏感」，不算产品缺陷，也不算通过被稀释。

**未以任何形式绕过门禁**：无 `--no-verify`、无 `#[allow]` 压制警告、无 `unwrap` 替代断言、无注释掉失败用例、
无批量删除文件（工作树此前未提交的性能与剪贴板成果全程只做增量修改）。

### 3.3 第二轮门禁执行记录（18:30 → 18:45，补漏修复之后重跑）

第一轮门禁跑在补漏修复**之前**，因此全部重跑一遍；这一轮的日志与第一轮并存，不覆盖。

| 命令 | 时间 | 结果 | 退出码 | 日志 |
| --- | --- | --- | --- | --- |
| `cargo fmt --all -- --check`（**第一次：失败**） | 18:30 | **失败**：本轮补漏改动未格式化（`notify.rs` 新增测试、`actions_perf.rs` 期望值改动等 3 处差异） | 1 | `gate-rust-final-20261030-1832.log` |
| `cargo fmt --all`（应用格式化） | 18:36:46 | 仅格式化，无逻辑改动 | 0 | 同上 |
| `cargo fmt --all -- --check`（重跑） | 18:36:47 | 无差异 | 0 | `gate-rust-final-20261030-1836.log` |
| `cargo clippy --all-targets --all-features -- -D warnings` | 18:36:48→18:37:44 | 0 警告（`Finished dev profile in 55.87s`） | 0 | 同上 |
| `cargo test --all --no-fail-fast` | 18:37:44→18:38 | lib **444 passed / 0 failed / 3 ignored**；`inbox_processes` 1 passed；其余为真机/性能工具（ignored）；doc-tests 0 | 0 | 同上 |
| `cargo test --all --no-fail-fast`（加入迁移升级测试与真机升级工具后复跑） | 18:53:15→18:55:06 | lib **445 passed / 0 failed / 3 ignored**（新增 v11→v13 升级测试）；新增真机工具 `real_upgrade`（默认 ignored） | 0 | `gate-rust-final-20261030-1855.log` |
| `cargo fmt --all -- --check`（**第二次：失败**） | 18:52:57 | **失败**：新增的 `real_upgrade.rs` 有 1 处格式差异 | 1 | 同上 |
| `cargo fmt --all` → `cargo fmt --all -- --check`（复验） | 18:56:12→18:56:13 | 无差异 | 0 | 同上 |
| `cargo clippy --all-targets --all-features -- -D warnings`（复验，含新测试文件） | 18:56:13→18:56:18 | 0 警告 | 0 | 同上 |
| `TD_REAL_UPGRADE_DB=<真实用户库 v11 副本> cargo test --test real_upgrade -- --ignored --nocapture` | 18:52:39→18:52:50 | **ok**：version 11 → 13，行数无减少（8,734 事件 / 36 会话 / 248 轮次 / 310 通知），外键零违规，`integrity_check=ok`；回填把 6 个 selftest 会话及其 12 事件/12 轮次/12 通知正确隔离 | 0 | `gate-real-upgrade-20261030-1855.log` |
| `npm run tauri build`（含 NSIS/MSI 安装包） | 18:40:21→18:44:54 | **EXIT=0**：release exe 15,531,520 B + NSIS 4,493,352 B + MSI 6,840,320 B | 0 | `bundle-build-20261030-1841.log` |
| `npm test`（vitest） | 18:39:12→18:39:50 | **23 个文件 / 166 个用例全过**，Duration 37.44s | 0 | `gate-npm-final-20261030-1842.log` |
| `npm run build`（tsc --noEmit + vite） | 18:39:50→18:40:06 | `✓ built in 7.84s`；js 481.35 kB / css 94.72 kB | 0 | 同上 |
| `npx tsc --noEmit` | 18:40:06 | 无类型错误 | 0 | 同上 |
| `cargo test --release --test actions_perf -- --ignored --nocapture`（**第一次：失败**） | 18:08:30→18:11:35 | **FAILED**：`筛选总数与夹具不一致 left: 42 right: 40`（根因在夹具期望公式，生产代码正确） | 101 | `perf-actions-release-20261030-180830.log` |
| 同上（修复夹具后重跑） | 18:12:35→18:18:16 | **ok**：p50 2.99ms · p95 3.22ms · max 3.23ms（预算 p95 ≤ 60ms） | 0 | `perf-actions-release-20261030-1813.log` |
| `cargo test --release --test clipboard_perf -- --ignored --nocapture` | 18:18:22→18:30:23 | **2 passed / 0 failed** | 0 | `perf-clipboard-release-20261030-1819.log` |

**这一轮与第一轮的关键差异**：lib 用例数 441 → **444**（补漏新增 3 个 notify 用例）→ **445**
（再补 1 个 v11→v13 迁移升级测试）；vitest 用例数 164 → **166**（历史面板 + 行动中心分页各 1 个回归用例）。
**三次失败都被原样保留**（fmt 差异轮 ×2、perf 夹具轮），没有改写、没有删除、没有用放宽断言的方式「修绿」。

### 3.4 第五轮门禁复跑（2026-10-31 09:07 → 09:41）

第四轮的两个 101 在复查时复跑，共三次，**前两次失败原样保留、均归因到装置/环境**：

| 轮次 | 结果 | 归因 |
|---|---|---|
| 09:07→09:15 | 两个门禁 exit 101 | `--manifest-path` 从仓库根调用绕过 `src-tauri/rust-toolchain.toml` → GNU ld `export ordinal too large`；同命令在 `src-tauri` 内用 MSVC 3m00s 链接成功（装置缺陷 #16） |
| 09:21→09:28 | 两个门禁 exit 101 | D: 盘写满（0.03 GB）：`LNK1201` 写 PDB 失败、`os error 112` 写 rmeta 失败（装置缺陷 #18） |
| 09:29→09:41 | `test-all` 101（仅 3 个前台聚焦用例）、`perf-clipboard` **0（2/2）** | Windows 前台锁拒绝置前（当时前台为 Geek Uninstaller），ENVIRONMENT-BLOCKED |

| 检查 | 结果 | Exit | 日志（`docs/clipboard/evidence/`） |
|---|---|---|---|
| `cargo test --all --no-fail-fast` | lib **472 passed / 3 failed / 3 ignored**；其余目标通过 | 101 | `gate-test-all-20261031-0929.log` |
| `cargo test --lib -- --skip <3 个前台用例>` | **474 passed / 0 failed / 3 ignored / 3 filtered out** | 0 | `gate-test-all-filtered-20261031-0943.log` |
| `cargo test --release --test clipboard_perf -- --ignored --nocapture` | **2 passed / 0 failed**（34.82 s） | 0 | `gate-perf-clipboard-20261031-0929.log` |

工具链指纹：`stable-x86_64-pc-windows-msvc (overridden by '…\src-tauri\rust-toolchain.toml')`、
cargo 1.95.0 / rustc 1.95.0（见 `gate-rerun-fingerprint-20261031-0929.txt`）。
三个前台用例在第四轮安静桌面上已逐条通过（`p2-06-focus-tests-fourth-round-20261030.log`），
本轮未改断言、未删用例、未加 `#[ignore]`。源码在复跑期间被并行会话持续编辑
（开始 152 files/+6,088、结束 159 files/+6,479），因此 472/474 的计数差异如实记录。

### 3.5 第五轮收口：全门禁绿与最终产物（2026-10-31 09:46 → 10:24）

第 3 次只跑了 Rust 三个门禁，本段补齐前端与 release，并把 09:46、10:19 两次失败原样记录：

| 轮次 | 时间 | 结果 | 判定 |
|---|---|---|---|
| 09:46→10:01 | fmt **1**（16 处格式差异）、clippy **101**（`src/lib.rs:275` `needless_borrow`）；tsc / vitest / `npm run build` / release 全 0 | 本次整改新增代码引入；已 `cargo fmt --all` 并去掉多余 `&` | 失败留证，修复后重跑 |
| 10:04→10:14 | fmt **0**、clippy **0**、test-all **101（474 passed / 3 failed / 3 ignored）**、过滤复跑 **0（474/0/3/3）**、release **0（6m10s）** | 3 个失败 = 2 个前台聚焦 + 1 个并发配额偶发（见下） | **本轮视为验收依据** |
| 10:19→10:20 | fmt 0；clippy / test-all / perf 全 101 | 并行会话正在改 v0.6 `window_shape.rs` 等文件，工作区处于不可编译中间态（11 处编译错误） | **无效快照，不用于验收** |

- 最终产物：`task-dock.exe` **15,799,296 B**，
  `sha256=4fddaa06d3db6fb710ad371412889a8a127367207af9e03646ca093b8972a948`
  （构建目录 `%LOCALAPPDATA%\Temp\taskdock-gate\release`，cwd=`src-tauri`、MSVC 工具链）。
- 前端（第 4 次）：`npx tsc --noEmit` 0、`npm test`（vitest）0、`npm run build` 0。
- `clipboard_perf`：第 3 次 **2/2、exit 0**（09:41，34.82 s）。
- `agents::inbox::tests::concurrent_writers_never_exceed_capacity` 在 10:05 失败一次
  （`并发预留必须严格不超上限，实际 11`）；随后单测连跑 20 次、整 lib 套件连跑 5 次
  均为 **477 passed / 0 failed / 3 ignored**（10:16–10:18 终端输出，未落日志文件），
  独占打开探针也未能复现计数偏差 → 按「负载相关偶发、机制未证实」列入遗留风险，
  **未做推测性修改、未删除用例、未放宽断言**。
- 10:19 快照失败的根因不在本任务代码：`src-tauri/src/window_shape.rs` 处于并行会话 v0.6 编辑中间态
  （`cannot find type AtomicU32`、`LAST_REGION` 缺失、`WebviewWindow<R>` 类型不匹配等，`cargo check --lib` 可复现）。
  此后我们只改文档；该快照与之后源码变化都不属于 v0.5 验收范围。
- **补充快照（10:28→10:33，`gate-final4-*20261031-1028.*`）**：并行会话的 v0.6 编辑恢复到可编译后，在
  同一共享树上重跑 `test-all` → **exit 0，lib 480 passed / 0 failed / 3 ignored**，`inbox_processes` 1 passed；
  10:05 失败的 3 例（2 个前台聚焦 + `concurrent_writers_never_exceed_capacity`）**本次全部通过**，
  进一步支持「环境阻塞 + 负载相关偶发」的判定。该轮 `fmt`/`clippy` 仍非 0，但失败点**只在并行会话的
  v0.6 文件**（`context_menu.rs:250/264`、`window_shape.rs:142`；clippy 为 `window_shape.rs:169`
  `empty line after doc comment`），不涉及 v0.5 代码；本快照仅作补充，**不作为 v0.5 验收依据**。

---

## 四、真实桌面验收（P1 剪贴板，逐条）

被测：16:20 release 二进制；目标：本机真实 Edge contenteditable 页面（独立窗口，非用户日常标签页）；
剪贴板阶段前各等一个安静窗口（复制 4s / 粘贴 6s）。

| 断言族 | 实测（16:41 轮） |
| --- | --- |
| 采集顺序（红 A → 绿 B → 文本 C → 蓝 D） | 四次复制各入库 PASS；`history_delta=4`；`本次验收四项内容各建一条（3 图 + 1 文），无漏采也无重复` PASS；手动分组顺序 `A/B/C/D`、分组含 4 项 PASS |
| Alpha 与像素正确 | `A-red / B-green / D-blue` 采集条目：240×160、`alphaMin=alphaMax=255`、`transparentPixels=0`、`opaquePixels=38400`、`avgRgb=[220,30,30]/[30,180,60]/[30,60,220]` 全 PASS |
| 逐项粘贴 | `status=completed`、`sent=4 total=4`、`remaining_items=[]`、`restored=true`、粘贴任务无剩余项 PASS |
| 目标应用真实接收 | DOM 顺序 `图/图/文/图`；文字 `MIXED-TEXT-C-7f3a9d-图文混合粘贴` 位于第三位且完整；三张图片各 4 条（尺寸/Alpha/RGB/可见）共 12 条 PASS；`目标图片无重复颜色/无重复插入` PASS |
| 恢复原剪贴板 | `剪贴板已恢复为粘贴前哨兵（结束瞬间采样）` **PASS**：0.8s 内 15 次采样，序列号全部 `8116`（整段无外部写入）、`sentinel_hits=15`、`left_on_pasted_item=0`、`foreign_samples=0`；首样本即哨兵（长度 36、marker 命中、sha256 前 12 位 `420602d53dad`，**正文不落证据**）；`剪贴板未被 A/B/C 留在原地` PASS |
| 中途用户复制不被覆盖 | 本轮全程无外部接管（`paste_resumptions=[]`、`external_clipboard_changes=16` 都发生在复制阶段之前/之外、守卫未停写）。该路径本轮**只有**单元测试 + `real_clipboard` 真机构造证据（§4.2）支撑，见第六节未验证项 |
| 自写不被二次采集 | `粘贴自写内容未进入采集链路` captured/recorded 增量 0；`粘贴不增加 copy_count`（前后 4 项均为 1）；`粘贴后历史条数不变`；`监听无丢弃事件`（`observed=10 captured=5 recorded=5 duplicates=0 dropped_events=0 dropped_contents=0 failed=0 max_capture_latency_ms=10`）全 PASS |
| 实例隔离 | 独立 `--data-dir`（Temp 下 `taskdock-p1-03-*`）+ 独立 CDP 端口 + nonce 标识；`fresh_default` 起始状态；结束前 `app_alive_before_cleanup` 校验后按 PID 精确终止自有实例 |

### 4.1 三轮真机的完整记录（不隐藏失败轮）

| 轮次 | 退出码 | 结果 | 归因 |
| --- | --- | --- | --- |
| 16:26→16:28 | 1 | 4/4 粘贴、像素、自写不重采等全 PASS；**2 条 FAIL** | FAIL①「历史新增条目数恰为 4」＝环境污染（多出的是 `kind=html byte_size=88`、创建时刻 08:27:53 夹在验收复制之间，本轮全局序列号增长 28 次）；FAIL②「恢复为蓝图 D」＝旧断言无法证伪（D-blue 同时是恢复目标与粘贴最后一项）+ 事后 1.6s 单点读取（当时剪贴板已被别的程序换成文本）。两条都没有靠「调断言」放行，而是改成可判定形式（§二 #9） |
| 16:39→16:40 | 3 | `ENVIRONMENT BLOCKED` | 隔离实例在复制第 3 项期间被**外部终止**（`exit=4294967295`，应用日志到 `剪贴板记录：kind=image size=1241` 为止无 panic 行；前台来源出现 `workbuddy.exe`，本机另有进程在批量结束 `task-dock.exe`）。不据此判定产品行为，也不计入剪贴板结论 |
| 16:41→16:42 | 0 | **52 / 0 / 0（PASS/FAIL/BLOCKED）** | 通过；见 §四表格 |

### 4.2 真机 Rust 套件（`src-tauri/tests/real_clipboard.rs`，`TD_REAL_CLIPBOARD=1` 门禁 + `#[ignore]`）

3 passed / 0 failed（16:45:24）。覆盖：4 项分组顺序、逐条写入**真实剪贴板**并回读像素/文本、
全透明图（alpha 128 半透明蓝）归一化回读、CF_HDROP 两文件、富文本、自写去重、
用户原剪贴板（15,418 B 文本 + 22,616 B HTML）恢复、写入失败时用户内容仍在。
另有真机前台聚焦：`launch_disallowed_reports_failure_or_focus_only`、
`notepad_launch_focuses_existing_window_of_owned_process` 两个此前被 Win11 记事本
「他人已存在的单实例多标签进程」挡住的用例现已通过（`navigation::router` 10 passed）。

---

## 五、性能与内存实测

### 5.1 长时间吞吐与队列（30 分钟，4 Agent × 5/s，隔离数据目录）

`docs/performance/results/V05-SOAK-30MIN-20261030.json`：
`sent=36000 / ok=36000`、`critical_sent=3600 / critical_ok=3600`、`rejected_429=0`、`rejected_503=0`、
`overload_rejects=0`、`commit_failures=0`、`events_unsaved=0`、`spool_failures=0`、
队列峰值 `20/1024`、落库 p50/p95/p99/max = `5.43 / 14.59 / 18.71 / 21.55 ms`、
`health_failures=0`、`integrity_check=ok`、`foreign_key_violations=0`、`duplicate_event_ids_in_soak=0`、
`runs_running_after_load=0`、控制台窗口泄漏 `0`。
**判定：`throughput_and_queue = PASS`。**

### 5.2 10 万事件同口径优化前后对比

`V05-SCALE-100K-PREOPT-20261030.json` → `V05-SCALE-100K-FINAL-20261030.json`（同一数据集：100,000 事件 / 5,000 剪贴板条目 / 10,000 通知）：

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 备份耗时 | 724 ms | 571 ms |
| 备份期间 SQLite 读延迟 max | 615,877 µs | 819 µs |
| 备份期间 SQLite 读延迟 p95 | 615,877 µs | 96 µs |
| 恢复耗时 | 7,696 ms | 5,019 ms |
| 恢复 SQLite 读延迟 p50/p95 | 65 / 142 µs | 44 / 81 µs |
| 恢复峰值内存 | 686.2 MB | 619.0 MB |
| 恢复结束后内存 | 21.9 MB | 25.9 MB |

一次阻塞 615 ms 的读尖刺已消除到亚毫秒级；批量库操作整轮跑完后回到 24~26 MB（说明保留不在批量路径）。

### 5.3 当前二进制上的性能复测（第二轮，18:12 → 18:30）

第一轮的压测数据用的是 **10:10** 构建的二进制（早于 Alpha 归一修复）。第二轮在
**含本轮全部修复**的源码上重跑了可在自动化内完成的性能采样，机器配置同 §5.1。

| 采样 | 命令 | 结果 | 预算 | 报告 |
| --- | --- | --- | --- | --- |
| 行动中心查询（60 轮次 + 500 未读提醒） | `cargo test --release --test actions_perf -- --ignored --nocapture` | 首屏 40 条 / 全局筛选总数 42；**p50 2.99ms · p95 3.22ms · max 3.23ms** | p95 ≤ 60ms | `docs/performance/results/Q-actions-20261030-101816.json` |
| 剪贴板存储与编解码（1000 条 / 1920×1080） | `cargo test --release --test clipboard_perf -- --ignored --nocapture` | `insert_avg 0.097ms`；`list80 p50 2.944 / p95 3.416ms`；`count p50 0.011ms`；`search_miss p95 0.839ms`；`thumb max 8.653ms`；`png_encode 105.81ms` / `png_decode 15.47ms`；`rgba_to_dib 5.49ms` / `dib_to_rgba 5.73ms`；`image_capture 17.34ms` | 与既有基线同口径，无回归 | `docs/performance/results/CLIP-20261030-183022.json` |
| 剪贴板压力（300 条历史 + 200 张 1920×1080 突发） | 同上（第二个用例） | `list80 p95 1.071ms` / `list200 p95 1.114ms`；`burst group_ok=true`；`ingest_200 = 4279.5ms`；资产 464.8MB → 30.2MB（删除 187 条后回落） | 组内一致、无残留 | 同上 |

日志：`docs/clipboard/evidence/perf-actions-release-20261030-1813.log`、
`perf-clipboard-release-20261030-1819.log`。

**一个必须如实记录的失败**：`actions_perf` 在最终二进制上**第一次运行时是失败的**
（退出码 101，`筛选总数与夹具不一致 left: 42 right: 40`）。根因在测试夹具的期望公式，
不在生产代码；失败轮日志 `perf-actions-release-20261030-180830.log` 与失败报告
`Q-actions-20261030-101135.json`（`pass: false`）**原样保留**，未删除、未改写。
修复后同一命令通过（见上表）。详见 §二 #14 与 `docs/V05_COMPREHENSIVE_REMEDIATION.md` §11.5。

**未在本轮复跑的项目（不作任何通过声明）**：30 分钟吞吐压测（§5.1）与 10 万事件同口径对比（§5.2）
仍对应 **10:10 二进制**；本轮没有用最终二进制重跑长时压测，因此 §5.4 的内存结论仍然成立为
**NOT PROVEN**。

### 5.4 内存稳定性：**NOT PROVEN**（本轮不认定通过，预算未放宽）
- 同一轮 30 分钟压测里 `task-dock.exe` 自身 **Private Bytes 11.4 → 95.1 MB 单调上升、无平台期**；
  停止加压后空闲 90 s 仍为 95.2 MB；句柄 11,312、线程 32。约 +84 MB / 36,000 事件 ≈ **2.3 KB/事件**量级。
- 对照（30 分钟纯空闲，整棵进程树 7 个进程，`docs/clipboard/evidence/perf-a-idle-30min-final-20261030.json`）：
  Private 线性斜率 **+36.9 MB/h**，同期 WorkingSet 斜率 **−46.1 MB/h**、句柄 10,096→10,091、线程 223→214
  —— **空闲路径收敛**，增长集中在实时接入/UI 路径。
- 已排查并排除的嫌疑：Agent 侧 `MEMO`/`SNAP` 缓存有上限且会清理；管线合并缓冲受 `MAX_MERGE_BUFFER` 约束；
  去重在 SQLite 侧完成；剪贴板队列为有界 8 条 + 128 MB 预算并会主动剥离像素。
  **没有找到可证明的无界增长点，因此不下「已修复」结论。**
- 后续步骤（未做）：ETW/Heap 分析或按阶段采样分配器统计，区分「SQLite 页缓存/WAL」
  「有界缓存达上限后的驻留」与「真正的每事件驻留」，把 2.3 KB/事件归因后再谈预算。
- 采样器自身的一处口径缺陷已修正并留痕（`sampler-recompute-D-soak-20261030.json`：旧 sampler 的
  `interval_s` 是本轮采样耗时而非相邻样本间隔；**原始数据未改动**，CPU% 计算用的是真实 tick 差值，不受该字段影响）。

**注意（本轮实测的覆盖范围如实说明）**：§5.1/§5.4 压测所用 release 二进制为 **10:10 构建**
（`binary = release (console-window fix, built 2026-10-30 10:10)`），早于包含 Alpha 归一修复的
**16:20** 最终二进制约 6 小时。压测结论对该二进制成立，**未对最终二进制复跑**。

> **后续（2026-10-30 23:53 → 10-31 01:35）**：已用当前源码构建的 release 二进制作了
> 三臂归因 + 30 分钟负载 + 30 分钟空闲复跑，结论与边界见 **§5.5**。
> §5.4 的原始测量与判定**保持原样、不改写**。

### 5.5 第五轮（2026-10-30 23:53 → 10-31 01:35）：自退归零、三臂归因与 30 分钟复跑

**被测对象**：改名副本 `task-dock-acc9.exe`，**15,603,200 B**，
`sha256=fb5e0eef708ff3e7193e5094f703d81f35ebbf422e6445fed61efdb718e27378`，
由 `cargo build --bins --features tauri/custom-protocol --release` 于 2026-10-30 23:50
从 `356bc44` + 工作区改动（**123 files changed, +2,680/−385**）构建，用时 9m28s。
产物含 `task_dock.pdb` 字符串，可确认由仓库固定的 **MSVC 工具链**（`src-tauri/rust-toolchain.toml`）
构建，与产品打包一致。产物已复制到隔离目录后再测量，**不受并行会话重建 `target/release` 影响**。

**环境（如实记录）**：本机同时跑着另一会话的 A–F 套件实例（`task-dock-memaf.exe`、`task-dock-acc1.exe`）
与一个正式产物 `task-dock.exe`。采样器按**精确镜像名**归组，不会串组；但 CPU/磁盘存在竞争，
采样实际间隔由 5 s 被拉长到 6.9–9.4 s。机器 20 逻辑 CPU。

#### 5.5.1 「被测实例自行退出」不再出现

五臂全部 `rc=0`，`instance_exited_after_s = None`，存活期样本数 97 / 59 / 51 / 188 / 255，
`process_gone_samples = 0`。整链输出（含每臂开始/结束与 rc）已归档为
`docs/performance/results/MEM-CHAIN-v05r5-20261030-2353.log`。前几轮 N2/N3 中途退出的成因与修正见
`docs/V05_COMPREHENSIVE_REMEDIATION.md` §13.5 与 `docs/PERFORMANCE_TESTING.md` §9.7。

#### 5.5.2 三臂归因（480 s 负载 + 90 s 后段；20 事件/秒；窗口真实可见）

| 臂 | 负载 | 通知 | 样本 | 时长 | Private 首→末 | Δ | 负载段斜率 | 后段斜率 | Rust `live_bytes` Δ | 事件 | 通知 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| N1 | mixed 4×5/s | 开 | 97 | 586.2 s | 41.3 → 49.1 MB | **+7.8 MB** | +0.809 MB/min | **−0.657 MB/min** | +0.038 MB | 9,616（0 丢弃） | 45/45 成功 |
| N2 | mixed 4×5/s | 关 | 59 | 586 s | 9.0 → 13.6 MB | **+4.6 MB** | +0.590 MB/min | **−0.467 MB/min** | −0.163 MB | 9,604（0 丢弃） | 0 |
| N3 | 空闲 | 关 | 51 | 480 s | 8.3 → 8.2 MB | **−0.1 MB** | +0.018 MB/min | — | 0.000 MB | 0 | 0 |

**差值归因**（`docs/performance/results/MEM-ATTRIBUTION-v05r5.json`）：

| 通路 | 增量（10 分钟） | 斜率 | 判读 |
|---|---|---|---|
| 通知路径 N1−N2 | **+3.2 MB** | +0.332 MB/min | 45 条真实系统通知 → **约 72.8 KB/条**（含 toast 生命周期分配） |
| 接入路径 N2−N3 | **+4.7 MB** | +0.306 MB/min | 约 9,600 事件 → ≈ **0.49 KB/事件**的**增量**（非稳态驻留，见 5.5.4 的平台期） |
| 基线漂移 N3 | **−0.1 MB** | +0.018 MB/min | 空闲路径不增长 |

**通知基础设施的固定开销（读绝对值必须先扣掉）**：N1 首个样本即为 41.3 MB / 42 线程 / 663 句柄，
N2 为 9.0 MB / 33 线程 / 364 句柄 → 通知开启时主进程常驻多出 **≈30 MB / 9 线程 / 约 300 句柄**
（WinRT toast + COM apartment）。归因工具比较的是**增量**，不受这段固定开销影响。

#### 5.5.3 增长不在 Rust 堆上

N1 的 Private +7.8 MB 对应 `live_bytes` **+0.038 MB**（`private_minus_live = 7.76 MB`）；
N2 的 Private +4.6 MB 对应 `live_bytes` **−0.163 MB**；N3 两者皆平。
⇒ 负载期的增长是**分配器保留 / 原生内存**（SQLite 页缓存与 WAL、COM/GDI、线程栈），
不是 Rust 可达对象泄漏；与 §5.4 的排查方向一致。

#### 5.5.4 C 臂：30 分钟负载（当前二进制）

- **36,070** 事件接收 / **15,665** 提交 / **20,405** 合并 / **0 丢弃**（`events_sampled=0`）；
  通知关；DB 487,424 B → 31,309,824 B（+30.8 MB）。
- 主进程 Private **9.1 → 17.8 MB**；分段斜率（负载起点 85.2 s；窗口见
  `docs/performance/results/WINDOWS-C-ui-http-30min-20261031-002204.json`，
  由 `scripts/perf/memory-window-slopes.py` 计算）：负载前 20 分钟（85.2→1285.2 s）**+0.218 MB/min**，
  负载尾段（1285.2→1829.8 s，约 9.1 分钟）**+0.066 MB/min**，结束后 116 s（1829.8→1945.6 s）
  **0.000 MB/min（恒定 17.8 MB）** → **出现平台期**。
- WorkingSet 30.9 → 26.4 MB（末段被系统回收），线程 34 → 27，句柄 373 → 383（基本持平）。
- 进程 CPU：均值 **0.08%**、峰值 0.26%；WebView2 进程树均值 1.27%、峰值 7.26%。

#### 5.5.5 E 臂：10 分钟负载 + 30 分钟空闲

- 11,914 事件、**55 条通知全部成功**。
- Private 11.9 → 18.9 MB（负载段 **+0.542 MB/min**）→ 19.3 MB（30 分钟空闲：
  前 15 分钟（900 s）**+0.0028 MB/min**，其后 14.5 分钟 **−0.0275 MB/min**；
  窗口与工具同上，`WINDOWS-E-idle-after-load-30min-20261031-005450.json`）。
- 空闲期 WorkingSet 被压到 5.5–18.9 MB；进程 CPU 均值 0.02%。
- ⇒ **负载结束后不增长**，与 10-29「空闲路径收敛」的结论一致。

#### 5.5.6 与 §5.4 的关系：改写结论边界，但不推翻历史、也不宣称「已修复」

§5.4 的「2.3 KB/事件、无平台期」对应 **10:10 二进制 + 旧采样装置**；那套装置后来查出的缺陷共 15 项
（见 `docs/V05_COMPREHENSIVE_REMEDIATION.md` §13.2/§13.4/§13.5），其中至少三项直接改变量级与形状：
①`--window visible` 实际显示的是单实例插件的工具窗（主窗口从未渲染）；
②采样按进程名归组（同机其它 `task-dock.exe` 会被并入同一分组）；
③0 样本 / 实例退出会被读成「内存回落到 0」。

因此**旧数值不能再作为基线**。在**同一速率（20 事件/秒）、UI 真实可见、当前源码构建**的条件下，
本轮实测给出的是：**主进程驻留内存在 30 分钟内出现平台期（≈18 MB），负载结束后 30 分钟空闲不增长（±0.4 MB）**。
这**不等于**「不存在任何泄漏」，覆盖边界如下：

- 只覆盖 20 事件/秒、单实例、单显示器；未覆盖 500 事件/秒持续负载、8 小时以上长跑、长时间 UI 交互路径；
- 通知路径的固定开销（≈30 MB）与每条增量（≈73 KB）已量化，但**未做进一步压缩**；
- 归因只到「分配器保留 / 原生内存」这一层，**未做 ETW/Heap 逐分配点归因**；
- 安装形态（NSIS/MSI 安装后）未复跑，与 §六 C 一致。

---

## 六、残留风险（三分法）

### A. 代码侧（已确认的缺陷状态）

1. **长时间运行内存驻留（已归因、非泄漏型；仍不是「已证明无泄漏」）**：见 §5.4 与 §5.5。
   第五轮在当前源码 release 上取得平台期证据（30 分钟负载末段 0.000 MB/min，负载后 30 分钟空闲
   ±0.4 MB），增长落在分配器保留 / 原生内存（`private_minus_live` 7.76 MB），并量化了
   通知路径（≈30 MB 固定开销 + ≈73 KB/条）与接入路径（≈0.49 KB/事件增量）。
   **剩余边界**：只覆盖 20 事件/秒、单实例、单显示器；未做 ETW/Heap 逐分配点归因；
   通知路径开销只量化、未压缩；500 事件/秒持续负载与 8 小时以上长跑未验证。

### B. 环境侧（本轮无法安全取得证据）

1. **真机验收第 2 轮被外部终止**：本机其他进程批量结束 `task-dock.exe`（含 `workbuddy.exe` 出现在前台来源）。
   已按纪律判 `ENVIRONMENT BLOCKED`，第 3 轮在安静环境下取到完整证据。
2. **本机剪贴板为共享资源**：同口径 100k 与 GUI 验收都需要安静窗口；外部程序持续复制会显著影响
   「按全局条数」类断言，因此这类断言已全部改成按内容归属 + 序列号佐证。
3. **本机有并行会话在同一份工作区上按镜像名结束进程**（第四轮实测，见 §5.5）：
   另一会话执行 `taskkill //IM task-dock.exe //F`，时间戳 `2026-10-30T13:55:52.715Z`
   与被测实例死亡时刻逐秒吻合；该会话随后重建 `target/release`，把被测二进制换成
   dev-mode 产物。**任何在本机做的长时测量，都必须先隔离产物与镜像名**，
   否则测到的可能是「被杀掉 / 被换掉」的进程。

### C. 未验证（不宣称通过）

1. **安装包安装→升级→卸载链路未实测**：第二轮已用**当前源码**重新产出安装包
   （`npm run tauri build` 退出码 0：NSIS `Task Dock_0.5.0_x64-setup.exe` 4,493,352 B、
   MSI `Task Dock_0.5.0_x64_en-US.msi` 6,840,320 B，均为 18:44 产物，见
   `docs/clipboard/evidence/bundle-build-20261030-1841.log`），
   **但没有在本机实际执行安装→升级→卸载**：那会改动用户机器的系统状态，
   本轮未获授权擅自执行。**perMachine MSI 静默安装仍未验证**（受非管理员会话限制）。
   迁移链路本身已在**真实用户库副本**上验证（见下条），缺的只是「装上去」这一步。
2. **迁移 v12/v13 在真实用户库上的执行**：第二轮已完成 —— 把运行中的真实用户库
   （`%APPDATA%/com.taskdock.desktop/task-dock.db`，8,734 事件 / 36 会话 / 248 轮次 / 310 通知）
   复制为副本并**降级到 v11 结构**（删掉 v12/v13 新增的列与索引、`user_version=11`），
   再用当前代码打开：版本 11 → 13，行数无减少、外键零违规、`integrity_check=ok`、
   幂等重开不重复推进版本；回填把 **6 个 `taskdock-selftest-` 会话及其 12 事件 / 12 轮次 / 12 通知**
   正确标为 `selftest`，其余 8,722 事件 / 30 会话 / 236 轮次 / 298 通知保持 `real`，
   `bench` 来源注册为 `category=benchmark, hidden=1`。
   工具已入库可复跑：`src-tauri/tests/real_upgrade.rs`（`TD_REAL_UPGRADE_DB` 指向副本）。
   日志：`docs/clipboard/evidence/gate-real-upgrade-20261030-1855.log`。
   **仍缺**：从 v0.1/v0.2/v0.3/v0.4 各历史版本真实库升级的逐版本验证（本次只覆盖 v11→v13）。
3. **第三方目标应用矩阵未在 v0.5 二进制上复跑**：`docs/clipboard/evidence/apps-matrix-report.json` 的
   M1 记事本 / M2 资源管理器（CF_HDROP）/ M3 Edge textarea / M4 Edge contenteditable / M5 VS Code 是
   2026-10-29 **调试构建**的 PASS 证据，M6 微信 ENVIRONMENT BLOCKED，M7 Office/Word NOT VERIFIED；
   产出该报告的矩阵脚本**从未入库**（仓库里只有 `mixed_paste_acceptance.py`），因此不能拿旧证据宣称 v0.5 通过，也无法原样复跑。
   本轮真实目标覆盖由两处补强：`real_clipboard` 真机套件（文本/图片/全透明图/CF_HDROP 两文件/富文本四种容器真实写入回读）
   与 `navigation::router` 真机记事本窗口归属测试。
4. **粘贴「中途被用户复制」的真实桌面路径这一轮没有重现**（`paste_resumptions=[]`）：该行为只有单元测试与
   真机套件构造性证据，缺一条真机现场证据。
5. **DPI / 窄窗口真实渲染走查未做**：CSS 断点 280/360/520 与 320/400/500px 规则有代码与单测依据，
   真机截图覆盖 280/320/340/400 宽度，但**没有 125%/150% 缩放下、也没有 500px 满抽屉的真实渲染截图**。
6. **真实休眠唤醒补偿、真实第三方 Agent 端到端接入**：沿用 v0.4 的验证结论，本轮未重跑。
7. **长时压测的覆盖边界**：第五轮已用**当前源码构建的 release 副本**（`task-dock-acc9.exe`，
   15,603,200 B，`sha256=fb5e0eef…`，23:50 构建）复跑 30 分钟负载与 30 分钟空闲（§5.5）；
   仍**未覆盖** 500 事件/秒持续负载、8 小时以上长跑、安装形态（NSIS/MSI）与长时间 UI 交互，
   且 §5.1 的吞吐结论仍对应 10:10 构建的二进制。

---

## 七、证据索引

| 主题 | 路径（相对仓库根） |
| --- | --- |
| 过程记录（缺陷—根因—修复—证据） | `docs/V05_COMPREHENSIVE_REMEDIATION.md` |
| 真机图文混合粘贴（通过轮） | `docs/clipboard/evidence/p1-03-mixed-paste-20261030-164201-c07922a9.json`（+ `-app.log`）、`…/p1-03-mixed-paste-run-1710-console.log` |
| 真机前两轮（FAIL / 环境阻塞） | `…/p1-03-mixed-paste-20261030-162822-ecb8e568.json` + `p1-03-mixed-paste-run-1635-console.log`；`…/p1-03-mixed-paste-20261030-164009-43acef9b.json`(-app) + `p1-03-mixed-paste-run-1700-console.log` |
| 真机剪贴板 Rust 套件 + 路由真机测试 | `docs/clipboard/evidence/gate-real-clipboard-20261030-1715.log` |
| 门禁（Rust / clippy / fmt / npm / vitest / release） | `gate-rust-all-20261030-1615.log`、`gate-fmt-clippy-20261030-1620.log`、`gate-clippy-test-20261030-1625.log`、`gate-npmtest-20261030-1630.log`、`gate-fmt-20261030-1700.log`、`release-build-accept-20261030-161144.log`（均在 `docs/clipboard/evidence/`） |
| 30 分钟压测 | `docs/performance/results/V05-SOAK-30MIN-20261030.json`、`V05-SOAK-30MIN-DB-RECON-20261030.json`、`http-soak-20261030-101315.json/.log`、`D-soak-20261030-101315.jsonl`、`sampler-recompute-D-soak-20261030.json` |
| 10 万事件同口径对比 | `docs/performance/results/V05-SCALE-100K-PREOPT-20261030.json`、`V05-SCALE-100K-FINAL-20261030.json`（+ `.log`） |
| 空闲对照（斜率证据） | `docs/clipboard/evidence/perf-a-idle-30min-final-20261030.json` |
| 真机 UI 截图 | `docs/screenshots/v06/`（35 张走查 + 6 张诊断） |
| 验收脚本（唯一入库的桌面验收器） | `scripts/acceptance/mixed_paste_acceptance.py` |
| **第二轮门禁**（fmt/clippy/rust test/npm test/npm build/tsc） | `docs/clipboard/evidence/gate-rust-final-20261030-1832.log`（fmt 失败轮）、`gate-rust-final-20261030-1836.log`（fmt 0 / clippy 0 / 444 lib tests）、`gate-npm-final-20261030-1842.log`（166 vitest / build 0 / tsc 0） |
| **第二轮性能采样**（当前二进制） | `perf-actions-release-20261030-180830.log`（**失败轮，原样保留**）、`perf-actions-release-20261030-1813.log`、`perf-clipboard-release-20261030-1819.log`；报告 `docs/performance/results/Q-actions-20261030-101135.json`（pass=false）、`Q-actions-20261030-101816.json`、`CLIP-20261030-183022.json` |
| **安装包构建尝试** | `docs/clipboard/evidence/bundle-build-20261030-1841.log` |
| **第五轮三臂归因**（N1/N2/N3 采样与元数据） | `docs/performance/results/DIAG-N1-load-notify-on-20261030-235323.*`、`DIAG-N2-load-notify-off-20261031-000318.*`、`DIAG-N3-idle-20261031-001325.*`；归因 `MEM-ATTRIBUTION-v05r5.json` |
| **第五轮长跑**（C/E 臂） | `DIAG-C-ui-http-30min-20261031-002204.*`、`DIAG-E-idle-after-load-30min-20261031-005450.*`；驱动日志 `MEM-CHAIN-v05r5-20261030-2353.log`（整链，含每臂 rc）、`MEM-C-ui-http-30min-20261031-002156.log`、`MEM-E-idle-after-load-30min-20261031-002156.log`、`MEM-fingerprint-20261031-002156.txt`；分段分析 `PHASES-C-ui-http-30min-20261031-002204.json`、`PHASES-E-idle-after-load-30min-20261031-005450.json` |
| **「被测实例自行退出」取证** | `docs/performance/results/EXIT-FORENSICS-20261030.md`、`scripts/perf/exit-forensics.py`、`scripts/perf/quit-under-load.py`（实例守卫，`SystemExit(3)`） |
| **第五轮测量脚本** | `scripts/perf/v05r5-memory-chain.sh`（链入口）、`scripts/perf/gate-rerun-failed.sh`（复跑装置）、`scripts/perf/memory-window-slopes.py`（分段斜率） |
| **第五轮门禁复跑**（含两次失败轮） | `docs/clipboard/evidence/gate-test-all-20261031-0907.log`、`gate-perf-clipboard-20261031-0907.log`、`gate-rerun-fingerprint-20261031-0907.txt`（GNU 工具链失败）、`gate-test-all-20261031-0921.log`、`gate-perf-clipboard-20261031-0921.log`（磁盘写满）、`gate-test-all-20261031-0929.log`、`gate-perf-clipboard-20261031-0929.log`、`gate-test-all-filtered-20261031-0943.log`、`gate-rerun-fingerprint-20261031-0929.txt` |

---

## 八、发布判定

**CONDITIONAL PASS。**

- **可以发布的部分**：P0 数据可信与隐私隔离（含**真实用户库 v11→v13 升级与回填实测**）、
  P1 行动中心语义、P1 全局计数与 keyset 分页、P1 通知风暴治理（**含调度器到期提醒并入同一限频闸门**）、
  **P1 智能剪贴板可靠性（真实桌面 52/52，含「结束瞬间剪贴板确为粘贴前哨兵」的硬证据）**、
  P2 UI/UX 与工程门禁。
  第二轮补齐的五处（历史分页失同步、行动中心分页竞态、压测数据审计无前端入口、提醒绕过限频、
  性能夹具期望值算错）均已闭环并有对应回归用例。
  v0.4 遗留的「粘贴停在第 1 项」这一真实产品缺陷已修复并在真机上验证。
- **本轮全部工程门禁（补漏之后重跑，退出码均为 0）**：
  `cargo fmt --all -- --check` 0；`cargo clippy --all-targets --all-features -- -D warnings` 0；
  `cargo test --all --no-fail-fast` → lib **445 passed / 0 failed / 3 ignored** + `inbox_processes` 1 passed；
  `npm test` → **23 文件 / 166 用例全过**；`npm run build` 0；`npx tsc --noEmit` 0；
  `npm run tauri build`（release exe + NSIS + MSI）0；
  `cargo test --release --test actions_perf -- --ignored --nocapture` → p95 **3.22ms**（预算 60ms）；
  `cargo test --release --test clipboard_perf -- --ignored --nocapture` → 2 passed；
  `TD_REAL_UPGRADE_DB=… cargo test --test real_upgrade -- --ignored` → ok（真实用户库 v11→v13）。
- **第五轮门禁复跑（2026-10-31 09:07 → 09:41，§3.4）**：前两次失败均为装置/环境问题并已留证
  （GNU 工具链绕过、D: 盘写满）；第 3 次 `perf-clipboard` **2/2、exit 0**，
  `test-all` 仅 3 个 `navigation::router` 前台聚焦用例被 Windows 前台锁拒绝（ENVIRONMENT-BLOCKED，
  第四轮安静桌面已逐条通过，断言未改、用例未删），过滤这 3 例后 lib **474 passed / 0 failed**。
- **第五轮收口（2026-10-31 09:46 → 10:24，§3.5）**：`fmt` 1 → 修复 → **0**；`clippy` 101
  （`needless_borrow`）→ 修复 → **0**；`tsc`/`vitest`/`npm run build` **0**；release **0**，
  产物 15,799,296 B `sha256=4fddaa06…`。`test-all` 仍报 474/3/3：2 个前台锁环境阻塞 +
  `concurrent_writers_never_exceed_capacity` 偶发一次（随后单测 20 次、整 lib 5 次全绿，
  机制未复现，未改为放宽断言）。10:19 的复跑因并行会话 v0.6 编辑使工作区不可编译而**判为无效快照**；
  10:28–10:33 补充快照（并行 v0.6 编辑恢复可编译后）`test-all` **exit 0、lib 480 passed / 0 failed**，
  此前 3 例失败全部通过（fmt/clippy 的失败点只在并行会话的 v0.6 文件，不涉及 v0.5 代码）。
- **发布条件（建议人工执行后再打 tag）**：
  1. 在真实环境执行一次 **NSIS/MSI 安装→升级→卸载**（会改动用户机器，本轮未擅自执行），
     并在真实用户库上确认 v12/v13 迁移后的界面表现；
  2. 内存驻留已用当前源码 release 复跑 30 分钟（§5.5，出现平台期）并完成三臂归因；
     若要进一步压缩常驻量，再做一次 ETW/Heap 逐分配点归因，给出「是否需要主动收缩」的结论；
     另需用最终二进制重跑 §5.1 的 30 分钟吞吐压测（现仍对应 10:10 构建）；
  3. 在安静桌面环境复跑目标应用矩阵（记事本/资源管理器/Edge textarea/VS Code，微信与 Office/Word 需人工在场），
     并把矩阵脚本入库，避免证据再次不可复现；
  4. 补 125%/150% DPI 与 500px 满抽屉的真实截图走查；
  5. 补 v0.1~v0.4 各自真实历史库到 v13 的逐版本升级验证（本次只覆盖 v11→v13）。
- **不构成发布阻断但必须随包说明**：内存曲线已在**当前源码 release** 上取得平台期（§5.5），
  但覆盖只有 20 事件/秒、30 分钟负载 + 30 分钟空闲；未做 ETW/Heap 逐分配点归因，
  通知路径的 ≈30 MB 固定开销未压缩，500 事件/秒持续负载与 8 小时以上长跑未验证，
  因此只能表述为「未观察到泄漏型增长」，不能表述为「已证明无泄漏」；
  「粘贴中途被用户复制」的真机现场证据本轮缺失，但该行为有守卫单测与真机套件支撑，
  不会因为本轮未复现而被视为已修复；
  `agents::inbox::tests::concurrent_writers_never_exceed_capacity` 在 10:05 全量门禁中偶发失败一次
  （实测 11 > 上限 10），随后 20 次单测 + 5 次整 lib 套件均通过、机制未能复现（§3.5），
  按「负载相关偶发」随包记录；若发布后在低配机器复现，需按 `write_reserved` 的锁获取
  与 `measure()` 统计口径重新归因，不得直接放宽断言或提高上限。
