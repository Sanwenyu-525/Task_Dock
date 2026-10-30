# v0.5 综合整改记录（2026-10-30）

本轮按「数据可信/隐私 > 状态正确性 > 稳定性 > 性能 > 可用性 > 视觉细节」的顺序整改。
基线 HEAD：66d1eb7（v0.5 工作现场 + Agent 行动中心 + 智能剪贴板）。工作树含大量此前未提交的
性能与剪贴板成果，本轮全程只做增量修改，未做任何重置、覆盖或批量删除。

与既有文档的分工：`docs/clipboard/10-remediation-acceptance.md`、`docs/clipboard/11-final-release-acceptance.md`
是当时的历史测量，本文只记录本轮的缺陷—根因—修复—证据，不改写它们的数值。
最终发布结论与残余风险见 `docs/V05_FINAL_ACCEPTANCE.md`。

---

## 一、P0 压测/自测数据污染真实状态

**症状**：性能压测与接入自测产生的事件与真实 Agent 事件在库里同权，会改写真实会话/轮次状态、
进入行动中心徽标、弹出系统通知，把用户真实数据冲掉。

**根因**：来源身份部分依赖客户端载荷可声明的字段；库内没有「这条数据可信到什么程度」这一列，
清理与统计都只能按来源 ID 猜。

**整改**（`src-tauri/src/agents/mod.rs`、`src-tauri/src/db/mod.rs` 迁移 v12/v13）：

- 新增服务端判定的 `EventOrigin { Real, Selftest, Benchmark, Mock, Manual }`，判定依据只有三个
  客户端无法伪造的输入：来源注册表的 `category`（服务端维护）、接入入口判定的 `Transport`、
  验证器签发的保留会话前缀（`taskdock-selftest-`）。**客户端最多只能把自己的事件降级，
  不能把压测/自测/模拟事件提升为真实事件。**
- `agent_sources.category`、`agent_events.origin`、`agent_sessions/agent_runs/agent_instances.origin`、
  `notification_history.agent_origin` 全部落库；`backfill_origin_labels()` 只标记「可证明」的历史
  测试数据（压测脚本固定 `http-perf-` 会话+轮次双前缀、同来源同会话有压测轮次佐证等），
  不能证明的保持 `real`，不做启发式批量改写。
- 内置隐藏来源 `bench`（`hidden=1, category='benchmark'`）：不在来源列表出现、不可选择，
  压测客户端默认使用它。
- 只有 `Real` 事件可以改变真实 Agent 状态、置 `verified`/`transport_verified`、进入行动中心、
  产生系统通知；`origin <> 'real'` 的轮次不参与失联判定。管理员把来源改成压测类别后，
  同一会话的后续事件立即被隔离，真实轮次状态不被压测事件改写。
- 配套索引 `(origin, received_at DESC)`、`(origin, status, updated_at DESC)` 等，
  使隔离判定不靠全表扫描。

**证据**（`cargo test --lib`）：`benchmark_source_is_fully_isolated`（含「压测事件不得产生通知」
「压测轮次不参与失联判定」）、`cross_origin_events_cannot_mutate_existing_session`、
`selftest_waiting_never_notifies`、`client_declared_transport_is_not_trusted`。

---

## 二、P1 行动中心状态与统计语义

**症状**：把事件窗口内的推断当成当前状态；已完成条目仍占徽标；「需介入/通知/历史」三类混在
一个列表里；确认操作顺手改了 Agent 状态。

**整改**（`src-tauri/src/actions/mod.rs` 模块头有完整语义约定）：

- 三类别拆分：`intervention`（当前轮次真的停在 `waiting`/`failed` 且未确认）、
  `notification`（未被当前需介入状态代表的未读通知）、`history`（最近 30 天真实轮次，只读）。
- 状态只读 `agent_runs` 的当前状态，**最新事件胜出**，不再按事件窗口猜测。
- 已完成、断连类通知只进历史，不计入徽标。
- 「授权」类型是最新消息关键词推断，UI 必须标注「推断」，它不是权限系统。
- 确认（ack）只写 `action_acks` 与通知已读位，**绝不改 `agent_runs`/`agent_sessions`**；
  确认后同一轮次若有更晚事件（受理时间晚于确认时间）会重新出现。

**证据**：`completed_never_counts_in_badge`、`ack_never_changes_agent_state_and_new_event_resurfaces`、
`acking_history_waiting_run_removes_badge_but_keeps_history_item`、`notification_dedupe_across_duplicate_states`。

---

## 三、P1 全局计数与分页

**症状**：计数靠把整页拉回前端再数，筛选/分页一变数字就变；offset 分页在插入新事件时丢条目、
出重复、页面重排。

**整改**：

- 计数全部来自显式 SQL 聚合（`counts.intervention/notification/total`），与筛选条件、分页游标无关。
- 分页改为 keyset 游标：游标由上一页最后一条编码（`\u{1f}` 分隔的复合键，含 rank），
  只接受上一页面发来的游标；新事件插入不会让旧页丢失或重复。
- 迁移 v13 为时间轴与「来源+时间」筛选补复合索引，避免深页排序退化为全表扫描。

**证据**（10 万事件真实库，见 `docs/performance/results/V05-SCALE-100K-*.json`）：
同样的 100,000 事件 / 5,000 剪贴板条目 / 10,000 通知数据集，优化前后同口径对比——

| 指标 | 优化前（PREOPT） | 优化后（FINAL） |
|---|---:|---:|
| 备份耗时 | 724 ms | 571 ms |
| 备份期间 SQLite 读延迟 max | 615,877 µs | 819 µs |
| 备份期间 SQLite 读延迟 p95 | 615,877 µs | 96 µs |
| 恢复耗时 | 7,696 ms | 5,019 ms |
| 恢复 SQLite 读延迟 p50/p95 | 65 / 142 µs | 44 / 81 µs |
| 恢复峰值内存 | 686.2 MB | 619.0 MB |
| 恢复结束后内存 | 21.9 MB | 25.9 MB |

读延迟尖刺（一次 615 ms 的阻塞读）是分页与聚合改造要解决的真实问题，已经消除到亚毫秒级。

---

## 四、P1 通知风暴治理

**症状**：批量事件时每状态跃迁各弹一条 OS 通知，跨批次累加，桌面被刷屏；运行中进度也弹通知。

**整改**（新增 `src-tauri/src/agents/notify.rs`，纯逻辑、无 Tauri 依赖）：

- 只有 `Real` 事件能产生通知；自测/压测/模拟/人工事件即使状态跃迁也不进收件箱。
- `running` 不通知；重复的同一状态去重（同轮次连续 waiting 只通知一次）。
- 跨批次全局窗口限流：窗口内最多 `notify_burst_max`（1~20，默认 3）条独立弹窗，
  窗口 `notify_rate_window_secs`（10~3600，默认 60）；等待/失败优先占用额度，
  完成只能用剩余额度。
- 同一批多条完成合并为一条「Agent 批量完成」摘要；被抑制的通知在窗口内汇总一条摘要，
  窗口结束时由调度器 `flush` 尾部（每窗口最多一条）。
- `notify_muted` 静音时不调用闸门，避免消耗额度；限流只决定「弹哪些」，
  `notification_history` 仍在同一事务逐条落库，不因限流丢记录。
- 合成的性能事件永不通知。

**证据**：`global_limit_spans_batches_and_digests_once`、`waiting_and_failure_are_prioritized_and_prompt`、
`high_frequency_completions_collapse_into_one_popup`、`single_completion_is_prompt`、
`aggregation_disabled_shows_individual_completions_up_to_limit`、`tail_digest_flushes_after_window_expiry`、
`window_rollover_restores_full_budget`、`empty_batch_never_consumes_budget`（8 项），
以及第一节的「压测/自测事件 `notification_history` 计数为 0」。

---

## 五、P1 智能剪贴板可靠性

