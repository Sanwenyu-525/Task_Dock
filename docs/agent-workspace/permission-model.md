# 权限模型

## 1. 身份

唯一身份真源：`mcp_agents`（沿用 MCP 已有表）。

| 字段 | 含义 |
|---|---|
| `agent_id` | 稳定标识（字母/数字/`-`/`_`/`.`，≤64） |
| `display_name` | 展示名 |
| `vendor` / `interface_hint` / `note` | 厂商、接入方式提示、备注（v76 新增） |
| `scope` | `disabled` / `readonly` / `project_rw`（既有语义不变） |
| `token_hash` | SHA-256；明文只在创建/轮换返回值出现一次 |
| `revoked_at` | 非空即失效（每次请求重读，无缓存窗口） |

`scope` 决定「能否调用写工具」；能力表决定「能触达哪些资源」。**两层都满足才放行**。

## 2. 能力（capability）

| 能力 | 读/写 | 资源范围 |
|---|---|---|
| `projects.read` | 读 | 全局 |
| `tasks.read` / `tasks.write` | 读/写 | 全局或单个任务（`resource_id`） |
| `plans.read` | 读 | 全局或单项目 |
| `knowledge.read` / `knowledge.write` | 读/写 | 全局或单知识库 |
| `decisions.read` / `decisions.write` | 读/写 | 全局或单项目 |
| `context.read` | 读 | 全局 |
| `handoffs.read` / `handoffs.write` | 读/写 | 全局或单项目 |
| `skills.read` | 读 | 全局 |
| `notes.*` / `workflows.read` / `workspace.read` | 既有 | 既有规则不变 |

默认策略：新建 Agent = `disabled` + 无能力 → 全部拒绝。UI 必须显式授予。

## 3. 判定顺序（v92 统一授权四层）

```
1. 身份存在且未撤销         → 否则 UNAUTHORIZED
2. scope 允许该操作类别      → disabled 一律拒绝；只读不允许写
3. 能力存在（全局或资源级）  → 否则 FORBIDDEN（记 permission_denial 审计）
4. 项目授权 grant（v92）     → 项目型能力且资源非空且 scope≠readonly：
                              必须持有 mcp_agent_grants 上该项目根的授权；
                              计划 ID 入参先 resolve_project_root 解析，解析不出 → FORBIDDEN
5. 资源归属（备注/任务）     → 仅能写自己创建的资源（若配置了 ownership）
```

任何一层失败都**明确拒绝**，不降级、不回退到只读执行。

**唯一入口**：`agent_access::permissions::require`（及 `require_any_read` / `authorized_reads`）。
CLI、MCP、REST 三个协议共用同一判定——**任何 Agent 都不能通过更换接入协议绕过权限**。
MCP 工具层的 `ensure_grant` / `ensure_can_read_project` 是该入口的薄包装（含 readonly 豁免），
不得绕开它自建判定。

### 3.1 scope / capability / grant 的职责边界

| 层 | 存储 | 回答的问题 | 关键规则 |
|---|---|---|---|
| scope | `mcp_agents.scope` | 总开关：能不能读、能不能写 | `project_rw` 只代表「可写」，不隐含创建权，也不隐含项目授权 |
| capability | `mcp_agent_capabilities` | 会什么（全局 `resource_id=''` 或精确项目根） | `projects.create` / `context.read` / `skills.read` 只支持全局；`context.read` 不能赋予任何项目读取权 |
| grant | `mcp_agent_grants` | 能动**哪个项目**（项目根，v91 外键） | 项目型能力（projects.read/write、plans.read、decisions.*、handoffs.*）读写都要求；readonly 是用户显式选择的全局只读，读不逐项目要 grant |
| 策略 | 创建服务 `CreatorProjectAndPlan` | 创建成功后给创建者什么 | 只写刚创建的项目根（projects.read + plans.read 能力 + grant 该根），绝不全局、不跨项目继承 |

### 3.2 读取范围的 grant 交集（v92）

`authorized_reads` 返回的能力范围在 `scope=project_rw` 下与 `mcp_agent_grants` 求交集
（projects / plans / decisions / handoffs 四个槽位）：全局能力收敛为「已授权的项目根集合」，
项目级能力只保留同时持有 grant 的根。列表查询（交接/决策/项目）据此服务端过滤，
`total` 为过滤后的数量；交集为空返回 `FORBIDDEN`（项目列表为空集合时同样拒绝，
不返回假空列表）。

## 4. 本地主体（Local Principal）

CLI 未提供 token 时，操作者是本机用户，等同于 UI：
- 读写全量（删除能力仍未开放）；
- 审计 `actor_kind=local`、`agent_id=""`；
- `TASKDOCK_CLI_READONLY=1` 强制只读。
理由：本机用户本就能直接改数据库/UI；把 CLI 视为「另一个 UI」比伪造一套用户体系更诚实。
风险与边界见 [security.md](security.md)。

