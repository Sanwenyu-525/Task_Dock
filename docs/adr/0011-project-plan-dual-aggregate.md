# ADR-0011：Project Root 与 Plan 双聚合及 API 契约

| 项目 | 内容 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-11-22 |
| 决策范围 | project_hub / agent_access（REST、CLI） / mcp / commands::planning |
| 关联 | [0008](0008-unified-project-identity-and-creation.md)（统一项目身份）、[0010](0010-unified-project-context.md)（前端统一项目上下文，编号由并行任务占用，本 ADR 顺延为 0011） |

## 1. 背景

ADR-0008 之后，项目根（`workspace_projects`）与计划容器（`planning_projects`）已经分离，
`resolve_project_ref` / `resolve_project_root` 是唯一解析入口。但对外接口仍把两个聚合
混在同一个「项目」概念里：

- REST `PATCH /api/v1/projects/{id}`：授权按项目根判定，revision 读取与更新却仍按
  **原始入参**查 `planning_projects.id`，返回体是计划行（PlanningProject）；
- MCP `taskdock_list_projects` 返回计划行；`taskdock_get_project` 读计划；
  `taskdock_update_project` 把计划执行状态当项目状态写入计划表；
- 项目根没有自己的 revision：更新借用计划 revision（v37），两个聚合的并发控制互相污染；
- MCP / CLI / REST 的创建授权事务边界不一致（MCP 事务内授权，CLI/REST 提交后授权）。

## 2. 当前问题

1. **身份混用**：同一个 `project_id` 字符串在不同接口里可能指项目根或计划，
   客户端无法稳定建立「创建 → 读取 → 更新」链路。
2. **revision 混用**：项目根字段更新借计划 revision 判冲突；GET 返回的 revision 与
   PATCH 校验的 revision 甚至不是同一行。
3. **状态混用**：项目生命周期（active/archived）与计划执行状态
   （planning/in_progress/paused/completed）互相覆盖。
4. **事务边界不一致**：CLI/REST 创建是「先提交项目、再补授权」，授权失败会留下
   「客户端已收到成功、Agent 却无权访问」的状态。

## 3. 决策

### 3.1 双聚合模型

| | Project Root（项目根） | Plan（计划） |
|---|---|---|
| 表 | `workspace_projects` | `planning_projects` |
| ID | `ProjectId`（workspace_projects.id） | `PlanId`（planning_projects.id） |
| 生命周期 | `status: active / archived`（lifecycleStatus） | `status: planning / in_progress / paused / completed`（执行状态）+ archived 标记 |
| revision | `workspace_projects.revision`（v93 新增，DEFAULT 1） | `planning_projects.revision`（v37） |
| 唯一事实字段 | name / kind / description / goal / target_date | execution status / sort_order / archived / is_active |
| 兼容镜像 | — | name / description / target_date（只读镜像，根是事实源） |
| 服务层 | `project_hub::service`（ProjectService） | `commands::planning`（PlanningService） |

镜像同步规则：项目根字段变更由 `update_project_fields_tx` 在同一事务内同步到全部计划行；
计划侧不回写根的生命周期状态。

### 3.2 API 资源边界

| 资源 | 语义 | revision | 服务 |
|---|---|---|---|
| `GET/PATCH /api/v1/projects/{projectId}` | 项目根 | 根 revision（v93） | ProjectService |
| `GET/PATCH /api/v1/plans/{planId}` | 计划 | 计划 revision（v37） | PlanningService |

- Project PATCH 可改：name / kind / description / goal / targetDate / lifecycleStatus。
- Plan PATCH 可改：name / description / status（执行状态）/ targetDate / sortOrder。
- `PATCH /plans/{planId}` 需 `projects.write` 能力 + 计划所属项目根的 grant
  （授权始终锚定项目根）。
- 旧入口继续接受计划 ID 作为入参（兼容适配器），内部先解析为根再走根服务；
  业务服务内部禁止按字符串猜测实体类型。

### 3.3 项目根 revision（v93）

- 生成：插入根时默认 1；`update_project_fields_tx` 在同一事务内
  「读 → 比对 expectedRevision → `revision + 1`」，不匹配返回 Conflict。
- 读取：`project_hub::service::ProjectSummary.revision` 与 REST
  `agent_access::service::project_summary` 同源（列值），GET 与 PATCH 使用同一事实源。
- 独立性：改项目根只动根 revision；改计划执行状态只动计划 revision；
  计划更新携带 name/description/targetDate 时会写根镜像字段，根 revision 相应递增
  （两个计数器各自跟踪各自表的写入）。
- 校验实现：`project_hub::service::check_expected_revision_tx` 是唯一实现，
  计划行与根行共用。

### 3.4 MCP 工具契约

- `taskdock_list_projects`：返回项目根读模型（projectId=根、activePlanId、根 revision）。
- `taskdock_get_project`：项目根详情（含 plans 列表）。
- `taskdock_update_project`：只更新根字段（name/kind/description/goal/targetDate/
  lifecycleStatus），expectedRevision 对根 revision；`project_id` 参数接受旧计划 ID
  入参并解析为根，schema/description 明确语义。
