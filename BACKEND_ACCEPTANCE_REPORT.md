# Task Dock 后端 P0/P1 缺陷修复与回归验收报告

- **验收对象**：`src-tauri/src/` 后端（Rust/Tauri/SQLite）
- **基线**：`d7b21fb`（Initial commit: Task Dock v0.3 desktop app）
- **验收日期**：2026-10-25
- **验收方式**：真实代码修复 + 真实命令执行 + 内存库/临时文件库集成测试 + 原始代码缺陷复现（git worktree）+ 真机抽查（`--agentctl scan`）。全程未使用模拟数据冒充测试结果。
- **环境**：Windows 10.0.22631 x64，Git Bash，rustc 1.85 / clippy 1.95，Node/vitest 3.2.7

---

## 1. 缺陷清单（编号 / 级别 / 根因）

### A. 数据导入与恢复

| 编号 | 级别 | 缺陷与根因 | 修复位置 |
|---|---|---|---|
| B-01 | **P0** | **导出缺表导致导入外键失败**。`collect()` 只导出 `agent_runs`，不导出 `agent_sessions/agent_sources/agent_instances/agent_events`；旧导入又先 `DELETE FROM agent_sessions` 再插 `agent_runs`，任何含 Agent 数据的导出文件导入必报 `FOREIGN KEY constraint failed`。 | `commands/data.rs` `collect()`：单只读事务内导出全部 13 张表（v2 格式） |
| B-02 | **P0** | **导入用 `serde_json::Value` 绑定参数**。rusqlite 会把 `Value::Bool` 序列化成 JSON 文本绑入：`fired`/`is_read` 落库为 TEXT `'true'/'false'`，与 `fired = 0` 比较永假——导入后的提醒永不触发、已读状态失效。 | `commands/data.rs` 强类型行结构（`TaskRow` 等 12 个）+ `rusqlite::params!` 原生绑定（`fired as i64` 等），并有 `typeof(fired)='integer'` 断言测试 |
| B-03 | P1 | **导入前无结构/必需字段/引用完整性校验**；导入后设置应用用 `let _ =` 吞错（假报成功）。 | `parse_and_validate()`：逐表强类型反序列化（缺字段/类型错报「表[行号]」）、表内唯一性、reminder→task / task→rule / link→task / run→session / session·instance→source 全量引用检查；设置在导入事务内应用，非法键拒绝、未知键跳过并记录 |
| B-04 | P1 | **备份既非一致性快照也非原子写入**。`collect()` 分多次 `with_conn` 读取，与调度器并发会得到跨事务的混合数据；`std::fs::write` 直接覆盖目标文件，崩溃留半文件。 | `collect()` 单事务快照；`write_json_atomic()`（临时文件 + rename，Windows 先删后换）用于导出与备份 |
| B-01b | P1 | v0.3 已流出的 v1 导出文件（含 runs 无 sessions）按新逻辑会被拒收，用户数据无法恢复。 | v1 兼容：为孤儿 run 合成占位会话（`external_id=recovered-<id>`），v2 文件缺会话则明确报错（`import_v1_with_orphan_runs_synthesizes_sessions` / `import_v2_missing_sessions_is_rejected_and_original_preserved`） |

### B. 任务调度可靠性

