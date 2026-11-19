# 数据模型：工作篮、批次与实体关联

## 1. 迁移

- 迁移号：**79**（`src-tauri/src/transfer/schema.rs::MIGRATION_79`），登记在
  `db/mod.rs` 的 `MIGRATIONS` 末尾。
- 只新增表与索引，不改任何既有表；不做破坏性 DDL。
- 失败回滚：`apply_migrations` 在单事务内执行，任一句失败整体回滚，`user_version` 保持
  迁移前值（既有机制，本系统不额外实现）。
- 备份：四张表均登记进 `BACKUP_TABLES`（`extended=true`，`quick_policy=all`）；
  `transfer_contents` 依赖 `transfer_items`，恢复顺序在其后。

## 2. 表结构

### 2.1 `transfer_items`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID |
| `item_type` | TEXT | `text` `richtext` `image` `file` `directory` `url` `clipboard` `task` `project` `planning` `knowledge` `capture` |
| `source_module` | TEXT | `clipboard` `files` `tasks` `projects` `planning` `knowledge` `capture` `mobile` `resource` `shelf` `tray` `manual` |
| `source_id` | TEXT default `''` | 来源稳定 id（剪贴板条目 id / 任务 id / 规范化路径…） |
| `dedupe_key` | TEXT | `类型 + 来源 + 稳定标识/内容哈希` |
| `title` | TEXT | 列表展示标题（≤200 字） |
| `description` | TEXT | 副标题/来源说明（≤400 字） |
| `content` | TEXT | 文本正文（内联 ≤64KB）；其它类型为空 |
| `content_ref` | TEXT NULL | 溢出正文在 `transfer_contents.id` |
| `payload_json` | TEXT | 引用载荷（见 §3），**不含二进制** |
| `sort_order` | REAL | 拖拽排序（插入取相邻均值，冲突时重排） |
| `pinned` | INTEGER | 0/1 |
| `status` | TEXT | `ready` `sending` `sent` `failed` `expired` |
| `error_code` / `error_message` | TEXT | 最近一次失败（稳定码 + 可读原因） |
| `last_target` | TEXT | 最近发送目标（`files:/path`、`task:<id>`…） |
| `created_at` / `updated_at` / `sent_at` / `expires_at` | TEXT | UTC RFC3339 |

索引：

```sql
CREATE INDEX idx_transfer_items_order ON transfer_items(status, pinned DESC, sort_order, created_at);
CREATE INDEX idx_transfer_items_type ON transfer_items(item_type, status);
CREATE INDEX idx_transfer_items_source ON transfer_items(source_module, source_id);
CREATE UNIQUE INDEX idx_transfer_items_dedupe
  ON transfer_items(dedupe_key) WHERE status IN ('ready','sending','failed');
```

> 去重索引只覆盖「仍在篮中」的状态：条目发送成功后，同一内容可以再次加入（新的一批），
> 不会被历史记录挡住。

### 2.2 `transfer_contents`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID |
| `body` | TEXT | 正文（≤512KB，超过拒绝加入并提示另存为文件） |
| `created_at` | TEXT | UTC |

正文单独存放的原因：列表查询不读取大字段；`transfer_items.content` 只保留短文本。

### 2.3 `transfer_batches`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID（前端展示与重试标识） |
| `target_module` | TEXT | `files` `tasks` `projects` `planning` `knowledge` `shelf` `capture` |
| `target_ref` | TEXT | 目标引用（目录路径 / 任务 id / 项目 id…） |
| `operation` | TEXT | `write` `copy` `move` `create_task` `link` `import` |
| `status` | TEXT | `pending` `running` `completed` `partial` `failed` `cancelled` |
| `total` `ok` `failed` `skipped` | INTEGER | 计数（由结果汇总，不单独维护两套） |
| `job_ids_json` | TEXT | fsops 任务 id 数组（文件类操作） |
| `results_json` | TEXT | 逐条结果（有界：最多 200 条失败明细） |
| `undo_kind` | TEXT | `none` `recycle` `unlink` |
| `undo_payload_json` | TEXT | 撤销所需的最小信息（创建的目标路径 / 关联 id） |
| `undo_state` | TEXT | `available` `used` `unavailable` |
| `error_message` | TEXT | 批次级失败原因 |
| `created_at` / `updated_at` | TEXT | UTC |

