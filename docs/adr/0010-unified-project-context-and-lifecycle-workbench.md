# ADR-0010：统一项目上下文与项目生命周期工作台

- 状态：Accepted（2026-11-22，用户授权进入方案落地）
- 落地提交：b1beede（workspace_project_id 契约）、2713cc7（ProjectContext）、ac9ed3e（项目中枢）、ed8e8a8（Plan 语义与深链修复）
- 决策范围：桌面端 Workbench、项目中枢、规划编辑、专业工作空间、跨页面导航与 Agent 精确定位
- 关联决策：扩展 [ADR-0008：统一项目身份与项目创建服务](0008-unified-project-identity-and-creation.md)
- 本 ADR 不改变 ADR-0008 的项目根、计划容器和统一创建服务决策。

## 1. 背景与目标

TaskDock 中与用户项目生命周期有关的三个专业领域是：

1.  **项目中枢（Project Hub）**：管理项目身份、目标、生命周期、整体状态、风险、能力、资源和交付验收。
2.  **规划（Planning）**：组织计划、阶段、里程碑、功能拆解、步骤、验收标准和计划调整。
3.  **专业工作空间（Project Workspace）**：承载具体生产活动、领域数据、文件、专业模块和执行现场。

三个领域应该保持专业职责独立，但不能让用户感知为三套互不相关的项目系统。用户在任意页面选择一个项目后，其他页面必须自然地继续围绕同一个项目工作。

本决策的目标是：

- 一个项目根身份；
- 一个全局项目上下文；
- 一个全局项目切换入口；
- 三个专业领域各自保留合适的页面和交互；
- 计划 ID、项目根 ID、开发仓库 ID 严格区分；
- 页面切换、项目切换、深链定位和多窗口同步不产生上下文漂移。

## 2. 当前源码审计事实

以下是本次审计确认的实现事实，不是目标设计：

| 位置                                                     | 当前实现                                                                                                                                                  | 问题                                                                      |
|----------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| `src/workbench/WorkbenchShell.tsx`                       | `selectedId`、`selectProject`、`refreshProjects` 和 `ActiveProjectWriter` 管理工作空间项目；顶栏已有全局项目选择器；持久化键为 `workspace_active_project` | 已经具备全局选择的基础，但状态由 Shell 局部持有，其他页面没有统一消费契约 |
| `src/components/roadmap/ProjectHubPanel.tsx`             | 自己维护 `projects`、`selectedId`，调用 `projectHubListProjects`，工具栏另有「当前项目」选择器                                                            | 与 Workbench 顶栏形成第二套项目选择状态                                   |
| `src/components/roadmap/PlanningWorkspace.tsx`           | `initialProjectId` 实际由 `active.planId` 传入；内部按 `PlanningProject.id` 选择并加载功能                                                                | 参数和状态命名把计划 ID 误称为项目 ID                                     |
| `src/store/usePlanningStore.ts`                          | `activeProjectId` 实际是 `planning_projects.id`；`selectProject(id)` 用该 ID 加载功能和里程碑                                                             | Store 的项目语义与 ADR-0008 的项目根语义冲突                              |
| `src-tauri/src/commands/planning.rs::list_projects_impl` | 只返回每个项目当前激活计划（以及未补链的孤立旧计划）                                                                                                      | 返回结果不是完整计划版本列表，不能直接充当同一项目的计划版本选择器        |
| `src/workbench/ProjectWorkspacePanel.tsx`                | 将 Shell 选中的项目根 ID 传给 `useWorkspaceProjectContext`                                                                                                | 已有代际隔离、过期请求丢弃和写入归属保护，是应该复用的基础                |
| `src/workspace/activeProjectWriter.ts`                   | 串行化 `workspace_active_project` 写入，保证 latest-wins                                                                                                  | 应保留为唯一持久化写入机制，不另建并行写队列                              |
| `src/store/useUiStore.ts` / `PlanningWorkspace.tsx`      | 导航请求的 `projectId` 按全局导航契约来自项目根；但 `runRoadmapFocus` 当前直接拿它与规划 Store 的计划 ID 比较                                             | Project ID 与 Plan ID 在精确定位链路中存在实际语义错配风险                |
| `src/components/agents/AgentPlanningLinks.tsx`           | 把规划功能所属的 `link.project_id` 传给 `requestPlanningFeatureLocate`，参数名却叫 `projectId`                                                            | 该字段在规划功能关系中是计划归属 ID，必须明确命名并解析到项目根           |

