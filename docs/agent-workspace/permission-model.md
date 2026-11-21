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

## 3. 判定顺序

```
1. 身份存在且未撤销         → 否则 UNAUTHORIZED
2. scope 允许该操作类别      → disabled 一律拒绝；只读不允许写
3. 能力存在（全局或资源级）  → 否则 FORBIDDEN（记 permission_denial 审计）
4. 项目范围（如适用）        → project_rw 还需项目授权 grant
5. 资源归属（备注/任务）     → 仅能写自己创建的资源（若配置了 ownership）
```

任何一层失败都**明确拒绝**，不降级、不回退到只读执行。

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

- 文件来源不是身份；导入仍按目录策略 + 能力集合 + 真实资源归属判定。
- 读取交接/报告同样校验能力与项目范围（v82 收紧：不再对文件导入放行读）。

## 项目创建权限（2026-11-21）

- 新增 `projects.create`（**全局**能力，`global_only`）：项目尚不存在，逐资源授权无法表达；
- 新增 `projects.write`（项目级）：预留给改名/归档/删除等写操作；
- `scope=project_rw` 只代表「可写」，**不再隐含创建权**；MCP/CLI/REST 都先校验 `projects.create`；
- 创建成功后的自动授权只写刚创建的项目根（v91 外键），绝不写全局或计划 ID；
- 计划 ID 入参先解析到项目根再判定（`ensure_grant` / `perms::require`），计划授权不会跨项目生效。
