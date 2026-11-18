# Context Engine

目标：Agent 不遍历整个工作空间，也能拿到**与当前工作相关**的最小充分上下文。

## 1. 输入

| 参数 | 说明 |
|---|---|
| `query` | 自然语言任务描述（可空，空则用项目/任务范围） |
| `project_id` / `workspace_project_id` | 限定项目 |
| `task_id` | 限定任务（自动带入其项目/分类/标签） |
| `agent_id` | 当前 Agent 身份（用于过滤其交接与活动） |
| `kinds` | 需要的内容类型（task/plan/knowledge/decision/skill/handoff/activity） |
| `budget_tokens` | 可选上限，默认 6000，最大 24000 |
| `format` | `markdown` / `json` |

## 2. 流程

```
resolve_context_scope()        规范化输入；确定 project/task 范围（缺失时取当前项目）
resolve_current_project()      UI 当前项目 → 最近活跃项目 → 无（显式返回 null，不猜）
retrieve_relevant_tasks()      项目关联 / 关键词 / 逾期 / 进行中
retrieve_relevant_plans()      里程碑 + 功能 + 步骤 + 最近活动
retrieve_relevant_knowledge()  knowledge::search_in_conn（标题/分块 LIKE 排序）
retrieve_related_decisions()   项目决策 + 关键词命中
retrieve_relevant_skills()     capability_skills（enabled + 作用域匹配）
retrieve_active_agent_work()   pending/accepted 交接 + 近期活动（不复制正文）
retrieve_recent_changes()      tasks/decisions/knowledge/handoff 的近期 updated_at
rank_context_items()           打分（见 §3）
deduplicate_context_items()    同 resource_id 去重；同 title+hash 的知识去重
apply_context_budget()         按分数降序累加估算 token，超出即截断（不是按数组长度粗暴切）
serialize_context_markdown() / serialize_context_json()
record_context_access()        写 agent_context_access_logs（只记规模）
```

## 3. 排序打分（可解释）

| 因子 | 权重 | 说明 |
|---|---|---|
| 显式范围命中 | +40 | 与 project_id/task_id 直接关联 |
| 关键词命中（标题） | +25 | 标题包含查询词（大小写不敏感） |
| 关键词命中（正文） | +12 | 分块命中 |
| 状态相关 | +10 | 进行中/阻塞/待办优先于已完成 |
| 时间相关 | +8 | updated_at 越近越高（7 天内满分，30 天衰减） |
| 同一来源多命中 | +4 | 文档多个分块命中 |
| 决策已接受 | +6 | accepted 决策比 proposed 更可作为约束 |
| 交接待处理 | +8 | pending/accepted 优先 |

同分按 `updated_at` 降序；再按 `resource_id` 稳定排序（结果可复现）。

## 4. 输出结构（Markdown）

```markdown
# TaskDock Agent Context

> 生成时间 / 项目 / 预算 / 条目数 / 来源接口

## Project
## Current Objective
## Relevant Tasks
## Current Plan
## Architecture
## Decisions
## Knowledge
## Skills
## Active Work
## Constraints
## Recent Changes
## Suggested Next Steps
```

每条内容至少包含：`source_id`、`source_kind`、`updated_at`、`relevance`、摘要、原始访问方式
（CLI 命令 / MCP tool / REST 路径 / 文件路径）。

## 5. 质量约束

- 不把推测写成事实：`Suggested Next Steps` 由规则生成（未完成步骤、阻塞项、待处理交接），
  并显式标注「基于规则生成的建议」。
- 预算不足时优先保留：项目、目标、约束、已接受决策、当前计划；舍弃低分知识片段。
- 空结果不编造：返回空分区并说明「未找到相关 X」。
- `format=json` 时结构与 Markdown 一一对应（`sections[].items[]`），便于程序消费。

## 6. 检索策略阶段

- 阶段一（本轮）：SQLite LIKE + 分块 + 标题/标签/状态/时间加权；可解释、无外部依赖。
- 阶段二（未实现）：向量/语义与混合重排；需要外部模型与索引，先不做（避免为了 AI 而 AI）。
