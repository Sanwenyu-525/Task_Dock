# 手机端规范索引（TaskDock Mobile / Android）

本目录是 `apps/mobile` 的正式规范集，对应桌面端的 `docs/ARCHITECTURE.md` /
`docs/DEVELOPMENT.md` / `docs/TESTING.md` / `docs/ui-themes/` 分工。

**权威顺序**：代码与可复现输出 > 真机证据 > 本目录文档。文档与实现冲突时以代码为准，
并按本目录各篇末尾的「变更记录」追加带日期的更正，不覆盖历史结论。

## 文档地图

| 文档 | 内容 | 对应桌面端 |
|---|---|---|
| [01-architecture.md](01-architecture.md) | 分层、依赖方向、启动序列、提醒子系统、状态刷新 | `docs/ARCHITECTURE.md` |
| [02-data-model.md](02-data-model.md) | 表结构、迁移策略、三态补丁、`rev`/outbox、重复规则契约 | `docs/ARCHITECTURE.md` 数据章 |
| [03-ui-spec.md](03-ui-spec.md) | 设计 Token、表面硬规则、组件约束、字阶与交互 | `docs/ui-themes/01-design-spec.md` |
| [04-testing.md](04-testing.md) | 自动化、真机通道、用例矩阵、证据要求、已知阻塞 | `docs/TESTING.md`、`docs/ACCEPTANCE_ROUTING.md` |
| [05-build.md](05-build.md) | Windows 构建 Android 的工具链、版本管理、产物校验、故障表 | `docs/DEVELOPMENT.md` |
| [../MOBILE_STACK.md](../MOBILE_STACK.md) | 选型与共享边界**设计稿**（含未实现能力的规划，不是现状） | 选型报告 |
| [../../apps/mobile/AGENTS.md](../../apps/mobile/AGENTS.md) | 本目录的开发红线与提交前自检 | 根 `AGENTS.md` |

任务级验收报告在 `tmp/acceptance/mobile-app-skeleton/report.md`（`tmp/` 不入库）。

## 当前状态（2026-11-08）

### 已实现并在真机验证

- 任务：新建 / 编辑 / 完成 / 软删除 / 优先级 / 分类 / 标签 / 截止时间 / 提前提醒
- 重复任务：按日/周/月推进期次，完成只推进不落地为「已完成」
- 列表：今天 / 本周 / 以后 / 无日期 / 已完成分组，逾期提示，搜索（标题、描述、分类、标签）
- 收集箱：录入（`client_id` 幂等）、删除、一键转任务（单事务）、搜索
- 设置：主题三态、通知权限状态与申请、测试通知、本地数据概览
- 提醒：本地通知排期（上限 64）、启动对账、通知动作「完成 / 10 分钟后」、处理完收起通知
- 数据：SQLite v2（WAL）、迁移事务化、`rev` 自增、`outbox` 同事务入队

### 未实现（明确边界）

| 能力 | 状态 |
|---|---|
| 配对 / 设备身份 / 同步传输 / 冲突合并 / 墓碑推进 | 只有协议骨架（`src/lib/sync/`），**未接入网络** |
| `notes` 表、`server_rev` / `dirty` 列 | 设计稿提出，**未建**；当前用 `rev` + `outbox.base_rev` |
| 主屏小组件、系统分享接收、后台同步、远程推送 | 未实现 |
| iOS | 未验证（本机无 macOS/Xcode），本轮只做 Android |

### 已记录的已知限制

- 应用退到后台后提醒未投递（vivo Funtouch / Android 16），判定为厂商后台策略，
  见 [04-testing.md](04-testing.md) §6。
- 提醒使用默认精度排期（约 7.5 分钟窗口），不申请 `SCHEDULE_EXACT_ALARM`。
- 重复规则按自然日/自然周计算，不支持法定节假日与调休。

## 变更记录

- 2026-11-08 首版：按桌面端文档分工建立手机端规范集，全部条目以当时代码为准。
