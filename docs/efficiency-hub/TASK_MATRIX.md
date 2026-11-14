# 统一任务矩阵（效率中枢 V2）

> 建立日期：2026-11-13。本文件把原「开发效率中枢」与「通用项目工作空间」两条开发线
> 收敛成一张稳定任务表：**实现状态与验证状态分开记录**，旧任务编号保留映射。
> 架构细节仍以 `docs/developer-efficiency/ARCHITECTURE.md`、`docs/WORKSPACE_PROJECTS.md`
> 为准；本文件只回答「做到哪、验证到哪、下一步是什么」。
>
> 状态口径：
> - 实现：`not_started / in_progress / implemented / blocked`
> - 验证：`unverified / partially_verified / verified / failed`
> - 代码已实现 **不等于** 验收通过；Windows 原生行为必须真机证据。

## 1. 本轮（2026-11-13 第三轮）架构可靠性

| ID | 功能 | 原任务来源 | 对应代码 | 归属 | 已实现范围 | 尚未实现范围 | 实现 | 验证 | 阻塞 | 下一次行动 |
|---|---|---|---|---|---|---|---|---|---|---|
| U0-01 | 跨窗口导航请求/回执 | 工作空间 P0-02 | `src/lib/mainWindowNavigation.ts`、`src/workspace/devNavRequest.ts`、`src-tauri/src/project_workspace_window.rs`、`src/App.tsx` | workspace | 客户端 requestId 先登记、ack 四态（pending/succeeded/cancelled/failed）、重复/迟到/超时、pending 最终回执、事务串行、失败回滚上下文 | 原生窗口真机时序（主窗口关闭/最小化/胶囊） | implemented | partially_verified（Vitest + Rust 单测；真机未验） | 无 | Windows 真机：胶囊内发起导航、草稿确认/取消、关闭专业窗口后回执 |
| U0-02 | 活跃项目写入所有权 | 工作空间 P0-B | `src-tauri/src/commands/project_workspace.rs`、`src/workspace/activeProjectWriter.ts`、`src/workspace/WorkspaceApp.tsx`、`src-tauri/src/project_workspace_window.rs` | workspace | 实例保存不再写活跃键；选择/创建/删除回退/跨窗口选择统一串行 latest-wins；打开窗口成功后才写活跃；无效 ID 拒绝且保留旧值 | 多实例同时写（两个进程）——单实例锁下不成立 | implemented | partially_verified（Vitest 7 + Rust 断言；DB 并发真机未验） | 无 | 真机快速 A→B→A、重启恢复核对 |
| U0-03 | 项目首渲染隔离 | 工作空间 P1-A | `src/workspace/workspaceContextScope.ts`、`src/workspace/WorkspaceApp.tsx`、`src/workspace/useWorkspaceProjectContext.ts` | workspace | 渲染期 projectId 门控、切换加载态、模块保存串行且只读本项目布局、旧项目写操作 stale | 无 | implemented | partially_verified（父组件切换测试 3 项） | 无 | 真机快速切换观察（可选） |
| U0-04 | 任务选择器分页 | 工作空间 P1-B | `src/workspace/useWorkspaceProjectContext.ts`（`useWorkspaceTaskPicker`） | workspace | 以服务端返回条数判断 loadMore；200 上限提示；查询/状态切换重置 | 后端仍未返回 total/next 元数据 | implemented | partially_verified（hook 测试 5 项） | 无 | 后续可加 `list_tasks` 分页元数据（P2） |
| U0-05 | 开发工作台导航上下文 | 开发效率 U0-05 | 同 U0-01 | workspace | 开发项目提交发生在导航事务内；取消/失败不改上下文；旧上下文回滚 | 真机 | implemented | partially_verified | 无 | 同 U0-01 |

## 2. 开发效率中枢八项（开发线 A）

