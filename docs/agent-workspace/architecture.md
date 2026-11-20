# 架构设计

## 1. 分层

```
外部 Agent（Claude / Codex / Gemini / 任意能执行命令或发 HTTP 的进程）
        │
        ├── CLI:  taskdock.exe（独立 console 可执行文件，直接调用统一服务层）
        ├── MCP:  taskdock.exe --mcp-server  →(stdio JSON-RPC)→ 主进程 loopback /mcp
        ├── REST: http://127.0.0.1:<port>/api/v1/...（主进程 loopback，Bearer agent token）
        └── 文件:  TaskDock-Agent-Workspace/（投影 + 受控导入，经同步服务）
                                │
                    ┌───────────┴───────────┐
                    │  Agent Access Layer    │  权限校验 / 审计 / 版本与冲突 / 来源标注
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │  Unified Service Layer │  agent_access::service
                    └───────────┬───────────┘
                                │
        ┌───────────────┬───────┴────────┬────────────────┐
   planning 服务    tasks 服务     knowledge 服务    新建：decisions / handoffs
        └───────────────┴────────────────┴────────────────┘
                                │
                          SQLite（唯一事实来源）
                                │
                          TaskDock UI
```

**硬约束**：CLI / MCP / REST / 文件四个入口不允许各写一套 SQL。四个入口只能调用
`agent_access::service`（内部再调用既有 `*_impl`）或 `agent_access::handoff/store`（新增实体）。

## 2. 一次外部写入的固定管线

```
1. 解析身份      CLI: env TASKDOCK_AGENT_TOKEN；MCP/REST: Bearer token
2. 解析能力      permissions::require(principal, capability, scope{project|resource})
3. 读取基线      service 返回 {data, revision, updated_at}
4. 版本校验      调用方提交 base_revision（+ 可选 base_updated_at）
                 不一致 → AppError::Conflict(当前 revision 与摘要)，不落库
5. 业务写入      复用既有 *_impl（事务内完成业务 + activity）
6. 版本推进      agent_resource_revisions += 1，记录 updated_by / source / content_hash
7. 审计          写 agent_activity_logs（成功/失败、接口、对象、revision、request_id；无正文）
8. 投影          标记该资源为「待导出」，同步任务在下一个周期写出（不在请求线程里写文件）
```

写入在请求路径上**不同步写文件**：避免长 IO 阻塞与同步环。投影由 `sync::export_dirty` 异步完成。

## 3. 来源（source）判定

| 来源 | 值 | 判定方式 |
|---|---|---|
| UI | `ui` | Tauri 命令调用（`Principal::Local`） |
| CLI | `cli` | `taskdock` 可执行文件 |
| MCP | `mcp` | loopback `/mcp` 工具调用 |
| REST | `rest` | loopback `/api/v1` |
| 文件 | `file` | 同步服务导入，`force_source=file` |
| 系统 | `system` | 迁移/修复/初始化 |

来源只由服务端根据**入口**决定，调用方不能通过参数伪造（REST 忽略 body 里的 `source`）。

## 4. 文件投影与同步（不产生回环）

```
DB ──export──▶ 文件（记录 exported_hash + exported_revision 到 agent_workspace_files）
                    │
              （Agent 手动编辑 / 外部写入）
                    ▼
文件 ──scan──▶ 计算 hash：== exported_hash → 跳过（自身写入，不导入）
                        != exported_hash → 候选导入
                                          │
                        DB revision == exported_revision ? → 安全导入
                                                          : → 写冲突记录，不覆盖
```

- 文件监听是**轮询 + 有界变更集**（默认 20s，上限 200 文件/轮），不做 OS hook。
- 只扫描协议允许的目录（`inbox/`、`tasks/inbox/`、`knowledge/inbox/`）。
- 导出写入前记录 hash 与 revision，因此自身写入不会被误判为外部修改。
- 删除/重命名只更新索引状态，不删除数据库数据；数据库删除也不删除文件（避免不可逆）。

## 5. 并发与一致性

- SQLite 单写连接 + WAL：同进程内写事务串行；CLI 独立进程用 `busy_timeout=5s`。
- 所有外部写要求 `base_revision`；不一致返回 409/`Conflict`，携带当前 revision。
- MCP 已有工具保持 `expected_revision` 语义不变；新增工具沿用同一规则。
- REST 写接口支持 `Idempotency-Key`：命中 `agent_request_cache` 直接返回首次结果。

## 6. 上下文装配（Context Engine）

> **记法更正（2026-11-20，第二轮架构审计）**：本节原记 `build_agent_context(query|project|task|plan|agent, budget, kinds)` 为设计稿伪签名，该名称在 Rust/TS 源码中**不存在**（全仓仅本文一处）。真实入口是
> `agent_access::context::build(db, principal, req)`（`src-tauri/src/agent_access/context.rs:1022`），
> 入参为结构体 `ContextRequest { task, task_id, project_id, agent_id, session_id, budget_tokens, kinds, format }`，
> 预算常量 `DEFAULT_BUDGET=6000` / `MAX_BUDGET=24000`（clamp 1000–24000）。
> 下列流水线描述仍为**目标态设计**：已实现的部分为 7 类来源检索、权限过滤、中文 2-gram 抽词、
> 去重与预算裁剪；「打分/relevance 排序」等为未来扩展，引用时以下方真实签名为准。

真实入口 `agent_access::context::build(db, principal, req)`：
范围解析 → 多源检索（任务/规划/知识/决策/Skill/交接/近期变更）→ 打分 → 去重 → 预算裁剪
→ Markdown / JSON 输出。每条内容带 `source_id / source_kind / updated_at / relevance / summary /
uri`，不把推测写成事实。详见 [context-engine.md](context-engine.md)。

## 7. UI 与管理面

能力中心新增「Agent 接入」子页（接入状态 / 权限 / 活动 / 交接 / 同步），复用 `cap-*` 语义样式与
既有组件；不复制 MCP 管理页，只在设置页保留 MCP Server 端开关，在本页提供统一视图与操作。

## 8. 生命周期

- REST 服务与文件监听只在设置开启时启动，设置变更即时生效（与 MCP bridge 同一模式）。
- 监听线程有取消标志与最大生命周期；退出时 join，不留下孤儿线程。
- 所有后台任务有上限（并发 1、每轮文件数上限、单文件大小上限）。
