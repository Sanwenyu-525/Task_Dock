# 项目工作空间（Project Workspace）

> 状态：P0 数据模型/窗口/入口 + 第三轮可靠性整改已完成（2026-11-13）；
> 创作工作台 A 阶段「小说项目类型接入」已完成（2026-11-15，迁移 v57）。
> 本文定义概念边界、能力声明、跨窗口/活跃项目一致性规则与当前可用范围；
> 实现与验收证据见 `tmp/acceptance/project-workspace/report.md`、
> `tmp/acceptance/novel-project/report.md`，统一任务矩阵见
> `docs/efficiency-hub/TASK_MATRIX.md`。

## 1. 为什么需要独立概念

Task Dock 已有三类容易与「项目」混淆的对象，本功能不替换、不合并它们：

| 现有概念 | 语义 | 生命周期 | 与本功能的关系 |
|---|---|---|---|
| `dev_projects` | 单个代码仓库目录的登记（Git 摘要来源） | 用户显式登记；删除只删登记 | 「开发」型工作空间可**弱引用**一个 `dev_projects.id`，复用 Git 探测与开发工作台 |
| `scenarios` | 一组应用 / URL / 文件夹的启动清单，可软引用工作流或现场快照 | 用户手动启动 | 仍是「环境启动器」；不承载项目状态、事项、产物 |
| `workspace_snapshots` | 某一刻窗口 / 导航现场的捕获与恢复 | 可恢复、可清理 | 仍是「现场快照」；可作为项目工作流的一个步骤，但不是项目本身 |
| **Project Workspace（本功能）** | 跨工具的长期工作容器：类型、根目录引用、事项/阶段、关联任务、开发项目链接 | 用户创建/归档/删除；**永不移动或删除外部文件** | 以弱引用串联上述对象，不复制它们的实现 |

设计原则：

- **不重造**资源管理器、IDE、Agent 客户端或视频编辑器；只做跨工具的项目状态、切换、交接与复盘。
- 项目数据独立存储；未归属任何项目的旧数据（任务、暂存、现场、开发项目）保持原路径可用。
- 删除工作空间只删除登记与本地元数据，不删除仓库、文件、任务或开发项目。
- 根目录、关联开发项目、关联任务都是**弱引用**：目标消失时如实显示失效，不静默清理。

## 2. 数据模型（迁移 v49；v57 扩展类型，v58 增加小说卷/章）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `workspace_projects` | 工作空间主记录 | `kind` CHECK 限定 `development / game / ai_comic / general / novel`（v57 起五值）；`status` 限定 `active / archived`；`root_path` 可空、只登记不写入 |
| `workspace_instances` | 每个项目一份窗口状态 | `project_id` 主键 + 级联删除；`active_module`、`layout_json`、`last_opened_at` |
| `workspace_items` | 通用事项/阶段节点（集数、镜头、角色、构建、测试、问题…） | 自引用 `parent_id`；`status` CHECK；`metadata_json` 只存 JSON 对象 |
| `workspace_task_links` | 项目 ↔ 现有任务的多对多弱关联 | 两端外键级联；只存关联，不复制任务内容 |
| `workspace_resource_links` | 五类项目共用的笔记 / Agent 会话 / 外部产物关联（v69） | 项目外键级联；资源目标为弱引用，目标失效仍保留关联；同项目/类型/目标唯一 |
| `shelf_project_links` | 暂存条目 ↔ 项目弱关联（v51） | 两端外键级联；只存关联 |
| `novel_volumes` | 小说卷（B1，v58） | `project_id` 级联删除；`sort_order` 控制卷内顺序 |
| `novel_chapters` | 小说章与正文（B1，v58） | `project_id`、`volume_id`（可空=未分卷）均级联；正文为 `TEXT`，`word_count` 由保存时更新 |

不做的事：

- 不新增文件托管目录；根目录与产物路径只作引用。
- 不引入第二套任务系统；任务仍由 `tasks` 管理。
- 不实现游戏/漫画专用流水线（分镜生成、资源打包、引擎构建）；小说只实现**纯文本**
  正文与卷→章树（B1），不实现富文本/Markdown、版本历史、人物/世界观与 AI 生成；这些能力
  仍标记为 `planned`/`unavailable`，不得显示为可用。

## 3. 能力声明与「诚实可用」

能力注册表是静态元数据，不是权限系统：

```ts
type WorkspaceCapabilityState = "available" | "limited" | "planned" | "unavailable";
```

规则：

1. 只有真实调用链已接通、失败可解释的能力才标记 `available`；
2. 只有部分路径可用（如需人工步骤、只读、仅特定类型）标记 `limited` 并写明降级方式；
3. 未实现的能力必须标记 `planned`，UI 不得给出可点击的假入口；
4. 外部依赖缺失（Git 不存在、目录失效、视频工具未安装）是运行时降级，不改变静态状态。

**基础 Profile ≠ 完整专业业务闭环。** 当前五种类型的导航标题、首页卡片与能力声明确实不同，
并且 `available` 能力都有真实调用链（项目/事项/任务关联/开发项目/Git/Agent 快照），但：

- 游戏类型没有资源索引、构建/测试登记、引擎跳转；
- AI 漫剧没有素材/角色库、生成结果导入、版本比较与采用；
- 小说类型（B1，2026-11-16）已有纯文本正文与卷→章树（`novel.manuscript` available）；
  仍没有人物档案、世界观、AI 创作辅助（这三项登记为 `planned`，不可调用），
  也没有 Markdown/富文本、版本历史与导出；
- `core.layout` 已声明为 `limited`：解析器支持 `moduleOrder`/`hiddenModules`，
  但当前 UI 只有「当前模块」会被写回，没有排序/隐藏编辑入口。

## 4. 三层入口

| 层 | 入口 | 行为 |
|---|---|---|
| 1 胶囊 | 轨道顶部肩部的项目按钮（注册中心 `workspace` 入口，可隐藏） | 打开/唤醒唯一大型工作台（U0 起为工作台首页），不展开面板、不改变胶囊几何 |
| 2 完整面板 | 左侧导航「工作空间」页 | 项目列表、创建/切换、打开统一工作台项目页 |
| 3 统一工作台 | 独立 WebView 窗口 `workspace` | 普通装饰、任务栏可见、可缩放/最大化、非置顶、记忆几何；承载全部完整功能页（任务/Agent/开发/项目/收集/剪贴板/…/设置）；关闭不影响胶囊 |

