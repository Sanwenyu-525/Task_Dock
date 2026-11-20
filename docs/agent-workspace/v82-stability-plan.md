# v82 稳定性方案：安全加固、并发修复与质量闭环

> 状态：**方案已定稿，进入实施**
> 编写：主 Agent｜基线：`main` @ `5b6c671`（工作区另有 61 项他人未提交改动，本任务不触碰）
> 结论口径：本文件只写「要改什么、为什么、怎么验证」；执行证据写 `v82-acceptance-report.md`。

## 0. 两个必须先说清的事实

1. **数据库迁移版本号不是 82。** `MIGRATIONS` 数组末端已被另一个在途任务占用：
   `(82, security_audit_log …)`（见 `src-tauri/src/db/mod.rs:2137`，属他人未提交改动）。
   → 本轮**发布名仍为 v82**，新增迁移为 **`MIGRATION_83`**（`agent_access/schema.rs`），
   登记在 82 之后。**禁止**修改或复用 82。
2. **文件导入的幂等表 `agent_import_claims.status` 只有 `inflight|ok` 两个取值**
   （v81 CHECK 约束）。重建该表可加入 `failed`，但会重写已发布迁移的表结构。
   → 决策：**只加列、不重建表**。`failed` 用「租约被释放/过期」表达，
   状态机在 Rust 侧统一为 `ImportOutcome` 枚举（见 §3.2），不靠 bool。

## 1. v81 现状（核对结果，非文档转述）

| 能力 | 实现位置 | 现状 |
|---|---|---|
| 四入口 | `cli.rs` / `mcp_tools.rs` / `rest.rs` / `sync.rs` | 均已接入 `service.rs`，无重复 SQL |
| 身份 | `Principal.identity`（LocalHuman/RegisteredAgent/FileImport/SystemInternal） | `Source` 仅表示入口 |
| 文件导入授权 | `permissions.rs` + 迁移 81 三张表 | 目录策略 + 待审核 + 幂等声明 |
| REST | `rest.rs`（hyper + tokio） | 已先 bind 再登记 listening |
| Context | `context.rs` | 按 kind 分权 + 预算 |
| Handoff / Report | `handoff.rs` + `agent_work_reports` | 状态迁移绑定操作者 |

v81 验收：`scripts/acceptance-agent-access-v81.mjs` 36/36 通过，但其中 **C5 / 只读拒绝 / F1 / E5
四条结论不可信**（见 P1-6）。

## 2. v82 问题清单（全部已读代码确认，非推测）

| 编号 | 问题 | 严重度 | 确认位置 |
|---|---|---|---|
| P1-1a | `check_import_resource_scope()` 查不到任务归属时**静默放行** | 高 | `permissions.rs:525-547` |
| P1-1b | `import_target_project()` **优先信任文件声明** `project_id` | 高 | `sync.rs:307-326` |
| P1-1c | `_ => Some(resource_id.to_string())` 把资源 ID 当项目 ID | 高 | `permissions.rs:536` |
| P1-1d | 创建类操作把最终归属绑到文件声明而非授权范围 | 高 | `sync.rs:352-357` |
| P1-2a | `claim_import()` 用 `bool` 混同 ok / inflight | 高 | `sync.rs:516-561` |
| P1-2b | `scan()` 在 claim 返回 false 时**归档到 `_imported`** | 高 | `sync.rs:888-893` |
| P1-2c | `approve_import()` 在 inflight 时把请求标 `imported` | 高 | `sync.rs:1050-1064` |
| P1-2d | 无认领者、无认领时间、无过期恢复 | 高 | `schema.rs:329-342` |
| P1-3 | `read_body()` 在 `REQUEST_TIMEOUT` 之外 | 中高 | `rest.rs:508-538` |
| P1-4a | `cache_lookup()` 不返回 `request_hash`，不比对指纹 | 高 | `store.rs:1034-1053` |
| P1-4b | 缓存命中即重放，不同 Body/Path/Method 也重放 | 高 | `rest.rs:517-532` |
| P1-4c | 无「进行中」占位，并发同 Key 双执行 | 高 | `store.rs:1055-1084` |
| P1-5a | `start()` 检查 slot 与登记 slot 非原子（不同端口可双绑） | 高 | `rest.rs:252-314` |
| P1-5b | `status()` 用 `runtime.configured_port.max(configured_port)` | 中 | `rest.rs:209` |
| P1-5c | `stop()` 以「端口可再绑」判定任务结束，abort + 轮询混用 | 中 | `rest.rs:326-360` |
| P1-6a | 用 `includes("task") && includes("create")` 选工具 | 高 | `v81.mjs:487/501` |
| P1-6b | 只读拒绝只看 `isError` 布尔 | 高 | `v81.mjs:511` |
| P1-6c | F1 用 `spawnSync` 顺序执行，不是并发 | 高 | `v81.mjs:374` |
| P1-6d | E5 名为 Agent C、实际用 Agent A Token | 中 | `v81.mjs:549` |
| P2-1 | `upsert_import_request()` 冲突更新不重置 `status` | 中 | `sync.rs:586-634` |
| P2-2 | `create_report()` 算出 `effective_project` 却插入 `project_id` | 中 | `handoff.rs:360-382` |
| P2-3 | `"report" => handoff_ids.contains(id)` 拿报告 ID 比交接 ID | 中 | `context.rs:973` |
| P2-4 | `kind_globally_or_project_authorized()` 把所有资源粒度为项目 | 中 | `context.rs:406-425` |
| P2-5 | 约束/下一步在预算之后拼接，markdown 可超预算 | 中 | `context.rs:1058-1097` |