| 编号 | 级别 | 缺陷与根因 | 修复位置 |
|---|---|---|---|
| B-05 | **P0** | **snooze 导致重复任务无法推进**。旧 `snooze_reminder` 删光未触发提醒、插一条 `kind='custom'`，而 `fire()` 只对 `kind=='due'` 调 `advance_recurrence` —— due 提醒被销毁后重复任务永久卡死，且 `tasks.remind_at` 被永久改写。 | `commands/tasks.rs` `snooze_reminder_inner()`：原地后移未触发提醒（保留 kind/occurrence），无可后移项时才补一次性 custom；不再覆盖任务配置。测试 `snoozed_recurring_task_still_advances` 证明 snooze → 到点 → 照常推进 |
| B-06 | **P0** | **提醒领取非原子**。旧 `fire()` 无条件 `UPDATE fired=1`（不查影响行数），且「标记/写通知/推进」分属多个隐式事务，与编辑/完成/删除命令竞争：可对已删除任务弹幽灵通知、重复触发、半推进。 | `scheduler.rs` `fire_reminder_core()`：单事务内 ①条件领取（`WHERE id=? AND fired=0`，rows=0 即放弃）②任务仍 pending 检查 ③通知去重写入 ④重复任务推进；OS 通知/广播移到提交后。测试 `reminder_claim_is_atomic_only_one_fires`、`reminder_for_completed_task_is_skipped` |
| B-07 | P1 | **停机/休眠多日追不回**。旧 `advance_recurrence` 每次只推一期，due 落在过去多期时任务连续多天显示过期。 | `advance_recurrence_tx()` 补偿循环（上限 2000 期）直到越过当前时刻；测试 `recurrence_catches_up_across_missed_days`（3 天前 due 一次推到未来） |
| B-08 | P1 | **任务写路径非事务 + 吞错**。`create/update/toggle` 的规则写入、任务更新、提醒重建分散多语句；`update_task` 删除旧规则用 `let _ =` 吞错，中途失败会被 `ON DELETE SET NULL` 静默吃掉任务的重复规则；`delete_task` 对不存在任务假报成功。 | `insert_rule_tx`/`rebuild_reminders_tx` 事务化；`create_task_inner`/`update_task_inner`/`toggle_task` 单事务；`delete_task`/`snooze` 对不存在任务返回 `NotFound`。测试 `update_task_removes_recurrence_and_rebuilds_in_one_tx` 等 |

### C. 数据库事务与迁移

| 编号 | 级别 | 缺陷与根因 | 修复位置 |
|---|---|---|---|
| B-09 | **P0** | **迁移非原子**。旧 `execute_batch(sql)` 与 `pragma_update(user_version)` 是两条独立语句；迁移中途崩溃（断电/磁盘满/被杀）留下「半套 DDL + 旧 user_version」，下次启动重放 v2 报 `table agent_instances already exists`，**数据库永久打不开**。 | `db/mod.rs` `apply_migrations()`：每个版本迁移 SQL + user_version 在同一 `BEGIN IMMEDIATE…COMMIT` 内，失败整体回滚可安全重试；新增迁移失败恢复测试。注意：`ALTER TABLE ADD COLUMN` 为增量 DDL，兼容全部 v1/v2 既有库，**不清空任何用户数据**（真机库已验证：迁移后 15 runs / 15 events / 9 sessions 原样保留） |
| B-10 | P1 | **来源删除外键冲突**。`agent_sessions/agent_instances` 外键引用 `agent_sources`，旧 `delete_source(also_delete_data=false)` 直接删来源 → 一旦来源有过事件必报 FK 错误，永远删不掉。 | `commands/agents.rs` `delete_source`：FK 绑定观测数据（runs/sessions/instances）总是随删保证可删；`agent_events` 按 `also_delete_data` 决定去留；用户任务与 `task_agent_links` 永不级联 |

### D. Agent 事件状态机

| 编号 | 级别 | 缺陷与根因 | 修复位置 |
|---|---|---|---|
| B-11 | **P0** | **服务端信任客户端声明的 transport**。旧代码直接落库 `ev.transport`，并据此决定 verified：HTTP 客户端声明 `transport:"mock"` 即可隐藏验证记录（不置 verified、流水标 mock），声明任意值也无从核实。 | `agents/mod.rs` 新增 `Transport` 枚举，`ingest_core(conn, ev, now, transport)` 的 transport 一律由服务端按接入入口传入（Http/File/Hook/Plugin/Mock/Manual），载荷声明仅作兼容不采信。测试 `client_declared_transport_is_not_trusted` |
| B-12 | **P0** | **self-test/mock/manual 数据污染验证状态**。旧 verify 管线的 `taskdock-selftest-*` 事件经 HTTP 到达即把来源 verified 置 1——自测事件被当成真实会话联调证据（v0.2 刚修过 codex 预置 verified 的同类问题）。 | 三层分离：`event_received`（任何事件记录流水）/ `transport_verified`（真实通道打通，自测可证明）/ `verified=natural_session_verified`（真实通道 + 非自测会话）。v3 迁移新增 `agent_sources.transport_verified` 列；自测会话 `evidence_type='selftest'`、不建实例、不置 verified。测试 `selftest_events_isolated_from_real_sessions_and_verification`、`manual_transport_never_verifies_source` |
| B-13 | **P0** | **终态后重连（同 external_run_id）撞唯一索引**。旧状态机对「终态后更晚发生的活跃事件」开新轮次，但同 `(source_id, external_run_id)` 受部分唯一索引约束 → `INSERT` 必然 `UNIQUE constraint failed`，**整个事件接入报错失败**。 | `is_new_round` 且带 run_id 时改为**重开原轮次**（状态回活跃、`ended_at=NULL`）；无 run_id 才开新行。测试 `reconnect_after_terminal_with_same_run_id_reopens_run`；跨来源同 run_id 由索引天然隔离（`same_run_id_across_sources_never_conflicts`）；缺失 run_id 多会话不冲突（既有测试） |
| B-17 | P1 | **Hook 验证会话名固定**。旧 verify 用固定 `taskdock-selftest-<source>` 会话，轮询查询可能匹配到历史自测事件，把陈旧记录误判为本次验证通过。 | `managed.rs` `verify_hook_pipeline`：每次验证生成唯一 nonce 会话（`taskdock-selftest-<source>-<uuid12>`）并按 nonce 精确匹配本次事件 |

