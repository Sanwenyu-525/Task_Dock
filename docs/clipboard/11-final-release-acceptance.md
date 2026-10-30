# 11 · v0.5 最终发布验收

> 日期：2026-10-30 · 版本：0.5.0 · 平台：Windows 11 x64 · 20 逻辑 CPU
> 原则：**未执行的验收不写成通过；单元测试不替代真实桌面验收；文档与最终源码一致。**
> 本文只记录本机可复现的最终结果；历史证据（2026-10-29 上午的 46/46 与 5/5）
> 单独标注为“前轮证据”，不与本轮结果混算。
>
> **2026-10-30 后续复跑补充**：同一工作树在 09:44 交互会话为 382 passed / 0 failed / 13 ignored；
> 控制台闪窗修复后 10:0x 复跑 lib 为 380 passed / 2 failed / 3 ignored，lib 失败后 cargo 中止，
> 集成另行执行 1 passed / 10 ignored，合并 381 passed / 2 failed / 13 ignored；2 例仍为导航前台
> 聚焦测试被 Windows 前台锁拒绝（环境性，断言未改）。本表 §三 的 302/2/11 是更早的锁屏会话结果，
> 三次结果均保留，不互相覆盖。最新汇总见 `docs/PERFORMANCE_FINAL_ACCEPTANCE.md`。
>
> **2026-10-30 16:41 真机解锁后复跑（追加，不改写上列任何历史测量）**：工作站已解锁，
> §4.3 的「修复后 GUI 复验 = ENVIRONMENT BLOCKED / NOT VERIFIED」与 §八 D 项的
> 「修复后图文混合未复验」**已被真实桌面证据解除**：16:41→16:42 一轮 **52 条断言全 PASS /
> 0 FAIL / 0 BLOCKED**（release 二进制 16:20 构建），详见 §4.6 与
> `docs/V05_FINAL_ACCEPTANCE.md`。本文的锁屏期数值（302/2/11、vitest 133、场景 B 阻塞等）
> 全部保持原样作为历史记录。

## 一、结论摘要

| 维度 | 本轮结果 |
|---|---|
| P0 隐私配置 fail-closed | **已修复**：键缺失/JSON 损坏/类型/范围/数据库读取失败均停止自动采集；真实隔离实例复现 + 单元测试 |
| P1 恢复自写隔离 | **已修复**：所有自写在同一访问锁内登记序列号；恢复前内容校验；失败不登记；单元测试 |
| P1 图片 Alpha 缺陷 | **已修复**：全透明 32bpp DIB 合成 PNG 归一化为不透明；3 个单元测试；**修复后真实目标复验被锁屏阻塞** |
| P1 Agent HTTP 接入 | **已修复**：hyper 1.x `header_read_timeout` 缺少 timer 导致每个连接 panic；新增回归测试 |
| 自动化门禁 | **通过（2 例环境例外）**：fmt/clippy/tsc/build/vitest 133 全过；Rust 302 passed / 2 锁屏前台聚焦失败 / 11 ignored；详见 §三 |
| release 性能预算 | **PASS**：列表 p95 1.96–2.36 ms（≤120）、200 张 1080p 入库 6,984 ms（≤8,000）、配额 30.21 MB（≤32）、脚本 `pass=true` |
| 场景 A 30 分钟空闲 | **已完成**：CPU 平均 0.324% / 峰值 0.594%，WS 546–644 MB，线程 204–225，句柄 10,074–10,470；锁屏下事件计数为 0 |
| 场景 C Agent 并发 | 两轮各 60 s：33,649 / 41,004 次事件请求全部 200，0 网络失败，0 过载拒绝；1 次解析拒绝来自测试脚本的终端编码问题（非应用缺陷）；CPU 峰值 2.72% |
| 场景 D 1000+ 历史/大分组/抽屉 | release 实测见 §5.4；后端列表 p95 ≤ 52.6 ms |
| 真实图文混合粘贴 | 修复前：顺序正确但三张图 Alpha 全 0（不可见）；修复后 GUI 复验 **ENVIRONMENT BLOCKED / NOT VERIFIED** |
| 第三方应用矩阵 | 前轮 5/5 PASS；本轮微信 = ENVIRONMENT BLOCKED，Agent = NOT VERIFIED |
| 安装包 | **已重建（01:44）**：NSIS 4.01 MiB / MSI 6.15 MiB，版本 0.5.0；release 启动健康检查 200、历史 1,250 条可读 |
| **总体判定** | **CONDITIONAL PASS** |

**为什么是 CONDITIONAL PASS，而不是 PASS 或 FAIL：**

- 代码层没有已知的未解决 P0；隐私配置、自写隔离、Alpha、HTTP 连接均有修复和测试；
- 除 2 例锁屏下无法获得前台焦点的导航测试外，全部可执行工程门禁与性能预算通过；
  这 2 例失败未跳过、未改断言，计入环境例外；
- 但用户明确规定的发布阻断条件之一是“真实图文混合粘贴在可测试目标上验证成功”。
  修复 Alpha 缺陷后，工作站从 2026-10-29 16:36 起持续锁屏
  （`WTSInfoEx.SessionFlags=0`、`LogonUI` 存在、剪贴板写入 `ERROR_ACCESS_DENIED=5`），
  无法在不伪造证据的前提下完成 GUI 复验；修复前的真实记录只证明“顺序正确”，
  不证明“图片可见”。因此不得判定完整 PASS。
- 微信与 Agent 类应用仍按原约束保持 `ENVIRONMENT BLOCKED / NOT VERIFIED`。

> **上列四条是 2026-10-30 01:xx 锁屏会话的判定，原样保留。** 其中「真实图文混合粘贴」这一条
> 阻断项已在同日 16:41 的解锁会话中以 52/52 真机断言解除（§4.6）；总体判定仍是 CONDITIONAL PASS，
> 但条件已换成别的项目（安装包与升级迁移、目标应用矩阵、内存稳定性），见 `docs/V05_FINAL_ACCEPTANCE.md`。

## 二、源码审计与修复

### 2.1 P0 隐私配置 fail-closed（已修复）

**原风险**：`clipboard_enabled` 等设置反序列化失败时若回退到默认值（true），
应用会继续自动记录，属于隐私配置 fail-open。

