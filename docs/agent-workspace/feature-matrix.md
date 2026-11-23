# 功能矩阵（模块 × 接口）

状态标记：**已实现** = 代码完成且有测试；**部分** = 已实现但有限制；**未实现** = 仅有文档或空壳。

| 模块 | CLI | MCP | REST | 文件 | 说明 |
|---|---|---|---|---|---|
| 项目查询 | 已实现 | 已实现（`taskdock_list_projects`） | 已实现 | 已实现（投影） | 规划项目 + 项目工作空间 |
| 项目状态 | 已实现 | 已实现（`taskdock_get_project_status`） | 已实现 | 已实现 | 进度/功能计数/风险 |
| 任务查询 | 已实现（含项目分页） | 已实现（`taskdock_list_tasks`，含项目分页） | 已实现（含项目分页） | 已实现 | 项目与任务授权交集先于分页 |
| 创建任务 | 已实现（可关联项目） | 已实现（`taskdock_create_task`，可关联项目） | 已实现（可关联项目） | 受控导入 | 创建与项目关联同事务 |
| 已有任务关联/解绑 | 已实现 | 已实现 | 已实现 | 未开放 | 双重授权，重复设置关系幂等 |
| 修改任务 | 已实现 | 已实现（`taskdock_update_task`） | 已实现（PATCH） | 受控导入 | 必须带 `base_revision` |
| 完成任务 | 已实现 | 已实现（`taskdock_complete_task`） | 已实现 | 受控导入 | 走 `update_task_inner`，保留完成事件 |
| 规划查询 | 已实现 | 已实现（`taskdock_list_plans` 等） | 已实现 | 已实现 | 里程碑/功能/步骤/活动 |
| 计划管理、里程碑编辑 | 仅项目创建时带初始计划 | 已实现 | 仅项目创建与计划执行状态更新 | 未开放 | MCP 可新增、激活、归档、恢复计划，创建和修改里程碑 |
| 项目结项检查与归档 | 可修改归档状态 | 已实现（带结项检查） | 可修改归档状态 | 未开放 | MCP 在同一事务复查阻塞后归档 |
| 知识检索 | 已实现 | 已实现（`taskdock_search_knowledge`） | 已实现 | 已实现 | 复用分块检索 |
| 知识写入 | 已实现 | 已实现（`taskdock_create_knowledge`） | 已实现 | 受控导入 | 需 `knowledge.write` |
| 决策记录 | 已实现 | 已实现（`taskdock_create_decision` 等） | 已实现 | 已实现 + 导入 | 新表 `agent_decisions` |
| Skill 查询 | 已实现 | 已实现（`taskdock_list_skills`） | 已实现 | 已实现（索引） | 只读 |
| 上下文获取 | 已实现 | 已实现（3 个 context 工具） | 已实现 | 已实现 | Context Engine |
| Agent 工作记录 | 已实现 | 已实现（活动由工具自动记录） | 已实现（`/agents/activity`） | 已实现（registry/sessions） | 只读为主 |
| 交接 | 已实现 | 已实现（创建、读取、流转、报告） | 已实现 | 已实现 + 导入 | 状态机见 handoff 文档 |
| 版本历史 | 已实现 | 已实现（`revision` 字段 + 冲突错误） | 已实现 | 已实现（导出） | 单表计数器 + updated_at 双校验 |
| 搜索 | 已实现 | 已实现（`taskdock_search`） | 已实现 | 已实现 | 跨任务/知识/决策 |
| 同步状态 | 已实现 | 未开放（MCP 不暴露同步写） | 已实现（`/sync/*`） | 已实现 | 文件接口需要明确动作 |
| 小说章节正文 | 已实现 | 已实现（`taskdock_novel_update_chapter_content`） | 已实现（`PUT .../novel/chapters/{id}/content`） | 受控导入（`novel.chapter.content.update`） | 必须带 `base_revision` |
| 漫剧素材元信息/采用 | 已实现 | 已实现（`taskdock_comic_save_media_version` / `..._adopt_media_version`） | 已实现（`PUT .../media-versions/{id}`、`POST .../adopt`） | 受控导入（`comic.media.update` / `comic.media.adopt`） | 采用时被替换版本同事务推进 revision |
| 删除 | **未实现（默认关闭）** | 未实现 | 未实现 | 未实现 | 破坏性能力不在本轮开放 |
| 远程访问 | 未实现 | 未实现 | 未实现（设置项仅展示为未开放） | 未实现 | 只在 loopback |

