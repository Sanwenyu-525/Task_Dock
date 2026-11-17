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
| PW-1 | 数据模型与命令层 | 工作空间 P0 | v49 迁移 + v57（kind 五值）、`commands/project_workspace.rs` | 四表（+`shelf_project_links` 弱关联）、CRUD、事项、任务关联、实例布局、备份登记；v57 事务内重建父表/依赖表并自检外键 | 章节/人物等小说专业表（下一阶段） | implemented | verified（Rust 单测含 v57 迁移与 FK check） |
| PW-2 | 独立专业窗口 | 工作空间 P0 | `src-tauri/src/project_workspace_window.rs`、`workspace.html` | 单窗口、几何持久化、显示器收敛、关闭不影响胶囊 | 真机 DPI/多显示器验收 | implemented | partially_verified |
| PW-3 | 三层入口 | 工作空间 P0 | 胶囊肩部 / 完整面板 / 专业窗口 | 三个入口均可打开 | 胶囊入口隐藏后的回流验证 | implemented | partially_verified |
| PW-4 | Profile/Capability 注册中心 | 工作空间 P1-01 | `src/workspace/workspaceProfiles.ts`、`workspaceProfileIcons.ts` | **五类型**导航/首页/能力声明、四态、planned/unavailable 无假按钮、图标 token 有真实映射 | 仅「基础 Profile」：游戏/AI 漫剧/小说无完整专业闭环；布局排序/隐藏无编辑入口（已标 limited） | implemented（基础） | verified（注册中心契约测试） |
| PW-5 | 页面数据层（代次隔离） | 工作空间 P0-03/P1-02 | `src/workspace/useWorkspaceProjectContext.ts` | 代次、项目归属、写保护、布局解析回退、任务选择器 | 后端分页元数据 | implemented | verified（hook 测试） |
| PW-6 | 游戏制作闭环 | 工作空间 P1 | 仅事项阶段 | 事项承载关卡/系统阶段 | 资源关联、构建/测试登记、引擎跳转 | not_started | unverified |
| PW-7 | AI 漫剧闭环 | 工作空间 P1 | 仅事项阶段 | 剧集/镜头用 stage 承载 | 素材/角色库、生成结果导入、版本比较/采用 | not_started | unverified |
| PW-8 | 跨项目资源与产出物关系 | 工作空间 P2 | 无 | 无 | — | not_started | unverified |
| PW-10 | 小说正文与章节（创作工作台 B1） | 2026-11-16 | v58 迁移、`commands/project_workspace.rs`、`commands/backup.rs`、`src/workspace/workspaceProfiles.ts`、`src/lib/bridge.ts`、`NovelManuscriptPanel.tsx`、`ProjectWorkspacePanel.tsx`、`workspace.css` | v58 卷/章两表三索引；8 个卷/章命令（列表/读取/保存/正文保存/删除）；`manuscript` 模块与 `novel.manuscript` available；卷→章树 + 纯文本编辑器（单章节串行保存、0.9s 防抖、模块/项目离开前 async flush、保存失败阻止离开并保留草稿、实时字数、归档全入口只读、Rust kind/status 门禁） | 富文本/Markdown、版本历史、导入导出、全文搜索；人物/世界观/剧情/伏笔/AI；跨卷拖拽移动；应用关闭握手 | implemented | partially_verified（前端 26/26 通过；Rust 用例已落盘但本轮共享工作树被其他模块编译错误阻塞，已在隔离 worktree 复跑 6/6；原生窗口未逐页走查） | 无 | 原生走查：新建卷/章、自动保存、切换章节、归档只读、备份恢复 |

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
7. ~~B1：小说卷→章树 + 纯文本正文编辑器（2026-11-16）。~~ ✅
8. B2：人物/世界观条目（同构条目 + 关系，不建第二套搜索/任务）；随后再评估 AI 辅助的
   上下文装配与授权边界，以及导出与版本历史。

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

## 8. 2026-11-15 创作工作台 A 阶段（小说项目类型）

