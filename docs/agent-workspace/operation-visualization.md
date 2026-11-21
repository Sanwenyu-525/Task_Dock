# Agent 操作可视化（v86 / v86.1）

> 目标：用户能在 TaskDock 里实时看到「哪个 Agent 正在修改哪个资源」，修改完成后看到真实结果，
> 并能一键定位到被修改的位置；同时不牺牲用户对自己工作空间的控制权（不覆盖未保存输入、
> 不伪造成功、不假装定位成功）。
>
> v86.1（2026-11-21）只做可靠性修复：长操作心跳、状态版本、启动恢复全部活动操作、
> 业务提交与状态提交同事务。状态取值、事件名、入口协议保持不变。

本文件是实现与验收的事实说明。代码优先级高于本文；发现偏差以代码为准并回写本文。

---

## 1. 当前架构

```
CLI（独立进程） ─┐
MCP（loopback）  ─┼→ 既有 service / sync 写路径 → SQLite（业务表 + agent_operations）
REST（loopback） ─┤                                      │
文件受控导入     ─┘                                      ├→ Tauri 事件 agent-operation-changed（进程内）
                                                          └→ 游标增量查询 agent_operations_sync（跨进程/补漏）
                                                                     │
                                                     useAgentOperationsStore（唯一订阅者）
                                                                     │
                       资源索引 key=`kind:id` → AgentOperationHighlight / Indicator / Timeline
```

设计边界：

- **不复制业务 SQL**。操作记录只描述「谁在改什么、结果如何」，业务写入仍由既有
  `service::*` / `agent_access::sync::*` 完成。
- **事件不是事实来源**。事实永远在 `agent_operations` 表；事件只降低延迟。
- **每个窗口只有一处订阅与一处轮询**（store）：主窗口与统一工作台各一份实例，
  页面组件只做资源维度查询，不得自行监听或轮询。
- 不改动 Agent 接入体系（认证、授权、幂等、审计）与无关模块。

代码落点：

| 层 | 文件 |
|---|---|
| 生命周期核心 | `src-tauri/src/agent_access/operations.rs` |
| 迁移 v86 | `src-tauri/src/agent_access/schema.rs`（`MIGRATION_86`） |
| 入口接入 | `agent_access/cli.rs`、`mcp/tools.rs`、`agent_access/rest.rs`、`agent_access/sync.rs` |
| Tauri 命令 | `agent_access/commands.rs`（`agent_operations_sync` / `_active` / `_list`） |
| 前端状态 | `src/store/useAgentOperationsStore.ts` |
| 公共组件 | `src/components/agents/operations/*` |
| 用户编辑保护 | `commands::tasks::update_task_cas` + `TaskEditorView` |

---

## 2. 操作生命周期

### 2.1 状态（固定五个，不随功能增加）

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `running` | 已受理、正在执行 | `start` 成功 |
| `committed` | 业务写入已真实提交 | 业务事务提交成功（MCP 与业务同事务；其他入口在提交返回后） |
| `failed` | 业务失败且未提交 | 业务返回错误（非冲突） |
| `conflict` | 版本/租约冲突 | `AppError::Conflict`（revision 不匹配、导入租约被抢占等） |
| `interrupted` | 无法确定结果 | 租约过期且从未收到完成信号（进程退出、客户端断开后未完成、宽限期耗尽） |

**互斥规则**：终态不可回退；`failed/conflict/interrupted` 不会被迟到的 `committed` 覆盖；
唯一例外是 `interrupted → committed`——业务确实提交了，租约误判不能改写事实。

合法转换（前后端同一张表，后端由 `UPDATE ... WHERE status IN (...)` 实现）：

| 当前 | 允许进入 | 说明 |
|---|---|---|
| `running` | `running` / `committed` / `failed` / `conflict` / `interrupted` | 正常生命周期 |
| `interrupted` | `interrupted` / `committed` / `failed` / `conflict` | 真实结果可纠正误判，但不能回到 running |
| `committed` / `failed` / `conflict` | 仅自身 | 最终结论，只允许追加详情 |

### 2.1.1 状态版本（v86.1，**尚未实现**）