**实现**（`src-tauri/src/db/mod.rs`）：

- `ClipboardConfigErrorKind { Json, Type, Range, Database }` 与
  `ClipboardConfigError { kind, keys }`（`:1115`、`:1124`）；错误信息只含键名，不含正文；
- `Settings::load_clipboard`（`:1407`）逐键解析；失败时 `error=Some(...)`、
  且 `capture_allowed()` 为 false（`:1154`–`:1160`）；
- `clipboard_status` 在异常时返回 `enabled=false、paused=true、captureAllowed=false、
  configError{kind,keys,message}`（`src-tauri/src/commands/clipboard.rs:543`）；
- 采集线程与工作线程都只调用 `capture_allowed()`；异常时跳过采集并限频记录
  （`platform.rs:310`、`:329`）；
- `Settings::load_display`（`:1415`）仍返回可展示的设置，损坏键使用安全展示值，
  **任务/Agent 设置不受影响**；
- 显式修复 `clipboard_repair_config`（`commands/settings.rs:235`）：
  只重写无法解析的键，原始值合并备份到 `clipboard_config_corrupt_backup`（`:1457` 起）；
  `resume=false` 修复后保持暂停，`resume=true` 才重新启用自动记录；
- 数据库本身不可读时 `repair` 直接失败，不写入（`:2092` 测试）。

**自动化证据**：

- `clipboard_corrupt_json_fails_closed_and_keeps_unrelated_settings`
- `clipboard_config_never_enables_after_user_disabled`
- `clipboard_repair_backs_up_raw_values_and_requires_explicit_resume`
- `clipboard_repair_does_not_write_when_database_broken`
- 前端 `ClipboardDrawer.test.tsx`：损坏时显示“配置异常，自动记录已暂停”，
  不显示“监听中”，alert 含键名与“监听线程仍在运行”，按钮跳转设置页。

**真实运行证据（本轮新增）**：使用独立数据目录副本，将 `clipboard_enabled` 写成
非法 JSON 后启动 release 实例，经 CDP 调用 `clipboard_status` 与 `clipboard_repair_config`，
核对暂停/修复/恢复行为与备份键，结果见 §4.5 与
`evidence/p0-config-runtime-20261030.json`。

### 2.2 P1 恢复自写隔离（已修复）

**原风险**：恢复动作本身会触发 `WM_CLIPBOARDUPDATE`；若采集线程把恢复写回当成
用户复制，会新增历史/改变 `copy_count`，甚至与下一轮写入互相覆盖。

**实现**（`src-tauri/src/clipboard/platform.rs`）：

- 进程级 `ACCESS_LOCK`（`:1195`）串行化本进程全部剪贴板访问；
- 所有写入统一走 `write_guarded` / `write_guarded_notifying`（`:635`、`:644`），
  锁内比较 `WriteGuard::{Content, Sequence, Unconditional}`；不匹配时不 `EmptyClipboard`；
- 写入成功后在同一把锁内把序列号 `fetch_max` 登记到 `self_write`；
- 采集线程在锁内复核 `is_own_write_sequence(event_sequence, self_write)
  = event_sequence <= self_write`（`:497`），自写事件不进入采集；
- `restore_if_own_content`（`:661`）只在“当前内容 == 本任务最后一次写入”时恢复；
  用户后来复制的内容一律保留（`KeepUserCopy`）；
- `finish_restore` 只在恢复成功后登记序列号；失败不登记，避免污染自写门槛。

**自动化证据**：`self_write_gate_skips_only_covered_events`、
`restore_registers_self_write_only_on_success`、`restore_never_overwrites_new_user_content`、
`write_guard_uses_content_for_own_writes`、`sequence_race_between_check_and_write_never_overwrites`、
`user_copy_after_write_blocks_key_and_preserves_new_content`。
前轮真机 C6（粘贴自身写入不产生新历史）与 C11（用户中途复制不被覆盖）仍成立。

### 2.3 P1 图文混合中的图片 Alpha 缺陷（已修复，GUI 复验阻塞）

**真机复现路径**：构造分组 **截图A（红）→ 截图B（绿）→ 文字C → 截图D（蓝）**，
对 Edge `contenteditable` 测试页整组粘贴。Task Dock 返回 `completed`、`sent=4/4`、
`restored=true`；目标 DOM 顺序为 `IMG → IMG → 文字 → IMG`，看起来“成功”。

**像素审计揭穿**：目标中保存的三张图（480×300）Alpha 采样全部为 0：

| 文件 | 尺寸 | 采样点 | 不透明点 | 中心 RGBA | 左上 RGBA |
|---|---|---|---|---|---|
| pasted-1.png | 480×300 | 5760 | 0 | 255,255,255,0 | 220,40,40,0 |
| pasted-2.png | 480×300 | 5760 | 0 | 40,160,60,0 | 40,160,60,0 |
| pasted-3.png | 480×300 | 5760 | 0 | 40,70,200,0 | 40,70,200,0 |

即 RGB 颜色存在但完全透明。根因：Windows 会为 32bpp BI_RGB DIB 合成 Alpha 全 0
的 PNG；读取路径 `read_png` 原样保存，绕过了 `dib_to_rgba` 的兜底。

**修复**（`src-tauri/src/clipboard/image.rs`）：

- `opaque_when_fully_transparent`（`:105`）仅在**全部**像素 Alpha=0 时改为 255；
  部分透明/有可见像素一律不动；
- `normalize_clipboard_png`（`:119`）全透明时重编码，否则返回原字节；
- `platform.rs:879` 的 `read_png` 统一走该入口；
- 测试：`fully_transparent_png_is_treated_as_opaque`、
  `transparent_png_from_clipboard_is_reencoded_visible`、
  `opaque_clipboard_png_is_kept_byte_identical`。

**边界**：该修复解决“全透明合成 PNG”；若来源本身是**部分透明**图，保持原样，
不会强行改不透明。修复后未能在真实目标复验（锁屏），见 §4.3。

### 2.4 P1 Agent HTTP 接入连接 panic（本轮新发现并修复）

**现象**：release 实例对 `/api/v1/health` 返回空响应；stderr 每个连接一条：