### E. 接入与异常处理

| 编号 | 级别 | 缺陷与根因 | 修复位置 |
|---|---|---|---|
| B-14 | P1 | **批量上报部分成功语义**。旧 HTTP 数组端点逐条 ingest（一条被拒不影响其余，部分落库）；文件投递数组同样半处理。 | `AgentHub::ingest_batch()`：全部事件单事务，任一失败整体回滚。HTTP 批量：任一元素非法或被拒 → 4xx 且 accepted=0；文件投递：任一元素非法整文件进 failed/，不落一条。测试 `batch_ingest_is_all_or_nothing` |
| B-15 | P1 | **设置无校验**。`update_settings` 接受任意值（theme="banana"、http_port=99999、布尔传字符串静默入库），未知键被静默忽略（假报成功）。 | `commands/settings.rs` `validate_setting()`：枚举（theme/mode/material）、布尔严格类型、端口 1..=65535、时长/天数范围；先整体校验再写入；未知键报 `Validation` 错误。3 组测试 |
| B-16 | P2 | **主线程材质调用无限等待**。`run_material` 用 `rx.recv()` 阻塞，主线程卡死/退出时命令永久挂起。 | `rx.recv_timeout(2s)` |

### 顺带修复（不改变语义）

- clippy `-D warnings` 清零：`from_str` 更名 `parse`、冗余闭包/字段名、`&PathBuf→&Path`、三个 Adapter 补 `Default` 等（codex/qoder/trae/hooks_install/nlp/lib 等文件的小改）。
- 既有测试断言未弱化；`mock_vs_real_events_distinguishable` 等原测试全部保留并通过。

---

## 2. 修改文件与关键代码位置

| 文件 | 关键位置 |
|---|---|
| `src-tauri/src/db/mod.rs` | `MIGRATIONS` v3（transport_verified 列）、`apply_migrations()` 原子迁移、测试 `migration_failure_rolls_back_atomically_and_can_retry` |
| `src-tauri/src/scheduler.rs` | `fire_reminder_core()`（原子领取+单事务）、`advance_recurrence_tx()`（补偿推进）、4 项新测试 |
| `src-tauri/src/commands/tasks.rs` | `snooze_reminder_inner()`、`update_task_inner()`、`insert_rule_tx`/`rebuild_reminders_tx`、6 项新测试 |
| `src-tauri/src/commands/data.rs` | 全量重写：12 个强类型行结构、`collect()` 快照导出、`parse_and_validate()`、`import_value()` 单事务、`write_json_atomic()`、6 项新测试 |
| `src-tauri/src/agents/mod.rs` | `Transport` 枚举、`ingest_core(…, transport)`、selftest 隔离与三层验证、终态重连重开、`AgentHub::ingest/ingest_batch/after_ingest`、6 项新测试 |
| `src-tauri/src/agents/http_ingest.rs` | 服务端通道判定 + 批量全成功/全失败（200 全收 / 400·422 全拒） |
| `src-tauri/src/agents/file_drop.rs` | 批量整批原子处理 |
| `src-tauri/src/agents/mock.rs` | `Transport::Mock` 显式传入 |
| `src-tauri/src/agents/managed.rs` | `verify_hook_pipeline` 唯一 nonce |
| `src-tauri/src/commands/agents.rs` | `delete_source` FK 语义修复 |
| `src-tauri/src/commands/settings.rs` | `validate_setting()` 白名单校验 + 3 项测试 |
| `src-tauri/src/commands/system.rs` | `run_material` 超时 |
| 其余（codex/trae/qoder/dsh/opencode/workbuddy/discovery/hooks_install/nlp/lib/models/mod） | clippy 清零与 fmt 格式化，无行为变更 |

