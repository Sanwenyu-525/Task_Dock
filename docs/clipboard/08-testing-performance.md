# 08 · 测试、兼容性与性能

> 测试日期：2026-10-29 · 应用版本 0.5.0 · 本文为 P0/P1/P2 整改后的复测记录
> 原则：自动化结果与真机结果分开记录；**未执行的验收不写成通过**。
> 结果原始文件：`docs/performance/results/CLIP-20261029-080326.json`（最新）
> 及同目录早期 CLIP 记录（00:26 / 00:27）。

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

## 二、自动化检查结果（2026-10-29 最终复测）

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
| `src/components/clipboard/ClipboardDrawer.test.tsx` | 3 例：监听中 + 80/100 加载更多只追加；监听未启动 vs 暂停；错误 + 重试 |
| `src/components/clipboard/AgentExportPanel.test.tsx` | 2 例：能力矩阵文案（直接发送不支持/文件导入未验证/桌面粘贴可手动/本地导出可用）；本地导出参数与“未发送”提示 |
| `src/store/useClipboardStore.test.ts` | 4 例（原有）：筛选清空多选、刷新剔除失效选中、追加分页、加载失败 |

本次全量运行未出现此前的 5 s 超时；早前在 CPU 满载并行编译时出现过 3 例任务面板超时，
属于测试阈值而非功能回归，未通过修改阈值掩盖。

### 2.3 构建与打包

| 项目 | 结果 |
|---|---|
| `npm run build` | 通过（459.80 kB JS / 67.70 kB CSS） |
| `npx tauri build`（release） | 通过，4m49s；NSIS 3.98 MiB + MSI 6.11 MiB（产物时间 10:16，晚于最终 UI 修复） |
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
2026-10-29 在未锁屏桌面运行 **46/46 PASS**。

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
| 20 | 任务/Agent 原有功能正常 | 244 Rust + 109 前端 | **PASS**：H2 任务列表与快速添加正常 |
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
- **未测量**：WebView2 渲染帧率、空闲 CPU、常驻内存、真实硬件 30 分钟长跑、
  大分组滚动、抽屉快速开关、并发 Agent 事件/任务更新、剪贴板监听对前台应用的影响。
  上述项目需要可交互桌面与性能计数器，本次未执行，不得用上表数字外推。
- 1000 条文本历史（+1 图）的列表查询已由 §5.1 覆盖（p95 2.659 ms）；
  “>1000”未覆盖的是连续截图数量与大分组滚动，不是历史条数本身。

## 六、稳定性测试

| 项目 | 状态 |
|---|---|
| 单元/集成重复运行 | 通过（244 例；fmt/clippy/tsc/vitest/build 全绿） |
| 粘贴状态机竞态（注入假 IO） | 通过（paste 模块 16 例，覆盖取消/外部更新/目标关闭/焦点失败/恢复失败/重启） |
| 监听队列压力 | 通过（100/1000 事件，容量与丢弃计数断言） |
| 200 连拍 + 配额 | 通过（release 实测） |
| 真机验收重复运行 | 通过（验收脚本 final13：46/46；第三方矩阵 5/5） |
| 30 分钟空闲监听 CPU/内存 | 未执行（需长时挂机与性能计数器） |
| 长时间截图循环（>1000 张） | 未执行 |
| 崩溃/断电恢复 | 仅单测层面覆盖（粘贴任务 interrupted、资产清理） |
| 并发 Agent 事件/任务更新 | 未做剪贴板与 Agent 的联合真机压测 |

## 七、未覆盖与环境阻塞（诚实清单）

1. **微信**：本机 Weixin 4.x 正在运行且为已登录的真实用户会话，向其窗口注入
   Ctrl+V 可能写入用户正在进行的聊天；无隔离实例，按安全原则不自动化，
   记为 **ENVIRONMENT BLOCKED / NOT VERIFIED**。
2. **Agent 类应用**：Trae CN 以隔离 profile 启动后停在登录/引导窗口（标题 `TRAE CN`），
   CLI `--goto` 无法进入编辑区，自动化输入无法确认落点，记为 **NOT VERIFIED**。
3. **ESLint 缺失**：仓库无 ESLint 配置文件，`npm run lint` 不存在；未以禁用规则
   的方式“通过”lint，而是如实记录该工程缺口。
4. **图片/文件粘贴到图形界面应用**：仅验证了记事本拒绝图片时如实报告（C12）；
   Word/微信/设计软件等未验证。
5. **UI 帧率/空闲资源/长跑**：见 §五.5；WebView2 渲染帧率、常驻内存、
   30 分钟以上挂机、多显示器/不同 DPI 均未测量。
6. **真实监听计数**：`clipboard_status.monitor` 已暴露 observed/captured/dropped/latency，
   本次真机验收未单独采样这些计数（只验证了采集结果与暂停/停用行为）。
7. **安装/卸载/签名**：未实测；产物未签名。
8. **前端测试超时抖动**：早前并行重负载下 3 例任务面板测试曾超过默认 5 s；
   本次全量运行通过，未修改超时阈值掩盖问题。

## 八、打包结果

- Release 构建：`npx tauri build` 通过，4m49s（release profile：codegen-units=1 + LTO），
  产物时间 10:16，晚于最终 UI 修复（09:40/10:02）。
- NSIS：`Task Dock_0.5.0_x64-setup.exe` 3.98 MiB。
- MSI：`Task Dock_0.5.0_x64_en-US.msi` 6.11 MiB。
- 产物路径：`src-tauri/target/release/bundle/{nsis,msi}/`。
- 产物未签名；未做安装/卸载与签名验证。与早期 `target-accept` 产物（3.92/5.39 MiB）
  大小不同，来源是不同构建目录/打包时间，不作为回归结论。

## 九、结论

- 自动化层：fmt / clippy（0 警告）/ 244 Rust / 109 前端 / tsc / vite build 全部通过；
  release 性能预算 2/2 通过；队列与粘贴竞态有针对性测试。
- 真机层：验收脚本 46/46、第三方矩阵 5/5 通过；微信与 Agent 应用如实记录为
  `ENVIRONMENT BLOCKED / NOT VERIFIED`，未用单元测试替代。
- UI 帧率、空闲资源、长时挂机、安装/卸载未验证；发布判定见 `09` / `10` 文档。
