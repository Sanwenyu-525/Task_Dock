# 规划中心（Planning Center）设计说明

> 模块：`roadmap` Tab（导航显示名「规划中心」）  
> 前端：`src/components/roadmap/` · 状态：`src/store/usePlanningStore.ts` · 后端：`src-tauri/src/commands/planning.rs`  
> 数据：SQLite `planning_*` 表（迁移 v19 增加 `planning_features.acceptance_criteria`）  
> 本文只记录长期有效的结构、数据语义与交互决策；临时验收证据见 `tmp/acceptance/planning-center-ui/`。

## 1. 页面结构

规划中心保留两个数据源入口，互不影响：

| 数据源 | 内容 | 可写 |
|---|---|---|
| 我的项目 | 用户自建项目、功能、步骤、里程碑、进度历史（SQLite） | 是 |
| 内置路线图 | Task Dock 自身 28 项功能目录（`src/lib/featureCatalog.ts`） | 否，只读 |

「我的项目」内部为四视图，由 `PlanningWorkspace` 统一承载：

1. **项目总览**：宽容器左侧项目列表 + 右侧项目详情与统计；窄容器折叠为项目 Select + 纵向统计/最近进度。
2. **功能列表 / 功能详情**：按里程碑分组的功能卡片；卡片就地展开为功能详情；新增/编辑功能切到页面内编辑态（`FeatureEditorView`），不铺全局遮罩。
3. **功能看板**：待开发 / 开发中 / 待验收 / 已完成 四列；受阻、已暂停通过状态筛选与顶部常驻计数入口访问。
4. **里程碑**：宽容器水平时间轴、窄容器纵向列表；节点展示目标日期、关联功能数、完成数与阶段状态。

进度历史不单独占视图：功能详情内复用 `PlanningFeatureCard` 的「进度历史」组件（分页 + 开发日志）；项目总览展示项目级最近动态。

## 2. 组件职责

| 组件 | 职责 |
|---|---|
| `PlanningCenterPanel` | 数据源切换（我的项目 / 内置路线图），保持 roadmap Tab 身份 |
| `PlanningWorkspace` | 四视图 Tab、项目列表引导加载、看板→功能详情、里程碑→功能筛选的跳转状态 |
| `ProjectsView` | 项目总览：项目 CRUD/归档/删除、统计卡、整体完成率、项目级最近进度 |
| `FeatureListView` | 功能列表/详情：搜索、状态/优先级/里程碑筛选、分组、新增/编辑/删除入口、看板定位 |
| `PlanningFeatureCard` | 功能卡片与就地详情：概述、验收标准、步骤、状态/优先级/里程碑/目标日期、历史、编辑/删除 |
| `PlanningKanban` | 四列看板、受阻/暂停入口、状态下拉改状态、卡片定位到详情、每列分片渲染 |
| `MilestonesView` | 里程碑时间轴、阶段派生状态、完成率、新建/编辑/删除、查看关联功能 |
| `PlanningEditors` | 页面内编辑态：`ProjectEditorView` / `FeatureEditorView` / `MilestoneEditorView`（替代原 `PlanningDialogs`） |
| `DatePicker`（`components/ui`） | 纯日期 `YYYY-MM-DD` 选择器；项目/功能/里程碑编辑与功能详情快捷编辑统一使用 |
| `PlanningBits` | 项目选择器、统一进度条、功能状态徽标 |
| `usePlanningStore` | 唯一前端状态源：项目/功能/里程碑/活动、代际防护、统计同步、活动作用域 |

## 3. 数据来源与一致性

- **权威数据**：项目、功能、步骤、里程碑、历史均来自 Rust 命令 / SQLite；前端不生成示例项目或统计数字。
- **不做本地持久化缓存**：进入规划中心时加载项目列表并选中第一个未归档项目；切换项目时立即清空旧项目功能/里程碑，再按请求代际（`featuresSeq` / `milestonesSeq`）丢弃迟到响应。
- **统计同步**：功能增删改后，Store 用后端返回的功能实体推导当前项目统计与里程碑关联统计（`syncDerivedLists`），保证总览、列表、看板一致；不在前端伪造计数。
- **活动作用域**：项目级（`feature_id = null`）与功能级历史共用 `activity` 字段，但带 `activityScope = { projectId, featureId }`；迟到响应、跨作用域 `addNote` 均不写入当前列表。
- **无轮询**：只在面板挂载、切换项目、用户操作后刷新；历史按 30 条分页，不无限增长。
- **写入事务复用（2026-11-06）**：`Db::with_transaction` 在唯一 writer 上打开立即写事务；规划命令的 `*_tx` 内核在调用方事务中完成校验、写入和权威实体读取，不再嵌套开锁或事务。事务 closure 返回错误时整组修改回滚。该内部 API 不改变命令参数、SQLite schema 或备份格式。
- **Agent 会话关联（2026-11-06）**：功能详情读取 `feature_agent_links`，显示 Agent 来源、会话 ID、真实会话状态与最近执行时间；只有匹配到真实 `agent_sessions` 时才允许跳转。Agent 会话详情可反向定位关联功能。解除关联将状态更新为 `unlinked` 并保留审计行；新增只读查询/解除关联 Tauri 命令，不新增表或迁移。

## 4. 状态语义

### 项目状态

`planning`（规划中）/ `in_progress`（进行中）/ `paused`（已暂停）/ `completed`（已完成）。归档是独立布尔字段，不改变项目状态。

### 功能状态

`planned`（待开发）/ `in_progress`（开发中）/ `review`（待验收）/ `completed`（已完成）/ `blocked`（受阻）/ `paused`（已暂停）。