分层不变：`engine` 纯逻辑、`image` 编解码、`store` 库与资产、`platform` 唯一触碰 Win32、
`paste` 逐项队列与守卫。本轮修的是四处会导致「产品把自己的写入当成用户接管」的真实缺陷。

### 5.1 内容同一性：容器字节 → 像素 → Alpha 语义（本轮 GUI 复验发现，最关键）

**缺陷**：红 A → 绿 B → 文本 C → 蓝 D 四连复制后发起逐项粘贴，任务在第 1 项即停，
`sent=0/4`，提示「第 1 项写入前检测到剪贴板已被其他程序更新」。应用日志给出决定性细节：

```
剪贴板内容不一致：期望 png=1241B；实际 png=Some(553)B
```

**根因**：两侧根本不是同一种表示。粘贴前快照由采集管道产出（32bpp CF_DIB → RGBA，
Alpha 通道未使用 → 置 255 → 重新编码 PNG，1241B），而守卫读的是剪贴板上的原始「PNG」容器；
Windows 用同源 CF_DIB 合成的容器里 Alpha 字节全 0（553B）。已有的像素回退直接比较 RGBA，
等于拿 Alpha=0 的容器比 Alpha=255 的入库版本，**本进程刚写入的图片永远匹配不上自己的快照**。
所以这不是环境噪声：连续三次等待 6 秒剪贴板安静窗口后续跑，三次都在第 1 项同样停住。

**修复**：`image::canonicalize_unused_alpha()`——Alpha 全为 0 视为「通道未被使用」按不透明归一，
任一非 0 即真实透明信息、绝不归一；`payload_matches_read` 的图片回退把**期望侧与实际侧都归一**
后再比像素与尺寸。该函数同时被 `content_matches_open` 使用，因此写前守卫、写后按键前复核
（`clipboard_match`）、结束恢复三条路径共享同一条判定，不再各说各话。
归一只改 Alpha、不动颜色；实现按整像素遍历（`rgba[..len/4*4]`），
第一版用 `rgba[3..].chunks_exact(4)` 会漏掉最后一个像素的 Alpha，已由单测钉住。

**不对称的来源**（两侧读取路径不同，必须成对维护）：采集/快照走
`read_png(dib_alpha_unused)` → `image::normalize_clipboard_png()`，以同源 CF_DIB 作为
「Alpha 未被使用」的证据把容器归一为不透明；守卫走 `read_png_bytes()`（platform.rs:978），
返回容器**原始字节**、不做归一。上一轮只改了采集侧，于是快照侧 Alpha=255、守卫侧 Alpha=0，
比较必然失败——本轮把归一规则下沉到 `payload_matches_read`，两侧同规则。

**证据**：`payload_match_treats_zero_alpha_png_container_as_unused`、
`canonicalize_unused_alpha_covers_the_last_pixel_and_keeps_real_transparency`、
`payload_match_falls_back_to_pixels_when_png_container_changes`（容器不同/像素变/尺寸变三种情形）。

### 5.2 空 CF_HTML 片段不算富文本

**缺陷**：长度为 0 的 CF_HTML 片段被当成「有富文本」，本进程写入的纯文本被判成「用户已换成
富文本」，逐项粘贴误停、自写抑制失效并重复入库。

**修复**：`payload_matches_read` 的 Text 分支对期望侧与实际侧同样 `filter(|h| !h.is_empty())`。
**证据**：`payload_match_ignores_empty_html_fragment`。

### 5.3 采集内存峰值：诚实记账 + 解码前闸门

- 队列字节估算必须包含 `png` **和** `rgba`（像素×4），只算容器会严重低估：
  `estimate_content_bytes`。
- 整条内容超过队列字节预算（`CONTENT_QUEUE_MAX_BYTES = 128 MB`，容量 8）时，
  入队前释放解码像素 `rgba`，只留 PNG 容器；落库时 `store::write_assets` 发现像素缺失或
  长度不足，就从 PNG 重新解码生成缩略图，功能不受影响。
- 尺寸闸门必须在分配之前：`within_image_limits`（边长 ≤ 20,000，像素总数 ≤ 100,000,000）
  同时用于 `decode_png_rgba`（先读 IHDR 再决定要不要分配）、`dib_alpha_is_unused`、`dib_to_rgba`。
  纯色大图可以把容器压到几十 KB，只按容器字节判断会让监听线程一次吃掉几百 MB。

**证据**：`content_queue_estimates_image_and_text_bytes`、
`oversized_capture_drops_rgba_to_stay_inside_queue_budget`、
`oversized_capture_without_rgba_still_gets_exact_thumb`、`png_decode_refuses_dimensions_beyond_the_cap`。

### 5.4 配置损坏一律 fail-closed

剪贴板配置 JSON 损坏、类型错误或已初始化配置缺键时，`load_clipboard` 保留原始值并判定为
不允许采集，绝不按默认值自动开启；修复动作必须由用户显式确认。修复事务在提交前，
另一条读连接只能看到修复前的 fail-closed 状态；进程在修复中途死亡则回滚。
UI 侧对应「剪贴板配置损坏时提示已暂停，绝不显示监听中」。

**证据**：`clipboard_type_errors_fail_closed`、`clipboard_repair_*`（含缺键保守修复、
数据库损坏时不写、提交后才恢复监听）、`config.capture_allowed()` 在损坏时为 false。

### 5.5 隐私：日志不含内容

日志只记录类型/大小/计数（`剪贴板记录：kind=image size=1241`、`剪贴板内容不一致：期望 png=…B；实际 png=…B`），
绝不记录正文、文件路径、图片内容；剪贴板正文只存在本地库。
来源未知时采用更保守的高风险字段策略（宁可少记录），该策略不做绝对保证——文档与代码注释都按此表述。

### 5.6 真机套件与「瞬态发布窗口」

`src-tauri/tests/real_clipboard.rs`（`TD_REAL_CLIPBOARD=1` 门禁 + `#[ignore]`）在真实剪贴板上验证
采集、自写不重采、守卫拒绝覆盖用户中途复制、结束恢复用户原内容。
本轮发现：大图的写入在 `CloseClipboard` 之后仍有一小段「格式继续合成」的窗口，
即时读取只能看到部分格式。处理方式是在**测试侧**做有界重读（0/20/40/80/150 ms）并打印
实测等待值，产品断言一条不放宽；重读全部失败时输出完整 `mismatch_report` 再判失败。

### 5.7 GUI 验收：把环境与产品分开，但不给产品开后门

`scripts/acceptance/mixed_paste_acceptance.py`（P1-03）本轮补齐了判定纪律：

- 剪贴板是全局共享资源：复制阶段与粘贴阶段前各等一个安静窗口（4s / 6s，最长 90s / 180s），
  等不到就 `EnvironmentBlocked`（退出码 3），不把外部流量算成产品缺陷。
- 本次验收的文本条目用唯一标记 `MIXED-TEXT-C-7f3a9d` 做身份归属；外部条目单独记账
  （`external_items_during_run` / `external_clipboard_changes`）。
- 每次复制都记录当时前台来源；前台被本实例抢走时按「外部前台优先」重做该步，
  证据里保留每次尝试。
- **新增判定**：粘贴停在「已被其他程序更新」时，先用两路独立证据判断剪贴板到底换没换：
  ①全局剪贴板序列号与参照点完全一致（参照点取「写完粘贴前哨兵之后」，避免把验收自己的
  写入读成别人动过）；②可见内容仍是哨兵文本或最后一张自写图（按内容判定，不比容器字节）。
  任一成立即判为产品误判（`paste_stop_is_product_misjudgment`），不续跑、不判环境，
  让 4/4 断言如实失败；两路都证明确实被别人接管，才等安静窗口用 `clipboard_paste_resume`
  续跑，连续 3 次被打断才判环境。这条判定正是 5.1 那个缺陷被暴露出来的原因——
  修复前它会被误记成「环境不安静」。