### 2.1 相关数据模型已经给出的边界

ADR-0008 已经确定：

- `workspace_projects.id` 是唯一项目根 ID。
- `planning_projects.id` 是计划 ID。
- `workspace_projects.active_plan_id` 指向当前激活计划。
- 一个项目可以有多个计划，但同一时刻只有一个 active 计划。
- `dev_projects.id` 是开发仓库登记 ID，只能通过弱引用关联项目，不能与项目根 ID 混用。
- 项目级授权、项目上下文和对外 `projectId` 一律使用项目根 ID。

本 ADR 不重新定义这些事实，只要求 UI、Store 和导航严格遵循它们。

## 3. 决策

### 3.1 三个领域保持独立职责，不再保持独立项目体系

| 领域         | 核心问题                                       | 负责内容                                                                     | 不负责的内容                                   |
|--------------|------------------------------------------------|------------------------------------------------------------------------------|------------------------------------------------|
| 项目中枢     | 项目是什么、为什么做、现在怎么样、下一步是什么 | 项目目标、项目生命周期、整体进度、风险、能力需求、项目资源引用、交付物与验收 | 不复制专业编辑器，不重新实现任务 CRUD          |
| 规划         | 项目应该怎么做、如何拆解和调整                 | 计划、阶段、里程碑、功能、步骤、验收标准、计划版本                           | 不创建第二个项目根，不独立决定全局项目         |
| 专业工作空间 | 具体在哪里做、如何生产成果                     | 五种 Profile、领域模块、专业数据、文件、项目事项、生产现场                   | 不维护第二份项目目标、项目根身份或全局项目选择 |

专业页面可以独立加载、独立布局、独立维护局部 UI 状态，但必须使用同一个项目根上下文。

### 3.2 信息架构：项目中枢是生命周期入口，规划是其专业工作视图

目标信息架构：

``` text
Workbench
├─ 顶栏：唯一全局项目选择器（projectId）
│
├─ 项目中枢（项目生命周期入口）
│  ├─ 总览
│  ├─ 规划
│  │  ├─ 目标
│  │  ├─ 阶段 / 里程碑
│  │  ├─ 功能 / 步骤 / 验收标准
│  │  └─ 计划版本（具备对应 API 后开放）
│  ├─ 能力
│  ├─ 项目资源
│  └─ 执行 / 交付物
│
├─ 专业工作空间（独立生产环境）
│  ├─ 小说 / 游戏 / 漫剧 / 通用 / 开发 Profile
│  └─ 专业模块、项目事项、文件与产出
│
├─ 任务中心（跨项目统一调度）
│
└─ 系统级页面
   ├─ TaskDock 内置路线图（产品自身路线图）
   └─ 协作中心（按其独立的数据域和权限模型运行）
```

具体约束：

- 项目中枢与规划编辑属于同一个项目生命周期体系；规划编辑器可以作为项目中枢的正式工作视图，也可以通过兼容深链打开完整编辑界面，但不得形成第二套项目选择与项目列表状态。
- 专业工作空间继续保持独立页面、独立专业 UI 和按需加载机制。它是项目的生产环境，不应被压缩成项目中枢中的一个普通 Tab。
- TaskDock 自身的内置路线图不是用户项目的计划，不应被当前用户项目上下文过滤。
- 协作中心是否展示项目维度内容，按其既有 `workspace_project_id` 和授权契约执行；不能仅因它出现在规划页面就假定它与用户计划共用同一套实体。
- 保留现有 `roadmap` 路由身份、快捷键和兼容深链；导航重组不得造成旧入口失效。

