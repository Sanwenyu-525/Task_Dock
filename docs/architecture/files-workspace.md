# 文件工作区技术架构与数据模型

- 日期：2026-11-18
- 阶段：Phase 1 开发前基线（方案冻结前的现状 + 目标架构）
- 功能台账：[docs/features/files-workspace.md](../features/files-workspace.md)
- 既有实现细节：[docs/ARCHITECTURE.md 文件工作区章节](../ARCHITECTURE.md)、
  [docs/files-workspace-marquee-selection.md](../files-workspace-marquee-selection.md)

> 本文只描述架构、边界、接口与数据模型；功能状态与验收结论分别见功能台账与验收矩阵。
> 任何实现与本文冲突时，以代码为准并更新本文。

---

## 1. 现状架构（事实）

### 1.1 分层与所有权

```
React UI（src/components/files/*）
  ├─ FilesWorkspacePanel.tsx   外壳：工具栏/布局/拖拽协调/冲突对话/各对话框
  ├─ FilePane.tsx              单窗格：标签栏/面包屑/筛选/选择条/右键菜单/属性
  ├─ FileList.tsx              列表与网格：虚拟化、框选、滚动锚点
  └─ 对话框                    BatchRename / QuickPreview / DuplicateFinder /
                               FolderCompare / WorkspaceSearch / RecycleWorkspaceView
        │
        ▼
前端领域层（src/lib/filesWorkspace/*）
  ├─ model / layoutTransfer / persist      布局树、容量分配、持久化
  ├─ dirCache / volumeCache                目录缓存、真实卷键
  ├─ select 相关：marqueeSelection         框选几何与选择合并
  ├─ interactions / fileDrop / transfer    应用内拖拽、外部投递、冲突探测
  ├─ operationQueue / fileJobs / opReport  前端队列视图、后端任务订阅、报告聚合
  ├─ workspaceSearch / folderCompare       递归搜索、重复候选、目录对比
  ├─ batchRename / folderPicker / pathUtils
  └─ fileMeta / fileTypeUi / fsOpFeedback
        │
        ▼
IPC 桥（src/lib/bridge.ts）
  fs_* / recycle_* / mobile_file_* / shelf_*
        │
        ▼
Rust 后端（src-tauri/src/）
  ├─ file_workspace/       路径校验、列目录分页、复制/移动/删除、预览、缩略图、卷
  ├─ fsops/                统一任务队列（复制/移动/删除/重命名/回收站恢复/清空）
  ├─ recycle/              回收站索引、扫描、Shell 恢复/清空
  ├─ shelf/                暂存架（文件引用/托管副本）
  └─ mobile_sync/          局域网配对与文件互传
        │
        ▼
SQLite（db/mod.rs MIGRATIONS 末尾追加） + 设置键 file_workspace_layouts
```

- **唯一 Store**：`src/store/useFilesWorkspaceStore.ts`（树、标签、选择、收纳、固定/最近目录、
  布局撤销栈、持久化键）。目录列表数据不放进 Store，而在 `dirCache` 按路径缓存。
- **唯一布局持久化键**：`file_workspace_layouts`（`ALLOWED_KEYS` 注册；states≤8、模板≤20、
  ≤256KB）。不写 `workbench_layout` / `navigation_layout` / `workspace_instances.layout_json`。
- **唯一文件 mutation 通道**：`bridge.ts` → Tauri 命令 → `file_workspace` / `fsops`。
  UI 不直接调用 Win32；`fs_open/fs_reveal` 是只读系统动作。
- **唯一回收站通道**：`recycle_*` 命令；普通文件工作区不得直接操作 `$Recycle.Bin`。
- **唯一暂存架**：`shelf` 模块；文件工作区只调用 `shelf_add_paths` 与接收 `taskdock-fw-deliver`。
- **唯一设备传输**：`mobile_sync` + `mobile_files` 表；不新建协议。

### 1.2 现有 IPC 契约（摘要）

