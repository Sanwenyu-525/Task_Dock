# 12 · 第四轮专项整改验收（隐私事务安全 · 图文粘贴 · 内存稳定性 · 发布门禁）

> 日期：2026-10-30 · 版本：0.5.0 · 平台：Windows 11 x64 (22631) · 20 逻辑 CPU
> 原则：**未执行的验收不写成通过；单元测试不替代真实桌面验收；进程内断言不替代像素级与真机证据；文档与最终源码一致。**
> 本文只记录本轮（第四轮）可复现的结果；前几轮证据保留在 `11-final-release-acceptance.md` 与
> `docs/V05_FINAL_ACCEPTANCE.md`，不与本轮混算。
>
> 涉及的问题编号沿用第四轮整改清单：
> `P0-01` 剪贴板配置修复事务化 · `P1-02` 缺失配置键处理 · `P1-03` 图片 Alpha 与真实图文粘贴 ·
> `P1-04` Agent 长跑内存 · `P1-05` 剪贴板＋Agent 联合负载 · `P2-06` Windows 前台聚焦测试 ·
> `§九` 其余可靠性边界审查（10 条）。

---

## 一、本轮代码基线和 Git 状态

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 基线提交 | `356bc44 feat(v0.5): 综合整改、备份恢复与主题体系，补齐最终验收证据`（2026-10-30 22:17） |
| 工作树 | 脏（并行会话与本轮共用同一工作树，**未做任何 Git 清理/提交/回滚**） |
| 本轮改动（`src-tauri/`） | `agents/dsh.rs` `clipboard/mod.rs` `clipboard/paste.rs` `clipboard/platform.rs` `commands/backup.rs` `commands/clipboard.rs` `commands/data.rs` `commands/restore.rs` `db/mod.rs` `lib.rs` `tests/real_clipboard.rs` |
| Release 二进制（P1-04 长跑使用） | 副本 `task-dock-acc1.exe`，15,603,200 B，构建时间 **2026-10-30 23:42:45**（`npx tauri build --no-bundle`，exit 0） |
| Release 二进制（门禁与 P1-05 复跑使用） | `src-tauri/target-accept/release/task-dock.exe`，**2026-10-31 09:20:15**，15,792,128 B，`sha256=8900bd9d71e2ea19f730dd985505cfecda12d649ff85de809f4368072e021029`（同一份源码、`npx tauri build --no-bundle`，exit 0；构建日志 `evidence/build-release-fourth-round-final-20261031.log`） |
| 隔离构建目录 | `CARGO_TARGET_DIR=src-tauri/target-accept`（不与并行会话的 `target/` 互相覆盖产物）。**注意**：`npx tauri build` 从 `src-tauri/` 启动时，相对路径会被解析成 `src-tauri/src-tauri/target-accept`；产物已按同一 sha256 复制到常规路径，`src-tauri/src-tauri/` 只是构建暂存目录，不参与发布 |
| 验收隔离数据目录 | 每个验收实例使用独立 `TASK_DOCK_DATA_DIR`（单实例锁按数据目录哈希隔离，可与并行实例并存） |

**本轮新增/修改的源码文件（本轮作者本人）**

- `src-tauri/src/clipboard/platform.rs`：`ClipboardRead` 改为携带**读取时刻序列号**的 struct variant；
  新增 `superseded_events` / `self_write_events` / `empty_events` 三个计数器；
  新增纯函数 `classify_event`；采集线程改用读取水位推进去重。
- `src-tauri/src/commands/clipboard.rs`：`clipboard_probe` 适配新的 enum 形态。
- `src-tauri/tests/real_clipboard.rs`：真机集成测试适配新的 enum 形态。

---

## 二、P0-01 剪贴板配置修复的事务原子性

**风险**：原修复流程把「读原始值 → 备份 → 改键 → 校验」拆成多次独立写入，
监听线程可能在中间态读到**半修复**的配置（例如 `clipboard_enabled` 已写回 `true`
但 `clipboard_paused` 还是旧的 `false`），出现「用户只是点了修复，采集却被短暂打开」。

**实现**（`src-tauri/src/db/mod.rs`）

- `Settings::repair_clipboard(db, resume)`（`:1861`）把整个修复放进
  `rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)`；
- `repair_clipboard_tx`（`:1866`）顺序固定为
  **读取 → 备份（`clipboard_config_corrupt_backup`）→ 写入 → 校验 → 提交**：
  - `verify_clipboard_repair`（`:1968`）在**提交前**重读并断言「无配置错误」且
    `capture_allowed() == resume`，不满足直接 `Err` → 整体回滚；
  - 数据库不可用时 `Transaction::new_unchecked` 失败 → **不写任何东西**（`:1869`）；
  - `resume=false`（仅修复）强制 `clipboard_paused=true`，
    且**只有 `resume=true`（用户显式恢复）才允许写 `clipboard_enabled=true`**（`:1938`–`:1958`）；
  - 备份保留原始值（缺失键记 `null`）与 `_last_repair{kind, keys, origin, at, resume}`，绝不静默删除。

**为什么这样就满足「不短暂自动开启记录」**：采集线程的读路径走同一写连接，
在事务提交前只能看到**修复前的 fail-closed 状态**（`capture_allowed()=false`），
提交后才一次性看到完整合法状态；中途任何失败整体回滚，不存在「一半新一半旧」的可见态。

**回归测试**（`src-tauri/src/db/mod.rs`）

