# 03 · 数据模型与迁移

> 代码位置：`src-tauri/src/db/mod.rs`（迁移 v7 / v9）、`src-tauri/src/clipboard/store.rs`
> 数据库：现有 SQLite（WAL + 外键 + `busy_timeout`），无第二套存储。

## 一、表结构

### clipboard_items（历史条目）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID |
| `kind` | TEXT | `text` / `url` / `html` / `image` / `files`，CHECK 约束 |
| `text` | TEXT | 纯文本正文（≤512 KB，超出截断） |
| `html` | TEXT | 清洗后的 HTML 片段（≤512 KB） |
| `preview` | TEXT | 列表预览（≤220 字符 + 省略号） |
| `content_hash` | TEXT | SHA-256（类型 + 正文/文件路径/图片字节参与），**唯一索引** |
| `byte_size` | INTEGER | 文字/HTML 为字节数；图片为 PNG 字节数；文件为现存文件大小合计 |
| `source_app` | TEXT | 来源 exe 文件名（小写） |
| `source_title` | TEXT | 来源窗口标题 |
| `image_width` / `image_height` | INTEGER | 图片尺寸（可空） |
| `file_paths` | TEXT | 文件路径 JSON 数组（≤200 条） |
| `favorite` / `pinned` | INTEGER | 0/1；自动清理不触碰 |
| `copy_count` | INTEGER | 去重命中时 +1 |
| `created_at` / `last_seen_at` | TEXT | RFC3339；排序与保留期依据 |

索引：`content_hash` 唯一；`last_seen_at DESC`；`(kind, last_seen_at DESC)`；
`(favorite, last_seen_at DESC)`。

### clipboard_assets（图片资产）

| 列 | 说明 |
|---|---|
| `id` TEXT PK | UUID |
| `item_id` | → `clipboard_items(id)` ON DELETE CASCADE |
| `role` | `image`（原图）/ `thumb`（缩略图），UNIQUE(item_id, role) |
| `path` | 相对剪贴板根目录的路径（`images/<id>.png`、`thumbs/<id>.png`） |
| `byte_size` / `width` / `height` | 文件大小与尺寸 |
| `created_at` | RFC3339 |

不把二进制写入数据库；根目录位于应用数据目录 `clipboard/` 下，随应用数据迁移。
路径读取前经过 `safe_rel` 校验（拒绝绝对路径、`..`、非普通组件）。

### clipboard_groups（分组）

| 列 | 说明 |
|---|---|
| `id` TEXT PK | UUID |
| `name` | 默认“截图组 N”/“手动分组”，≤80 字符 |
| `mode` | `auto` / `manual` |
| `status` | `collecting` / `closed` |
| `favorite` / `pinned` | 0/1 |
| `created_at` / `updated_at` / `closed_at` | RFC3339 |

索引：`(status, updated_at DESC)`。

### clipboard_group_items（组内顺序）

| 列 | 说明 |
|---|---|
| `group_id` / `item_id` | 复合主键，双外键 ON DELETE CASCADE |
| `position` | 从 0 递增；**不设唯一约束**，重排在事务内整体重写，避免中间态冲突 |
| `origin` | `auto`（引擎追加）/ `manual`（用户加入/拆分/合并） |
| `added_at` | RFC3339 |

索引：`(group_id, position)`、`item_id`。

### clipboard_task_links（任务关联）

| 列 | 说明 |
|---|---|
| `id` TEXT PK | UUID |
| `task_id` | → `tasks(id)` ON DELETE CASCADE |
| `target_type` | `item` / `group` |
| `target_id` | 对应条目/分组 id（不设外键，删除目标时由应用清理） |
| `created_at` | RFC3339 |

唯一约束 `(task_id, target_type, target_id)`；任务删除只删关联行，剪贴板内容保留。

### clipboard_paste_jobs（逐项粘贴审计）

| 列 | 说明 |
|---|---|
| `id` TEXT PK | UUID |
| `group_id` | 来源分组（可为空） |
| `target_title` / `target_exe` | 目标窗口信息 |
| `status` | `running` / `completed` / `cancelled` / `failed` / `interrupted` |
| `total` / `sent` | 总数与已发送按键数 |
| `started_at` / `ended_at` | RFC3339 |
| `message` | 面向用户的诚实状态文本 |
| `remaining_items` | 未完成条目 id 的 JSON 数组（用于继续） |
| `restored` | 是否恢复了原剪贴板 |

索引：`started_at DESC`。启动时把残留 `running` 任务标记为 `interrupted`（不删除记录）。

### clipboard_snapshot_links（v0.5 工作现场，迁移 v9）

| 列 | 说明 |
|---|---|
| `id` TEXT PK | UUID |
| `snapshot_id` | → `workspace_snapshots(id)` ON DELETE CASCADE |
| `target_type` | `item` / `group` |
| `target_id` | 条目/分组 id |
| `created_at` | RFC3339 |

唯一约束 `(snapshot_id, target_type, target_id)`。只写关联，不复制内容；
素材删除后由应用侧解除关联。对应命令 `clipboard_link_snapshot` /
`clipboard_unlink_snapshot` / `clipboard_snapshot_links`，当前 UI 未接入。

## 二、迁移

