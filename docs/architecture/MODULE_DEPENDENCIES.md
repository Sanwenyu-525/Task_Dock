# 模块依赖（MODULE DEPENDENCIES）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1 依赖事实 + Phase 2 守卫基线） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目模块依赖规则与例外 |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md) |
| 自动化 | `scripts/architecture/architecture-rules.json`、`architecture-guard.mjs` |

---

## 1. 允许的依赖方向

### 前端

```
app → features → shared / platform
features/<a> → features/<b>/index.ts   （只经公开出口，禁止 import 内部路径）
features/* → shared/*                  （允许）
features/* → platform/*                （允许，只经 platform 公开出口）
shared/* → shared/*                    （允许，禁止成环）
shared/* → features/*                  （禁止）
platform/* → features/*                （禁止）
lib → store                            （禁止；见层次倒置问题）
```

### 后端（Rust）

```
app → application → domains → shared
app → infrastructure → domains
app → platform
commands → application / domains / infrastructure
domains → domains（同域内）/ shared    （禁止跨 domains 直接依赖，经 application）
domains → infrastructure / platform   （禁止）
infrastructure → domains              （允许，实现 trait）
```

### 移动端

```
screens → features → components → domain / db / lib
domain → 无（纯）
db → domain（允许）
screens/components/features → expo-sqlite  （禁止，只经 db/）
notifications → db / expo-notifications     （允许，不渲染 UI、不自写 SQL）
theme → 无外部依赖
```

## 2. 已观测的违规/例外（Phase 0 基线）

| 编号 | 违规 | 位置 | 处置 |
|---|---|---|---|
| V1 | lib → store 层次倒置 | `lib/errorReport.ts:14` → `useUiStore` | Phase 3 修（事件上抛） |
| V2 | IPC 多出口 | `creative/ipc.ts`、`desktopBridge.ts`、`dragCursorSession.ts`、`windowFrame.ts` | 受控例外 + 收敛计划 |
| V3 | 页面静态导入绕过 registry | `FullView.tsx:38,481` | 默认页例外，显式注释 |
| V4 | 跨端 DTO 双份维护 | 移动端 `protocol.ts` vs 桌面 `mobile_sync/` | Phase 3 共享契约 |
| V5 | store 间隐式耦合 | `useGlobalSearchStore:39-42` 等 | Phase 3 service 化 |
| V6 | 平行源码树分叉 | `src-tauri/components/`、`src-tauri/boot/` | 未跟踪在途，只审计不删除 |
| V7 | Command 直连 SQL | `tasks.rs`/`backup.rs`/`data.rs` 等 | Phase 3 Repository 化 |

## 3. 例外配置与渐进启用

架构守卫采用三阶段（见 [QUALITY_GATES.md](../engineering/QUALITY_GATES.md)）：

- **阶段一（当前）**：只报告违规，建立历史基线，不阻断构建。上述 V1–V7 记入基线例外。
- **阶段二**：新代码禁止新增违规；已治理模块启用强制检查（按路径白名单）。
- **阶段三**：逐模块清理历史违规，完成后升级为全局强制。

**禁止**为让检查通过而大量添加忽略规则；每个例外必须有理由与退出条件，记入 `architecture-rules.json`。

## 4. 共享枢纽文件（唯一所有者串行写）

`src/lib/bridge.ts`、`navigationRegistry.ts`、`featureCatalog.ts`、`useUiStore.ts`、`src-tauri/src/lib.rs`、`commands/mod.rs`、`db/mod.rs`、全局样式与主题 Token、i18n、依赖与构建配置、数据库迁移与版本定义——同时写必须由唯一所有者串行，具体见 `AGENTS.md` §3.2。