**状态与步骤进度相互独立**：

- 步骤完成数只影响步骤进度，不自动改变功能状态；
- 功能状态改为 `completed` 时即使还有未完成步骤也允许，但需在详情中二次确认；
- 标记完成不会自动勾选/取消任何步骤；
- 5/5 步骤但状态为「待验收」是合法状态。

### 里程碑阶段状态（派生，不落库）

- 无关联功能 → 「尚未关联功能」；
- `完成数 >= 关联数` → 「已完成」；
- 未完成且目标日期早于今天 → 「已逾期」（仅提醒，绝不自动完成）；
- 有完成但未全部完成 → 「进行中」；否则「待开始」。

## 5. 进度计算规则

| 指标 | 规则 |
|---|---|
| 项目整体完成率 | `已完成功能数 / 功能总数`，向下取整百分比；`has_features = false` 时 UI 显示「尚未添加功能」，不显示 0% |
| 项目状态计数 | 按功能状态分别计数：已完成 / 开发中 / 待开发 / 待验收 / 受阻 / 已暂停（Rust `ProjectStats`） |
| 功能步骤进度 | `已完成步骤数 / 步骤总数`；`step_total = 0` 显示「未拆分步骤」，不伪造百分比 |
| 里程碑完成率 | `已完成关联功能数 / 关联功能总数`；无关联功能不画进度条 |
| 项目最近进度 | 项目级 `planning_activity` 时间倒序，预览最近 8 条，可加载更早记录 |

## 6. 响应式规则

主窗口默认约 400×560，不修改窗口最小尺寸、吸附与裁剪逻辑。布局使用 `.planning-workspace` 容器查询：

| 容器宽度 | 规则 |
|---|---|
| `< 640px` | 项目列表收起为 Select；总览单列；统计卡自动换行（≤460px 固定两列）；功能/里程碑单列 |
| `≥ 640px` | 项目总览左右分栏（约 190–220px 项目列表 + 详情）；功能详情概述/验收标准两列 |
| `≤ 460px` | 看板由四列改为按状态纵向分组；时间轴由水平改为纵向；视图 Tab 等分换行 |
| `641–860px` | 看板保留四列，容器内横向滚动，不导致整窗水平溢出 |

新增样式统一追加在 `src/styles.css` 的「规划中心四视图」区块，使用语义 Token：`--surface-*`、`--text-*`、`--border-*`、`--accent-gradient`、`--status-*`、`--card-face`、`--card-shadow`；不改全局字体、布局与标题栏。动效只用于展开、进度条与删除退出，并尊重 `prefers-reduced-motion`。

## 7. 关键交互决策

1. **新建/编辑功能**：`FeatureEditorView` 在页面内维护名称、描述、验收标准、状态、优先级、里程碑、目标日期；失败保留输入与未保存标记，成功后回到列表并刷新列表/统计。
2. **功能详情就地展开**：不使用弹层；步骤勾选立即提交；状态变更走 Store `updateFeature`。
3. **看板不实现拖拽**：第一版用卡片内状态下拉框，复用 `updateFeature`，失败时 Store 不更新、卡片保持原状态；键盘与下拉菜单均可操作。每列最多渲染 40 张，超出用「显示更多」。
4. **受阻/暂停不隐藏**：看板顶部常驻「受阻 N / 已暂停 N」按钮，状态筛选下拉也包含这两项。
5. **删除**：项目、功能、里程碑均经 `ConfirmDialog` 明确影响面；里程碑删除只解除关联，不删除功能。
6. **搜索**：匹配功能标题、描述、验收标准与步骤标题；筛选条件可组合，可一键清除。
7. **内置路线图只读**：不把 28 项目录复制成用户项目，编辑用户项目不影响内置目录。
8. **目标日期统一走 `DatePicker`**：项目编辑器、功能编辑器、里程碑编辑器与功能详情快捷编辑四处均使用纯日期 `DatePicker`（`YYYY-MM-DD`，不转 UTC）；清除映射回 `null`，编辑失败保留原值并沿用原有错误提示，开关日历与切月不触发保存。

## 8. 数据兼容与迁移

- `planning_features` 迁移 v19 新增 `acceptance_criteria TEXT NOT NULL DEFAULT ''`；旧库自动补空串，旧功能显示「尚未填写验收标准」，不影响既有数据。
- 备份通过 `SELECT *` 导出/恢复，新增列随表结构自动纳入；恢复旧备份时新列为空串。
- 验收标准与开发步骤语义分离，不用步骤冒充验收标准，不生成占位条目。
- 命令与类型同步：`PlanningFeature`、`PlanningFeatureInput`、`PlanningFeaturePatch`、`PlanningProjectStats` 与 Rust 结构一致。

## 9. 验证与证据

- 前端单元/组件测试：`src/store/usePlanningStore.test.ts`、`src/components/roadmap/PlanningCenterPanel.test.tsx`、`FeatureRoadmapPanel.test.tsx`、`src/components/ui/DatePicker.test.tsx`。
- Rust：`src-tauri/src/commands/planning.rs` 测试模块覆盖 CRUD、步骤、状态、里程碑、验收标准与统计。
- 真机视觉走查证据与结论记录在 `tmp/acceptance/planning-center-ui/report.md`（不提交真实用户数据）。
- 日期选择器四套主题与窄窗证据：`tmp/acceptance/date-picker-ui/`（`report.md` + 截图），交互结论来自 Playwright 预览 harness（通道 B），不等同 WebView2/Win32 真机。