| 测试 | 断言 |
|---|---|
| `clipboard_repair_fault_after_writes_rolls_back` | 写入后注入故障 → 整体回滚，库内无半修复痕迹 |
| `clipboard_repair_database_write_failure_rolls_back_backup` | 写失败 → 备份也不落盘 |
| `clipboard_repair_process_death_rolls_back_on_reopen` | 事务中途进程死亡 → 重开后仍是修复前状态 |
| `clipboard_repair_blocks_monitor_until_commit_without_resume` / `..._with_resume` | 提交前监听侧读到的始终是 fail-closed |
| `clipboard_repair_backs_up_raw_values_and_requires_explicit_resume` | 备份保留原始值；仅修复后仍暂停 |
| `clipboard_repair_missing_switch_is_conservative` | 缺失键按最保守值落盘 |
| `clipboard_repair_does_not_write_when_database_broken` | 数据库坏掉时零写入 |

---

## 三、P1-02 缺失配置键的升级/异常隐私策略

**风险**：旧版本数据库升级后剪贴板键缺失，若按默认值补齐，
「缺省即开启」的语义会在用户毫不知情时重新打开剪贴板采集。

**实现**：引入初始化来源标记 `clipboard_config_origin`（`db/mod.rs:1455`），
由 `seed_clipboard_config`（`:1084`）在**一个事务内**决定来源并落标记：

| 来源 | 触发条件 | 处理 |
|---|---|---|
| `fresh_default` | `user_version=0` 的全新库 | 写入产品默认值，正常采集 |
| `legacy_upgrade_paused` | `0<version<7` 的无剪贴板模块旧库 | 写入默认值但**强制暂停**，等用户显式恢复 |
| `existing` | 库中已有部分剪贴板键 | **不补齐**，缺失键由读取路径 fail-closed |
| `missing` | `version>=7` 已初始化却一个剪贴板键都没有 | **只记录，不补齐**，保持缺失并 fail-closed |

- 读取路径 `reload_clipboard_raw`（`:1650`）把「缺失」单独归类为
  `ClipboardConfigErrorKind::Missing`（`:1466`），与 Json/Type/Range 区分开；
- 标记已存在（`marker > 0`）时初始化**直接返回**，绝不二次改写用户已有的合法配置；
- 整个初始化在一个事务内，失败不留下半套配置。

**回归测试**：`clipboard_fresh_install_seeds_defaults_and_marks_origin`、
`clipboard_legacy_upgrade_starts_paused`、`clipboard_missing_config_never_reenables_across_restarts`、
`clipboard_partial_missing_is_not_filled_on_restart`、
`clipboard_user_disabled_survives_key_loss_and_repair_only`。

---

## 四、图片 Alpha 与真实图文粘贴验证（P1-03）

### 4.1 Alpha 归一化的语义边界

修复只针对「Windows 合成 DIB 的 32bpp 通道被置零」这一种形态，
**不得无条件破坏用户本来希望保留的透明图像**：

| 形态 | 判定 | 结果 |
|---|---|---|
| 32bpp BI_RGB、Alpha 通道全 0、RGB 非零 | 合成 DIB 伪透明 | 归一化为不透明（合成 PNG 通道被丢弃） |
| 32bpp BI_RGB、Alpha 通道全 0、RGB 也全 0 | 真透明 | 保留透明 |
| 32bpp 带 Alpha 掩码 / 部分透明 | 真透明 | 保留，绝不归一化 |
| 只有 PNG、没有 DIB 来源 | 用户自带的透明 PNG | 原样保留（字节级一致） |

回归测试在 `src-tauri/src/clipboard/image.rs`：
`fully_transparent_png_is_treated_as_opaque`、`transparent_png_from_clipboard_is_reencoded_visible`、
`legitimate_transparent_png_without_dib_provenance_is_preserved`、
`partially_transparent_png_is_never_normalized`、`opaque_clipboard_png_is_kept_byte_identical`、
`dib_32bpp_bi_rgb_with_zero_alpha_is_visible`、`dib_bitfields_with_alpha_mask_keeps_transparency`。

### 4.2 真实图文混合粘贴（真机、非模拟）

证据：`docs/clipboard/evidence/p1-03-mixed-paste-20261030-235050-76869ab9.json`
（release 二进制 23:42:45 构建；目标为真实 Edge 页面；复制动作在**外部应用前台**发生）

| 断言组 | 结果 |
|---|---|
| 采集入库（A-red / B-green / D-blue / text-C） | 4/4 PASS，图片 240×160、Alpha 255 全不透明、RGB 与预期一致 |
| 无漏采无重复 | PASS（history_delta=4，distinct_colors=3，unrelated_image_items=0） |
| 粘贴前哨兵被采集 | PASS（history_count=5 ≥ expected 5） |
| 粘贴任务 | PASS（completed，sent 4/4，remaining_items=[]，restored=true） |
| 目标页 DOM 顺序 | PASS：图/图/文/图 |
| 目标页 3 张图片 | PASS：尺寸 240×160、Alpha 正确、RGB 正确、可见、无重复颜色 |
| 剪贴板恢复 | PASS：15 次采样全部命中哨兵，`left_on_pasted_item=0` |
| copy_count 不被粘贴抬高 | PASS（前后均为 1） |
| 粘贴自写内容未进入采集链路 | PASS（captured=0 / recorded=0） |
| **总计** | **52 PASS / 0 FAIL / 0 BLOCKED**，overall = **PASS** |

### 4.3 本轮新增的采集可观测性（修复「观察到但没采到」的静默丢弃）

