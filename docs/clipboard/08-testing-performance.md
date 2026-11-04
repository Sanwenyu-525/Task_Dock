# 08 · 测试、兼容性与性能

> 测试日期：2026-10-29（基线）· 2026-10-30（最终复核）· 2026-10-30 18:18（第二轮复核重跑）· 应用版本 0.5.0
> 本文 §一–§四、§五.1–§五.5 为 2026-10-29 的记录；§五.6 起与 §六–§九
> 为 2026-10-30 最终复核结果；§五.11 与 §八 的第二轮条目为 2026-10-30 18:18 之后的复核。
> **最终判定为 CONDITIONAL PASS**，
> 依据与完整证据见 [11-final-release-acceptance.md](11-final-release-acceptance.md)。
> 原则：自动化结果与真机结果分开记录；**未执行的验收不写成通过**。
> 结果原始文件：`docs/performance/results/CLIP-20261029-080326.json`（历史基线）
> 及同目录 CLIP 记录（00:26 / 00:27 / 13:08 / 23:36 / 23:59 与本轮重跑）。

## 一、测试分层

| 层次 | 手段 | 覆盖 | 不覆盖 |
|---|---|---|---|
| 分组/解析/哈希/敏感规则 | `cargo test --lib` | 纯逻辑、边界、去重、隐私模式、保守凭据模式 | Win32、真实剪贴板 |
| 存储/迁移/清理/引用安全 | `cargo test --lib`（真实 SQLite 临时库 + 临时目录） | 落盘、配额、级联、任务关联、失败无半行 | 磁盘满、权限异常 |
| 粘贴状态机/竞态 | `cargo test --lib`（注入 `PasteIo` 假实现 + 可控时间线） | 外部剪贴板变化、序列号竞态、取消、目标关闭、焦点失败、恢复失败、重启续跑、禁止盲目重发 | 真实 `SendInput`、目标应用接收 |
| 监听队列/背压 | `cargo test --lib`（`BoundedQueue` + 1000 事件压力） | 队列容量、丢最旧、字节预算、合并、panic 隔离 | 真实 OS 事件节奏、CPU/内存 |
| 剪贴板写入/读取格式 | `cargo test --lib`（部分真机） | CF_HTML 偏移、DIB、HDROP 解析、排除名单、锁内序列号校验 | 第三方应用是否接收 |
| 前端纯逻辑/组件 | `npx vitest run` + testing-library | 复制预检、分组/监听状态、粘贴进度、批量状态、分页、错误重试 | 真实 WebView 渲染与系统剪贴板 |
| 端到端 UI + 系统剪贴板 | 隔离实例 Playwright 验收脚本（临时目录，不入库） | 真实监听、真实逐项粘贴、真实目标窗口、重启持久化 | 微信/Agent 应用、长时挂机 |
| 性能 | `cargo test --release --test clipboard_perf -- --ignored` | 入库、列表、搜索、缩略图、编解码、200 连拍+配额 | WebView 帧率、空闲 CPU/内存、真实硬件长跑 |

## 二、自动化检查结果（2026-10-29 基线）

> 本节数字是 10-29 基线，不再代表最终源码；最终门禁计数（302 passed / 2 锁屏失败 /
> 11 ignored、前端 133 例、构建 464.88 kB JS + 68.51 kB CSS）见
> [11-final-release-acceptance.md](11-final-release-acceptance.md) §三。

### 2.1 Rust

| 命令 | 结果 |
|---|---|
| `cargo fmt --check` | 通过（无差异） |
| `cargo clippy --all-targets --all-features` | 通过，0 警告 |
| `cargo test --all-targets` | **244 passed；0 failed；0 ignored**（lib），另有 10 个手动/真机测试标为 ignored |

说明：`cargo test --all-targets` 会同时编译集成测试；其中 `actions_perf` 1 例、
`clipboard_perf` 2 例、`ingest_perf` 6 例、`real_backup_restore` 1 例为 `#[ignore]`
的手动性能/真机工具，不计入 244。剪贴板模块（engine / image / store / paste /
platform / agent_bridge）内的单元测试共 **61 例**，另有跨模块集成用例与真机脚本。

本次整改新增/加强的关键用例：

| 模块 | 用例 | 验证点 |
|---|---|---|
| paste | `text_image_text_keeps_order_and_never_claims_confirmed` | 文本→图片→文本顺序；无接收信号时 `confirmed=0` |
| paste | `sequence_race_between_check_and_write_never_overwrites` | 检查与写入之间用户复制 → 不覆盖 |
| paste | `external_update_between_items_stops_without_restore` | 外部更新后停止且不恢复 |
| paste | `cancel_preserves_unprocessed_items_and_still_finishes` | 取消保留未处理项、仍完成收尾 |
| paste | `send_failure_removes_written_item_to_prevent_duplicate_paste` | 按键失败不盲目重发 |
| paste | `resumed_plan_does_not_retry_consumed_items` | 重启续跑不重发已消费项 |
| paste | `closed_target_fails_without_writes` / `focus_failure_keeps_item_pending` | 目标关闭/焦点失败不写入 |
| paste | `restore_failure_is_reported_honestly` | 恢复失败如实上报 |
| paste | `each_write_is_guarded_by_the_last_own_content` | 每次写入使用内容守卫，序列号只作快速变化检测 |
| paste | `user_copy_after_write_blocks_key_and_preserves_new_content` | 写入后用户复制 → 不发送按键、保留新内容 |
| paste | `unreadable_clipboard_is_retried_and_does_not_stop_the_job` / `persistently_unreadable_clipboard_stops_before_sending_keys` | 短暂占用重试；持续不可读时不发送按键 |
| paste | `per_type_intervals_and_settle_are_conservative` | 分类型间隔与收尾窗口 |
| platform | `event_burst_is_bounded_and_keeps_latest_sequence` | 200 事件只留 64、保留最新序列号 |
| platform | `mixed_content_backlog_respects_count_and_byte_budgets` | 混合内容队列条目/字节双上限 |
| platform | `monitor_queue_stress_keeps_backlog_bounded` | 1000 事件压力，峰值=容量、丢弃计数准确 |
| platform | `capture_filter_honors_pause_and_kind_toggles` | 暂停/停用/类型开关 |
| platform | `capture_filter_excludes_configured_apps` | 排除名单按 basename 匹配 |
| platform | `capture_filter_uses_conservative_sensitive_policy_for_unknown_source` | 来源未知时才启用保守凭据模式 |
| platform | `process_catching_panic_converts_panic_to_failed` | 单条 panic 不杀死采集线程 |
| platform | `write_guard_uses_content_for_own_writes` / `write_guard_uses_sequence_only_for_uncomparable_baseline` / `unconditional_write_has_no_guard_constraint` | 内容守卫、基线序列号守卫、用户复制无条件写入 |
| platform | `payload_match_requires_same_text_and_html_presence` / `payload_match_compares_image_bytes_and_file_names` | 内容比较覆盖文本/HTML/图片/文件 |
| platform | `exclusion_list_matches_basename` | 完整路径与 exe 名等价 |
| store | `image_capture_failure_leaves_no_partial_row` | 图片落盘失败不留半条记录 |
| db | `clipboard_paste_intervals_keep_conservative_defaults` | 默认间隔 350/600/900/1200 ms |
| engine | `conservative_filter_catches_credentials_only_when_source_unknown` | 保守模式只匹配凭据赋值/认证头/JSON 凭据 |
| db | `clipboard_corrupt_json_fails_closed_and_keeps_unrelated_settings` | 配置损坏时停止采集，任务/Agent 设置不受影响 |
| db | `clipboard_config_never_enables_after_user_disabled` | 用户关闭后不会被默认值重新启用 |
| db | `clipboard_repair_backs_up_raw_values_and_requires_explicit_resume` | 修复备份原始值；仅修复保持暂停 |
| db | `clipboard_repair_does_not_write_when_database_broken` | DB 不可读时不写入 |
| image | `fully_transparent_png_is_treated_as_opaque` / `transparent_png_from_clipboard_is_reencoded_visible` / `opaque_clipboard_png_is_kept_byte_identical` | 全透明归一化；部分透明/正常图不动 |
| agents/http_ingest | `http1_connection_with_header_timeout_answers_instead_of_panicking` | 真实 TCP：设置 `header_read_timeout` 后返回 200 而非 panic |

