# 功能矩阵（模块 × 接口）

状态标记：**已实现** = 代码完成且有测试；**部分** = 已实现但有限制；**未实现** = 仅有文档或空壳。

| 模块 | CLI | MCP | REST | 文件 | 说明 |
|---|---|---|---|---|---|
| 项目查询 | 已实现 | 已实现（`taskdock_list_projects`） | 已实现 | 已实现（投影） | 规划项目 + 项目工作空间 |
| 项目状态 | 已实现 | 已实现（`taskdock_get_project_status`） | 已实现 | 已实现 | 进度/功能计数/风险 |
| 任务查询 | 已实现 | 已实现（`taskdock_list_tasks`） | 已实现 | 已实现 | 筛选/分页/字段筛选 |
| 创建任务 | 已实现 | 已实现（`taskdock_create_task`） | 已实现 | 受控导入 | 文件写入 `tasks/inbox/*.json` 或 `.md` |
| 修改任务 | 已实现 | 已实现（`taskdock_update_task`） | 已实现（PATCH） | 受控导入 | 必须带 `base_revision` |
| 完成任务 | 已实现 | 已实现（`taskdock_complete_task`） | 已实现 | 受控导入 | 走 `update_task_inner`，保留完成事件 |
| 规划查询 | 已实现 | 已实现（`taskdock_list_plans` 等） | 已实现 | 已实现 | 里程碑/功能/步骤/活动 |
| 知识检索 | 已实现 | 已实现（`taskdock_search_knowledge`） | 已实现 | 已实现 | 复用分块检索 |
| 知识写入 | 已实现 | 已实现（`taskdock_create_knowledge`） | 已实现 | 受控导入 | 需 `knowledge.write` |
| 决策记录 | 已实现 | 已实现（`taskdock_create_decision` 等） | 已实现 | 已实现 + 导入 | 新表 `agent_decisions` |
| Skill 查询 | 已实现 | 已实现（`taskdock_list_skills`） | 已实现 | 已实现（索引） | 只读 |
| 上下文获取 | 已实现 | 已实现（3 个 context 工具） | 已实现 | 已实现 | Context Engine |
| Agent 工作记录 | 已实现 | 已实现（活动由工具自动记录） | 已实现（`/agents/activity`） | 已实现（registry/sessions） | 只读为主 |
| 交接 | 已实现 | 已实现（create/get/list/submit_report） | 已实现 | 已实现 + 导入 | 状态机见 handoff 文档 |
| 版本历史 | 已实现 | 已实现（`revision` 字段 + 冲突错误） | 已实现 | 已实现（导出） | 单表计数器 + updated_at 双校验 |
| 搜索 | 已实现 | 已实现（`taskdock_search`） | 已实现 | 已实现 | 跨任务/知识/决策 |
| 同步状态 | 已实现 | 未开放（MCP 不暴露同步写） | 已实现（`/sync/*`） | 已实现 | 文件接口需要明确动作 |
| 删除 | **未实现（默认关闭）** | 未实现 | 未实现 | 未实现 | 破坏性能力不在本轮开放 |
| 远程访问 | 未实现 | 未实现 | 未实现（设置项仅展示为未开放） | 未实现 | 只在 loopback |

## 权限矩阵（能力 → 接口）

| 能力 | CLI | MCP | REST | 文件导入 |
|---|---|---|---|---|
| `projects.read` | ✓ | ✓ | ✓ | ✓ |
| `tasks.read` / `tasks.write` | ✓ | ✓ | ✓ | 写需 write |
| `plans.read` | ✓ | ✓ | ✓ | ✓ |
| `knowledge.read` / `knowledge.write` | ✓ | ✓ | ✓ | 写需 write |
| `decisions.read` / `decisions.write` | ✓ | ✓ | ✓ | 写需 write |
| `context.read` | ✓ | ✓ | ✓ | ✓ |
| `handoffs.read` / `handoffs.write` | ✓ | ✓ | ✓ | 写需 write |
| `skills.read` | ✓ | ✓ | ✓ | ✓ |

默认新建 Agent 为 `disabled` + 无能力；UI 逐个授予。CLI 由本机用户直接执行时视为 `local`
（等价 UI 权限），仍写审计；设置 `TASKDOCK_CLI_READONLY=1` 可强制只读。

## 增强能力评估（第十九节）

| 能力 | 结论 | 理由 |
|---|---|---|
| Agent 自动发现 Workspace | 已实现（文件 + manifest） | manifest 携带 protocol/端口/CLI 路径，足够发现 |
| 自动生成接入说明 | 已实现 | manifest 的 `interfaces` + UI 复制接入说明 |
| 多 Agent 共享工作记忆 | 部分 | 交接 + 上下文 + 活动记录；不做实时消息总线 |
| Agent 间消息传递 | 未实现 | 需要长连接/推送，超出本轮，交接轮询已够用 |
| 成果自动归档 | 部分 | 工作报告 + 导出目录；不做自动清理 |
| 任务变更通知 | 未实现（计划） | 需要事件订阅；当前用 `planning-changed` 到 UI |
| Agent 订阅项目事件 | 未实现 | 同上，避免引入长连接 |
| 任务认领与锁定 | 未实现 | 需要租约与超时回收；先靠 revision + 交接归属 |
| 上下文快照 | 已实现 | `context/current.md` + `exports/` |
| 关键决策自动提取 | 未实现 | 需要模型判断，易把推测当事实，不做 |
| 知识贡献质量评分 | 未实现 | 无客观口径 |
| 过期知识提醒 | 未实现 | 可在后续用 `updated_at` 阈值做只读提示 |
| 重复知识检测 | 部分 | 写入时按 `content_hash` 判重并返回已存在文档 |
| Agent 成果版本比较 | 部分 | 交接/报告有 revision 与历史行；无 diff 视图 |
| 跨项目知识复用 | 已实现 | 知识库可跨项目检索（`kb_ids` 过滤） |
| 通用 Workspace 协议 | 已实现 | `manifest` + 协议版本 + 文件布局，其他软件可只读接入 |