统一工作台不是主窗口的放大版：不挂载 `App.tsx`，不启动主窗口的全局轮询、贴边吸附与通知调度；
能力集由 `capabilities/workspace.json` 隔离。项目模式只是工作台的一个路由：全局导航始终存在，
中央区域按 Profile 展示项目专业模块（见 [ARCHITECTURE.md](ARCHITECTURE.md)「统一大型工作台」）。

## 5. 兼容与迁移

- 迁移只追加在 `MIGRATIONS` 末尾（v49…v58），不修改已发布迁移。
- **v58（2026-11-16，B1）**：只新增 `novel_volumes` / `novel_chapters` 两表与三个索引
  （卷/章项目级联、章节可空 `volume_id`、`volume_id` 级联），不改任何既有表与行；
  旧库升级后既有项目、实例、事项、关联与布局 JSON 原样保留。
- **v57（2026-11-15）**：`workspace_projects.kind` 的 CHECK 扩为五值。SQLite 不能原地改
  CHECK，必须重建表；该表被 `workspace_instances / workspace_items / workspace_task_links /
  shelf_project_links` 四张表以 `ON DELETE CASCADE` 引用，迁移器又在事务内执行、事务内不能
  关闭 `PRAGMA foreign_keys`。因此 v57 在**同一个事务**里：暂存五张表整行到 TEMP 表 →
  按依赖逆序删除四张依赖表 → 重建父表并复制全部列 → 重建依赖表与索引 →
  回填数据（事项先 `parent_id=NULL` 插入，再一次性回填父子关系）→
  用 scoped `PRAGMA foreign_key_check` + `EXCEPT` 逐行比对做迁移自检，任一不满足即
  CHECK 报错、整体回滚到 v56。迁移前后保留项目 ID/名称/类型/状态/根目录/dev 弱引用/
  备注/创建更新时间、窗口实例与布局 JSON、事项父子关系与排序、metadata_json、
  任务关联、暂存关联；不删除旧数据再重建。
- 新表全部注册到 `BACKUP_TABLES`；恢复顺序：项目 → 实例 → 事项 → 任务关联；
  小说按 项目 → 卷 → 章 插入（v58，章节的 `volume_id` 可为空）。
  备份不按 `kind` 过滤，`novel` 项目与其它四种类型走同一套往返流程，正文原文全量保存。
- 新设置键：`workspace_active_project`（字符串，空 = 未设置）、
  `workspace_window_rect`（JSON 对象，窗口自管几何，不进入前端 Settings 快照）。
- U0 新增工作台外壳布局键：`workbench_layout`（版本化 JSON：上次路由/项目/右栏显隐/分栏宽度；
  缺失或损坏回默认，不迁移、不清空 `navigation_layout` 或项目 `layout_json`）。
- 旧数据不迁移、不重新归属：没有项目时，任务/收集箱/暂存架/开发工作台按原路径工作。
- `dev_projects` 与 `workspace_projects` 不是同一张表；开发工作空间只保存
  `dev_project_id` 弱引用，删除任一方向都不级联删除另一方。

## 6. 失败与边界

- 根目录不存在：显示「目录失效」，不自动删除、不自动重建。
- 关联任务/开发项目不存在：显示失效徽标，保留原 ID 以支持恢复。
- 窗口几何越界：恢复时收敛到目标显示器工作区；显示器消失时回落主显示器。
- 文件操作：本功能只登记路径，不移动、不覆盖、不删除任何外部文件。
- 未执行的原生窗口/DPI/多显示器验收必须标注「未验证」，不能用浏览器预览替代。

## 6.1 跨窗口「打开开发工作台」协议（P0-A）

> U0 起（2026-11-14）：工作台项目页与开发工作台在同一窗口内，项目页直接写
> `workbench_current_project` 后走本窗口路由（失败回滚），不再需要跨窗口请求。
> 下面这套请求/回执协议保留给旧调用方与历史记录；当前前端已无调用方。

代码：`src/lib/mainWindowNavigation.ts`、`src/workspace/devNavRequest.ts`、
`src-tauri/src/project_workspace_window.rs`、`src/App.tsx`。

1. **请求编号由工作空间窗口在 `invoke` 之前生成并登记**（`requestId` 随命令传入）。
   主窗口的回执可能先于命令响应到达，若等返回值才知道编号，早到的回执会被丢弃 →
   假超时。Rust 仍保留单调计数器作为未传编号时的兼容回退。
2. 回执状态为 `pending | succeeded | cancelled | failed`；`pending` **不是终态**：
   主窗口被未保存草稿拦截时先回 pending，用户确认/取消后必须再回一条最终回执。
   工作空间窗口据此展示「尚未进入 / 已取消 / 失败」，不会把 pending 显示成成功。
3. 主窗口事务按顺序执行：唤醒 → 退出胶囊（既有 undock）→ 切回完整模式 → 预检门禁 →
   提交 `workbench_current_project` → 切页 → 校验标签 → 聚焦。
   **开发项目上下文只在导航事务里提交**，Rust 命令不再提前写。
4. 已知有未保存草稿时**完全不写上下文**（不依赖回滚是否成功）；预检后才发现草稿则回滚。
   提交后切页失败、标签未生效都会回滚并报失败。
5. 并发：同一主窗口串行执行；新请求取代仍 pending 的旧请求，旧事务回 cancelled、
   不覆盖新结果；重复回执只处理一次；迟到回执只在没有新请求时修正展示（标记迟到）。
6. 超时只针对「仍在等待首个结果」的请求；收到 pending 后不再触发首个结果超时。
7. 主窗口不存在 / 事件发送失败：直接失败，不写上下文、不返回「已受理」。

## 6.2 活跃项目写入所有权（P0-B）