| 域 | 命令 | 说明 |
|---|---|---|
| 列目录/元数据 | `fs_list_dir`、`fs_dir_signature`、`fs_places`、`fs_stat`、`fs_volume_keys` | `fs_list_dir` 的 `offset` 是绝对磁盘序；`nextOffset` 才可翻页（r6 冻结） |
| 创建/重命名 | `fs_create_dir`、`fs_create_file`、`fs_rename`、`fs_batch_rename` | 名称清洗、冲突策略显式 |
| 复制/移动/删除 | `fs_copy_paths`、`fs_move_paths`、`fs_delete_paths` | 逐条报告；删除默认回收站 |
| 任务 | `fs_copy_job_start`、`fs_move_job_start`、`fs_delete_job_start`、`fs_job_status`、`fs_job_cancel`、`fs_job_report`、`fs_batch_rename_job_start` | 事件 `recycle:job-progress`；轮询 100ms 节流 |
| 预览 | `fs_preview_image`、`fs_read_text`、`fs_preview_media_url`、`fs_release_preview_url`、`fs_thumbnail` | 短期 token + Range；只读 |
| 系统 | `fs_open`、`fs_reveal`、`fs_drag_out` | 只读/系统动作 |
| 回收站 | `recycle_stats/list/sync/sync_status/sync_cancel/restore/purge/empty` | 索引只是缓存，Shell 为准 |
| 手机文件 | `mobile_file_list/offer/delete/reveal/open_inbox/import_shelf/thumbnail` | 文件本体在 `data_dir/mobile_files` |
| 暂存架 | `shelf_add_paths`、`shelf_paste_current`、`shelf_move_items`、`shelf_copy_to`、`shelf_drop_to_directory` 等 | 引用/托管两种模式 |

### 1.3 现有安全边界（不可破坏）

1. 只接受绝对路径；`normalize_lexical` 处理 verbatim/UNC/`.`/`..`，盘符与 UNC server/share
   为不可越过基底；设备路径 `\\.\` 拒绝。
2. `real_path` 防 junction/symlink 绕过保护目录；`is_under` 分量边界比较。
3. 受保护目录（应用数据目录）拒绝删除/移动/复制的源或目标。
4. 删除默认回收站；永久删除独立命令语义，重解析点不跟随，深度 64/总量 20 万上限。
5. 目录复制/移动有界递归；父目录优先去重；自引用/子目录投递拒绝；跨卷回退复制+删除。
6. 冲突策略必须显式给定，绝不静默覆盖；报告逐条 ok/failed/skipped/partial。
7. 文件剪贴板是 TaskDock 内部状态，不写系统剪贴板；外部 OS 拖入恒复制。
8. 预览只读；文本最多 2 MiB；二进制拒绝；媒体 token 有界并显式释放。
9. 诊断/事件不记录文件正文、完整路径列表或用户敏感内容（报告只给 label/计数/错误码）。

---

## 2. 目标架构

### 2.1 原则

1. **不推倒重来**：保留现有布局树、dirCache、fsops、recycle、shelf、mobile_sync。
2. **新增薄 facade，不造第二套实现**：`FileWorkspaceService` 组合既有模块，UI 只依赖 facade；
   高风险 mutation 不得再从组件直接调用 `bridge`。
3. **唯一状态源**：运行中的文件任务以 Rust `JobRegistry` 为准；前端 `fileJobs` 只做订阅与视图。
   收藏/集合/标签/自动化等持久化数据以 SQLite 为准；Store 只缓存。
4. **所有高风险操作走预演**：delete/move/overwrite/archive/automation 必须先
   `previewFileOperation`（或明确豁免并记录原因）。
5. **可取消、有上限、可回收**：搜索/扫描/自动化/传输都有取消、预算、终态清理。

### 2.2 目标模块图

```
src/components/files/
  FilePane / FileList / FilesWorkspacePanel（保留）
  FileToolbar / FileBreadcrumb / FileSearchBar / FileFilterPanel   （可从 FilePane 拆出）
  FileDetailsPanel（新） / FileOperationQueue（现有 OperationQueueBar）
  FileOperationPreviewDialog（新） / FileContextMenu（可从 FilePane 抽出）
        │
        ▼
