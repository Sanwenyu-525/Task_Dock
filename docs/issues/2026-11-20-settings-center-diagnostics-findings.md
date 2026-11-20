# 设置中心诊断异常核查（2026-11-20）

> 结论先行：7 项里 **1 项当前仍存在**（`settings.get_settings` 启动竞态，与设置页 UI 无关），
> **1 项已在本仓库修复**（`workbench_layout.navWidth` 校验区间），其余为开发实例环境特征或
> 未初始化态的正常降级。本文只记录证据与根因，不改动范围外代码。

## 1. 取证方法

| 项 | 说明 |
|---|---|
| 数据源 | release 实例 `%APPDATA%\com.taskdock.desktop\diagnostics\diagnostics-active.jsonl`（618 条）<br>dev 实例 `...\dev-instance\diagnostics\diagnostics-active.jsonl`（731 条） |
| 判定「当前问题」 | 该 `module/action/event` 的最新时间戳是否落在最近一次启动（2026-11-20） |
| 判定「历史」 | 最新记录早于 2026-11-20，且源码已变更 |
| 关联字段 | `timestamp` / `window_id` / `error_code` / `duration_ms` / `metadata.occurrences` |

`diagnostics-active.jsonl` 是单写线程 + 同键聚合（60s 窗口）的产物，因此条数不等于调用次数：
`event=aggregated` 记录的 `metadata.occurrences` 才是窗口内次数。

## 2. 逐项结论

### 2.1 `settings.get_settings` — ✅ 当前仍存在（1120 条，最近 2026-11-20 11:15）

| 证据 | 值 |
|---|---|
| 记录数 | release 220（failed 137 + aggregated 83）；dev 16 |
| 典型报文 | `state not managed for field 'db' on command 'get_settings'. You must call '.manage()' before using this command` |
| 出错窗口 | `context-menu` 209、`notification` 9、`capture` 2（release） |
| 时序 | 每条 `failed` 都紧贴 `system.startup ready`：例如 ready `17:43:01.767` → first failed `17:43:01.858`（+91ms） |
| 时间分布 | 11-07 起每天都有，非单次事故 |

**根因（已定位到代码）**：`src-tauri/tauri.conf.json` 以声明式方式预创建了
`context-menu` / `notification` / `capture` / `tab-hint` 四个隐藏窗口。Tauri 在 `setup()` **之前**
就创建这些窗口并开始加载其页面，页面首帧的 `get_settings` 会在 `handle.manage(db)`（
`src-tauri/src/lib.rs:730`）之前到达，因而取不到 `State<Arc<Db>>`。

`lib.rs:843` 的注释（“context-menu 也改为 DB 托管后由 context_menu::init 创建，避免其首屏
get_settings 与 handle.manage(db) 竞态”）说明这条路径已被识别，但 `notification_window::init`
（`lib.rs:1123`）只挂事件、不创建窗口——窗口仍来自配置，竞态因此保留。

**责任模块**：启动/窗口装配（`tauri.conf.json` + `lib.rs`）与 settings 命令签名。
**建议处置（未实施，属本次范围外）**：
1. 命令侧用 `app.try_state::<Arc<Db>>()`，未就绪时返回可重试错误码（前端已有重试路径）；
2. 或把四个辅助窗口移出配置，在 `manage` 完成后用 `WebviewWindowBuilder` 创建（改面较大，
   涉及透明/圆角/预创建策略，需单独任务）。

### 2.2 `settings.update_settings` navWidth 120–800 — ✅ 历史，已修复

| 证据 | 值 |
|---|---|
| 记录数 | 5 条（全部 dev 实例，`window_id=workspace`，`error_code=VALIDATION_ERROR`） |
| 时间 | 2026-11-19 11:18 / 20:00 / 20:56 / 21:17 / 22:39 |
| 报文 | `workbench_layout.navWidth 超出范围（120–800）` |

**根因**：旧版后端用同一区间校验两个宽度（`git show 5b6c671^:src-tauri/src/commands/settings.rs`
第 539–552 行：`(120..=800)` 同时套 `navWidth` 与 `detailWidth`），而前端 `WORKBENCH_NAV_WIDTH_MIN`
是 96（图标轨）。把导航拖到图标轨后，前端归一化出的 96 被后端拒收。