- **恢复断言改为可判定**：旧脚本在任务结束 1.6s 之后（还要等 DOM 解码）单点读剪贴板，
  并把「应当恢复成的那张蓝 D」与「粘贴的最后一项」当成同一个内容——两者本来就是同一张图，
  即便产品根本没恢复，读回也是 D-blue，这条断言其实无法证伪。本轮改为：
  ①粘贴前写入与分组四项都不同的**哨兵文本** `PASTE-BASELINE-SENTINEL-4d71be`，
  恢复目标唯一可判；②在任务状态离开 running 的那一刻起 0.8s 内每 60ms 密集采样剪贴板，
  抢在并行复制之前拿到「恢复后的那一刻」。
- **三态判定**：采样命中哨兵 → PASS；采样命中分组里被粘贴过的内容 → 产品确实没恢复，FAIL；
  产品自报已恢复但采样全是外部内容 → 记 `BLOCKED`（既不算通过也不算缺陷，附全部序列号与样本）。
  `BLOCKED` 单独成桶写入证据 `checks.blocked`，控制台逐条打印，总体结论降级为
  `PASS_WITH_ENVIRONMENT_BLOCKED`，绝不折算成 PASS。
- **隐私**：证据不再落用户剪贴板正文——文本只记 `has_text / length / markers / sha256_12`
  （旧脚本会把 `clipboard_text()` 原文写进控制台与 JSON，本轮修掉了）。

### 5.8 真实桌面复验（Alpha 修复后的 release 二进制）

被测二进制：`src-tauri/target-accept/release/task-dock.exe`，16:20 构建（15,515,136 B），
构建日志 `release-build-accept-20261030-161144.log`（`Finished release in 8m 08s`，EXIT=0）。

**第一次复跑 16:26→16:28（EXIT=1，两份 FAIL）**
日志 `p1-03-mixed-paste-run-1635-console.log`，证据 `p1-03-mixed-paste-20261030-162822-ecb8e568.json`。

- **5.1 的缺陷确认修复**：`粘贴任务完成且发送 4/4` **PASS**（`status=completed sent=4 total=4`，
  `remaining_items=[]`，`restored=true`），不再在第 1 项停住；
  `DOM 顺序为 图/图/文/图` PASS，三张目标图片 `Alpha 正确`（`[255,255,0]`：
  alphaMin=alphaMax=255、transparentPixels=0）与 RGB `[220,30,30] / [30,180,60] / [30,60,220]` 全对，
  文字 `MIXED-TEXT-C-7f3a9d` 完整位于第三位；`粘贴自写内容未进入采集链路`（captured/recorded 增量 0）、
  `粘贴后历史条数不变`、`粘贴不增加 copy_count`、`监听无丢弃事件` 全 PASS。
- **FAIL①「历史新增条目数恰为 4」＝环境污染**：证据 `external_items_during_run` 显示多出的那条是
  `kind=html, byte_size=88`，创建时刻 08:27:53 夹在验收自己的复制步骤之间，
  本轮全局序列号共增长 28 次——本机其他程序在持续复制。产品的采集行为是正确的
  （别人复制了就记一条）。按 5.7 的新纪律把该断言改成按内容归属判定，
  并要求「多出的条目必须有等量外部写入佐证」，而不是要求全局条数恰好等于 4。
- **FAIL②「剪贴板恢复为蓝图 D」＝旧断言无法证伪 + 事后单点读取**：`clipboard_after` 为 `null`
  （剪贴板当时已是文本「UI-11｜…」，非验收内容），而产品侧 `restored=true` 且
  message 明写「已恢复粘贴前的剪贴板内容」。在 28 次外部复制的机器上，
  任务结束 1.6s 之后读剪贴板毫无意义，且 D-blue 同时是「恢复目标」和「粘贴最后一项」。
  → 按 5.7 改成哨兵 + 结束瞬间密集采样。

**第二次复跑 16:39→16:40（EXIT=3，环境污染加剧）**
日志 `p1-03-mixed-paste-run-1700-console.log`，证据 `p1-03-mixed-paste-20261030-164009-43acef9b.json`。
隔离实例在复制第 3 项期间被**外部终止**（`exit=4294967295`），应用日志到
`剪贴板记录：kind=image size=1241` 为止无任何 panic/错误行；
前台来源里出现了 `workbuddy.exe`，本机另有进程在批量结束 `task-dock.exe`。
脚本如实判 `ENVIRONMENT BLOCKED`（退出码 3），**不据此判定产品行为**，
也不把这一次算进剪贴板结论。

**第三次复跑 16:41→16:42（EXIT=0，52 条断言全绿）**
日志 `p1-03-mixed-paste-run-1710-console.log`，
证据 `p1-03-mixed-paste-20261030-164201-c07922a9.json`（`overall=PASS`，
**PASS 52 / FAIL 0 / BLOCKED 0**）。这一轮用的是改造后的脚本（哨兵 + 结束瞬间密集采样）。
关键结果：

| 断言 | 实测 |
| --- | --- |
| 图文顺序与分组 | `复制 A/B/C/D 后各入库` 4/4 PASS；`历史新增条目数` delta=4；`本次验收四项内容各建一条（3 图 + 1 文），无漏采也无重复` PASS；`手动分组顺序为 A/B/C/D`、`分组包含 4 项` PASS |
| Alpha 正确 | `采集入库的 A-red / B-green / D-blue 像素可见且颜色正确`（alphaMin=alphaMax=255、transparentPixels=0、opaquePixels=38400）PASS |
| 逐项粘贴 | `粘贴任务完成且发送 4/4`、`粘贴任务无剩余项`、`粘贴任务结束=completed` PASS |
| 目标接收 | `DOM 顺序为 图/图/文/图`、`文字位于第三位且完整`、三张图片「尺寸 240x160 / Alpha 正确 / RGB 正确 / 可见」9 条 PASS、`目标图片无重复颜色/无重复插入` PASS |
| 恢复原剪贴板 | `粘贴后恢复原剪贴板`（`restored=true`）PASS；**`剪贴板已恢复为粘贴前哨兵（结束瞬间采样）` PASS**：0.8s 内 15 次采样，序列号全部为 `8116`（整段没有任何外部写入）、`sentinel_hits=15`、`left_on_pasted_item=0`、`foreign_samples=0`，首样本即哨兵文本（长度 36、marker `PASTE-BASELINE-SENTINEL-4d71be`、sha256 前 12 位 `420602d53dad`，正文不落证据） |
| 中途用户复制不被覆盖 | 本轮无外部接管发生（守卫全程未停写、`paste_resumptions=[]`），该路径仍只有单元测试与 5.6/5.7 的构造性证据；上一条的 `left_on_pasted_item=0` 与 `剪贴板未被 A/B/C 留在原地` 证明粘贴项没有留在剪贴板上 |
| 自写不被二次采集 | `粘贴自写内容未进入采集链路` captured/recorded 增量 0；`粘贴不增加 copy_count`；`粘贴后历史条数不变`；`监听无丢弃事件`（observed=10 captured=5 recorded=5 duplicates=0 dropped=0 failed=0，峰值队列 1/1，采集延迟 ≤10ms）全 PASS |

**因此 5.1 的图片粘贴缺陷已在真实桌面上闭环**：从「第 1 项就判成用户接管、sent=0/4」
到「4/4 发送、DOM 图/图/文/图、三图 Alpha=255、结束瞬间剪贴板确为粘贴前哨兵」。

---

## 六、P2 UI / UX

- 剪贴板抽屉固定 `min(500px, 100%)`，窄窗口（≤520px）铺满；**背景恒为 `--surface-overlay` 不透明**，
  玻璃/亚克力模式也不例外，避免底层任务列表透出干扰逐项粘贴。
- 焦点与键盘：`role="dialog"` + `aria-modal`；Tab 只在最上层内循环（末项回首项、首项回末项），
  焦点漏到背景时按 Tab 立即拉回抽屉，蒙层不接收焦点；Escape 严格按「确认框 → 子视图 → 抽屉」
  逐层退出，确认框关闭后焦点还给触发按钮；打开前记录 `document.activeElement`，关闭后归还。
  实现绑定真实键盘事件序列，没有用定时器或防抖做时序掩盖。