src/lib/filesWorkspace/
  service.ts                 facade：navigation/selection/clipboard/ops/search/filter/
                             favorites/collections/tags/archive/automation/transfer
  navigation.ts             （新）每标签历史与路径输入
  selection.ts              （新）选择 facade + marquee 适配
  clipboard.ts              （新）FileClipboardPayload、TTL、源窗格
  operations.ts             （新）fsops 任务 wrapper、重试/暂停/恢复
  operationPreview.ts       （新）计划、冲突、无权限、重复、字节统计
  operationHistory.ts       （新）撤销/重做与可逆判定
  search.ts                 （新）搜索会话与范围
  filters.ts                （新）统一 FileFilter 模型与预设
  favorites.ts              （新）收藏/分组/排序
  collections.ts            （新）收藏集
  tags.ts                   （新）TaskDock 文件标签
  archive.ts                （新）压缩/解压 IPC wrapper
  automation.ts             （新）规则 CRUD/预演/执行/日志
  deviceTransfer.ts         （新）配对设备/传输状态
  activity.ts               （新）TaskDock 观测时间线
  relations.ts              （新）文件关系（白名单解析器）
  （现有模块保持不变，按需被 facade 调用）
        │
        ▼
src/store/useFilesWorkspaceStore.ts（唯一 Store；新增字段见 §3）
        │
        ▼
src/lib/bridge.ts（新增命令；既有命令签名不变）
        │
        ▼
src-tauri/src/
  file_workspace/           + plan.rs（预演）/ metadata.rs / activity.rs / archive/（或独立模块）
  fsops/                    + 字节进度、速度、ETA、当前项、pause/resume/retry、compress/extract
  recycle/                  不变（仅复用）
  shelf/                    不变（仅复用）
  mobile_sync/              不变（仅复用）
  db/mod.rs                 MIGRATIONS 末尾追加新表（不修改已发布迁移）
```

### 2.3 `FileWorkspaceService` 边界

- 只做**编排与类型收敛**，不持有 React 状态，不直接操作 DOM。
- 方法按域分组；UI 可以只导入需要的子模块，但跨域业务流程（如「暂存→预演→执行→历史」）
  必须走 facade，避免组件各自拼 IPC。
- 只读动作（列目录、统计、预览 URL）可继续由 `dirCache` / 组件调用 bridge；**写操作**
  （copy/move/delete/rename/archive/automation/tag/collection）必须经 facade。
- facade 不吞错：返回 `Result` 风格（`{ ok, report, error }`）或抛出已分类错误，由 UI 显示。
- 不在 facade 内做 `setTimeout` 重试；取消/超时由底层任务或显式 AbortController 承担。

---

## 3. 数据模型

### 3.1 前端核心类型（目标）

```ts
type FileClipboardPayload = {
  operation: "copy" | "cut";
  items: string[];              // 规范化绝对路径
  sourcePaneId?: string;
  createdAt: number;
};

type FileOperationProgress = {
  operationId: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  totalItems: number;
  completedItems: number;
  totalBytes: number;
  completedBytes: number;
  speedBytesPerSecond: number;
  estimatedRemainingMs?: number;
  currentItem?: string;         // 仅展示名，不写完整路径到事件
  error?: { code: string; message: string; retryable: boolean };
};

type FileOperationPreview = {
  id: string;
  effect: "copy" | "move" | "delete" | "archive" | "extract";
  itemsToProcess: number;
  bytesToProcess: number;
  conflicts: FileConflict[];
  inaccessible: string[];
  duplicates: string[];
  overwrittenItems: string[];
  warnings: { code: string; message: string }[];
};

type FileOperationHistory = {
  id: string;
  operation: "copy" | "move" | "rename" | "delete" | "archive" | "extract";
  sourceItems: string[];
  targetPath?: string;
  timestamp: number;
  reversible: boolean;
  inverse?: { operation: string; items: unknown };
};

type WorkspaceFolderState = {
  id: string;
  path: string;
  label: string;
  role?: "source" | "assets" | "documents" | "build" | "export" | "reference" | "cache" | "custom";
  viewMode: "list" | "grid";
  sortField: "name" | "modified" | "type" | "size";
  sortAsc: boolean;
  filter: FileFilter;
  scrollPosition: number;
  selectedItems: string[];
};

type FileFilter = {
  kinds: string[];
  extensions: string[];
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
  name?: string;
  includeHidden: boolean;
  includeFolders: boolean;
};