| ID | 功能 | 原任务来源 | 对应代码 | 已实现范围 | 尚未实现 | 实现 | 验证 |
|---|---|---|---|---|---|---|---|
| DE-1 | 开发现场感知 | 开发效率功能一 | `src-tauri/src/devwork/git.rs`、`src/components/devwork/DevProjectContext.tsx`、`src-tauri/src/commands/dev_workbench.rs` | 开发项目登记、当前项目、Git 分支/dirty/worktree 摘要、目录失效反馈 | 与工作空间项目上下文的自动关联（当前为弱引用 + 手动） | implemented | partially_verified |
| DE-2 | Agent 任务交接包 | 功能二 / R2-3 | `src/components/devwork/DevHandoffSection.tsx`、`dev_handoff_packs` | 十二节模板、编辑/预览、敏感扫描、保存版本、复制、任务上下文、**资料选择（Round 2a 已集成）**、**绑定 Agent 会话（U2-01 / v50）** | 独立执行结果入口（Agent 侧直接打开交接包） | implemented | partially_verified |
| DE-3 | 开发验收工作台 | 功能三 | `src/components/devwork/DevAcceptanceSection.tsx`、`dev_acceptance_records` | 验收状态派生、记录、四种结论、历史、返工提示词/任务入口、**Agent 已完成轮次候选与来源标注（U2-02 / v50，人工结论）** | 真实测试日志/构建记录引用（U2-03） | implemented | partially_verified |
| DE-4 | Git/Worktree 协调中心 | 功能四 / R2-7 | `devwork::git`（只读探测、isWorktree） | 单仓库分支、dirty、worktree 识别 | 多 worktree 列表、文件重叠/潜在冲突、Agent↔worktree 关联 | in_progress（仅探测底座） | unverified |
| DE-5 | 智能问题复现包 | 功能五 | 无 | 无 | 问题包数据模型、诊断关联、脱敏导出、闭环 | not_started | unverified |
| DE-6 | 开发环境监控 | 功能六 | 无 | 无 | 服务/测试命令登记、真实执行状态、超时取消、结果关联验收 | not_started | unverified |
| DE-7 | 情境化快捷操作 | 功能七 | `src/components/actions/ActionCenterPanel.tsx` + 现有 Agent/任务状态 | 既有行动中心按真实状态聚合条目 | 按项目/诊断/Worktree 风险动态排序与胶囊入口收敛 | implemented（基础） | partially_verified |
| DE-8 | 工作现场增强恢复 | 功能八 | `workspace_snapshots` / 场景 / 应用恢复（既有） | 快照、逐项回执、几何恢复 | 关联 Project Workspace / 开发仓库 / 当前任务、恢复前预览与部分恢复 | in_progress（底座既有，项目关联未做） | partially_verified |

## 3. 通用项目工作空间（开发线 B）

| ID | 功能 | 原任务来源 | 对应代码 | 已实现范围 | 尚未实现 | 实现 | 验证 |
|---|---|---|---|---|---|---|---|
| PW-1 | 数据模型与命令层 | 工作空间 P0 | v49 迁移、`commands/project_workspace.rs` | 四表、CRUD、事项、任务关联、实例布局、备份登记 | — | implemented | verified（Rust 单测，待本轮复跑） |
| PW-2 | 独立专业窗口 | 工作空间 P0 | `src-tauri/src/project_workspace_window.rs`、`workspace.html` | 单窗口、几何持久化、显示器收敛、关闭不影响胶囊 | 真机 DPI/多显示器验收 | implemented | partially_verified |
| PW-3 | 三层入口 | 工作空间 P0 | 胶囊肩部 / 完整面板 / 专业窗口 | 三个入口均可打开 | 胶囊入口隐藏后的回流验证 | implemented | partially_verified |
| PW-4 | Profile/Capability 注册中心 | 工作空间 P1-01 | `src/workspace/workspaceProfiles.ts` | 四类型导航/首页/能力声明、四态、planned/unavailable 无假按钮 | 仅「基础 Profile」：游戏/AI 漫剧无真实业务闭环；布局排序/隐藏无编辑入口（已标 limited） | implemented（基础） | verified（注册中心契约测试） |
| PW-5 | 页面数据层（代次隔离） | 工作空间 P0-03/P1-02 | `src/workspace/useWorkspaceProjectContext.ts` | 代次、项目归属、写保护、布局解析回退、任务选择器 | 后端分页元数据 | implemented | verified（hook 测试） |
| PW-6 | 游戏制作闭环 | 工作空间 P1 | 仅事项阶段 | 事项承载关卡/系统阶段 | 资源关联、构建/测试登记、引擎跳转 | not_started | unverified |
| PW-7 | AI 漫剧闭环 | 工作空间 P1 | 仅事项阶段 | 剧集/镜头用 stage 承载 | 素材/角色库、生成结果导入、版本比较/采用 | not_started | unverified |
| PW-8 | 跨项目资源与产出物关系 | 工作空间 P2 | 无 | 无 | — | not_started | unverified |

