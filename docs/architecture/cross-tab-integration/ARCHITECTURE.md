# 技术架构：分层、复用与装配

## 1. 总体结构

```
┌───────────────────────────────────────────────────────────────┐
│ UI 层                                                          │
│  FullView（主窗口）  ── 右侧 TransferPanel                      │
│  WorkbenchShell（工作台） ── 文件工作区工具栏/右键              │
│  各页面只调用 lib/crossTab 与自身 store                        │
└───────────────▲───────────────────────────────┬───────────────┘
                │ 订阅/查询                      │ 命令调用
┌───────────────┴───────────────────────────────▼───────────────┐
│ 跨 Tab Integration Layer（前端，src/lib/crossTab/）             │
│  ActionRegistry  EntityLinkService(facade)  ContextResolver     │
│  IntegrationEventBus   TransferClient（编排、预览、进度）       │
└───────────────▲───────────────────────────────┬───────────────┘
                │ Tauri 事件                     │ invoke
┌───────────────┴───────────────────────────────▼───────────────┐
│ Rust 服务层                                                    │
│  transfer（items/links/batches/context/execute）               │
│  fsops（文件任务调度：copy/move/delete/**write**）              │
│  clipboard（历史/图片缓存）  shelf（暂存架）  planning/tasks…    │
│  SQLite（单一写连接 + 读连接池，WAL）                           │
└───────────────────────────────────────────────────────────────┘
```

## 2. 复用映射：需求里的每项能力实际落在哪

| 需求中提到的能力 | 项目中的真实实现 | 本系统如何使用 |
|---|---|---|
| ClipboardService | `src-tauri/src/clipboard/*`、`clipboard_*` 命令 | 只读引用；图片按 id 取缓存路径；文本按需 `clipboard_item` 读取 |
| FileOperationService | `src-tauri/src/fsops/mod.rs`（Scheduler + JobRegistry）+ `file_workspace` | 新增 `write` 任务类型；复制/移动/删除直接复用 `start_copy/start_move/start_delete` |
| File safety | `file_workspace::validate_abs_path/sanitize_name/Conflict`、`fs_safety` | 所有目标目录与文件名必须经过这些函数 |
| TaskService | `commands/tasks.rs`、`bridge.createTask` | 动作 handler 调用既有 createTask，不新建任务表 |
| ProjectService | `workspace_projects`、`project_hub`、`workspace_task_links`、`shelf_project_links` | 关联走既有表；不复制项目资料 |
| PlanningService | `planning_projects/features/steps` | 规划↔任务关联落 `entity_links`；进度计算仍由 planning 提供 |
| KnowledgeService | `capability::knowledge`（kb/doc/import/search/link/backlink） | 文本建文档、文件导入、关联走既有 `knowledge_links` |
| EventBus | 前端 `createSubscriptionScope` + Tauri `listen` | 新增类型安全 `IntegrationEventBus`；**不**替代后端事件 |
| ContextMenu | `src/components/ui/PointerMenu`（右键）、`DropdownMenu`（下拉） | `SendToMenu` 基于 DropdownMenu；右键菜单复用 PointerMenu |
| DragDrop | `dragPayload.ts` + Rust `dragdrop`（OS 拖入）、`useDropTargetsStore` | P1 采用应用内 HTML5 载荷（`application/x-taskdock-transfer`），不新建 OS 拖拽通道 |
| PanelManager | 无统一实现（各页各自管理右栏/抽屉） | 新增 `panelState.ts`，**只管理全局工作篮**，不接管页面自身右栏 |
| CommandRegistry | `src/lib/commandRegistry.ts`（命令面板，白名单动作） | 不复用其执行白名单；新增 `ActionRegistry` 专管跨模块动作，两者职责不同 |

## 3. 前端服务职责

### 3.1 TransferClient（`transferClient.ts`）

- 唯一允许调用 `transfer_*` 命令的前端模块；
- 负责把 UI 请求转成「预览 → 执行 → 轮询进度 → 汇总结果」；
- 不做 UI 文案以外的业务判断；权限/合法性由后端与 `ActionRegistry` 双重校验。

### 3.2 ActionRegistry（`actionRegistry.ts`）

动作定义：

```ts
interface ActionDefinition {
  actionId: string;                 // "files.saveAsText"、"tasks.createFromItem"
  moduleId: string;                 // 注册方
  titleKey: string;
  descriptionKey?: string;
  supportedItemTypes: TransferItemType[] | "*";
  sourceModules: TransferSourceModule[] | "*";
  targetModule?: TransferTargetModule;
  relation?: EntityRelation;
  permission?: "read" | "write" | "dangerous";
  confirmation?: "none" | "confirm" | "dangerous";
  availability?: (ctx) => ActionAvailability;   // { enabled, reasonKey }
  handler: (req) => Promise<ActionResult>;
}
```