目标：在既有 Project Workspace 上增加第五种专业 Profile，为正文/章节/人物/世界观/AI
辅助预留位置；**不新增第二套项目、任务或窗口系统**。

| 层 | 落地内容 | 证据/验证 |
|---|---|---|
| 数据库 | 迁移 **v57**：`workspace_projects.kind` CHECK 扩为 `development / game / ai_comic / general / novel`。事务内暂存五张表 → 按依赖逆序删除四张依赖表 → 重建父表（复制全部列）→ 重建依赖表与索引 → 回填（事项两段式 parent_id）→ scoped `PRAGMA foreign_key_check` + `EXCEPT` 逐行自检，任一失败整体回滚 | `v57_novel_kind_migration_preserves_workspace_rows_and_fk_integrity`（4 类历史项目 + 实例 + 多级事项 + 任务关联 + 暂存关联，逐列断言 + 0 外键违例 + 非法类型拒绝 + 级联删除） |
| Rust | `PROJECT_KINDS` 追加 `novel`；创建/编辑/列表/归档/恢复/设为当前/备注/根目录/事项/任务关联全部复用既有命令 | `novel_project_supports_crud_status_instance_items_and_task_links` |
| 前端 | `WorkspaceKind` 追加 `"novel"`；`WORKSPACE_PROFILES.novel`（标签「小说」、icon `book-open`→`BookOpen`）；导航 概览/写作事项/任务关联/项目设置；首页 5 卡片（项目/简介/写作事项/任务关联/计划能力清单） | `workspaceProfiles.test.ts`（五 Profile、卡片组合、能力悬空引用、planned 不可调用、旧布局兼容、图标映射） |
| 能力 | available：`core.project` `core.items` `core.taskLinks`；limited：`core.layout`；planned（不可调用）：`novel.manuscript` `novel.characters` `novel.worldview` `novel.aiAssist` | 同上；计划能力卡片为纯文本，无编辑/保存/生成按钮 |
| 备份 | 无 kind 过滤；novel 项目随五张表完整往返 | `novel_workspace_project_roundtrips_in_full_and_quick_backup`（Full + Quick，恢复后 kind/实例/事项/关联） |
| 入口 | 新建/编辑项目类型下拉、项目列表徽标、详情类型、切换/独立窗口均从 Profile 注册中心派生（无重复入口） | 组件测试 + 契约测试 |

明确未做（不冒充）：

- 没有小说正文编辑器、富文本/Markdown、自动保存、版本历史；
- 没有章节/卷管理、人物档案、世界观、剧情时间线、伏笔追踪、AI 续写/改写、导出；
- 没有为上述功能提前建表，也没有可点击的假入口；
- 未执行原生窗口逐页走查（新建/编辑/归档/切换/备份恢复的 UI 层），只做了自动化验证。
- 2026-11-16 复跑：Rust `cargo test --lib novel` 3 passed / 0 failed；
  `vitest run src/workspace/workspaceProfiles.test.ts` 16 passed；`tsc --noEmit` 退出码 0。

## 9. 2026-11-16 创作工作台 B1（小说正文与章节）

目标：在既有 Project Workspace 上完成「卷 → 章」两级章节树与纯文本正文编辑器；
仍不新增第二套项目/任务/窗口系统，不复制 CRUD。

