# 架构决策记录（ADR）索引

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效 |
| 最后更新 | 2026-11-19 |
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
