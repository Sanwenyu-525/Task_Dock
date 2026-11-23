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
计划侧不回写根的生命周期状态。v94 的计划激活与归档可改变根的 `active_plan_id`，
这类变更在同一事务推进项目根版本和受影响计划的版本。MCP 生命周期工具同时检查目标计划与
项目根的版本，避免旧选择覆盖当前计划。恢复单个计划只推进该计划自己的版本。

### 3.2 API 资源边界

| 资源 | 语义 | revision | 服务 |
|---|---|---|---|
| `GET/PATCH /api/v1/projects/{projectId}` | 项目根 | 根 revision（v93） | ProjectService |
| `GET/PATCH /api/v1/plans/{planId}` | 计划（**严格 PlanId**） | 计划 revision（v37） | PlanningService |
| `GET /api/v1/plans/current` | 当前活动计划 | — | PlanningService |

- Project PATCH 可改：name / kind / description / goal / targetDate / lifecycleStatus。
- **Plan PATCH 只能改**：execution status（`planning_projects.status`）/ sortOrder。
  名称、描述、目标日期是项目根的事实字段，`PATCH /plans/{planId}` 不提供这些写入能力
  （请求体里出现会被忽略 schema，服务层不接受；MCP 工具会明确拒绝并指路）。
- `PATCH /plans/{planId}` 需 `projects.write` 能力 + 计划所属项目根的 grant
  （授权始终锚定项目根）。
- 同一路径的 GET 与 PATCH 必须同义：`/plans/{id}` 的 id 始终是 PlanId。
  项目根 ID → Validation，不再「GET 静默取 active 计划、PATCH 却要求 PlanId」。
  项目根到活动计划的快捷查询用 `GET /api/v1/plans/current` 或
  `GET /api/v1/projects/{projectId}`（返回 activePlanId）。
- 旧入口 `/projects/{planId}` 继续接受计划 ID 作为入参（兼容适配器），内部先解析为根
  再走根服务；业务服务内部禁止按字符串猜测实体类型。

### 3.2.1 版本令牌必须显式

- REST / MCP / CLI / 桌面 IPC 的**通用更新入口**都必须携带对应聚合的 revision：
  - 项目根：`expectedRevision` / `expected_project_revision`（REST/MCP/CLI/IPC）；
  - 计划：`expectedRevision` / `expected_plan_revision`。
- 缺失令牌直接 `Validation`，不允许「Option 为 None 就跳过检查」。
- 唯一例外是**明确区分的内部/领域方法**：项目归档/恢复（`set_project_status`）、
  工作空间编辑器的根路径保存、旧计划补链后的首次写入。它们不暴露为普通业务更新入口，
  但仍照常推进所属聚合 revision。
- 空补丁（只有令牌、没有任何字段）→ `Validation("没有可更新的字段")`；
  revision 不变、`updated_at` 不变、不产生业务事件、不写成功审计、不产生 committed 操作。

### 3.3 项目根 revision（v93）

- 生成：插入根时默认 1；`update_project_fields_tx` 在同一事务内
  「读 → 比对 expectedRevision → `revision + 1`」，不匹配返回 Conflict；
  缺 `expected_project_revision` 直接 Validation。
- 读取：`project_hub::service::ProjectSummary.revision` 与 REST
  `agent_access::service::project_summary` 同源（列值），GET 与 PATCH 使用同一事实源；
  计划读模型额外返回 `project_revision`，桌面编辑器用它作为根写入的令牌。
- **两个 revision 完全独立**：改项目根只动根 revision；改计划执行状态只动计划 revision。
  根字段更新同步 `planning_projects.name/description/target_date` 镜像列时**不推进**
  计划 revision；计划更新也**不推进**根 revision。
- 校验实现：`project_hub::service::check_expected_revision_tx` 是唯一实现，
  计划行与根行共用。

### 3.4 MCP 工具契约

- `taskdock_list_projects`：返回项目根读模型（projectId=根、activePlanId、根 revision）。
- `taskdock_get_project`：项目根详情（含 plans 列表）。
- `taskdock_update_project`：只更新根字段（name/kind/description/goal/targetDate/
  lifecycleStatus），expectedRevision 对根 revision；`project_id` 参数接受旧计划 ID
  入参并解析为根，schema/description 明确语义。
