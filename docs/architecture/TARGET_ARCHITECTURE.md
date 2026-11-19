# TaskDock 目标架构（TARGET ARCHITECTURE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1 架构方案，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目（桌面前端 / Rust 后端 / 移动端） |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) |
| 相关文档 | [前端](FRONTEND_ARCHITECTURE.md)、[后端](BACKEND_ARCHITECTURE.md)、[移动端](MOBILE_ARCHITECTURE.md)、[模块依赖](MODULE_DEPENDENCIES.md) |
| 相关 ADR | [ADR 索引](../adr/README.md) |

---

## 1. 总体定位：模块化单体 + 轻量六边形 + 垂直切片

TaskDock 是**长期演进的模块化单体**，不是微服务。目标架构遵循三条铁律：

1. **不重写**：渐进重构，每次只改一个清晰边界，保持公开接口与行为不变（Strangler Pattern）。
2. **不过度抽象**：不强制所有简单 CRUD 走满五层；按业务复杂度选择分层深度。
3. **不换底座**：不更换数据库（SQLite）、状态管理（Zustand）、UI 框架（React）、桌面壳（Tauri）、移动端技术栈（Expo/RN）。

分层模型（每端按复杂度裁剪，非强制全套）：

```
Interface 层   ← UI / Tauri Command / IPC 事件（对外入口，只做参数校验与 DTO 转换）
Application 层 ← 用例编排、事务边界、跨领域流程（可选，仅复杂用例）
Domain 层      ← 业务规则、实体、值对象、状态机（纯，无框架依赖）
Infrastructure← SQLite / 文件系统 / 网络的具体实现（Repository 落这里）
Platform 层    ← Win32 / Tauri / Android 原生 API 适配
```

**依赖方向**：外层依赖内层；内层永不依赖外层。Domain 不 import React / Tauri / expo-sqlite。

---

## 2. 继承（不重复开发）的现有机制

以下机制已存在且经审计确认有效，**目标架构继承并保护它们，不另起炉灶**：

| 机制 | 路径 | 处置 |
|---|---|---|
| 按需加载 | `featureRuntime.ts`、`featureRegistry.ts`、`FeatureView` | 保留；治理"唯一入口"一致性 |
| 错误处理 | `src/lib/errors.ts` 的 `AppError` 理念 | 保留并统一为跨端契约 |
| Zustand 领域 Store | `src/store/` 26 个 | 保留；逐步分离 store 中的业务逻辑 |
| SQLite WAL + 只追加迁移 | `db/mod.rs` | 保留；MIGRATIONS 版本与顺序为红线 |
| Tauri 多窗口独立 Capability | `capabilities/` 8 文件 | 保留；收敛主窗权限面 |
| 移动端 domain/db/screens 分层 | `apps/mobile/src/` | 保留；作为分层正确参照 |
| 有界 Agent 管线 | `agents/pipeline.rs` | 保留；修正持锁跨 await |
| Build Scheduler / Integration Snapshot | `scripts/build-sched.mjs`、`taskdock-integration.mjs` | 保留；重构产物一律走此链路 |
| 启动诊断/日志/异常 | `diagnostics/`、`globalErrors.ts` | 保留；纳入生命周期规范 |
| 文件所有权与集成规范 | `AGENTS.md` §3 | 保留；重构线强制串行写共享枢纽文件 |

---

## 3. 前端目标架构

### 3.1 目标目录

```
src/
  app/
    bootstrap/       应用启动、feature 安装、探针
    shell/           窗口外壳（App/FullView/WorkbenchShell 的骨架）
    providers/       Context/主题/错误边界
    routing/         路由与主窗口导航
  features/
    tasks/ files/ clipboard/ agents/ workspace/ vault/
    workflows/ mobile/ navigation/ settings/ shelf/
    <feature>/
      components/    展示组件
      hooks/         UI 生命周期与交互状态
      services/      用例编排（复杂功能才有）
      store/         领域状态（复杂功能才有）
      models/        纯业务模型
      api/           该域的 IPC 封装
      index.ts       公开出口（其他模块只能从这里 import）
  platform/
    tauri/           Tauri API 适配（窗口/事件/文件 URL）
    desktop/         桌面特有能力
  shared/
    ui/              UI 基元（保留 src/components/ui）
    errors/          错误契约（单一事实源）
    contracts/       IPC 类型契约、跨端 DTO
    utils/           纯工具
    hooks/           跨功能复用 hook
```

### 3.2 迁移策略（不是一次性搬迁）

- **当前代码保持原位**，通过 `index.ts` 出口与路径别名渐进迁移；先从 `lib/bridge.ts` 内部按域拆分开始，不动调用方。
- **按需加载红线不变**：页面只能经 `featureRegistry` 登记（`load: () => import(...)` 静态字面量），由 `FeatureView` 首次可见加载。禁止 `React.lazy`；用 `featureRuntime` 的 `loadFeature/retryFeature`。
- 页面隐藏必须停轮询/订阅（`useFullViewVisible`/`useWorkbenchPageActive`），不能只判 `document.hidden`。
- 策略：`instance: "keep"`（有草稿/编辑态）vs `"release"`（只读工具）；`preload: "idle"` 只允许一个。
- 具体规范见 [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) 与 `docs/ON_DEMAND_LOADING.md`。

---

## 4. Rust 后端目标架构

