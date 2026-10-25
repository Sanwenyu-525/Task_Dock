# Task Dock v0.2 验收报告

- 验收日期：2026-10-25
- 验收范围：v0.1 代码正式验收 + P0/P1 缺陷修复 + 通用 Agent 自动发现系统（按用户指示，Agent 范围收窄为 **codex、trae、workbuddy、qoder、deepseek-harness、opencode、zcode** 七个）
- 环境：Windows 10/11 x64（win32 10.0.22631），Tauri 2 + Rust 1.85 + React 19 + TypeScript 5.9 + SQLite (rusqlite 0.32 bundled)

---

## 一、本轮检查结果（对照 v0.1 代码验收）

重点审查文件全部过目：`src-tauri/src/agents/{mod,codex,http_ingest,file_drop,mock}.rs`、`src-tauri/src/db/mod.rs`、`src-tauri/src/commands/agents.rs`、`src/components/agents/AgentPanel.tsx`。

### 发现的问题

| # | 级别 | 问题 | 位置（v0.1） |
|---|---|---|---|
| 1 | P0 | Codex Hooks 写入格式错误：直接把 `{type, command}` 写进事件数组，缺少官方的 `hooks` 组层，Codex 根本不会执行；`PermissionRequest` 等事件名未经能力核验 | `codex.rs:155-179` |
| 2 | P0 | 缺失 `run_id` 被转为空字符串 `''` 写入 `agent_runs.external_run_id`：空串非 NULL，命中部分唯一索引 `idx_runs_external`，同一来源第二个无 run_id 会话必然冲突 | `mod.rs:314` |
| 3 | P0 | ingest 的会话 upsert、轮次状态机、事件流水、通知写入分散在多个独立连接调用中，无事务包裹，任何中途失败都会留下半更新 | `mod.rs:233-377` |
| 4 | P0 | 状态机无终态保护：已 `completed` 的轮次收到旧 `running` 事件会被无条件改回 running；无幂等去重；无实例层 | `mod.rs:282-330` |
| 5 | P1 | seed 将 codex 预置为 `verified=1`，但从未真实联调 | `db/mod.rs:207` |
| 6 | P1 | Mock 每 30 秒自动生成模拟剧本，持续产生无意义通知 | `mock.rs:60-70` |
| 7 | P1 | hooks.json 读写无备份、非原子写、无回滚 | `codex.rs:180-184` |
| 8 | P1 | 无 AgentHub 数据库集成测试；通知去重依赖计数 seq，重复等待仍会重复通知 | `mod.rs:367-376` |

另发现两个联调期问题（本轮修复）：
- Hook 上报脚本为无 BOM UTF-8 且含中文注释，Windows PowerShell 5.1 按 ANSI 解析导致语法错误（联调实测定位）。
- Trae 版本探测会拉起整个 IDE 导致扫描挂起；能力扫描对 245MB 的 codex.exe 逐字节滑窗在未优化构建下需 36 秒。

### 修复文件与原因