- 新增 `taskdock_update_plan` / 计划读路径：计划字段走计划 revision。
- 旧工具不删除：参数名兼容 + 语义显式化，破坏性变化在工具描述中写明
  （旧客户端把执行状态传给 update_project 会得到明确的 Validation 提示，改用计划工具）。

### 3.5 创建授权事务（CreateProjectForAgentUseCase）

Agent 创建（MCP / CLI / REST 三入口共用）：

```
单事务：验证主体行 ID（fail-closed）
      → 拒绝 create_new（目录副作用只能由人类发起）
      → scope 校验（project_rw）
      → projects.create 全局能力
      → create_with_conn（幂等归属 + 项目根 + 初始计划 + 事件，同事务）
      → grant_created_project_in_conn（只授项目根）
      → commit
```

- 事务边界不一致消除：授权失败 = 整体回滚，不存在「半条授权」或「无权成功」。
- `AgentAccessPolicy::CreatorProject` 是唯一自动授权语义；`CreatorProjectAndPlan`
  保留为兼容别名（行为一致：只授项目根；v91 起外键已禁止计划级授权行）。
- 人类 UI 创建继续走 `creation::create()`（目录初始化与补偿在事务外）。
- 幂等 fail-closed：`Prepared` 携带独立 `principal`；缺行 ID 的 RegisteredAgent 直接
  拒绝；Agent 请求永不进入人类历史事件兜底；actor 与 payload.principal 按真实主体记录。

## 4. 备选方案与不采用原因

| 备选 | 不采用原因 |
|---|---|
| 项目根继续借用计划 revision（updated_at/计数器派生） | 两个聚合的并发控制互相污染；agent_access 计数器派生值与 PATCH 校验不同源，正是本次要消除的混用 |
| 单一「项目」聚合吸收计划字段 | 推翻 v90–v92 已落地的双表模型；计划归档/继任/激活不变量已绑定计划行 |
| REST PATCH 继续兼容执行状态字段 | 状态语义二义性正是缺陷根源；用明确 Validation 提示替代静默混用 |
| 旧 MCP 工具直接删除 | 破坏已有 Agent 客户端；改用「语义显式化 + 解析兼容」 |
| 创建授权保留「提交后补授权」 | 授权失败留下客户端不可识别的半状态；Agent 目录路径无文件系统副作用，完全可事务化 |

## 5. 影响模块

`project_hub/{service,schema}`、`db/mod.rs`（v93）、`commands/planning`、
`agent_access/{service,rest,cli,context,project_creation}`、`mcp/tools`、
`project_hub/creation`、文档九件套（project-hub/05/06/10、agent-workspace 五件、ADR 索引）。

## 6. 迁移与兼容

- v93 纯加列（`workspace_projects.revision DEFAULT 1`），不改已发布迁移，旧行为
  （不传 expectedRevision）完全不变。
- 旧客户端传计划 ID 给 Project 接口：边界解析为根后按根语义处理；计划专属字段
  （执行状态）改走 Plan 接口，返回明确错误而非静默写错聚合。
- 历史数据不迁移不删除；计划行的镜像列继续由根变更同步。

## 7. 测试要求

ProjectId/PlanId 区分、根/计划 revision 独立递增、过期 revision 分别返回 409/Conflict、
GET→PATCH→GET 全链路、三入口创建结果一致、授权失败无半条数据、同主体重放不重复创建、
跨 Agent 幂等隔离、计划更新不改根生命周期、根更新不改计划执行状态、
镜像名称同步、MCP 旧参数兼容。

## 8. 回滚条件

v93 加列导致存量库升级失败，或双聚合拆分造成既有 UI/Agent 客户端不可恢复的破坏时，
回退接口层；revision 列保留无害，可独立保留。

## 9. 实际验证（2026-11-22，v93 实现后）

| 验证 | 结果 |
|---|---|
| `cargo test --lib -- project_hub:: agent_access:: mcp:: commands::planning::` | 365 passed / 0 failed |
| `cargo test --test project_creation_identity`（隔离 target） | 18 passed / 0 failed |
| `cargo test --test mcp_e2e`（隔离 target） | 3 passed / 0 failed |
| `npm run typecheck` | 0 错误 |
| 前端三单文件 vitest | 14 / 29 / 17 全过 |
| CLI 端到端 A–J（隔离库，全新迁移 v93） | 根 revision 链 1→2→3→4、计划 revision 恒 1、计划执行状态不随根写迁移、未授权 FORBIDDEN、过期根 revision Conflict、计划 ID 入参归根；证据 `tmp/acceptance/agent-gov-round4/` |

已验证的契约细节：`taskdock_update_project` 用根 revision 而非计划 revision（mcp_e2e 夹具
计划 revision=3、根 DEFAULT 1）；项目删除级联清理 grant 与幂等归属行；
`PATCH /plans/{rootId}` → Validation（计划域不伪造计划行）。