### 2.4 `entity_links`（通用关联，仅用于没有归属表的实体对）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID |
| `source_type` / `source_id` | TEXT | 源实体 |
| `target_type` / `target_id` | TEXT | 目标实体 |
| `relation` | TEXT | `reference` `attachment` `parent` `derived`（CHECK 约束） |
| `label` | TEXT | 展示标签（可空） |
| `metadata_json` | TEXT | 扩展（如 `{"mime":"image/png"}`），不含正文 |
| `created_at` | TEXT | UTC |

唯一约束：`(source_type, source_id, target_type, target_id, relation)` —— 重复关联
幂等返回已存在记录，不产生第二条。

## 3. `payload_json` 约定（按类型）

| 类型 | payload | 示例 |
|---|---|---|
| `text` / `richtext` / `url` | `{}`（正文在 `content`） | — |
| `image` | `{clipboardItemId, width, height, mime}` | `{"clipboardItemId":"c-1","width":1920,"height":1080,"mime":"image/png"}` |
| `file` / `directory` | `{path, size?, name}` | `{"path":"D:\\work\\a.pdf","size":10240,"name":"a.pdf"}` |
| `clipboard` | `{clipboardItemId, kind}` | — |
| `task` / `project` / `planning` / `knowledge` / `capture` | `{snapshotTitle, snapshotSubtitle}` | 只用于展示，**不是数据源** |

## 4. 实体标识规范

| 实体 | type | id |
|---|---|---|
| 任务 | `task` | `tasks.id` |
| 项目（工作空间） | `workspace_project` | `workspace_projects.id` |
| 规划项目 / 功能 / 步骤 | `planning_project` / `planning_feature` / `planning_step` | 各自 id |
| 知识文档 | `knowledge_doc` | `knowledge_documents.id` |
| 采集条目 | `capture` | `quick_capture_items.id` |
| 暂存架条目 | `shelf_item` | `shelf_items.id` |
| 剪贴板条目 | `clipboard_item` | `clipboard_items.id` |
| 文件 | `file` | 规范化绝对路径（`file_workspace::validate_abs_path` 的结果） |

文件路径作为 `target_id` 时：

- 必须先词法规范化（去 `..`、统一分隔符、去尾分隔符）；
- 比较时大小写不敏感（Windows）；
- **路径失效识别**：读取关联时用 `fs_stat` 校验存在性，失效则返回 `stale=true`，
  不删除关联记录（用户可能只是移动了磁盘）。

## 5. 关系语义（不可混用）

| relation | 含义 | 典型 |
|---|---|---|
| `reference` | 引用：目标内容仍归原模块，删除关联不影响内容 | 项目资料、任务附件引用 |
| `attachment` | 附件：该内容被当作目标的附属物管理与展示 | 任务附件 |
| `parent` | 父子：source 属于 target 的子项 | 规划步骤属于功能 |
| `derived` | 派生：source 由 target 生成/转化 | 规划条目生成的任务、采集转任务 |

`copy` / `move` 是**操作**（写入 `transfer_batches.operation`），不是关系。一次移动不会
在 `entity_links` 留痕；移动后原路径的引用会被标记 stale。

## 6. 生命周期与清理

- `sent` 条目默认保留 7 天（`transfer_sent_retention_days`，设置项，默认 7，0=永久）；
- `expired` 条目保留至用户删除或超过 30 天；
- `pinned=1` 的条目**永不**自动清理；
- 清理在写入路径上顺带执行（每次 `add/update/remove` 后最多删 200 行），不新增常驻定时器；
- 批次记录保留最近 30 条，其余按 `created_at` 淘汰（不影响条目本身）。

## 7. 兼容与回退

- 新表不参与既有查询，旧版本应用打开新库时忽略它们（SQLite 允许未知表）；
- 回退到旧版应用：`user_version` 更高不会阻止启动（旧代码只应用版本号大于当前值的迁移，
  没有迁移会跳过）；但旧版不会读取新表，工作篮内容暂不可见，数据不丢失；
- 备份 manifest 的新 section 为 `transfer_*` / `entity_links`；旧备份恢复时缺失这些
  section 视为空，不报错（`extended=true` 的通用行格式）。