- 行动中心条目显示 P0~P3 优先级与「推断」标注，等待/失败排在完成之前；
  历史视图与需介入视图分列，徽标只数需介入。
- 设置面板改为可折叠分组：外观与主题、窗口与快捷键、应用与快捷方式、通知、智能剪贴板、
  Agent 接入、数据与备份（共 7 组，含图标与说明）。
- 响应式与 DPI：CSS 断点 280 / 360 / 520；`docs/screenshots/v06/` 35 张真机截图覆盖
  280/320/340/400 宽度、明暗两色、玻璃与实底、抽屉、多条目、缩放与原生圆角。
  jsdom 没有布局引擎，窄窗与 DPI 的结论只来自这些真机截图，不由单测冒充。

---

## 七、P2 性能与内存

吞吐与队列侧本轮实测通过（30 分钟、4 Agent × 5/s、36,000 事件全送达）：
`docs/performance/results/V05-SOAK-30MIN-20261030.json` —
`overload_rejects=0`、`commit_failures=0`、`events_unsaved=0`、`spool_failures=0`、
队列峰值 20/1024、落库 p50/p95/p99 = 5.43 / 14.59 / 18.71 ms、`health_failures=0`。
**该轮压测所用 release 二进制为 10:10 构建**（JSON 内 `binary = release (console-window fix, built 2026-10-30 10:10)`），
早于包含本轮 Alpha 归一修复的 16:20 最终二进制；压测结论对 10:10 二进制成立，**未对最终二进制复跑**。

**内存稳定性：NOT PROVEN（本轮不认定通过，预算未放宽）。**

- 同一轮 30 分钟压测里 task-dock.exe 自身 Private Bytes 从 11.4 MB 单调升到 95.1 MB，
  没有平台期；停止加压后空闲 90 s 仍为 95.2 MB；句柄 11,312。
- 对照一：10 万事件的备份+恢复整轮跑完后回到 24~26 MB —— 批量库操作不留驻，
  保留发生在**实时接入/UI 路径**。
- 对照二：30 分钟纯空闲（整棵进程树 7 个进程）Private 线性斜率 +36.9 MB/h，
  同期 WorkingSet 斜率为 −46.1 MB/h、句柄 10,096→10,091、线程数下降 —— 空闲路径是收敛的。
  压测下 task-dock.exe 单进程约 +84 MB / 36,000 事件 ≈ 2.3 KB/事件量级，明显高于空闲基线。
- 已排查并排除的嫌疑：Agent 侧 `MEMO`/`SNAP` 缓存有上限且会清理、管线合并缓冲受
  `MAX_MERGE_BUFFER` 约束、去重在 SQLite 侧完成、剪贴板队列为有界 8 条 + 128 MB 预算并会
  主动剥离像素。**没有找到可证明的无界增长点，因此不下「已修复」结论。**
- 下一步（尚未做）：ETW/Heap 分析或按阶段采样分配器统计，区分「SQLite 页缓存/WAL」
  「有界缓存达到上限后的驻留」与「真正的每事件驻留」；把 2.3 KB/事件这一量级归因后再谈预算。

---

## 八、工程门禁执行记录

本轮整改后的完整序列（全部为本机真实执行，日志在 `docs/clipboard/evidence/`，
每条都记录命令、时间戳与退出码）。命令按「先单测、后重建、再真机」的顺序执行，
剪贴板真机验收与 Rust 测试**绝不并行**（两者都要独占剪贴板与前台）。

| 命令 | 时间 | 结果 | 退出码 | 日志 |
| --- | --- | --- | --- | --- |
| `cargo test --all --no-fail-fast` | 2026-10-30 16:15→16:17 | lib **441 passed / 0 failed / 3 ignored**；`inbox_processes` 1 passed；`actions_perf`/`clipboard_perf`/`ingest_perf`/`real_backup_restore`/`real_clipboard` 均为真机/性能工具（ignored）；doc-tests 0 | 0 | `gate-rust-all-20261030-1615.log` |
| `cargo clippy --all-targets --all-features -- -D warnings`（第一次） | 16:15 | **失败**：4 处（新单测里的未用变量 `i`、恒等乘法 `wide * 1 * 4`、`window_shape.rs:53` 多余 `as`、`router.rs:1200` 嵌套 `format!`） | 101 | 同上 |
| 逐条修复后重跑 `cargo fmt --all` + `cargo fmt --all -- --check` | 16:20→16:41 | 无差异 | 0 | `gate-fmt-20261030-1700.log` |
| `cargo clippy --all-targets --all-features -- -D warnings`（重跑） | 16:19:47→16:19:58 | 0 警告（`Finished dev profile in 10.66s`） | 0 | `gate-clippy-test-20261030-1625.log` |
| 第二次 clippy 失败点（`real_clipboard.rs` 嵌套 `format!` + `Default::default()` 后逐字段赋值） | 16:18 | 已改为结构体字面量与单层 `format!` 后通过 | — | `gate-fmt-clippy-20261030-1620.log` |
| `cargo test --all --no-fail-fast`（重跑，含修复后的测试文件） | 16:19:58→16:20 | 与上一行同源，全绿 | 0 | `gate-clippy-test-20261030-1625.log` |
| `npm run build`（tsc --noEmit + vite） | 16:11→16:12 | `✓ built in 10.73s`，dist 产物 js 478.09 kB / css 94.72 kB | 0 | `release-build-accept-20261030-161144.log` |
| `npm test` | 16:24:22→16:25:03 | **23 个文件 / 164 个用例全过**（Duration 37.64s） | 0 | `gate-npmtest-20261030-1630.log` |
| Windows Release 构建（`--target-dir target-accept`） | 16:11→16:20 | `Finished release in 8m 08s`，产出 `src-tauri/target-accept/release/task-dock.exe`（15,515,136 B，16:20） | 0 | `release-build-accept-20261030-161144.log` |
| 真实桌面图文混合粘贴验收（release 二进制） | 16:26→16:28 | 见 §5.8：4/4 粘贴与像素断言全 PASS，2 条断言如实 FAIL（环境污染 + 旧断言无法证伪） | 1 | `p1-03-mixed-paste-run-1635-console.log` + `p1-03-mixed-paste-20261030-162822-ecb8e568.json` |
| 同上（脚本改造后复跑） | 16:39→16:40 | 隔离实例被本机其他进程外部终止（应用日志无 panic），如实判环境阻塞 | 3 | `p1-03-mixed-paste-run-1700-console.log` |
| 同上（最终一轮） | 16:41→16:42 | **52 条断言全 PASS / 0 FAIL / 0 BLOCKED**，含「剪贴板已恢复为粘贴前哨兵」 | 0 | `p1-03-mixed-paste-run-1710-console.log` + `p1-03-mixed-paste-20261030-164201-c07922a9.json` |

**关于 `npm test` 的两次超时**：16:05 前后两次运行各出现 2 例 5000ms 超时
（`TasksPanel 筛选交互` 等 jsdom 用例），当时同一台机器正在编译 release；空闲复跑
23 文件 / 164 用例全绿。未删除任何用例、未放宽任何断言、未调大超时阈值，
如实记为「编译负载下的 jsdom 计时敏感」，不是产品缺陷。

**没有以任何形式绕过门禁**：没有 `--no-verify`、没有 `#[allow]` 压制警告、
没有 `unwrap` 替代断言、没有把失败用例注释掉。

### 8.1 第二轮门禁（2026-10-30 18:30 → 18:45，补漏修复之后重跑）

第一轮门禁跑在第十一节补漏修复**之前**，因此全部重跑；两轮日志并存，不覆盖。

