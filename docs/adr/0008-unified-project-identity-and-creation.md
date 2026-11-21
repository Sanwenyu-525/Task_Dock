# ADR-0008：统一项目身份与统一项目创建服务

- 状态：Accepted（2026-11-21）
- 决策者：主 Agent（公共契约）+ Project Domain / Agent Access / UI 三个执行面
- 影响范围：`project_hub`、`commands/planning`、`commands/project_workspace`、`agent_access`、
  `mcp`、前端工作台/项目中枢/Agent 接入、`agent_workspace` 文件协议

## 背景

TaskDock 同时存在三个「项目」相关实体：`workspace_projects`（工作空间项目）、
`planning_projects`（规划项目）、`dev_projects`（仓库登记）。v78 已确定
`workspace_projects` 是唯一项目根、`planning_projects` 是计划容器，但入口层没有跟上：

- 规划入口 `planning::create_project_tx` 丢弃 `project_id`，MCP 创建项目后按**计划 ID** 写授权；
- Agent 项目列表同时遍历两张表，同一个项目返回两行；
- 项目创建 SQL 在 `project_hub::service`、`commands/planning`、`commands/project_workspace` 各有一份；
- 文件系统初始化完全没有：`root_path` 只是字符串，「目录不存在」被当成正常值。

结果是：Agent 拿到的 `projectId` 可能是计划 ID，授权挂在计划上，跨项目判定失效；人类在
工作台创建的项目与项目中枢创建的项目走不同规则；目录与数据库无法对账。

## 决策

1. **项目聚合根唯一** = `workspace_projects`；计划 = `planning_projects`，通过
   `workspace_project_id` 归属，`is_active` 与 `workspace_projects.active_plan_id` 同事务维护。
2. **ID 契约统一**：对外 `projectId` 一律是项目根；`planId` 独立；计划 ID 必须能反解析项目根；
   项目级授权只用项目根。
3. **唯一创建服务** = `project_hub::creation`。UI（快速/高级）、CLI、MCP、REST 全部调用它，
   禁止各自实现创建 SQL；创建结果统一返回 `projectId` + `activePlanId` + `project` + `activePlan` +
   `provisioningStatus`。
4. **项目根与初始计划同事务**；阶段/里程碑/功能/任务/目标/能力在同一事务内初始化，不允许半成品。
5. **目录初始化显式化**：`metadata_only` / `attach_existing` / `create_new` 三模式；
   `create_new` 先建目录再事务，事务失败只回滚本次创建的空目录，并用恢复日志覆盖崩溃窗口。
6. **权限新增** `projects.create`（全局，显式授予）与 `projects.write`（项目级）。
   `scope=project_rw` 不再隐含创建权；创建成功后的自动授权只作用于新项目根（+ 兼容计划 ID）。
7. **授权表外键改挂项目根**：`mcp_agent_grants.project_id` 原本 `REFERENCES planning_projects(id)`，
   统一身份后写项目根会直接触发外键失败，因此迁移 v91 先为有授权的历史计划补建项目根，
   再重建表并映射保留授权；计划 ID 入参在判定前解析，不再单独存计划授权。
8. **Agent 文件协议按项目根分目录**：`projects/{projectId}/project.md`、
   `projects/{projectId}/plans/{planId}/plan.md`；计划不再作为同级项目出现。

## 理由

- **为什么统一项目身份**：Agent 的长期工作单位是项目，不是某一次规划。授权、操作记录、上下文、
  文件协议都必须锚定同一个 ID，否则跨会话交接会指错实体。
- **为什么 Project 与 Plan 分开**：计划会被替换/并行（多方案），项目生命周期（active/archived）
  与计划执行状态（planning/in_progress/paused/completed）是两个正交轴；合并会导致改状态互相覆盖。
- **为什么 AgentWorkspace 独立**：它是 Agent 的读写契约目录（投影/导入/冲突），不是源码目录。
  合并会让「导入即改仓库」成为可能，破坏 v81 的导入审核边界。
- **为什么四入口共用服务**：幂等、事务、目录补偿、授权这四件事只要有一处实现不同，就会出现
  「UI 建的项目 Agent 读不到」「MCP 建的项目没有计划」这类不可复现的偏差。
- **为什么文件系统需要补偿**：SQLite 事务无法回滚 `create_dir`；不做补偿就会留下空目录，
  做成常驻 `provisioning` 状态又需要人工解锁。选择「短事务 + 恢复日志 + 只删空目录」。
- **权限如何隔离**：创建是全局能力、写是项目能力；计划 ID 先反解析项目根再判定，计划级授权不会
  溢出到其他项目；`context.read` 不携带任何项目数据权限。
- **兼容旧数据的方式**：只加迁移 v90 扩展能力 CHECK；旧计划自动补建项目根；旧 `project_events`
  无 V2 摘要时按旧摘要判定幂等；MCP 工具名与旧参数保持不变。

## 影响

- 破坏性变化：MCP `taskdock_create_project` 返回的 `id` 从「计划 ID」变为「项目 ID」，
  同时新增 `planId` / `activePlanId`。这是修正而非重构，需在写侧文档与客户端提示中明示。
- `planning_create_project` 的返回结构不变（仍是计划视图），但底层返回结果新增项目根字段，
  供内部调用方使用。
- 新增迁移 v90（能力白名单）与 v91（授权表外键改挂项目根），备份恢复按序补跑，旧授权不丢。