| 层 | 落地内容 | 证据/验证 |
|---|---|---|
| 数据库 | 迁移 **v58**（append-only）：`novel_volumes`、`novel_chapters`（`volume_id` 可空=未分卷，项目/卷均级联），三索引；不改 v57 与任何既有表 | `v58_novel_chapter_tables_preserve_existing_rows_and_cascade`（v57 升级、既有项目/实例/事项保留、卷/章写入、删卷/删项目级联、FK 0） |
| Rust | 卷：list/save/delete；章：list（仅元信息）/get（正文）/save（新建/改名/移卷/排序，正文不变）/save_content（只更新正文与字数）/delete；标题 240 字符、正文 8 MiB、字数=非空白字符、跨项目卷引用拒绝 | `novel_chapters_support_volumes_content_autosave_and_cascade` |
| 前端 | `manuscript` 模块（概览/正文/写作事项/任务关联/项目设置）；`novel.manuscript` → available；卷→章树 + 未分卷桶；textarea 0.9s 防抖保存 + 失焦/切换/卸载落盘；保存失败阻止切章；实时字数、保存状态、归档只读；概览「开始写作」真实跳转 | `workspaceProfiles.test.ts`（16 passed）；`NovelManuscriptPanel.test.tsx`（4 passed：树/正文回填、失焦落盘、归档只读、保存失败阻止切章） |
| 备份 | `novel_volumes` / `novel_chapters` 登记 `EXTENDED_TABLES` 与 `BACKUP_TABLES`，快速备份全量分支显式放行；恢复顺序 项目 → 卷 → 章 | `novel_workspace_project_roundtrips_in_full_and_quick_backup`（Full + Quick，正文逐字与 word_count 一致） |

明确未做（不冒充）：

- 富文本/Markdown、版本历史/撤销快照、TXT/Markdown/DOCX/PDF 导出、全文搜索、拼写检查；
- 人物档案、世界观、剧情时间线、伏笔追踪、AI 续写/改写；
- 跨卷拖拽移动与批量操作（B1 只支持同卷上下移、新建时指定卷）；
- 原生窗口逐页走查：本机仅做自动化与组件测试，未启动隔离实例逐页点击（未验证）。
- 命令：`cargo test -j 1 --lib novel` → 5 passed / 0 failed（日志
  `m-mwimhxy1-c5b5e4.log`）；`vitest run src/workspace/workspaceProfiles.test.ts` → 16 passed
  （`l-mwimjaco-30d10f.log`）；`vitest run src/workbench/NovelManuscriptPanel.test.tsx` → 4 passed
  （`l-mwimq139-37c86e.log`）；合并复跑两文件 **20 passed**
  （`l-mwimskcj-3034f9.log`）；
  `tsc --noEmit` 退出码 0（`m-mwimqbau-683566.log`，组件最终改动后复跑）。

### 9.1 2026-11-16 B1 第二轮：正文安全、离开守卫与后端门禁

| 层 | 落地内容 | 证据/验证 |
|---|---|---|
| 前端保存 | `savePromiseRef` 单章节唯一在途请求；`flush` 串行等待，成功后比较草稿并补交最新版本；`savedRef` 不被旧请求回写；失败保留草稿、显示错误与重试按钮 | 组件测试：A/B 并发（B 晚发、A 后完成）最终落 B；连续输入只补交最后一版 |
| 离开守卫 | `NovelManuscriptPanel.registerFlush` → `ProjectWorkspacePanel` 切模块前 await；`registerProjectLeaveGuard` → `WorkbenchShell.selectProject` 切项目前 await；失败取消导航/切换，保留原稿；首页入口等待守卫后再进工作台 | 组件测试用父级协议 harness 验证成功等待、失败不导航、项目不串线；真实壳层集成测试未执行（未验证） |
| 卸载 | cleanup 统一走 `flush`；保存成功后即使组件已卸载也推进 `savedRef`，避免卸载循环重复写库；失败经 `onNotice` 报告 | 组件测试：无脏稿 0 次写库、有脏稿 flush、失败不静默 |
| 归档 | 新建卷/章、卷章重命名/排序/删除、正文输入全部 disabled + 事件防御；归档瞬间保留草稿并显示“项目已归档，正文未保存”；恢复后可重试 | 组件测试：全部入口 disabled；编辑中归档草稿不丢 |
| Rust 门禁 | `ensure_novel_project` 校验 kind；所有小说写入再校验 status=active；只带章节/卷 ID 的命令先解析 owner；读允许归档；未新增 v59 | `novel_commands_enforce_kind_and_archived_read_only`（新增）与 8 MiB 断言；隔离 worktree `cargo test --lib novel` 6/6 通过（共享工作树被其他模块编译错误阻塞） |