### 2.2 前端

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | **16 文件 / 109 测试全部通过**（7.06 s） |
| `npm run build` | 通过（459.80 kB JS / 67.70 kB CSS；gzip 137.35 / 10.80 kB） |
| ESLint | **未执行**：仓库没有 ESLint 配置，不伪造 lint 结果（见 §七） |

新增/加强的前端测试：

| 文件 | 用例 |
|---|---|
| `src/lib/clipboardUi.test.ts` | 9 例：未知来源文案、预检无警告、6 MB 图片预算、超预算占位+替代方案、文件模式只传路径、超大 HTML 降级、混合统计、NaN 容错 |
| `src/components/clipboard/PastePanel.test.tsx` | 3 例：分类型间隔提示；启动后逐项状态/剩余/进度条；取消后 unverified 与继续入口；完成文案且无取消/继续 |
| `src/components/clipboard/ClipboardDrawer.test.tsx` | 4 例：监听中 + 80/100 加载更多只追加；监听未启动 vs 暂停；错误 + 重试；**配置损坏时显示“已暂停”，绝不显示“监听中”** |
| `src/components/clipboard/AgentExportPanel.test.tsx` | 2 例：能力矩阵文案（直接发送不支持/文件导入未验证/桌面粘贴可手动/本地导出可用）；本地导出参数与“未发送”提示 |
| `src/store/useClipboardStore.test.ts` | 4 例（原有）：筛选清空多选、刷新剔除失效选中、追加分页、加载失败 |

本次全量运行未出现此前的 5 s 超时；早前在 CPU 满载并行编译时出现过 3 例任务面板超时，
属于测试阈值而非功能回归，未通过修改阈值掩盖。

### 2.3 构建与打包

| 项目 | 结果 |
|---|---|
| `npm run build` | 通过（459.80 kB JS / 67.70 kB CSS） |
| `npx tauri build`（release） | 通过，4m49s；NSIS 3.98 MiB + MSI 6.11 MiB（产物时间 10:16，晚于最终 UI 修复）；**本轮最终重建见 `11` §三** |
| 隔离 debug 实例（acceptance identifier，内嵌前端） | 构建通过并完成真机验收 46/46 |

**打包产物**：

```
target/release/bundle/nsis/Task Dock_0.5.0_x64-setup.exe  3.98 MiB
target/release/bundle/msi/Task Dock_0.5.0_x64_en-US.msi   6.11 MiB
```

未签名，首次运行需“更多信息 → 仍要运行”；未做安装/卸载实测（见 §七）。

## 三、22 项必测场景矩阵

“自动化覆盖”指单元/集成测试；“真机”指真实系统剪贴板与第三方窗口。验收脚本共
**46 项检查**（A0、B1–B17 及 b 补充项、C1–C12、D1–D5、E1、F1、G1–G2、H1–H2），
2026-10-29 在未锁屏桌面运行 **46/46 PASS**。**本轮（2026-10-30）未重跑这 46 项**：
工作站自 16:36 起锁屏，只完成场景 C/D、30 分钟空闲（A）与 P0 配置损坏的真实运行；
表中“真机结果”列是 10-29 历史证据，不冒充本轮结果。修复 Alpha 后的图文混合
像素级复验仍为 `ENVIRONMENT BLOCKED / NOT VERIFIED`（见 §七）。

| # | 场景 | 自动化覆盖 | 真机结果（2026-10-29） |
|---|---|---|---|
| 1 | 连续复制多段文字全部入历史 | store 单测 + monitor 队列压力 | **PASS**：B2/B3/B8（含截图之间插入文字） |
| 2 | 连续截图三次自动分组 | engine/store 单测 | **PASS**：B8（3 图自动成组）、B8b（12 张同组） |
| 3 | 截图之间插入文字顺序不变 | store 单测 | **PASS**：B8 `positions=0,1,2,3` |
| 4 | 超时间窗口建立新组 | engine 单测 | **PASS**：B9 旧组 `closed`、B9b 新组 `collecting` |
| 5 | 相同内容去重 | store 单测 | **PASS**：B3 一条记录、`copy_count=4` |
| 6 | 手动调整组内顺序 | store 单测 | **PASS**：B17 顺序持久化 |
| 7 | 重启后历史与分组存在 | 持久化单测 | **PASS**：H1 `items 239->239 groups 8->8` |
| 8 | 删除分组不破坏共享图片 | store 单测 | **PASS**：D4 组删除条目保留、D5 图片资产 `11/11` 保留 |
| 9 | 复制单项图片 | image/store 单测 | **PASS**：B7b 系统剪贴板含 PNG/DIB |
| 10 | 复制多文件 | HDROP 单测 | **PASS**：B10b `FileDrop` 两文件路径 |
| 11 | 富文本整组复制 | engine 单测 | **PASS**：C1 `HTML Format` + 纯文本 |
| 12 | 粘贴整组保持顺序 | paste 状态机 | **PASS**：C3 记事本真实读回 `target_len=57`、`order=0,19,38` |
| 13 | 中途取消粘贴 | paste 取消保留未处理项 | **PASS**：C7 `cancelled sent=1/5 remaining=4` |
| 14 | 目标窗口丢失焦点 | paste 目标关闭/焦点失败 | **PASS**：C10 目标关闭即停止；焦点被抢仅单测覆盖 |
| 15 | 目标应用拒绝图片格式 | — | **PASS**：C12 目标文本未变，任务只报“动作已发送” |
| 16 | 粘贴失败显示具体状态 | paste 失败/跳过状态 | **PASS**：C7/C10 含具体原因与恢复结果 |
| 17 | 粘贴中用户修改剪贴板 | paste 内容竞态/恢复守卫 | **PASS**：C11 `failed`、`clip_keeps_user=true`、未恢复 |
| 18 | 自动粘贴不产生自记录 | self_write 单测 | **PASS**：C6 历史行数不增 |
| 19 | 大量截图不明显卡顿 | 200 连拍 release 实测 | **PASS（有限）**：G2 200 条列表 `p50=5ms`、200 连拍 2.73 s；1000 张 UI 未测 |
| 20 | 任务/Agent 原有功能正常 | 10-29：244 Rust + 109 前端 | **PASS**：H2 任务列表与快速添加正常 |
| 21 | 隐私排除名单有效 | 过滤/basename 单测 | **PASS**：B13 被排除应用未入库 |
| 22 | 关闭监听后不保存新内容 | 过滤单测 | **PASS**：B11b 关闭期间 0 行，重新启用后恢复 |

## 四、兼容性验收矩阵

格式层（单元测试 + 真机读回）：

| 写入格式 | 验证方式 | 结果 |
|---|---|---|
| CF_UNICODETEXT | 单测 + C3/C5 真实读回 + M1/M3/M5 | 通过（真机） |
| CF_HTML | 偏移/片段单测 + C1/B6 + M4 contenteditable | 通过（真机格式存在；样式接受度见边界） |
| PNG + CF_DIB | 往返单测 + B7b 系统格式枚举 | 通过（真机） |
| CF_HDROP | 宽字符路径单测 + B10b/M2 | 通过（资源管理器真实落盘） |
| 自写入隔离 | self_write 单测 + C6 | 通过 |
| 内容守卫/恢复 | `write_guarded` / `restore_if_own_content` 单测 + C11 | 通过（真机保留用户新内容） |
| 图片 Alpha 归一化 | 3 个 image 单测 + 修复前真机像素审计（0/5760 不透明） | **单测通过；修复后 GUI 未验证（锁屏）** |

Alpha 一行的含义：单元测试只证明“全透明 PNG 会被改写为不透明”，不证明真实
目标应用能显示粘贴结果。修复前的真实记录只证明顺序正确、图片不可见，
因此应用层结论保持 `NOT VERIFIED`，不把单测折算为兼容性证明。

目标应用层（2026-10-29 真实桌面）：

| 目标 | 验证方式 | 状态 |
|---|---|---|
| 记事本 | 3 项文本有序 + SendKeys 读回（M1）；拒绝图片（C12） | **PASS** |
| Windows 资源管理器 | 两个文件真实复制落盘（M2） | **PASS** |
| Chromium/Edge 文本框 | CDP 读回两项有序（M3） | **PASS** |
| 富文本 contenteditable（Edge） | `<b>`/`<i>` 保留（M4） | **PASS** |
| VS Code | 隔离实例粘贴两项、Ctrl+S 后磁盘文件读回（M5） | **PASS** |
| 微信桌面端 | — | **ENVIRONMENT BLOCKED / NOT VERIFIED**：已登录真实用户会话，无隔离实例，不注入按键 |
| Agent 类应用（Trae CN） | — | **NOT VERIFIED**：停在登录/引导页，无法进入编辑区 |