> 注：工作区同时存在并行 UI/UX 工作流的改动（`tauri.conf.json` 托盘图标、`src/styles.css`、`discovery.rs`、`UI_UX_ACCEPTANCE.md`、`docs/screenshots/` 等），不属于本次后端验收范围，未纳入评审；后端全部命令在该合并工作树上执行并通过。

---

## 3. 实际执行的命令与结果

| 命令（cwd=src-tauri 除 npm 外） | 退出码 | 结果 |
|---|---|---|
| `cargo fmt --all -- --check` | **0** | 格式全部合规 |
| `cargo clippy --all-targets -- -D warnings` | **0** | 0 error / 0 warning（修复前 16 个 error） |
| `cargo check` | **0** | 通过 |
| `cargo test` | **0** | **80 passed, 0 failed**（基线 53 + 新增回归 27） |
| `npm test`（cwd=repo） | **0** | 4 文件 **37 passed** |
| `npm run build`（tsc --noEmit && vite build） | **0** | tsc 无错误，vite 产物 321.70 kB js / 31.49 kB css |
| `cargo build` + `./target/debug/task-dock.exe --agentctl scan` | **0** | 真机发现扫描成功（见 §5） |

### 新增回归测试（27 项，对应需求清单）

- **数据库往返恢复**：`export_import_export_roundtrip_is_consistent`（export→import→export 语义一致、`typeof(fired)='integer'` 原生类型断言、全表恢复计数、http_token 不外流）；`import_preserves_local_http_token_and_registry`
- **迁移失败恢复**：`migration_failure_rolls_back_atomatically_and_can_retry`、`v3_adds_transport_verified_column`
- **提醒竞争**：`reminder_claim_is_atomic_only_one_fires`、`reminder_for_completed_task_is_skipped`
- **重复任务 snooze**：`snoozed_recurring_task_still_advances`、`snooze_keeps_due_reminder_and_occurrence`、`snooze_with_no_pending_reminder_inserts_one_shot`、`snooze_unknown_task_returns_not_found`
- **跨日期/异常重启**：`recurrence_catches_up_across_missed_days`、既有 `restart_recovery_and_history_preserved`、`agent_sudden_exit_marks_disconnected_once`
- **Agent 乱序与验证**：`reconnect_after_terminal_with_same_run_id_reopens_run`、`same_run_id_across_sources_never_conflicts`、`selftest_events_isolated_from_real_sessions_and_verification`、`client_declared_transport_is_not_trusted`、`manual_transport_never_verifies_source`、`batch_ingest_is_all_or_nothing`、既有 `terminal_state_is_protected_from_late_running`/`missing_run_id_creates_separate_runs_without_conflict`/`task_completion_unaffected_by_agent_events`
- **导入校验**：`import_v1_with_orphan_runs_synthesizes_sessions`、`import_v2_missing_sessions_is_rejected_and_original_preserved`、`import_rejects_wrong_types_and_missing_fields`、`import_rejects_dangling_references`
- **任务事务**：`update_task_removes_recurrence_and_rebuilds_in_one_tx`、`update_task_replaces_recurrence_with_new_rule`、`create_task_builds_due_and_advance_reminders`；**设置校验** 3 项

---

## 4. 修复前失败 → 修复后通过（回归证据）

在 `git worktree`（HEAD = 原始 v0.3 代码）中注入 5 个缺陷复现测试并运行 `cargo test`，**全部失败**，随后删除 worktree：