**这是本轮从一次真实失败中定位并修复的产品缺陷。**
早前一轮 P1-03 验收出现过 `observed_events=6` 而 `captured=4` 的失败：
两条事件**既没有计数、也没有日志**地消失了（三条静默路径：
`sequence_after` 判过期、本进程自写、`ClipboardRead::Empty`），
监控面板无法解释 observed 与 captured 的差额，只能靠复跑碰运气。

**修复**（`src-tauri/src/clipboard/platform.rs`）

1. `ClipboardRead::Content` 改为 `{ sequence, content }`，
   `read_open`（`:1210`）在**剪贴板锁内**取 `GetClipboardSequenceNumber()`，
   把「读到的内容属于哪一刻的剪贴板状态」和内容一起返回；
2. 新增纯函数 `classify_event(event_sequence, last_captured, self_write)`（`:588`）
   → `Read` / `Superseded` / `SelfWrite` 三种处置，
   去重水位 `last` 推进到**读取时刻**的序列号，
   保证「同一份剪贴板状态只入库一次」（既不漏采，也不再抬高 `copy_count`）；
3. 三条丢弃路径全部计数并落日志：
   `superseded_events`（已覆盖）、`self_write_events`（本进程自写）、
   `empty_events`（剪贴板为空/无可识别格式）；
4. 自写判定排在覆盖判定之前，使「本进程自己写的」与「用户重复复制」在计数器里分开归因。

**修复后同一场景的计数器完全对账**（上表 23:50:50 那一轮）：

```
observed_events 10 = captured 5 + self_write_events 5 + superseded 0 + empty 0 + dropped 0
captured 5 = recorded 5，duplicates 0，skipped 0，failed 0
max_capture_latency_ms 6，max_process_latency_ms 28，peak_content_queue 1
```

其中 `captured 5` = 4 次外部复制 + 1 次哨兵写入；
`self_write_events 5` = 本进程 4 次写入 + 1 次粘贴后恢复。
**每一个观察到的事件都有归属，不再存在无法解释的差额。**

**回归测试**：`event_disposition_separates_read_superseded_and_self_write`
（`platform.rs`，覆盖 Read / Superseded / SelfWrite 三态、读取水位之后的旧通知不得二次入库、
自写优先归因、以及序列号回绕后的放行与去重）。

---

## 五、Agent 长跑内存增长定位（P1-04）

> 本节结论由第四轮长跑套件的三臂对照给出；原始采样与分段分析见 `docs/performance/results/`。
> 判定口径：**Rust 堆（`rust.live_bytes`）、进程私有提交（`private_mb`）、工作集（`ws_mb`）、
> 线程/句柄、数据库页数与 WAL 分别看趋势**；负载尾段（后 1/4）与负载后 10 分钟的斜率
> 才是泄漏信号，整段平均斜率会被一次性阶梯稀释。

### 5.1 方法与环境

| 项 | 值 |
|---|---|
| 套件脚本 | `scripts/perf/fourth-round-memory-suite.sh`（`DURATION=1800`、`POST=600`） |
| 被测产物 | `task-dock-acc1.exe`（23:42:45 的 Release 构建副本，15,603,200 B，套件内三臂共用同一文件） |
| 隔离 | 每臂独立 `TASK_DOCK_DATA_DIR`/`APPDATA`；构建产物目录 `target-accept`；测量副本改名，避免与并行会话实例同名串组 |
| 负载 | HTTP 4 Agent × 5 事件/s = 20 事件/s，共 36,000 条，全部 200；`failed=0`，`overload_rejects=0`，`commit_failures=0` |
| 采样 | `sampler.ps1` 5 s 一轮，进程树按镜像名 `^task-dock-acc1` 归组；`memory-phases.py` 按 `http_accepted` 增长切分 warmup/load/load_tail_quarter/post |
| 有效性 | 三臂 `process_exited_during_run=false`、`instance_exited_after_s=null`；存活样本 A 302 / B 222 / C 452；每样本 `taskdock.count=1`（无同名进程混入） |
| 臂参数 | A、B：`mixed/notify on/visible/rate 5/agents 4`（对照臂，剪贴板关闭）；C：同参数但 `minimized`，剪贴板开启 + 真实剪贴板激励 |

负载成功率三臂一致：A `36,000/36,000`、B `36,000/36,000`、C `36,000/36,000`；
端到端 p95 分别为 257.67 / 258.51 / 256.51 ms（预算门禁见第六节）。

### 5.2 三臂分段结果

单位为 MB / 个；`load` 为负载期首末，`tail` 为负载期后 1/4，`post` 为负载结束后 10 分钟。