## 5. Token 生命周期

- 生成：`tdm_` + 256 bit OS 随机；库内只存 SHA-256。
- 轮换：`rotate_agent_token` 立即替换哈希，旧 token 失效（无过渡期）。
- 撤销：`revoked_at` 置时间；所有接口下一次请求即拒绝。
- 存储：只在用户侧配置文件/环境变量；禁止写入日志、审计 detail、导出文件、manifest。
- 泄露处置：UI 一键轮换；审计可按 `agent_id` 过滤异常调用。

## 6. 权限授予（UI）

接入管理页逐项操作：scope、能力（复选框）、项目授权、文件工作区根目录（既有）。
每次变更写审计；变更后无需重启，下一次请求即生效。

## 7. 远程访问

- Agent API 默认只监听 loopback。
- 远程访问**未实现**；设置项存在但显示「未开放」，避免用户误以为已提供安全远程通道。
- 任何未来实现都必须：独立开关、独立端口、强制 TLS、独立授权、默认关闭。

## 8. 文件导入身份与授权（v81 修订）

> 本节取代「文件来源等同本机用户」的旧假设。旧实现里 `Source::File` 被当成
> `Principal::local(...)`，导致「能写某个 Inbox 目录」等价于「可修改 TaskDock 全部资源」。
> 现在 **来源不是身份**：`Identity` 才是。

### 8.1 四种身份

| 身份 | 构造 | 内部特权 | 说明 |
|---|---|---|---|
| `LocalHuman` | `Principal::local(Source::Ui/Cli)` | 有 | 可信本机用户，UI 与未带 token 的本机 CLI |
| `RegisteredAgent` | `Principal::agent(row_id, agent_id, source)` | 无 | 经 Token 认证的 Agent（MCP/REST/带 token 的 CLI） |
| `FileImport` | `Principal::file_import(...)` | 无 | 共享目录里的外部文件；**默认没有任何写权限** |
| `SystemInternal` | `Principal::system(Source::File)` | 有（仅内部维护） | 监听线程、导出等内部任务；同样不能替文件授权 |

判定入口统一在 `permissions::require` / `require_any_read`：只对 `LocalHuman` 与 `SystemInternal`
直接放行；`FileImport` 必须携带**显式授权上下文**（`ImportGrant`），否则一律 FORBIDDEN。

### 8.2 导入授权上下文（`ImportGrant`）

| 字段 | 含义 |
|---|---|
| `authorization_id` | `agent_import_policies.id`；人工单次批准为 `manual-approval` |
| `capabilities` | 允许的写能力集合（`tasks.write` / `knowledge.write` / `decisions.write` / `handoffs.write`） |
| `project_id` | 非空时只允许该项目 |
| `agent_row_id` | 绑定到某个已注册 Agent 时，该 Agent 的真实授权仍会再校验一次 |
| `approved_by` | `policy` 或审批人标签 |

### 8.3 目录策略（`agent_import_policies`）

| 模式 | 行为 |
|---|---|
| 无策略行 | **默认待审核**：只登记 `agent_import_requests`，不写业务表 |
| `off` | 明确拒绝该目录，文件移入 `_rejected/` |
| `review` | 待审核，等本机用户逐条批准 |
| `trusted` | 自动导入，但仍受能力集合与项目范围限制 |

`resolve_import_capability(kind)` 给出 kind → 真实写能力的映射；**禁止**用 `TasksWrite`
代表所有写权限。

### 8.4 判定结果

`authorize_file_import()` 返回三态，全部可审计：

| 结果 | 含义 | 业务表 |
|---|---|---|
| `Allowed(principal)` | 允许执行（受限主体） | 写入 |
| `NeedsReview{reason}` | 等待人工批准 | 不写入，文件保留在 Inbox |
| `Rejected{reason}` | 明确拒绝 | 不写入，文件移入 `_rejected/` |

### 8.5 身份不可伪造

- 文件里写的 `agent_id` 只是**声明**，不是凭据：目录未绑定 Agent 时永远不会被当作该 Agent；
- 目录绑定了 Agent A 时，文件声明 Agent B 会被拒绝（`Rejected`）；
- 绑定 Agent 被撤销后，后续导入立即失败。

### 8.6 OS 级边界（不可由本模块提供）

同一 OS 用户下，普通文件与 CLI **无法**形成强隔离边界。需要真正隔离的 Agent 应运行在受限
OS 用户或沙箱中；本模块只保证「不因目录可写而越权修改 TaskDock 资源」。

## 9. 读取判定细则（v82 修订）

### 9.1 能力与资源范围