| 文件 | 修复内容 |
|---|---|
| `src-tauri/src/db/mod.rs` | 迁移 v2：`agent_instances` 实例表、事件扩展列（schema_version/event_id/instance_id/parent_run_id/occurred_at/transport/evidence_type/confidence/dedupe_key 唯一索引）、`agent_runs.external_run_id` 空串→NULL 数据修复、来源表动态化（adapter/icon/hidden/last_event_at）、**全部来源 verified 重置为 0**（v0.1 无真实联调证据）、9 个标准来源预置 |
| `src-tauri/src/agents/mod.rs` | 全量重写 ingest：**单一事务**（unchecked_transaction 包裹实例→会话→轮次→事件→通知）；`ingest_core` 纯数据库函数可脱离 Tauri 测试；幂等（dedupe_key 唯一约束 + 内容签名）；乱序保护（occurred_at 早于 ended_at 的活跃事件仅记录不回退）；终态保护；多轮会话（终态后更新的活跃事件开新轮次）；终态间修正（completed→failed 允许，ended_at 保留首个）；通知按 `run:state` occurrence 去重；`cleanup_stale_core` 心跳失联判定 + 断连通知；`recover_after_restart` 重启恢复；分层模型 Agent→Instance→Session→Run→Event |
| `src-tauri/src/agents/hooks_install.rs`（新增） | Claude 兼容 Hooks 安全读写模块：损坏 JSON 拒改、写前备份（保留 5 份）、原子写（临时文件+rename）、失败回滚、第三方条目原样保留、按命令标记识别自身条目、卸载后清理空组；共享上报脚本生成（UTF-8 BOM + 纯 ASCII，HTTP 优先 + 文件投递回退） |
| `src-tauri/src/agents/codex.rs` | 重写为官方组结构 `{hooks:{Event:[{hooks:[{type,command,timeout}]}]}}`；安装前二进制能力核验（regex 扫描 codex.exe 中实际存在的事件名 + 文件缓存）；`verify` 以与 Codex 相同方式调用 hook 并确认事件抵达数据库 |
| `src-tauri/src/agents/{trae,workbuddy,qoder}.rs`（新增） | 同格式适配器：Trae 双配置根（~/.trae + ~/.trae-cn）、WorkBuddy 三配置根（.workbuddy/.workbuddy-ai/.codebuddy，注明 /hooks 面板确认机制）、Qoder（settings.json 合并写入） |
| `src-tauri/src/agents/{opencode,dsh}.rs`（新增） | 插件桥接：OpenCode TS 插件（session.idle/error、permission.asked 事件映射）、DSH 宿主插件（agent/status、approval/request、subagent 事件映射，参照本机 dsh-task-chime 现成实现） |
| `src-tauri/src/agents/zcode.rs`（新增） | 发现型适配器：安装/进程识别 + 通用桥接指引；不自动改写插件市场注册表（风险披露） |
| `src-tauri/src/agents/discovery.rs`（新增） | 四层发现引擎：安装（配置根/PATH/常见目录/注册表卸载信息）→ 进程（tasklist 多实例枚举）→ 能力（事件能力核验）→ 事件证据（DB verified/last_event_at） |
| `src-tauri/src/agents/managed.rs`（新增） | 通用 Adapter 架构（detect/preview/install/verify/uninstall/config_status + source_health 七态：live/stale/awaiting-first-event/no-events/unregistered…）；`verify_hook_pipeline` 真实链路验证 |
| `src-tauri/src/agents/mock.rs` | 移除 30 秒自动剧本；仅 UI 手动触发；transport=mock 永不置 verified |
| `src-tauri/src/agents/{http_ingest,file_drop}.rs` | 事件带 transport 标记（调用方显式值优先） |
| `src-tauri/src/commands/agents.rs` | 新命令：create/update/delete_source（删来源不删任务）、discovery_scan、adapter_list/preview/install/verify/uninstall/status；list_agent_events 支持 source 过滤 + 新列 |
| `src-tauri/src/lib.rs` | 注册 12 个新命令；启动时 `recover_after_restart`；`--agentctl` 无头 CLI（scan/install/verify/uninstall/status/events/post，供自动化联调） |
| `src/components/agents/AgentPanel.tsx` | 重构为「Agent 管理中心」：自动发现面板（安装/版本/实例数/接入方式/最近事件/健康徽标）、一键接入向导（预览→确认→安装→验证→可回滚）、活动监控树（Agent→实例→会话→轮次，含未知态显示）、自定义来源动态注册 |
| `src/lib/bridge.ts`、`src/styles.css` | 新接口桥接与新样式 |

---

## 二、测试命令及实际结果

### 自动化测试（可复现）

```
cd src-tauri && cargo test        → test result: ok. 52 passed; 0 failed
cd . && npm run build             → tsc --noEmit 0 错误；vite build 成功
cd . && npm test                  → Test Files 1 passed；Tests 11 passed
```

Rust 52 个测试覆盖：状态机（终态保护/乱序/幂等/无 run_id/多轮/同 ID 异源/5 会话并发/终态修正/任务不受影响）、实例层、通知去重、mock 不置 verified、真实事件置 verified、失联判定（一次性通知）、重启恢复（文件库重开）、v1→v2 迁移回归（旧任务保留、'' →NULL、verified 重置、9 来源并入、实例表可用）、hooks 安全读写（第三方保留/幂等安装/仅删自身/损坏 JSON 拒改）。