| 指标 | A（对照 1） | B（对照 2） | C（联合负载臂） |
|---|---|---|---|
| `private_mb` load | 10.0 → 45.0（+35.0） | 11.5 → 13.7（+2.2） | 10.3 → 13.1（+2.8） |
| `private_mb` tail 斜率 | **−0.119 MB/min**（45.6→45.0） | **−0.042**（14.1→13.7） | **−0.032**（13.8→13.1） |
| `private_mb` post | 45.0 → 45.0（**−0.003 MB/min**） | 13.7 → 13.7（0.000） | 13.1 → 13.1（0.000） |
| `ws_mb` load → post | 32.2 → 26.6（**−5.6**） | 33.8 → 17.3（−16.5） | 32.2 → 15.0（−17.2） |
| `rust.live_bytes` load → post | 1.06 → 1.82 → 1.82 MB | 1.06 → 0.89 → 0.89 MB | 1.04 → 0.89 → 0.89 MB |
| `rust.peak_bytes` 全程 | 恒为 ≈2.49 MB | ≈2.49 MB | ≈2.49 MB |
| `threads` load / post | 32 → 32 / 32 | 31 → 27 / 27 | 35 → 32 / 31 |
| `handles` load / tail / post | 379→684 / 694→684 / 684→693 | 384→369 / 379→369 / 369→369 | 389→384 / 392→384 / 384→382 |
| `webview2_tree.private_mb` load → post | 226.8 → 289.2 → 289.2 | 241.9 → 221.8 → 222.6 | 244.2 → 224.3 → 223.6 |
| `webview2_tree` tail/post 斜率 | +0.015 / −0.013 | −0.033 / +0.084 | +0.006 / −0.047 |
| `db.page_count` load → post | 260 → 9458（post 持平） | 491 → 9603（持平） | 573 → 9871（持平） |
| `db.wal_bytes` | 4.29 → 4.63 MB（tail/post 持平） | 4.48 → 4.59 MB（持平） | 4.47 → 4.62 MB（持平） |
| CPU 均值（load / post） | 0.152% / 0.025% | 0.084% / 0.009% | 0.036% / 0.001% |

原始数据：
`DIAG-fourth-round-memory-a-20261030-235117.jsonl` / `…-b-20261031-003145.jsonl` /
`DIAG-fourth-round-joint-clipboard-20261031-011217.jsonl` 与同名 `analysis-*.json`。

### 5.3 结论：有界平台，不是「泄漏已修复」

1. **三条臂在负载后段全部不再上升**：`private_mb` 尾段斜率 A/B/C =
   −0.119 / −0.042 / −0.032 MB/min，负载后 10 分钟 = −0.003 / 0.000 / 0.000 MB/min；
   `ws_mb` 首末为负增长；线程与句柄在尾段/后段只有 ±10 的抖动。
2. **增长不在 Rust 侧**：`rust.live_bytes` 全程 ≤ 2.01 MB，`rust.peak_bytes` 恒为 ≈2.49 MB；
   而 `private_mb` 的差异是原生/系统资源。`db.page_count` 的增长与入库事件数一一对应
   （36,000 条 → 约 9,200 页 ≈ 38 MB），且**负载结束后完全持平**；WAL 稳定在 4.3–4.6 MB。
3. **A 臂存在一次性阶梯（原因未确认，如实登记）**：t≈77 s 时 `private_mb`
   11.2 → 45.0（+33.8）、线程 31 → 42、句柄 381 → 687，**但工作集没有上升**
   （负载末 `ws_mb` 反而从 32.2 降到 26.0），阶梯发生时 `cpu_pct≈0.00`，
   之后 39 分钟保持同一水平（尾段 −0.119 MB/min、后段 −0.003 MB/min）。
   同参数的 B/C 未复现（13.7 / 13.1 MB）。`rust.live_bytes` 同时只有 1–2 MB，
   因此这一步**不是 Rust 堆增长**，而是一次性原生提交（非驻留）。
   **本轮未定位到具体触发源**，按「一次性水平差异、非增长斜率」记录，不当作泄漏，
   也不将其平均抹平；复现该阶梯需要再跑一条同参数臂并做 ETW/句柄归因，属后续工作。
4. **通知路径未被本套件覆盖**：三臂 `notifications.attempted=0`（bench 来源按设计不产生
   系统通知），因此**通知/托盘相关内存没有测量证据**，见第十节遗留项。
5. **预算对照**：项目既有预算是「RSS 增长 < 200MB」（`docs/PERFORMANCE_ACCEPTANCE_REPORT.md:23`、
   `docs/PERFORMANCE_TESTING.md:115`，v0.4 场景 E）。本轮首末增长：
   `ws_mb` A −5.6 / B −16.5 / C −17.2 MB；即使按更严格的 `private_mb` 计，
   A +35.0 / B +2.2 / C +2.8 MB —— 均远低于 200 MB 预算。
   **未新造宽松阈值**：判定沿用既有预算，其余指标只作趋势证据。

**P1-04 判定：内存稳定性达到「可解释、可验证的预算」——30 分钟负载 + 10 分钟静置内为有界平台，
Rust 堆无增长、数据库增长可解释且负载后停增、线程/句柄不单调上升。**
不宣称「绝对无泄漏」：40 分钟窗口无法证明更慢的泄漏不存在，A 臂一次性阶梯与通知路径
是两个已列明的证据缺口。

---

## 六、剪贴板＋Agent 真实联合负载（P1-05）

> 本节要求：负载期间产生**真实 Windows 剪贴板变更事件**（`WM_CLIPBOARDUPDATE`），
> 绝不用向队列塞模拟事件替代。负载期间的每一次剪贴板写入都由
> `scripts/acceptance/clipboard_stimulus.py` 以纯 ctypes 调用真实
> `OpenClipboard/EmptyClipboard/SetClipboardData` 完成，并逐次校验格式可用性。

### 6.0 执行定位（三个层面分开判定）

| 层面 | 本臂（30 分钟长跑） | 说明 |
|---|---|---|
| 后端负载 | **已完成** | 4 Agent × 5 事件/s × 1800 s = 36,000 条，全部 200 |
| 真实剪贴板 | **已完成** | 600 次文本 + 60 次图片真实写入，0 次 OpenClipboard 失败 |
| GUI 交互 | **未在本臂执行** | 本臂窗口 `minimized`，长跑期间不做人工/GUI 操作；GUI 在 §6.3 的独立可见窗口短程联合跑中执行 |

