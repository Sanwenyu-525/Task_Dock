# TaskDock Agent 共享工作空间

TaskDock 不只是「人类用的任务面板」，也是 **Human + Agent Shared Workspace**：人类在 UI 里管理，
Agent 通过 CLI / MCP / REST / 受控文件目录访问**同一套数据**。

## 文档索引

| 文档 | 内容 |
|---|---|
| [code-audit.md](code-audit.md) | 开发前代码审计：已有能力、可复用服务、缺失能力、冲突与风险 |
| [architecture.md](architecture.md) | 统一 Agent Access Layer、分层与数据流 |
| [feature-matrix.md](feature-matrix.md) | 模块 × 接口能力矩阵与实现状态 |
| [data-model.md](data-model.md) | 新增表、字段、约束、索引、迁移与删除策略 |
| [workspace-protocol.md](workspace-protocol.md) | 文件目录协议、manifest、导入导出与验证规则 |
| [synchronization.md](synchronization.md) | 同步状态机、来源判定、冲突与重试 |
| [cli-specification.md](cli-specification.md) | `taskdock` 命令、JSON 协议、退出码、安装 |
| [mcp-specification.md](mcp-specification.md) | MCP Tools / Resources / Prompts 与传输 |
| [rest-api-specification.md](rest-api-specification.md) | `/api/v1` 端点、认证、分页、限流、幂等、OpenAPI |
| [context-engine.md](context-engine.md) | 上下文装配、检索、排序、预算与输出 |
| [handoff-protocol.md](handoff-protocol.md) | 跨 Agent 交接、工作报告、状态机 |
| [permission-model.md](permission-model.md) | 身份、能力、项目/资源范围、Token 生命周期 |
| [security.md](security.md) | 攻击面、可信边界、不可信输入处理、日志脱敏 |
| [development-progress.md](development-progress.md) | 分阶段进度（未实现/部分实现/已完成/已验收） |
| [test-plan.md](test-plan.md) | 测试项、命令、数据规模与证据要求 |
| [acceptance-report.md](acceptance-report.md) | 端到端验收记录与结论 |
| [phase1-domain-acceptance.md](phase1-domain-acceptance.md) | Novel + Comic Phase 1 架构修复验收报告 |

## 一句话设计

```
CLI / MCP / REST / 文件  →  Agent Access Layer（权限 → 审计 → 版本）
                        →  Unified Service Layer（复用 planning/tasks/knowledge 既有 *_impl）
                        →  SQLite（唯一事实来源）  →  TaskDock UI
```

四个入口**不各自实现业务逻辑**：读写全部落到 `agent_access::service`，它再调用既有的
`commands::planning` / `commands::tasks` / `capability::knowledge` 服务函数。

## 不可违反的边界

1. 外部 Agent 不直接读写 SQLite：CLI 是 TaskDock 自己的可执行文件，走同一服务层；MCP/REST 经
   loopback 主进程。
2. 文件接口只做**受控投影与受控导入**，不接受「改任意文件即改库」。
3. 所有外部写入带来源（`source=cli|mcp|rest|file`）、Agent 身份、目标 revision 与审计记录。
4. 读取与写入权限分离，默认只读；删除默认关闭。
5. 远程访问默认关闭且 v1 未实现（见 [security.md](security.md)）。
