# 接口规范：命令、服务方法与错误

约定：

- Rust 命令参数用 **camelCase**（`#[tauri::command]` 参数名即前端 key）；
- 返回结构统一 `serde(rename_all = "camelCase")`；列表字段沿用仓库既有风格（工作篮新表
  全部 camelCase）；
- 错误：`AppError` 统一结构，`code` 为稳定字符串（`validation` / `not_found` /
  `conflict` / `permission` / `io` / `unknown` + 业务码）；
- 所有写操作成功后必须**同步返回真实结果**，前端不得以事件判断成功。

## 1. Rust 命令（`commands/transfer.rs`）

### 1.1 条目

```rust
transfer_list_items(filter: TransferFilter) -> TransferPage
// filter: { itemTypes?: string[], sourceModules?: string[], status?: string,
//           search?: string, pinnedOnly?: bool, limit?: u32 (≤200), offset?: u32 }
// page:   { items: TransferItem[], total: i64 }

transfer_get_item(id: String) -> TransferItem   // content 已解析（含 content_ref）
transfer_add_items(inputs: Vec<TransferItemInput>) -> TransferAddReport
// input: { itemType, sourceModule, sourceId?, title?, description?,
//          content?, payloadJson?, pinned? }
// report:{ items: TransferItem[], duplicates: usize, rejected: Vec<{title, code, message}> }
transfer_update_item(id: String, patch: TransferItemPatch) -> TransferItem
// patch: { title?, description?, content?, pinned?, status? }（status 只允许 ready/expired）
transfer_remove_items(ids: Vec<String>) -> TransferRemoveReport  // { removed: usize }
transfer_reorder_items(ids: Vec<String>) -> ()                  // 按给定顺序重写 sort_order
transfer_pin_item(id: String, pinned: bool) -> TransferItem
transfer_clear_temporary() -> TransferRemoveReport              // 只清 ready/expired 且非 pinned
transfer_counts() -> { total: i64, ready: i64, failed: i64, pinned: i64 }
```

错误：

| 场景 | code | 行为 |
|---|---|---|
| 类型非法 | `validation` | 拒绝整条，写入 `rejected`，其余条目继续 |
| 重复（去重键命中未发送条目） | 无错误 | 返回已存在条目，计入 `duplicates` |
| 正文超过 512KB | `TRANSFER_CONTENT_TOO_LARGE` | 拒绝该条并提示「另存为文件」 |
| 条目不存在 | `not_found` | 更新/删除返回错误 |

### 1.2 目标校验与预览

```rust
transfer_validate_target(target: TransferTarget) -> TargetValidation
// target: { module: string, ref?: string }
// validation: { valid: bool, message: string, displayName: string }
// 目录目标：存在 + 是目录 + 可写（尝试创建临时文件后立即删除，不写入用户数据）

transfer_preview(itemIds: Vec<String>, target: TransferTarget) -> TransferPreview
// preview: {
//   targetModule, targetRef, targetValid, targetMessage,
//   counts: { text, richtext, image, file, directory, url, clipboard, entity, unsupported },
//   plannedFiles: usize, conflicts: Vec<{name, resolution}>,
//   unsupported: Vec<{itemId, title, reason}>,
//   warnings: Vec<String>, moveRemovesSources: usize, estimatedBytes: i64
// }
```

### 1.3 执行（目标 = 文件工作区）

```rust
transfer_execute(app, clipboard, itemIds: Vec<String>, target: TransferTarget,
                 options: TransferOptions) -> TransferBatch
// target:  { module: "files", ref: "<绝对目录>" }
// options: { conflict: "skip"|"rename"|"overwrite",
//            textFormat: "txt"|"md", textMode: "separate"|"merge",
//            fileOperation: "copy"|"move", urlMode: "url"|"markdown" }
```

行为：

1. 校验目录（`validate_abs_path` + `validate_dir`），不合格直接 `validation`；
2. 读取条目，解析文本/图片/文件引用；引用失效的条目记 `failed(TRANSFER_SOURCE_MISSING)`；
3. 生成计划（文件名清洗 + 冲突策略），写入 `transfer_batches.plan_json`；
4. 提交 fsops：
   - `write` 任务：文本/HTML/URL 生成的文本文件、图片（源=剪贴板 PNG 缓存）；
   - `copy` 或 `move` 任务：文件/目录引用；
5. 批次状态 `running`，返回 `TransferBatch`（含 `jobIds`）。

**并发控制**：由 fsops 统一排队（2 个 worker、最多 32 个待执行任务）；一次工作篮发送
最多产生 2 个任务（write + copy/move），不出现无界 `Promise.all`。

### 1.4 批次查询 / 取消 / 撤销

```rust
transfer_batch_get(batchId: String) -> TransferBatch
// batch: { id, targetModule, targetRef, operation, status, total, ok, failed, skipped,
//          jobIds, entries: [{ itemId?, label, status, code?, message?, target? }],
//          undo: { state: "available"|"used"|"unavailable", reason? },
//          createdAt, updatedAt, message? }

transfer_batch_cancel(batchId: String) -> bool      // 逐个 fs_job_cancel
transfer_batch_undo(batchId: String) -> BatchUndoResult
// 仅 write/copy 且未覆盖时可用：把已创建的目标文件移入回收站（可再恢复）
// move 与 overwrite 一律返回 undo.state=unavailable，理由写入 reason
```

### 1.5 上下文（跨窗口）