长跑与 GUI 跑分开的原因：30 分钟整臂需要最小化窗口以避免干扰用户桌面，
而“真实 GUI 操作”必须可见、可观察；把两者放进同一条臂会让 GUI 证据不可复现。

### 6.1 方法与证据

| 项 | 值 |
|---|---|
| 被测产物 | `task-dock-p105.exe`（09:20:15 的 Release 副本，15,792,128 B，`sha256=8900bd9d…`；第四轮 P1-05 专用构建） |
| 场景 | `memory-scenario.py --duration 1800 --post 600 --agents 4 --rate 5 --port 47861 --window minimized --clipboard-stimulus on --clipboard-interval 3 --clipboard-image-every 10` |
| 数据隔离 | `TASK_DOCK_DATA_DIR=…/joint-clipboard-rerun-20261031-0943-data`（独立实例、独立数据库与资产目录） |
| 激励器 | 每 3 s 写一次 `CF_UNICODETEXT`（`taskdock-p1-05-clipboard-probe-N`）；每第 10 次**额外**写入图片：注册格式 `PNG` 为主、`CF_DIBV5` 为辅；图片为确定性 RGBA（左不透明蓝 / 中半透明绿 / 右全透明黑） |
| 结束处理 | 结束后尽力恢复原剪贴板（原格式 `text`，恢复成功 `restored=true`）；正文不落盘、不写日志 |
| 运行时间 | 2026-10-31 09:43:06 启动，负载至 10:13:06，静置观察至 10:23:06；采样 482 个有效样本 |
| 有效性 | `meta.error=null`、`instance_exited_after_s=null`；采样器每样本 `taskdock.count=1`（无同名进程混入）；结束时进程被 `taskkill /T /F` 强制结束（`instance_exit_code=1` 是强杀结果，不是中途退出） |
| 环境干扰（如实记录） | 并行会话的 `task-dock-memaf.exe` PID 33848 同时运行；并行会话在 09:46:33–09:51:25 跑 clippy、09:53:05–10:01:11 跑 release 构建，与本臂争用 CPU/磁盘 |

原始证据：
`docs/performance/results/DIAG-joint-clipboard-rerun-20261031-0943-20261031-094304-(app.log|stimulus.json|load.json|meta.json|.jsonl)`、
分析 `analysis-joint-clipboard-rerun-20261031-0943.json` / `phases-joint-clipboard-rerun-20261031-0943.json`、
锁采样 `docs/clipboard/evidence/p1-05-rerun-20261031-0943/lock-sampler.jsonl`。

### 6.2 对账结果

#### 6.2.1 激励与采集

| 指标 | 结果 |
|---|---|
| 文本写入 | 600 attempted / **600 ok / 600 verified**（写后 `IsClipboardFormatAvailable` 校验）/ 0 failed |
| 图片写入 | 60 attempted / **60 ok / 60 verified** / 0 failed（辅助 `CF_DIBV5` 60 次全部写入） |
| OpenClipboard 失败 | **0**（`open_failure_blockers={}`，没有占用进程被记录） |
| 剪贴板序列号 | 9436 → 12773，`delta=3337`。这是**系统级**序列号增量，包含其他应用的真实复制与本应用写入，不能除以激励次数解释（3337/660≈5.06 只说明期间其他剪贴板活动频繁） |
| 原剪贴板 | 原格式 `text`，结束恢复成功（`restored=true`, `restored_kind=text`） |
| 激励器版本边界 | 本次进程启动于 09:43:18，加载的是 09:45:08 加入 `started_at/interval` 字段**之前**的脚本版本，因此 JSON 中没有精确写入时刻；绝对入库延迟在 §6.3 的修复版短程跑中给出 |

#### 6.2.2 入库、去重与分组

| 指标 | 结果 |
|---|---|
| 数据库条目 | **667** 条 = 595 文本 + 65 图片 + 7 富文本 |
| 激励派生条目 | **655 / 660（99.24%）**：文本 595/600、图片 **60/60** |
| 激励之外的真实复制 | **12 条**（5 张真实截图 + 7 段富文本，来自系统内其他应用）。这 12 条是真实用户剪贴板活动被真实采集，**内容未写入任何日志或报告** |
| 日志记录行 | 672 行（`created=true` 667 + `created=false` 5）→ 与库内 667 条、5 条哈希去重完全对上 |
| 事件处置 | `skipped=4`、`dropped=0`、`superseded=0`、`mismatch=0`、`store_failed=0`、`config_unreliable=0` |
| 自动分组 | 5 个自动分组（均 `closed`），640/667 条入组，`group_origin` 全为 `auto` |
| 资产 | 65 张原图 + 65 张缩略图，`assets_missing=0`；资产字节 406,479 + 95,360 B |

**5 条文本探针未入库的原因（不掩饰）**：缺失索引为 **110、227、228、229、233**。
索引 110 是图片节拍（该拍文本写完后立刻被同一拍的图片覆盖）；227–233 落在
09:54:24–09:54:42，与并行会话 release 编译的高 CPU 时间窗重合。
Windows 剪贴板只保留**最新状态**，采集线程在积压时按设计合并旧事件
（`platform.rs` 的 drain-merge：只读取最新一次状态，绝不回放/伪造中间版本），
因此这些文本在被读取前已被后续写入覆盖。内容队列丢弃为 **0**，
不是内部丢弃或静默失败；该臂未持久化 `merged_events` 计数器，
计数器级证据由 §6.3 的短程跑提供。图片是关键负载，60/60 全部入库。