| 命令 | 时间 | 结果 | 退出码 | 日志 |
| --- | --- | --- | --- | --- |
| `cargo fmt --all -- --check`（第一次） | 18:30 | **失败**：补漏改动未格式化（`notify.rs` 新测试、`actions_perf.rs` 期望值改动等 3 处差异） | 1 | `gate-rust-final-20261030-1832.log` |
| `cargo fmt --all` → `cargo fmt --all -- --check` | 18:36:46→18:36:47 | 仅格式化，无差异 | 0 | `gate-rust-final-20261030-1836.log` |
| `cargo clippy --all-targets --all-features -- -D warnings` | 18:36:48→18:37:44 | 0 警告 | 0 | 同上 |
| `cargo test --all --no-fail-fast` | 18:37:44→18:38 | lib **444 passed / 0 failed / 3 ignored**（第一轮为 441）；`inbox_processes` 1 passed | 0 | 同上 |
| `npm test`（vitest） | 18:39:12→18:39:50 | **23 文件 / 166 用例全过**（第一轮为 164） | 0 | `gate-npm-final-20261030-1842.log` |
| `npm run build` + `npx tsc --noEmit` | 18:39:50→18:40:12 | `✓ built in 7.84s`（js 481.35 kB / css 94.72 kB）；tsc 无错误 | 0 | 同上 |
| `cargo test --release --test actions_perf -- --ignored --nocapture`（第一次） | 18:08:30→18:11:35 | **FAILED**：全局筛选总数 42 ≠ 夹具期望 40（夹具公式错，生产代码对） | 101 | `perf-actions-release-20261030-180830.log` |
| 同上（修复后） | 18:12:35→18:18:16 | **ok**：p50 2.99ms · p95 3.22ms · max 3.23ms | 0 | `perf-actions-release-20261030-1813.log` |
| `cargo test --release --test clipboard_perf -- --ignored --nocapture` | 18:18:22→18:30:23 | **2 passed / 0 failed** | 0 | `perf-clipboard-release-20261030-1819.log` |

**两次失败都原样留档**（fmt 差异轮、perf 夹具轮）：没有删除、没有改写日志、
没有用「放宽断言」的方式把失败变成通过——perf 那次是把**错误的期望值改成正确的期望值**，
同时加了「夹具必须超过单页上限」的前置断言防止测试变哑。

## 九、本轮仍未闭合

- **目标应用矩阵未在 v0.5 二进制上复跑**：`docs/clipboard/evidence/apps-matrix-report.json` 的
  M1 记事本、M2 资源管理器（CF_HDROP）、M3 Edge textarea、M4 Edge contenteditable、M5 VS Code
  为 2026-10-29 调试构建的 PASS 证据，M6 微信为 ENVIRONMENT BLOCKED，M7（Office/Word）NOT VERIFIED；
  产出该报告的矩阵脚本从未入库（`git log --diff-filter=D -- scripts/acceptance` 无删除记录，
  仓库里只有 `mixed_paste_acceptance.py`），因此不能拿旧证据宣称 v0.5 通过，也无法原样复跑。
  当前 P1-03 脚本只覆盖 Edge contenteditable 目标。
  **本轮的真实目标覆盖由两处补强**：`real_clipboard` 真机套件（文本/图片/全透明图/CF_HDROP 两文件/
  富文本四种容器逐一写入真实剪贴板并回读校验，用户原剪贴板恢复）与
  `navigation::router` 真机记事本窗口归属测试。
- **内存稳定性 NOT PROVEN**（见第七节，两条独立判据与后续步骤都在那一节）。
- **安装包（NSIS/MSI）安装与升级迁移、真实休眠恢复、真实第三方 Agent 端到端接入仍未验证**：
  `src-tauri/target-accept/release/bundle/` 里的 NSIS（10-29 00:42，4,107,422 B）与
  MSI（10-29 00:43，5,648,384 B）以及主 target 目录 01:44 的产物，都早于本轮 16:20 的
  `task-dock.exe`（15,515,136 B）——本轮只执行了 `cargo build --release`（未跑 bundle 步骤），
  因此**没有任何安装包代表本轮代码**，迁移 v12/v13 在真实用户库上的执行也未复验。
- **粘贴「中途被用户复制」的真实桌面路径这一轮没有重现**：最终通过的 16:41 一轮全程无外部接管
  （`paste_resumptions=[]`），该行为只有单元测试与 5.6/5.7 的构造性证据。
- **DPI / 窄窗口的真实渲染走查未做**：CSS 断点与 320/400/500px 规则有代码与单测依据，
  `docs/screenshots/v06/` 35 张真机截图覆盖 280/320/340/400 宽度，但**没有 125%/150% 缩放、
  也没有 500px 满抽屉的真实渲染截图**。

## 十、本轮已闭合（此前记录为未闭合）

- **真实桌面图文混合粘贴**：见 §5.8，16:41 一轮 52/52 全绿（release 二进制）。
- **真机剪贴板套件**：`TD_REAL_CLIPBOARD=1 cargo test --test real_clipboard -- --ignored`
  → 3 passed / 0 failed（`gate-real-clipboard-20261030-1715.log`，16:45:24）。
  覆盖：4 项分组顺序、逐条写入真实剪贴板并回读像素/文本、全透明图归一化回读、
  CF_HDROP 两文件、富文本、自写去重、用户原剪贴板（15418B 文本 + 22616B HTML）恢复、
  写入失败时用户内容仍在。
- **前台聚焦两个导航测试**：`launch_disallowed_reports_failure_or_focus_only` 与
  `notepad_launch_focuses_existing_window_of_owned_process` 此前被 Win11 记事本
  「他人已存在的单实例多标签进程」挡住（16:45 复跑时那些记事本进程已不在），
  现在两者 **ok**；`cargo test --lib navigation::router` 10 passed / 0 failed。

---

## 十一、第二轮独立复核与补漏（2026-10-30 17:50 → 18:35）

第一轮结论是 CONDITIONAL PASS。第二轮不改写第一轮的任何历史测量，只做两件事：
**独立复核**已闭合项是否真的闭合（不靠「文档说已闭合」采信），以及**在可复现范围内补漏**。
本节记录复核结论与补漏的缺陷—根因—修复—证据；第五节之后的门禁与性能数值见
`docs/V05_FINAL_ACCEPTANCE.md` 的对应表格。

### 11.1 历史面板：合并刷新不推进分页状态（分页不可达，P1）

- **现象**：首屏为空时收到新事件，列表里出现了新事件，但「加载更早」按钮不出现；
  未读数与列表长度不同步。
- **根因**：`HistoryPanel` 挂载时用服务端返回的 `has_more` 初始化 `eventsHasMore` /
  `notificationsHasMore`；此后 `onAgentChanged` 触发的**合并刷新**只更新列表与 `hasNew`，
  没有按新的 `filtered_total` 重新推导分页状态 → 状态停在挂载时的取值。
  后果是：新事件到达后用户再也翻不到更早的历史，而分页按钮的可见性依赖一个陈旧布尔值。
- **修复**：合并刷新后按「已合并条数 < 全局筛选总数」重新推导两个分页标志
  （`src/components/history/HistoryPanel.tsx:166-167`）。用全局 `filtered_total` 而不是
  服务端 `has_more`，因为合并刷新后本地已加载条数与服务端分页游标不再一一对应。
- **证据**：`src/components/history/HistoryPanel.test.tsx` 新增用例
  「首屏为空后到达的新事件会重新启用『加载更早』」，断言按钮文案为
  「加载更早的 Agent 事件（已加载 1/250）」；该文件 8 个用例全过。

### 11.2 行动中心：分页请求与列表整体刷新之间的竞态（P1）

- **现象**：在「加载更多」在途时，触发了一次列表整体刷新（切换筛选条件或收到刷新事件），
  旧游标页返回后被直接追加到新列表上 → 出现重复行、顺序错乱，甚至混入已被新筛选排除的行。
- **根因**：`useActionsStore.load()` 全量替换 `feed` 时没有让在途的 `loadMore()` 失效；
  `loadMore()` 只校验了筛选条件是否变化，未校验**列表本身是否已被整体替换**。
  两个请求的竞态窗口内，没有「列表代数」这一概念。