已知限制：Tauri `CloseRequested` 仍未 `prevent_close`，应用关闭/强杀时 cleanup 会发起保存但无法等待完成，本轮未改全局关闭协议。

### 9.2 2026-11-16 B1 第三轮：关闭/退出握手、删除安全与生命周期验收

| 层 | 落地内容 | 证据/验证 |
|---|---|---|
| 工作台关闭 | `workbenchCloseGuard.ts` 在 `onCloseRequested` 内同步 `preventDefault()`，再 await 正文守卫；成功 `allowClose` 后 `window.close()`；失败保持窗口并提示；无守卫放行、重复关闭只跑一轮、监听安装失败 Toast | closeGuard 5 项；WorkbenchShell 安装于真实窗口 effect（单测环境跳过） |
| 应用退出 | Rust `ExitHandshake`（requestId、首个匹配回执、5s 超时、并发拒绝）；`request_exit()` 在管线 shutdown 前排空工作台正文，失败回滚防重入并 emit `app-exit-blocked`，应用保持可用；托盘/`quit_app`/`RunEvent` 均走该路径 | `exit_handshake` 5/5；`app_exit_ack` 注册；托盘/系统退出共用 `request_exit` |
| 删除安全 | 删除对话框展示章节数/总字数/当前编辑/未保存状态；保存后删除 await `flush`，明确丢弃先等 `settleInFlight`；失败保留数据与草稿；token 防旧请求写新 UI | `NovelManuscriptPanel.test.tsx` 21 项中删除安全 11 项，含 deferred 在途请求、多章节卷、重复点击 |
| 项目切换 | 正文面板 projectId effect 先 await flush 再清空/换项目；壳层 `selectProject` 捕获抛错并取消；真实壳层测试使用真实 `WorkbenchShell` + `ProjectWorkspacePanel` + `NovelManuscriptPanel` | `WorkbenchShell.selectGuard.test.tsx` 4/4（项目数据 hook mock；面板与正文组件真实） |
| 回归 | v57/v58、Full/Quick 备份、novel 类型/归档门禁未改；未新增 v59 | 隔离 worktree `cargo test -j 1 --lib novel` 6/6（含 v57、v58、备份往返、kind/归档） |

实际命令与日志：前端四文件合计 **36 passed / 0 failed**（`l-mwitumhh-ee92e8.log`）；
`cargo test -j 1 --lib exit_handshake` **5 passed / 0 failed**（`m-mwisiway-17db43.log`）；
`cargo test -j 1 --lib novel` **6 passed / 0 failed**（`m-mwisq0fp-b1da86.log`）；
`tsc --noEmit` 在本轮改动后、其他任务破坏前 exit 0（`m-mwite1wb-c2cc5a.log`）；最终复跑
`m-mwitvali-e69464.log` exit 2，仅 3 个错误全部来自其他任务的 `ActionCenterPanel.tsx`（未完成
JSX），本轮文件无报错。`npm run build` exit 0（`m-mwith57o-a6d089.log`，2047 modules /
vite 18.40s；同样早于该并发破坏）。

未验证：真实原生窗口关闭/托盘退出/系统退出走查、Tauri 打包/安装包。已知限制：
关闭门禁仅前端 `onCloseRequested`，Rust 不 `prevent_close`；系统强杀/断电无法握手；退出失败
没有“强制退出并明确丢弃正文”的独立按钮。

## 10. 2026-11-16 创作工作台五线并行（B2 / G1 / C1 / U1 / D1）

五条线同时开工、各自独占领域目录与 Rust 领域文件，公共外壳（Profile、面板装配、
`bridge.ts`、`lib.rs`、`commands/mod.rs`、`db/mod.rs`、`backup.rs`）只由集成负责人写。
契约见 `tmp/acceptance/creative-workspaces-v1/contract.md`，架构说明见
[WORKSPACE_PROJECTS.md §12](../WORKSPACE_PROJECTS.md)。