- `actionId` 全局唯一，重复注册抛错（不静默覆盖）；
- `getActions(context)` 只返回**当前内容与当前上下文**下可用的动作，含不可用原因；
- `executeAction` 先 `validate`，再 `canExecute`，最后执行；handler 抛错统一转
  `{ ok:false, code, message }`，不吞异常。

### 3.3 ContextResolver / useCrossTabStore

- 当前模块、项目、任务、目录、规划条目、知识条目；
- 目录/项目/任务由对应页面在「用户明确进入」时写入（文件工作区打开目录、任务详情打开），
  不在切 Tab 时自动改写；
- 跨窗口共享由 Rust `TransferContext` 承担（`transfer_context_set` 广播），前端 store 订阅；
- `resolveTargetForItem(item, ctx)` 是纯函数：给定内容类型与上下文，返回推荐目标与理由，
  不产生副作用。

### 3.4 EntityLinkService（`entityLinks.ts`）

统一门面，按实体对路由到既有存储：

| 源 → 目标 | 落点 |
|---|---|
| knowledge ↔ task / project / file / note | `knowledge::add_link_impl`（`knowledge_links`） |
| shelf item ↔ task / project | `shelf::link_task/link_project` |
| workspace project ↔ task | `workspace_task_link_add` |
| 其他（planning ↔ task、planning ↔ project、capture ↔ project、task ↔ file 等） | `entity_links` |
| 文件引用（task/project ↔ 文件路径） | `entity_links`（`target_type=file`，`target_id=规范化路径`） |

读取 `getLinks(entity)` 会合并上述来源并统一成 `EntityLink` 形状；`relation` 保留原表语义。

### 3.5 IntegrationEventBus

- 仅用于**通知**（UI 刷新、统计），不作为业务成功判据；
- 事件类型联合类型固定，载荷按类型映射；
- `publish` 内同步分发，深度超过 8 层判定为循环并丢弃 + 记一次诊断（不递归爆栈）；
- 每个页面/组件用 `bus.createScope(moduleId)` 订阅，卸载时 `dispose()` 一次性退订；
- 重复订阅检测：同一 `(moduleId, type, handler)` 只保留一个。

## 4. Rust 服务职责

### 4.1 transfer 模块

| 文件 | 职责 |
|---|---|
| `store.rs` | 工作篮条目 CRUD、去重、内容分级存储、排序（REAL sort_order）、状态迁移 |
| `batches.rs` | 批次记录、逐条结果、重试、撤销信息（创建文件路径） |
| `execute.rs` | 目标=文件工作区的预览与执行：分类、命名、冲突、分批提交 fsops |
| `context.rs` | 跨窗口上下文（`Mutex<TransferContext>` + `emit("transfer:context-changed")`） |
| `links.rs` | 通用实体关联的校验/写入/查询/去重 |

### 4.2 fsops 的扩展点

新增 `start_write`：

- 输入：`target_dir`、`conflict`、`entries[{fileName, text?, sourcePath?}]`、`operationId`；
- 校验：目录存在且可写（`validate_dir`）、文件名 `sanitize_name`、目标必须在允许范围内
  （禁止写入应用数据目录、盘符根、`..` 穿越）；
- 冲突：`skip` / `rename` / `overwrite`（overwrite 用同目录临时文件 + rename）；
- 进度：与 copy/move 共用 `JobSnapshot`，逐条 `FsEntryReport`（含目标路径）；
- 取消：条目之间检查；运行中的单文件不中断；
- 报告：`FsOpReport` 存于 JobHandle，`fs_job_report` 可查（撤销依赖 target 列表）。

### 4.3 事件

| 事件名 | 载荷 | 发出方 |
|---|---|---|
| `transfer:changed` | `{ reason, ids? }` | transfer store 写入后 |
| `transfer:context-changed` | `TransferContext` | context set/clear |
| `transfer:batch-progress` | 批次快照（含 fsops job 聚合） | execute / 轮询 |
| `recycle:job-progress` | `JobSnapshot` | fsops（既有） |

前端不直接依赖 `recycle:job-progress` 做业务判断；它只驱动进度条，最终结果由
`transfer_batch_report` 返回。

## 5. 模块装配与扩展

- 唯一装配点：`src/lib/crossTab/modules/index.ts` 的 `installCrossTabModules()`；
  在 App 挂载时调用一次（幂等）。
- 每个模块适配器导出 `register()`，内部只做三件事：注册动作、注册事件转发（如需）、
  在页面进入时写上下文。
- 新增 Tab 不需要改 `FullView`：面板与菜单都从 `ActionRegistry` 动态生成。

## 6. 已知取舍

1. **工作台与主窗口是两个 WebView**：面板只挂在主窗口。工作台内的「发送到当前页面」
   依赖 `TransferContext` 中的目录，而不是工作台 React 状态。
2. **应用内拖拽暂不做跨窗口**（OS 级拖拽跨窗口需另建通道）。P0 用菜单/按钮；
   P1 在同一窗口内启用 HTML5 载荷。
3. **智能推荐只做规则排序**（最近使用 + 当前项目/任务 + 类型匹配），不引入模型。