## 权限矩阵（能力 → 接口）

| 能力 | CLI | MCP | REST | 文件导入 |
|---|---|---|---|---|
| `projects.read` | ✓ | ✓ | ✓ | ✓ |
| `projects.write` | ✓ | ✓（领域写操作） | ✓ | 写需 write（领域导入） |
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

## 统一项目创建（2026-11-21）

| 能力 | 状态 | 说明 |
|---|---|---|
| 项目列表按项目根去重 | 已实现 | 同一项目不再返回「planning + workspace」两行 |
| 项目详情接受计划 ID | 已实现 | 返回 `projectId` / `planId` / `plans`，授权按项目根 |
| 计划列表独立 | 已实现 | `GET /plans` 条目带 `projectId`、`isActive` |
| 四入口共用创建服务 | 已实现 | UI IPC / CLI / MCP / REST 同一事务与幂等 |
| `projects.create` 独立授权 | 已实现 | 无该能力时 `project_rw` 也不能创建 |
| 目录三模式 + 补偿 | 已实现 | `create_new` 仅本机人类：UI 弹窗与未带 token 的 CLI；Agent 在 CLI/MCP/REST 一律拒绝（v92 统一门禁） |
| Agent 文件协议按项目根 | 已实现 | `projects/{projectId}/plans/{planId}/plan.md` |

## 统一授权与幂等归属（2026-11-22，v92）

| 能力 | 状态 | 说明 |
|---|---|---|
| 幂等请求归属隔离 | 已实现 | `project_create_requests`（v92）：同主体重试返回原项目，跨主体相同 requestId 独立创建，无跨 Agent 授权 |
| 授权判定统一 | 已实现 | `require` 四层（身份→scope→capability→grant），CLI/MCP/REST 同规则；`taskdock_update_project` 需 `projects.write` 能力 |
| 项目列表授权过滤 | 已实现 | 全局能力返回全部；项目级授权返回被授权项目；无授权 FORBIDDEN |
| `projects.write` 更新链路 | 已实现 | MCP + REST PATCH + CLI `project update`（第五轮起 `--base-revision` 必填）同走项目根服务（expectedRevision→409） |
| MCP 设置 UI 项目根授权 | 已实现 | 数据源改项目根列表，授权按根 ID 匹配名称；能力清单补齐项目族 |

## Project/Plan 双聚合（2026-11-22，第三轮）

| 能力 | 状态 | 实现锚点 |
|---|---|---|
| 项目根 revision（乐观并发） | 已实现 | `workspace_projects.revision`（v93）+ `update_project_fields_tx` 同事务读→比对→+1；`check_expected_revision_tx` 唯一实现 |
| REST 双聚合端点 | 已实现 | `PATCH /api/v1/projects/{id}`（根聚合，返回 ProjectSummary）+ `PATCH /api/v1/plans/{planId}`（计划聚合，只含执行状态/排序，严格 PlanId，返回 PlanningProject）；旧执行状态传项目端点 → 400 指路 |
| MCP 根读模型 + 计划工具 | 已实现 | `taskdock_list_projects/get_project/update_project` 按项目根（根 revision、activePlanId、plans）；新增 `taskdock_get_plan`/`taskdock_update_plan`；`project_id` 接受旧计划 ID 归一根 |
| CLI project update | 已实现 | `taskdock project update <id> --name/--description/--status active\|archived/--target-date/--base-revision`；走 `perms::require` + `update_project_fields_tx`；操作记录 `project.update` |
| 创建授权单事务 | 已实现 | `agent_access::project_creation::create_for_agent(_in_conn)`：MCP/CLI/REST 三入口共用；授权失败整体回滚；**仅 created=true 授权**，重放不恢复已撤销授权 |
| 幂等 fail-closed | 已实现 | 缺行 ID Agent 创建拒绝；Agent 永不进人类历史兜底；actor/principal 记真实主体 |
| 双 revision 独立性 | 已测试 | 改根只动根 revision；计划只改执行状态只动计划 revision；各自过期分别 409/Conflict |
| 计划 PATCH 边界（第五轮） | 已实现 | 计划更新只接受执行状态/排序；name/description/targetDate 属项目根，REST schema 不接收、MCP 明确拒绝；没有跨聚合写入路径 |
| 版本令牌必填（第五轮） | 已实现 | REST/MCP/CLI/IPC 通用更新入口缺 revision → Validation；空 PATCH → Validation 且 revision 不变 |
| MCP 计划资源身份（第五轮） | 已实现 | `taskdock_update_plan` 审计/操作记录 `resource_kind=plan`、`resource_id=PlanId`、`project_id=根`；`planning-changed` 带 `kind:plan` + `planId` |