**图片像素/字节验收**：60 张激励图片的入库资产与按同一 seed 重算的 PNG
**60/60 字节一致（sha256 相等）**，`missing_files=0`；另 5 张外部真实截图
不在激励集合内、不参与比对。这证明入库的就是当时真实写入系统剪贴板的
PNG（含半透明/全透明 Alpha 像素），不是解码后重编码的近似图。

#### 6.2.3 延迟、锁与资源

| 指标 | 结果 |
|---|---|
| 入库延迟（相对最快样本，消除首条冷启动偏移） | p50 **1.9 ms**、p95 **85.6 ms**、max **3602 ms**（595 个样本） |
| 延迟尖峰 | 前 5 个最慢样本集中在 09:48:35–09:49:03，与并行 clippy（09:46:33–09:51:25）争用 CPU 的时间窗一致；无负值样本 |
| 首末记录一致性 | 库内 `created_at` 首 01:43:18.713 / 日志首 01:43:18.719；库内末 02:22:39.813 / 日志末 02:22:39.818（UTC，差 ≤6 ms） |
| Agent 负载 | `accepted 36,000 / 36,000`、`requests 36,431`；`rejected_auth/concurrency/overload/parse=0`、`internal_errors=0` |
| 管道 | `received 36,009`、`processed 21,304`、`merged 14,705`、`batches 4,441`；`commit_failures=0`、`overload_rejects=0`、队列深度 0、最大批 12 |
| Agent 端到端延迟 | ingest p50 **254.07 ms** / p95 **276.96 ms** / max 296.92 ms |
| 数据库写延迟 | p50 **6.79 ms** / p95 **56.65 ms** / p99 161.53 ms / max **780.4 ms**（并行构建期间）；`wal_bytes` 稳定 4.43→4.68 MB |
| DB 锁等待 | 应用日志 `database is locked` **0 条**；`db.read` 10,418 次、avg 1.36 ms、>100 ms 慢查询 17 次（0.16%）；数据库 42.5 MB、10,393 页 |
| 剪贴板占用 | 锁采样 484 次，**0 次** 被其他进程持有；激励器 OpenClipboard 失败 0 次 |
| CPU | 主进程 mean **0.029%**、p95 0.12%、max 0.44%；WebView2 进程树 mean 0.018%（最小化窗口） |
| 通知 | 本次负载按 bench 来源设计不产生系统通知（`attempted=0`）；提醒/通知链路在 §6.3 用真实提醒单独验证 |

#### 6.2.4 内存（联合负载臂，30 min 负载 + 10 min 静置）

| 指标 | warmup | load | load 尾 1/4 | post（10 min） |
|---|---|---|---|---|
| `taskdock.private_mb` | 42.8 → 45.4 | 45.4 → **49.2**（+3.8） | **+0.004 MB/min** | 49.2 → 47.8（**−0.062 MB/min**） |
| `taskdock.ws_mb` | 74.6 → 78.2 | 78.2 → 18.6 | −0.116 MB/min | 18.6 → 17.5（−0.128） |
| `threads` | 47 → 46 | 46 → 39 | −0.02/min | 39 → 37 |
| `handles` | 692 → 716 | 716 → 734 | +0.22/min | 734 → 732（−0.02） |
| `rust.live_bytes` | 1.34 → 1.56 MB | 1.56 → 1.41 MB | −8.2 KB/min | 1.4056 → 1.4065 MB（**持平**） |
| `rust.peak_bytes` | 2.59 MB | 2.59 → 4.57 MB | 持平 | 4.57 → **5.33 MB**（高水位上升，live 不动） |
| `db.page_count` | 121 → 340 | 340 → 10,393 | — | 10,393 → 10,414（21 页） |
| `db.wal_bytes` | 0.39 → 4.43 MB | 4.43 → 4.68 MB | 持平 | **持平** |

解读：负载期私有内存 +3.8 MB 后在尾段与静置段**停止增长**（post 为负斜率），
Rust 堆 live 全程 1.34–1.65 MB 且 post 持平；`rust.peak_bytes` 的高水位
在 post 从 4.57 升到 5.33 MB，但 live 不变，属分配器高水位（同一量级，
远小于 200 MB 既有预算），不构成增长趋势。线程/句柄在 post 段回落或持平。
数据库增长与 667 条入库 + 36,000 条 Agent 事件一一对应，静置段只多 21 页。

### 6.3 可见窗口 GUI 联合验收（短程）

> 待执行：在重建的最终 Release 上以可见窗口运行 240 s 真实剪贴板 + Agent 负载，
> 同时用 CDP 驱动真实抽屉/搜索/图片详情/返回/关闭、真实提醒、真实历史清理，
> 并读取 observed/captured/recorded/dropped/merged 计数器与 UI 操作 p95。

### 6.4 判定

- **后端负载 + 真实剪贴板（30 分钟）**：**完成且通过**。36,000/36,000 Agent 事件成功；
  600/600 文本、60/60 图片真实写入；60/60 图片入库字节一致；0 队列丢弃、
  0 入库失败、0 配置不可靠、0 DB 锁等待；私有内存有界平台。
- **5/600 文本探针被覆盖**：按最新状态语义解释（不是内部丢弃），并在 §6.3 用
  计数器复核；不把它平均抹平，也不据此宣称“100% 文本完整”。
- **GUI**：长跑臂未执行（最小化）；待 §6.3 可见窗口短程跑结论。

---

## 七、Windows 前台聚焦测试的处理（P2-06）

**真实契约**（读代码确认，而不是猜测试名字）：
`launch_disallowed_reports_failure_or_focus_only` 与
`notepad_launch_focuses_existing_window_of_owned_process` 的产品契约分两层：