- `taskdock_update_plan`：**只**更新计划自身字段（execution status / sortOrder），
  expectedRevision 对计划 revision。schema 不再声明 name/description/target_date；
  旧客户端仍传这些字段 → Validation 指路 `taskdock_update_project`。
- 计划聚合写工具的审计与操作资源身份：
  `resource_kind = plan`、`resource_id = PlanId`、`project_id = 所属项目根`、
  `revision = 计划 revision`。绝不把 PlanId 放进 project 资源类型。
- `planning-changed` 事件：
  - 根更新 → `{ kind: "project", projectId: 根, revision: 根 revision }`；
  - 计划更新 → `{ kind: "plan", projectId: 根, planId: 计划, revision: 计划 revision }`。
  前端按 `kind`/`planId` 判断是否刷新当前工作区，不用 projectId 冒充计划 ID。
- 旧工具不删除：参数名兼容 + 语义显式化，破坏性变化在工具描述中写明
  （旧客户端把执行状态传给 update_project 会得到明确的 Validation 提示，改用计划工具）。

### 3.4.1 桌面端编辑器（ProjectEditorView）

- 名称/描述/目标日期 → 项目根服务；执行状态 → 计划服务。两边分别携带**打开编辑器时**
  读取到的 revision（快照，不随 store 刷新漂移）。
- 一次改两个聚合时走 `UpdateProjectAndPlanUseCase`（`planning_update_project_and_plan`）：
  同一事务内校验两个 revision → 改根 → 同步镜像 → 改计划字段 → 两个 revision 各自 +1；
  任一冲突整体回滚，不出现「名称已改、状态未改」。
- 冲突提示明确、保留用户输入、不自动用本地值覆盖服务端新数据；保存中禁止重复提交。

### 3.5 创建授权事务（CreateProjectForAgentUseCase）

Agent 创建（MCP / CLI / REST 三入口共用）：

```
单事务：验证主体行 ID（fail-closed）
      → 拒绝 create_new（目录副作用只能由人类发起）
      → scope 校验（project_rw）
      → projects.create 全局能力
      → create_with_conn（幂等归属 + 项目根 + 初始计划 + 事件，同事务）
      → created.created == true ?
           是 → grant_created_project_in_conn（只授项目根）
           否 → 直接返回历史结果，不写任何授权
      → commit
```

- **授权只在首次创建时发生**。幂等重放（`created.created == false`）不得补写授权：
  人类撤销的授权不可被 Agent 用原 `clientRequestId` 重放恢复。
- 事务边界不一致消除：授权失败 = 整体回滚，不存在「半条授权」或「无权成功」，
  也不残留幂等归属行（否则同请求 ID 永远无法重试）。
- `AgentAccessPolicy::CreatorProject` 是唯一自动授权语义；`CreatorProjectAndPlan`
  保留为兼容别名（行为一致：只授项目根；v91 起外键已禁止计划级授权行）。
- 人类 UI 创建继续走 `creation::create()`（目录初始化与补偿在事务外）。
- 幂等 fail-closed：`Prepared` 携带独立 `principal`；缺行 ID 的 RegisteredAgent 直接
  拒绝；Agent 请求永不进入人类历史事件兜底；actor 与 payload.principal 按真实主体记录。
- 重放仍然**每次都重新检查** scope 与 `projects.create`：撤权/降 scope 后重放立即失败。
  显式重新授权（人类 `grant_project`）后，Agent 才能恢复访问。
- MCP 工具层 requestId 的重放测试不能替代 CreationUseCase 的直接测试：两层幂等机制
  独立，本 ADR 的规则由 `agent_access::project_creation::tests` 直接覆盖。

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

- v93 纯加列（`workspace_projects.revision DEFAULT 1`），不改已发布迁移。
- **版本令牌从可选改为必填**（第五轮，2026-11-23）：REST/MCP/CLI/IPC 的通用更新入口
  缺 revision 返回 Validation。这是有意的破坏性收紧：旧行为「不传即跳过检查」正是
  「旧版本请求覆盖新数据」的根因。调用方需先 GET 再带着 revision 提交；
  CLI 的 `project update` 因此要求 `--base-revision`。