> 更正（2026-11-21，v87 修复轮）：本节描述的是设计目标，代码尚未实现
> `state_revision` 列与迁移 v88（当前最大迁移号为 87）。实际比较仍为
> `updatedAt` → 合法转换表；在实现并测试前不得据此宣称「已支持版本防覆盖」。

`state_revision` 是**同一操作内部**的单调版本号（计划中的迁移 v88）：

- 每次真实状态变更（状态 / 阶段 / 资源绑定 / 详情追加）+1；
- **心跳不推进**，也不改 `updated_at`——心跳只续租，不制造事件；
- 前端比较顺序：`stateRevision` → `updatedAt` → 合法转换表；
- 两侧版本相同但内容不同 → 拒绝覆盖并记诊断（说明有第二套写入路径或事件被伪造）；
- 旧数据（v88 之前）没有版本，前端退回时间戳比较，行为与 v86 一致。

### 2.2 阶段（可验证，不含百分比）

`started → writing → finalizing → done`。阶段只在真实节点推进：

- `writing`：MCP 在进入写事务前、文件导入在取得租约后；
- `finalizing`：保留给「业务已提交、正在收尾」的入口（文件归档）；
- `done`：所有终态。

界面不得用阶段推算进度条；`step_total/step_done` 那套业务进度与操作进度无关。

### 2.3 方法

| 方法 | 职责 |
|---|---|
| `start` / `try_start` | 生成唯一 ID、写 `running`、记录开始时间与租约；入口在调用前就从参数/路径绑定资源目标（失败也要能落到行上）；`try_start` 失败只告警，不阻断业务 |
| `update_target` | 绑定资源目标（新建时尚无 ID → 先关联项目，提交后绑定真实 ID） |
| `update_phase` | 推进阶段并续租 |
| `heartbeat` | 只续租（不改 `updated_at` / `state_revision`）；终态不会被复活 |
| `start_runtime` / `tick_leases` | 进程级**共享**租约调度：一个后台线程续租所有登记操作；`tick_leases` 可单测 |
| `complete_tx` | **在业务写事务内**置 `committed`，写入真实资源 ID / revision / 完成时间；`interrupted → committed` 会留痕「业务提交后恢复」 |
| `complete` | 事务外完成（业务已单独提交，或用作事务内完成后的兜底） |
| `append_detail` | 只追加详情、不改状态（文件归档失败等收尾异常） |
| `OperationGuard` / `CompositeGuard` | 把 `complete_tx` 挂到既有 `WriteGuard` 事务链：REST 幂等、文件导入、CLI 资源写入同事务收尾 |
| `fail` / `fail_with` | 收敛为 `failed`/`conflict`（`fail_with` 供「人工拒绝」用 `REJECTED` 错误码） |
| `interrupt_stale` | 只处理 `running` 且租约**确实过期**的行 → `interrupted`；启动时与运行期周期执行 |
| `active` / `list` / `sync_since` | 活动查询、历史分页、游标增量 |
| `prune` | 清理超过保留期的终态记录（`running` 永不清理） |

租约：默认 90 秒，共享调度器每 15 秒续租一次（一个租约期内 6 次机会）。

- 短操作只登记一个 ID，不会创建线程；长操作由同一个后台线程续租；
- 只续租**本进程启动的操作**：一个进程不替另一个进程「续命」；
- 心跳连续失败 20 次（数据库长时间不可写）才放弃本进程的续租，让租约自然过期；
- 主进程每 15 秒扫描一次过期租约，CLI 异常退出不再依赖重启才收敛；
- 独立 CLI 也会启动同一个调度器（`sweep=false`，不替别的进程判死）。

### 2.4 心跳接入与异常终态（v87）

**谁需要心跳**：REST 请求受 20s 预算 + 10s 宽限期约束，必然短于 90s 租约，不启动守护线程；
可能超过租约的是 CLI 写命令与 MCP 长工具（同步扫描/导出、知识导入、报告写入），
由 `operations::is_long_running_action(action)` 判定后启动 `LeaseGuard`。
守护线程只在写操作期间存在，操作完成即随作用域 Drop 停止。