### 4.1 目标目录

```
src-tauri/src/
  app/
    bootstrap/       插件注册、状态装配
    state/           AppState 定义
    commands/        generate_handler! 唯一注册处（thin）
    windows/         窗口/托盘/几何
    plugins/         插件装配
    lifecycle.rs     启动意图、退出握手
    cli.rs           agentctl 等 CLI
  domains/
    tasks/ clipboard/ files/ agents/ workspace/ vault/ mobile/
    <domain>/
      model.rs       实体/值对象
      rules.rs       纯业务规则
      events.rs      领域事件定义
  application/
    tasks/ files/ clipboard/ backup/ ...
    <usecase>.rs    用例编排 + 事务边界（复杂用例才有）
  infrastructure/
    sqlite/
      migrations/    每版本一个 .sql，MIGRATIONS 用 include_str! 引用
      repositories/  Repository trait + 实现
    filesystem/
    network/
  platform/
    windows/         Win32 / DWM / WinRT 适配
  shared/
    errors.rs        AppError 单一事实源
    events.rs        事件模型
    types.rs         共享 DTO
```

### 4.2 关键约束

- **命令层变薄**：Command 只做参数接收、必要校验、DTO 转换、调用 Application/Domain、返回结果。复杂编排下沉到 Application，SQL 下沉到 Repository。
- **数据库红线**：`MIGRATIONS` 版本号与顺序、`user_version`、表结构完全不变；迁移 SQL 文件化只改"SQL 从哪里来"，不改"迁移是什么"。备份表清单（143 张）数据化但不删表。
- **异步规范**：不跨 `.await` 持有同步锁；长阻塞操作用 `spawn_blocking`；有界队列 + 超时 + 可取消；任务退出与应用关闭有明确关系。
- 具体规范见 [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) 与 `docs/ARCHITECTURE.md`。

---

## 5. 移动端目标架构

**保留现有分层**（domain/db/features/components/screens/lib/notifications/theme），不复制桌面端架构。重点改善：

| 改善点 | 目标 |
|---|---|
| 跨端数据契约 | 与桌面端共享同步 DTO 契约定义 + 契约测试，消除双份漂移 |
| 网络边界 | 保持 `secureFetch` 单一出口与 TLS-only + SPKI 固定 |
| 数据库事务 | 保持 Outbox 与业务表同事务（rev+1 + outbox 写入） |
| 后台任务 | 保持无 WorkManager/前台服务；前台自动同步有完整取消机制 |
| 认证授权 | 收口手动输码配对的 TOFU 窗口；配对 v2 与数据 API v1 语义文档化 |
| 测试盲区 | 补 notifications、App.tsx、原生 secure-http 单测 |

具体见 [MOBILE_ARCHITECTURE.md](MOBILE_ARCHITECTURE.md) 与 `apps/mobile/AGENTS.md`。

---

## 6. 横切规范索引

| 主题 | 文档 |
|---|---|
| 模块边界与公开接口 | [CODING_STANDARDS.md](../engineering/CODING_STANDARDS.md) |
| IPC 契约 | [IPC_ARCHITECTURE.md](IPC_ARCHITECTURE.md)、[IPC 规范](../engineering/CODING_STANDARDS.md#2-ipc-规范) |
| 事件系统 | [EVENT_ARCHITECTURE.md](EVENT_ARCHITECTURE.md) |
| 错误处理 | [ERROR_HANDLING.md](../engineering/ERROR_HANDLING.md) |
| 并发与生命周期 | [CONCURRENCY.md](../engineering/CONCURRENCY.md)、[RESOURCE_LIFECYCLE.md](../engineering/RESOURCE_LIFECYCLE.md) |
| 数据库 | [DATABASE_ARCHITECTURE.md](DATABASE_ARCHITECTURE.md) |
| 安全 | [SECURITY.md](SECURITY.md) |
| 测试 | [TESTING_STRATEGY.md](../engineering/TESTING_STRATEGY.md) |
| 质量门禁 | [QUALITY_GATES.md](../engineering/QUALITY_GATES.md) |
| 设计模式 | [DESIGN_PATTERNS.md](DESIGN_PATTERNS.md) |

---

## 7. 演进原则

1. **行为不变**：纯架构重构满足"输入/规则/输出/数据格式/体验"五不变；发现的 Bug 单独登记，不在重构中偷改。
2. **兼容层有退出条件**：Strangler 允许新旧短期共存，但禁止长期双实现、禁止两个数据源同时写入，需写明兼容层退出条件。
3. **一次一个边界**：先拆内部结构保留导出 → 迁移调用方 → 测试 → 无旧引用后再废弃兼容层。
4. **数据与安全不退化**：数据库重构用隔离测试库，验证备份恢复，不动生产库、不清用户数据、不降低安全等级。

---

## 8. 目标能力验收（治理完成的 15 条）

1. 新增功能时代码位置明确；2. 改模块无需理解全项目；3. 模块可独立测试；4. 模块间稳定接口通信；5. DB 不污染业务规则；6. UI 不依赖底层系统；7. IPC 不膨胀成巨型文件；8. 异步任务生命周期完整；9. 复杂业务有状态机；10. 错误/日志/追踪统一；11. 新代码自动架构检查；12. 多 Agent 并行少冲突；13. 桌面/移动端边界合理；14. 数据安全性能不退化；15. 架构可持续演进。