## 备选方案与放弃原因

| 方案 | 放弃原因 |
|---|---|
| 新建 `projects` 主表统一三套实体 | 破坏外键、备份顺序与既有 200+ 查询；收益只是命名整洁 |
| 保留计划 ID 作为对外 `projectId` | 授权、文件协议、操作记录全部锚错实体，且无法表达多计划 |
| 目录初始化交给前端 | 前端无法保证事务补偿与崩溃恢复，也绕过了服务端校验 |
| 用 `provisioning` 常驻状态机 | 需要后台对账与人工解锁，收益低于「短事务 + 补偿」 |

## 验证

见 `docs/project-hub/10-统一项目身份与创建服务.md` §11 与 `docs/project-hub/06-验收标准.md`
「统一项目身份」章节；证据目录 `tmp/acceptance/project-identity-v2/`。

## 实施结果与设计调整（2026-11-21 第二轮稳定性修复）

首版落地后暴露出三类缺陷，本轮只做定点修复，不改变上面的身份与创建决策。

### 1. 幂等必须早于任何副作用

- **问题**：`create()` 先 `prepare_directory()` 再 `check_replay()`。`create_new` 的第二次相同请求
  在目录已存在时提前返回 `Conflict`，「重试幂等」在唯一会产生副作用的模式下失效。
- **调整**：顺序固定为 `清洗 → 幂等查询 → 恢复 → 目录准备 → 单事务（事务内再判一次幂等）`。
  命中幂等时**完全不触碰文件系统**；`create_new` 遇 `Conflict` 时再查一次幂等，覆盖
  「并发/超时重试的另一个请求刚完成」的窗口；`create_with_conn` 同样先判幂等，避免
  「目录已被改名/删除」把重放变成新错误。
- **不变**：摘要规则、`requestDigestV2` 优先与旧摘要兼容、同 ID 不同参 → `Conflict`。

### 2. 恢复日志需要操作身份，而不是路径

- **问题**：日志条目只有 `path`，按路径去重与删除。恢复线程读到「已写日志、尚未建目录」的条目时
  会按「目录不存在」丢弃它；创建线程随后建目录并崩溃 → 目录永久失去恢复线索。恢复收尾又用
  最初读到的快照整表覆盖 → 并发创建追加的条目被覆盖。
- **调整**：条目升级为 `{opId, path, state, pid, leaseUntilMs, clientRequestId, createdAt}`。
  - `state`：`pending`（已声明未建目录）/ `created`（已建目录、事务未知）；
  - 处置只按 `opId`；旧条目（无 `opId`）按「路径 + createdAt」定位，永不误删新条目；
  - 恢复收尾在事务内**重新读取**日志再过滤，保留并发新增；
  - 日志损坏 → 返回 `Unavailable` 并阻止建目录（宁可拒绝创建，也不覆盖唯一恢复线索）。

### 3. 恢复并发协调：进程内精确、跨进程租约

- 进程内用 `ACTIVE_OPS`（opId 集合，`Drop` 释放，panic 也能摘除）判定「在途」，恢复绝不打断；
- 跨进程只认租约（5 分钟）：租约内的条目一律跳过，过期才允许回收；
- 只删「空目录 + 没有任何项目引用 + 本次操作创建」的目标，永远 `remove_dir`，绝不 `remove_dir_all`；
- 非空目录保留但出清条目（避免日志无限增长，也避免事后误删用户后放入的内容）；
- 启动时（`setup`）与每次创建前各跑一次，失败只记录，不阻塞应用启动。

仍未引入 `provisioning` 常驻状态机：日志是恢复手段，不是新状态。

### 4. 路径策略收敛到唯一判定

- 新增 `root_path_violation()`（Windows/Linux/macOS 分支）作为**唯一**语法判定，
  `clean_root_path`、`workspace_path_check`、`workspace_project_save` 共用；
- 拒绝 UNC（`\\server\share`、`//server/share`）与 `\\?\`/`\\.\` 扩展路径：`create_new` 与恢复
  依赖可靠的存在性/空目录判定，网络盘断连会把「不可访问」伪装成「不存在」；
  若将来支持网络目录，需先补连接探测与独立安全验证，不能只放开校验；
- 路径比较改为「归一化后相等」（Windows 忽略大小写/分隔符，macOS 忽略大小写），
  不再用 `COLLATE NOCASE` 的裸字符串比较，也不做前缀归属判断；
- `create_new` 记录建目录前的真实父目录，建后 `canonicalize` 核对父目录未被替换；
  目标为文件/目录/符号链接一律 `Conflict`，`attach_existing` 始终只读。

### 5. 数据库层面原子性（选型说明）

未新增唯一索引：`check_replay + insert` 始终在同一个 `BEGIN IMMEDIATE` 事务内，
写事务由单写连接串行化，跨进程由 SQLite 写锁串行化，因此「同一请求 ID 只能产生一条项目」
不依赖索引。放弃索引的理由是旧库可能已存在同 ID 重复事件，建唯一索引会让迁移失败并阻塞启动；
若后续确认历史数据干净，可再补部分唯一索引作为第二道保险。

### 6. 本轮验证边界

已实现且有单元测试覆盖的项见 `docs/project-hub/06-验收标准.md` §13；
未经真实 Dev 实例与原生窗口验证的项在该节标为「未验证」，不以单元测试替代。