**异常路径必须有终态**（不允许长期停在 `running`）：

| 路径 | 终态 | 错误码 |
|---|---|---|
| 幂等请求宽限期耗尽（业务可能已提交、响应未写回） | `interrupted` | `REST_GRACE_EXHAUSTED` |
| 无幂等占位的请求超时（future 被取消，事务回滚） | `interrupted` | `REQUEST_TIMEOUT` |
| 业务事务成功、审计/响应写失败 | `committed`（业务事实优先） | — |
| 客户端断开（响应通道关闭） | 由后台执行结果决定：提交 → `committed`，失败 → `failed` | — |
| 进程退出（CLI/桌面） | 启动时 `interrupt_stale` + 运行期 `spawn_sweeper` 收敛 | `INTERRUPTED` |

**资源定位**：`rest_target_id` 对 `/api/v1/tasks/t1/complete` 返回 `t1`（子动作不是资源 ID）；
集合端点返回空，创建成功后由响应对象回填真实 ID。旧测试把「子动作路径返回空」当成契约，
已按真实语义修正。

**首次同步**：`sync_since(cursor=None)` 不再只取最近 N 条——它会**并集**「全部运行中操作
（上限 50）」与「最近一页终态历史」，按 `(updated_at,id)` 正序返回，`has_more` 明确告知
是否还有更早历史（走历史分页，不靠游标回退）。游标之后严格 keyset 递增，不重复不跳行。

**备份策略**：`agent_operations` 是**短期运行状态**（租约与执行进程绑定本机），
登记为 `cache/none` + `is_local_transient_table`：导出写空 section、恢复时忽略。
恢复旧备份不会留下永远等不到心跳的假 `running` 行；测试见
`backup_registry_covers_every_schema_table` 与 operations 单元测试。

---

## 3. 事件模型

事件名：`agent-operation-changed`，载荷与 `AgentOperation` 同构（camelCase）：

```json
{
  "id": "…", "agentId": "codex", "actorKind": "agent", "interface": "mcp",
  "action": "taskdock_update_task", "resourceKind": "task", "resourceId": "t-1",
  "projectId": "p-1", "status": "committed", "phase": "done", "revision": 4,
  "requestId": "", "startedAt": "…", "updatedAt": "…", "finishedAt": "…",
  "errorCode": "", "detail": "…"
}
```

规则：

1. camelCase；只含元数据（无正文、无 Token、无绝对路径）。
2. **提交成功后才发 `committed`**：MCP 在事务返回后发；其他入口在业务调用返回 Ok 后发。
3. 通知失败不回滚业务：发射器异常被捕获并只记 warn。
4. 前端按 `operationId` 合并；同一操作重复事件不产生第二条记录。
5. 乱序收敛（v86.1）：先比 `stateRevision`，再比 `updatedAt`，最后才看状态转换；
   旧版本、同版本不同内容、任何 `终态 → running` 一律丢弃（前端计数并在 DEV 记录诊断），
   终态不会被改回 `running`；`interrupted → committed` 只接受后端真实恢复产生的记录。
6. 与 `planning-changed` **职责分离**，不合并：
   - `planning-changed`：业务数据刷新（沿用 v37 的去抖 + 代际守卫）；
   - `agent-operation-changed`：操作过程展示（本功能）。

---

## 4. 数据库设计

迁移 **v86**（`MIGRATION_86`）。表 `agent_operations`：

- `id` 主键；`status`/`phase` 均有 CHECK 约束（非法状态由数据库拒绝）；
- `agent_row_id` 弱引用 `mcp_agents(id) ON DELETE SET NULL`，`agent_id` 是**身份快照**，
  Agent 删除后仍可追溯；
- `resource_kind` + `resource_id`：新建时 `resource_id` 允许为空，提交后绑定真实 ID；
- `project_id`：资源归属（新建未分配 ID 时的临时定位目标）；
- `lease_expires_at`：过期恢复的可靠依据；
- `revision`：业务版本（与 `agent_resource_revisions` 同源，不另造版本）；
- `detail`：写入前脱敏、截断 500 字。

