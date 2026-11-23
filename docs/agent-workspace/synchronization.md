# 同步机制

## 1. 状态机（单文件）

```
untracked ──export──▶ in_sync ──外部修改──▶ modified_external ──版本一致──▶ in_sync（导入后）
                          │                        │
                          │                        └──版本不一致──▶ conflict ──resolve──▶ in_sync / resolved_*
                          └──DB 变更──▶ stale ──export──▶ in_sync
文件被删 ──scan──▶ deleted ──export──▶ in_sync
```

- `in_sync`：文件 hash == `exported_hash`，且 `exported_revision` == 当前 DB revision。
- `stale`：DB revision 已前进，等待下一次导出（不读取文件内容）。
- `modified_external`：文件 hash != `exported_hash`，且 DB revision 未变 → 可安全导入。
- `conflict`：文件 hash 变化 **且** DB revision 已前进 → 只记录冲突，不覆盖任何一侧。
- `deleted`：已登记文件在磁盘上消失；仅更新索引，不删除数据库行。

## 2. 事件来源判定（防同步环）

| 判定 | 依据 |
|---|---|
| TaskDock 自身写入 | 文件 hash == `exported_hash`（导出时记录） |
| Agent 外部写入 | 文件 hash != `exported_hash` 且文件 mtime > `exported_at` |
| 人工编辑 | 同「外部写入」；`source=file`，`actor_kind=human`（若导入方未提供 Agent token） |
| 文件删除 | 索引中存在、磁盘不存在 |
| 文件重命名 | 旧路径 `deleted` + 新路径 `untracked`（不做内容指纹合并，避免误判） |

**没有无差别双向监听**：只有可导入目录中的「hash 不一致」文件才进入导入队列；导出不监听文件系统。

## 3. 导出（`export_*`）

1. 读取工作空间配置（未初始化 → `AppError::Validation`，提示先在 UI 初始化）。
2. 确保 `.taskdock-workspace.json` 存在且 `workspace_id` 匹配；否则拒绝写入。
3. 逐资源渲染（分页读取，单次最多 500 行/页）→ 原子写（`tmp` + rename）。
4. 更新 `agent_workspace_files`：`exported_hash` / `exported_revision` / `exported_at` / `state=in_sync`。
5. 写 `agent_sync_events(direction=export, status=ok)`；失败逐文件记录 `failed` 并继续（不因单文件失败中断）。
6. 全量导出完成后更新 `agent_workspaces.last_export_at` 与 `manifest.json` 的 `data_updated_at`。

预算：单次全量导出上限 2000 个文件；超过时只导出「脏资源 + manifest + context」，并在事件里标注
`partial=true`。

## 4. 导入（`import_external_document`）

1. 路径/大小/扩展名校验（见 workspace-protocol §6）。
2. 解析信封 → `kind` + `payload` + `base_revision`。
3. 权限校验（按 kind 映射的能力）。
4. 读取当前 revision 与 `updated_at`：
   - `base_revision` 缺失 → 拒绝（`validation`）。
   - 不一致 → 写冲突记录（`agent_sync_conflicts`），返回 `conflict`，**不落库**。
5. 业务写入（复用 `service`），事务内：业务 + revision + 审计 + 同步事件。
6. 成功后把文件移入 `exports/applied/`（同 workspace 内移动，保留原始内容便于追溯）。
7. 失败保留原文件（便于修复后重试），按 `request_id` 做 24h 幂等。

## 5. 重试与失败

- 单文件失败不阻塞其它文件；失败计数与原因写 `agent_sync_events(status=failed, message=…)`。
- 自动重试**只针对可重试错误**（IO 短时占用、SQLite busy）；校验/权限/冲突错误不自动重试。
- 每轮扫描上限 200 个候选文件、总预算 2s；未处理完的留到下一轮（不丢队列）。

## 6. 差异与人工解决

`sync_conflicts` 返回：`rel_path`、`resource_kind`、`db_revision`、`file_revision`、两侧 hash、
`detail_json`（DB 侧摘要 + 文件侧摘要，截断到 200 字符）。

