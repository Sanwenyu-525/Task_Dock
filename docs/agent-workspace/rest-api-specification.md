# REST API 规范（`/api/v1`）

- 监听：`127.0.0.1:<port>`，默认端口 `47911`，默认**关闭**；仅在设置开启时启动。
- 远程访问：**未实现**，设置项仅提示「未开放」。禁止把数据库/文件暴露到公网。
- 认证：`Authorization: Bearer tdm_…`（agent token）。无 Cookie、无 CORS 头。
- 拒绝：带 `Origin` 头的请求（浏览器跨站）、非 JSON 的写请求、超大 body（>1 MiB）。
- 请求 ID：客户端可传 `X-Request-Id`，否则服务端生成；出现在响应与审计中。
- 超时：请求 20s；body 读取 5s；连接 120s。
- 限流：每 Agent 120 请求/分钟（突发 20）；超限 `429` + `Retry-After: 1`。

## 1. 统一响应

```json
{
  "success": true,
  "data": {},
  "error": null,
  "meta": {
    "request_id": "…",
    "timestamp": "2026-11-18T09:00:00+00:00",
    "schema_version": "1.0",
    "pagination": {"limit": 20, "offset": 0, "total": 42, "has_more": true}
  }
}
```

错误：

```json
{"success":false,"data":null,
 "error":{"code":"FORBIDDEN","message":"缺少能力 decisions.write","details":{},"retryable":false},
 "meta":{"request_id":"…","timestamp":"…","schema_version":"1.0"}}
```

HTTP 状态映射：`VALIDATION→400`、`UNAUTHORIZED→401`、`FORBIDDEN→403`、`NOT_FOUND→404`、
`CONFLICT→409`、`SCHEMA_MISMATCH→422`、`RATE_LIMITED→429`、`UNAVAILABLE→503`、`INTERNAL→500`。

## 2. 端点

| 方法 | 路径 | 能力 | 说明 |
|---|---|---|---|
| GET | `/api/v1/health` | 无（仅 `{ok:true}`，不含数据） | 存活探测 |
| GET | `/api/v1/status` | 任一 read | 接口/工作空间/版本/计数 |
| GET | `/api/v1/manifest` | 任一 read | 工作空间 manifest |
| GET | `/api/v1/openapi.json` | 无 | OpenAPI 3.0 文档（不含示例密钥） |
| GET | `/api/v1/projects` | `projects.read` | `limit`/`offset`/`q` |
| GET | `/api/v1/projects/{id}` | `projects.read` | 项目详情 |
| GET | `/api/v1/projects/{id}/status` | `projects.read` | 进度/功能计数/阻塞 |
| GET | `/api/v1/tasks` | `tasks.read` | `status`/`view`/`category`/`tag`/`priority`/`q`/`limit`/`offset` |
| GET | `/api/v1/tasks/{id}` | `tasks.read` | 含 `revision`/`updated_at` |
| POST | `/api/v1/tasks` | `tasks.write` | 创建；body=任务字段 |
| PATCH | `/api/v1/tasks/{id}` | `tasks.write` | 需 `base_revision` |
| POST | `/api/v1/tasks/{id}/complete` | `tasks.write` | 需 `base_revision` |
| GET | `/api/v1/plans` | `plans.read` | `project_id` 可选 |
| GET | `/api/v1/plans/current` | `plans.read` | 当前进行中项目计划 |
| GET | `/api/v1/plans/{project_id}` | `plans.read` | 完整计划 |
| GET | `/api/v1/knowledge/search` | `knowledge.read` | `q` 必填、`kb_ids`、`limit`、`offset` |
| GET | `/api/v1/knowledge/{id}` | `knowledge.read` | 文档详情 |
| POST | `/api/v1/knowledge` | `knowledge.write` | `title` + `content` + `kb_id`/`kb_name` |
| GET | `/api/v1/decisions` | `decisions.read` | `project_id`/`status`/`limit` |
| GET | `/api/v1/decisions/{id}` | `decisions.read` | 详情 |
| POST | `/api/v1/decisions` | `decisions.write` | 创建 |
| GET | `/api/v1/context` | `context.read`，指定任务时另需 `tasks.read` | `project`/`task_id`/`task`/`budget`/`format`；任务必须关联指定项目。格式为 `json`、`compact_json` 或 `markdown` |
| GET | `/api/v1/context/search` | `context.read` | 同上，`q` 必填 |
| POST | `/api/v1/context` | `context.read` | body 里的 scope（避免超长 query） |
| GET | `/api/v1/agents/handoffs` | `handoffs.read` | `status`/`project`/`limit`/`offset`；省略项目时按授权范围发现，过滤后分页 |
| GET | `/api/v1/agents/handoffs/{id}` | `handoffs.read` | 详情 |
| POST | `/api/v1/agents/handoffs` | `handoffs.write` | 创建 |
| POST | `/api/v1/agents/handoffs/{id}/accept` | `handoffs.write` | 接收 |
| POST | `/api/v1/agents/handoffs/{id}/complete` | `handoffs.write` | 完成 |
| POST | `/api/v1/agents/handoffs/{id}/reject` | `handoffs.write` | 拒绝（需 reason） |
| GET | `/api/v1/agents/reports` | `handoffs.read` | 报告列表 |
| POST | `/api/v1/agents/reports` | `handoffs.write` | 提交报告 |
| GET | `/api/v1/agents/activity` | 任一 read | `agent_id`/`interface`/`since`/`limit` |
| GET | `/api/v1/sync/status` | 任一 read | 工作空间/索引/冲突计数 |
| POST | `/api/v1/sync/scan` | 对应 write | 扫描并导入（dry_run 可选） |
| POST | `/api/v1/sync/export` | 任一 read | 立即导出脏资源 |
| GET | `/api/v1/sync/conflicts` | 任一 read | 冲突列表 |
| POST | `/api/v1/sync/conflicts/{id}/resolve` | 对应 write | `action=keep-db|keep-file|dismiss` |

