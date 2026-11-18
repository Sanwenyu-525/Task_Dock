# 权限模型

## 1. 身份

唯一身份真源：`mcp_agents`（沿用 MCP 已有表）。

| 字段 | 含义 |
|---|---|
| `agent_id` | 稳定标识（字母/数字/`-`/`_`/`.`，≤64） |
| `display_name` | 展示名 |
| `vendor` / `interface_hint` / `note` | 厂商、接入方式提示、备注（v76 新增） |
| `scope` | `disabled` / `readonly` / `project_rw`（既有语义不变） |
| `token_hash` | SHA-256；明文只在创建/轮换返回值出现一次 |
| `revoked_at` | 非空即失效（每次请求重读，无缓存窗口） |

`scope` 决定「能否调用写工具」；能力表决定「能触达哪些资源」。**两层都满足才放行**。

## 2. 能力（capability）

| 能力 | 读/写 | 资源范围 |
|---|---|---|
| `projects.read` | 读 | 全局 |
| `tasks.read` / `tasks.write` | 读/写 | 全局或单个任务（`resource_id`） |
| `plans.read` | 读 | 全局或单项目 |
| `knowledge.read` / `knowledge.write` | 读/写 | 全局或单知识库 |
| `decisions.read` / `decisions.write` | 读/写 | 全局或单项目 |
| `context.read` | 读 | 全局 |
| `handoffs.read` / `handoffs.write` | 读/写 | 全局或单项目 |
| `skills.read` | 读 | 全局 |
| `notes.*` / `workflows.read` / `workspace.read` | 既有 | 既有规则不变 |

默认策略：新建 Agent = `disabled` + 无能力 → 全部拒绝。UI 必须显式授予。

## 3. 判定顺序

```
1. 身份存在且未撤销         → 否则 UNAUTHORIZED
2. scope 允许该操作类别      → disabled 一律拒绝；只读不允许写
3. 能力存在（全局或资源级）  → 否则 FORBIDDEN（记 permission_denial 审计）
4. 项目范围（如适用）        → project_rw 还需项目授权 grant
5. 资源归属（备注/任务）     → 仅能写自己创建的资源（若配置了 ownership）
```

任何一层失败都**明确拒绝**，不降级、不回退到只读执行。

## 4. 本地主体（Local Principal）

CLI 未提供 token 时，操作者是本机用户，等同于 UI：
- 读写全量（删除能力仍未开放）；
- 审计 `actor_kind=local`、`agent_id=""`；
- `TASKDOCK_CLI_READONLY=1` 强制只读。
理由：本机用户本就能直接改数据库/UI；把 CLI 视为「另一个 UI」比伪造一套用户体系更诚实。
风险与边界见 [security.md](security.md)。

## 5. Token 生命周期

- 生成：`tdm_` + 256 bit OS 随机；库内只存 SHA-256。
- 轮换：`rotate_agent_token` 立即替换哈希，旧 token 失效（无过渡期）。
- 撤销：`revoked_at` 置时间；所有接口下一次请求即拒绝。
- 存储：只在用户侧配置文件/环境变量；禁止写入日志、审计 detail、导出文件、manifest。
- 泄露处置：UI 一键轮换；审计可按 `agent_id` 过滤异常调用。

## 6. 权限授予（UI）

接入管理页逐项操作：scope、能力（复选框）、项目授权、文件工作区根目录（既有）。
每次变更写审计；变更后无需重启，下一次请求即生效。

## 7. 远程访问

- Agent API 默认只监听 loopback。
- 远程访问**未实现**；设置项存在但显示「未开放」，避免用户误以为已提供安全远程通道。
- 任何未来实现都必须：独立开关、独立端口、强制 TLS、独立授权、默认关闭。