```
thread 'tokio-rt-worker' panicked at hyper-1.12.0/src/common/time.rs:84:32:
timeout `header_read_timeout` set, but no timer set
```

**根因**：hyper 1.x 设置 `header_read_timeout` 时必须同时提供 timer；
原代码只设置了超时。该缺陷会让 Agent HTTP 接入在高频事件下完全不可用。

**修复**（`src-tauri/src/agents/http_ingest.rs`）：

- 新增 `http1_builder()`（`:45`），统一设置 `keep_alive`、`header_read_timeout`、
  `.timer(TokioTimer::new())`（`:50`）；
- 连接处理改用 `http1_builder().serve_connection(...)`（`:456`）；
- 回归测试 `http1_connection_with_header_timeout_answers_instead_of_panicking`（`:595`）：
  起真实 TCP 服务，断言返回 `HTTP/1.1 200` 与 JSON，而不是超时/空响应。

**真实运行证据**：重建 release 后 `/api/v1/health` 返回 200；场景 C 两轮共
74,653 次事件请求全部 200，`internal_errors=0`，`rejected_overload=0`，
`rejected_parse=1`（测试脚本经 Git Bash 发送中文时的终端编码失败，改用 Node 后正常，
非应用缺陷），stderr 为空（无 panic）。

### 2.5 十二项边界检查

| # | 边界 | 结论 | 证据 |
|---|---|---|---|
| 1 | 恢复自身通知被当成用户复制 | **已处理** | 锁内 `fetch_max` 登记 + `is_own_write_sequence`；`self_write_gate_skips_only_covered_events`；前轮 C6 |
| 2 | 目标 HWND 复用导致误发按键 | **已处理** | `ensure_target_pid`/`ensure_send_target`（`paste.rs:929`、`:939`），PID+前台双校验；`reused_or_unfocused_target_is_rejected_before_pressing_keys` |
| 3 | Ctrl+V 前后焦点变化 | **部分处理** | 发送前再次校验前台 HWND 与 PID；`SendInput` 之后无可靠系统信号，最终只报“动作已发送”；未验证的焦点切换如实记录 |
| 4 | 写入失败留下部分格式 | **残余风险（未构造故障注入）** | `OpenClipboard` 失败直接返回、不清空剪贴板；若 `EmptyClipboard` 或主格式写入失败，剪贴板可能为空或只剩部分格式。任务会 `failed` 并停止，但 `restore_if_own_content` 因内容无法证明“仍是本次写入”可能选择 `KeepUserCopy`，原快照不保证恢复。无对应注入测试 |
| 5 | 删除图片误删共享资源 | **已处理** | 资产引用计数；前轮 D4/D5 真机（组删除条目保留、图片资产 11/11 保留） |
| 6 | 图片解码失败导致半写入 | **已处理** | `image_capture_failure_leaves_no_partial_row` |
| 7 | 敏感内容进入日志/Agent 导出 | **已处理（代码审查）** | 剪贴板日志只含类型/大小/计数/窗口标题；`ClipboardMatch` 无内容载荷；导出必须用户显式触发、无网络上传；未做日志逐行自动审计 |
| 8 | 设置异常阻塞启动 | **已处理** | fail-closed 读取不影响任务/Agent 设置；真实隔离实例启动验证（§4.5） |
| 9 | 后台线程退出 | **已处理** | `ClipboardMonitor::stop` 依次 join 消息/capture/worker（`platform.rs:1664`）；maintenance 用 Condvar 唤醒退出（`mod.rs:306` 起）；`stop_signal_wakes_maintenance_wait_immediately` |
| 10 | 清理与粘贴争用图片 | **已处理** | 维护线程与 `clipboard_cleanup` 在粘贴活跃时跳过清理（`mod.rs:262`、`commands/clipboard.rs:518`）；`interrupt_stale_paste_jobs` 仅在无活跃任务时执行 |
| 11 | 非 Windows 降级 | **仅代码审查** | `cfg(not(windows))` 下监听返回“当前平台不支持剪贴板监听”、粘贴返回“当前平台不支持粘贴自动化”；本机无法编译/运行非 Windows |
| 12 | 长跑后监听计数可信度 | **部分验证** | `AtomicU64` 单调计数，`clipboard_status.monitor` 暴露；场景 A 期间锁屏无剪贴板事件，计数全 0，**无法验证真实事件下的长跑计数** |

## 三、自动化与工程门禁

本轮在 2026-10-30 01:26–01:32 重新执行，未复用历史结果。日志在
`docs/clipboard/evidence/gates-20261030.log`（汇总，临时工作目录已清理）。

| 门禁 | 结果 |
|---|---|
| `cargo fmt --all -- --check` | **通过**（exit 0，无输出） |
| `cargo clippy --all-targets --all-features` | **通过**（0 警告，16.17 s） |
| `cargo test --all-targets --no-fail-fast` | **302 passed / 2 failed / 11 ignored**（lib 305 项 + 10 个集成 ignored）；2 个失败均为 `navigation::router` 前台聚焦测试，锁屏下 Windows 拒绝 `SetForegroundWindow`（环境阻塞，非剪贴板回归）；生产代码如实返回失败原因，未放宽断言 |
| `npx tsc --noEmit` | **通过**（exit 0，12 s） |
| `npx vitest run` | **21 个文件 / 133 个测试全部通过**（55.44 s） |
| `npm run build` | **通过**；JS 464.88 kB（gzip 138.75）、CSS 68.51 kB（gzip 10.96）、index 0.40 kB |
| `cargo test --release --test clipboard_perf -- --ignored --nocapture` | **2 passed**；历史/入库预算 `pass=true`（明细 §5.5） |
| `npm run tauri build`（NSIS + MSI） | **通过**；`release` 编译 8m26s，NSIS 4.01 MiB / MSI 6.15 MiB，01:44 产出；产物见 §5.6 |

**门禁说明**：

- 为排除整包失败对剪贴板结论的影响，另单独重跑 `cargo test --lib clipboard::`：
  **69 passed / 0 failed / 0 ignored**（0.68 s），剪贴板模块无失败。