## 3. 分页与字段筛选

`GET /api/v1/tasks?project=<id>&limit=20&offset=0` 按项目列任务。项目参数接受项目根 ID 或其计划 ID。
项目关联与任务读取权限先于分页应用，`meta.pagination.total` 只统计可见任务。

- `POST /api/v1/tasks` 支持可选的 `project_id`。项目关联和创建同事务提交。
- `POST /api/v1/tasks/{id}/link` 与 `/unlink` 接收 `{"project_id":"…" }`，
  返回 `data.project_id`、`data.task_id`、`data.linked`。重复设定同一关系状态可安全重试。
- 项目任务写入在事务内验证项目与任务权限。携带幂等键的重放仍检查当前权限。
  关联请求若在提交后、响应缓存完成前中断，返回恢复冲突，可用项目列表确认关系。
- Breaking Change: No。新路由和可选参数，原未指定项目的任务契约继续有效。

- `limit` 默认 20（最大 200），`offset` 最大 10000；响应 `meta.pagination`。
- GET 的 `fields=a,b` 保留 `data` 对象或列表各项的指定字段，分页信息仍在 `meta.pagination`。
  非空结果上的未知字段、空字段或超过 50 个字段返回 400。空列表仍返回空列表。
  例如 `GET /api/v1/tasks?limit=10&fields=id,title,status,revision`。
- 上下文的 `format=compact_json` 省略 Markdown，`format=markdown` 仅返回 Markdown 字段。
  `fields` 在预算裁剪后应用。只需一种表示时应先指定 `format`。
- 兼容性：省略新增格式或字段筛选时，响应结构保持原样。有效的 `fields` 现在生效，
  无效值会报错。固定内容已超过上下文预算时返回 400。

## 4. 幂等

写请求可带 `Idempotency-Key`（≤128 字符）：
- 首次执行 → 存 `agent_request_cache`（24h）。
- 相同 key + 相同请求体 → 返回首次响应（含原状态码），`meta.replayed=true`。
- 相同 key + 不同请求体 → `409 CONFLICT`（不复用他人结果）。

## 5. OpenAPI

`GET /api/v1/openapi.json` 返回静态生成的 OpenAPI 3.0（路径、参数、响应 schema、错误码）。
不包含示例 token、不包含内部字段说明。手工维护于 `agent_access::rest::openapi_document()`，
与实际路由共用同一路由表常量，避免文档漂移（测试校验路径集合一致）。

## 6. 安全约束

- 只绑定 loopback；`agent_api_enabled=false` 时不监听端口。
- 拒绝 `Origin` 头；不返回 `Access-Control-Allow-*`。
- 不记录 body、token、上下文正文；日志只有方法/路径/状态/耗时/request_id。
- 无能力 → 403 且写 `agent_activity_logs(error_code=FORBIDDEN)`；不降级执行。

## `POST /api/v1/projects`（2026-11-21）