```rust
transfer_context_get() -> TransferContext
transfer_context_set(patch: TransferContextPatch) -> TransferContext
transfer_context_clear() -> TransferContext
// context: { module, projectId, taskId, directory, planningId, knowledgeId,
//            updatedAt, source: "user"|"auto" }
```

- `module` 只接受白名单（`files` `tasks` `projects` `planning` `knowledge` `clipboard`
  `capture` `resource` `shelf` `mobile` `home`）；
- `directory` 若非空必须通过 `validate_abs_path`（不要求存在，失效由消费者提示）；
- 写入后 `app.emit("transfer:context-changed", context)`（广播到所有窗口）。

### 1.6 实体关联

```rust
transfer_link_create(input: EntityLinkInput) -> EntityLink
transfer_link_remove(linkId: String) -> bool
transfer_link_list(entityType: String, entityId: String) -> Vec<EntityLink>
transfer_link_related(entityType: String, entityId: String) -> Vec<RelatedEntity>
// related: { linkId, entityType, entityId, relation, label, stale?: bool }
```

- 类型白名单：`task` `workspace_project` `planning_project` `planning_feature`
  `planning_step` `knowledge_doc` `capture` `shelf_item` `clipboard_item` `file`；
- `file` 的 id 必须是规范化绝对路径；
- 重复关联幂等（唯一索引）；
- `parent` 只允许 `planning_step → planning_feature`、`* → planning_project` 两类方向，
  其他方向返回 `validation`（防止形成环）。

## 2. 前端服务（`src/lib/crossTab/`）

### 2.1 `transferClient`

```ts
listItems(filter): Promise<TransferPage>
getItem(id): Promise<TransferItem>
addItems(inputs): Promise<TransferAddReport>
updateItem(id, patch): Promise<TransferItem>
removeItems(ids): Promise<{ removed: number }>
reorderItems(ids): Promise<void>
pinItem(id, pinned): Promise<TransferItem>
clearTemporary(): Promise<{ removed: number }>

validateTarget(target): Promise<TargetValidation>
preview(itemIds, target): Promise<TransferPreview>
executeTransfer(req): Promise<TransferBatch>       // 按 target.module 分发
copyToTarget(itemIds, target): Promise<TransferBatch>
moveToTarget(itemIds, target): Promise<TransferBatch>
retryFailed(batchId): Promise<TransferBatch>       // 只重跑失败条目
cancelBatch(batchId): Promise<boolean>
undoBatch(batchId): Promise<BatchUndoResult>
getBatch(batchId): Promise<TransferBatch>
```

### 2.2 `actionRegistry`

```ts
registerAction(def: ActionDefinition): void        // 重复 actionId 抛错
unregisterAction(actionId): void
getActions(ctx: ActionContext): ActionView[]      // { def, enabled, reasonKey? }
getAction(actionId): ActionDefinition | undefined
canExecute(actionId, ctx): ActionAvailability
executeAction(actionId, req): Promise<ActionResult>
```

`ActionResult = { ok: true, value?: unknown } | { ok: false, code: string, message: string }`

### 2.3 `contextResolver` / `useCrossTabStore`

```ts
getCurrentContext(): TransferContext
getCurrentModule(): string
getCurrentProject(): string | null
getCurrentTask(): string | null
getCurrentDirectory(): string | null
getCurrentTarget(): TransferTarget | null
setModule(module): void
setProject(id | null): void
setTask(id | null): void
setDirectory(path | null): Promise<void>       // 同时 sync 到 Rust，跨窗口可见
clearTemporaryContext(): Promise<void>
resolveTargetForItem(item, ctx): { target: TransferTarget; reasonKey: string } | null
```

### 2.4 `entityLinks`

```ts
createLink(source, target, relation, label?): Promise<EntityLink>
removeLink(link): Promise<void>
getLinks(entity): Promise<EntityLink[]>
getRelatedEntities(entity): Promise<RelatedEntity[]>
```

内部按 [ARCHITECTURE.md](ARCHITECTURE.md) §3.4 路由到既有表；对知识/暂存架/项目任务
关联使用既有命令，其余使用 `transfer_link_*`。

### 2.5 `eventBus`

```ts
publish<K extends IntegrationEventType>(type: K, payload: IntegrationEventMap[K]): void
subscribe<K>(type: K, handler, moduleId): string
unsubscribe(id): void
unsubscribeModule(moduleId): void
createScope(moduleId): { add(fn): void; dispose(): void }
```

## 3. 错误码

| 码 | 含义 | 前端处理 |
|---|---|---|
| `TRANSFER_TARGET_INVALID` | 目标目录不可用 | 停留预览，要求重选 |
| `TRANSFER_TARGET_NOT_DIR` | 目标是文件 | 同上 |
| `TRANSFER_TARGET_FORBIDDEN` | 目标在保护区（应用数据/盘符根） | 拒绝并说明 |
| `TRANSFER_SOURCE_MISSING` | 条目来源失效（文件删除/剪贴板清理） | 标记 `expired`，可移除 |
| `TRANSFER_CONTENT_TOO_LARGE` | 正文超限 | 提示另存为文件 |
| `TRANSFER_TARGET_UNSUPPORTED` | 该目标不支持此操作 | 菜单中不展示该动作 |
| `TRANSFER_BATCH_NOT_FOUND` | 批次不存在 | 刷新列表 |
| `TRANSFER_UNDO_UNAVAILABLE` | 该批次不可撤销 | 展示原因，不假装成功 |
| `FS_OP_CONFLICT` / `FS_OP_ACCESS_DENIED` / `FS_OP_FILE_BUSY` / `FS_OP_IO` | fsops 逐条错误 | 原样展示在失败清单 |