- **A 层（与 OS 前台资格无关，任何时候都必须成立）**：
  目标窗口已存在时，决策必须是 `focus_window`、**不得再启动新进程**、
  失败原因必须如实（不得谎报成功）；
- **B 层（真正把窗口带到前台）**：需要本进程此刻具备设置前台的资格，
  被系统前台锁拒绝时**如实登记 ENVIRONMENT-BLOCKED**，不删断言、不伪造焦点成功。

**测试实现的改进**（`src-tauri/src/navigation/router.rs`）：

- 两个测试都改为**自己拉起记事本子进程**（`spawn_owned_notepad`），
  只针对本测试子进程自己的窗口做断言，**绝不触碰用户已打开的记事本窗口**；
- `NOTEPAD_TEST_LOCK` 串行化两个测试，避免互相抢前台；
- 清理由 `OwnedProc::Drop` 完成：只杀自己子进程树（父 PID 匹配 + 镜像名匹配）；
- 前提不成立（拉不起子进程 / 窗口不归属本进程 / 解析不到 exe）时
  登记 `ENVIRONMENT-BLOCKED` 并**如实说明原因**，不做任何清理动作；
- A 层断言始终保留：新增进程 PID 列表必须为空、`actual_action` 必须是 `focus_window`、
  失败原因必须恰好是 `FocusError::ForegroundDenied`。

**本轮复跑结果**（真实交互桌面，无环境阻塞）：
`cargo test --lib navigation::router` → **10 passed / 0 failed / 0 ignored**，
两个聚焦测试均为 `ok`（不是 skip，也不是无条件跳过）。
证据：`docs/clipboard/evidence/p2-06-focus-tests-fourth-round-20261030.log`。

**前轮 ENVIRONMENT-BLOCKED 记录保留**（原样，不改写）：
`docs/clipboard/evidence/p2-06-focus-tests-ownwindow-20261030-1452.log`、
`p2-06-focus-tests-after-fix-20261030.log` —— 那两轮确实是
「Win11 记事本单实例多标签：已存在他人记事本进程，本次 spawn 不会拥有窗口归属」，
属环境阻塞而非产品缺陷；本轮在无其他记事本实例的桌面上**真实通过**，
说明当时的阻塞判定是准确的，不是把失败伪装成通过。

---

## 八、本轮新增的回归测试

| 模块 | 新增/修改测试 | 覆盖的风险 |
|---|---|---|
| `db::tests` | `clipboard_repair_fault_after_writes_rolls_back`、`clipboard_repair_database_write_failure_rolls_back_backup`、`clipboard_repair_process_death_rolls_back_on_reopen`、`clipboard_repair_blocks_monitor_until_commit_without_resume`、`clipboard_repair_blocks_monitor_until_commit_with_resume`、`clipboard_repair_backs_up_raw_values_and_requires_explicit_resume`、`clipboard_repair_missing_switch_is_conservative`、`clipboard_repair_does_not_write_when_database_broken` | P0-01 半修复状态 |
| `db::tests` | `clipboard_fresh_install_seeds_defaults_and_marks_origin`、`clipboard_legacy_upgrade_starts_paused`、`clipboard_missing_config_never_reenables_across_restarts`、`clipboard_partial_missing_is_not_filled_on_restart`、`clipboard_user_disabled_survives_key_loss_and_repair_only` | P1-02 缺失键 |
| `clipboard::image::tests` | `fully_transparent_png_is_treated_as_opaque`、`transparent_png_from_clipboard_is_reencoded_visible`、`legitimate_transparent_png_without_dib_provenance_is_preserved`、`partially_transparent_png_is_never_normalized`、`opaque_clipboard_png_is_kept_byte_identical`、`dib_32bpp_bi_rgb_with_zero_alpha_is_visible`、`dib_32bpp_with_real_alpha_keeps_transparency`、`dib_bitfields_without_alpha_mask_is_visible`、`dib_bitfields_with_alpha_mask_keeps_transparency`、`malformed_dib_is_not_reported_as_alpha_unused` | P1-03 Alpha 语义 |
| `clipboard::platform::tests` | `event_disposition_separates_read_superseded_and_self_write` | 采集事件三态去重与归因 |
| `clipboard::paste::tests` | `cancel_preserves_unprocessed_items_and_still_finishes`、`worker_slot_waits_for_thread_to_finish`、`worker_slot_reports_timeout_for_stuck_thread`、`worker_slot_clears_itself_when_thread_ends` | §九-6 取消保留未处理项、§九-8 退出无遗留线程 |
| `commands::restore::tests` | `bundle_with_stale_clipboard_switches_keeps_local_preference` | §九-10 恢复不意外开启记录 |
| `commands::backup::tests` | `directory_target_is_never_replaced_by_backup_file` | 备份目标为目录时不得被顶替 |
| `navigation::router::tests` | `launch_disallowed_reports_failure_or_focus_only`、`notepad_launch_focuses_existing_window_of_owned_process`（改造为自拉起记事本） | P2-06 |

### 8.1 §九 其余可靠性边界审查（10 条逐条核实）

审查方式：**先在当前源码里逐条核实，再决定改不改**；
只修与本轮可靠性目标相关的真实缺陷，不扩大为全项目重构。
每条都给出「结论 + 代码位置 + 依据」，无法用代码证明的写明证据缺口。