代码：`src-tauri/src/commands/project_workspace.rs`、`src/workspace/activeProjectWriter.ts`、
`src/workspace/WorkspaceApp.tsx`、`src-tauri/src/project_workspace_window.rs`。

- **项目选择拥有活跃项目**：`workspace_active_project` 只由显式选择/创建/删除回退/
  跨窗口「打开某项目」写入。
- `workspace_instance_save` **只更新该项目自己的模块与布局**，不再隐式写活跃键
  （旧实现导致「切到 B 后，A 的延迟模块保存把活跃项目改回 A」）。
- 前端写入统一走串行合并队列：快速 A→B、A→B→A 时最后一次选择必然最后落库；
  旧写入失败不阻塞新选择，且被取代的失败不提示用户。
- 删除当前项目后把回退选择写回设置；重启恢复时若活跃 ID 无效则落到第一个项目并回写。
- 打开专业窗口：先校验项目存在，**窗口创建/显示成功后**才写活跃项目。
- 无效/已删除项目 ID 被后端拒绝，旧活跃值保持不变。
- 同一项目的模块切换串行保存，保留 `moduleOrder`/`hiddenModules`，最后一次点击生效；
  项目切换那一帧不读取旧项目布局（必要时重新读取本项目实例）。

**2026-11-17 后端补强**：`workspace_instance_save` 省略或传 `null` 的 `layoutJson`
表示只保存活动模块，保留原布局；新实例仍默认 `{}`，显式传 `{}` 才清空布局。
项目删除及清除匹配的活跃项目键现在处于同一 SQLite 事务中；任一步失败均回滚，避免
命令报错后项目实际已消失。命令签名与表结构不变，无迁移；Breaking Change: No。

## 6.3 渲染隔离与任务选择器（P1-A / P1-B）

- `scopeWorkspaceContext` 只允许渲染「上下文项目 === 当前选中项目」的数据；
  不一致时按加载中处理（空集合 + 默认布局），不显示上一个项目的事项/关联，
  不给旧项目按钮留入口。写操作仍由数据层按点击时的项目 ID 校验归属。
- 任务选择器 `canLoadMore` 以**服务端返回条数**判断（不是过滤已关联后的可显示条数），
  避免「本页大部分已关联」时错误隐藏后续未关联任务；到达后端 200 条上限时明确提示
  用搜索缩小范围。

## 7. 迭代状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 数据模型、项目 CRUD、窗口、三层入口、开发项目复用、旧路径兼容 | 已实现（自动化验证；原生窗口待真机） |
| P0-A | 跨窗口请求/回执、pending 最终态、上下文提交时机、并发/迟到/超时 | 已实现（单测 + Rust 测试） |
| P0-B | 活跃项目写入所有权、串行 latest-wins、删除/恢复落盘 | 已实现（单测 + Rust 测试） |
| P1-A | 首渲染项目隔离、写结果隔离、模块保存串行 | 已实现（父组件切换测试） |
| P1-B | 任务选择器分页与 200 上限提示 | 已实现（hook 测试） |
| P1-C | Profile/Capability 诚实性审计（`core.layout` 降为 limited） | 已实现（契约测试） |
| A1 | 小说项目类型接入：v57 迁移、Rust 类型/命令复用、Profile/图标/首页、备份往返 | 已实现（2026-11-16 复跑：Rust 3/3、Vitest 16/16、`tsc --noEmit` 通过；原生窗口未逐项走查） |
| B1 | 小说正文与章节：v58 卷/章表、章节 CRUD/自动保存/字数、正文模块 UI、备份往返 | 已实现（2026-11-16 第一轮：Rust 5/5、Vitest 16+4；同日第二轮：串行保存/离开守卫/归档只读/后端 kind+status 门禁，前端 26/26） |
| P1 | 游戏/漫画阶段模板、产物版本与采用状态、工作流 I/O 跟踪 | 未开始 |
| P1 | 跨项目复盘的统一验收视图、文件缩略图/预览 | 未开始 |
| P2 | 移动端只读镜像或远程项目视图 | 未开始 |
| P2 | `list_tasks` 返回 total/next 分页元数据 | 未开始 |

## 8. 验证边界

- 自动化：Vitest（导航事务、请求状态机、活跃项目队列、上下文隔离、分页、布局/Profile 契约）
  与 Rust（命令归属、活跃项目无副作用、ack 状态、几何收敛）；A 阶段追加
  `workspaceProfiles.test.ts`（五种 Profile/能力/旧布局）与 Rust
  `v57_novel_kind_migration_preserves_workspace_rows_and_fk_integrity`、
  `novel_project_supports_crud_status_instance_items_and_task_links`、
  `novel_workspace_project_roundtrips_in_full_and_quick_backup`。
  2026-11-16 复跑结果：上述 3 个 Rust 测试 3 passed / 0 failed；
  `vitest run src/workspace/workspaceProfiles.test.ts` 16 passed；
  `tsc --noEmit` 退出码 0。证据见 `tmp/acceptance/novel-project/report.md`。
- 原生：Windows 真机上的窗口打开/关闭、DPI、多显示器、胶囊内发起导航、草稿确认/取消、
  关闭专业窗口后回执——本轮**未执行**，报告中标为未验证。

## 9. U0 统一工作台（2026-11-14）

- **唯一宿主**：`workspace` 窗口从「项目专用窗口」升级为唯一大型完整工作台；仍沿用原
  label、创建命令、`workspace_window_rect` 几何、显示器收敛与关闭语义，没有新增窗口。
- **项目页迁移**：旧 `WorkspaceApp` 的项目内容（概览卡片、事项、任务关联、项目设置、
  开发项目/Git/Agent 卡片）迁入 `src/workbench/ProjectWorkspacePanel.tsx`；窗口顶栏、
  项目列表、创建弹层、主题同步、活跃项目串行写入上移到 `WorkbenchShell`。项目 CRUD
  仍使用原有 `workspace_project_*` 命令，不复制数据模型。
- **无项目可用**：首页、任务、Agent、收集与暂存、剪贴板、应用、工作流、诊断、设置等
  通用功能无需项目；只有项目页与开发项目关联需要项目。