**不得**将上述“未验证”改写为“支持”或“部分支持”；粘贴任务的最终文案固定为
“已发送 N/M 项粘贴动作；目标应用是否接收无法自动验证”。

## 五、性能实测（release）

环境（结果 JSON 自动记录）：Windows x86_64 · LAPTOP-RTUVXZ-G · 20 逻辑 CPU ·
应用 0.5.0 · release。

命令：

```bash
cd src-tauri
cargo test --release --test clipboard_perf -- --ignored --nocapture
```

### 5.1 基础采样（1000 条文本 + 1 张 1920×1080）

| 指标 | 本次实测 |
|---|---|
| 单条入库均值 | 0.072 ms |
| 列表 80 条 p50 / p95 | 2.270 / 2.659 ms |
| 计数 p50 / p95 | 0.014 / 0.016 ms |
| 搜索未命中 p50 / p95 | 0.690 / 0.746 ms |
| 缩略图 p50 / 最大 | 4.364 / 5.251 ms |
| PNG 编码（1920×1080，Fast） | 95.433 ms |
| PNG 解码 | 13.211 ms |
| RGBA→DIB / DIB→RGBA | 4.425 / 5.003 ms |
| 图片条目完整入库（含缩略图+落盘） | 14.117 ms |

### 5.2 验收预算（docs/V05_DESIGN.md 8.2）

| 项目 | 预算 | 本次实测 | 判定 |
|---|---|---|---|
| 300 条历史（200 文本 + 100 图 960×540）列表 80 条 p95 | ≤120 ms | **1.001 ms** | 通过 |
| 同上列表 200 条 p95 | ≤120 ms | **1.185 ms** | 通过 |
| 200 张 1920×1080 连续截图入库（落盘+缩略图+DB+分组+配额） | ≤8 s | **2.730 s**（含清理 2.799 s） | 通过 |
| 配额收紧到 32 MB 后的清理 | 磁盘/资产 ≤32 MB | 30.215 MB，删除 187 条 | 通过 |
| 自动分组 | 1 组 200 条，状态 collecting | 符合 | 通过 |

原始记录：`docs/performance/results/CLIP-20261029-080326.json`。

### 5.3 与整改前基线对比

| 指标 | 00:26/00:27 记录 | 08:03 记录 | 说明 |
|---|---|---|---|
| 200 连拍总耗时 | 5.846 s / 6.632 s | 2.799 s | 同机 release；本次文件系统/页缓存更热，**不能全部归因于代码** |
| 列表 80 条 p95 | 1.52 / 1.94 ms | 1.001 ms | 同上，量级一致 |
| 列表 200 条 p95 | 1.713 ms | 1.185 ms | 同上 |
| PNG 编码 setup | 38.2 s | 19.13 s | setup 阶段，不计入入库预算 |
| 配额清理后磁盘 | 30.2 MB | 30.215 MB | 一致 |

结论：两次记录都满足预算；本次更快主要来自环境热缓存，不能宣称“优化后提升一倍”。
真实使用中的瓶颈仍在截图 PNG 编码（约 95–191 ms/张，取决于内容与缓存）。

### 5.4 队列压力与背压

| 项目 | 结果 |
|---|---|
| 100 次快速事件 | 事件队列峰值 ≤64，保留最新序列号，丢弃计数准确 |
| 1000 次事件洪峰 | 峰值=64，丢弃 936，队列长度从未超容量 |
| 混合内容 + 字节预算 | 条目数与 128 MB 双上限均生效，丢弃最旧 |
| 监听线程职责 | 只入队；读取/编码在 capture 线程，入库在 worker 线程 |

以上为**进程内队列压力测试**，不是真实 OS 剪贴板事件节奏；真实监听下的
observed/captured/latency/CPU/内存未测量（见 §七）。

### 5.5 说明与边界

- 200 张 1080p 截图落盘约 464.8 MB，收紧配额后清理到 30.2 MB；默认上限 512 MB
  时只能容纳约 220 张全尺寸截图，长期使用会触发清理。
- 截图 PNG 编码属于平台采集阶段，未计入入库预算；真实截图管线会逐张编码，
  用户连续截图 200 张的实际落库节奏受此限制。
- **2026-10-29 时未测量**：WebView2 渲染帧率、空闲 CPU、常驻内存、真实硬件 30 分钟
  长跑、大分组滚动、抽屉快速开关、并发 Agent 事件/任务更新。**这些项目已在
  2026-10-30 的场景 A/C/D 中补测，见 §五.6–§五.9**；其中真实剪贴板事件
  仍因锁屏为 0，不能外推为“真实事件节奏下稳定”。
- 1000 条文本历史（+1 图）的列表查询已由 §5.1 覆盖（p95 2.659 ms）；
  “>1000”未覆盖的是连续截图数量与大分组滚动，不是历史条数本身。

### 5.6 本轮 release 剪贴板预算（2026-10-30）

干净重跑（`cargo test --release --test clipboard_perf -- --ignored --nocapture`，
01:30–01:32，机器仅运行该测试），报告 `docs/performance/results/CLIP-20261030-013239.json`：

| 项 | 实测 | 预算 | 判定 |
|---|---|---|---|
| 300 条历史（含 100 图）列表 80 条 p95 | 1.964 ms | ≤120 ms | PASS |
| 300 条历史列表 200 条 p95 | 2.364 ms | ≤120 ms | PASS |
| 200 张 1920×1080 截图入库+分组+配额 | 6,984.09 ms | ≤8,000 ms | PASS |
| 其中清理 | 179.07 ms | — | — |
| 资产落盘 | 30.21 MB | ≤32 MB 配额 | PASS |
| PNG 编码准备（不计入入库） | 47,584.97 ms | — | — |
| 总脚本 `pass` | `true` | — | PASS |

此前 2026-10-29 23:36 / 23:59 两次失败（ingest 16.75 s / 17.01 s，setup 112–113 s）
发生在机器有其他编译负载时；失败 JSON 保留在 `docs/performance/results/`，
预算未调整。本次重跑与 §5.10 记录并列，不覆盖失败记录。

### 5.7 场景 A：30 分钟空闲（2026-10-30）

release 实例 + 隔离数据目录（1,250 条历史），30 s 间隔采样 58 个样本
（1804 s，20 逻辑 CPU，进程树 7–9 个）：

| 指标 | 结果 |
|---|---|
| CPU 平均 / 峰值 | **0.324% / 0.594%** |
| 工作集 WS | 546.11–643.63 MB（平均 564.28） |
| 私有内存 | 375.85–455.05 MB（平均 390.69） |
| 线程 / 句柄 | 204–225 / 10,074–10,470 |
| 历史规模 | 1,250 条 / 555,068 B，前后一致 |
| 监听状态 | `monitoring=true`、`paused=false`，未漂移 |
| 监听计数 | 全 0（锁屏无真实剪贴板事件）；队列峰值 0 |
| 健康检查 | 200（前/中/后） |

限制：锁屏使真实事件为 0，只证明空闲无泄漏、线程存活，不证明真实事件节奏；
采样期间未运行编译/压测。原始数据：`evidence/perf-a-idle-30min-20261030.json`。
独立第二次采样（00:54:45–01:24:17，1,803 s，58 样本，与前次重叠约 25 分钟）：
CPU 平均 0.294% / 峰值 0.607%；WS 546.31–594.04 MB；私有内存 376.32–403.02 MB；
线程 203–223；句柄 10,074–10,096，结论一致；
原始数据：`evidence/perf-a-idle-30min-final-20261030.json`。

### 5.8 场景 C：Agent 高频事件 + UI + 任务提醒 + 抽屉（2026-10-30）

两轮 16 worker × 60 s，每 23 条事件插入一条 `completed`，同时 3 个提醒任务、
抽屉开关、列表刷新与搜索。摘要：

| 指标 | 第 1 轮 | 第 2 轮 |
|---|---|---|
| 事件请求 / HTTP 200 | 33,649 / 33,649 | 41,004 / 41,004 |
| 过载拒绝 / 提交失败 / 内部错误 | 0 / 0 / 0 | 0 / 0 / 0 |
| 请求延迟 p50 / p95 / max | 17.78 / 89.72 / 2583.07 ms | 17.00 / 42.17 / 2237.75 ms |
| 单批写库 p50 / p95 / max | 18.56 / 52.67 / 68.31 ms | 19.32 / 62.58 / 95.60 ms |
| ingest p50 / p95 / max | 119.80 / 2486.59 / 2612.57 ms | 119.26 / 294.03 / 507.81 ms |
| 进程 CPU / 私有 / WS 峰值 | — | 2.719% / 545.48 / 720.89 MB |
| 线程 / 句柄峰值 | — | 243 / 10,155 |