## 3. 根因与修复方案

### 3.1 P1-1 文件导入权限绕过
**根因**：权限判定用了「文件自称的 project_id」，而不是「数据库里资源的真实归属」；
且归属不可知时按「不报错」处理（fail-open）。

**修复（按资源类型分流，新增 `permissions.rs::resolve_resource_scope()`）**

| 操作 | 归属来源 | 归属不可知时 |
|---|---|---|
| `task.create` | 授权范围（`grant.project_id`），文件声明只做一致性校验 | 授权为全局 → 全局；授权限项目 → 用 `grant.project_id` |
| `task.update / complete` | `workspace_task_links.task_id → project_id` | **FORBIDDEN** |
| `knowledge.create` | 授权范围 | 同上 |
| `decision.create` | 授权范围 | 同上 |
| `handoff.create` | 授权范围（`project_id` 必须存在于 `planning_projects`/`workspace_projects`） | **FORBIDDEN** |
| `report.create` | 由 handoff 推导（见 P2-2） | **FORBIDDEN** |

规则：
- 全局授权（`grant.project_id == ""`）**只**表示「不限项目」，仍需能力集合通过；
- 项目授权绝不因为「资源无归属」而放行；
- 文件传 `project_id` 只作为待校验信息，与真实归属不一致 → FORBIDDEN；
- `import_target_project()` 改为 `declare_project()`：只返回「文件声明」，命名上禁止当权限用。

### 3.2 P1-2 导入幂等与并发
**根因**：认领是「先查后写」的非原子读，且 bool 丢失了状态语义。

**修复：租约（lease）+ 单事务条件更新**

新增 `store.rs::claim_import_lease()`：
```sql
INSERT INTO agent_import_claims
  (id, workspace_row_id, claim_key, rel_path, kind, content_hash, actor, status, owner,
   claimed_at, expires_at, attempt, created_at, updated_at)
VALUES (…, 'inflight', :owner, :now, :lease_until, 1, :now, :now)
ON CONFLICT(workspace_row_id, claim_key) DO UPDATE SET
  status='inflight', owner=:owner, claimed_at=:now, expires_at=:lease_until,
  attempt=agent_import_claims.attempt+1, updated_at=:now
WHERE agent_import_claims.status <> 'ok'
  AND (agent_import_claims.status <> 'inflight'
       OR agent_import_claims.expires_at IS NULL
       OR agent_import_claims.expires_at <= :now)
RETURNING attempt
```
返回 `AppResult<Option<u32>>`：`Some(attempt)` = 取得执行权；`None` = 被他人持有。
（`RETURNING` 在 SQLite ≥ 3.35 可用；项目已用 `rusqlite` bundled，版本满足。）

`claim_import()` 改为返回枚举：
```rust
pub enum ImportOutcome {
    Acquired { attempt: u32 },
    AlreadyImported { at: String },
    InProgress { owner: String, until: String },
    Rejected { status: String },   // 请求状态不允许执行
}
```