| 线 | 任务 ID | 已实现 | 前端测试 | 迁移 | IPC | 结论（2026-11-17 更正） |
|---|---|---|---|---|---|---|
| A 小说 | `creative-novel-b2` | 人物档案+关系、世界观设定、章节引用、人物/世界观模块 | 29/29（3 文件）+ Rust 9/9 | v59（4 表） | 14 | 命令层通过：Rust 9/9、备份 Full+Quick 往返通过；真机待验 |
| B 游戏 | `creative-game-g1` | 引擎识别（Unity/Unreal/Godot/自定义+手动指定）、资源关联、构建/测试登记、资源与构建模块 | 10/10 + Rust 9/9 | v60（4 表） | 12 | 命令层通过：Rust 9/9、隔离库 15 项 checks 全 ok；真机待验 |
| C 漫剧 | `creative-comic-c1` | 剧集（含剧本）、分镜（可排序）、角色与场景、素材版本与采用状态 | 16/16 + Rust 7/7 | v61（5 表） | 21 | 命令层通过：Rust 7/7、全流程往返通过；真机待验 |
| D 通用 | `creative-general-u1` | 6 模板真实初始化、里程碑与阶段、项目资料关联、真实统计视图 | 21/21 + Rust 15/15 | v62（2 表） | 9 | 命令层通过：Rust 15/15、六模板矩阵与统计对照通过；真机待验 |
| E 开发 | `creative-development-d1` | 仓库与 Git 风险只读探测、Agent 任务接续（自述完成≠验收通过）、构建/验收追溯 | 7/7 + Rust 9/9 | v63（2 表） | 7 | 命令层通过：Rust 9/9、探测严格只读；真机待验 |

> **2026-11-17 更正说明（保留历史口径，不覆盖）**：本表此前五线结论列均为「部分通过」，当时
> 的含义是"组件级/编译级已验证，真机 UI 与备份恢复未验证"。本轮 V1 最终验收补齐了各线的
> Rust 用例与前端用例实测（数字见上表），并修复了公共备份层的 3 个 P1（快速备份写出策略缺 17 表、
> 漫剧扩展表恢复顺序致 FK 787、暂存架项目关联顺序倒置），五线备份 Full+Quick 往返已实测通过、
> 17 表真往返一致。**但真实窗口生命周期、500 条性能、四尺寸适配、NSIS/MSI 安装升级仍未执行**，
> 因此不能把本表的"命令层通过"读成"V1 正式通过"；总体结论为 PARTIAL，详见
> `tmp/acceptance/creative-workspaces-v1/report.md` §10.6。

公共侧由集成负责人完成：模块 ID 并集与 `isModuleId`、五个 Profile 的模块顺序、11 项专业
能力登记、`creative/moduleRegistry.ts` 装配、`CreativeModuleHost` 降级、63 条命令注册、
v59–v63 迁移引用、17 张新表的备份登记（`EXTENDED_TABLES` + `BACKUP_TABLES`，
`quick` 全量保存）。

**本轮共同未取证项**（因此所有专业能力只声明 `limited`，不得声明 `available`）：

- Rust 功能测试（五线共 30 个用例）**未取得运行证据**：`cargo check` exit 0 只证明可编译；
  `cargo test` 先后被本机页面文件耗尽（`os error 1455`，rustc `0xc0000409`）与并行线在途
  `#[cfg(test)]` 代码阻塞；
- 真实 Windows 窗口内的逐线操作链路、备份真实往返恢复、500+ 条性能手感未走查；
- `npm run build` / 统一快照构建在并发任务破坏工作树期间无法取得干净基线
  （`src/components/tasks/TasksPanel.test.tsx` 语法错误、`src/file_workspace/volume.rs`
  `raw` 未定义均属**其他任务在途文件**）。

未接入且保持不可调用：`comic.generate`（unavailable，无生成管线）、`novel.aiAssist`、
`general.delivery`、`core.mediaLink`（跨媒介预留，只登记不进任何 Profile）。


