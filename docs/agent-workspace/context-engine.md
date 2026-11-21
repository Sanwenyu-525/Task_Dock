# Context Engine

目标：Agent 不遍历整个工作空间，也能拿到**与当前工作相关**的最小充分上下文。

## 1. 输入

| 参数 | 说明 |
|---|---|
| `query` | 自然语言任务描述（可空，空则用项目/任务范围） |
| `project_id` / `workspace_project_id` | 限定项目 |
| `task_id` | 以可读任务为目标。自动选择其关联项目，也可显式指定关联项目 |
| `agent_id` | 当前 Agent 身份（用于过滤其交接与活动） |
| `kinds` | 需要的内容类型（task/plan/knowledge/decision/skill/handoff/activity） |
| `budget_tokens` | 可选上限，默认 6000，最大 24000 |
| `format` | `compact_json` 仅结构化数据，`markdown` 仅文本，旧版 `json` 同时附带两种表示 |

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
- `format=compact_json` 适合程序消费，保留 `items[]`、`recent_changes[]`、目标、约束及预算信息。
- 已有调用继续使用旧版格式。CLI 使用 `--json` 时，只有显式选择 `--format compact_json` 才会省略 Markdown。

## 6. 检索策略阶段

- 阶段一（本轮）：SQLite LIKE + 分块 + 标题/标签/状态/时间加权；可解释、无外部依赖。
- 阶段二（未实现）：向量/语义与混合重排；需要外部模型与索引，先不做（避免为了 AI 而 AI）。

## 7. 授权与装配（v81 修订）

### 7.1 分权原则

- `ContextRead` 是装配入口的必要条件；
- 每种资源再按自己的读能力过滤：没有 `TasksRead` 就不返回任务，**而不是整次请求失败**；
- 显式请求未授权资源 → 明确的 `FORBIDDEN`（不静默返回空）；
- 默认上下文允许「部分结果」，但绝不跨项目/跨权限回退到全局数据。

能力与类型的对应：plan→`plans.read`、task→`tasks.read`、knowledge→`knowledge.read`、
decision→`decisions.read`、skill→`skills.read`、handoff→`handoffs.read`。
判定同时接受「全局授权」与「当前项目上的授权」。

### 7.2 装配流水线（实现函数名）

```
resolve_context_scope()        项目存在性 + 项目可访问性 + 目标 + 关键词
resolve_authorized_kinds()     按能力与项目范围决定可返回的类型
collect_context_candidates()   分类收集候选（plan/task/knowledge/decision/skill/handoff）
filter_context_by_permission() 权限兜底过滤
rank_context_candidates()      相关性排序
deduplicate_context_candidates() 同 (kind, source_id) 去重
apply_context_budget()         按估算 token 截断，返回 truncated/estimated_tokens/kept_items
retrieve_recent_changes()      按业务关联（任务/知识/决策/交接/规划）取近期变更并再过滤
serialize_context_result()     Markdown / JSON 输出
record_context_access()        只记规模
```

### 7.3 项目范围

- 显式项目：必须存在且 Agent 有权访问（任一读能力在全局或该项目上授权）；
- 显式任务：`context.read` 和目标任务的读取授权都通过后才装配。单任务授权可沿真实的
  `workspace_task_links` 进入该任务的上下文。任务关联多个项目时优先使用最近关联的可读项目，
  同一时间按项目 ID 排序。无项目关联的任务不借用默认项目。
- 同时传入项目与任务时，两者必须确有关联。目标任务无读取授权返回 `FORBIDDEN`，已授权任务
  与指定项目不匹配返回 `VALIDATION`。关联只限定装配范围，项目名称、规划和其他任务分别校验权限。
- 默认项目：只在 Agent 可访问的项目中选择；都不可访问时按「无项目」处理，不取全局数据。
- 显式目标直接按 ID 纳入候选，不受任务列表的 200 条上限影响。最终输出仍受 token 预算限制。

CLI `context get --task-id`、MCP `taskdock_get_relevant_context` 和 REST `GET /api/v1/context?task_id=…`
共享上面的判定。请求与响应结构保持兼容。行为收紧涉及显式无权任务和不匹配的项目参数
（Breaking Change: Yes），调用方应处理 `FORBIDDEN` 和 `VALIDATION`。

### 7.4 近期变更

不再用 `resource_id = project_id` 近似匹配。改为按既有业务关联查找该项目的任务、知识文档、
决策、交接与规划元素，再与版本表 `agent_resource_revisions` 求交集，并再次按权限过滤。

### 7.5 预算

预算按所选表示估算。双份 JSON 会计入附带的 Markdown，紧凑 JSON 只估算结构化响应。文件投影、
MCP 资源和提示以 Markdown 估算。固定内容先占预算，正文和近期变更共享剩余额度，按优先级裁剪。
如果只有固定内容仍装不下，请求返回 `VALIDATION`，调用方可提高预算或缩小范围。
`estimated_tokens` 是含响应余量的本地估算值，实际模型分词与计费随客户端和模型变化。

### 7.6 中文检索

关键词抽取对中文按**双字切片**（2-gram）处理，避免整句中文变成一个无法命中的「词」；
英文仍按空白切词。评分仍为可解释的标题/正文命中 + 时间新鲜度。