读取能力按资源类型分别判定，互不替代：

| 能力 | 资源范围 | 读取对象 |
|---|---|---|
| `projects.read` | 全局或项目 | 项目元数据（名称、目标、规划摘要）、同步状态/冲突 |
| `tasks.read` | 全局、项目或具体任务 | 任务列表/详情、任务活动 |
| `plans.read` | 全局或项目 | 规划与里程碑 |
| `knowledge.read` | 全局、知识库或项目 | 知识库、文档、索引、检索 |
| `decisions.read` | 全局或项目 | 决策列表/详情、决策活动 |
| `handoffs.read` | 全局或项目 | 交接、报告、报告活动 |
| `context.read` | 仅全局 | **只**允许进入上下文装配；不授予项目/任务/知识/决策可见性 |

### 9.2 列表与活动

- 指定项目的任务列表先校验项目根上的 `projects.read` 及适用的项目授权，
  再取关联任务与 `tasks.read` 全局或精确任务授权的交集，最后计数和分页。
  只有项目权限而无任务读能力时返回 `FORBIDDEN`。无项目筛选的任务列表沿用全局任务读授权。
- 创建并关联项目需要 `projects.write`、该项目授权和全局 `tasks.write`。
  关联或解除已有任务需要前两项，以及该任务的精确或全局 `tasks.write`。解绑只改关系。

- 列表查询在**服务端 SQL** 过滤，分页 `total` 只统计授权范围；不依赖前端过滤。
- 活动记录按 `resource_kind + project_id/resource_id` 匹配：
  项目级授权可见该项目活动；任务/知识库级授权可见对应资源活动；无项目活动只对全局授权可见。
- 无任何资源读能力 → `FORBIDDEN`，不返回空列表。
- `GET /api/v1/sync/status` 与 `/sync/conflicts` 要求 `projects.read`（全局），本机/系统身份除外。

### 9.3 Context