- **修复**：引入列表代数 `listVersion`（`src/store/useActionsStore.ts:28`）：
  `load()` 整体替换时 `listVersion += 1`（:98）；`loadMore()` 发起时捕获当前代数（:119），
  返回后若 `listVersion` 已变化则整页丢弃并复位 `loadingMore`（:123）。
- **证据**：`src/store/useActionsStore.test.ts` 新增用例
  「加载更多期间列表被整体刷新替换时放弃旧游标页」；该文件 11 个用例全过。

### 11.3 压测/自测数据审计：后端命令没有前端入口（P0 能力不可达）

- **现象**：后端 `audit_test_data` 命令（dry-run 预览 + `VACUUM INTO` 清理前快照 +
  事务化删除 + 外键校验 + 不确定数据标记）已实现且有测试，但**前端没有任何调用点**。
  能力存在却无法被使用，「只清理可证明数据、绝不误删」这一承诺在 UI 上无法兑现。
- **修复**：
  - `src/lib/bridge.ts` 增加 `auditTestData(apply)` 与审计类型
    （`AuditTableCounts` / `AuditOriginBucket` / `AuditUncertainItem` / `TestDataAudit`）。
  - `src/components/settings/SettingsPanel.tsx` 新增「测试/压测数据审计」分组：
    **先预览**（`apply=false`，零写入，只报数）→ 再「清理可证明数据…」（二次确认后 `apply=true`），
    toast 报告删除条数与**清理前快照路径**；`fk_violations > 0` 时以 error 级别提示。
    无法证明归属的数据只列条数与样本摘要，**不提供任何删除入口**。
- **证据**：`npx tsc --noEmit` 退出码 0、`npm run build` 退出码 0；
  后端行为由 `src-tauri/src/commands/audit.rs` 的三个单测覆盖
  （`dry_run_never_deletes`、`apply_deletes_only_provable_data_with_backup`、
  `apply_without_provable_data_does_nothing`：dry-run 零写入、快照先于删除、
  只删可证明数据、无法证明时不动）。UI 无端到端自动化，仅以类型检查与构建为证。

### 11.4 调度器到期提醒绕过全局限频（P1 通知风暴）

- **现象**：上一轮把 Agent 事件通知接入了 `NotifyGate` 全局窗口限流，但
  `scheduler.rs` 的到期提醒仍走旧的逐条 `fire()` 路径：**每个到期任务各发一条 OS 通知**，
  单个 tick 最多 50 条 → 一次批量到期就是 50 次弹窗，限频形同虚设。
- **根因**：限频只加在 Agent 事件入口；提醒是另一条产生 OS 通知的路径，没有经过同一个闸门。
- **修复**：
  - `src-tauri/src/scheduler.rs:51` 的 `tick()` 改为收集本轮全部到期提醒，
    统一交给 `hub.notify_reminder_popups(&popups)`（:98），UI 广播也合并为**一条**
    `reminder-fired`（携带 `task_ids` 数组，:101-102）。
  - `src-tauri/src/agents/mod.rs:1320` 新增 `notify_reminder_popups`，
    与 `notify_agent_popups`（:1310）共用 `plan_popups`（:1328）的同一 `NotifyGate` 与窗口预算，
    并分别尊重 `notify_reminder` / `notify_agent` / `notify_muted` 开关。
  - `src-tauri/src/agents/notify.rs` 增加可合并类型（`agent_done` / `reminder`，
    :62），同一批多条提醒合并为一条「任务提醒汇总」（:203 `group_by_kind`、:215 `summary_for`）。
- **证据**：`src-tauri/src/agents/notify.rs` 新增 3 个用例
  （`many_reminders_collapse_into_one_summary`、`reminders_do_not_displace_waiting_notifications`、
  `single_reminder_stays_prompt`），该文件共 11 个用例全过。
  **待办（未做）**：提醒合并只在后端生效，前端弹窗聚合策略未单独验证。

### 11.5 性能夹具期望值算错：`actions_perf` 在最终二进制上首次运行即失败

- **现象**：在本轮最终二进制上第一次运行
  `cargo test --release --test actions_perf -- --ignored --nocapture` → **FAILED，退出码 101**：
  `assertion left == right failed: 筛选总数与夹具不一致 / left: 42 / right: 40`。
- **归因（生产代码是对的，测试夹具的期望公式错了）**：夹具按「每来源 10 个会话、
  `session % 3` 分布（0 失败 / 1 等待 / 2 运行）」写入，每来源实际是 **4 失败 + 3 等待 = 7**
  个需介入轮次，6 个来源共 **42** 个；而断言用的
  `SOURCES.len() * SESSIONS_PER_SOURCE / 3 * 2 = 60 / 3 * 2 = 40` 假设的是
  「三分之一失败 + 三分之一等待」，在 10 不能被 3 整除时**低估了 2 条**。
  生产侧返回值是正确的：单页 40 条（`ITEM_LIMIT_DEFAULT`）+ 全局筛选总数 42。
- **修复**（`src-tauri/tests/actions_perf.rs`）：
  - 期望值改为与种子**同一分布**计算（`expected_intervention()`，按来源内会话序号取模）；
  - 断言拆成三条，且第一条是**防止测试变哑**的前置条件：
    ① 夹具需介入条数必须 > 单页上限（否则该样本无法验证「全局计数不随分页退化」）；
    ② 首屏条数 == `min(期望, 单页上限)`；③ 全局筛选总数 == 期望（42）。
  - `ITEM_LIMIT_DEFAULT` 由私有改为 `pub`（`src-tauri/src/actions/mod.rs:29`），
    测试不再硬编码 40，避免两处常量漂移。
- **证据**：`docs/clipboard/evidence/perf-actions-release-20261030-180830.log`（失败轮，原样保留不删）
  与 `perf-actions-release-20261030-1813.log`（修复后：`p50 2.99ms · p95 3.22ms · max 3.23ms`，
  预算 60ms，EXIT=0），报告 `docs/performance/results/Q-actions-20261030-101816.json`。
  旧的失败报告 `Q-actions-20261030-101135.json`（`pass: false`）一并留在结果目录，作为修复前后的对照。

### 11.6 迁移升级路径缺少覆盖：v11 → v13 在**有数据**的库上没有测试

- **现象**：复核迁移覆盖面时发现，`db/mod.rs` 的测试只有两段与迁移相关：
  `v5_to_v6_preserves_links_and_defaults_to_reselection`（空库）与
  `backfill_origin_marks_only_provable_test_data`（**全新 v13 库**）。
  也就是说：**没有任何测试验证「一个 v11 的旧库被新版本打开」这条真实升级路径** ——
  旧列的默认值、新列的落地、回填在真实历史数据上的效果，全都没被测过。
  而这正是发布条件里「迁移 v12/v13 在真实用户库上的执行」所指的那条路径。
- **修复（两层）**：
  1. **单元测试**（可复跑，不依赖本机数据）：
     `src-tauri/src/db/mod.rs` 新增 `v11_to_v13_upgrade_keeps_rows_and_isolates_provable_test_data` ——
     先用 `MIGRATIONS[..11]` 建出 v11 库并放入旧结构数据（真实会话 / 自测会话 / 压测轮次 / 通知），
     再用 `Db::open` 打开（触发迁移 + 一次性回填），断言：
     版本推进到最新、四张表行数不变、旧行默认 `real`、
     可证明的自测/压测数据被正确隔离、`bench` 来源 `category=benchmark & hidden=1`、
     v13 的四个分页索引齐备、`pragma_foreign_key_check` 零违规、**重复打开不重复回填也不改写归类**。
  2. **真机工具**（依赖本机数据，默认 `#[ignore]`）：
     `src-tauri/tests/real_upgrade.rs` 新增 `real_user_database_upgrades_without_losing_rows`，
     由 `TD_REAL_UPGRADE_DB` 指向**真实用户库副本**；运行前记录版本与各表行数，
     打开后校验版本推进、行数不减少、外键零违规、`PRAGMA integrity_check=ok`、新列可查询、幂等重开。
     工具只读用户原库，迁移只发生在副本上。