- `cargo test --all-targets` 因 2 个前台聚焦测试在锁屏会话失败而整体退出 101；
  使用 `--no-fail-fast` 跑完全部 target 才能得到完整计数。这不是把失败改成通过：
  2 例仍记录为 **ENVIRONMENT BLOCKED**，未删除、未跳过、未调高阈值。
- 11 个 ignored 均为手动性能/真机脚本（`actions_perf` 1、`clipboard_perf` 2、
  `ingest_perf` 6、`real_backup_restore` 1、lib 1），不是本轮新增跳过。
- 前端 133 个测试包含剪贴板配置异常 UI、抽屉交互与任务/导航既有用例；
  仓库仍无 ESLint 配置，未伪造 lint 结果。

## 四、真实桌面验收

### 4.1 方法与隔离

- 隔离标识 `com.taskdock.desktop.accept`，独立 `TASK_DOCK_DATA_DIR`；
- 内嵌前端的 release 构建；WebView2 CDP `9417` 驱动 UI 与 invoke；
- 真实系统剪贴板由独立 PowerShell STA 脚本写入；目标为真实 Edge 进程；
- 每项读回来自目标 DOM / 独立进程 / 磁盘，不复用 Task Dock 自身状态；
- 磁盘上的图片读回用 canvas `getImageData` 逐点审计，而不是只看 `<img>` 是否存在。

### 4.2 修复前的真实图文混合记录（2026-10-29 15:32，桌面未锁屏）

| 检查 | 结果 |
|---|---|
| 分组内容 | A（红）→ B（绿）→ 文字C → D（蓝），4 项 |
| Task Dock 任务 | `completed`、`sent=4/4`、`confirmed=0`、`restored=true` |
| 目标 DOM 顺序 | `IMG → IMG → TEXT-C → IMG`（正确） |
| paste 事件类型 | `Files / Files / text/plain / Files` |
| 剪贴板恢复 | 哨兵文本读回存在 |
| 历史副作用 | 7→7 条、分组 2→2、4 个条目 `copy_count` 未变 |
| 图片字节 | 与库内资产逐字节一致 |
| **图片可见性** | **三张图 Alpha 全 0（不可见）→ 缺陷** |

结论：`sent=4/4` 与 DOM 顺序不能证明图文粘贴成功；必须做像素级读回。
该记录直接触发了 §2.3 的修复。

### 4.3 修复后的 GUI 复验：环境阻塞

2026-10-29 16:36 起工作站锁屏，直至本报告完成时仍未解锁：

```json
{"ClipboardOpen":false,"LogonUI":true,"SessionFlags":0,"SessionState":1}
```

- `SessionFlags=0` 表示会话锁定；
- 锁屏下剪贴板写入阻塞/`ERROR_ACCESS_DENIED=5`，`SendInput` 不可能落到目标窗口；
- 因此未创建“修复后真实目标粘贴成功”的证据，也不把单元测试折算为真机通过。

**结论：修复后的真实图文混合粘贴 = ENVIRONMENT BLOCKED / NOT VERIFIED。**
微信（已登录真实会话）与 Agent 应用（登录/引导页）同样保持未验证。

### 4.4 第三方应用矩阵

| 目标 | 前轮结果（2026-10-29 上午） | 本轮 |
|---|---|---|
| 记事本 | PASS（3 项文本有序，独立读回） | 未重跑（锁屏） |
| 资源管理器 | PASS（CF_HDROP 两文件落盘） | 未重跑 |
| Edge textarea | PASS（CDP DOM 两项有序） | 未重跑 |
| Edge contenteditable 富文本 | PASS（`<b>`/`<i>` 保留） | 未重跑 |
| VS Code | PASS（保存后磁盘读回） | 未重跑 |
| 微信桌面端 | ENVIRONMENT BLOCKED | ENVIRONMENT BLOCKED |
| Agent（Trae CN） | NOT VERIFIED | NOT VERIFIED |

前轮 5/5 只覆盖“文本/富文本/文件”的目标接收；它不能替代图文混合的像素级复验。

### 4.5 P0 隐私配置的真实运行验证

隔离实例（数据副本 3 个任务、45 个设置键）将 `clipboard_enabled` 写成 `{not-json` 后启动，
用 WebView2 CDP 调用真实 IPC 与 UI，原始摘要：
`evidence/p0-config-runtime-20261030.json`。

| 步骤 | 实测 |
|---|---|
| 损坏后 `clipboard_status` | `enabled=false`、`paused=true`、`captureAllowed=false`、`monitoring=true`；`configError.kind=json`、`keys=["clipboard_enabled"]` |
| 损坏后抽屉 UI | 状态“配置异常，自动记录已暂停”；说明含键名、“监听线程仍在运行，但不会记录任何新内容”、“损坏的原始值已保留…去修复” |
| 损坏后历史/任务 | 历史可读（5 条抽样含 text/image）；任务 3 → 3 |
| `clipboard_repair_config(resume=false)` | 配置错误清空、`enabled=false`、`paused=true`、`monitoring=false`（用户明确保持关闭） |
| `clipboard_repair_config(resume=true)` | `enabled=true`、`paused=false`、`captureAllowed=true`、`monitoring=true` |
| 原始值备份 | `clipboard_config_corrupt_backup = {"clipboard_enabled":"{not-json"}` |
| 其他设置 | 28 个非剪贴板键中仅 `window_rect`（窗口位置，y 32→64）变化；主题/通知/HTTP/Agent 等业务键全部未变 |
| 进程日志 | stderr 0 字节，无 panic |

监听线程在配置损坏期间保持运行但不采集；修复并恢复后重新可用。该验证只覆盖
`clipboard_enabled` 的 JSON 损坏；其他键/类型/范围/数据库读取失败由单元测试覆盖（§三）。

### 4.6 修复后的 GUI 复验：真实桌面通过（2026-10-30 16:41，追加）

解除 §4.3 的锁屏阻塞后重跑。被测二进制 `src-tauri/target-accept/release/task-dock.exe`
（16:20:27 构建，15,515,136 B，版本 0.5.0）；目标为本机真实 Edge `contenteditable` 独立窗口。

**这一轮同时暴露并修掉了两条旧断言自身的问题**（详见 `docs/V05_COMPREHENSIVE_REMEDIATION.md` §5.7–5.8）：

