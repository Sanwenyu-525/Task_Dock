# 事件架构（EVENT ARCHITECTURE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 跨模块事件、状态通知、后台任务完成、数据变更通知（三端） |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md) |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) §5.4 |

---

## 1. 核心原则

**不使用全局 EventBus 作为架构主干。** 事件是补充手段，不是模块间通信的默认方式。模块间优先用直接接口/依赖注入；只有"一对多通知、发布方不需要知道订阅方"的场景才用事件。

## 2. 事件生命周期规范

每个事件必须明确：

| 要素 | 要求 |
|---|---|
| 类型定义 | 强类型 payload（TS interface / Rust struct） |
| 版本 | payload 带 `version` 字段，破坏性变更升版本 |
| 发布方 | 明确谁发布，不匿名广播 |
| 订阅 | `subscribeEvent<T>(event, handler): Promise<Unsubscribe>` |
| 释放 | 订阅方卸载/隐藏时调用 Unsubscribe；有引用计数 |
| 高频 | 合并/节流（如百毫秒窗口聚合） |
| 循环 | 禁止事件 A 触发事件 B 又触发 A；架构守卫检测 |
| 日志 | 只记事件类型/计数/耗时，不记正文 |

## 3. 现有事件源盘点

| 事件源 | 路径 | 现状 | 处置 |
|---|---|---|---|
| Tauri 全局事件 | `bridge.ts` 中 `listen`、`@tauri-apps/api/event` | 遍布，部分无显式释放 | 统一封装，强制 Unsubscribe |
| featureRuntime 事件 | `featureRuntime.ts:632` `subscribeFeatureRuntime` | 有配套 `__resetForTests` | 保留，纳入统一模式 |
| Agent 事件管线 | `agents/pipeline.rs` | 有界队列、drain、origin 判定 | 保留；修持锁跨 await |
| 移动端本地变更 | `autoSync.ts:463` `subscribeLocalChange` | 进程级单例，无释放（可接受） | 文档标注例外 |
| 多套轻量 Set<Listener> | `featureRuntime`/`fileJobs`/`operationQueue`/`interactions`/`mobilePairing` 等 | 模块级单例 + reset 钩子 | 逐步收敛到统一事件工具 |

## 4. 事件 vs 轮询 vs Store 订阅的选择

| 场景 | 推荐 |
|---|---|
| 后端主动推送状态变化 | 事件（Tauri event + 统一封装） |
| 前端组件读最新状态 | Store 订阅（Zustand selector） |
| 需要定期刷新且无推送 | 轮询（必须可取消、有超时、页面隐藏停止） |
| 跨模块业务流程 | Service 直接调用，不用事件 |

## 5. 生命周期要求（继承 AGENTS.md §4.8）

- 后台任务、轮询、订阅、定时器必须可取消、有超时、有上限、可回收。
- 页面隐藏停轮询：`useFullViewVisible()` / `useWorkbenchPageActive()`，不是只判 `document.hidden`。
- 窗口提前关闭、应用异常退出时事件订阅与任务正确释放。

## 6. 测试要求

- 订阅 → 触发 → Unsubscribe，验证无残留监听器。
- 高频事件合并正确性。
- 事件循环检测（架构守卫 + 运行期看门狗）。
- payload 版本兼容测试。