解决动作：
- `keep-db`：标记 `resolved_db`，重新导出覆盖文件。
- `keep-file`：需要 `force=true`；以文件内容覆盖 DB（仍校验 schema），revision +1，写审计与事件。
- `dismiss`：标记 `dismissed`，保留记录，不再提示。

## 7. 监听任务

- 由 `agent_access::watch` 启动，单线程 + `AtomicBool` 取消标志；默认 20s。
- 启动条件：`agent_workspace_watch_enabled=true` 且 workspace 已初始化。
- 每次 tick：`scan_once`（只读目录遍历 + 有界文件数）→ `export_dirty`（仅脏资源）。
- 退出时置取消标志并 join（≤2s），不留孤儿线程。
- 错误只记录并降频（连续失败 3 次后间隔翻倍，最多 5 分钟）。

## 8. 导入判定与幂等（v81 修订）

### 8.1 导入判定链

```
scan() 逐文件：
  1) 解析（JSON 信封 / Markdown front matter）
  2) kind → 真实写能力（resolve_import_capability）
  3) 目标项目（显式 project_id > payload.project_id > 任务所属项目）
  4) authorize_file_import() → Allowed / NeedsReview / Rejected
  5) Allowed：占幂等声明 → import_document()（再校验能力与项目范围）→ 置 ok → 归档 _imported/
     NeedsReview：登记 agent_import_requests（保留文件在 Inbox）
     Rejected：记录原因 → 归档 _rejected/
```

后台监听（`watch.rs`）与 UI 手动扫描（`commands::agent_access_scan`）走**同一条链**；
人工批准走 `approve_import()`（一次性 `ImportGrant`，只含该 kind 的能力）。

### 8.2 幂等键

`claim_key = sha256(rel_path | kind | content_hash | actor)`：请求身份 + 操作类型 + 请求标识。
只看内容 Hash 会把「不同文件、相同内容」误判为同一操作，因此不使用。

### 8.3 冲突解决契约

| 传输值 | 含义 | 前置校验 |
|---|---|---|
| `db` | 保留 TaskDock 数据，删除外部文件 | 冲突属于当前工作空间、状态为 open |
| `file` | 接受外部文件（以当前 revision 重新导入） | 上述校验 + 文件 hash 未变 + 类型一致 + 目标仍存在 + **重新校验权限** |
| `dismiss` | 仅关闭冲突记录，文件保留 | 上述基础校验 |

其他取值一律 `VALIDATION`（前端只允许 `db | file | dismiss`）。
文件读取失败或数据库写入失败时**不得**把冲突标记为已解决。

### 8.4 监听状态

`watch::status()` 暴露 `running / interval_secs / last_tick_at / last_ok_at / last_error`；
`sync::status()` 暴露 `pending_imports / conflicts / pending_reviews / last_error`。
20s 轮询保留为可靠兜底，未引入文件系统事件监听。

### 8.5 领域受限导入（Phase 1）

文件通道只开放三个**更新型**领域操作，默认进入人工审核：

| kind | 必填 payload | 写入语义 |
|---|---|---|
| `novel.chapter.content.update` | `chapter_id`、`content` | 覆盖章节正文，推进 `novel.chapter` revision |
| `comic.media.update` | `media_id`、`version_label`；可选 `status`（`candidate`/`rejected`）、`review_note` | 更新素材元信息；不允许直接写 `adopted` |
| `comic.media.adopt` | `media_id` | 采用版本；被替换版本在同一事务内推进 revision |

约束：

- 全部为更新类，`base_revision` 必填；不一致进入 `agent_sync_conflicts`，可按 `file` 以当前 revision 重新导入。
- 项目归属只认数据库真实归属（章节/素材行）；文件声明的 `project_id` 仅做一致性校验，不构成授权依据。
- 能力映射为 `projects.write`；`trusted` 目录仍要校验导入授权能力集合与真实资源归属，绑定 Agent 时再以其真实授权为准。
- Markdown：`novel.chapter.content.update` 取 front matter 之后的正文作为 `content`；`comic.media.update` 的正文作为 `review_note`。
- 单文件仍受 256KiB 上限约束；领域正文/备注不额外放大。