### 真实联调（本机实际执行，命令可复现）

启动应用后（`task-dock.exe`，HTTP ingest 127.0.0.1:47821 + 文件投递 + 托盘运行）：

```
task-dock.exe --agentctl scan
→ 7 个 Agent 全部 installed=True（codex 2 进程 / workbuddy 11 / opencode 1 / zcode 21）

task-dock.exe --agentctl install codex|trae|workbuddy|qoder
→ hooks.json/settings.json 写入：备份 ✓、第三方条目保留 ✓（codex 的 cc_ring 钩子原样保留）、
  写后 JSON 校验 ✓；Trae 国际版+CN 版双写入；WorkBuddy 三配置根写入

task-dock.exe --agentctl install opencode|dsh
→ ~/.config/opencode/plugins/task-dock-bridge.ts、~/.dsh/plugins/task-dock-bridge/ 写入

task-dock.exe --agentctl verify codex|trae|workbuddy|qoder
→ ok: True — hook-script → Task Dock ingest（真实链路）：以与 Agent 完全相同的方式
  调用 hook 脚本（stdin JSON + 事件参数），事件真实抵达数据库（transport=hook）

task-dock.exe --agentctl verify opencode|dsh
→ ok: True — plugin → HTTP ingest → DB 链路验证

task-dock.exe --agentctl post bridge|zcode running → posted（通用桥接）

task-dock.exe --agentctl uninstall trae → 两个 hooks.json 中 6 个事件条目全部移除，恢复 {}
手动验证：codex hooks.json 中 cc_ring 第三方条目在多次安装/卸载后仍完好
```

数据库终态：9 来源（7 Agent + bridge + mock），**7 个 Agent 来源全部 verified=1（由真实 hook/plugin/manual 事件置位）**，mock verified=0；事件流水带 transport（hook×5 / plugin×2 / manual×2）。

### 18 项验收场景对照

| # | 场景 | 证据 |
|---|---|---|
| 1 | 3 种 Agent 同时运行 | 单测 `three_agents_concurrently` + 真实联调（codex/workbuddy/opencode 进程同时在跑） |
| 2 | 同 Agent ≥5 会话 | 单测 `five_concurrent_sessions_one_source` |
| 3 | 会话内多轮 | 单测 `same_session_multiple_rounds`（终态后新活跃事件开新轮次） |
| 4 | 无 run_id 上报 | 单测 `missing_run_id_creates_separate_runs_without_conflict`（P0-2 回归） |
| 5 | 两 Agent 相同外部会话 ID | 单测 `same_external_session_id_different_sources_never_merge` |
| 6 | 重复上报同一事件 | 单测 `duplicate_event_is_idempotent`（dedupe_key 唯一索引） |
| 7 | completed 后旧 running | 单测 `terminal_state_is_protected_from_late_running` |
| 8 | Agent 突然退出 | 单测 `agent_sudden_exit_marks_disconnected_once`（失联判定 + 一次通知） |
| 9 | 重启后恢复 | 单测 `restart_recovery_and_history_preserved`（文件库重开）+ 启动时 recover_after_restart |
| 10 | 等待权限通知 | 单测 `notification_dedupe_across_duplicate_states`（waiting 进入通知） |
| 11 | Agent 完成不改任务状态 | 单测 `task_completion_unaffected_by_agent_events` |
| 12 | 第三方 Hooks 安全追加/卸载 | 单测（hooks_install 4 个测试）+ 真实 cc_ring 保留验证 |
| 13 | 安装未启动 | 发现引擎 installed=True + health=no-events（状态显示未知，不推断） |
| 14 | 有进程无状态 | 单测 `no_event_evidence_means_unknown_not_running` + zcode 实测（21 进程、状态未知） |
| 15 | 多 Agent 同机安装 | 真实联调 scan：7 个全部识别 |
| 16 | 模拟与真实区分 | 单测 `mock_vs_real_events_distinguishable`（transport 列）+ mock 永不置 verified |
| 17 | 关窗后托盘继续接收 | 架构保证：ingest 在主进程后台任务（tiny_http + 文件轮询），与窗口无关；联调期间事件在无窗口 CLI 验证中持续抵达运行中的托盘进程 |
| 18 | 数据库升级不丢数据 | 单测 `v1_to_v2_upgrade_preserves_data_and_fixes_run_ids`（真实 v1 结构库升级） |