### 3.3 唯一全局项目选择器

WorkbenchShell 顶栏现有项目选择器是唯一全局项目根选择入口。

- 项目中枢不得再展示第二个项目根选择器。
- 规划编辑不得用计划列表冒充项目选择器。
- 专业工作空间不得另建一套项目根选择器。
- 其他页面如需跳转项目，调用统一 `selectProject(projectId)`，不得自行写 `workspace_active_project`。
- 新建项目成功后，应将新项目根 ID 提交给全局上下文并刷新项目列表。
- 切换项目时保持当前页面领域不变，页面内容切换到新项目；不应因为项目切换而无故跳回某个固定页面。
- 项目为空或尚未选择时，显示明确空态，不得静默选择列表中的第一个项目。
- 项目被删除或归档时，按统一生命周期规则清理当前选择；不能继续展示幽灵项目。

### 3.4 Project ID、Plan ID、Dev Project ID 三种身份严格区分

| 标识             | 权威来源                            | 使用范围                                                   | 禁止行为                            |
|------------------|-------------------------------------|------------------------------------------------------------|-------------------------------------|
| `projectId`      | `workspace_projects.id`             | 全局上下文、项目切换、项目级导航、授权、项目快照、工作空间 | 不得传入需要 plan ID 的规划功能查询 |
| `activePlanId`   | `workspace_projects.active_plan_id` | 当前项目激活计划的只读元数据                               | 不得作为全局项目上下文              |
| `planId`         | `planning_projects.id`              | 规划功能、阶段、里程碑、计划详情和计划版本操作             | 不得冒充项目根 ID                   |
| `selectedPlanId` | 规划页面局部视图状态                | 用户当前查看的计划；可以与 `activePlanId` 不同             | 不得隐式激活计划或改变全局项目      |
| `devProjectId`   | `dev_projects.id`                   | Git 仓库登记、开发现场、仓库探测                           | 不得写入 `workspace_active_project` |

`activePlanId` 是项目根的属性，不是第二个全局上下文。`selectedPlanId` 是规划页面的局部浏览状态；只有用户明确执行「设为当前计划」后，才通过既有项目服务更新 `active_plan_id`。

### 3.5 全局上下文的实现策略

**第一阶段优先采用 Context Adapter，不再创建第二份全局状态。**

- `WorkbenchShell` 继续拥有现有 `projects`、`selectedId`、`selectProject`、`refreshProjects` 和项目切换事务。
- 新建轻量 React Context（建议 `src/workbench/ProjectContext.tsx`），只把 Shell 已有状态和方法暴露给路由页面。
- `ProjectContextProvider` 不得再维护另一份 `selectedProjectId`，也不得另建 Zustand Store 与 Shell 状态双向同步。
- 页面通过 `useProjectContext()` 获取 `projectId`、`selectedProject`、`projects`、`selectProject`、`refreshProjects` 和加载状态。
- `workspace_active_project` 继续作为跨启动恢复的持久化偏好；运行期唯一写入仍走 `ActiveProjectWriter`。
- 跨窗口刷新继续复用现有设置变更事件和导航回执契约；不能新增一个与其竞争的持久化来源。
- `workbench_current_project` 继续代表 `dev_projects.id`，不得并入 `workspace_active_project`。

建议接口（以实际 `WorkspaceProject` 类型为准，不得照抄字段假设）：

``` ts
interface ProjectContextValue {
  projectId: string | null;
  selectedProject: WorkspaceProject | null;
  projects: WorkspaceProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  selectProject: (projectId: string | null) => Promise<boolean>;
  refreshProjects: () => Promise<WorkspaceProject[]>;
}
```