type FileSearchQuery = {
  text?: string;
  extensions?: string[];
  types?: string[];
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
  includeHidden?: boolean;
  scope: "pane" | "workspace" | "project" | "favorites";
  maxDepth?: number;
  maxResults?: number;
  maxDirs?: number;
};
```

### 3.2 Store 扩展（不建第二个 Store）

在 `FilesWorkspaceState` 追加（按需分阶段）：

```ts
clipboard: FileClipboardPayload | null;
favorites: FavoriteItem[];
favoriteGroups: FavoriteGroup[];
recentPaths: RecentPath[];              // 与现有 recentDirs 迁移对齐
filters: Record<string, FileFilter>;    // 按 tabId
filterPresets: FileFilterPreset[];
workspaceFolders: WorkspaceFolderState[];
collections: FileCollection[];
tags: Record<string, string[]>;          // 只做缓存，持久化在 DB
searches: FileSearchSession[];           // 只保留活跃/最近会话
operations: FileOperationProgress[];     // 视图缓存，权威在 Rust JobRegistry
operationHistory: FileOperationHistory[];// 只读历史缓存
deviceTransfers: DeviceFileTransfer[];
automations: FileAutomation[];
```

- 现有 `pinnedDirs` **迁移**为 `favorites(kind="folder")`；迁移后不再并行维护两套。
- `selection` 保持现有 `Record<paneId, {paths, anchor}>`；不复制到新字段。
- 运行中任务不放入 Store 持久化；刷新/重启后以 `fs_job_status` 查询，进程退出即丢失（如实）。

### 3.3 SQLite 表（新增，全部追加迁移）

> 命名暂定，落地前在 `db/mod.rs` 末尾追加并登记 `BACKUP_TABLES`；路径键统一
> `COLLATE NOCASE` 并保存规范化绝对路径；不存文件正文。

| 表 | 用途 | 关键字段 |
|---|---|---|
| `file_workspace_folders` | 工作区目录注册 | `id, path, label, role, sort_order, created_at` |
| `file_favorites` | 收藏（文件/目录） | `id, path_key, kind, name, group_id, sort_order, created_at` |
| `file_favorite_groups` | 收藏分组 | `id, name, sort_order` |
| `file_recent_paths` | 最近访问 | `path_key, kind, last_used_at`（有界清理） |
| `file_filter_presets` | 筛选预设 | `id, name, filter_json, sort_json, created_at` |
| `file_tags` | TaskDock 文件标签 | `path_key, tag, color, created_at, updated_at` |
| `file_collections` | 虚拟收藏集 | `id, name, created_at` |
| `file_collection_items` | 集合条目 | `collection_id, path_key, added_at`，唯一键 |
| `file_operation_history` | 可撤销操作 | `id, operation, source_json, target_path, reversible, inverse_json, created_at` |
| `file_activity_events` | TaskDock 观测时间线 | `id, path_key, kind, operation_id, at`（有界） |
| `file_automations` | 自动化规则 | `id, name, enabled, trigger_json, conditions_json, actions_json, last_run_at` |
| `file_automation_logs` | 自动化日志 | `id, automation_id, status, detail, at` |
| `project_folders` | 项目多目录 | `project_id, folder_id, path, role, sort_order` |
| `file_relations` | 可靠解析的文件关系 | `from_path, to_path, kind, parser, confidence, updated_at` |

- 回收站继续使用 `recycle_index/recycle_volume_state/recycle_restored_metadata`（已存在）。
- 手机文件继续使用 `mobile_files`（已存在）。
- 暂存架继续使用 `shelf_items/shelf_groups/shelf_task_links`（已存在）。
- 布局**不**迁入 DB：继续使用设置键 `file_workspace_layouts`（公开契约）。

---

## 4. 函数级实现清单

> 标注：`现有` = 已有函数/模块；`新增` = 本轮计划新增；`扩展` = 在现有函数上追加参数/分支。
> 文件路径以当前仓库为准，新增文件在落地时创建。

### 4.1 导航与选择

| 目标函数 | 实现位置 | 方式 |
|---|---|---|
| `getPanePath(paneId)` | `lib/filesWorkspace/navigation.ts` | 新增（读 Store） |
| `setPanePathInput / commitPanePathInput / cancelPanePathInput` | 同上 + `FilePane.tsx` | 新增（把组件内 `pathEdit` 上移） |
| `navigatePaneToPath / Back / Forward / Up` | `navigation.ts` | 新增（包 `store.navigate/openInPane`） |
| `getPaneNavigationHistory / clearPaneNavigationHistory` | `navigation.ts` | 新增 |
| `canNavigateBack/Forward/Up` | `navigation.ts` | 新增 |
| `getSelectedItems / setSelectedItems / add / remove / clear / selectAll` | `lib/filesWorkspace/selection.ts` | 新增（薄封装 Store） |
| `begin/update/commit/cancelMarqueeSelection` | `selection.ts` + `marqueeSelection.ts` | 扩展 facade |
| `openInPane / navigate / splitPane / ...` | `useFilesWorkspaceStore.ts:195-278` | 现有 |

### 4.2 文件剪贴板与操作

| 目标函数 | 实现位置 | 方式 |
|---|---|---|
| `getFileClipboard / setFileClipboard / clearFileClipboard / hasClipboardItems / getClipboardOperation` | `lib/filesWorkspace/clipboard.ts` | 新增（包装 `interactions.ts:269-276`） |
| `copySelectedFiles / cutSelectedFiles` | `clipboard.ts` + `FilesWorkspacePanel.tsx` | 新增 |
| `canPasteFiles / pasteFiles` | `clipboard.ts` + `transfer.ts` | 新增 |
| `enqueueFileOperation / startFileOperation` | `lib/filesWorkspace/operations.ts` | 新增（包 `fileJobs.ts` / bridge） |
| `pauseFileOperation / resumeFileOperation` | `operations.ts` + Rust `fsops` | 新增（后端能力） |
| `cancelFileOperation / retryFileOperation` | `operations.ts` | 扩展（现有 cancel） |
| `getFileOperation / getFileOperations` | `operations.ts` | 新增 |
| `previewFileOperation / confirm / cancelPreview` | `lib/filesWorkspace/operationPreview.ts` + Rust `file_workspace/plan.rs` | 新增 |
| `resolveFileConflict / resolveAllFileConflicts` | `operationPreview.ts` / `operations.ts` | 新增（后端 conflict 策略扩展） |
| `canUndoFileOperation / getUndoableOperations / undo / redo` | `lib/filesWorkspace/operationHistory.ts` + Rust | 新增 |
| `fsCopyPaths / fsMovePaths / fsDeletePaths` | `bridge.ts:5830-5838` | 现有（保留兼容） |
| `fsCopyJobStart / fsMoveJobStart / fsDeleteJobStart / fsJobStatus / fsJobCancel / fsJobReport` | `bridge.ts:6056-6080` | 现有（扩展字段） |

### 4.3 搜索、筛选、信息与预览

| 目标函数 | 实现位置 | 方式 |
|---|---|---|
| `searchFiles / searchPaneFiles / searchWorkspaceFiles / searchProjectFiles` | `lib/filesWorkspace/search.ts` | 新增（包 `workspaceSearch.ts:94`） |
| `startFileSearch / updateFileSearch / cancelFileSearch / getFileSearchStatus / getFileSearchResults` | `search.ts` | 新增（会话 + AbortController） |
| `setPaneFileFilter / clearPaneFileFilter / getPaneFileFilter` | `lib/filesWorkspace/filters.ts` | 新增（兼容 `FolderTab.filter`） |
| `saveFileFilterPreset / update / delete / apply` | `filters.ts` + DB | 新增 |
| `getFileMetadata / getSelectionMetadata` | `lib/filesWorkspace/metadata.ts` + Rust `fs_stat` | 扩展（访问时间/属性/多选聚合） |
| `canPreviewFile / getFilePreview / openFilePreview / closeFilePreview` | `QuickPreviewDialog.tsx` + `preview.ts` | 新增 facade（现有类型扩展） |
| `getFileTags / setFileTags / addFileTag / removeFileTag` | `tags.ts` + DB | 新增 |
| `createFileCollection / ...` | `collections.ts` + DB | 新增 |

### 4.4 工作区、项目、暂存与设备

| 目标函数 | 实现位置 | 方式 |
|---|---|---|
| `addWorkspaceFolder / removeWorkspaceFolder / getWorkspaceFolders / updateWorkspaceFolder` | `favorites.ts` 或 `workspace.ts` + DB | 新增 |
| `searchAcrossWorkspace` | `search.ts` | 新增（复用现有 sources） |
| `collectFile(s) / removeCollectedFile / clearCollectedFiles / getCollectedFiles` | `collect.ts` | 新增（底层 `shelf_add_paths`） |
| `buildFileTransferPlan / preview / execute / cancel` | `collect.ts` + `operations.ts` | 新增 |
| `bindProjectFolder / unbindProjectFolder / getProjectFolders / getProjectFolderByRole` | Rust `commands/project_workspace.rs` + `project_folders` | 新增 |
| `getPairedDevices / sendFilesToDevice / getFileTransferStatus / pause / resume / cancel / retry` | `deviceTransfer.ts` + `mobile_sync` 扩展 | 新增 |

### 4.5 系统、压缩、自动化、历史

| 目标函数 | 实现位置 | 方式 |
|---|---|---|
| `openWithDefaultApp` | 复用 `fs_open` | 现有 |
| `openWithApp / openTerminalAtPath / showNativeFileProperties` | Rust `commands/system.rs` 或 `file_workspace.rs` | 新增 |
| `openInWindowsExplorer` | 复用 `fs_reveal` | 现有 |
| `createArchive / previewArchive / extractArchive / canExtractArchive` | Rust `archive/` + `archive.ts` | 新增（依赖授权） |
| `createFileAutomation / ... / getFileAutomationLogs` | `automation.ts` + Rust `automation/` | 新增 |
| `getFileActivityTimeline / getFileActivity` | `activity.ts` + Rust `file_workspace/activity.rs` | 新增 |
| `analyzeFileRelations / getFileDependents / getFileDependencies` | `relations.ts` + Rust | 新增（白名单解析器） |

### 4.6 Rust 扩展点

1. **`fsops`**：`JobSnapshot` 追加 `total_bytes/completed_bytes/speed_bps/eta_ms/current_item`；
   新增 `pause/resume` 状态与命令；新增 `kind=compress|extract`；`retry` 以失败项创建新任务，
   不复活旧任务。调度仍为固定 worker + 有界队列；暂停只能在条目边界生效。
2. **`file_workspace/plan.rs`（新）**：只读预演。输入计划（源、目标、效果、冲突策略），
   输出计数、字节、冲突/无权限/重复/覆盖与警告；统计使用 `fs_stat`/`fs_list_dir`，
   不复制内容；对目录递归设深度/条目上限，超限返回 `incomplete` 而不是假装完整。
3. **`file_workspace/archive.rs`（新）**：ZIP 创建/列表/解压；zip-slip 防护（规范化后必须位于
   目标根内）、解压炸弹上限（条目数/总字节/压缩比）、重解析点不跟随；算法不进入 UI。
4. **`file_workspace/activity.rs`（新）**：写 `file_activity_events`，只记录 TaskDock 自己发起
   的操作（copy/move/delete/rename/archive/transfer）；外部修改不伪造。
5. **`commands/`**：新命令薄壳，全部 `validate_abs_path` + 受保护目录校验；异步/阻塞线程
   与现有约定一致；在 `lib.rs` 注册。
6. **`db/mod.rs`**：末尾追加迁移；新表登记 `BACKUP_TABLES`/`EXTENDED_TABLES`；不改已发布迁移。

---

## 5. 事件与错误契约

- 任务进度：沿用 `recycle:job-progress`（事件名已公开），追加字段必须向后兼容；
  前端按 `jobId` 去重，终态后停止轮询。
- 搜索：前端 AbortController + 请求代际；后端单次 IPC 不可抢占，前端停止后续调度。
- 错误分类：沿用 `FS_OP_*` 稳定码（`fsOpFeedback.ts`）；新增 `FS_OP_PAUSED`、
  `FS_OP_CONFLICT`、`FS_OP_PREVIEW_INCOMPLETE`、`FS_OP_ARCHIVE_*` 时必须在前端映射。
- 不允许吞异常：IPC 失败必须进入 `fsOpFeedback` 或可见 toast；禁止只 `console.log`。

---

## 6. 性能与资源约束

1. 选择/框选：只遍历虚拟可见范围；不得 `mousemove → 全量遍历 → setState`。
2. 搜索：深度/目录/结果三重上限；连续输入只保留最后一个会话；取消后不再调度。
3. 任务：固定 worker + 有界队列；失败明细有界；终态任务按上限淘汰。
4. 预览：大图按需解码；文本≤2 MiB；媒体 token 有界并释放；50 次切换不泄漏。
5. 事件监听：每个功能一个订阅源，不在每个文件行上挂全局监听器。
6. 大目录：1000/5000/25000 三档回归；新增功能不得破坏现有虚拟化。
7. 自动化/关系分析：必须可取消、有预算、后台执行；不得在 UI 线程扫描磁盘。

---

## 7. 并行开发所有权（按任务规范 §35）

| 角色 | 范围 | 独占写入 |
|---|---|---|
| 主 Agent | 架构、Store、API 契约、集成、构建、最终验收 | `useFilesWorkspaceStore.ts`、`bridge.ts`、`persist.ts`、`docs/architecture`、`docs/acceptance` |
| Agent A | 导航、搜索、筛选、收藏 | `navigation.ts`、`search.ts`、`filters.ts`、`favorites.ts`（新增） |
| Agent B | 文件操作引擎 | `clipboard.ts`、`operations.ts`、`operationPreview.ts`、`operationHistory.ts`、Rust `fsops/file_workspace/plan.rs` |
| Agent C | 文件 UI | `FileToolbar/Breadcrumb/SearchBar/FilterPanel/DetailsPanel/ContextMenu/OperationQueue` 组件 |
| Agent D | 多目录与项目 | `workspace.ts`、`collect.ts`、`tags.ts`、`collections.ts`、`project_folders` |
| Agent E | 设备与智能 | `deviceTransfer.ts`、`automation.ts`、`activity.ts`、`relations.ts`、`archive.ts` |

共享枢纽文件（`FilePane.tsx`、`useFilesWorkspaceStore.ts`、`operations.ts`、`bridge.ts`、
`src-tauri/src/lib.rs`、`commands/mod.rs`、`db/mod.rs`、全局样式/locales）只能由唯一所有者
串行写入；其他 Agent 先读后提改动建议，不并行写。

---

## 8. 兼容性与迁移

- **布局设置键**：`file_workspace_layouts` 结构只追加可选字段；旧 states 归一化后可用。
- **pinnedDirs → favorites**：迁移时保留原路径与顺序；失败则保留旧字段只读，不丢数据。
- **recentDirs → recentPaths**：旧数组迁移为 `kind="dir"`；上限仍为 8，可配置。
- **DB**：只追加迁移；新表登记备份；旧版本回退需使用迁移前数据库副本（与既有约定一致）。
- **IPC**：既有命令签名不变；新增命令独立；`JobSnapshot` 只追加字段。
- **文件系统**：不移动/覆盖用户文件；删除默认回收站；标签/收藏/集合均为 TaskDock 元数据。
- **设备协议**：复用现有 TLS + SPKI 固定；不改配对二维码格式。

---

## 9. 风险与未决项（Phase 1 登记）

| 风险/未决项 | 影响 | 处理 |
|---|---|---|
| 共享工作树存在其他任务未提交改动 | 文件工作区文件可能被他人在途修改 | 开工前/交付前 `git status`；按文件所有权串行；不覆盖他人 diff |
| r7 结论为 PARTIAL，b09 正式构建全部失败 | 当前无可作为正式验收的安装包 | Phase 2 先走快照+构建，不在共享工作树打临时包冒充正式包 |
| `fs_stat` 访问时间语义（Windows 延迟更新） | FW-INFO-001 可能显示不准确 | 实现前用原生实验确认；必要时标注「最后访问时间仅供参考」 |
| ZIP 依赖引入 | 供应链/体积/安全 | 单独依赖授权；优先评估现有依赖或 Windows Shell 能力 |
| 撤销的可逆性 | 永久删除/外部修改不可逆 | 只对可证明可逆的操作提供撤销；其余明确置灰 |
| 自动化误伤 | 数据风险 | 强制预演 + 确认 + 日志 + 暂停；默认关闭 |
| 25k+ 大目录下新增筛选/搜索 | 性能回退 | 复用现有有界扫描；新增基准测试；不新增全量遍历 |
| 设备传输进度/暂停 | 移动端协议可能要扩展 | 先复用 `mobile_files` 状态；协议变更需移动端协同 |
| 多窗口并发写同一设置键 | 读-改-写竞态（既有已知限制） | 保持窗口内串行；跨窗口问题另行评估，不在本轮扩面 |
| `FilePane.tsx` 体量过大 | 并行冲突与维护成本 | 只做「按功能抽组件」的低风险拆分，不整文件重写 |

---

## 10. 本轮实现记录（2026-11-18，P0 批次 1）

本批只做低风险、可独立验证的 P0 缺口，未引入新依赖、未改数据库迁移。

### 10.1 导航与剪贴板

- `FilesWorkspacePanel.tsx`：新增 `Alt+Left / Alt+Right / Alt+Up`（活动窗格前进/后退/上一级），
  在布局撤销分支之前处理，输入框内不消费。
- `useFilesWorkspaceStore.ts`：新增 `clearRecentDirs()`；地址栏新增「路径历史」下拉
  （最近目录，可清除），复用 `recentDirs`，不新建第二套历史状态。
- `interactions.ts`：文件剪贴板升级为 `FwClipboardPayload`
  `{ mode, paths, sourcePaneId, createdAt }`；新增 `clearFwClipboard /
  hasFwClipboardItems / getFwClipboardOperation`；空路径等同清空。复制/剪切调用点带来源窗格。

### 10.2 文件详细信息

- Rust `FsStat` 追加 `accessed_ms` 与 `attributes: Vec<&'static str>`；新增
  `attribute_names()` 把 Windows 属性位转稳定代码（readonly/hidden/system/directory/
  archive/reparse/compressed/encrypted/offline/sparse/temporary/normal）。