状态机（`agent_import_requests`，用 `status` + 租约列表达，不重建表）：

| 状态 | 表达 | 允许迁移到 |
|---|---|---|
| `pending_review` | `status='pending'` 且无租约 | `inflight`（批准）、`rejected` |
| `inflight` | `status IN ('pending','approved')` 且 `lease_expires_at > now` | `imported`、`failed` |
| `imported` | `status='imported'` | 终态 |
| `rejected` | `status='rejected'` | 终态（新内容走 P2-1 重置） |
| `failed` | `status='failed'` | 重新扫描/批准 → `pending`/`inflight` |

- 归档规则：`Acquired → 成功 → archive`；`AlreadyImported → archive（附证据）`；
  `InProgress / Rejected → 留在 inbox`，只记事件。
- `approve_import()` 与 `scan()` 共用 `claim_import_lease()`，`approve` 不再自己写一套。
- 崩溃恢复：`expires_at <= now` 的租约视为可抢占；旧执行者写入前 `begin_import_write()`
  复查 `owner` 仍是自己，否则放弃（防止过期者继续写）。

### 3.3 P1-3 REST 超时
- `handle()` 起算 `Instant::now()`，`read_body_limited(req, remaining)` 与 `dispatch()` 共享
  `REQUEST_TIMEOUT` 预算：`timeout_at(deadline, ...)`。
- `read_body` 同时校验 `Content-Length` 与**流式累计字节**（缺 Content-Length 也受限）。
- 超时返回统一 Envelope + `request_id`，`X-Request-Id` 头一致。
- 超时取消的写操作：`dispatch` 只调 `service`，业务写入均在 `with_transaction` 内，
  超时 drop future 即回滚，不留半条数据（这点要在测试里验：超时后表行数不变）。

### 3.4 P1-4 幂等指纹
- 指纹 = `sha256(method \n path \n sorted_query \n body_hash)`，与 Agent 行 ID、Key 一起作为唯一键
  （现有 `UNIQUE(agent_row_id, interface, idempotency_key)` 已足够）。
- **原子占位**：`cache_claim()` 用 `INSERT … ON CONFLICT DO NOTHING` 抢一条 `state='inflight'` 的行；
  抢到即执行，抢不到读已有行：
  - `state='done'` 且指纹相同 → 重放 + `meta.replayed=true`；
  - `state='done'` 且指纹不同 → **409 IDEMPOTENCY_CONFLICT**；
  - `state='inflight'` → 有界轮询（≤2s）等结果；仍 inflight → **409 IDEMPOTENCY_IN_PROGRESS**；
  - 过期 inflight（`expires_at` 5 分钟）→ 允许抢占重试。
- 失败不缓存：`dispatch` 返回 `Err` 时 `cache_release()` 删占位行。
- 不同 Agent 天然隔离（唯一键含 `agent_row_id`），补测试锁定。

### 3.5 P1-5 REST 生命周期
- 引入 `LifecycleGate`：`Mutex<LifecycleState>`，`start/stop/apply` 全部在 gate 内串行；
  `RestRuntimeStatus` 只允许 `Stopped→Starting→Listening→Stopping→Stopped`、任一→`Failed`。
- `start()`：gate 内 `bind → spawn → 登记 slot → Listening`，失败清理已绑 socket，置 `Failed` 并留 `last_error`。
- `stop()`：`notify_waiters()` + `JoinHandle::abort()`，用 `finished` 计数 + `JoinHandle` 完成信号做
  **有界等待（2s）**，超时记 `last_error="停止超时"`，但仍置 `Stopped` 且释放 slot。
- `status()`：`configured_port` 只反映设置值；`bound_port` 只反映真实监听；
  `port` = `bound_port`（listening）否则 `configured_port`。删掉 `.max()`。

### 3.6 P1-6 验收脚本（详见 Agent E）
新建 `scripts/acceptance-agent-access-v82.mjs`，v81 脚本原样保留。要点：
工具名从 `tools/list` **精确匹配** `taskdock_create_task`（并从 schema 取参数名）；
只读拒绝断言「HTTP/JSON-RPC 错误码 + 业务错误码 + 数据库无新增」三者同时成立；
F1 用 `child_process.spawn` + 同步屏障（两进程写 ready 文件后 `Atomics.wait`/轮询）实现真并发；
E5 与真实身份一致；每次运行独立 `TASK_DOCK_DATA_DIR`。
数据目录：`tmp/acceptance/agent-access-v82-<timestamp>/`。

