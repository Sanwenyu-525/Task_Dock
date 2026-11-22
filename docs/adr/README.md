# 架构决策记录（ADR）索引

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效 |
| 最后更新 | 2026-11-20（战略草案 ADR-A01–A12 状态调整为 Proposed，见下） |
| 适用范围 | 全项目重大架构决策 |

---

## 为什么要 ADR

ADR 记录"为什么这样决策"，让未来 Agent 理解取舍、避免反复推翻。ADR 一旦记录不轻易删除；推翻旧决策时保留原记录并说明原因（新 ADR 标注 Supersedes）。

## 现有 ADR（治理前已存在，保留）

| 编号 | 标题 | 路径 |
|---|---|---|
| 0001 | 确定性命令短语 | `docs/adr/0001-deterministic-command-phrases.md` |
| 0001–0007 | Personal Hub 系列（安全优先、本地认证、投屏双栈、Android 栈、服务形态、加密工具链、云信令） | `docs/personal-hub/adr/` |

## 本次治理新增 ADR

| 编号 | 标题 | 状态 |
|---|---|---|
| [0002](0002-modular-monolith-no-rewrite.md) | 采用模块化单体 + 渐进重构，禁止推倒重写 | Accepted |
| [0003](0003-shared-error-contract.md) | 建立跨端统一错误契约，三端 AppError 归一 | Accepted |
| [0004](0004-migration-redline.md) | 数据库迁移红线：版本/顺序/表结构不变，仅文件化 SQL | Accepted |
| [0005](0005-architecture-guard-phased.md) | 架构守卫三阶段渐进启用，禁大量忽略规则 | Accepted |
| [0006](0006-cqrs-rejected.md) | 当前拒绝 CQRS，仅统计聚合未来评估 | Accepted |
| [0007](0007-remove-build-scheduler.md) | 删除构建调度器，命令直接执行 | Accepted |
| [0008](0008-unified-project-identity-and-creation.md) | 统一项目身份与统一项目创建服务 | Accepted |
| [0009](0009-window-close-behavior-and-tray-recall.md) | 窗口关闭策略（window_close_behavior）与托盘唤回入口 | Accepted |
| [0010](0010-unified-project-context-and-lifecycle-workbench.md) | 统一项目上下文与项目生命周期工作台（ProjectContext + Plan 语义收敛） | Accepted |
| [0011](0011-project-plan-dual-aggregate.md) | Project Root 与 Plan 双聚合及 API 契约（v93 根 revision、三入口创建事务统一） | Accepted |

## 战略草案决策（未正式 Accepted，待用户确认）

> **状态更正（2026-11-20，第二轮架构审计）**：本节原名「战略级冻结决策」并把 ADR-A01–A12 标注
> 为「冻结（2026-11-19）」——该表述超出了实际治理状态。用户尚未对这批战略取舍做出最终确认，
> 依第二轮整改要求，它们只是**战略草案**，不得宣称已正式 Accepted。

| 编号 | 标题 | 状态 | 路径 |
|---|---|---|---|
| ADR-A01 – ADR-A12 | TaskDock 定位、Relay 边界、Agent 身份分离、Context 装配、完成判定等 12 条战略约束 | **Proposed（待用户确认）** | [../AGENT_ERA_STRATEGY.md](../AGENT_ERA_STRATEGY.md) §12 |

### 战略草案与正式 ADR 的区分

| | 正式 ADR（0001–0007） | 战略草案（ADR-A01–A12） |
|---|---|---|
| 存放 | `docs/adr/00xx-*.md` 独立条目 | 战略文档 §12 表格 |
| 状态 | Accepted（经用户治理确认） | Proposed（事实核对已完成，**待产品战略确认**） |
| 约束力 | 已作为开发约束生效 | 在用户确认前仅作方向参考，不得作为验收依据 |
| 转正方式 | — | 用户确认战略方向后，按需逐条拆出 `00xx-*.md` 并标 Accepted |

这 12 条已在战略文档中作为候选约束列出，但尚未拆为独立的 `docs/adr/00xx-*.md` 条目，也未获
用户逐条确认。各条在用户确认且首次需要独立追溯时拆出正式 ADR；若战略方向被调整，应直接修改
战略文档草案而非拆分。

## ADR 模板（新增时使用）

```markdown
# ADR-NNNN-标题
1. 背景
2. 当前问题
3. 决策
4. 备选方案
5. 选择原因
6. 优点
7. 缺点
8. 影响模块
9. 迁移计划
10. 测试要求
11. 回滚条件
```

重大决策（架构方向、公共接口、数据结构、跨端协议、安全模型）必须写 ADR；普通代码改动不写。