- `bridge.ts` 同步 `FsStat` 类型；`FilePane.tsx` 属性对话框展示访问时间与属性；
  多选时选择条新增「选中项」摘要（数量/总大小/文件与文件夹/类型分布），只读现有条目，
  不额外发 IPC。

### 10.3 系统集成

- `commands/file_workspace.rs` 新增：
  - `fs_open_with`：`ShellExecuteW("openas")`；
  - `fs_show_properties`：`ShellExecuteW("properties")`；
  - `fs_open_terminal`：优先 `wt.exe -d <dir>`，回退 `cmd.exe /K`（`current_dir`，不拼 cd）。
  - 全部先过 `validate_local_path` + 受保护目录校验；只调用系统 Shell/进程，不写文件。
- `lib.rs` 注册三个命令；`bridge.ts` 新增 `fsOpenWith/fsShowProperties/fsOpenTerminal`；
  `FilePane` 右键菜单新增对应入口（与内部只读「属性」区分）。

### 10.4 操作预演（FW-OPS-003）

- Rust `file_workspace::preview_transfer(paths, target_dir, effect)`：只读统计
  `items/files/dirs/bytes`、同名冲突、无权限源、重复源、警告与 `complete`；
  有界（50,000 条目 / 深度 64 / 不跟随重解析点），移动进自身子树直接拒绝。