- 机制：`MIGRATIONS` 数组按 `PRAGMA user_version` 顺序执行，每步 SQL 与版本号
  在同一事务中提交；失败整体回滚，可重试。
- 剪贴板相关：
  - **v7**：5 张剪贴板表 + 索引（属于 v0.5 开发线，旧库升级时自动创建）。
  - **v8**：Agent 事件/通知索引（并行性能专项，仅 `CREATE INDEX IF NOT EXISTS`）。
  - **v9**：工作现场/行动中心表 + `clipboard_snapshot_links`。
- 版本检查在测试中覆盖：旧库逐级升级到最新、迁移中途失败回滚后重试成功。
- 回滚/重置路径：数据管理命令删除表时同时删除 `clipboard_snapshot_links`，
  避免外键残留（`db/mod.rs` 的清理 SQL）。

## 三、去重与归一化

`store::record_capture`：

1. `normalize`：HTML 清洗（去脚本/样式/iframe/表单等主动内容、`on*` 属性、
   `javascript:`）、正文按 UTF-8 边界截断、重新生成预览、计算 `byte_size`。
2. `engine::hash_of`：类型 + 文本 + HTML + 文件路径 + 图片字节 → SHA-256。
3. 命中 `content_hash`：只更新 `copy_count + 1`、`last_seen_at`、来源应用/标题，
   返回 `created=false`；不新建行、不重新落盘、不参与分组。
4. 未命中：图片先写原图 + 缩略图（临时文件 + 原子 rename），再在单事务中插入
   条目与资产；事务失败删除已写文件；唯一约束冲突按重复处理。
5. 自动分组在同一事务内完成，避免“条目入库但分组失败”的半状态。

不同 `kind` 的内容即使文本相同也哈希不同（例如纯文本与 URL），避免错误合并。

## 四、删除与引用安全

| 操作 | 行为 |
|---|---|
| 删除分组（保留内容） | 删除分组及其组内关系、分组任务关联；条目保留在历史 |
| 删除分组及内容 | 只删除**未被其他分组引用、未被任务关联、未收藏/置顶**的条目；其余保留，并返回 `retained_shared` |
| 显式删除条目 | 用户明确删除内容：条目、资产引用、组内关系、任务关联一并移除；因此从所有分组消失。界面文案已明确提示，不再声称“仍被引用会保留” |
| 任务删除 | 仅级联删除 `clipboard_task_links`，剪贴板内容与分组不变 |
| 资产文件 | 删除后检查 `clipboard_assets` 是否仍引用同一路径；无引用才删文件 |

空分组在条目删除后自动清理（含分组任务关联），避免留下空壳。

## 五、清理策略

`store::cleanup` 在后台线程启动 8 秒后执行，此后每 300 秒一次；也可由设置页手动触发：

1. 关闭最后一张截图早于分组窗口的 `collecting` 组。
2. 非收藏/非置顶条目：
   - 超过 `clipboard_retention_days`（默认 30，1–3650）删除；
   - 超过 `clipboard_max_items`（默认 1000，20–50000）按最旧优先删除；
   - 资产总量超过 `clipboard_max_storage_mb`（默认 512，16–102400）时，
     按最旧优先删除带资产的条目，直到低于上限。
3. 清理无引用资产文件（崩溃/手工改库留下的孤儿文件）。
4. 报告删除条数、关闭分组数、释放字节、孤儿文件数。

收藏/置顶条目永不自动清理；文件条目不计入“释放字节”（不拥有原文件）。

## 六、查询与分页

- 列表：`ORDER BY pinned DESC, last_seen_at DESC LIMIT ? OFFSET ?`；
  默认 80，最大 200；返回 `total_items` 供“加载更多”。
- 搜索：`text` / `preview` / `source_app` / `source_title` / `file_paths`
  的 `LIKE %q%`，对 `\`、`%`、`_` 转义（`ESCAPE '\'`），避免通配符注入。
- 筛选：类型、收藏、分组、任务（任务筛选展开到条目及其所属分组）。
- 列表/分组详情 DTO 压实：`text` 只给预览、`html` 清空；完整正文只在详情接口返回，
  避免一次传输大量正文。
- 统计：条目数、分组数、图片数、文件数、收藏数、正文/资产字节、上限与开关状态。

## 七、设置键

`application_settings` 键值表 + `Settings` 强类型视图（全部带默认值）：

| 键 | 默认 | 校验 |
|---|---|---|
| `clipboard_enabled` | true | bool |
| `clipboard_paused` | false | bool |
| `clipboard_capture_images` | true | bool |
| `clipboard_capture_files` | true | bool |
| `clipboard_capture_html` | true | bool |
| `clipboard_auto_group` | true | bool |
| `clipboard_group_window_secs` | 45 | 5–600 |
| `clipboard_retention_days` | 30 | 1–3650 |
| `clipboard_max_items` | 1000 | 20–50000 |
| `clipboard_max_storage_mb` | 512 | 16–102400 |
| `clipboard_exclude_apps` | 空 | ≤4096 字符、无控制字符 |
| `clipboard_paste_interval_ms` | 350 | 100–5000 |
| `clipboard_sensitive_filter` | true | bool |
| `clipboard_group_seq`（内部） | 0 | 自动分组命名序号 |

设置写入沿用现有 `settings` 命令的校验与广播；旧库缺少这些键时按默认值工作。