- **真机证据**（本轮实测）：把运行中的真实用户库
  （`%APPDATA%/com.taskdock.desktop/task-dock.db`：8,734 事件 / 36 会话 / 248 轮次 / 310 通知）
  复制为副本并**降级到 v11 结构**（删除 v12/v13 新增的列与索引、`user_version=11`、清掉回填标记），
  再用当前代码打开：
  - 版本 `11 → 13`，行数无减少，外键零违规，`integrity_check=ok`，重复打开不重复推进版本；
  - 回填把 **6 个 `taskdock-selftest-` 会话及其 12 事件 / 12 轮次 / 12 通知** 正确标为 `selftest`，
    其余 **8,722 事件 / 30 会话 / 236 轮次 / 298 通知** 保持 `real`（没有任何真实数据被误判为测试数据）；
  - `bench` 来源注册为 `category=benchmark, hidden=1`。
  - 日志：`docs/clipboard/evidence/gate-real-upgrade-20261030-1855.log`。
- **仍未覆盖**：v0.1/v0.2/v0.3/v0.4 各自的真实历史库升级路径（本次只覆盖 v11→v13）；
  NSIS/MSI 的「安装→升级→卸载」实机链路（会改动用户机器，未擅自执行）。

### 11.7 安装包：用当前源码重建（本轮闭合「产物早于代码」这一条）

- **背景**：第一轮的安装包是 10-29 的产物，早于本轮代码，`bundle/` 里没有任何代表本轮代码的安装包。
- **实测**：`npm run tauri build` **退出码 0**（18:40:21 → 18:44:54），
  先跑 `beforeBuildCommand`（vite build）再 `cargo build --release`（4m 03s），
  最后由 `makensis` / `candle`+`light` 产出：
  - NSIS：`src-tauri/target/release/bundle/nsis/Task Dock_0.5.0_x64-setup.exe`（4,493,352 B）
  - MSI：`src-tauri/target/release/bundle/msi/Task Dock_0.5.0_x64_en-US.msi`（6,840,320 B）
  - 可执行文件：`src-tauri/target/release/task-dock.exe`（15,531,520 B，18:44）
- **日志**：`docs/clipboard/evidence/bundle-build-20261030-1841.log`。
- **如实说明**：产物已重建，但**没有在本机执行安装/升级/卸载**（会改动用户机器的系统状态），
  因此「安装包可用」只是**构建层面**的证据，不是安装层面的证据。

### 11.8 复核确认「已正确、本轮不动」的项目

为避免过度整改，以下项经独立复核确认为**真实闭合**，本轮不做任何改动：

- **origin 隔离不可被客户端伪造**：`AgentEvent` 没有 `origin` 字段，客户端载荷无法声明；
  客户端声明的 `transport` 被忽略，改用**服务端入口**判定的 `Transport`；
  `bench` 是服务端注册的隐藏来源（`category='benchmark'`）；仅 `EventOrigin::Real`
  可改状态、进行动中心、产生通知；非 real 轮次不参与失联判定（`cleanup_stale_core` 过滤 `origin='real'`）。
- **ack 不改 Agent 状态**：确认只写 `action_acks` 与通知已读位，不写
  `agent_runs` / `agent_sessions`；更晚的事件可以让同一条目重新出现。
- **计数与分页口径分离**：全局计数走独立 SQL 聚合，与筛选/游标无关；
  `filtered_total` 是全局值而非当前页长度——这一点在 11.5 里正是被夹具误判的地方。


---

## 十二、第三轮：内存驻留增长归因（2026-10-30 19:20 → 21:10）

§七 里那条「+84 MB / 36,000 事件 ≈ 2.3 KB/事件、没有找到可证明的无界增长点」的结论，
本轮用**多臂差分**做了归因，并补上了「最终二进制上从未复跑」这个空档。
历史测量原样保留，本节只追加新证据。

### 12.1 归因工具：每臂一个独立进程，只改一个变量

新增 `src-tauri/tests/memory_attrib.rs`（`#[ignore]`，需手动跑），
用 `TD_MEM_ATTRIB_ARM` 选臂，每臂**独立进程**（避免堆互相污染），每臂 36,000 事件：

| 臂 | 变量 | 做法 |
| --- | --- | --- |
| `full` | 全链路 | 真实 `IngestPipeline` + 真实 `DbSink`（`ingest_core` 事务提交） |
| `pipeline_only` | 去掉库写入 | 同管线，sink 换成 `DropSink`（不落库） |
| `db_only` | 去掉管线 | 绕过管线，直接按 100 条一事务调 `ingest_core` |
| `full_checkpoint` | 追加 WAL 截断 | 同 `full`，每次提交后 `PRAGMA wal_checkpoint(TRUNCATE)` |

采样同时记录进程 Private/WorkingSet、DB 主库/WAL/SHM 字节与 `page_count`。
每臂耗时 62~76 s，事件提交按 100 条一批（与 `PipelineConfig::default().batch_size` 一致，
否则测的是逐事件 fsync 的磁盘延迟而不是内存）。

### 12.2 归因结果：增长不在「管线 + 库写入」这条路上

| 臂 | Private 增长 | 每事件 | WAL | 主库 | page_count | 耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| `full`（管线 + 库） | **+3,510,272 B（3.35 MB）** | 97.5 B | 5,471,392 B | 54,558,720 B | 13,351 | 70.44 s |
| `pipeline_only`（无库） | +835,584 B（0.80 MB） | 23.2 B | 918,792 B | 4,096 B | 119 | 62.20 s |
| `db_only`（无管线） | +2,785,280 B（2.66 MB） | 77.4 B | 5,463,152 B | 54,841,344 B | 13,389 | 70.22 s |
| `full_checkpoint`（截断 WAL） | +3,772,416 B（3.60 MB） | 104.8 B | **0 B** | 55,095,296 B | 13,451 | 76.28 s |

三条可判定的结论：

1. **量级对不上**：接入管线 + SQLite 写入每 36,000 事件只涨 **3.35 MB**，
   比真机长跑观察到的 **+84 MB** 低一个数量级 —— 增长**不在这条路上**。
2. **拆分自洽**：`full` ≈ `pipeline_only` + `db_only`（0.80 + 2.66 = 3.46 ≈ 3.35 MB），
   说明 77.4 B/事件主要来自库侧写入，与管线无关。
3. **不是 WAL 累积**：把 WAL 每次提交后截断，Private 增长不降反升（3.35 → 3.60 MB），
   所以「WAL 越堆越大」这一猜测被证伪。

因此 +84 MB 只能来自**只有真机才有的路径**：HTTP 接入层、提交后副作用
（`app.emit` 广播 / 托盘 / 系统通知）、以及前端快照服务。
下一次实验就针对这条路径（见 12.4）。

### 12.3 顺带证伪：早期的「1,321 B/事件」是启动成本，不是每事件驻留

第一版归因工具每个事件一次事务（等于每个事件一次 fsync），2,000 事件测出 **1,321 B/事件**。
改成 100 条一事务后，36,000 事件只有 **97.5 B/事件**；把事件数从 2,000 提到 36,000
并不按比例放大单事件成本 —— 说明早期那个数字几乎全是**固定启动成本**摊到少量事件上的结果，
不是「每事件驻留」。这类「样本量太小导致斜率虚高」的结论不能直接拿去做预算。

### 12.4 三臂对照：把通知路径单独拆出来

新增 `scripts/perf/memory-notify-suite.sh`（驱动既有 `scripts/perf/memory-scenario.py`），
同一 release 二进制、同样负载，三个臂只差一个变量：

- **N1**：负载 + 通知开（完整用户路径）
- **N2**：同样负载 + 通知关
- **N3**：空闲（无负载）→ 基线漂移