| 复现测试（原始代码上） | 结果 / 失败信息 | 对应新回归测试（修复后通过） |
|---|---|---|
| `repro_snooze_kills_recurrence_engine` | FAILED：snooze 后未触发 due 提醒数 = 0（期望 1），推进引擎无从工作 | `snoozed_recurring_task_still_advances` ✅ |
| `repro_export_omits_agent_tables_fk_broken` | FAILED：导出 JSON 无 `agent_sessions` 键（含 agent_runs → 导入必撞 FOREIGN KEY） | `export_import_export_roundtrip_is_consistent` ✅ |
| `repro_crashed_migration_cannot_recover` | FAILED：`Db::open` 报 `table agent_instances already exists`，数据库永久打不开 | `migration_failure_rolls_back_atomically_and_can_retry` ✅ |
| `repro_client_declared_transport_is_trusted` | FAILED：HTTP 事件落库 transport=mock、verified=0（客户端声明被采信） | `client_declared_transport_is_not_trusted` ✅ |
| `repro_selftest_event_pollutes_verification` | FAILED：自测事件把 codex verified 置 1 | `selftest_events_isolated_from_real_sessions_and_verification` ✅ |

无独立运行时复现、以代码路径证明并被新测试覆盖的缺陷：B-02（Value→TEXT 布尔绑定，rustqlite `ToSql for Value` 语义 + 新测试 `typeof` 断言）、B-06（无条件 UPDATE 竞争窗口）、B-08/B-10/B-13/B-14/B-15/B-16/B-17。

修复后全量：`cargo test` 80/80 通过（含上述全部回归测试），`npm test` 37/37 通过。

---

## 5. 真机（Windows）验证情况

已执行（真实环境，非模拟）：

- `task-dock.exe --agentctl scan`：真实识别本机 Codex 安装（`codex-cli 0.130.0-alpha.5`，`C:\Users\ASUS\AppData\Local\OpenAI\Codex\bin\codex.exe`）、`~/.codex` 配置目录、7 个官方 Hook 事件（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/Stop/Notification），来源健康读取自真实库（`verified=1`，历史真实事件 2026-10-25T13:51Z）。
- 真实用户库 `%APPDATA%\com.taskdock.desktop\task-dock.db` 经 v3 迁移：`user_version=3`，9 来源 / 9 会话 / 15 轮次 / 15 事件**全部保留**（未删除任何用户数据；仅增量 `ALTER TABLE ADD COLUMN`）。

**未验证**（具备条件时补充）：

- 真实 Agent 会话端到端事件（需要用户实际运行一次 Codex 会话触发 Hook；本轮为不干扰第三方 Agent 配置，未执行 `adapter install/verify` 写入操作）。
- 托盘后台长时间运行与物理休眠/唤醒（逻辑层已由补触发、补偿推进、stale 清理测试覆盖；物理实验未做）。
- HTTP 接入端点的真机联调（需完整 GUI 运行；鉴权/批量/回退逻辑已由单元与集成测试覆盖）。
- 新版安装包构建（`npm run tauri build` 未执行；`npm run build` 前端产物与 `cargo build` 后端调试产物均通过）。

## 6. 已知风险与遗留

1. `transport_verified` 列为新增，既有来源初始为 0，首次自测/真实事件后置位——UI 不应将其误读为「接入失效」。
2. 导入为**整体替换**语义（导入前自动备份到 backups/），通知历史导出上限 500 条；来源注册表采用 upsert 合并（库内已有而文件缺失的来源会保留）。
3. v1 导出文件恢复的 Agent 会话为占位会话（`recovered-*`），标题/状态不可复原。
4. Mock/Manual 通道永不参与验证置位（by design）；`--agentctl post` 走 HTTP 入口，属真实通道证据。
5. 并行 UI/UX 工作流改动与本报告后端改动同树共存，发布前需合并回归一次。

## 7. 结论

需求清单五类 P0/P1 缺陷（B-01/02/05/06/09/11/12/13 + P1 全部）均已修复并有失败→通过的回归证据；六项指定命令全部退出码 0（Rust 80 测试 + 前端 37 测试全绿，clippy -D warnings 清零）；真实用户数据库经增量迁移完好；未动用户数据库数据、未覆盖任何第三方 Agent 配置、未弱化任何断言。剩余未验证项均为需要真实 Agent 会话或长时间物理运行的环境项，不构成发布阻断，但建议发布前补做一次真实 Codex 会话联调。

**最终结论：有条件通过**（条件：发布前完成一次真实 Agent 会话端到端联调 + 托盘后台运行抽查，与并行 UI/UX 改动合并后重跑本报告 §3 全部命令）。
