# IPC 架构（IPC ARCHITECTURE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 桌面前端 ↔ Rust 后端 IPC；跨端同步 HTTP 协议 |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md) |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) §3.1 |

---

## 1. 现状事实

- 前端统一出口 `src/lib/bridge.ts`：**2785 行、1028 个导出**（2026-11-19 契约分离后），命令/事件实现集中于此。
- 纯类型契约已分离到 `src/lib/contracts/`：`models.ts`（434 个 DTO）、`navigation.ts`（4 个 nav 类型）；`bridge.ts` 以 `export * from "./contracts/models"` 与 `import type` 保持公开 API 不变。
- 后端 `generate_handler!` 在 `lib.rs:1283` 注册 764 条命令；全库 803 个 `#[tauri::command]`（39 个差异待复核）。
- 存在 4 条并行 IPC 出口：bridge（主）、`creative/ipc.ts`（受控例外）、`widgets/desktopBridge.ts`、`dragCursorSession.ts`/`windowFrame.ts`。
- 事件订阅 `listen` 遍布窗口入口与各 store。
- 契约层约束：只放纯类型、不 import 业务模块（`navigation.ts` 反向 re-export 契约，单向依赖）。

## 2. 统一调用契约（目标）

```typescript
// 命令契约：每个命令的 args / result 类型单一事实源
interface CommandContracts {
  "tasks_list": { args: { filter?: TaskFilter }; result: Task[] };
  // ... 由现有命令逐步登记
}

function invokeCommand<TCommand extends keyof CommandContracts>(
  command: TCommand,
  args: CommandContracts[TCommand]["args"],
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<CommandContracts[TCommand]["result"]>;
```

必须支持：
- 参数/返回值类型约束（编译期）；
- 统一错误处理（经 `AppError`，见 [ERROR_HANDLING.md](../engineering/ERROR_HANDLING.md)）；
- 请求取消（适用时，`AbortSignal`）；
- 超时控制（默认 + 可覆盖）；
- 日志追踪（operationId / correlationId，不含敏感正文）；
- 多窗口上下文（command 不绑定具体窗口，窗口操作经 platform）；
- 兼容旧调用方（`bridge.ts` 作为 Facade 保留全部导出）。

## 3. 事件契约（目标）

```typescript
interface Unsubscribe { (): void }

function subscribeEvent<T>(
  event: string,
  handler: (payload: T) => void
): Promise<Unsubscribe>;
```

必须确保：
- 监听器可正确清理（组件/stores 卸载时调用 Unsubscribe）；
- 事件有类型定义、有版本（payload schema 版本字段）；
- 高频事件合并/节流；
- 禁止事件循环、禁止把全局 EventBus 当架构主干；
- 参考现有 `featureRuntime.subscribeFeatureRuntime`、`bridge` 里 listen 的用法统一封装。

## 4. 收敛路线

| 出口 | 现状 | 目标 |
|---|---|---|
| `bridge.ts` | ✅ 类型契约已分离（2785 行）；函数仍集中 | 第二步：按域拆 `bridge/{clipboard,shelf,fs,...}.ts`，facade 保持；`contracts/models.ts` 按域拆 |
| `creative/ipc.ts` | 受控例外 | 补 CommandContracts + 注释理由；Phase 3 评估并入 |
| `widgets/desktopBridge.ts` | 窗口/微件命令 | 归入 `platform/tauri/`，仍走统一契约 |
| `dragCursorSession.ts` / `windowFrame.ts` | 直连 | 业务命令并 bridge，窗口几何归 platform |

> 2026-11-19 已完成第一步：`src/lib/contracts/models.ts`（434 DTO）+ `contracts/navigation.ts`；`bridge.ts` 通过 `export *` 与 `import type` 保持 1028 导出零变化。详见 `tmp/acceptance/architecture-governance/phase3-1-ipc-contracts/report.md`。

## 5. 命令设计规范

- 参数 camelCase，Rust 侧 `rename_all = "camelCase"`；新增命令同步前端类型与 Rust 签名。
- 命令层 thin：参数校验、DTO 转换、调用下层、返回结果；复杂编排下沉 Application。
- 命令不记录敏感正文（剪贴板内容/图片/路径/密钥）。
- 39 个未注册命令复核：死代码删除或补注册，记入审计报告。
- 事件载荷 `origin` 由服务端判定，客户端不可伪造（继承 agents 机制）。

## 6. 跨端同步协议（独立但相关）

- 移动端 ↔ 桌面端走 `secureFetch`（TLS-only + SPKI 固定），不经过 Tauri IPC。
- 配对层 v2，HTTP 数据路由 `/v1/*`，加密 AAD `taskdock-sync-v1`——语义差异需在契约文档明确。
- 同步 DTO 单一事实源与契约测试见 [MOBILE_ARCHITECTURE.md](MOBILE_ARCHITECTURE.md) §3.1。

## 7. 测试要求

- 契约测试：TS 命令签名 ↔ Rust 命令参数/返回（可用脚本比对或 golden 文件）。
- 集成测试：Command → Service → Repository 全链路。
- 事件测试：订阅 → 触发 → 清理，验证无泄漏、无循环。
- 多窗口上下文测试：同一命令在不同窗口调用行为一致。