- **同窗口开发工作台**：项目页「在开发工作台打开」先写 `workbench_current_project`，
  再在当前窗口切到开发工作台路由；路由失败（保存中）回滚上下文。跨窗口请求/回执协议
  保留但当前无调用方。
- **导航回执**：`workbench_open_window` / `workbench_take_nav` / `workbench_nav_ack`
  采用「客户端预生成 requestId + 入队 + 事件快路径 + 拉取 + 回执」；`pending` 由工作台内
  草稿确认条收敛为最终结果；12s 无回执按失败提示。
- **布局**：新增 `workbench_layout`（路由/项目/右栏/宽度），与 `navigation_layout`、
  `workspace_instances.layout_json` 正交；旧键不迁移、不清空。
- **Phase D（主窗口收敛）**：主窗口完整模式中开发工作台、项目工作空间、应用、微件、
  手机互传、工作流、历史、规划、帮助、诊断、资源 11 个大型管理页不再挂载第二套面板，
  统一退化为 `WorkbenchHandoff`（功能摘要 + 「在完整工作台中打开」）；点击走
  `workbench_open_window` 并落到对应路由。任务/Agent/行动/剪贴板/收集与暂存属于
  胶囊快捷面，设置是主窗口窗口/外观配置入口，继续保留。导航显隐/排序与 Ctrl+数字
  语义不变。
- **原生验收（2026-11-14，隔离实例，最终二进制）**：胶囊四边停靠/展开收起、胶囊直接
  入口打开工作台、关闭工作台后胶囊继续可用并重开；工作台 19 路由逐页、任务栏
  `WS_EX_APPWINDOW`、最大化/恢复；草稿取消/确认、项目上下文只在确认后提交；Phase D
  9 个入口原生点击与跳转。1180×760 @125% DPI 单屏。
- **仍受限**：多显示器（本机 1 屏）、150%/200% DPI、2K/4K 逐页视觉/键盘走查未验证；
  迁移前性能基线未测（当前仅有迁移后采样）。
- **状态栏磁盘项（2026-11-17）**：状态栏磁盘项改为列出 `resource_snapshot` 枚举到的**全部卷**，
  按盘符稳定排序（`C: 剩余 … · D: 剩余 …`），不再只取 `disks[0]`（数据目录所在主卷）。原因是
  不同窗口/实例的数据目录可能不在同一卷，只显示主卷时两个窗口会分别显示 `C:` 与 `D:`，看起来
  像读到了不同的机器。读不到可用空间的卷（探测超时/未知）保留卷名并显示「暂不可用」，不以 0 冒充；
  窄窗（≤760px）仍按原优先级整项隐藏。磁盘项右侧提供手动刷新按钮：点击复用同一个
  `resource_snapshot`（不新增后端命令），刷新中禁用并旋转图标，失败保留上次读数并弹提示；
  挂载时仍只读一次，无轮询。实现：`WorkbenchShell.tsx` 状态栏与 `workbench.css`、词条
  `workbench.statusDiskUnavailable` / `statusDiskRefresh` / `statusDiskRefreshFailed`（zh/en）；
  测试 `WorkbenchShell.test.tsx` 新增 1 项（三卷排序 + 暂不可用 + 点击刷新）。**未验证**：
  真机多卷（含断连网络盘/可移动盘）状态栏与刷新走查未执行。
- **状态栏「包信息」（2026-11-17）**：底部状态栏在「Agent 会话数 / 磁盘剩余」之后新增可点项
  `构建 {短commit} · {profile} · {构建时间}`，右侧 `v0.5.0` 不变。数据来自新命令
  `app_build_info`（`src-tauri/src/commands/system.rs`）：运行期包元信息（包名 / 版本 / 标识 /
  `流程-架构`）+ 编译期注入的 `build`（短 commit、dirty、Unix 构建时间、debug/release、exe
  路径）；`build` 复用 `build_info()`，与 `performance_diagnostics` 同一实现，不新增第二套溯源，
  也不读写数据库或文件系统。弹窗「包信息」逐项展示字段（含「构建时工作树」三态：干净 / 有未提交
  改动 / 未知），并给出可直接复制的 JSON（`commit / dirty / profile / builtAt.local|iso|unix /
  exe`）；状态栏项另有 `data-build-*` 稳定属性，截图与脚本、Agent 读到的是同一份值。
  **边界**：安装包产物、构建 ID、包含任务属于构建台账（`tmp/integration/builds/<buildId>/build.json`），
  运行时不可得，弹窗只说明去哪查（或开发工作台「构建与验收追溯」面板），不伪造这些字段。
  **降级**：非 Tauri 预览或 IPC 失败时整项不渲染；`commit` 与构建时间都取不到时也不占位；
  窄窗（≤760px）只保留 `构建 {commit}` 短文案，避免把「Agent 会话数 / 磁盘剩余 / 版本号」挤成
  截断（1180 与 400 宽静态 harness 对照：`tmp/visual-check/statusbar-1180.png`、`statusbar-400.png`）。
  实现：`src/workbench/WorkbenchBuildStatus.tsx`（新增，含 `formatBuildStamp` /
  `buildInfoSnapshot`）、`WorkbenchShell.tsx` 页脚一行接入、`workbench.css`、`src/lib/bridge.ts`
  （`AppBuildInfo` + `appBuildInfo()`）、`src-tauri/src/lib.rs` 命令注册、zh/en 词条；
  测试 `src/workbench/WorkbenchBuildStatus.test.tsx`（7 项，含降级与复制一致性）；
  预览 harness 的 IPC mock 补同形夹具（`scripts/make-preview.mjs`）。

## 10. 小说项目类型（A 阶段，2026-11-15）

**目标**：在不新增第二套项目/任务/窗口系统的前提下，让「小说」成为第五种专业 Profile，
为后续正文编辑器、章节/卷、人物设定、世界观与 AI 辅助预留位置。

### 10.1 已实现