解释：Agent 管线零丢失/零拒绝；`events_processed < events_received` 是最新事件
合并策略（非丢弃）。高频事件期间 WebView 主线程被列表刷新/搜索占用，抽屉 p95
约 0.51–0.55 s，后端列表仍为几十毫秒。**剪贴板侧为 0 事件（锁屏），不能称
“剪贴板 + Agent 联合压测通过”。** 原始数据：`evidence/perf-c-*.json`。

### 5.9 场景 D：>1000 条历史、大分组、滚动、预览、抽屉与清理（2026-10-30 release）

数据集 1,250 条（1,185 文本 + 45 图片 + 20 文件 + 1 个 50 条分组），960×540 图片，
DB 约 10 MB。摘要：

| 指标 | release 实测 |
|---|---|
| 抽屉首次打开 | 239.11 ms |
| 快速滚动 5 s（395 帧） | p50 15.2 / p95 17.2 / max 32 ms，>50 ms 0 帧 |
| 搜索 `BURST` | 稳定 367.4 ms，2 个 53 ms long task |
| 图片详情（含解码） | 56.4 ms |
| 分组卡片 / 50 行详情 | 7.8 / 15.6 ms（后端 18.15 / 19.6 ms） |
| 10 次抽屉开关 | 打开 85–152 ms；关闭 13–22 ms |
| 后端列表 80 / 200 条 p95 | 40.77 / 52.46 ms |
| 后端搜索 p95 / max | 43.86 / 47.21 ms |
| 清理（440 条 / 1,275,695 B）期间帧 | p50 8 / p95 8.6 / max 17.03 ms，>50 ms 0 |
| 删除 10 条 | 23.76 ms |
| 类型筛选 | 图片 45 / 文件 20 / 文字 1,185 / 全部 1,250；耗时 477–577 ms |

原始数据：`evidence/perf-d-ui-release-20261030.json`、`perf-d-filter-release-20261030.json`。

### 5.10 失败运行与解释（不得只报成功）

| 时间 | 结果 | 观察 |
|---|---|---|
| 2026-10-29 23:36 | **FAIL** | ingest 16.75 s（预算 8 s），encode setup 112.27 s |
| 2026-10-29 23:59 | **FAIL** | ingest 17.01 s，encode setup 113.25 s |
| 2026-10-29 13:08 | PASS | ingest 4.09 s，encode setup 27.33 s |

两次失败发生在机器有其他编译/负载时，setup 从约 20–27 s 升至 112–113 s，
不是“仅入库变慢”；失败记录保留在 `docs/performance/results/CLIP-20261029-233606.json`、
`CLIP-20261029-235948.json`，未删除、未篡改预算。最终干净重跑见 §5.6。

### 5.11 第二轮复核重跑（2026-10-30 18:18–18:30，当前源码）

`cargo test --release --test clipboard_perf -- --ignored --nocapture`，
**2 passed / 0 failed（EXIT=0）**，结果 `docs/performance/results/CLIP-20261030-183022.json`，
日志 `docs/clipboard/evidence/perf-clipboard-release-20261030-1819.log`：

| 项 | 实测 | 预算 | 判定 |
|---|---|---|---|
| 1000 条历史（1 张 1920×1080）列表 80 条 | p50 2.944 / p95 3.416 ms | — | — |
| 1000 条历史计数 | p50 0.011 / p95 0.013 ms | — | — |
| 搜索未命中 | p50 0.713 / p95 0.839 ms | — | — |
| 缩略图 | p50 8.368 / max 8.653 ms | — | — |
| PNG 编码 / 解码 | 105.810 / 15.474 ms | — | — |
| RGBA→DIB / DIB→RGBA | 5.489 / 5.726 ms | — | — |
| 200 张 1920×1080 连拍入库 | **4,279.54 ms** | ≤8,000 ms | PASS |
| 其中清理 / 总计 | 150.28 / 4,429.82 ms | — | — |
| 资产占用 | 464.8 MB → **30.2 MB** | ≤32 MB 配额 | PASS |

与 §5.6（01:32 的 6,984.09 ms）并列保留：入库耗时差异来自机器负载，
**预算未调整**。同窗口还重跑了行动中心查询
（`actions_perf` p95 3.22 ms，预算 ≤60 ms；该用例首跑因夹具期望值算错失败，
失败记录保留，见 `docs/PERFORMANCE_TESTING.md` §8.1）。

### 5.12 第四轮复测（2026-10-30 22:00 → 23:50）

第四轮专项整改（隐私事务安全 / 图文粘贴 / 内存稳定性 / 发布门禁）的测试结果。
完整报告见 [12-fourth-round-acceptance.md](12-fourth-round-acceptance.md)。

#### 5.12.1 工程门禁（22:21:18 → 22:32:18，全部 exit 0）

| 命令 | 开始 | 结束 | Exit | 统计 |
|---|---|---|---|---|
| `cargo fmt --all -- --check` | 22:21:18 | 22:21:20 | 0 | — |
| `cargo clippy --all-targets --all-features` | 22:21:20 | 22:22:48 | 0 | 0 警告 |
| `cargo test --all-targets --no-fail-fast` | 22:22:48 | 22:25:39 | 0 | lib 449 passed / 0 failed / 3 ignored；全部二进制合计 450 passed / 0 failed / 19 ignored |
| `cargo test --lib clipboard::` | 22:25:39 | 22:25:42 | 0 | 89 passed / 0 failed / 0 ignored |
| `npx tsc --noEmit` | 22:25:42 | 22:25:48 | 0 | — |
| `npx vitest run` | 22:25:48 | 22:26:35 | 0 | 36 文件 / 260 测试通过 |
| `npm run build` | 22:26:35 | 22:26:46 | 0 | — |
| `cargo test --release --test clipboard_perf -- --ignored --nocapture` | 22:26:46 | 22:32:18 | 0 | 2 passed / 0 failed |

原始输出：`evidence/gate-*-20261030-2221.log`；汇总：`evidence/gates-fourth-round-20261030-2221.md`。
环境：`CARGO_TARGET_DIR=src-tauri/target-accept`（与并行会话的构建目录隔离）、
cargo 1.95.0 / rustc 1.95.0 / Node v22.22.3 / npm 10.9.8、Git HEAD `356bc44`。

#### 5.12.2 真实图文混合粘贴（P1-03，23:50:01）

隔离实例 + **真实 Windows 剪贴板** + 真实 Edge 目标页，release 二进制
（`src-tauri/target-accept/release/task-dock.exe`，23:42:45 构建，15,603,200 B）。

**52 PASS / 0 FAIL / 0 BLOCKED，overall = PASS。**
证据：`evidence/p1-03-mixed-paste-20261030-235050-76869ab9.json`（+ `-app.log`）。

| 断言组 | 结果 |
|---|---|
| 采集入库 4 项（图 3 + 文字 1） | PASS：`history_delta=4`、图片 240×160、`alphaMin=alphaMax=255`、`transparentPixels=0`、`opaquePixels=38400` |
| 目标 DOM 顺序 | PASS：`image → image → text → image` |
| 目标图片像素 | PASS：红 `(220,30,30,255)`、绿 `(30,180,60,255)`、蓝 `(30,60,220,255)`，三图 `visible=true` |
| 粘贴任务 | PASS：`completed`、`sent 4/4`、`remaining_items=[]`、`restored=true` |
| 剪贴板恢复 | PASS：15 次采样全部命中哨兵（序列号全程 `9039`），`left_on_pasted_item=0`、`our_text_left=[]` |
| 历史副作用 | PASS：`copy_count` 前后均为 1，历史条数不变 |
| 采集计数器对账 | PASS：`observed_events 10 = captured 5 + self_write_events 5`；`superseded 0`/`empty 0`/`dropped 0`/`merged 0`/`skipped 0`/`duplicates 0`/`failed 0` |
| 延迟 | `max_capture_latency_ms 6`、`max_process_latency_ms 28` |