- 显式项目必须由至少一项资源读能力覆盖；只持 `context.read` → `FORBIDDEN`。
- 显式指定已授权任务时，该任务与项目的真实关联可以限定装配范围。同项目其他任务仍需各自的读取授权。
  无权读取目标任务时返回 `FORBIDDEN`。详见 [任务上下文范围](context-engine.md#73-项目范围)。
- 项目名称/规划目标分别要求 `projects.read` / `plans.read`；未授权时输出为空，而不是回退全局。
- 近期活动经 `service::list_activity_authorized` 过滤；未授权内容不进入 Markdown 或 JSON。

### 9.4 文件导入

- CLI 的全量导出与工作空间初始化由本机用户执行。CLI 同步状态、冲突列表与 REST 一样，
  已注册 Agent 需要全局 `projects.read`。

- 文件来源不是身份；导入仍按目录策略 + 能力集合 + 真实资源归属判定。
- 读取交接/报告同样校验能力与项目范围（v82 收紧：不再对文件导入放行读）。

## 项目创建权限（2026-11-21，v92 补齐入口一致性）

- 新增 `projects.create`（**全局**能力，`global_only`）：项目尚不存在，逐资源授权无法表达；
- 新增 `projects.write`（项目级）：项目改名/归档等写操作（MCP `taskdock_update_project` /
  `taskdock_update_plan`、REST `PATCH /api/v1/projects/{id}` / `PATCH /api/v1/plans/{id}`、
  CLI `project update`——第三轮已全链路实现）；
- `scope=project_rw` 只代表「可写」，**不再隐含创建权**，也**不隐含项目授权**：
  写项目 = `projects.write` 能力 + 该项目根 grant；MCP/CLI/REST 都先校验 `projects.create`；
- **目录创建门禁（v92）**：`create_new` 只允许本机人类（LocalHuman）——UI 弹窗与未带 token 的
  CLI；RegisteredAgent 在 CLI / MCP / REST 一律拒绝，错误提示人类在 UI 完成目录创建。
  身份判定只用已解析的 Principal，禁止读 `TASKDOCK_AGENT_TOKEN` 环境变量猜测。
  `metadata_only` / `attach_existing` 按既有权限规则通过或拒绝；
- 创建成功后的自动授权只写刚创建的项目根（v91 外键），绝不写全局或计划 ID；创建与归属
  （`project_create_requests`）同事务落库，创建者重试（含授权失败后的重试）返回原项目；
- **幂等按主体隔离（v92）**：创建重试的作用域是「主体 × 请求 ID」——同一 Agent 同请求 ID 同摘要
  返回原项目，换摘要 `Conflict`；不同 Agent（或 Agent 与人类）相同请求 ID 各自独立创建，
  任何主体都不能通过重放获得其他主体创建的项目及其授权。
  详见 [统一项目身份与创建服务](../project-hub/10-统一项目身份与创建服务.md) §14；
- 计划 ID 入参先解析到项目根再判定（`ensure_grant` / `perms::require`），计划授权不会跨项目生效；
- Agent 项目列表按授权过滤：全局能力 + readonly 返回全部；只有项目级授权的 Agent 只看到
  被授权项目；无任何授权返回 `FORBIDDEN`（total 为过滤后数量）。

## 双聚合授权与创建事务（2026-11-22，第三轮）

- **授权恒锚定项目根**：计划聚合写（`PATCH /api/v1/plans/{planId}`、`taskdock_update_plan`）
  同样要求 `projects.write` + 计划所属项目根 grant——计划不是独立授权对象；
  计划工具传根 ID → Validation 指路（身份防混用），项目聚合传计划 ID → 边界归一根；
- **创建单事务**（`CreateProjectForAgentUseCase`）：`create_for_agent(_in_conn)` 把
  scope 重读（撤销即时生效）→ `projects.create` → 创建 → **仅首次创建**（`created=true`）
  自动授权项目根，收进同一事务；授权失败 = 整体回滚（项目/初始计划/幂等归属/事件），
  不存在「半条授权」或「无权成功」；MCP/CLI/REST 三入口共用；
  `CreatorProjectAndPlan` 降级为兼容别名（行为 = 只授项目根）；
- **撤销不可被重放恢复（第五轮）**：幂等重放（`created=false`）不写任何授权行。
  人类 `revoke_project` 后，Agent 用原 `clientRequestId` 重放只得到历史结果，
  读取仍 `FORBIDDEN`；只有人类再次 `grant_project` 才恢复访问。
  重放每次仍重新检查 scope 与 `projects.create`（Agent 被撤销/降 scope 后重放立即失败）；
- **写入口版本令牌必填（第五轮）**：项目根 / 计划更新缺 `expectedRevision` 直接 Validation；
  空补丁 Validation 且不推进 revision。撤销与并发保护必须同时成立，不能用一个换另一个；
- **幂等 fail-closed**：缺行 ID 的 RegisteredAgent 创建直接 Validation 拒绝（不再静默当作
  人类）；历史事件兜底按主体类别判定，Agent 任何情况不进入；事件 actor 与
  `payload.principal.principalId` 记真实主体行 ID；
- **审计**：`taskdock_update_plan` 与 `taskdock_update_project` 同列 `HIGH_RISK_ACTIONS`
  （项目级状态迁移写）。

## 专业领域 Phase 1 权限（2026-11-23）

### 判定顺序（固定）

```text
解析项目根（项目 ID / 计划 ID 兼容）
        │
        ▼
身份 → scope → 能力（ProjectsRead/Write）→ 项目根 grant
        │
        ▼
项目类型（DomainKind::Parse，未知类型拒绝，不回退 general）
        │
        ▼
项目状态（写要求 active；读允许 archived）
        │
        ▼
资源归属（数据库真实 project_id == 授权项目根）
        │
        ▼
业务读取 / 业务写入
```

唯一实现：`agent_access::domains::policy::resolve_authorized_project`
（读）与领域写核心内的同一调用 + `ensure_domain_write`。**不得**先
`ensure_domain` 再查 `ProjectsRead`——未授权 Agent 会从「项目类型不匹配」
推断项目类型。`policy` 单测覆盖跨项目资源统一错误 `资源不可访问`，不泄露存在性。

### Manifest

- `manifest::build_for_principal(db, principal, project_ref)` 是 MCP/REST/CLI 唯一入口；
  先解析项目根并通过 `projects.read`（含 grant，readonly 按全局只读规则），再读
  kind/status 并解析领域。
- 未授权时只返回统一 `FORBIDDEN`；不得返回项目 `kind`、`status`、`operations`。
- `project.kind` 是真实数据库类型：漫剧为 `ai_comic`；`domain` 为领域名 `comic`。
  两者混用会让 Agent 以 `comic` 去匹配 `workspace_projects.kind`，必须显式区分。

### 真实 RegisteredAgent 测试矩阵（本轮）

| 场景 | 期望 |
|---|---|
| 无项目 grant（`project_rw`） | `FORBIDDEN`，错误与项目类型无关 |
| 只有其他项目 grant | 目标项目 `FORBIDDEN` |
| `readonly` | Manifest 可读（全局只读，不要求逐项目 grant） |
| `disabled` | `FORBIDDEN`（身份层拒绝） |
| `revoked` | `FORBIDDEN`（每次请求重读 `revoked_at`） |
| 项目类型不匹配 | 授权通过后 `VALIDATION`（领域类型错误），不泄露给未授权者 |
| 跨项目资源 ID | `FORBIDDEN 资源不可访问`（统一错误，不泄露存在性） |