## 专业领域 Phase 1（Novel + Comic，2026-11-23）

状态口径：**已实现** = 四入口代码 + 本轮测试；**未开放** = 未注册操作，Manifest 不展示。
Game / General / Development 保持 `planned`，没有空壳 available 操作。

### Novel（7 个操作）

| 操作 | 类型 | MCP 工具 | REST | CLI | 文件导入 |
|---|---|---|---|---|---|
| `novel.chapter.list` | 读（分页） | `taskdock_novel_list_chapters` | `GET .../novel/chapters` | `novel chapter list` | 不适用 |
| `novel.chapter.get` | 读（仅元信息） | `taskdock_novel_get_chapter` | `GET .../novel/chapters/{id}` | `novel chapter get` | 不适用 |
| `novel.chapter.content.read` | 读（正文） | `taskdock_novel_get_chapter_content` | `GET .../novel/chapters/{id}/content` | `novel chapter content` | 不适用 |
| `novel.chapter.content.update` | 写（expectedRevision） | `taskdock_novel_update_chapter_content` | `PUT .../novel/chapters/{id}/content` | `novel chapter update-content` | 支持 |
| `novel.character.list` | 读（分页） | `taskdock_novel_list_characters` | `GET .../novel/characters` | `novel character list` | 不适用 |
| `novel.worldview.list` | 读（分页） | `taskdock_novel_list_worldview` | `GET .../novel/worldview` | `novel worldview list` | 不适用 |
| `novel.ref.list` | 读（分页） | `taskdock_novel_list_entity_refs` | `GET .../novel/refs` | `novel ref list` | 不适用 |

### Comic（8 个操作）

| 操作 | 类型 | MCP 工具 | REST | CLI | 文件导入 |
|---|---|---|---|---|---|
| `comic.episode.list` | 读（分页，不含 script） | `taskdock_comic_list_episodes` | `GET .../comic/episodes` | `comic episode list` | 不适用 |
| `comic.shot.list` | 读（分页） | `taskdock_comic_list_shots` | `GET .../comic/shots` | `comic shot list` | 不适用 |
| `comic.media.list` | 读（分页） | `taskdock_comic_list_media_versions` | `GET .../comic/media-versions` | `comic media list` | 不适用 |
| `comic.media.get` | 读（详情 + revision） | `taskdock_comic_get_media_version` | `GET .../comic/media-versions/{id}` | `comic media get` | 不适用 |
| `comic.character.list` | 读（分页） | `taskdock_comic_list_characters` | `GET .../comic/characters` | `comic character list` | 不适用 |
| `comic.scene.list` | 读（分页） | `taskdock_comic_list_scenes` | `GET .../comic/scenes` | `comic scene list` | 不适用 |
| `comic.media.update` | 写（expectedRevision） | `taskdock_comic_save_media_version` | `PUT .../comic/media-versions/{id}` | `comic media update` | 支持 |
| `comic.media.adopt` | 写（expectedRevision） | `taskdock_comic_adopt_media_version` | `POST .../comic/media-versions/{id}/adopt` | `comic media adopt` | 支持 |

### 明确未开放

| 能力 | 状态 | 说明 |
|---|---|---|
| 领域删除/批量写入 | 未开放 | 破坏性能力不在 Phase 1 |
| 小说卷/章创建、角色/世界观写入 | 未开放 | 当前只读 + 正文更新；写入仍走 UI |
| 漫剧剧集/镜头/角色/场景编辑 | 未开放 | 当前只读 + 素材元信息/采用 |
| 漫剧完整剧本读取 | 未开放 | 列表只返回摘要，剧本需后续独立接口 |
| Game / General / Development | planned | 无操作注册，Manifest 不展示 |