## 4. 旧任务编号映射（不丢失追踪）

| 旧编号 | 原内容 | 当前状态 | 映射到 |
|---|---|---|---|
| R2-1 | 统一真机验收 | 未执行（本环境无原生真机验收） | U0-01/U0-02 真机项 |
| R2-2 | 导航测试偶发失败治理 | 本轮未复现；导航测试已重写为确定性用例 | U0-01 |
| R2-3 | 交接包资料选择 | 代码已集成（`DevHandoffSection` 资料选择） | DE-2 |
| R2-4 | Agent 会话快照关联 | 未实现 | U2-01（下一轮） |
| R2-5 | Agent 轮次进入待验收 | 未实现 | U2-02（下一轮） |
| R2-6 | Git unavailable 测试 | 已有 Rust 测试覆盖（探测失败降级） | DE-1/DE-4 |
| R2-7 | Worktree 协调与环境监控 | 仅探测底座 | DE-4/DE-6 |
| R2-8 | 开发现场高级识别可行性 | 未开始（需要新探测源，不在本轮） | 后续评估 |

## 5. 下一轮建议顺序（依赖顺序，不承诺本会话完成）

1. ~~U2-01 交接包 ↔ Agent 会话（复用 `task_agent_links`，不建第二套会话表）。~~ ✅ 2026-11-14
2. ~~U2-02 Agent 结果 → 待验收（人工确认，不自动通过）。~~ ✅ 2026-11-14
3. U3 Git/Worktree 只读协调（多 worktree、文件重叠提示；区分「已冲突 / 潜在冲突 / 仅重叠」）。
4. U5 统一问题复现包（复用诊断，不建第二套日志）。
5. U4 开发环境监控 MVP（只读登记 + 明确授权执行）。
6. U8 游戏/AI 漫剧最小闭环（有真实接口才把能力从 planned 提升）。

## 6. 2026-11-14 第二轮（U2：交接包 ↔ Agent 会话、Agent 结果待验收）

迁移 **v50** 只加弱引用列与索引，不新建会话/任务/日志系统；两张表已在 `BACKUP_TABLES`
中，备份 `SELECT *` 自动覆盖新列。

| ID | 功能 | 原任务来源 | 对应代码 | 已实现范围 | 尚未实现范围 | 实现 | 验证 | 阻塞 | 下一次行动 |
|---|---|---|---|---|---|---|---|---|---|
| U2-01 | 交接包绑定 Agent 会话 | R2-4 | v50 迁移、`commands/dev_workbench.rs`、`src/components/devwork/DevHandoffSection.tsx`、`src/lib/bridge.ts` | 保存时选择性绑定真实会话 `(source_id, external_id)`；服务端校验会话存在；读时派生标题与 `available`；版本列表展示失效；会话候选＝实时+历史（最近 20，可搜索） | Agent 侧「从会话打开交接包」入口 | implemented | partially_verified（Rust 22 + Vitest 22；真机未验） | 无 | 真机：选择会话保存、重启后版本列表、会话被删除后的失效展示 |
| U2-02 | Agent 完成轮次 → 人工待验收 | R2-5 | v50 迁移、`dev_acceptance_agent_runs` 命令、`DevAcceptanceSection.tsx` | 只读候选＝本任务关联会话 ∪ 交接包绑定会话的 `completed` 轮次；标注 user/auto/handoff 来源；已验收轮次带结论；**必须人工选 verdict + summary 才落库**；来源三元组服务端校验真实存在 | 真实测试日志/构建证据引用（U2-03）；失败轮次的问题排查入口 | implemented | partially_verified（Rust 22 + Vitest 23；真机未验） | 无 | 真机：Agent 完成一轮后候选出现、登记后变「已验收」、不自动通过 |

明确未做（不冒充）：

- 没有自动验收、自动改任务状态、自动建待办；Agent 事件仍只通知。
- 没有新的会话快照表、没有第二套任务系统；候选全部由既有表派生。
- 没有把测试/压测会话纳入：查询固定 `origin='real'`。