**现状**：HEAD 已改为按字段校验——`navWidth 96–320`、`detailWidth 260–480`
（`src-tauri/src/commands/settings.rs:544`），与 `src/lib/workbenchLayout.ts:75-78` 的常量一致。
因此 11-19 之后没有新增记录。该修复位于提交 `5b6c671`。

### 2.3 `ui.boot_slow` — ⚠️ 开发实例特征，release 无新增

| 实例 | 次数 | 最近 | 说明 |
|---|---|---|---|
| release | 13 | 2026-11-17 15:42（8.3s） | 11-17 之后再无超阈值启动 |
| dev | 50 | 2026-11-20 12:24（8.5s / 12.9s） | `npm run tauri dev` 的 Vite 冷启动 + debug 链接 |

`metadata.reason = slow_module_load`，`event_count = 0`：慢在模块装载，没有抛错。
结论：dev 环境特征；release 侧当前未复现，不构成回归。

### 2.4 `ui.boot_timeout` — ⚠️ 历史 + 开发实例

release 14 次（最近 2026-11-17 16:20）；dev 23 次（最近 2026-11-19 22:55）。同一会话里
`boot_timeout` 之后 5–10 秒仍会补一条 `boot_slow`（如 15:42:49 timeout → 15:42:54 19.8s），
说明是「超过 15s 阈值」而非卡死。改完模块拆分（按需加载）后 release 侧未再出现。

### 2.5 `workbench.startup-reveal` — ⚠️ 开发实例为主

release 3 次（集中在 2026-11-17 15:42 / 16:12 / 16:20）；dev 47 次（最近 2026-11-20 12:23）。
该事件是**兜底生效**：前端未在超时内确认就绪，Rust 强制显示窗口（`project_workspace_window.rs`
的 watchdog），不会白屏。dev 期间前端在编译/热更新，属预期。

### 2.6 `agents.http_ingest` — ⚠️ 环境性降级，非缺陷

| 实例 | 次数 | 最近 | 典型报文 |
|---|---|---|---|
| release | 24 | 2026-11-20 11:15 | `127.0.0.1:47821 已被另一个 Task Dock 实例占用（第 1 次尝试）；本实例会在端口释放后自动接入` |
| dev | 68 | 2026-11-20 12:54 | `HTTP 接入鉴权失败 1 次/10s（method=POST, path=/api/v1/events）` |

根因：release 与 dev 两个实例共用固定端口 47821（`settings.http_port` 默认值），后启动者绑定失败
并按 10s 退避重试；dev 侧 401 是外部脚本用了旧 token。两者都是**设计内的降级路径**，
不需要修；若要消除，应做单实例仲裁或端口回退（记录为后续项）。

### 2.7 `agent.agent_access_conflicts` — ⚠️ 未初始化态告警，仅 dev 3 次

| 证据 | 值 |
|---|---|
| 记录数 | 3（dev），release 0 |
| 时间 | 2026-11-19 18:01 / 22:53 / 22:54 |
| 报文 | `工作空间尚未初始化`（`AppError::NotFound`，`agent_access/commands.rs:79`） |

**根因**：`src/components/capability/AgentAccessSection.tsx` 的 `loadAll` 用 `Promise.all`
同时拉 `agent_access_status` 与 `agent_access_conflicts`；工作空间尚未初始化时后者返回 NotFound，
整组请求失败并打一条 WARN。正确顺序应是先读 status，`workspaceId` 存在后再拉 conflicts。
责任模块是 Agent 工作空间面板（非设置中心）。11-20 未复现。

## 3. 与本次设置中心的关系

| 项 | 是否与设置页有关 | 处置 |
|---|---|---|
| 2.1 get_settings 竞态 | 间接（设置值来自该命令） | 记录，未改 |
| 2.2 navWidth 校验 | 是（工作台布局默认值） | 已由 5b6c671 修复，本次验证一致 |
| 2.3–2.5 启动耗时 | 否 | 记录 |
| 2.6 HTTP 端口占用 | 否 | 记录 |
| 2.7 工作空间未初始化 | 否 | 记录 |

本次设置中心改动**没有新增**任何一条上述诊断事件。