迁移 **v88**（`MIGRATION_88`，v86.1）：只加列 + 索引，不改既有语义。

- `state_revision INTEGER NOT NULL DEFAULT 0`：操作状态版本；新行从 1 开始，旧行为 0；
- `idx_agent_ops_lease(status, lease_expires_at)`：周期过期扫描按索引定位。

索引：`(status, updated_at)`、`(resource_kind, resource_id)`、`(project_id, started_at)`、
`(agent_id, started_at)`、`(updated_at, id)`（游标）、`(status, lease_expires_at)`（租约）。

与审计的分工：

- `agent_activity_logs` 仍是**追加式审计**，只增不改；
- `agent_operations` 是**可变过程状态**，一行业务写入一行；
- 两者通过 `request_id` + 资源指针关联。**没有**把审计表改造成运行状态表，也**没有**
  给审计表加 `operation_id`（可选项，本轮不做：活动面板用操作时间线承担实时性）。

保留策略：终态记录保留 30 天（`RETENTION_DAYS`），启动时清理；`running` 永不清理。

**不是** `agent_request_cache.operation_id`：那是 REST 幂等的业务资源恢复指针，语义不同，
不能当通用 Operation ID 使用。

---

## 5. 跨进程通信

| 场景 | 机制 |
|---|---|
| MCP / REST / 文件（主进程内） | Tauri 事件即时推送 + 游标兜底 |
| 独立 CLI 进程 | 只能写数据库；前端用 `agent_operations_sync` 增量读取 |
| 事件丢失 / 应用重启 | 游标同步（数据库为真源） |

游标语义（v86.1）：

- 首次（`cursor = null`）返回**全部运行中操作**（硬上限 1000）+ 最近一页终态历史，
  按 `(updated_at, id)` 正序合并；运行中操作不再受历史条数限制——这是启动遗漏的主要成因；
- 之后严格 keyset：`(updated_at > c.updated_at) OR (updated_at = c.updated_at AND id > c.id)`；
- 前端只保存一个游标；没有新行时保留原游标，不回退到起点；
- `hasMore=true` 时前端连续读取，但**单轮最多 5 页**（每页 100 条），剩余留到下一轮；
- 某一页失败时保留已合并状态与上一页游标，下一轮从断点继续，不重放已完成页。

频率：**可见时 4 秒一次**（一次按索引的增量查询）；页面隐藏时不查询（只保留一个轻量检查点），
回到前台立即补一次。没有 Redis / Kafka / 消息队列。

### 5.1 业务刷新桥（非 MCP 入口）

`planning-changed` 只由 MCP bridge 广播；独立 CLI、REST、受控文件导入都不会发。
若只同步操作状态，用户会看到「A 改完了」但列表还是旧数据。因此
`src/lib/agentOperationRefresh.ts` 订阅操作终态：

- 仅处理 `interface != 'mcp'` 且 `status = committed` 的操作；
- 250ms 去抖后调用各 store 既有刷新入口（任务 / 笔记 / 规划局部刷新）；
- MCP 仍只走 `planning-changed`，同一次写入不会刷两遍；
- 失败/冲突/中断不改业务数据，一律不刷新。

主窗口与工作台窗口都在各自入口启动这层桥（`App.tsx` / `workspaceEntry.tsx`）。

---

## 6. UI 资源关联

- 只用真实 `resourceId` 关联；**不按标题匹配**，不做全局 DOM 查询。
- 新建资源尚无 ID 时，用 `project:<projectId>` 作为列表级临时目标；提交后同一 operation
  的索引 key 迁移到 `feature:<id>`，旧 key 自动清理。
- 三个公共件：
  - `AgentOperationIndicator`：身份 + 状态（多 Agent 折叠 `+N`），inline-flex，不拦截点击；
  - `AgentOperationHighlight`：无宿主时渲染指示器；有宿主时**克隆宿主**追加
    `agent-op-surface` 类并注入绝对定位徽标（不新增包裹层、不改布局）；
  - `AgentOperationTimeline`：运行中 + 最近结束列表，失败/冲突/中断显示 `errorCode` 与脱敏详情，
    可点击「定位」。