若页面需要 `activePlanId`，通过当前项目根的权威快照读取或由根摘要派生，不要在多个 Store 内复制一份可独立写入的 activePlanId。

### 3.6 规划编辑器的计划语义

- 将 `PlanningWorkspace.initialProjectId` 更名为 `initialPlanId`，因为现有调用方传入的是 `active.planId`。
- 将规划 Store 内代表 `planning_projects.id` 的 `activeProjectId`、`selectProject`、`loadedForProject` 等命名调整为 `activePlanId`、`selectPlan`、`loadedForPlan` 等；逐一更新调用方和测试。
- 旧 Rust IPC 命令 `planning_list_projects` 等可暂时保持原名以兼容 MCP、CLI 和旧客户端，但前端必须在适配层明确其实际返回的是计划记录/当前激活计划。
- 当前 `planning_list_projects` 只返回每个项目的 active 计划，不是某个项目的全部计划版本。不得把它直接展示为同一项目的计划版本选择器。
- 在多计划版本 UI 上线前，规划编辑器使用全局 `projectId` 定位项目，再读取该项目的 `activePlanId`；若没有 active plan，显示明确空态。
- 未来计划版本选择必须调用按 `projectId` 过滤的计划列表 API，并保证每条计划返回 `planId + projectId + isActive + archived`。选择查看计划不自动激活它。
- 计划列表为空、项目无计划、计划已归档、计划已删除必须分别处理，不能用「第一个可见计划」静默代替。

### 3.7 跨页面导航与精确定位契约

- 所有导航目标的 `projectId` 都是项目根 ID。
- 如果目标是规划功能或里程碑，允许附带 `planId`；没有 `planId` 时由项目根解析 `activePlanId`。
- 功能/里程碑 ID 必须在目标计划内验证归属。
- `PlanningWorkspace.runRoadmapFocus()` 不得再把全局 `projectId` 直接与计划 ID 比较。
- Agent 规划关联中的 `link.project_id` 若实际表示 `planning_projects.id`，必须在类型和参数名上明确为 `planId`；导航前通过已有 `resolve_project_root` 语义或服务接口解析项目根。
- `GlobalSearchLocateIntent.parentId` 是通用父级字段；规划消费者必须把其计划归属语义显式转换为 `{ projectId, planId }`，不能把 parentId 直接当 projectId。
- 深链切换项目时，继续遵循现有导航事务：先通过离开守卫，再提交项目上下文，最后应用对象定位意图；失败或取消不得提前改变全局项目。
- 异步请求必须带项目/计划代际或等价作用域校验，旧项目响应不能覆盖新项目。

### 3.8 项目切换、草稿保护与并发

- 继续复用 `WorkbenchShell.selectProject` 的离开守卫和 `ActiveProjectWriter` latest-wins 串行写入。
- 专业工作空间已有 `useWorkspaceProjectContext` 代际保护，保留其「点击时捕获 projectId」写入规则。
- 规划编辑器若存在未保存草稿，必须注册到同一项目切换守卫协调流程；不要另外实现一套互不知情的切换门禁。
- 项目切换时清理旧项目的对象焦点、临时筛选、选中功能/里程碑和旧请求状态。
- 项目切换不应清除用户在全局任务中心的跨项目筛选偏好，除非该筛选明确绑定当前项目。
- 多窗口通过既有设置变更事件同步；收到其他窗口项目变更时，刷新当前根记录并验证项目是否仍存在。

## 4. 数据所有权