| 层 | 内容 |
|---|---|
| 数据库 | v57 迁移：`kind` CHECK 五值；事务内暂存 → 按依赖逆序重建 → 回填 → 自检；`PRAGMA foreign_key_check` 0 违例 |
| Rust | `PROJECT_KINDS` 增加 `novel`；创建/编辑/列表/归档/恢复/设为当前/备注/根目录沿用原命令，没有新增重复 CRUD |
| TypeScript | `WorkspaceKind` 增加 `"novel"`；`WORKSPACE_PROFILES.novel`（标签「小说」、图标 token `book-open`，映射到 `BookOpen`） |
| 导航 | 概览 / 写作事项 / 任务关联 / 项目设置（只使用既有模块 ID） |
| 首页 | 小说项目（基本信息）/ 项目简介 / 写作事项 / 任务关联 / 后续创作功能（只列 planned 能力，纯文本无按钮） |
| 能力 | available：`core.project` / `core.items` / `core.taskLinks`；limited：`core.layout`；planned：`novel.manuscript` / `novel.characters` / `novel.worldview` / `novel.aiAssist` |
| 入口 | 统一工作台新建/编辑项目类型、项目列表徽标、项目详情类型、项目切换与独立窗口，全部由 Profile 注册中心派生 |
| 备份 | `novel` 项目随 `workspace_projects` 等表完整往返，备份不按 `kind` 过滤 |

### 10.2 尚未实现（后续阶段）

- 小说正文编辑器、富文本/Markdown、自动保存与版本历史（纯文本 + 自动保存已由 B1 实现，
  见 §11；富文本与版本历史仍未实现）；
- 章节/卷管理（A 阶段只用 `workspace_items.stage` 标注；B1 已建模卷→章树与字数统计，
  见 §11）；
- 人物档案与关系、世界观设定集、剧情时间线、伏笔追踪；
- AI 续写/改写/生成、导出（TXT/Markdown/DOCX/PDF）。

本阶段**没有**为上述功能新建数据库表；`workspace_items` 足以承载「写作事项」，
下一阶段再评估是否需要独立章节/人物表（仍按 append-only 迁移追加）。

### 10.3 下一阶段建议（B 阶段）

1. 章节数据模型与编辑器：先做单项目内章节树（标题/字数/状态），复用事项父子关系作为过渡；
2. 人物/世界观条目：同构条目 + 关系表，不引入第二套搜索与第二套任务；
3. AI 辅助前先定义上下文装配与授权边界（沿用 Agent 管线的有界队列、取消与失败语义）；
4. 原生窗口逐页走查：新建/编辑/归档/切换/布局保存/备份恢复，并补齐多显示器与 DPI 场景。

## 11. 小说正文与章节（B1，2026-11-16）

**目标**：在既有 Project Workspace 与 novel Profile 上接入「卷 → 章」两级章节树和纯文本
正文编辑器；不新建项目/任务/窗口系统，不复制 CRUD。

### 11.1 数据与命令

- 迁移 **v58**：`novel_volumes`（id/project_id/title/sort_order/时间）与
  `novel_chapters`（id/project_id/volume_id/title/content/word_count/sort_order/时间）。
  `project_id` 与 `volume_id` 均 `ON DELETE CASCADE`；`volume_id` 为 NULL 表示未分卷。
- Rust 命令（`commands/project_workspace.rs`，IPC 包装 + `lib.rs` 注册）：
  `novel_volume_list/save/delete`、`novel_chapter_list/get/save/save_content/delete`。
  列表只返回章节元信息，正文按章按需读取；正文保存只更新 content/word_count/updated_at。
- 校验：标题 240 字符、正文 8 MiB 且不裁剪首尾空白（缩进/空行属于作者内容）、
  卷与章必须属于同一项目；字数 = 非空白字符数。

### 11.2 前端

- `WorkspaceModuleId` 增加 `manuscript`；`novel` Profile 导航为
  概览 / **正文** / 写作事项 / 任务关联 / 项目设置；旧布局缺少 `manuscript` 时自动补齐。
- `novel.manuscript` 从 `planned` 提升为 `available`，`provider` 指向 v58 表与内置纯文本
  编辑器，`action` 指向 `manuscript` 模块；人物/世界观/AI 仍为 `planned` 且不可调用。
- `NovelManuscriptPanel`：左栏卷→章树（新建/重命名/上下移/两步删除确认，未分卷桶），
  右栏 textarea；停止输入约 0.9 秒自动保存，失焦、切换章节/项目与卸载时立即落盘；
  展示本章与全书字数、保存状态；归档项目只读。全部使用现有 `ws-*` 语义 Token。
- 概览新增「开始写作」按钮（真实模块跳转），不产生假入口。

### 11.3 第二轮保存与约束修复（2026-11-16）

- **单章节串行保存**：`NovelManuscriptPanel` 用 `savePromiseRef` 保证同一章同时只有一个
  `novel_chapter_save_content` 在途；保存完成后比较最新草稿，若仍不同则自动补交最新版本。
  `savedRef` 只在成功且仍属同一项目/同一章时推进，旧请求不会回写新状态；失败保留草稿、
  显示“保存失败，可重试”，重试按钮显式触发同一 `flush`。
- **离开前落盘协议**：正文面板通过 `registerFlush` 向 `ProjectWorkspacePanel` 注册异步
  `flush`；切换模块先 await，失败则取消切换。`ProjectWorkspacePanel` 再通过
  `registerProjectLeaveGuard` 向 `WorkbenchShell` 注册项目守卫；顶栏选择器与首页项目入口
  都走异步 `selectProject`，保存失败不换项目、不卸载面板。首页仅在守卫通过后才进入工作台。
- **卸载**：cleanup 不再发裸 IPC，而是调用同一个 `flush`（串行、补交最新草稿、失败经
  `onNotice` 报告）。窗口被强杀/应用关闭无法等待异步 IPC，本轮不改全局关闭协议，
  该限制保留（见验收报告）。
- **归档只读**：`archived` 时新建卷/章、卷章重命名、上下移、删除、正文输入全部禁用，
  事件处理函数仍有防御检查；正在重命名时归档会立即关闭输入框。章节标题仍可点击以阅读
  其他章。归档瞬间的脏稿保留在 textarea 并显示“项目已归档，正文未保存”，恢复进行中后
  可重试保存。
