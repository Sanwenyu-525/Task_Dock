# 开发效率中枢——设计决策记录

按日期追加；推翻旧结论时保留原文并标注更正。

## D1（2026-11-12）开发效率三特性挂在既有 DevWorkbenchPanel，不新增导航入口

依据：AGENTS.md §8「不制造入口冗余」与总任务书 11.1。P0 已交付 DevWorkbenchPanel（四区域）
并注册 left order 0.5。功能①②③ 的 Round 1 UI 全部作为其新区域/组件挂载（DevProjectContext /
DevHandoffSection / DevAcceptanceSection），胶囊侧只给 TasksLite 加紧凑现场 chip，不新增 Lite
pane（避免 6 处注册点与 rail-contract 契约扩张，Phase 3 做情境化操作时再统一设计）。

## D2（2026-11-12）当前项目用设置键存「当前」，项目清单才建表

镜像 P0 的 `workbench_current_task` 口径：当前选择 = 用户显式意图，存 `application_settings`
（`workbench_current_project`）；项目本体 = 需要增删改查的记录，建 `dev_projects`。关联失效
（项目被删）不自动清键，读侧如实显示——与任务锚点删除不清键的既有口径一致。

## D3（2026-11-12）git 探测用子进程而非 git2

审计确认 Rust 侧零 git 依赖。git2 引入新依赖（AGENTS.md：不擅自引入依赖）且绑定 libgit2 版本
管理成本；探测只需 4 条只读命令，`std::process::Command` + 2s 超时 + CREATE_NO_WINDOW 足够。
探测结果不落库（易腐），前端 session 内存缓存 + 手动刷新。

## D4（2026-11-12）验收记录追加式，无 update/delete

总任务书功能三：「验收历史不可被无痕覆盖」。`dev_acceptance_records` 只 INSERT；更正 = 新记录
（verdict + summary），前端展示以最新记录为「当前结论」，历史完整可查。派生状态是**视图**，
不写回 planning/task 状态字段——避免第二套互不兼容的状态系统（总任务书功能三约束）。

## D5（2026-11-12）交接包第一版只做「复制到剪贴板」的 Markdown

总任务书功能二明确：自动提交到 Agent 是后续受权限控制的增强，非首版前置。版本化靠
`dev_handoff_packs` 按 (taskId|title) 自增 version 追加行。secret scan 在 Rust 侧做（权威），
只回类型+行号，绝不回显密文；用户可修正后再复制/保存。素材不自动带入文件内容：MVP 只带
task_context 只读摘要 + 用户勾选的笔记/暂存架条目标题，文件正文导入留待后续（需显式选择 +
大小限制）。

## D6（2026-11-12）Round 1 一次迁移合三张表

三张表同属 Phase 1 闭环，分开迁移会增加测试/备份验证轮次且无独立发布价值。一次迁移 =
一个事务 = 一个版本号（v48），迁移测试与 BACKUP_TABLES 登记一次完成。

## D7（2026-11-12）不自动把「任务 completed」当作验收通过

任务 status 只有 pending|completed，且规划功能 completed 只有用户能置（mcp/tools.rs:887 边界）。
DevAcceptanceSection 的派生状态把「任务 completed 且无验收记录」显示为**待验收**而非已验收；
pass 必须来自显式验收记录。