| 数据                                       | 唯一事实来源                          | 项目中枢      | 规划            | 专业工作空间       |
|--------------------------------------------|---------------------------------------|---------------|-----------------|--------------------|
| 项目名称、类型、生命周期状态、目标、根目录 | `workspace_projects` / ProjectService | 读写          | 只读展示        | 只读展示           |
| 当前计划引用                               | `workspace_projects.active_plan_id`   | 展示/显式切换 | 读取/显式激活   | 只读当前阶段上下文 |
| 计划、阶段、里程碑、功能、步骤             | Planning / ProjectPlanning 服务       | 汇总          | 读写            | 只读当前阶段/关联  |
| 任务正文和状态                             | `tasks`                               | 汇总/创建草稿 | 关联/规划       | 关联/执行          |
| 项目事项树                                 | `workspace_items`                     | 只读汇总      | 只读汇总        | 读写               |
| 小说/游戏/漫剧等专业数据                   | 各专业领域表                          | 只读摘要      | 按需关联        | 读写               |
| 能力需求和能力缺口                         | ProjectCapability 服务                | 读写          | 按阶段只读/引用 | 只读上下文         |
| Skill / 知识库 / MCP / Agent 等共享资源    | 各自模块                              | 只读引用/关联 | 只读引用        | 按既有权限使用     |
| 交付物登记和验收                           | ProjectDeliverable 服务               | 读写/验收     | 只读关联        | 上报产出           |
| 开发仓库登记                               | `dev_projects`                        | 关联摘要      | 可关联          | 开发现场使用       |

不允许复制任务正文、项目目标、项目根身份或专业领域数据来制造页面间同步。

## 5. 生命周期闭环

``` mermaid
flowchart TD
    A[创建项目 Project Root] --> B[项目中枢：确认目标与约束]
    B --> C[规划：制定/调整计划]
    C --> D[专业工作空间：实际生产]
    D --> E[任务进度、事项、产出与交付物]
    E --> F[项目中枢：评估进度、风险与能力缺口]
    F --> G{是否需要调整}
    G -->|需要| C
    G -->|继续执行| D
    G -->|完成| H[验收与归档]
```

这是闭环，不是强制线性向导。用户可以从任意阶段进入项目；项目中枢负责解释当前状态，不强迫用户完成全部规划字段后才能开始工作。

## 6. 备选方案与放弃原因

| 方案                                           | 结论         | 原因                                                                      |
|------------------------------------------------|--------------|---------------------------------------------------------------------------|
| 三个页面各自维护项目选择器                     | 拒绝         | 状态分叉、ID 语义不一、跨页面容易跳错项目                                 |
| 把三者合并成一个超级页面                       | 拒绝         | 专业工作空间复杂度高，破坏按需加载和专业 UI；页面会过度膨胀               |
| 只合并项目选择器，但继续让页面各自维护项目 ID  | 拒绝         | 表面同步，实际仍有多份状态和异步竞态                                      |
| 新建一张 `projects` 表                         | 拒绝         | ADR-0008 已确定 `workspace_projects` 为唯一项目根；新表只会制造第四套身份 |
| 新建 Zustand Store 与 WorkbenchShell 双向同步  | 第一阶段拒绝 | 形成两个可写状态源；优先通过 Context 暴露现有 Shell 状态                  |
| 让规划内部选择器继续列出所有项目的 active plan | 拒绝         | 把切换项目伪装成切换计划，破坏全局上下文语义                              |

## 7. 迁移与兼容策略

1.  不新增项目根表，不改变 ADR-0008 的 ID 契约。
2.  第一阶段优先做前端上下文收敛，不新增数据库迁移。
3.  旧 Rust IPC 命令名可保留；在 TypeScript bridge 层建立语义明确的适配名称。
4.  `roadmap` 路由、Ctrl+9、既有导航 ID 和深链保持兼容。
5.  `PlanningWorkspace` 可以保留独立编辑器组件，但只能接收全局项目根上下文和明确的计划 ID。
6.  `workspace_active_project` 继续保存项目根 ID；不再新增 `project_hub_active_project`、`planning_active_project` 等重复设置。
7.  `workbench_current_project` 继续保存开发仓库登记 ID，不做迁移。
8.  任何需要修改 Rust 命令、Agent 协议或 MCP 契约的变更必须先确认调用方兼容范围；不得为了 UI 命名顺手重命名外部接口。