- 命令 `fs_preview_operation`（`spawn_blocking`，源与目标都过保护目录校验）；
  `bridge.ts` 新增 `fsPreviewOperation` 与 `OperationPreview` 类型。
- 前端新增 `operationPreview.ts`（阈值：复制 ≥20、移动 ≥10）与
  `OperationPreviewDialog.tsx`；`FilesWorkspacePanel.requestTransfer` 先预演，
  确认后进入既有冲突决策/`applyFileDrop`，取消不产生写入。

### 10.5 搜索条件与范围

- `SearchOptions` 新增可选 `minSize/maxSize/includeHidden`；`matchesHit` 对文件按字节过滤、
  目录不受大小限制；`fsListDir` 透传 `includeHidden`。
- `WorkspaceSearchDialog` 新增最小/最大 MB 与「包含隐藏项」；旧调用不传新字段时行为不变。
- `workspaceSearchSources`：在已打开窗格外增加项目根目录与固定目录作为可选搜索来源；
  非真实窗格来源定位时回落到活动窗格，不新建窗格。

### 10.6 验证状态（本批）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过（exit 0；期间曾被其他任务在途文件阻塞，非本批错误） |
| 定向 Vitest | 剪贴板/预演/对话框/键盘导航/搜索条件/Store 共 6 个文件、约 90 用例通过 |
| 全量文件工作区 Vitest | `src/lib/filesWorkspace` + `src/components/files`：36 文件 / 341 用例全部通过 |
| Rust `cargo check` | 通过（exit 0，`Finished dev profile`） |
| Rust 单测 | `cargo test file_workspace::` 被其他任务在途测试代码（capability/recipes.rs、mcp/tests.rs）编译错误阻塞，未执行 |
| 构建 / 原生验收 | 未执行 |
| 提交 | 未提交（共享工作树，等待授权/集成流程） |

---

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-18 | 建立 Phase 1 架构基线：现状分层、目标 facade、数据模型、函数级清单、所有权与风险 |
| 2026-11-18 | P0 批次 1：导航快捷键/路径历史、文件剪贴板 payload、FsStat 属性、系统集成命令、操作预演、搜索大小/隐藏条件与项目/固定目录来源 |