- **后端门禁**：`ensure_novel_project(conn, project_id, require_active)` 统一校验
  `kind = novel`；写入（卷/章保存、正文保存、删除）还要求 `status = active`，读取允许归档。
  只带章节/卷 ID 的命令先解析所属项目再校验，避免先读正文再拒绝；未新增 v59。
- **自动化**：`NovelManuscriptPanel.test.tsx` 扩到 10 个并发/离开/归档用例；Rust 新增
  `novel_commands_enforce_kind_and_archived_read_only` 并补充 8 MiB 上限断言。

### 11.4 明确未做

- Markdown/富文本、版本历史/撤销快照、导入导出、全文搜索、拼写检查；
- 人物档案、世界观、剧情时间线、伏笔追踪、AI 续写/改写；
- 跨卷拖拽移动（B1 只支持同卷内上下移与新建时指定卷）；
- 原生窗口逐页走查（自动化与组件测试已覆盖树读取、正文回填、失焦保存与归档只读）。

### 11.5 第三轮关闭/退出与删除安全（2026-11-16）

- **工作台关闭握手**：新增 `workbenchCloseGuard.ts`，通过 Tauri
  `window.onCloseRequested` 在事件回调内**同步** `preventDefault()`，再 await 工作台已注册的
  正文 `workspaceLeaveGuardRef`；成功置 `allowClose` 后调用 `window.close()`，失败保持窗口、
  保留草稿并 Toast。无正文守卫直接放行；重复关闭只执行一轮 flush；监听安装失败会显示
  “工作台关闭保护未启用”，不再静默。
- **应用退出握手**：Rust `exit_handshake.rs` 提供 requestId 状态机（begin/complete/cancel/wait，
  25ms 轮询、5 秒超时、只接受首个匹配回执）；`lib.rs` 的 `request_exit()` 在
  `agents::shutdown_signal::begin()` **之前** `emit app-before-exit` 并 await 回执。失败/超时会
  回滚 `EXIT_REQUESTED`/`EXIT_READY`、emit `app-exit-blocked` 并直接返回，应用保持可用；
  托盘退出、`quit_app`、`RunEvent::ExitRequested` 统一走该路径。前端
  `createAppExitHandler` 复用同一个正文守卫，保存失败回执 false，同 requestId 只处理一次。
- **删除与自动保存协调**：删除统一走 `DeleteTarget` + 现有 Dialog；当前章属于删除目标时，
  “保存后删除”先 await `flush`（含在途请求与最新补交），失败保留对话框与草稿；“丢弃草稿并
  删除”先 `clearTimer()`、置空选择、`settleInFlight()` 等已发请求结束，再删除。删除 IPC 失败
  恢复选择并显示错误；成功后清理选择/草稿/保存状态并递增 `chapterTokenRef`，旧请求不能写新
  界面。`deleteBusyRef` 防重复点击。
- **删除确认信息**：章节显示名称、本章字数、未保存草稿有/无、不可恢复；卷显示卷名、实际章节
  数、正文总字数、是否正在编辑该卷、未保存草稿有/无、级联删除全部章节与正文。按钮为取消 /
  保存后删除 / 必要时“丢弃草稿并删除”。
- **项目切换防线**：`NovelManuscriptPanel` 的 projectId effect 改为 async：先 await flush，
  失败提示“项目切换已取消：正文尚未保存，已保留当前草稿”并保留旧项目状态；成功才清空并
  `loadTree()`；`projectChangeTokenRef` 防旧结果写新项目。`WorkbenchShell.selectProject` 捕获
  守卫抛错并用 `workbench.projectSwitchSaveFailed` 提示后取消切换。
- **测试**：新增 `WorkbenchShell.selectGuard.test.tsx` 改为**真实 WorkbenchShell + 真实
  ProjectWorkspacePanel + 真实 NovelManuscriptPanel**（项目数据 hook 用 mock），覆盖脏稿等待、
  保存失败保留、无脏稿放行、快速两次选择；新增 closeGuard 5 项、exitGuard 6 项；正文组件
  扩到 21 项。Rust 新增 `exit_handshake` 5 项；既有 `novel` 6 项回归全部通过。前端四文件
  36/36；B1 改动后 `tsc --noEmit` 与 `npm run build` 曾 exit 0，最终全工程 `tsc` 被其他任务
  未完成的 `ActionCenterPanel.tsx` JSX 语法错误阻塞（3 个错误，非本轮文件；见验收报告）。
- **未新增 v59**：删除级联、归档写入门禁、跨项目卷门禁均由 v58 外键 + 既有
  `ensure_novel_project` 覆盖，没有重建旧表。

**明确限制**：工作台关闭门禁仍只在前端 `onCloseRequested` 层实现，Rust
`project_workspace_window.rs` 的 `CloseRequested` 不 `prevent_close`；监听未安装或 WebView
无响应时无法保证保存。系统强杀/断电不执行退出握手。应用退出失败只取消退出并提示，未提供
“强制退出（明确丢弃正文）”按钮；用户需先处理保存错误后重新退出。

## 12. 创作工作台五线（B2 / G1 / C1 / U1 / D1，2026-11-16）

五种专业工作空间**不是五套项目管理系统**：项目容器仍是 `workspace_projects`，事项仍是
`workspace_items`，任务关联仍是 `workspace_task_links`，窗口外壳、导航、右栏、Toast 与
关闭/退出握手全部复用 U0 统一工作台。本轮只给每种类型补上「自己那条生产流程」的内容区。

### 12.1 五线并行的文件所有权（防止五线互相覆盖）

公共外壳文件由**集成负责人独占写入**，五条开发线只读：

```
src/workspace/workspaceProfiles.ts        # Profile / 模块清单 / 能力状态
src/workbench/ProjectWorkspacePanel.tsx   # 模块装配点
src/workbench/WorkbenchShell.tsx           # 窗口外壳与导航门禁
src/lib/bridge.ts                          # 通用 IPC 契约
src-tauri/src/lib.rs                       # generate_handler! 注册
src-tauri/src/commands/mod.rs              # 命令模块声明
src-tauri/src/db/mod.rs                    # MIGRATIONS 追加
src-tauri/src/commands/backup.rs           # BACKUP_TABLES / EXTENDED_TABLES 登记
```