## 7. 2026-11-14 第三轮（U0：唯一大型完整工作台 + 胶囊快捷入口）

目标：`main` 收敛为 Quick Surface Host，`workspace` 成为唯一 Full Workbench Host；
不新增第三个大型窗口、不复制业务实现、不改变辅助窗口生命周期。
详细架构见 [../ARCHITECTURE.md](../ARCHITECTURE.md)「统一大型工作台（U0）」与
[../WORKSPACE_PROJECTS.md](../WORKSPACE_PROJECTS.md) §9。

| ID | 功能 | 对应代码 | 已实现范围 | 尚未实现/未验证 | 实现 | 验证 | 阻塞 | 下一次行动 |
|---|---|---|---|---|---|---|---|---|
| U0-01 | 单一大型工作台窗口职责 | `project_workspace_window.rs`、`workspace.html`、`src/workspace/main.tsx` | `workspace` 承载全部完整功能；沿用原 label/几何/关闭语义；无第三窗口；辅助窗口不变 | 多显示器、150%-200% DPI（本机单屏 125%，环境受限） | implemented | partially_verified（原生隔离实例：创建/关闭/重开、任务栏 `WS_EX_APPWINDOW`、最大化/恢复、125% DPI 单屏、胶囊四边停靠/展开收起） | 多屏/150-200% 无环境 | 在具备多显示器/可改缩放的环境补测 |
| U0-02 | 统一工作台外壳 | `src/workbench/WorkbenchShell.tsx`、`ProjectWorkspacePanel.tsx`、`WorkbenchHome.tsx`、`WorkbenchContextPane.tsx` | 左栏复用注册中心；顶栏项目/类型/搜索/Agent 状态/右栏；无项目首页；项目内容迁移（非复制）；每页独立错误边界；主题跟随设置；工作台启动一次性读取任务/Agent/行动权威数据 | 880 最小窗、150%-200% DPI、2K/4K、逐页键盘走查 | implemented | partially_verified（组件测试 + 原生 944×608 外壳/17 个侧栏项/19 路由逐页渲染/窄窗自动收右栏） | 无 | 880 最小窗、高 DPI、逐页键盘走查 |
| U0-03 | 应用级导航契约 | `navigationRegistry.ts`、`workbenchNav.ts`、`workbench_open_window/take_nav/nav_ack` | 单一注册中心；结构化目标（tab/项目/任务/对象/子页）；客户端 requestId；入队+拉取+事件+页面 ping；**一次事件拉空队列**；回执四态；pending 最终态；12s 超时；草稿门禁；**活跃项目只在确认/切页成功后提交** | 迟到回执的 UI 修正（超时后迟到成功只记录，不改页面） | implemented | partially_verified（Vitest 11 + Rust 9 + 原生创建即导航/已存在窗口导航/ack 清队/**草稿取消保留/确认切页/项目上下文不提前写入**） | 无 | 迟到回执 UI 策略（P3） |
| U0-04 | 状态分层与跨窗口同步 | `windowHost.ts`、`useMainUiVisible.ts`、`settings-changed`、`WorkbenchShell` 一次性读取 | 业务状态/全局上下文/窗口 UI/持久化布局四类分离；事件只广播键名+来源+单调修订号；工作台不重复音频/微件/通知调度；项目选择串行 latest-wins；独立 WebView 不依赖主窗口 store 已加载 | 两进程并发写活跃项目（单实例锁下不成立）；更多页面在原生下的刷新节奏 | implemented | partially_verified（单测 + 权限契约 + 原生草稿/项目上下文时序 + 工作台独立读取任务/Agent/行动） | 无 | 逐页观察隐藏/恢复后的订阅刷新 |
| U0-05 | 解除主窗口绑定 | `windowHost.ts`、`WorkbenchPageActiveContext`、`useMainUiVisible.test.tsx` | 工作台角色下不读主窗口 mode/吸附相位；隐藏但保活的页面按真实 active 暂停消费者刷新；快捷键作用于本窗口；移动配对不再改主窗口 mode | 各页面在原生 WebView 下的实际刷新节奏 | implemented | partially_verified（hook 门控测试 + 原生隐藏任务页保活/工作台路由切换） | 无 | 逐页观察隐藏/恢复后的订阅与刷新 |
| U0-06 | 三层布局协议 | `workbenchLayout.ts`、`settings.rs`、`navigationLayout.ts`、`workspaceProfiles.ts` | `workbench_layout` v1（路由/项目/右栏/宽度）+ 客户端归一化与串行写入；后端结构校验；损坏回默认；旧导航/项目布局不清空；窗口几何仍恢复 | 布局自由拖动/IDE 式编排（本轮明确不做）；宽度/右栏重启恢复未逐项原生复测 | implemented | partially_verified（Vitest 8 + Rust settings 13 + 原生路由持久化） | 无 | 真机重启恢复宽度/右栏 |
| U0-07 | 功能迁移 Phase A–D | `WorkbenchShell` + 既有面板 + `WorkbenchHandoff` | 首页/任务/Agent/开发工作台/项目/收集与暂存/剪贴板/应用/微件/工作流/历史/规划/帮助/诊断/资源/设置/手机互传均已挂载复用；**Phase D：主窗口 11 个大型管理页退化为摘要+跳转**，任务/Agent/行动/剪贴板/收集/设置为快捷面保留 | Phase E 游戏/AI 漫剧专业模块只有事项阶段（与旧边界一致）；2K/4K 逐页视觉 | implemented（A–D） | partially_verified（构建 + 组件测试 + 原生 19 路由逐页 + Phase D 9 个入口原生点击/跳转） | 无 | 专业模块闭环另立任务 |
| U0-08 | 窗口能力与权限审计 | `capabilities/workspace.json`、`widget_windows.rs`、`settings.rs` | 工作台只保留 event/dialog/opener；不复制主窗口 notification/autostart/global-shortcut/窗口几何；微件显示/隐藏/重置允许 main/workspace，快照发布仍仅 main；设置广播带来源 | 原生 WebView2 实际权限拒绝路径 | implemented | verified（capability 契约 + Rust 标签测试） | 无 | 可选：原生验证工作台内文件选择/打开目录 |
| U0-09 | 性能与生命周期 | 窗口按需创建、DeferredView、消费者门控、一次性读取 | 工作台关闭即销毁 WebView；已访问页保活但隐藏页暂停可选刷新；无第二套通知/音频/微件调度；工作台打开/关闭 3 轮与空闲 CPU 已采样 | 迁移前基线未测；更长周期/更多页面组合未测 | implemented | partially_verified（隔离实例客观采样：胶囊隐藏 0.00 CPU-s/10s；工作台空闲 0.13 CPU-s/10s；开关 3 轮关闭后总 WS 845–868MB，未观察到单调增长，不宣称无泄漏） | 无 | 需要“迁移前”对照时另做基线快照 |
| U0-10 | UI 与信息层级 | `workbench.css`、Shell | 1180×760 三栏布局；宽屏取消 560px 阅读限制；**<1000 CSS 自动收起右栏**，默认 944 CSS 下主内容 716px；语义 Token；空/加载/错误态 | 880 最小窗、2K/4K、150%/200% DPI、多显示器、逐页深浅主题/键盘 | implemented | partially_verified（原生 944×608 单屏、19 页截图、右栏按阈值收起、胶囊四向轨道） | 高 DPI/多屏无环境 | 真机 + 预览逐页走查 |

Phase D（主窗口旧完整面板退役）：**implemented（2026-11-14）**。主窗口完整模式中
开发工作台、项目工作空间、应用、微件、手机互传、工作流、历史、规划中心、帮助、诊断中心、
资源管理 11 个大型管理页不再挂载原面板，统一渲染 `WorkbenchHandoff`（功能摘要 + 「在完整
工作台中打开」）；点击走真实 `workbench_open_window` 协议并落到对应路由。任务、Agent、行动、
剪贴板、收集与暂存属于胶囊快捷面，设置属于主窗口自身窗口/外观配置，继续保留。导航显隐/排序、
Ctrl+数字语义与旧数据不变；工作台侧栏仍是唯一完整功能入口。

明确未做（不冒充）：

- 没有新增第三个大型窗口；没有把辅助窗口并入工作台。
- 没有复制 FullView 的 JSX，也没有复制任务/Agent/项目等业务实现；工作台直接复用既有面板。
- Phase D 是「兼容入口 + 跳转」，不是删除主窗口；快捷面功能未删。
- 没有宣称多显示器、150%/200% DPI、2K/4K 视觉、资源无泄漏已验收。