**这一轮同时修掉了一个真实的产品缺陷**：整改前存在三条无计数、无日志的静默丢弃路径，
导致 `observed=6` / `captured=4` 的差额无法解释。修复内容见 `04-monitor-security.md`
的「事件处置与去重水位（第四轮整改）」。

#### 5.12.3 Windows 前台聚焦测试（P2-06）

`cargo test --lib navigation::router` → **10 passed / 0 failed / 0 ignored**
（真实交互桌面；两个聚焦测试均为 `ok`，不是 skip，也不是无条件跳过）。
证据：`evidence/p2-06-focus-tests-fourth-round-20261030.log`。
前轮的 ENVIRONMENT-BLOCKED 日志原样保留。

#### 5.12.4 第五轮长跑复跑（2026-10-30 23:53 → 10-31 01:35，当前源码 release）

针对「内存稳定性 NOT PROVEN」用当前源码构建的 release 副本（`task-dock-acc9.exe`，
15,603,200 B，`sha256=fb5e0eef…`）重跑，C 臂（UI+HTTP 负载 30 分钟）与 E 臂
（10 分钟负载 + 30 分钟空闲）均 `rc=0`、无实例中途退出：

| 臂 | 事件 | Private | 分段斜率 | 结论 |
|---|---|---|---|---|
| C（30 min 负载） | 36,070 收 / 15,665 提交 / 20,405 合并 / **0 丢弃**，DB +30.8 MB | 9.1→17.8 MB | 前 20 min +0.218 → 尾段 9.1 min +0.066 → 结束后 116 s **0.000** MB/min | 出现平台期 |
| E（10 min 负载 + 30 min 空闲） | 11,914 事件、55 条通知全部成功 | 11.9→18.9→19.3 MB | 负载 +0.542；空闲前 15 min +0.0028 → 其后 14.5 min −0.0275 MB/min | 空闲不增长 |

三臂归因（N1 通知开 / N2 通知关 / N3 空闲）：通知路径 **≈72.8 KB/条**（另有 ≈30 MB 的
toast/COM 固定开销），接入路径 **≈0.49 KB/事件增量**，`live_bytes` 基本不动
（`private_minus_live = 7.76 MB`）⇒ 分配器保留 / 原生内存，不是 Rust 堆泄漏。
完整数据与边界见 [../V05_FINAL_ACCEPTANCE.md](../V05_FINAL_ACCEPTANCE.md) §5.5、
`docs/performance/results/MEM-ATTRIBUTION-v05r5.json`。第五轮门禁复跑见
[10-remediation-acceptance.md](10-remediation-acceptance.md) §8.3。

### 5.13 剪贴板＋Agent 真实联合长跑（P1-05，2026-10-31 09:43 → 10:23）

> 完整数据与判定见 [12-fourth-round-acceptance.md](12-fourth-round-acceptance.md) §六。
> 本节只摘录可复核的数字与边界。

**为什么要复跑**：第一臂（01:12）的激励器文本写入 **344/344 全部因
`OpenClipboard` 被占用失败**（图片 57/57 成功），该臂不能作为“真实联合负载”证据；
修复激励器（失败计数 + 占用进程 + 每次校验）后用同一 release 副本复跑。

**结果（30 min 负载 + 10 min 静置，窗口最小化，GUI 另见 §5.13.2）**：

| 项 | 结果 |
|---|---|
| 真实剪贴板写入 | 文本 **600/600 verified**、图片 **60/60 verified**；`open_failures=0`；原剪贴板恢复成功 |
| Agent 负载 | **36,000/36,000** 成功；0 拒绝/解析/并发错误；管道 0 丢弃、0 提交失败；ingest p95 276.96 ms |
| 入库对账 | 库内 667 条 = 激励派生 655（595 文本 + 60 图片）+ 真实外部复制 12；日志 672 = 667 + 5 去重 |
| 图片完整性 | 60/60 入库 PNG 与激励器同 seed 重算字节**完全一致**（含 Alpha），0 缺失资产 |
| 5 条文本缺口 | 索引 110/227/228/229/233：最新状态语义下被后续写入覆盖；`dropped=0`、`store_failed=0`，不是静默丢弃 |
| 入库延迟 | 相对最快样本 p50 1.9 ms / p95 85.6 ms / max 3602 ms（尖峰与并行 clippy 时间窗重合） |
| DB/锁 | `database is locked` 0 条；db.read avg 1.36 ms、慢查询 17/10,418；写 p95 56.65 ms |
| 内存 | private 45.4→49.2 MB（+3.8）→ 尾段 +0.004 MB/min、post −0.062 MB/min；rust.live 1.34–1.65 MB 持平 |
| CPU | 主进程 mean 0.029%、p95 0.12%（最小化） |

**证据**：`docs/performance/results/DIAG-joint-clipboard-rerun-20261031-0943-*`、
`analysis-joint-clipboard-rerun-20261031-0943.json`、`phases-joint-clipboard-rerun-20261031-0943.json`、
`docs/clipboard/evidence/p1-05-rerun-20261031-0943/`。

#### 5.13.1 边界（不得省略）

1. 本次激励进程运行的是 09:45:08 之前的脚本版本（`started_at` 字段尚未加入），
   因此绝对写入时刻没有持久化；表中延迟是**相对最快样本**的分布。
2. 5/600 文本未入库，按“剪贴板只保留最新状态”的设计解释；该臂没有 `merged_events`
   计数器快照，计数器级证据由 §5.13.2 的短程 GUI 跑补足。
3. 30 分钟臂窗口最小化、不做 GUI 操作；GUI 交互与提醒链路在 §5.13.2 单独执行。
4. 并行会话的 clippy/Release 构建与本臂争用 CPU，延迟尖峰与 5 条覆盖都落在其时间窗内；
   如实记录，不把干扰归因成产品缺陷，也不隐藏。

#### 5.13.2 可见窗口短程 GUI 联合跑

> 待最终 Release 重建后执行并回填：真实抽屉/搜索/图片详情/返回/关闭、
> 真实提醒、真实历史清理、observed/captured/recorded/merged/dropped 计数器、
> UI 操作 p95 与截图延迟。

## 六、稳定性测试
| 项目 | 状态 |
|---|---|
| 单元/集成重复运行 | 完成（最终计数见 `11` §三：302 passed / 2 锁屏失败 / 11 ignored；fmt/clippy/tsc/vitest/build 全绿，2 例未跳过）；**第二轮复核 445 passed / 0 failed / 3 ignored（lib）** |
| 粘贴状态机竞态（注入假 IO） | 通过（paste 模块 16 例，覆盖取消/外部更新/目标关闭/焦点失败/恢复失败/重启） |
| 监听队列压力 | 通过（100/1000 事件，容量与丢弃断言） |
| 200 连拍 + 配额 | 通过（10-29：2.799 s；10-30 最终重跑：6.984 s；10-30 18:19 第二轮重跑：4.280 s，均低于 8 s；失败运行见 §五.10） |
| 真机验收重复运行 | 前轮 final13：46/46；第三方矩阵 5/5（历史证据） |
| 30 分钟空闲监听 CPU/内存 | **已完成**：场景 A 30 分钟采样（见 §五.7）；锁屏下无真实剪贴板事件 |
| 长时间截图循环（>1000 张） | 未执行 |
| 崩溃/断电恢复 | 仅单测层面覆盖（粘贴任务 interrupted、资产清理） |
| 并发 Agent 事件/任务更新 | **已完成（第四轮联合长跑）**：36,000/36,000 Agent 事件 + 600/600 文本、60/60 图片真实剪贴板写入，剪贴板侧真实入库 655/660（5 条文本被最新状态覆盖），见 §5.13 |
| 连续真实剪贴板采集 30 分钟（场景 B） | **已完成（第四轮复跑，09:43–10:23）**：0 次 OpenClipboard 失败、0 队列丢弃、60/60 图片字节一致；见 §5.13。锁屏期的 ENVIRONMENT BLOCKED 记录保留在 §七.4 |

## 七、未覆盖与环境阻塞（诚实清单）

1. **微信**：本机 Weixin 4.x 正在运行且为已登录的真实用户会话，向其窗口注入
   Ctrl+V 可能写入用户正在进行的聊天；无隔离实例，按安全原则不自动化，
   记为 **ENVIRONMENT BLOCKED / NOT VERIFIED**。
2. **Agent 类应用**：Trae CN 以隔离 profile 启动后停在登录/引导窗口（标题 `TRAE CN`），
   CLI `--goto` 无法进入编辑区，自动化输入无法确认落点，记为 **NOT VERIFIED**。