### 3.7 P2
- **P2-1**：`upsert_import_request()` 冲突时若 `content_hash` 变化 → `status='pending'`、
  `decided_at=NULL`、`decided_by=''`、`attempt=attempt+1`，并把旧结论写入 `detail_json.history[]`；
  内容未变 → 保持原状态（幂等）。
- **P2-2**：`create_report()` 插入 `effective_project`；`list_reports()` 按 `effective_project` 过滤；
  项目为空且无 handoff → 只允许全局 `HandoffsRead`。
- **P2-3**：`retrieve_recent_changes()` 对 `report` 走 `agent_work_reports.project_id` 或
  `JOIN agent_handoffs`，不再与 `handoff_ids` 直接比较。
- **P2-4**：`capability_resource_of_kind()` 明确「该 kind 的授权 resource_id 是什么粒度」：
  项目级（plan/handoff/decision/knowledge）→ `project_id`；任务级（task）→ 项目 ID 仍需映射为
  「该项目下的 task 集合」，不允许把 project_id 当 task_id。collector 内过滤 + 最终兜底双保险。
- **P2-5**：预算先算骨架（含 constraints / next_steps），再装条目；`render_markdown` 后按
  `estimated_tokens` 校验，超出则从尾部裁条目直至满足或全部裁掉，并置 `truncated=true`。

## 4. 涉及文件与所有权

| 文件 | 所有者 | 说明 |
|---|---|---|
| `agent_access/schema.rs` | **主 Agent** | 新增 `MIGRATION_83` |
| `db/mod.rs` | **主 Agent** | 注册 83（不碰 82） |
| `agent_access/store.rs` | **主 Agent** | `claim_import_lease / finish / release / reclaim`、`cache_claim / lookup / complete / release` |
| `agent_access/mod.rs` | **主 Agent** | 声明 4 个新测试模块 |
| `agent_access/permissions.rs`、`sync.rs` | Agent A | P1-1 / P1-2 / P2-1 |
| `agent_access/rest.rs` | Agent B | P1-3 / P1-4 / P1-5 |
| `agent_access/context.rs` | Agent C | P2-3 / P2-4 / P2-5 |
| `agent_access/handoff.rs` | Agent D | P2-2 |
| `scripts/acceptance-agent-access-v82.mjs` | Agent E | P1-6 |
| `agent_access/tests_v82_*.rs` | A/B/C/D 各自 | 一人一文件，互不覆盖 |

**共享枢纽**（`lib.rs`、`commands/mod.rs`、`locales/**`、`src/lib/contracts/**`）：本任务**不需要**
改动；若确需改动，由主 Agent 单独执行。

## 5. 安全影响分析

| 变更 | 安全性 | 兼容性 |
|---|---|---|
| 资源归属改由数据库决定 | 收紧（可能让原本「能用」的导入被拒） | 属**行为收紧**，需在报告里明示 |
| 归属不可知 → FORBIDDEN | 收紧，消除 fail-open | 同上 |
| 幂等同 Key 不同指纹 → 409 | 新增拒绝路径 | 客户端需区分 409 与 200（文档更新） |
| 导入租约 | 防重复写入 | 崩溃后 5 分钟内不可重试（可接受） |
| 迁移 83 仅加列 | 只增不改，回退 = 忽略新增列 | 旧库升级无损；全新库同样走 83 |

**不做的事**：不新增「默认允许」路径、不为兼容保留 fail-open、不删任何用户数据。

## 6. 数据库变更计划（MIGRATION_83，纯新增列 + 一次数据修复）