- `useResourceOperations(kind, id)` 是唯一查询入口；索引按 key 局部重建，未受影响的资源
  保持原数组引用（不整列表重渲染）。
- 高亮规则：运行中 = 柔和 outline（`outline-offset:-1px`，不占布局）+ 圆点呼吸（只改透明度）；
  `committed` 保留 4.2 秒，`failed/conflict` 9 秒，`interrupted` 7 秒。`prefers-reduced-motion`
  下关闭动画。
- 页面接入：规划功能卡、任务行、笔记条目、知识文档、Agent 管理「活动」页签（实时操作 + 历史）。

---

## 7. 故障恢复

| 场景 | 结果 |
|---|---|
| 业务事务回滚 | `complete_tx` 随事务回滚 → 操作保持 `running`；入口随后 `fail` → `failed`/`conflict` |
| MCP 幂等重放 | 预检命中 → **不创建** Operation；并发竞态退化为重放时只记一条 `committed` 且不重复写业务 |
| REST 幂等重放 | 缓存命中直接返回，不创建 Operation |
| REST 客户端断开 | 业务在后台任务中继续；状态按真实提交结果收敛，不因断开判失败 |
| REST 超时且宽限期未完成 | 占位释放；操作立即收敛为 `interrupted` + `REST_GRACE_EXHAUSTED`（不再等 90s 租约） |
| REST 无幂等占位超时 | 业务 future 已取消 → `interrupted` + `REQUEST_TIMEOUT` |
| 进程退出（CLI / 桌面） | 启动时 `interrupt_stale` + 共享调度器每 15s 扫描：过期 `running` → `interrupted`；**绝不伪造 committed** |
| 业务已提交、操作记录未完成 | v86.1 对 REST（含非幂等）/ 文件导入 / CLI 资源写入采用**同事务收尾**，该窗口不存在；未守卫的 `sync.*` 只收敛为 `interrupted`，不猜测成功 |
| 心跳误判后业务才提交 | `complete_tx` 允许 `interrupted → committed`，detail 留痕「业务提交后恢复」；重复完成幂等 |
| 文件归档失败 | 数据库已提交 → 操作 `committed`，`append_detail` 注明「归档失败，不会重复写入」，状态不变 |
| 导入被人工拒绝 | `failed` + `error_code=REJECTED`，不伪装成功 |
| 资源被删除 | 操作记录保留（无业务外键）；前端不定位已删除资源，明确提示 |

---

## 8. 权限模型

- 操作主体沿用既有 `Principal`（`Identity` × `Source` 正交）：
  `LocalHuman` / `RegisteredAgent` / `FileImport` / `SystemInternal`；
- `agent_id` 落库为身份快照（本机 `local`、系统 `system`、未认证文件 `file:…`），
  Agent 删除后仍能说明「是谁做的」；
- 记录只含元数据：不含正文、Token、密码、绝对路径；`detail` 经 `sanitize_detail`
  （脱敏 `token=`/`Bearer`/`password=` 等并截断）；
- 事件只发给本机 WebView（Tauri 进程内），不经过网络；
- 可见性：当前 UI 命令为本机用户视角（与既有 Agent 管理面一致）；操作记录不放宽任何
  业务读权限——定位走既有导航与授权读取。

---

## 9. 测试方案与执行结果

### Rust（`cargo test --lib`）