## 8. 验收标准

### 8.1 全局上下文

- 任意页面的全局项目选择器切换后，项目中枢、规划和工作空间都指向同一 `projectId`。
- 三个页面不再存在独立的项目根选择器。
- 刷新应用后恢复最后一次有效的 `workspace_active_project`。
- 新建项目成功后全局选择器自动选中新项目。
- 项目不存在、已删除、归档或加载失败时，状态明确，不展示幽灵项目。

### 8.2 ID 语义

- 任意 `projectId` 均能确认来自 `workspace_projects.id`。
- 任意 `planId` 均能确认来自 `planning_projects.id`。
- `devProjectId` 不会写入项目根上下文。
- `PlanningWorkspace.initialPlanId`、Store 的 `activePlanId` 与后端计划 ID 对齐。
- 精确定位项目功能时，先解析项目根，再解析计划和功能；不能用根 ID 直接查询计划表。

### 8.3 跨页面体验

- 在项目中枢切换到项目 A，进入规划仍是项目 A，进入工作空间仍是项目 A。
- 在规划中打开功能后进入工作空间，再返回规划，项目根仍为 A。
- 从 Agent、全局搜索或跨窗口导航进入某个功能时，能切换到正确项目和计划并定位目标。
- 取消含未保存草稿的项目切换，不改变当前项目和页面数据。
- 快速连续切换 A→B→C，最终上下文与持久化值均为 C，迟到请求不能覆盖 C。

### 8.4 数据与兼容

- 任务、事项、专业数据、能力资源没有复制出第二份。
- 计划状态与项目生命周期状态仍是两个正交状态轴。
- 内置路线图和协作中心的既有功能、导航和权限不回退。
- 不新增无必要的数据库迁移。

## 9. 回滚条件

出现以下任一情况应停止发布并回滚 UI 接线：

- 全局项目选择无法可靠恢复或跨窗口同步；
- 深链导航把计划 ID 当项目根 ID，造成跨项目定位；
- 项目切换导致未保存数据丢失；
- 工作空间或规划功能数据串到其他项目；
- 旧 `roadmap` 路由、Agent/MCP 导航或既有功能回归。

回滚只恢复 UI 适配层和 Context 接线，不回退 ADR-0008 的数据库身份模型，不删除项目或计划数据，不覆盖其他 Agent 的工作。

## 10. 不在本 ADR 范围内

- 不重写 Project Hub 领域服务。
- 不合并 `tasks`、`workspace_items` 和专业领域表。
- 不把 TaskDock 内置路线图改造成用户项目计划。
- 不新增自动执行 Agent 或工作流引擎。
- 不在没有 API 和验收依据时提前开放多计划版本 UI。
- 不做无关的全局导航、主题或 UI 风格重构。

## 11. 关联源码与文档

- `docs/adr/0008-unified-project-identity-and-creation.md`
- `docs/project-hub/02-架构设计.md`
- `docs/project-hub/10-统一项目身份与创建服务.md`
- `src/workbench/WorkbenchShell.tsx`
- `src/workbench/ProjectWorkspacePanel.tsx`
- `src/workspace/activeProjectWriter.ts`
- `src/workspace/useWorkspaceProjectContext.ts`
- `src/components/roadmap/ProjectHubPanel.tsx`
- `src/components/roadmap/PlanningCenterPanel.tsx`
- `src/components/roadmap/PlanningWorkspace.tsx`
- `src/store/usePlanningStore.ts`
- `src/store/useUiStore.ts`
- `src/store/useGlobalSearchStore.ts`
- `src/components/agents/AgentPlanningLinks.tsx`
- `src-tauri/src/commands/planning.rs`
- `src-tauri/src/project_hub/service.rs`
