# 移动端架构（MOBILE ARCHITECTURE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | Android 移动端 `apps/mobile/` |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md)；专项规范 `apps/mobile/AGENTS.md`（优先） |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) §2.3/§3.3/§3.4 |

---

## 1. 定位：保留现有分层，不复制桌面端

移动端当前分层是三端中最干净的，目标架构**保留**并针对性改善，不做全局搬迁。

```
apps/mobile/src/
  domain/          纯函数（类型/筛选/时间/重复规则），零平台依赖  ← 保持纯净
  db/              唯一 expo-sqlite 入口；schema/迁移/CRUD/Outbox  ← 保持唯一
  features/        按功能聚合（capture/tools）
  components/      展示组件 + entry/icons
  screens/         编排与交互
  lib/             sync（协议/客户端/安全通道）、net、capture、life
  notifications/   提醒通道与排期（不渲染 UI、不自写 SQL）
  theme/           Token/主题/动效
  feedback/        Toast 提示
  services/        （可选）当 service.ts 逻辑继续膨胀时再引入
modules/           8 个原生扩展
plugins/           5 个 config plugin
```

## 2. 已确认正确的机制（保护）

| 机制 | 证据 | 处置 |
|---|---|---|
| domain 零平台依赖 | 仅内部相对引用 + vitest | 加架构守卫锁定，禁止 react/db 依赖 |
| db 唯一 SQL 入口 | expo-sqlite 仅出现在 db/ | 加守卫锁定 |
| 本地优先 Outbox | `schema.ts:50-59` + 三态补丁 + 同事务 rev+1 | 保持并文档化 |
| TLS-only + SPKI 固定 | `secureFetch.ts`、`SecureHttpModule.kt` | 保持，补文档 |
| 前台自动同步取消机制 | `autoSync.ts` cancel + 退避 + 单飞 | 保持 |
| 无后台服务 | 无 WorkManager/前台服务 | 保持（符合 AGENTS.md） |

## 3. 重点改善项

### 3.1 跨端同步契约（P0）

现状：移动端 `lib/sync/protocol.ts` 与桌面端 `src-tauri/src/mobile_sync/` 各自维护 DTO，无共享事实源，字段/版本易漂移。

目标：
- 建立单一契约定义 `docs/contracts/` 或 `shared/contracts/sync.schema.json`（描述 `Change`/`Op`/`PatchValue`/`PullResult`/`PushResult` 的 snake_case 线上格式）；
- 两端各生成/校验自己的类型，配契约测试比对字段集；
- 明确版本语义：配对层 v2 与数据 API v1 的差异写进文档，避免混淆。

> 注意：不为"共享契约"把桌面端与移动端代码强行耦合。共享的是**契约描述文件与测试**，不是运行时代码。

### 3.2 配对安全（P1）

- 手动输码配对存在 TOFU 首用信任窗口（`pairClient.ts:148-149,214-217`、`SecureHttpModule.kt:40-44`）；同步阶段已由 `engine.ts:137` fail-closed 兜住。
- 目标：收窄 TOFU 窗口——配对完成即绑定指纹，后续连接缺指纹/不匹配一律拒绝，不退回 TOFU；与 `apps/mobile/AGENTS.md:20-21` 的字面要求对齐。
- `HostnameVerifier` 恒 true 以 SPKI 固定补偿属设计取舍，需在 SECURITY.md 记录理由与证书轮换风险。

### 3.3 超大页面与测试盲区（P1/P2）

- `CaptureScreen.tsx`(1805)、`LifeScreen.tsx`(1802)、`CaptureReviewScreen.tsx`(1677)、`CaptureStashScreen.tsx`(1637)：拆分为子组件 + hooks，逻辑下沉到 `features/capture/service.ts`。
- 补测试：`notifications/`（3 文件 0 测试）、`App.tsx`（0 测试）、原生 `SecureHttpModule.kt`（无单测，仅 JS mock）。
- README 口径统一：v2 配对/同步端到端"通过"与"未复验"两处矛盾表述需对齐（见审计 §P2）。

## 4. 测试要求

- 79 个现有 `.test.ts/.test.tsx`；重点覆盖协议/加密/客户端/迁移/domain/capture。
- 契约测试（新增）：与桌面端同步 DTO 字段比对。
- 真机项（不可被单测替代）：后台提醒投递、v2 扫码配对端到端、文件互传、投屏、后台运行。
