# 模块迁移矩阵（MODULE MIGRATION MATRIX）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1） |
| 最后更新 | 2026-11-19 |
| 配套 | [路线图](REFACTOR_ROADMAP.md)、[进度](REFACTOR_PROGRESS.md) |

---

覆盖全项目主要模块。"当前状态"基于 2026-11-19 审计；"目标架构/优先级/所有者"为治理计划，所有者待主 Agent 分配。

## 基础设施

| 模块 | 当前状态 | 目标架构 | 依赖问题 | 优先级 | 所有者 | 测试情况 |
|---|---|---|---|---|---|---|
| IPC Bridge | 7027 行/547 invoke，4 出口 | Facade 按域拆 + CommandContracts | 多出口、上帝文件 | P0 | 待分配 | typecheck/test 全绿；契约测试待建 |
| db/mod.rs | 7010 行/v78 混合迁移 | 迁移文件化 + ConnectionManager + Repository | 内联 SQL、无 Repository | P0 | 待分配 | 迁移原子性测试有；回放待建 |
| lib.rs | 2859 行/764 命令 | 拆 app/* 五模块 | 上帝文件 | P0 | 待分配 | cargo test；真机启动/退出 |
| 错误模型 | 三处重复、码集不一 | 跨端统一错误契约 | 无单一事实源 | P0 | 待分配 | 契约测试待建 |
| 事件系统 | Tauri listen 散布 + 多 Set | 统一 subscribeEvent/Unsubscribe | 释放路径不齐 | P1 | 待分配 | 清理测试待建 |
| 资源生命周期 | 部分无取消/释放 | 全资源可取消可释放 | 持锁跨 await、定时器 | P1 | 待分配 | 泄漏测试待建 |
| 并行源码树 | src-tauri/components、boot 未跟踪分叉 | 确认所有权后归档/删除 | 分叉、误用风险 | P0 | 待分配（在途 Agent） | 只审计，不动 |
| 架构守卫 | 无 | scripts/architecture/* 三阶段 | 无自动化检查 | P1 | 待分配 | 守卫单测待建 |

## 业务模块（后端）

| 模块 | 当前状态 | 目标架构 | 依赖问题 | 优先级 | 所有者 | 测试情况 |
|---|---|---|---|---|---|---|
| Tasks | tasks.rs 3171 行/98 SQL | tasks Repository + Application Service | Command 直连 SQL | P0 | 待分配 | 命令测试有；Service 测试待建 |
| Files / file_workspace | file_workspace 3895 行 | files Service + Repository | SQL + 大模块 | P1 | 待分配 | 部分 |
| Clipboard | store.rs 6346 行/190 SQL；platform 4880 行 | Clipboard Repository（已有雏形完善） | SQL 多、平台层重 | P1 | 待分配 | 部分；真机必须 |
| Agents | mod.rs 3966 行 + pipeline 2775 行 | 领域模型 + 有界管线（保留） | 持锁跨 await | P1 | 待分配 | 管线测试充分 |
| Workspace / project_hub | project_hub 4 文件 | workspace 域 + Service | 新模块在途 | P1 | 待分配 | 部分 |
| Vault | secure_vault 13 文件 | 保留安全边界，文档化 | 加密边界 | P1 | 待分配 | 有单测 |
| Workflows | workflows 5 文件 | Service + 状态机 | 状态机规范化 | P1 | 待分配 | 部分 |
| Mobile Sync | mobile_sync 6 文件 | 共享契约 + 状态机 | DTO 双份、TOFU | P0 | 待分配 | 契约测试待建；真机 |
| Resource Cleanup | 8 文件 | 统一清理策略（已有雏形） | 边界文档化 | P2 | 待分配 | 部分 |
| Recycle Bin | recycle 6 文件 | 统一文件操作服务 | 索引一致性 | P1 | 待分配 | 部分 |
| Backup | backup.rs 6315 行/170 SQL | backup Repository + 143 表数据化 | SQL 多 | P0 | 待分配 | 恢复测试待建 |

## 前端

| 模块 | 当前状态 | 目标架构 | 依赖问题 | 优先级 | 所有者 | 测试情况 |
|---|---|---|---|---|---|---|
| Store 层 | 26 store，4 个超 800 行 | Store 只留状态，业务下沉 Service | store 间耦合 | P1 | 待分配 | 部分 |
| Feature Registry | 已遵循（1 处静态例外） | 保持，锁定约束 | 默认页例外 | P2 | 待分配 | registry.test 有 |
| Navigation Registry | 已存在 | 保持，合并概念相近注册表 | 多套 catalog | P2 | 待分配 | rail-contract 有 |
| Platform Adapter | Tauri API 直连散布 | platform/tauri 收口（UI 窗口例外） | 直连不统一 | P1 | 待分配 | 部分 |
| Overlay Stack | 已存在 | 保持 | 无 | P2 | 待分配 | 有 |
| CSS Token | 三正交维度已实现 | 保持 | 全局样式 486KB | P2 | 待分配 | 视觉走查有 |
| FilesWorkspacePanel | 2847 行 | 组件/Hook/Service 分离 | 多职责 | P1 | 待分配（在途） | 部分 |
| WorkbenchShell | 2646 行 | 外壳保留聚合，抽子模块 | 外壳聚合 | P1 | 待分配 | 部分 |
| ClipboardWorkspace | 2019 行 | 逻辑下沉 | 多职责 | P1 | 待分配 | 部分 |
| AgentPanel | 2839 行 | 状态树/行动/历史拆分 | 多职责 | P1 | 待分配 | 部分 |

## 移动端

| 模块 | 当前状态 | 目标架构 | 依赖问题 | 优先级 | 所有者 | 测试情况 |
|---|---|---|---|---|---|---|
| domain/db 分层 | 干净 | 保持 + 守卫锁定 | 无 | P2 | 待分配 | domain/db 测试有 |
| 同步协议 | DTO 双份 | 共享契约 + 契约测试 | 字段漂移、版本语义 | P0 | 待分配 | 协议测试有，契约待测 |
| 配对安全 | TOFU 窗口 | 配对即绑指纹 | 首用信任 | P1 | 待分配 | 部分 |
| 超大页面 | 4 个 ≈1800 行 | 拆分 + 补测 | 多职责、无测试 | P1 | 待分配 | 盲区 |
| 通知层 | 3 文件 0 测试 | 补单测 | 测试盲区 | P1 | 待分配 | 无 |
| 原生 secure-http | 无单测 | 补 Kotlin 单测 | TLS 模块无测 | P1 | 待分配 | 仅 JS mock |