差值口径：**N1 − N2 = 通知路径贡献**，**N2 − N3 = 接入路径贡献**，**N3 = 基线漂移**。
每臂隔离数据目录 / APPDATA / 端口；采样同时记录进程 Private Bytes 与
`alloc_stats.live_bytes`（Rust 侧活跃分配），二者之差用来区分
「Rust 泄漏」与「原生（COM/WinRT/WebView2/SQLite）驻留」。

### 12.5 隔离实例身份：数据目录就是实例边界

跑隔离实例时踩到一个真实阻塞：应用被**单实例插件**直接拦下并退出，
HTTP 端口根本起不来，健康检查超时 —— 而本机同时有一个用户自己启动的实例在运行。
这不是测量脚本的问题，是**产品语义问题**：单实例锁按应用标识（`com.taskdock.desktop`）区分，
而不是按数据目录区分，于是「隔离数据目录的验收实例」和「正式安装」互相顶掉。

修复（`src-tauri/src/lib.rs` → `instance_identifier_for`）：设置 `TASK_DOCK_DATA_DIR` 时，
单实例标识与通知 AUMID 都按**数据目录的哈希**区分：

- 未设置覆盖 → 标识完全不变，正式安装的单实例保护行为一字未动；
- 设置覆盖 → 隔离实例与正式安装互不顶掉、互不串数据；
- **指向同一目录的两个隔离实例仍然互相拦下**（数据目录就是实例边界）。

单测 `tests::instance_identity_is_unchanged_without_data_dir_override`、
`tests::isolated_data_dir_gets_its_own_instance_identity`、
`tests::isolated_identity_is_case_insensitive_on_windows_paths` 覆盖这三条性质。

> 顺带修正一个发布流程坑：`npm run tauri build` 产出的 exe 与**裸 `cargo build --release`**
> 产出的不是同一个东西 —— 后者漏了 `custom-protocol` 特性，**启动即退出**。
> 本轮第一次用裸 cargo 构建的二进制跑三臂，健康检查全部超时就是这个原因。
> 性能/验收测量必须用 Tauri CLI 产出的二进制。

---

## 十三、第三轮复核：三臂数据作废、测量缺陷修正与最终二进制复跑（2026-10-30 21:46 →）

本节是 §十二 的续篇。§十二 的归因结论（12.2 四臂 + 12.3 每事件成本）**全部保留**，
但 **12.4 的三臂对照数字作废**，原因是**测量对象已经死了**——不是产品行为变了。
本节只追加：作废依据、测量脚本修正、环境干扰清单、以及在最终二进制上的复跑结果。

### 13.1 作废依据：N3 空闲臂测的是一个「已经退出的进程」

第二轮三臂对照里，N3（空闲基线）曾给出「Private 8.9 → 0.0 MB、斜率 −0.884 MB/min」，
并据此推出「接入路径贡献 = N2 − N3 = +14.3 MB」。复核发现三个互相印证的异常：

1. **N3 臂的实例在采样窗口内自行退出**。`last-shutdown-report.json` 记录
   `lifecycle=stopped`、`already_stopped=false`、`drained_events=0` —— 属**优雅退出**
   （应用自己的退出流程跑完了），不是崩溃：Windows 事件日志里没有该进程的崩溃条目。
2. **采样器仍在写数据**。采样按进程名匹配，进程不在 → 分组计数为 0 → 内存读数为 0，
   于是「进程死了」被读成「空闲路径把内存放掉了」。
3. **同窗口的 30 分钟 C 臂也在负载结束后约 300 s 失去健康检查**，形态一致。

作废当时本机正在跑**上一会话遗留的后台任务队列**：`cargo build --release`、
`cargo test --release`、`memory-af-suite.sh` 重跑。其中一次 `cargo build --release`
在实例死亡前 18 s 因**目标文件被运行中的实例占用**失败
（`failed to remove file … 拒绝访问。 (os error 5)`），
产出了一个**缺 `custom-protocol` 特性的 dev-mode 二进制**——
它启动即弹「开发服务器预检失败」并退出，数据库/管线/HTTP 服务全都不启动。

**结论**：N1/N2 两臂（实例存活 581 s、无退出事件）是有效的，**N3 臂无效**；
凡依赖 N3 的差值（N2 − N3）与结论（「空闲释放内存」「接入路径 +14.3 MB」）一律作废。
前一轮的**独立空闲对照**（`docs/clipboard/evidence/perf-a-idle-30min-final-20261030.json`，
58 个样本、进程数全程恒为 7、句柄 10,096→10,091、线程 223→214、无 0 值）
**不在作废范围内**，其「空闲路径收敛」结论继续有效。

### 13.2 测量脚本修正（六个缺陷，都已落代码）

| # | 缺陷 | 后果 | 修正 | 文件 |
|---|---|---|---|---|
| 1 | `echo "… rc=$?"` 里 `$(date)` 命令替换先覆盖 `$?` | 失败轮次被记成 `rc=0`（N3 曾因此被判成功） | 先 `local rc=$?` 落变量再输出 | `memory-af-suite.sh`、`memory-notify-suite.sh` |
| 2 | 实例退出无法被观测 | 死掉的进程被读成「内存回落到 0」 | 负载结束后逐秒轮询存活，记 `instance_exited_after_s`/`instance_exit_code`，命中即 `SystemExit(1)` | `memory-scenario.py` |
| 3 | 应用自身日志没被采集 | 判断不了实例为何退出 | 子进程 stdout/stderr 显式落 `DIAG-<name>-<ts>-app.log` | `memory-scenario.py` |
| 4 | 「显示窗口」取到插件工具窗 | `--window visible` 其实显示的是单实例插件的 `WS_EX_TOOLWINDOW` 消息窗，主窗口始终隐藏（界面根本没渲染，IME/毛玻璃路径也没走到） | 过滤 `WS_EX_TOOLWINDOW` + 取面积最大的可见窗口 | `memory-scenario.py`、`module-fingerprint.py` |
| 5 | 采样器按进程名归组 | 机器上任何多余 `task-dock.exe` 都会混进 `taskdock` 分组 | 场景启动前检查是否已有实例，有则**拒绝执行**并报 PID | `memory-scenario.py` |
| 6 | 压测来源未隔离 | 内存探针默认 `source=bridge`（真实类别），压测事件被服务端判为 `real`，可进真实状态与系统通知 | 与 `ingest-load.mjs` 同口径：默认 `bench`，非 `bench` 必须 `--allow-real-source` | `memory-probe.mjs`、`memory-scenario.py`、两个套件脚本 |

第 6 项的实测校验（隔离实例内查询，35 s 冒烟）：
`agent_events` 80 条全部 `origin=benchmark`、`agent_sessions` 2 条同为 `benchmark`、
`notification_history` **0 条**、`bench` 来源 `verified=0 / transport_verified=0`
——压测事件永远不能成为真实接入证据。

### 13.3 环境干扰清单（压测前必须逐条确认）

1. **产物必须是带 `custom-protocol` 的**：裸 `cargo build --release` **不等于**
   `npm run tauri build`；前者不带该特性 → `tauri::is_dev()` 为真 → 启动即弹框退出。
   本轮最终二进制：`src-tauri/target/release/task-dock.exe`，**15,553,536 B**，
   `sha256=35dcd14f109277105db95ed836439b7c6288b70dd760111683566d13d8a82a44`，
   2026-10-30 21:46:42 构建（`npm run tauri build -- --no-bundle`）。
   dev-mode 对照产物为 15,400,960 B（字节数即可肉眼区分）。
2. **Windows 文件锁**：运行中的 `task-dock.exe` 会让 `cargo build --release` 无法替换目标文件。
3. **后台任务队列**：压测期间被拉起的后台构建/测试会同时污染 CPU 与采样归属；
   开跑前确认队列为空，压测期间**不得**同时跑 cargo/npm。
4. **机器固有噪声**：`gitfox`（nssm 管理）约 128 s 周期的崩溃重启、其他项目的常驻 dev server，
   会抬高全机 `webview2_other`/`other_agents` 的 CPU 读数；解读只看本进程树分组。