| # | 审查项 | 结论 | 依据（源码位置） |
|---|---|---|---|
| 1 | `EmptyClipboard` 成功但主格式写入失败 → 原内容是否丢失 | **不会丢失**（无法比较时留空而非猜写） | `platform.rs:1586`–`:1622`：清空前先在锁内取 `fallback`（`WriteGuard::Content` 直接带内容，序列号守卫现场读一次）；写入失败且已清空 → 回写 `preserve`；`preserve=None` 时只记 warn，**不写残缺内容**。回归测试 `only_comparable_forms_can_be_put_back_after_failed_write` |
| 2 | 部分格式成功、部分失败 → 是否有明确状态 | **有** | `platform.rs:1407` `write_formats_with`：必需格式失败 → 整体 `Err`；辅助格式失败 → 记入 `degraded` 并从实际形态里剔除该字段，后续比对以实际形态为准。`WriteOutcome::Written{seq, effective, degraded}` 显式携带状态 |
| 3 | 剪贴板恢复与自写登记是否一致 | **一致** | `platform.rs:1644` `restore_if_own_content`：恢复前用**内容**比较（`content_matches_open`），序列号增长不作为恢复依据；用户已接管 → `RestoreOutcome::KeepUserCopy`；恢复成功才 `note_self_write_watermark`（`finish_restore`），失败**不登记**。测试 `restore_registers_self_write_only_on_success` |
| 4 | 序列号极端回绕 → 是否误判事件 | **不会** | `platform.rs:555` `sequence_after` 用回绕差比较（`(candidate.wrapping_sub(reference) as i32) > 0`）；`note_self_write_watermark`（`:602`）在回绕时前进水位、但拒绝把水位拉回回绕前的旧通知。测试 `sequence_wrap_does_not_pin_self_write_watermark`；本轮新增 `event_disposition_separates_read_superseded_and_self_write` 另覆盖回绕后的放行与去重 |
| 5 | 图片资产清理与活动粘贴任务是否竞争 | **会触达同一批数据，但安全** | 资产表 `clipboard_assets.item_id ... ON DELETE CASCADE`（`db/mod.rs:379`）：条目行先删、资产行随级联删除，**文件只在失去引用后才被删**（`store.rs:811` `remove_files_unreferenced`）；粘贴侧 `load` 取不到内容时按「内容不可用，已跳过」处理并从 `remaining` 移除（`paste.rs:333`–`:351`），不崩溃、不虚报已发送 |
| 6 | 任务取消时是否保留未处理项目 | **保留** | `run_plan` 的 `remaining` 始终记录未发送项；取消置 `status="cancelled"` 后把剩余项写回任务表（`paste.rs:1206` `update_paste_job`），可 `resume` 续发且累计 sent/total 不变。测试 `cancel_preserves_unprocessed_items_and_still_finishes`、`paste_job_tracks_remaining_and_interruption` |
| 7 | Agent 高频更新时是否出现重复订阅 | **不会** | 后端把 Agent 变化**聚合成批**后一次发 `agent-changed`（后端 `agents/mod.rs:1219` / `:1395`；前端入口 `bridge.ts:1194`）；前端两个消费方（`App.tsx:109`、`HistoryPanel.tsx:203`）都用 `createSubscriptionScope()`（`subscriptions.ts:21`）在卸载时统一退订，且对刷新做节流+单飞+合并；`changed===false` 直接忽略。前端测试 `HistoryPanel.test.tsx` 覆盖「挂载期间建立的监听在卸载时释放」与「卸载后才兑现的监听 Promise 会被立即反订阅」 |
| 8 | 应用退出时是否有遗留工作线程 | **无**（本轮前已修） | `WorkerSlot`（`paste.rs:661`）登记句柄、线程结束自清理、`wait(timeout)` 按时限等待；`ClipboardRuntime::shutdown(timeout)`（`clipboard/mod.rs:332`）= `stop()` + `paste.stop(timeout)`。测试 `worker_slot_waits_for_thread_to_finish`、`worker_slot_reports_timeout_for_stuck_thread`、`worker_slot_clears_itself_when_thread_ends` |
| 9 | 剪贴板配置修复失败是否可能留下半修复状态 | **不会**（本轮前已修为事务） | 见第二节：`repair_clipboard_tx` 的「读→备份→写→校验→提交」全在一个 `IMMEDIATE` 事务内，校验失败即回滚。回归测试 `clipboard_repair_fault_after_writes_rolls_back`、`clipboard_repair_process_death_rolls_back_on_reopen` |
| 10 | 备份恢复后是否保留剪贴板关闭/暂停偏好 | **保留**（本轮前已修） | `commands/backup.rs` `LOCAL_PRIVACY_SETTINGS = ["clipboard_enabled", "clipboard_paused"]`；`commands/data.rs:1823` 导入/恢复路径遇这两个键直接 `continue`，**绝不写回备份里「备份那一刻」的旧开关值**。测试 `bundle_with_stale_clipboard_switches_keeps_local_preference`（先断言备份里确实带着 `clipboard_enabled=true`，避免空转） |

**本轮由此产生的代码改动**：仅第 4.3 节描述的采集事件可观测性改造
（`platform.rs` 的 `ClipboardRead` 形态 + `classify_event` + 三个新计数器）
——它由一次**真实的验收失败**驱动（`observed=6` 但 `captured=4` 且无任何计数/日志可解释），
不是预防性重构。其余 9 条均已满足契约，只补证据与测试，不改行为。

---

## 九、工程门禁

> 记录每条门禁的命令、开始/结束时间、退出码、通过/失败/忽略数与原始输出路径。

---

## 十、实际发布阻断项

---

## 十一、最终验收结论
