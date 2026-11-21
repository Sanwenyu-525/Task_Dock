# 文档索引与按需读取

本页用于找归属，不是开工必读清单。先读根 [AGENTS.md](../AGENTS.md)，已知任务路径时直接进入对应文档。

## 读取方式

1. 明确要回答的问题、涉及模块与写入范围；先看相关源码/测试，避免凭旧报告判断当前实现。
2. 用下表找一个主文档，先检索标题/关键词，再读取命中章节；只有缺少安全边界、兼容条件或依赖信息才扩展。
3. 读取到足以实施/验证就停止；不把所有链接递归展开，不默认全读 README、战略、规划或历史测试。
4. 大任务需核对相关需求、架构、ADR、已知问题；这不等于通读所有目录。上下文已加载且文件未变时不重复读取。

PowerShell 示例（仓库根；标题命中后按实际行号读取，行号不作为长期引用）：

```powershell
rg -n '^#{1,3} ' docs/ARCHITECTURE.md
rg -n '备份|迁移|BACKUP_TABLES' docs/ARCHITECTURE.md
Get-Content docs/ARCHITECTURE.md | Select-Object -Skip <起始行减一> -First <所需行数>
```

单次输出过大或截断时缩小文件/章节范围，不继续整篇输出。Windows 中文内容读取按 UTF-8；
搜索先限目录与文件类型，不把截图、构建目录、证据日志全扫进上下文。

## 工程规则归属

| 问题 | 主文档与读取范围 |
|---|---|
| 必守约束、Git 安全、默认验收方式 | [AGENTS](../AGENTS.md)；根入口不维护长命令表或历史结果 |
| 如何启动、运行命令、确认 Dev 实例 | [DEVELOPMENT](DEVELOPMENT.md) §2；命令实现以 `package.json` 和对应脚本为准 |
| 错误处理、编码规范 | [DEVELOPMENT](DEVELOPMENT.md) §4 |
| 缓存/磁盘、并行写入与 Worktree | [DEVELOPMENT](DEVELOPMENT.md) §7/§8 的目标小节 |
| Release 任务交付/快照/构建/验收 | [INTEGRATION_BUILD](INTEGRATION_BUILD.md) §2–3/§4/§5/§6–8；仅执行对应阶段时加载 |
| 验收通道、原生边界、证据/报告格式 | [ACCEPTANCE_ROUTING](ACCEPTANCE_ROUTING.md) §2/§4/§6–9 |
| 过去测过什么、缺口与失败 | [TESTING](TESTING.md) 按模块/日期检索；历史结果不代表当前通过 |
| 模块职责、数据与安全 | [ARCHITECTURE](ARCHITECTURE.md) 对应模块；有专题文档则优先读专题、再补总览交叉约束 |
| 为什么这样设计 | [ADR 索引](adr/README.md)；只读相关决策，Proposed 不等于 Accepted |
| 选择开发/验收 Skill | [AGENT_SKILL_ROUTING](AGENT_SKILL_ROUTING.md) 对应任务；前端指南查询见 §6 |

## 模块入口

| 模块/任务 | 文档入口 |
|---|---|
| 桌面视觉、Token、交互 | [设计规格](ui-themes/01-design-spec.md)；按该目录文件名选择专题 |
| 页面弹层定位 | [定位规范](architecture/ui/global-popup-positioning-standard.md)；[审计](architecture/ui/global-popup-positioning-audit.md) 记录实施分类 |
| 页面按需加载、后台服务生命周期 | [ON_DEMAND_LOADING](ON_DEMAND_LOADING.md) |
| 文件工作区 | [需求](features/files-workspace.md)、[架构](architecture/files-workspace.md)、[验收](acceptance/files-workspace.md)；按任务选读 |
| 剪贴板 | `docs/clipboard/` 下按安全、架构、测试专题检索；总览在 ARCHITECTURE「智能剪贴板」 |
| Agent 接入与导航 | [适配器](AGENT_ADAPTERS.md)、[覆盖矩阵](../AGENT_COVERAGE_MATRIX.md)、[导航矩阵](../APP_NAVIGATION_MATRIX.md) |
| Agent 工作空间 | [模块索引](agent-workspace/README.md)；设计与已实现状态分别核对 |
| Personal Hub | [模块索引](personal-hub/README.md)与[架构基线](personal-hub/ARCHITECTURE_BASELINE_v1.0.md) |
| Android 配对/同步/文件互传 | [移动端索引](mobile/README.md) + [移动端规范](../apps/mobile/AGENTS.md) |
| 安全保险箱 | [专题索引](features/secure-vault/README.md) |
| 诊断与资源清理 | [DIAGNOSTICS](DIAGNOSTICS.md)、[RESOURCE_CLEANUP](RESOURCE_CLEANUP.md) 对应章节 |
| 产品状态与未来规划 | [产品介绍](../README.md)、[ROADMAP](ROADMAP.md)；功能目录事实源 `src/lib/featureCatalog.ts` |
| 战略规划 | [战略](AGENT_ERA_STRATEGY.md) + [事实核对](AGENT_ERA_STRATEGY_FACTCHECK.md)，不把草案当实现 |

未列出的模块用 `rg --files docs/<目录>` 或 `rg --files docs -g '*关键词*'` 定位，不在本索引复制每篇文档。

## 当前规范、方案与历史

- **当前规范**：维护约束、接口、行为和兼容边界；改实现时更新原归属章节，不追加一串任务日记。
- **方案/规划**：标明 Proposed、待确认、planned 等状态；是否实施要看代码、迁移与真实验证。
- **历史证据**：TESTING、带日期验收报告、旧版本整改记录只证明当时的范围；撤回/更正保留。
- 构建调度器已退役，决策见 [ADR-0007](adr/0007-remove-build-scheduler.md)。旧手册和其中的验收记录可用
  `git show 58d2d1e:docs/BUILD_SCHEDULER.md` 追溯。当前操作见 [DEVELOPMENT §7.8](DEVELOPMENT.md)。
- 当前状态不靠全仓搜索某个旧的「PASS」推断；未确认的偏差记录待确认，不伪造历史。

## 维护与文档影响检查

同一规则只在归属文档展开，其他入口写摘要 + 链接。新增文档仅在已有文档无合适归属时创建；
需求、架构、ADR、API、数据库、开发记录、测试、README、ROADMAP、CHANGELOG、已知问题逐项判断影响，
只更新实际受影响且存在的载体，不为了清单齐全创建空目录/空文档。本仓库决策目录为 `docs/adr/`。