| 覆盖点 | 用例 |
|---|---|
| 开始/完成/资源绑定 | `start_creates_running_operation_with_lease`、`complete_tx_binds_real_target_and_revision` |
| 回滚不写成功 | `rolled_back_transaction_keeps_operation_running` |
| 冲突映射 | `conflict_error_maps_to_conflict_status` |
| 租约/心跳/中断 | `stale_lease_marks_interrupted_but_fresh_stays_running`、`heartbeat_extends_lease_before_expiry` |
| 终态不可回退 | `terminal_operation_is_not_reopened` |
| 多 Agent / 同资源 | `same_resource_supports_multiple_agents` |
| 查询与分页 | `active_and_history_queries_are_filtered` |
| 游标同步 | `cursor_sync_returns_each_change_once`、`bootstrap_sync_restores_old_running_operation_beyond_recent_history`、`keyset_sync_pages_through_identical_timestamps_without_gaps` |
| 心跳与扫描竞态 | `shared_scheduler_renews_tracked_lease_and_releases_terminal`、`renewed_lease_is_not_swept_and_expired_one_is` |
| 状态版本 | `state_revision_advances_on_transitions_but_not_on_heartbeat`（心跳不推版本、不改 updated_at） |
| 事务内收尾 | `operation_guard_completes_inside_business_transaction`（提交同时生效、回滚同时回滚） |
| 误判恢复 | `late_completion_recovers_interrupted_without_repeating_business`、`append_detail_keeps_terminal_status` |
| REST 资源定位 | `rest_write_paths_map_to_stable_actions`（含 `/tasks/t1/complete` → `t1`） |
| 保留策略 | `prune_keeps_running_and_recent_terminal` |
| 事件发射 | `emission_happens_for_transitions_and_can_be_filtered_by_action` |
| 脱敏 | `detail_is_sanitized` |
| 跨入口契约一致 | `four_interfaces_share_the_same_operation_contract`（cli/mcp/rest/file 字段集合与取值一致） |
| 拒绝导入 | `rejected_import_is_recorded_as_failed_not_committed` |
| MCP 原子提交/幂等 | `write_tool_records_single_operation_and_replay_creates_none`、`write_tool_conflict_marks_operation_conflict` |
| REST 真实写入/失败 | `rest_write_records_committed_operation_with_real_resource_id`、`rest_validation_error_marks_operation_failed` |
| 迁移 | `migration_86_creates_operation_lifecycle_table`（CHECK 与索引、非法状态被拒）、`migration_88_adds_state_revision_and_lease_index` |
| CLI 分类 | `write_commands_map_to_actions_and_reads_do_not`、`operation_result_uses_only_returned_fields` |
| UI 编辑 CAS | `cas_update_rejects_stale_baseline_and_accepts_current` |

执行记录（2026-11-21，v86.1 复跑）：

```
npm run cargo -- test --lib agent_access::operations      → 27 passed
npm run cargo -- test --lib agent_access::                → 183 passed（含 schema / REST / 导入）
npm run cargo -- test --lib -- write_tool_records_single_operation_and_replay_creates_none \
    write_tool_conflict_marks_operation_conflict          → 2 passed
npx vitest run src/store/useAgentOperationsStore.test.ts \
    src/components/agents/operations/AgentOperationIndicator.test.tsx → 27 passed
npm run typecheck → 本任务文件通过；全仓仍有 1 处既有错误
    src/components/collab/editors/ImageAnnotator.test.tsx（协作中心未完成改动，非本任务）
```

已知**既有**失败（与本次改动无关，未修复）：`mcp::tests::tool_defs_are_complete_and_unique`
报 `taskdock_collab_create_issue 缺少并发令牌要求`——该工具由协作中心 v85 引入，测试的例外
清单未同步。本次未修改 `collab` 模块。

### 前端（vitest）

| 覆盖点 | 用例 |
|---|---|
| running 高亮 / committed 消退 | `committed 短暂高亮后从资源索引消除…` |
| 重复事件 / 乱序 | `重复事件…`、`乱序旧事件不得把终态改回运行中` |
| 状态版本优先 | `同一时间戳 running → committed 按状态版本接受`、`同一 stateRevision 不同内容…` |
| 终态不回退 | `committed 之后收到 running：即使版本更高也拒绝` |
| 真实恢复 | `interrupted → committed 只允许真实恢复` |
| 旧数据兼容 | `旧数据没有 stateRevision 时退回时间戳比较` |
| 多 Agent / 资源隔离 | `同一资源上的两个 Agent…`、`不同资源互不高亮` |
| 不整列表重建 | `未受影响的资源保持数组引用` |
| 新建临时目标 | `新建资源先用项目列表…` |
| 分页同步 | `hasMore 连续分页直到读完…`、`hasMore 始终为真时单轮最多 5 页…`、`游标不再推进时立即停止` |
| 同步失败保留 | `同步失败保留已合并状态与上一页游标`、`同步失败后重试可从游标继续` |
| 启动恢复不误闪 | `启动恢复不闪烁历史终态，但增量同步会闪烁` |
| 展示契约 | `AgentOperationIndicator.test.tsx`（身份、+N、无操作不渲染、宿主类名、其他资源不命中） |