```sql
-- 1) 导入认领：租约字段（失败=租约释放，不新增 status 取值，避免重建 v81 表）
ALTER TABLE agent_import_claims ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_import_claims ADD COLUMN claimed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_import_claims ADD COLUMN expires_at TEXT;
ALTER TABLE agent_import_claims ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_aic_lease ON agent_import_claims(workspace_row_id, status, expires_at);

-- 2) 导入请求：租约 + 决策内容版本
ALTER TABLE agent_import_requests ADD COLUMN lease_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_import_requests ADD COLUMN lease_expires_at TEXT;
ALTER TABLE agent_import_requests ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_import_requests ADD COLUMN decided_hash TEXT NOT NULL DEFAULT '';

-- 3) REST 幂等：进行中状态 + 指纹
ALTER TABLE agent_request_cache ADD COLUMN state TEXT NOT NULL DEFAULT 'done';
ALTER TABLE agent_request_cache ADD COLUMN request_method TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_request_cache ADD COLUMN request_path TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_arc_state ON agent_request_cache(state, expires_at);

-- 4) 数据修复：历史报告补齐项目归属（非破坏，只填空值）
UPDATE agent_work_reports
SET project_id = (SELECT h.project_id FROM agent_handoffs h WHERE h.id = agent_work_reports.handoff_id)
WHERE (project_id IS NULL OR project_id = '') AND handoff_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM agent_handoffs h WHERE h.id = agent_work_reports.handoff_id AND h.project_id <> '');
```

验收：全新库初始化、v81 库升级、升级后 `user_version = 83`、重复执行幂等。

## 7. 并行开发分工

| Agent | 范围 | 交付物 |
|---|---|---|
| A | `permissions.rs`、`sync.rs`、`tests_v82_import.rs` | P1-1、P1-2、P2-1 |
| B | `rest.rs`、`tests_v82_rest.rs` | P1-3、P1-4、P1-5 |
| C | `context.rs`、`tests_v82_context.rs` | P2-3、P2-4、P2-5 |
| D | `handoff.rs`、`tests_v82_handoff.rs` | P2-2 |
| E | `scripts/acceptance-agent-access-v82.mjs` | P1-6 |
| 主 | 迁移、`store.rs`、`mod.rs`、集成、集中验收、报告 | — |

约束：不得修改他人文件；不得 commit/push；发现需要改共享文件 → 报给主 Agent。

## 8. 测试用例矩阵

见 `docs/agent-workspace/test-plan.md` 的「v82」章节（与本文同步维护），覆盖：
权限 11 项、导入并发 6 项、REST 超时 7 项、幂等 7 项、生命周期 8 项、Context 6 项、Handoff 4 项。

## 9. 验收标准

**通过条件（全部满足才可 PASS）**
1. `cargo fmt --check`、`cargo check`、`cargo test --lib` 全绿（新增用例数 ≥ 35）。
2. `npm run typecheck` 通过。
3. 全新库 + v81 升级库两条路径迁移成功，`user_version=83`。
4. `node scripts/acceptance-agent-access-v82.mjs` 全绿，且**每条断言都带数据库副作用校验**。
5. 真实 `npm run tauri dev` 环境跑完 REST/CLI/MCP/File/Handoff/Context 六条链路，端口释放可证。
6. 不存在 fail-open 分支：`grep` 可证「归属不可知 → Ok(())」已归零。

**结论只允许** PASS / CONDITIONAL PASS / FAIL。

## 10. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 收紧后既有导入被拒 | 报告列明行为变化；`import` 事件带明确 reason | 回退 `permissions.rs`/`sync.rs` 单文件 |
| 租约 5 分钟过期导致卡住 | 过期可抢占；`attempt` 递增可追踪 | 清空 `agent_import_claims` 即可恢复 |
| 幂等 409 影响老客户端 | 文档写明；`meta.replayed` 语义不变 | 回退 `rest.rs` |
| 迁移 83 加列失败 | 单事务；失败整体回滚，库仍为 82 | `PRAGMA user_version=82` + 删列（SQLite 需重建，故仅作最后手段） |
| 与并行任务改同一文件 | 文件所有权表（§4） | 冲突即停，报主 Agent |

## 11. 执行顺序

1. 主 Agent 落迁移 83 + `store.rs` 租约/幂等 API + `mod.rs` 测试模块声明。（本次）
2. 五个子 Agent 并行实施（各自文件）。
3. 主 Agent 审查全部 diff，处理跨模块接口。
4. 集中静态检查 + 单元测试。
5. `npm run tauri dev` 真实环境六条链路验收。
6. 修问题 → 回归 → 写 `v82-acceptance-report.md`。
7. 更新 `development-progress.md`、`test-plan.md`。