3. ~~**修复 Alpha 后的真实图文混合粘贴**~~：2026-10-29 16:36 起锁屏，2026-10-30 16:36 的
   解锁会话已补上 52/52 真机断言（§4.6）；**第四轮 23:50 在当前 release 二进制上再次复验，
   52 PASS / 0 FAIL / 0 BLOCKED**，像素级证据见 §5.12.2。该项**已解除**。
4. **场景 B 连续真实剪贴板采集 30 分钟**：锁屏期确实无法写入（`ERROR_ACCESS_DENIED=5`），
   当时记为未执行。**第四轮已在未锁屏桌面完成真实复跑**（09:43–10:23，600/600 文本 +
   60/60 图片写入，0 次 OpenClipboard 失败，0 队列丢弃），见 §5.13 与
   `docs/clipboard/12-fourth-round-acceptance.md` §六；首臂 01:12 的
   `OpenClipboard` 全失败证据原样保留在 `docs/performance/results/DIAG-fourth-round-joint-clipboard-20261031-011217-stimulus.json`。
5. **场景 A 的监听计数**：锁屏期 30 分钟空闲已完成但事件为 0。**第四轮联合长跑在真实
   事件节奏下补上了采集对账**（595/600 文本、60/60 图片、0 丢弃），见 §5.13。
6. **写入中途格式失败**：若 EmptyClipboard 后主格式写入失败，任务停止，
   但 `restore_if_own_content` 可能因内容不匹配选择 `KeepUserCopy`，原快照不保证恢复；
   未构造故障注入（`11` §2.5 #4）。
7. **ESLint 缺失**：仓库无 ESLint 配置文件，`npm run lint` 不存在；未以禁用规则
   的方式“通过”lint，而是如实记录该工程缺口。
8. **图片/文件粘贴到图形界面应用**：仅验证了记事本拒绝图片时如实报告（C12）；
   Word/微信/设计软件等未验证。
9. **WebView 多显示器/不同 DPI**：场景 D 已采帧率与抽屉操作，但多显示器/DPI 未验证。
10. **安装/卸载/签名**：未实测；产物未签名。第二轮重建的安装包（18:44）同样
    **只验证了打包成功**，未执行安装→升级→卸载。
11. **前端测试超时抖动**：早前并行重负载下 3 例任务面板测试曾超过默认 5 s；
    最终全量运行通过，未修改超时阈值掩盖问题。
12. ~~**长跑内存稳定性在最终二进制上未重跑**~~：第四轮已补齐——P1-04 三分段
    （预热/负载/负载尾 1/4）在第四轮 release 二进制（`task-dock-acc1.exe`，23:42:45）
    上完成 30 分钟采样与 60 分钟静置，负载尾段私有字节 **+0.004 MB/min**，
    见 `12-fourth-round-acceptance.md` §五；联合长跑（09:43–10:23，09:20 release
    二进制）负载尾段同样平缓，见 §5.13。**仍待补**的是全部整改与重建之后的最终
    二进制未再跑一次长跑（当前代码树受并行会话编辑影响，最终构建时间未定），
    届时需按同一脚本复测才能把该行改为完全闭环；在此之前不宣称“最终二进制无泄漏”。

## 八、打包结果

- Release 构建：`npm run tauri build` 通过，release 编译 8m26s（codegen-units=1 + LTO），
  产物时间 2026-10-30 01:44，晚于全部源码修改。
- NSIS：`Task Dock_0.5.0_x64-setup.exe` 4.01 MiB（4,201,417 B）。
- MSI：`Task Dock_0.5.0_x64_en-US.msi` 6.15 MiB（6,447,104 B）。
- 产物路径：`src-tauri/target/release/bundle/{nsis,msi}/`。
- 冒烟：最终 `task-dock.exe` + 隔离数据目录启动，`/api/v1/health` 200，
  `clipboard_status.monitoring=true`，1,250 条历史可读（`evidence/final-release-smoke-20261030.json`）。
- 产物未签名；未做安装/卸载与签名验证。与早期 `target-accept` 产物（3.92/5.39 MiB）
  大小不同，来源是不同构建目录/打包时间，不作为回归结论。

**第二轮重建（2026-10-30 18:44，当前源码）**：整改收尾后用同一命令重新打包，
release 编译 4m03s，`TAURI_BUILD_EXIT=0`，日志 `evidence/bundle-build-20261030-1841.log`：

| 产物 | 大小 | 时间 |
|---|---|---|
| `task-dock.exe` | 15,531,520 B | 18:44 |
| `Task Dock_0.5.0_x64-setup.exe`（NSIS） | 4,493,352 B（4.29 MiB） | 18:44 |
| `Task Dock_0.5.0_x64_en-US.msi` | 6,840,320 B（6.52 MiB） | 18:44 |

与 §八 上方的 01:44 产物并列保留（大小不同源于代码与构建时间差异）。
**安装→升级→卸载仍未执行**（会改动用户机器），记为 **NOT VERIFIED**；
产物未签名这一点不变。

## 九、结论

- 自动化层：fmt / clippy（0 警告）/ Rust 与前端测试 / tsc / vite build /
  release 性能预算的最终计数见 §二 与 `11` §三；队列与粘贴竞态有针对性测试。
- 真机层：前轮验收 46/46、第三方矩阵 5/5；本轮完成场景 C/D、30 分钟空闲（A）与
  P0 配置损坏真实运行；**修复 Alpha 后的图文混合粘贴、场景 B 因锁屏未验证**。
- 第二轮复核（18:08–18:56，当前源码）：`cargo fmt` / `clippy -D warnings` /
  `cargo test --all --no-fail-fast`（lib 445 passed / 0 failed / 3 ignored）/
  `npx tsc --noEmit` / `npm run build` / `npx vitest run`（23 文件 / 166 用例）/
  `npm run tauri build` 全绿；`clipboard_perf` 2/2、`actions_perf` p95 3.22 ms、
  真实用户库 v11→v13 升级通过。详见
  [../V05_FINAL_ACCEPTANCE.md](../V05_FINAL_ACCEPTANCE.md)。
- 微信与 Agent 应用保持 `ENVIRONMENT BLOCKED / NOT VERIFIED`，未用单元测试替代。
- 总体判定 **CONDITIONAL PASS**：不得把本文的历史 PASS 或部分数据外推为
  “所有应用/所有场景已验证”。最终依据见 `11-final-release-acceptance.md`。

## 十、2026-11-02 剪贴板专项（自动标题 / 跨来源分组 / 多选批量复制与逐项粘贴）

本次专项在当前工作树（含并行未提交改动）上实施，只补自动化验证，不重复历史真机项：

- 变更范围：迁移 v15（`title` / `title_source`）、`engine::make_title` 与
  `truncate_chars`（省略号计入 30 字符上限）、`decide_group` 跨来源规则
  （8 参数）、`clipboard_copy_items_rich` / `clipboard_copy_items_files` /
  `clipboard_rename_item` / `clipboard_paste_items` 四个命令及前端接入。
- 自动化结果（命令 + 工作目录 + 退出码见
  `tmp/acceptance/clipboard-improvement/report.md`）：
  - `cargo test clipboard::`（`src-tauri/`）：**102 passed / 0 failed**，含新增
    `engine::auto_title_rules_per_kind`、`store::cross_source_text_does_not_join_screenshot_group`、
    `store::auto_title_lifecycle_and_search`、`store::auto_title_covers_image_and_files_kinds`；
  - 全量 `cargo test`（`src-tauri/`）：504 passed / 1 failed（`actions::ack_never_changes_agent_state…`，
    并行任务域既有失败，非本次改动）/ 3 ignored；
  - `npx tsc -b`：通过（exit 0）；`npx vitest run` 剪贴板相关 6 文件 46 用例通过。
- **真机验收未执行**（本机为用户正在使用的真实会话，涉及真实系统剪贴板与目标窗口）：
  自动标题实际显示效果、多选批量复制到第三方应用、无分组逐项粘贴的真实接收，
  均需后续在可控环境验证；本次不得以单测替代宣称通过。
- 性能边界：标题生成在 worker 线程 `record_capture` 内完成（限制输入长度，
  无长期后台负担）；四个新命令均为既有路径复用，未新增线程、依赖或定时器。

## 十一、2026-11-02 UI 精简与删除反馈复核（7.3 / 7.4）