1. 「历史新增条目数恰为 4」在全机共享剪贴板上不可判定 → 改为按内容归属判定 + 外部条数与全局序列号等量佐证；
2. 「恢复为蓝图 D」无法证伪（D-blue 既是恢复目标又是粘贴最后一项），且在任务结束 1.6 s 之后才单点读剪贴板
   → 改为粘贴前写入唯一哨兵文本 `PASTE-BASELINE-SENTINEL-4d71be`，并在任务状态离开 `running` 的那一刻起
   0.8 s 内每 60 ms 密集采样；断言改为 PASS/FAIL/**BLOCKED** 三态，BLOCKED 单独成桶、绝不折算成 PASS。
   脚本自身也修掉了把用户剪贴板原文写进证据的隐私问题（改为 `has_text/length/markers/sha256_12`）。

三轮完整记录（不隐藏失败轮）：

| 轮次 | 退出码 | 结果 | 归因 |
|---|---|---|---|
| 16:26→16:28 | 1 | 4/4 粘贴、像素、自写不重采等全 PASS；2 条 FAIL | 均为断言写法问题（环境污染 + 无法证伪），已按上面两条改造 |
| 16:39→16:40 | 3 | `ENVIRONMENT BLOCKED` | 隔离实例被本机其他进程外部终止（`exit=4294967295`，应用日志无 panic；前台来源出现 `workbuddy.exe`）；不据此判定产品 |
| 16:41→16:42 | 0 | **PASS 52 / FAIL 0 / BLOCKED 0**，`overall=PASS` | 通过 |

关键实测（16:41 轮，证据 `evidence/p1-03-mixed-paste-20261030-164201-c07922a9.json` +
`…-app.log` + `p1-03-mixed-paste-run-1710-console.log`）：

| 维度 | 实测 |
|---|---|
| 顺序与分组 | 红 A→绿 B→文本 C→蓝 D 各入库 PASS；`history_delta=4`；四项内容各建一条（3 图 + 1 文）无漏采无重复；分组顺序 A/B/C/D、含 4 项 |
| 像素级 Alpha/RGB | 采集侧三图 240×160、`alphaMin=alphaMax=255`、`transparentPixels=0`、`opaquePixels=38400`、`avgRgb` 红/绿/蓝精确；目标 DOM 侧三图各 4 条断言（尺寸/Alpha/RGB/可见）全 PASS，DOM 顺序 `图/图/文/图`，文字 `MIXED-TEXT-C-7f3a9d-图文混合粘贴` 位于第三位且完整 |
| 逐项粘贴 | `status=completed`、`sent=4 total=4`、`remaining_items=[]`、`restored=true` |
| 恢复原剪贴板 | 0.8 s 内 15 次采样，序列号全部 `8116`（整段无外部写入）、`sentinel_hits=15`、`left_on_pasted_item=0`、`foreign_samples=0`；`剪贴板未被 A/B/C 留在原地` PASS |
| 自写不重采 / copy_count / 监听 | captured·recorded 增量 0；四个条目 `copy_count` 前后均为 1；`observed=10 captured=5 recorded=5 duplicates=0 dropped_events=0 dropped_contents=0 failed=0 max_capture_latency_ms=10`、`peak_content_queue=1/8` |

同日 16:45 真机 Rust 套件 `TD_REAL_CLIPBOARD=1 cargo test --test real_clipboard -- --ignored`
→ **3 passed / 0 failed**（`evidence/gate-real-clipboard-20261030-1715.log`）；
`cargo test --lib navigation::router` → **10 passed / 0 failed**，§三 中两例锁屏前台聚焦失败
（`launch_disallowed_reports_failure_or_focus_only`、`notepad_launch_focuses_existing_window_of_owned_process`）
现已通过。全套门禁同日重跑：`cargo test --all` 441 passed / 0 failed / 3 ignored（EXIT=0）、
clippy 与 fmt 均 0、`npm run build` 0、`npm test` 23 文件 / 164 用例 0、release 构建 0。

**仍未因本轮通过而解除的项**：本节的成功只覆盖 Edge `contenteditable` 一个真实目标；
§4.4 的第三方应用矩阵未在 v0.5 二进制上复跑（矩阵脚本从未入库，无法原样复现）；
场景 B（§七 P1 第 4 条）本轮只跑了验收自身的连续采集链路，未做 30 分钟连续真实采集；
「粘贴中途被用户复制」这一轮全程没有外部接管（`paste_resumptions=[]`），仍只有单测与真机套件构造证据。

## 五、性能与稳定性

### 5.1 场景 A：30 分钟空闲

**采样**：2026-10-30 00:50:02–01:20:06（1804 s，30 s 间隔，58 个样本），
release 实例（隔离数据目录，1,250 条历史），进程树 7–9 个进程，20 逻辑 CPU。
原始记录：`evidence/perf-a-idle-30min-20261030.json`；前后状态：
`evidence/idle-before.json`、`idle-mid.json`、`idle-after.json`。

| 指标 | 结果 |
|---|---|
| CPU（进程树，20 逻辑 CPU） | 平均 **0.324%**，最低 0.154%，峰值 **0.594%** |
| 工作集 WS | 546.11–643.63 MB，平均 564.28 MB，末次 546.19 MB |
| 私有内存 | 375.85–455.05 MB，平均 390.69 MB |
| 线程 | 204–225，平均 208.3 |
| 句柄 | 10,074–10,470，平均 10,092 |
| 监听状态 | `monitoring=true`、`paused=false`，30 分钟未变 |
| 历史规模 | 1,250 条 / 555,068 B，前后一致 |
| 监听计数 | observed / captured / recorded / dropped / failed **全 0**；队列峰值为 0 |
| 健康检查 | `/api/v1/health` 200（前后及中途） |

**交叉核对**：独立第二次采样 2026-10-30 00:54:45–01:24:17（1,803 s，58 个样本，
与上式重叠约 25 分钟）：CPU 平均 **0.294%**、峰值 **0.607%**；WS 546.31–594.04 MB
（平均 556.31）；私有内存 376.32–403.02 MB；线程 203–223；句柄 10,074–10,096。
两组独立采样一致，未出现持续增长。原始记录：
`evidence/perf-a-idle-30min-final-20261030.json`。两次采样同样只覆盖空闲状态。

**限制（必须与数据一起引用）**：

- 采样期间工作站锁屏（`SessionFlags=0`、`LogonUI` 存在），真实剪贴板事件为 0，
  因此本场景只证明“空闲时无泄漏、无漂移、监听线程存活”，**不证明真实事件节奏下
  的队列/计数/延迟**，也不证明 30 分钟连续采集（场景 B）。
- WS 约 550–640 MB 主要来自 WebView2 与 1,250 条历史；30 分钟内总体下降，
  未观察到持续增长；不以单次峰值宣称“内存优化完成”。
- 采样器按进程树统计 CPU，系统上其他进程的活动不计入；采样期间未运行编译/压测。

### 5.2 场景 B：连续真实剪贴板采集

**ENVIRONMENT BLOCKED / NOT VERIFIED**。连续文本/截图/混合内容/大量图片/自动分组/
自动清理需要真实系统剪贴板；锁屏期间 `Clipboard.SetText` 阻塞，无法安全执行。
不以队列压力测试或缩短时长替代 30 分钟标准。
前轮 46/46 中 B8/B8b/B9/B10/B11 仅覆盖短时真实采集。

### 5.3 场景 C：Agent 高频事件 + UI + 任务提醒 + 抽屉

两轮 16 worker × 60 s；每 23 条事件插入一条 `completed`；同时运行 3 个提醒任务
（+3/6/9 s）、抽屉开关、列表刷新与搜索。

| 指标 | 第 1 轮 | 第 2 轮 |
|---|---|---|
| 事件请求 | 33,649 | 41,004 |
| HTTP 200 | 33,649 | 41,004 |
| 非 200 / 网络失败 | 0 / 0 | 0 / 0 |
| 请求延迟 p50 / p95 / max | 17.78 / 89.72 / 2583.07 ms | 17.00 / 42.17 / 2237.75 ms |
| pipeline 合并 / 处理 | 24,884 / 8,766 | （累计）55,182 / 19,472 |
| 批次数 / 批大小峰值 | 338 / 31 | 749（累计）/ 33 |
| 单批写库 p50 / p95 / max | 18.56 / 52.67 / 68.31 ms | 19.32 / 62.58 / 95.60 ms |
| ingest p50 / p95 / max | 119.80 / 2486.59 / 2612.57 ms | 119.26 / 294.03 / 507.81 ms |
| 过载拒绝 / 提交失败 / 内部错误 | 0 / 0 / 0 | 0 / 0 / 0 |
| 队列深度（结束后） | 0 | 0 |
| 抽屉打开 p50 / p95 | 313.98 / 553.73 ms | 359.23 / 512.74 ms |
| 抽屉关闭 p50 / p95 | 128.31 / 278.83 ms | 150.38 / 263.89 ms |
| 搜索（6 次） | 682–1129 ms | 707–1022 ms |
| invoke 列表 p50 / p95 | 254.87 / 2622.10 ms | 320.11 / 2990.92 ms |
| 进程 CPU 峰值（20 逻辑 CPU） | 见 5.1/资源记录 | 2.719% |
| 私有内存 / 工作集峰值 | — | 545.48 / 720.89 MB |
| 线程 / 句柄峰值 | — | 243 / 10,155 |

**解释与限制**：

- Agent 管线没有丢失/拒绝事件；合并是最新事件覆盖策略，`events_processed=8,766`
  小于 `events_received` 是预期行为，不是丢弃；
- 第二轮 ingest p95 更低，第一轮 p95 偏高与首轮 JIT/磁盘增长有关，两次都远低于
  负载上限；不以单次最优值对外宣称；
- 高频事件期间 WebView 主线程被列表刷新与搜索占用，抽屉操作 p95 约 0.51–0.55 s，
  后端列表本身仍为几十毫秒（§5.4）；这是 UI 争用，不是数据库退化；
- **剪贴板/提醒的联合验证受限**：锁屏下剪贴板计数全 0；3 个提醒任务按时插入，
  但未做“通知点击”GUI 验证。不得把本场景表述为“剪贴板 + Agent 联合压测通过”。

### 5.4 场景 D：>1000 条历史、大分组、快速滚动、预览、抽屉与清理（release）

数据集：1,250 条（1,185 文本 + 45 图片 + 20 文件 + 1 个 50 条分组），
图片 960×540，DB 约 10 MB，资产约 0.56 MB。

| 指标 | release 实测 |
|---|---|
| 抽屉首次打开 | 239.11 ms |
| 快速滚动 5 s（395 帧） | p50 15.2 / p95 17.2 / max 32 ms，>50 ms 0 帧 |
| 搜索 `BURST` | 稳定 367.4 ms，2 个 53 ms long task |
| 图片详情渲染（含解码） | 56.4 ms，960×540 |
| 分组卡片 / 50 行详情 | 7.8 / 15.6 ms（后端 18.15 / 19.6 ms） |
| 10 次抽屉开关 | 打开 85–152 ms；关闭 13–22 ms |
| 后端列表 80 条 | p50 30.52 / p95 40.77 / max 42.94 ms |
| 后端列表 200 条 | p50 47.11 / p95 52.46 / max 56.01 ms |
| 后端搜索 | p50 30.63 / p95 43.86 / max 47.21 ms |
| 清理（删除 440 条 / 1,275,695 B）期间帧 | p50 8 / p95 8.6 / max 17.03 ms，>50 ms 0 |
| 删除 10 条 | 23.76 ms |
| 类型筛选 | 图片 45 / 文件 20 / 文字 1,185 / 全部 1,250；收藏 0；恢复 1,250 |
| 类型筛选耗时 | 477–577 ms |

对比：dev 构建同数据集打开 749 ms、搜索 742 ms、清理 max 78 ms / 3 帧 >50 ms；
release 明显更稳，但清理期间仍有单帧 17 ms，未达到“零卡顿”的夸张说法。

### 5.5 release 剪贴板性能预算（含失败运行）

干净重跑 2026-10-30 01:30–01:32，报告
`docs/performance/results/CLIP-20261030-013239.json`：

| 项 | 实测 | 预算 | 判定 |
|---|---|---|---|
| 300 条历史（含 100 图）列表 p95 | 1.96 / 2.36 ms（80/200 条） | ≤120 ms | PASS |
| 200 张 1920×1080 截图入库+分组+配额 | 6,984.09 ms | ≤8,000 ms | PASS |
| 清理耗时 | 179.07 ms | — | — |
| 资产落盘 | 30.21 MB | ≤32 MB 配额 | PASS |
| PNG 编码准备（不计入入库） | 47,584.97 ms | — | — |
| 脚本 `pass` | `true` | — | PASS |

失败的两次运行不得隐藏：

| 时间 | 结果 | 观察 |
|---|---|---|
| 2026-10-29 23:36 | FAIL | ingest 16.75 s（预算 8 s），encode setup 112.27 s |
| 2026-10-29 23:59 | FAIL | ingest 17.01 s，encode setup 113.25 s |

两次失败发生在机器同时编译/有其他负载时，`setup` 从约 20–27 s 升至 112–113 s，
不是只入库变慢。失败 JSON 仍保留在 `docs/performance/results/`，预算未调整；
本次干净重跑通过，但不代表历史失败不存在。

### 5.6 最终安装包与产物冒烟

| 项目 | 结果 |
|---|---|
| 构建命令 | `npm run tauri build`（vite 7.93 s + release 编译 8m26s + NSIS/MSI） |
| NSIS | `Task Dock_0.5.0_x64-setup.exe`，4.01 MiB（4,201,417 B），2026-10-30 01:44 |
| MSI | `Task Dock_0.5.0_x64_en-US.msi`，6.15 MiB（6,447,104 B），2026-10-30 01:44 |
| 产物启动 | 用同一 `target/release/task-dock.exe` + 隔离数据目录启动：`/api/v1/health` 200，`clipboard_status.monitoring=true`，历史 1,250 条 / 45 图 / 20 文件可读 |
| 签名/安装卸载 | **未验证**（未签名；未执行安装/卸载流程） |

原始冒烟记录：`evidence/final-release-smoke-20261030.json`。
安装包新鲜度：01:44 产物晚于最后一次源码修改（仅文档改动），可执行文件与
P0 运行验证所用 release 构建同源。

## 六、证据分类

### 6.1 已修复且有自动化测试证明

- P0 隐私配置 fail-closed（4 个 db 测试 + 1 个前端组件测试）；
- P1 自写隔离与恢复守卫（6 个平台/引擎测试）；
- P1 Alpha 归一化（3 个 image 测试）；
- P1 HTTP `header_read_timeout` timer（1 个真实 TCP 回归测试）；
- 队列/粘贴状态机/HWND 复用/清理保护（前轮 16+ 例，仍在本轮门禁中运行）。

### 6.2 已修复且有真实运行/桌面测试证明

- P0 隐私配置：独立数据目录损坏后启动、`clipboard_status` 暂停、显式修复与恢复
  （本轮 CDP 实测，§4.5）；
- P1 HTTP：release 健康检查 200 + 74,653 次事件请求 0 失败；
- P1 自写隔离：前轮 C6（历史不增）；本轮 C 场景中无自写历史副作用（场景 C 不写剪贴板，
  故不能替代 C6）；
- 场景 D 的 UI/后端/清理数据（release，本轮）；
- 前轮 46/46 与第三方矩阵 5/5（历史证据，明确标注）。

### 6.3 仅代码审查通过

- 非 Windows 降级路径；
- 写入中途某个格式失败留下部分格式的极端情况；
- 敏感内容日志审计（逐行人工检查，无自动断言）；
- `SendInput` 之后焦点再次变化的窗口（无可靠系统信号）。

### 6.4 已实现但未验证

- 修复 Alpha 后的真实图文混合粘贴（锁屏）；
- 微信、Agent 应用接收；
- 多显示器/不同 DPI；
- 安装/卸载/签名；
- 30 分钟真实剪贴板事件下的监听计数可信度（场景 A 锁屏无事件）；
- 通知点击与提醒 UI（本轮只验证任务/提醒数据插入）。

### 6.5 未解决

- 锁屏导致的核心 GUI 复验缺口（外部环境，非代码缺陷）；
- 截图 PNG 编码 95–191 ms/张、默认 512 MB 配额约 220 张 1080p 的长期容量压力；
- 部分透明图片的显示依赖来源本身，不做强制改不透明；
- 前端主包体积与无代码分割（P2）。

### 6.6 环境阻塞

- 2026-10-29 16:36 起桌面锁屏：真实图文混合粘贴、场景 B、第三方应用复跑、
  多显示器验证均阻塞；
- 微信已登录真实会话，禁止自动注入；
- Agent 应用停在登录/引导页，无法确认落点；
- 隔离实例的 `agent-inbox` 仍指向真实 Roaming 目录（Tauri 已知文件夹 API），
  测试隔离不完整；本轮场景 C 只发送无正文事件，未读写用户聊天内容。

## 七、P0 / P1 / P2 遗留

**P0**

1. 无已知未修复 P0。隐私配置、恢复自写隔离、Alpha、HTTP 接入均已修复。

**P1**

2. 修复 Alpha 后的真实图文混合粘贴未在 GUI 复验（锁屏，外部阻塞）。
3. 微信/Agent 应用接收未验证。
4. 场景 B 连续真实采集未执行（锁屏）。
5. 写入中途格式失败的注入测试缺失（代码路径有停止/恢复，但未构造部分格式）。
6. 真实 30 分钟监听事件计数未验证（锁屏无事件；空闲资源指标已由场景 A 覆盖）。
7. 截图编码耗时与默认配额容量限制仍在。

**P2**

8. 通知点击/提醒 UI 未做 GUI 验证。
9. 隔离实例的 agent-inbox 未完全隔离（已知文件夹 API）。
10. 安装/卸载/签名未验证；产物未签名。
11. 前端主包无代码分割；仓库无 ESLint 配置（未伪造 lint 通过）。

## 八、最终 A–I 判定

| 项 | 验收维度 | 判定 | 依据 |
|---|---|---|---|
| A | 真实采集与自动分组（文字/截图/文件、顺序） | **部分验证** | 前轮 B2/B3/B8/B8b/B9/B10 真机；本轮锁屏无法重跑，场景 B 阻塞 |
| B | 持久化与删除安全 | **PASS（前轮证据）** | H1 重启持久化、D4/D5 共享资产；本轮未重跑 |
| C | UI 与入口（抽屉、分组、详情、筛选、状态） | **PASS** | 本轮 release 场景 D + 筛选；配置异常 UI 单测 |
| D | 复制/逐项粘贴/失败安全/不覆盖用户内容 | **CONDITIONAL** | 状态机、自写隔离、HWND 复用单测；前轮 C3/C5/C7/C8/C10/C11/C12；**修复后图文混合未复验** |
| E | 任务关联与 Agent 能力边界 | **PASS（自动化）** | 前轮 D1–D5/E1 真机；能力矩阵单测；导出显式触发 |
| F | 隐私控制与日志 | **PASS** | 隐私 fail-closed 单测 + 真实隔离实例；日志不含正文（代码审查） |
| G | 性能与稳定性 | **PASS（有边界）** | 场景 A/C/D、release 性能预算；场景 B 与真实监听计数阻塞 |
| H | 自动化门禁与构建 | **通过（有环境例外）** | fmt/clippy/tsc/build/vitest 133 全过；Rust 302 passed / 2 锁屏前台聚焦失败 / 11 ignored；release 性能 `pass=true`；NSIS/MSI 重建并冒烟 |
| I | 文档同步与诚实记录 | **PASS** | 01–11 与源码同步；未验证/阻塞逐条列明；不宣称 100% |

**总体：CONDITIONAL PASS。** 条件：解锁后在至少一个真实目标（Edge contenteditable
或记事本/Word）完成“修复后 A→B→文字C→D”的像素级复验，并重跑场景 B；
在此之前不得改为 PASS。

## 九、发布结论

- **可发布（条件性）**：核心 P0 与已知 P1 缺陷均已修复；工程门禁与可执行性能预算通过；
  产物与源码对应；隐私与恢复保护有自动化与真实运行证据。
- **不可宣称**：修复后的真实图文混合粘贴已通过、微信/Agent 应用已支持、
  30 分钟真实监听稳定、所有应用/所有 DPI 均已验证。
- 解锁后的最小复验清单：
  1. 在隔离实例创建分组：红图 A → 绿图 B → 文字 C → 蓝图 D；
  2. 向 Edge `contenteditable` 整组粘贴（或记事本/Word，若支持图片）；
  3. 用 CDP 读取目标 DOM 顺序，并用 canvas `getImageData` 逐点断言三图
     Alpha=255 且 RGB 为红/绿/蓝、文字完整；
  4. 读回系统剪贴板哨兵、历史/copy_count 未变、库内图片 SHA 与目标像素一致；
  5. 场景 B 30 分钟连续采集 + observed/captured/dropped/队列峰值采样。

## 十、追加判定（2026-10-30 16:41 解锁会话之后）

> 本节是追加，不回改 §一/§四.3/§四.4/§六/§七/§八/§九 的锁屏期数值与措辞。

§九「解锁后的最小复验清单」逐条对账：

| # | 清单项 | 现状 |
|---|---|---|
| 1 | 隔离实例创建分组 红 A → 绿 B → 文字 C → 蓝图 D | ✅ 已执行（§4.6） |
| 2 | 向 Edge `contenteditable` 整组粘贴 | ✅ 已执行（真实 Edge 独立窗口，非用户日常标签页；Word/记事本未覆盖） |
| 3 | CDP 读 DOM 顺序 + `getImageData` 逐点断言三图 Alpha=255、RGB 红/绿/蓝、文字完整 | ✅ 已执行（DOM 顺序 `图/图/文/图`；三图 `alphaMin=alphaMax=255`、`transparentPixels=0`、`opaquePixels=38400`、RGB 精确；文字完整位于第三位） |
| 4 | 读回系统剪贴板哨兵、历史/copy_count 未变、库内图片与目标像素一致 | ✅ 哨兵与历史/copy_count 已执行（15/15 采样命中哨兵、序列号全程 `8116`；`copy_count` 前后均为 1；历史条数不变）。**库内 vs 目标像素按尺寸/Alpha 极值/透明像素计数/平均 RGB/三点采样比对，未做容器 SHA 比对**——同一张图在 Windows 剪贴板上有两个容器表示（重编码 PNG 与 CF_DIB 合成 PNG），容器 SHA 相等本来就不是内容相等的判据，那正是 §2.3 Alpha 缺陷的成因 |
| 5 | 场景 B 30 分钟连续采集 + observed/captured/dropped/队列峰值 | ❌ **未执行**（本轮只有验收自身的 4 次连续复制 + 粘贴期监听计数） |

§八 A–I 判定中受本节影响的行（其余行维持原判）：

- **D（复制/逐项粘贴/失败安全/不覆盖用户内容）**：`CONDITIONAL` 的「修复后图文混合未复验」
  这一半已解除；「不覆盖用户内容」仍需一条真机现场证据（本轮 `paste_resumptions=[]`，无外部接管）。
- **H（自动化门禁与构建）**：2026-10-30 16:15→16:45 全套重跑，锁屏期那 2 例前台聚焦失败已通过，
  `cargo test --all` 441 passed / 0 failed / 3 ignored、clippy/fmt/tsc/vitest(23 文件 164 用例)/release 构建全 0。
  **但 NSIS/MSI 未随本轮源码重建**（`target-accept/release/bundle/` 仍是 10-29 00:42/00:43 产物），
  「产物与源码对应」这条在本节时刻不成立，故 H 仍不升为无条件通过。

**总体判定：CONDITIONAL PASS（不变）**，但阻断条件已从「解锁后完成图文混合真机复验」
切换为：① 内存稳定性（`docs/V05_FINAL_ACCEPTANCE.md` §5.3，NOT PROVEN）；
② 本轮源码的安装包与 v12/v13 真实库升级迁移；③ 第三方目标应用矩阵在 v0.5 二进制上复跑并把脚本入库；
④ 125%/150% DPI 与 500px 满抽屉的真实截图走查。剪贴板 P1 可靠性本身在真实桌面上已闭环。