每条线独占自己的领域目录与 Rust 领域文件（一对一）：

| 线 | 前端 | 后端 | 迁移 |
|---|---|---|---|
| A 小说 B2 | `src/workbench/creative/novel/` | `commands/novel_workspace.rs` | v59 |
| B 游戏 G1 | `src/workbench/creative/game/` | `commands/game_workspace.rs` | v60 |
| C 漫剧 C1 | `src/workbench/creative/comic/` | `commands/comic_workspace.rs` | v61 |
| D 通用 U1 | `src/workbench/creative/general/` | `commands/general_workspace.rs` | v62 |
| E 开发 D1 | `src/workbench/creative/development/` | `commands/development_workspace.rs` | v63 |

冻结契约写在 `tmp/acceptance/creative-workspaces-v1/contract.md`（含表名、备份
`restore_order` 分段、命令前缀、验收口径）。

### 12.2 模块注册表：壳层与专业模块的唯一接触面

`ProjectWorkspacePanel` 不再为每种类型写一套 `if (kind === ...)`：通用模块
（概览 / 正文 / 事项 / 关联 / 设置）由壳层自己渲染，其余模块按 `kind` 从注册表取实现。

- `src/workbench/creative/types.ts`：`CreativeModuleId` 并集、`CreativeModuleProps`
  （`projectId / kind / archived / rootPath / rootExists / devProjectId / onNotice / switchModule`）
  与 `CreativeModuleMap`；
- `src/workbench/creative/moduleRegistry.ts`：`kind → CreativeModuleMap` 装配点，
  五条线各自导出 `<DOMAIN>_CREATIVE_MODULES`，此处只做 import + 分桶；
- `src/workbench/creative/CreativeModuleHost.tsx`：按 `kind + moduleId` 找实现，
  **找不到就渲染「该模块尚未接入本轮实现」占位**（`role="status"`），不留空白页、不伪造数据。

模块 ID 并集（同一 ID 可在不同类型下各表其义，注册表按 `kind` 分桶）：

| 类型 | 模块顺序 |
|---|---|
| 小说 | 概览 → 正文 → 人物 → 世界观 → 写作事项 → 任务关联 → 项目设置 |
| 游戏 | 概览 → 制作事项 → 游戏资源 → 构建与测试 → 任务关联 → 设置 |
| AI 漫剧 | 概览 → 剧集 → 分镜 → 角色与场景 → 素材与产物 → 任务关联 → 设置 |
| 通用 | 概览 → 阶段与里程碑 → 项目资料 → 事项 → 任务关联 → 设置 |
| 开发 | 概览 → 开发事项 → 仓库与风险 → Agent 接续 → 构建与验收 → 任务关联 → 设置 |

新增模块 ID 必须同时进入 `WorkspaceModuleId` 与 `isModuleId()`，否则布局持久化会把它当非法值
剔除（`workspaceProfiles.test.ts` 有专项断言锁定这一点）。

### 12.3 能力状态必须诚实（四态闸门不变）

`WORKSPACE_CAPABILITIES` 新增本轮专业能力（`game.projectDetect` / `game.test` /
`comic.scripts` / `comic.review` / `general.templates` / `general.milestones` /
`general.materials` / `general.delivery` / `dev.gitRisk` / `dev.taskHandoff` /
`dev.buildTrace`），初始一律 `planned`：模块渲染出可操作入口、且有真实测试证据后，
才由集成负责人升级为 `available` / `limited`。`canInvokeCapability` 对 `planned` /
`unavailable` 返回 false，UI 不得渲染可点击的生成/构建按钮。

跨媒介预留 `core.mediaLink` 只登记、**不进任何 Profile 的 `capabilities`**，
因此即使未来误加 UI 也无法通过 `canInvokeCapability` 闸门。

### 12.4 数据库迁移与备份登记

| 迁移 | 表（表名已冻结） | 备份 restore_order |
|---|---|---|
| v59 | `novel_characters` / `novel_character_relations` / `novel_worldview_entries` / `novel_entity_refs` | 610–618 |
| v60 | `game_project_facts` / `game_assets` / `game_builds` / `game_tests` | 630–636 |
| v61 | `comic_episodes` / `comic_shots` / `comic_characters` / `comic_scenes` / `comic_media_versions` | 650–660 |
| v62 | `general_milestones` / `general_materials` | 680–682 |
| v63 | `dws_task_links` / `dws_workspace_probes` | 700–702 |

与其他迁移的差别（可追溯的架构决定）：DDL 常量放在各领域的
`commands/*_workspace.rs` 里（`MIGRATION_59` … `MIGRATION_63`），
`db/mod.rs` 只在 `MIGRATIONS` 末尾按序引用它们。这样五条线并行开发时**不需要**同时改
`db/mod.rs`——"只能在 `db/mod.rs` 末尾追加"的规则仍然成立，只是每条迁移的 SQL 归属到
领域文件。所有新表全部在 `EXTENDED_TABLES` + `BACKUP_TABLES` 登记（`quick` 全量保存，
创作内容不截断），否则 `backup.rs` 的 schema 覆盖测试会直接失败。

### 12.5 IPC 通道：`creativeInvoke` 与 `bridge.ts` 的关系

五线专业命令**不逐条写进 `src/lib/bridge.ts`**：那里是公共契约文件，五条线并发改必然冲突。
统一走 `src/workbench/creative/ipc.ts` 的 `creativeInvoke<T>(command, args)`——

- 仍然是单一 invoke 出口（禁止组件里直接 `import { invoke }`）；
- 参数 camelCase（Tauri 映射到 Rust snake_case 形参），命令名必须与 `lib.rs`
  `generate_handler!` 登记一致；
- 各领域在自己的 `ipc.ts` 里声明命令名与参数/返回类型，集成负责人负责把命令注册进
  `lib.rs`。这是本轮对「业务 IPC 统一经 bridge.ts」的**范围收敛**，而非另立第二套契约层。