本轮只复核「分组详情整理模式」与「删除离场反馈」两块 UI，并补齐清空历史竞态的单测。
证据与产品报告同在 `tmp/acceptance/clipboard-improvement/`（未覆盖任何历史证据文件）。

### 11.1 自动化

| 命令 | 工作目录 | 结果 | 证据 |
|---|---|---|---|
| `cargo test --quiet clipboard` | `src-tauri/` | 127 passed / 0 failed / 0 ignored（exit 0） | `cargo-clipboard-final-1102.txt` |
| `npx tsc -b` | 仓库根 | exit 0 | `final-frontend-1102.txt` |
| `npx vitest run` | 仓库根 | 569 passed / 0 failed（52 文件，exit 0） | `final-frontend-1102.txt` |
| `npx vite build` | 仓库根 | ✓ built in 2.72 s | — |

新增用例 `platform::stale_capture_epoch_blocks_work_queued_before_clear`：把「入队盖章 →
清空推进代数 → worker 出队核对」抽成纯函数 `epoch_is_stale` 并覆盖三种情形
（同代放行 / 清空前的在途事件与内容被拦 / 清空后的新复制照常入库）。
此前该竞态只有实现没有单测。

本轮中途曾观测到 `ClipboardPanel.test.tsx > 删掉当前聚焦的卡片后…` 失败
（`expected undefined to be 'ci1'`）与浏览器走查中「鼠标路径删除后焦点落在 `<body>`」
一致，均指向 `captureFocusAnchor` 在确认框打开后才读取 `document.activeElement`。
该区域由并行会话在同一次共享工作树内补齐（新增 `confirmAnchor`），
最终两条验证均已通过；本文件不重复记录中间态证据。

### 11.2 真机（只读）

| 命令 | 结果 | 证据 |
|---|---|---|
| `TD_REAL_CLIPBOARD=1 cargo test --test real_clipboard -- --ignored --exact real_visible_targets_exclude_self_and_pass_precheck --nocapture` | 1 passed（可见目标 9 个，本进程已排除，预检通过 9，提权拒绝 0） | `cargo-real-targets-env-1102.txt` |

另两个真机用例会写本机剪贴板（`real_clipboard_roundtrip_…`、`real_failed_write_restores_previous_content`），
**本轮未执行**：本机 `task-dock.exe`（PID 101100）处于监听状态，写入会被真实实例采集进用户库，
违反“独立数据目录 + 可识别测试内容”的隔离要求。需要关闭应用或授权暂停监听后另行执行。

### 11.3 浏览器走查（`scripts/serve-preview.mjs` 夹具 + Playwright Chromium）

- 入口：`PREVIEW_PORT=4179 node scripts/serve-preview.mjs`，脚本
  `tmp/acceptance/clipboard-improvement/visual-walkthrough.mjs`，结果 `visual-result.json`，
  截图 `shots/01–12*.png`。
- 覆盖：深浅主题列表层级、320px 窄窗、毛玻璃材质、删除确认/执行中/离场/失败四态、
  离场逐帧高度（81 → 60.6 → 15.8，11 帧单调收窄）、`prefers-reduced-motion`、
  分组卡片单行元信息、组内缩略图与标题优先、整理模式开关、多选操作栏遮挡与动作齐全、
  复制后滚动位置。
- 结果：**55 / 55 通过，控制台 0 错误**。删除后的焦点接管（含经确认框的鼠标路径）
  在并行会话补齐 `confirmAnchor` 后一并通过。
- 夹具修正：`clipboard_view` 改为每次返回快照。原先直接回传夹具数组引用，
  删除类 mock 就地 `splice` 会改写 store 里的 view，使「离场原位钉住」在走查前失效（假阴性）。

### 11.4 真机写入型测试的恢复守卫（2026-11-03）

`src-tauri/tests/real_clipboard.rs` 的写入型用例此前只在正常结束路径显式恢复剪贴板，
中途 `panic!` 会把测试内容留在用户剪贴板。现已引入 `ClipboardRestoreGuard`（RAII）：

- **启动门槛**：仍先调用 `restorable_snapshot()`；读不出可写回载荷（超大图、私有格式）
  一律拒绝启动。**原剪贴板为空**时也拒绝启动——平台层没有「恢复为空」的写回能力，
  写入后无法还原成空，只能避免留下测试内容。
- **恢复依据**：每次成功写入后登记 `last_written`；正常结束走 `finish`，panic 栈展开时
  `Drop` 再尽力恢复一次。恢复仍调用平台层 `restore_if_own_content`（同一把剪贴板访问锁内
  **先比较内容再写回**），没有新建第二套写入保护体系。
- **用户接管**：测试期间用户/其他程序改写剪贴板时，内容不等于 `last_written`，恢复返回
  `KeepUserCopy`，保留用户新内容，不覆盖。
- **不重复恢复**：守卫在进入恢复前先置 `restored = true`，正常结束与 `Drop` 合计最多一次；
  恢复失败只记录诊断，不重试、不启后台线程。
- **不二次 panic**：`Drop` 内对恢复后端调用 `catch_unwind`；日志只输出结果/字节数/错误，
  **不输出剪贴板正文、图片或文件路径**。
- **能力边界（不宣称 100% 可靠）**：进程被强杀、`panic=abort`、系统崩溃或断电时 `Drop`
  不会执行，剪贴板可能保留测试内容。写入型真机测试只允许在**明确授权、可接受短暂占用
  剪贴板**的隔离验收环境运行；不得在用户正在使用的桌面上无授权执行。
- **验证方式**：panic/失败注入无法在不污染真实剪贴板的前提下复现，因此新增 6 个
  **模拟剪贴板 + 可控失败注入**的用例（正常恢复、栈展开恢复、用户接管、恢复失败、
  恢复后端自身 panic、空快照），不触碰真实剪贴板；真实写入型用例本轮**未执行**。

### 11.5 保存/路径检查异步化与失败清理竞态（2026-11-03 晚间收尾）

范围：`clipboard_save_image` / `clipboard_path_status` 异步化、写入失败清理的文件身份竞态、
`ImageLightbox.onSaveAs` 异常边界、覆盖授权注释对齐。**未新增剪贴板功能、未重设计 UI、
未改图片复制与监听逻辑。** 本轮结论为**部分通过**：自动化全部通过，真机 UI 与慢路径未执行。

#### 11.5.1 线程模型变更

| 命令 | 变更 | 保留的契约 |
|---|---|---|
| `clipboard_save_image` | `async`；缓存 PNG 读取 + 写盘整体进入 `tauri::async_runtime::spawn_blocking`；`JoinError` 转为明确 `Io` 错误；进程级 `SaveSlot` 上限 2，超出返回可重试 `Overloaded` | `overwrite=false` 仍 `create_new` 排他创建；`overwrite=true` 仍临时文件 + `rename` 安全替换；PNG 字节保真；路径校验与权限错误映射不变 |
| `clipboard_path_status` | `async`；整批 `metadata` 放进**一个** `spawn_blocking` 任务（不按路径开线程） | 命令名不变；成功返回结构仍为 `Vec<String>`（`ok/missing/inaccessible`）；仍截断到 200 条；后台任务异常结束以 Promise 拒绝传播，前端 fail-closed（不得把路径当成存在） |

等待 I/O 期间不持有 DB 锁或长生命周期 Mutex；保存并发有上限且不排队。`ClipboardItemDetail`
既有的 `alive` 清理与 `[item, pathsKey]` 依赖未改动，旧请求结果不会覆盖新条目状态。

#### 11.5.2 失败清理：句柄级删除

`src-tauri/src/clipboard/export.rs` 的 `create_new(true)` 设计保持不变。Windows 创建文件时
额外申请 `DELETE` 权限；失败清理调用 `SetFileInformationByHandle(FileDispositionInfo)`
做**句柄级 delete-on-close**，删除对象由文件对象而非路径标识，避免「句柄释放 → 按路径删除」
之间路径被其他进程替换时误删对方新文件。句柄级标记失败时**不回退按路径删除**，只记录告警，
原始写入错误照常返回。`write_replace` 的临时文件长度校验移到句柄关闭前，失败同样走句柄级清理。
不新增文件锁系统。

新增真实文件系统用例（Windows 上实际运行）：

