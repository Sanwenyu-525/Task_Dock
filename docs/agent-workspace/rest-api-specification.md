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
| GET | `/api/v1/context` | `context.read` | `project_id`/`task_id`/`q`/`budget`/`format` |
| GET | `/api/v1/context/search` | `context.read` | 同上，`q` 必填 |
| POST | `/api/v1/context` | `context.read` | body 里的 scope（避免超长 query） |
| GET | `/api/v1/agents/handoffs` | `handoffs.read` | `status`/`limit` |
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

- `limit` 默认 20（最大 200），`offset` 最大 10000；响应 `meta.pagination`。
- `fields=a,b` 过滤返回字段（未知字段 → 400），用于减少上下文占用。

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