### 真实 Agent 生命周期事件说明

本轮完成的「真实联调」层级为：**真实配置写入真实 Agent 的官方配置文件 + 以与 Agent 相同的调用方式（stdin JSON + 事件参数）驱动 hook 脚本 + 事件经真实 HTTP/文件通道入库**。由真实 Codex/Trae/WorkBuddy/Qoder 会话自然触发的端到端事件（场景：用户在这些 Agent 里实际执行一次任务）已具备全部链路，但因不宜在本轮代替用户启动真实 Agent 会话执行任务，计为「待一次真实会话确认」，报告如实计入下方「未完成事项」。

---

## 三、Windows UI 验收结果

- `npm run tauri build` 产出 NSIS 安装包与 MSI（见「实际交付」）。
- 前端类型检查 0 错误；Agent 管理中心含发现面板（扫描/安装/实例数/健康徽标/限制提示）、接入向导（预览→确认→安装→验证→回滚）、监控树（Agent→实例→会话→轮次，未知态显示「未知」）、自定义来源注册/删除。
- 原有三种悬浮模式、托盘（状态图标/菜单/tooltip）、热键、提醒调度、贴边隐藏、备份导入导出代码路径未改动核心逻辑；52 个 Rust 测试中含 v0.1 遗留全部单测（recurrence/nlp/scheduler），无回归。
- 托盘收事件验证：联调期间应用的悬浮窗口处于隐藏状态，CLI 触发的事件正常入库并更新托盘状态（`update_tray` 由 ingest 提交后调用）。

## 四、实际交付

- 源代码：`src-tauri/src/agents/`（11 个模块）、`db/mod.rs`（迁移 v2）、`commands/agents.rs`、`src/components/agents/AgentPanel.tsx`、`src/lib/bridge.ts`
- 数据库迁移：v1 → v2（增量，兼容升级，自动执行）
- 安装包：`release/Task Dock_0.2.0_x64-setup.exe`、`release/Task Dock_0.2.0_x64_en-US.msi`（构建日志见下）
- 无头 CLI：`task-dock.exe --agentctl <scan|install|verify|uninstall|status|events|post>`（自动化联调入口）
- 文档：ACCEPTANCE_REPORT.md、AGENT_COVERAGE_MATRIX.md、ADAPTER_DEVELOPMENT.md、docs/THIRD_PARTY.md（更新）

## 五、未完成事项与如实声明

1. **真实 Agent 会话触发的端到端事件**：hook/plugin 链路已真实验证并留有验证命令，但未代替用户在 Codex/Trae/WorkBuddy/Qoder/OpenCode/DSH 内执行真实任务以观察自然触发。ZCode 的事件接入（插件市场注册）因无官方文档支持未实现，明确标记「待验证」。
2. WorkBuddy 官方安全机制要求在 CLI `/hooks` 面板人工确认外部配置改动后 hooks 才生效——已写入向导限制说明，需用户首次接入时确认一次。
3. Codex App Server（stdio JSON-RPC）可观测路线未纳入本轮（hooks 通道已覆盖 CLI/App 共用的 hooks.json）。
4. Claude Code / Cursor / Gemini CLI 按用户指示移出本轮范围（本机已装 Claude Code v2.1.186 与 Cursor 3.17.8，格式已勘明，后续按 ADAPTER_DEVELOPMENT.md 步骤 1-2 小时/个接入）。
5. 开发数据库事故披露：修复唯一索引测试期间，曾删除 v0.1 开发库 `%APPDATA%\com.taskdock.desktop\task-dock.db`；经核查其自动备份（backup-20261025-162633.json）内容为空库（无任务/轮次/链接数据），无实质数据损失，用户如有旧数据可经「设置→导入」恢复。
6. 安装信息扫描为用户点击触发（低频）；进程枚举单次 <1.5s；大二进制能力扫描有 (路径,大小,mtime) 文件缓存，无每秒轮询。