| 用例 | 覆盖点 |
|---|---|
| `failure_cleanup_removes_file_created_by_this_call` | 失败后清理本次创建的文件 |
| `failure_cleanup_deletes_by_handle_not_by_path`（`#[cfg(windows)]`） | 句柄打开期间路径被替换：只删本次文件，替换文件字节不变 |
| `failure_cleanup_without_delete_access_keeps_file_intact`（`#[cfg(windows)]`） | 无 `DELETE` 权限时清理失败不误删，文件哈希不变 |
| 既有用例 | 新建成功、已存在拒绝覆盖、并发创建、原文件字节/哈希不变、无 `.tmp` 残留 |

#### 11.5.3 自动化结果（实际执行）

| 命令 | 工作目录 | 结果 | 证据 |
|---|---|---|---|
| `cargo test --lib clipboard::export` | `src-tauri/` | exit 0；**15 passed / 0 failed** | `tmp/acceptance/clipboard-multitype/cargo-test-lib-full-20261103.log` |
| `cargo test --lib clipboard::` | `src-tauri/` | exit 0；**134 passed / 0 failed** | 同上 |
| `cargo test --lib`（全量） | `src-tauri/` | exit 101；673 passed / **8 failed（均非剪贴板模块，见验收报告 §15.6）** / 3 ignored | 同上 |
| `cargo check --lib` | `src-tauri/` | exit 0 | 终端输出 |
| `npx vitest run`（灯箱保存/灯箱/详情 3 文件） | 仓库根 | exit 0；**49 passed**（另存为 18 条，含新增对话框 rejection 与卸载用例） | 终端输出 |
| `npx vitest run src/components/clipboard/` | 仓库根 | **141 passed**（首次 3 个动画/面板用例在并行负载下超时，原样复跑通过） | 终端输出 |
| `npm run build`（`tsc --noEmit && vite build`） | 仓库根 | exit 0 | 终端输出 |

`ImageLightbox.tsx` 新增：`save()` 独立 try/catch（对话框创建/调用失败 → 错误 Toast、
不查状态、不写盘、`finally` 恢复 `busy`/`savingRef`）；`mountedRef` 防止卸载后更新状态。
新增 2 条前端用例：对话框 Promise rejection（断言不查状态、不写盘、按钮恢复可再次点击）、
保存中途卸载（无未处理 rejection，结果仍以 Toast 反馈）。

#### 11.5.4 性能数据（Rust 层探针，非 WebView2）

条件：Windows 11、debug 构建、共享 `src-tauri/target` 增量缓存、本机磁盘、机器同时有并行会话
构建与运行实例（非空闲）；样本为真实截图 PNG 488,434 B 与追加随机尾部构造的 62,914,560 B
（约 60MB，接近 `MAX_IMAGE_BYTES`）；每组 3 次；证据
`tmp/acceptance/clipboard-multitype/perf-probe-20261103.txt`。

| 指标 | 结果 |
|---|---|
| 同步基线（读 + write_all + flush + sync_all）正常 PNG | min 1.4 / median 1.5 / max 1.8 ms |
| 同步基线 60MB PNG | min 58.5 / median 60.6 / max 61.4 ms |
| 同一工作放入 `spawn_blocking` | 阻塞 60.3 ms；异步 wall 60.4 ms |
| 5ms ticker 最大间隔（空载 / 保存中） | 16.4 ms / **15.9 ms，未因 60ms 阻塞任务停摆** |
| 两个 60MB 保存并发（独立目标） | wall 73.3 ms，两者均成功 |
| 运行时关闭回收 | 0.2 ms |

**解释限制**：该数据只证明阻塞 I/O 已移出异步运行时且并发/回收有界，**不能等同于主窗口
UI 线程可交互**；后者本轮未真机测量。

#### 11.5.5 未验证与环境阻塞

1. **真机 UI 性能与完整保存链路**：本机存在运行中的 `task-dock.exe`（占用 debug 二进制），
   无法原地重建；Tauri 单实例插件会拦截同标识隔离实例。未终止该进程，因此保存期间主窗口
   可交互、原生保存对话框异常、覆盖/拒绝覆盖真机路径均**未执行**（ENVIRONMENT BLOCKED）。
2. **只读/占用/权限异常真机用例**：未执行；由 Rust 用例
   `save_overwrite_readonly_target_fails_without_damage`、
   `failure_cleanup_without_delete_access_keeps_file_intact` 与前端“保存失败展示后端错误”覆盖。
3. **慢路径 / 网络共享 / 断连盘**：未测（环境不具备，不制造系统级长期阻塞）。异步结构保证
   整批路径检查只占一个后台任务。
4. **构建排队**：每次构建前统计 `cargo/rustc/link.exe` 与 node 构建进程，≥3 时轮询；实际遇到
   并行会话构建占用与一次探针执行时短暂达到 5 个进程，未终止任何非本任务进程。

### 11.6 真机写入型测试的 effective 登记与快照完整性（2026-11-04）

`src-tauri/tests/real_clipboard.rs` 的写入型真机测试强化了两处数据安全；生产剪贴板链路
（读取、采集、粘贴、`snapshot`、`WriteOutcome`）未改。

#### 11.6.1 登记实际写入形态

平台允许辅助格式降级（HTML、DIB、文件纯文本）与文件路径有效性过滤，
`WriteOutcome::Written` 的 `effective` 才是剪贴板上真实存在的形态。测试工具现在：

- 解构 `{ seq, effective, degraded }`，写入成功后的第一条语句执行
  `note_written(&effective)`，登记先于任何可能 panic 的断言；
- 即时比较、有限次复核、失败诊断与后续回读一律使用 `effective`；
- `degraded` 非空时明确列出未写入格式；写入型真机用例要求完整格式保真，
  因此判测试失败，但守卫已登记实际内容，Drop 仍按内容归属尝试恢复；
- `requested != effective`（文件路径被过滤）同样在登记后判失败。

#### 11.6.2 模拟接管与真实接管

- 测试自己模拟的「用户中途复制」通过 `write_simulated_takeover()` 写入，
  成功后立即登记；panic 时内容归属匹配，恢复用户原内容。
- 真实外部程序写入不经过本进程、不登记；panic 时内容归属不匹配，
  `restore_if_own_content` 返回 `KeepUserCopy`，保留用户新内容。
- 守卫正常结束与 Drop 合计最多恢复一次；恢复失败如实记录，不重试、不伪报成功。

#### 11.6.3 快照完整性

新增只读 `platform::SnapshotProbe` / `snapshot_probe()`：同一次 `OpenClipboard`
内枚举格式并读取快照。写入型真机测试启动前由 `probe_refusal()` 判定：

- 允许：显式写回的 `CF_UNICODETEXT`、`CF_DIB`、`CF_HDROP`、`HTML Format`、`PNG`，
  Windows 系统合成格式 `CF_TEXT`、`CF_OEMTEXT`、`CF_BITMAP`、`CF_PALETTE`、`CF_DIBV5`，
  以及仅承载语言标记的 `CF_LOCALE`（不保证逐字节还原，但不影响正文）；
- 拒绝：RTF、Office 私有格式、第三方注册格式、元文件、TIFF/RIFF/WAVE 等，
  以及取不到快照（剪贴板被占用）的情况。

注意：`EnumClipboardFormats` 会把系统可转换格式一并枚举，`CF_DIBV5` 可由
`CF_DIB`/`CF_BITMAP` 自动合成，因此 DIBV5 不能作为「存在额外私有数据」的证据。
完整性保证的边界是「受支持的载荷形态 + 系统合成格式」，不是剪贴板所有字节格式；
含私有格式时拒绝启动，不做降级恢复。

#### 11.6.4 验证（2026-11-04）

工作目录 `src-tauri/`，最终在真实工作树执行：

| 命令 | 结果 |
|---|---|
| `cargo test --test real_clipboard` | 14 passed / 0 failed / 3 ignored（模拟剪贴板；真实写入型用例未执行） |
| `cargo test --lib clipboard` | 159 passed / 0 failed |
| `cargo test --test clipboard_source_snapshot` | 3 passed / 0 failed |
| `cargo check --lib` | EXIT 0 |

新增受控用例 8 个（完整写入后立即 panic、HTML/DIB 降级、文件路径过滤、
模拟接管立即登记、真实外部接管保留、恢复失败不重试、快照拒绝）与 1 个平台层
格式分类单测。验证期间并行会话的 `hotkeys/store.rs` 曾处于未闭合中间态、工作树编译
一度被阻塞；先用「HEAD + 本轮两个文件」的隔离导出树验证通过，待该会话恢复后已在
真实工作树复跑同一组命令并通过。该文件不属于本任务，未修改。
真实写入型 `#[ignore]` 用例与 Windows 真实应用来源识别仍未执行。