### 12.6 交付状态

（五线实现与验收结果见 `tmp/acceptance/creative-workspaces-v1/` 与各线
`tmp/acceptance/creative-*/report.md`；能力状态以 `workspaceProfiles.ts` 当前声明为准。）

**2026-11-17 V1 最终验收更新（保留上述历史口径，不覆盖）**：

- 五线领域代码在 r13（`3f8eddb`）之后未改动，本轮实质风险集中在公共层；已修复 3 个 P1：
  快速备份写出策略缺 17 张专业表（此前五线 Quick 备份一律 `Err("扩展表缺少备份策略")`）、
  漫剧段扩展表恢复顺序把 `comic_shots` 排在父表 `comic_scenes` 之前（恢复期
  `FOREIGN KEY constraint failed (787)`）、暂存架↔项目关联早于父表（潜在同类风险）。
- 实测：五线 Rust 用例小说 9/9、游戏 9/9、漫剧 7/7、通用 15/15、开发 9/9 全绿；前端
  29/29、10/10、16/16、21/21、7/7 全绿；`cargo test --lib roundtrip` 39 passed；
  CLI Full（43,840 B）/ Quick（44,034 B）**真往返**，17 张表行数/主键/项目归属一致、
  恢复退出码 0、外键违例 0。
- **仍未验证**：真实 Windows 窗口生命周期（关闭/托盘退出/系统退出/正文保存失败阻止关闭/
  在途保存/删章删卷前保存）、五线各 500 条性能、720×600 / 1024×768 / 1440×900 /
  1920×1080 四尺寸适配、NSIS/MSI 首次安装与升级卸载、v58→v63 迁移回放。
- 因此 §12 的整体状态为 **PARTIAL**，不得表述为"V1 正式通过"；完整结论、缺陷清单与
  未完成项见 `tmp/acceptance/creative-workspaces-v1/report.md` §10.6。

## 13. 通用项目资源关联与进度（2026-11-17，后端已接入，前端待接线）

- v69 新增 `workspace_resource_links`，五类 Profile 都可关联现有笔记 ID、Agent 本地会话 ID、
  外部产物绝对路径（文件或目录）。只存关联、标签和备注，原内容仍由原模块/目录持有。
  项目删除只级联删关联；目标删除/离线不自动删关联，读侧 `targetExists=false` 表示当前不可用。
- `workspace_resource_save({projectId,kind,target,label,note})` 返回关联；kind 为
  `note / agent_session / artifact`。同项目/类型/目标重复保存更新标签备注，不新增重复行。
  新笔记/会话必须存在，产物允许暂时离线；归档项目读取允许、写入拒绝。
- `workspace_resource_list({projectId,kind?,offset?,limit?})` 返回
  `{links,total,offset,limit,hasMore}`，默认 50/最大 200，每项目写入上限 2000。
  `workspace_resource_remove({projectId,id})` 仅解除当前项目的关联，不删除目标。
- `workspace_project_progress({projectId})` 返回事项五状态计数与 `itemsPercent`，以及独立的
  `linkedTasksTotal / linkedTasksCompleted / linkedTasksPercent`。事项归档项不参与分母；
  没有数据返回 null 百分比；父子事项按各自真实状态计数，不自动完成父级，不引入人工进度状态。
- 新表登记到完整/快速备份和恢复顺序，旧备份没有该表时为空；升级不修改旧项目。
  旧程序不能保证读取 v69 新库/备份，回退使用升级前备份；IPC 新增，Breaking Change: No。
- 当前只交付后端及桥接，不能据此宣称 UI 已可用。项目笔记编辑仍复用 notes，Agent 会话
  操作仍走原 Agent 模块；新接口只负责关联与事实读取，前端不得自动启动/发送 Agent 消息。

> 2026-11-17 续：上述「前端待接线」为当日早些时候状态，原文保留；前端接入见 §13.1，
> 整体仍按「部分通过」表述，不以预览夹具代替真实后端验收。

### 13.1 2026-11-17 前端接入记录

- **布局串行保存**：`useWorkspaceProjectContext.saveLayout()` 与 `saveModule()` 共用同一条
  `moduleSaveChainRef`；保存前重新 `parseWorkspaceLayout` 归一化。修复了 `stateRef` 与
  `setState` 不同步导致并发 `Promise.all([saveLayout, saveModule])` 丢失 `hiddenModules`
  的竞态（测试首轮暴露，修复后 22/22）。`workspace_instance_save` 省略/null 保留旧布局的
  后端语义由前端原样传递，显式 `{}` 才清空；归档项目只读。
- **布局编辑器**：`src/workspace/ProjectLayoutEditor.tsx` 提供概览固定首位、其余模块上移/
  下移/显隐；保存经 `saveLayout` 返回 `ok | stale | failed`。隐藏当前模块时活动模块回落
  `overview`。`workspaceProfiles.ts` 的 `core.layout` 由 limited 升为 available。
- **进度与资源卡**：`ProjectWorkspaceExtras.tsx` 展示事项五状态与关联任务的**独立百分比**；
  空分母显示「暂无可计算进度」，读取失败保留旧值并标注「可能已过期」。资源按
  `note / agent_session / artifact` 筛选、分页 50、长标签截断、`targetExists=false` 标注
  「当前不可用」；解除关联的确认文案明确「不删除目标」。笔记选择复用 `notesList`，Agent
  会话只读取已有会话快照登记、不启动新会话，产物只登记绝对路径。
- **最小接入边界**：`src/workbench/ProjectWorkspacePanel.tsx` 作为共享枢纽文件只做了最小
  增量（布局按钮/弹层、概览进度卡、设置区资源卡、`success→ok` 的提示映射），未改公共
  IPC 签名、数据库迁移或全局主题。
- **未验证**：真实 Tauri 窗口下的布局保存/资源登记与解除、真实 Agent 会话目标存在性、
  真实产物离线/恢复、归档项目写拒绝的端到端；预览走查使用 CDP 临时夹具，仅证明视觉与
  交互分支，不代表后端真实结果。跨设备项目同步仍未实现。