```
npx vitest run src/store/useAgentOperationsStore.test.ts src/components/agents/operations/AgentOperationIndicator.test.tsx → 27 passed
npx vitest run TaskItem / NotesPanel / FeatureAgentLinks / PlanningWorkspace.focus → 34 passed（v86 基线，未受本次影响）
npx vitest run TaskEditorView / TasksPanel → 38 passed（v86 基线，未受本次影响）
```

### 真实窗口验收（Dev，2026-11-21）

`node scripts/acceptance-agent-operation-v1.mjs` 通过 CDP 驱动真实 WebView2，
MCP 走 stdio 子进程、CLI 走独立进程、数据库用 `node:sqlite` 直读断言：

```
12 passed / 0 failed    tmp/acceptance/agent-operation-visualization/run-20261121-111925/
```

覆盖：A 规划功能新建（工作台窗口高亮 + 真实 ID）、B MCP 改任务、C 双 Agent 一成功一冲突、
D CLI 写入 4s 内被 UI 感知且标题自动刷新、E 关闭期间写入后重开、F 编辑中并发（不覆盖 +
冲突 + 重载）、G 租约过期 → interrupted。截图与 `summary.md` 同目录。

脚本注意事项（写给后续运行者）：

- Vite 在 HMR 后会给依赖 URL 加 `?t=`，脚本里的动态 `import()` 可能拿到**第二个 store 实例**；
  读应用真实实例请用 DEV 专用的 `window.__AGENT_OP_STORE__`（生产构建不存在）。
- 「关闭 → 重新打开」场景必须等旧 WebView2 的 CDP 端口释放；占用则换端口，否则会连到
  正在退出的旧目标（表现为 store 未初始化）。

验收过程中发现并修复的问题：

1. 失败/冲突的操作没有资源 ID（只在成功返回时绑定）→ 改为调用前从工具参数/REST 路径绑定；
2. 规划中心真实界面在统一工作台窗口，该窗口缺少操作订阅 → `workspaceEntry.tsx` 增加启动；
3. CLI/REST/文件写入没有 `planning-changed` → 新增业务刷新桥（§5.1）；
4. 窄窗口下多个徽标换行挤压任务标题 → 徽标 `nowrap` + 窄行只展示 1 个主体 + `+N`。

---

## 10. 入口接入点（代码定位）

| 入口 | 接入点 | 关键行为 |
|---|---|---|
| CLI | `cli.rs::main_entry` + `classify_cli_write` | 认证后开始；**只读命令不建操作**；一次调用一条记录；UI 关闭时照常写库；资源写入走 `*_guarded` + `OperationGuard`（同事务）；`sync.*` 无业务指针，失败只收敛为 `interrupted` |
| MCP | `mcp/tools.rs::run_tool_call` 写分支 | 预检重放 → 开始 → 事务内 `complete_tx` → 提交后发事件；失败按真实错误收敛 |
| REST | `rest.rs::run_claim_execution` / 无幂等分支 | 幂等占位取得后开始；`describe_rest_write` 映射动作；业务 + 幂等标记 + 操作终态同事务；超时按结果是否核实收敛 |
| File | `sync.rs::approve_import` / `reject_import` / `scan` | 审批/拒绝/自动导入各一条；`CompositeGuard(导入租约, 操作)` 同事务提交业务与终态；归档失败只 `append_detail` |

---

## 11. 不在本轮范围

- Agent 自动调度、分布式消息队列、远程控制、模拟鼠标、自动切换用户页面；
- 操作进度百分比（不伪造进度）；
- `agent_activity_logs.operation_id` 关联列（可选项，见 §4）；
- 对已删除资源的「定位」——只提示，不做假跳转。