```http
POST /api/v1/projects
Authorization: Bearer <token>
Idempotency-Key: <可选>
Content-Type: application/json

{
  "clientRequestId": "可选，等价于 requestId",
  "name": "项目名",
  "kind": "general",
  "description": "…",
  "goal": "…",
  "targetDate": "2026-12-31",
  "templateId": "…",
  "rootPath": "D:////Projects////demo",
  "directoryMode": "metadata_only | attach_existing",
  "note": "…",
  "initialPlan": { "phases": [], "features": [], "tasks": [], "goals": [], "capabilities": [] }
}
```

- 权限：`projects.create`；`scope=readonly` 直接 403；创建后只授予新项目根；
- **拒绝 `directoryMode=create_new`**：REST 不代任何客户端写文件系统，请由人类在 UI/CLI 创建目录；
- 响应 201：`{ created, project, activePlan, workspace, provisioningStatus }`；
- 幂等：`Idempotency-Key` 走既有缓存；`clientRequestId` 与 UI/MCP/CLI 共用同一摘要；
- 仍只监听 loopback，未新增任何公网暴露面。

## 专业领域端点（2026-11-23，Phase 1）

| 方法 | 路径 | 能力 | 说明 |
|---|---|---|---|
| GET | `/api/v1/projects/{projectId}/domain-manifest` | `projects.read` + 项目 grant | 授权 Manifest；`project.kind` 为真实类型 |
| GET | `/api/v1/projects/{projectId}/novel/chapters` | `projects.read` | 分页；不含正文 |
| GET | `/api/v1/projects/{projectId}/novel/chapters/{chapterId}` | `projects.read` | 元信息 + `revision`/`updatedAt` |
| GET | `/api/v1/projects/{projectId}/novel/chapters/{chapterId}/content` | `projects.read` | 正文 + `revision`/`updatedAt` |
| PUT | `/api/v1/projects/{projectId}/novel/chapters/{chapterId}/content` | `projects.write` | body `{content, expected_revision}` |
| GET | `/api/v1/projects/{projectId}/novel/{characters\|worldview\|refs}` | `projects.read` | 分页 |
| GET | `/api/v1/projects/{projectId}/comic/{episodes\|shots\|media-versions\|characters\|scenes}` | `projects.read` | 分页；剧集不含 script |
| GET | `/api/v1/projects/{projectId}/comic/media-versions/{mediaId}` | `projects.read` | 素材详情 + revision + 安全文件引用 |
| PUT | `/api/v1/projects/{projectId}/comic/media-versions/{mediaId}` | `projects.write` | body `{version_label, status?, review_note?, expected_revision}` |
| POST | `/api/v1/projects/{projectId}/comic/media-versions/{mediaId}/adopt` | `projects.write` | body `{expected_revision}` |

约定：

- 领域请求体与既有 REST 一致使用 **snake_case**（`expected_revision`）。
- **PUT 支持 `Idempotency-Key`**（与 POST 相同：同 Key 同 body 重放原结果；同 Key 不同 body 409）。
  PATCH/GET 不支持幂等键。`traceRequestId`（`X-Request-Id`）只用于追踪，不能替代幂等键。
- 一次 PUT/POST 只产生一条 `agent_operations`，`resource_id` 为章节/素材 ID，`project_id` 为项目根。
- 业务提交后响应缓存前崩溃：重试按 operation 指针恢复 `novel.chapter` / `comic.media_version`，
  不重新执行业务，也不推进 revision。
- 分页字段沿用 `limit` / `offset` / `total` / `has_more` / `next_offset`；默认 50、最大 200。

## 游戏、通用、开发领域端点（2026-11-24）

新增路径与对应操作见[功能矩阵](feature-matrix.md#游戏通用开发领域2026-11-24)。
GET 列表使用 `limit` / `offset`，任务证据列表额外使用 `task_id`。
新增 POST 需要有效的 `Idempotency-Key`，业务入参直接放在 JSON 对象中，字段使用 snake_case。

| POST 路径后缀 | 必填业务字段 | 可选业务字段 |
|---|---|---|
| `game/builds` | `target`、`status` | `engine`、`config`、`built_at`、`log_summary`、`item_id`、`note` |
| `game/tests` | `title`、`result` | `build_id`、`scope`、`tested_at`、`summary`、`defect_count`、`item_id`、`note` |
| `general/milestones` | `title` | `target_date`、`status`、`note`、`sort_order`。更新另需 `id`、`expected_revision` |
| `development/task-links` | `task_id`，以及 `handoff_pack_id`、`acceptance_record_id` 至少一个 | `note` |

写入响应为统一信封，`data` 为创建或更新的对象。项目授权撤销后拒绝查询或重放。
现有路径和响应契约保持兼容。