- 计划 PATCH 移除 name/description/targetDate 写入能力：旧客户端改这些字段会得到
  Validation（REST）或明确指路（MCP/CLI）。改为 `PATCH /projects/{projectId}`。
- `GET /plans/{projectRootId}` 由「返回 active 计划」改为 Validation：改用
  `GET /plans/current` 或 `GET /projects/{projectId}`。
- 旧客户端传计划 ID 给 Project 接口：边界解析为根后按根语义处理；返回体是 ProjectSummary。
- 历史数据不迁移不删除；计划行的镜像列继续由根变更同步。

## 7. 测试要求

ProjectId/PlanId 区分、根/计划 revision 独立递增、过期 revision 分别返回 409/Conflict、
GET→PATCH→GET 全链路、三入口创建结果一致、授权失败无半条数据、同主体重放不重复创建、
跨 Agent 幂等隔离、计划更新不改根生命周期、根更新不改计划执行状态、
镜像名称同步、MCP 旧参数兼容。

第五轮补充（必须全部覆盖）：

- 撤权后重放：项目不重建、授权行不存在、读取 FORBIDDEN；显式重新授权才恢复；
- 连续重放不新增数据、不推进 revision；首次授权失败整体回滚（含幂等归属）；
- 组合更新原子性：任一 revision 冲突整体回滚；
- 空 PATCH 不推进 revision、不产生事件/成功审计/committed 操作；
- MCP 计划操作记录 `resource_kind=plan`、`resource_id=PlanId`、`project_id=根`；
- `planning-changed` 的 project/plan 事件分别携带正确的 revision 与 planId。

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

## 10. 第五轮修订（2026-11-23）

第四轮验收证明 §3.2/§3.3/§3.5 仍有实现偏差，本轮按「代码即事实」修订：

| 旧契约（已废止） | 新契约 |
|---|---|
| `planning::ProjectPatch` 同时承载根字段与计划字段 | `ProjectRootPatch`（根）与 `PlanPatch`（计划）分离；旧类型与 `planning_update_project` 删除 |
| Plan PATCH 可改 name/description/targetDate | 禁止：这些是项目根事实字段，只能经 `update_project_fields_tx` 写根并同步镜像 |
| `expected_revision` 可选，缺省跳过检查 | 通用更新入口必填；缺失 Validation；唯一例外是明确区分的领域/补链首次写入 |
| 空 PATCH 仍 `revision + 1` | 空 PATCH Validation；revision/updated_at 不变、无事件、无成功审计、无 committed 操作 |
| `GET /plans/{id}` 接受项目根并回落 active 计划 | 严格 PlanId；根 ID → Validation；`/plans/current` 与 `/projects/{id}` 承担快捷查询 |
| `taskdock_update_plan` 记 `resource_kind=project` + PlanId | `resource_kind=plan`、`resource_id=PlanId`、`project_id=根`、`revision=计划 revision` |
| `planning-changed` 只有 projectId（实际放计划 ID） | `kind=project|plan` + `projectId`（根）+ `planId`（计划）+ 对应 revision |
| 创建自动授权无条件执行（重放也授权） | 仅 `created.created == true` 授权；重放不恢复已撤销权限；授权失败整体回滚 |

### 验证（本轮实际执行，2026-11-23）

| 命令 | 结果 |
|---|---|
| `cargo test --lib agent_access::project_creation::tests` | 11 passed / 0 failed |
| `cargo test --lib mcp::tests` | 64 passed / 0 failed |
| `cargo test --lib commands::planning::tests` | 13 passed / 0 failed |
| `cargo test --lib agent_access::` | 231 passed / 0 failed |
| `cargo test --test project_creation_identity` | 18 passed / 0 failed |
| `cargo test --test mcp_e2e` | 3 passed / 0 failed |
| `cargo test --test project_lifecycle` | 26 passed / 0 failed |
| `npm run typecheck` | 0 错误 |
| `npx vitest run`（5 个定向文件） | 113 passed / 0 failed |

未验证项（如实记录）：没有可用的真实 MCP 客户端做「撤权 → 重放」的端到端演练，
该场景由 `project_creation` 直接用例与 `mcp::tests` 的鉴权/操作记录用例覆盖；
`cargo test --lib` 全量（非过滤）在本轮未执行，原因是共享工作树中存在其他任务的
并行改动，只运行与本任务相关的过滤组。
