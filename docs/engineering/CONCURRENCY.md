# 并发与异步规范（CONCURRENCY）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目（Rust / 前端 / 移动端） |
| 上级 | [编码规范](CODING_STANDARDS.md) |
| 事实依据 | 审计 §7（异步与锁） |

---

## 1. 通用原则

- **可取消**：后台任务/轮询/订阅/定时器有 CancellationToken 或等价机制。
- **有超时**：所有等待外部资源的操作有超时。
- **有界**：队列、并发数、重试次数有上限，禁止无界任务创建。
- **幂等与合并**：重复请求合并；写操作幂等（operationId）。
- **资源释放**：任务结束/组件卸载/窗口关闭时释放。
- **监控**：后台任务可观测（计数、积压、耗时）。

## 2. Rust 专项

| 规则 | 要求 |
|---|---|
| 锁 | 不跨 `.await` 持有同步锁或不必要 tokio 锁；缩小锁粒度 |
| 阻塞 | 长阻塞操作（Argon2/文件扫描/OCR）用 `spawn_blocking`，不占 Tokio 异步执行器 |
| 任务 | 有界队列 + 超时 + 可取消；明确任务退出与应用关闭关系 |
| spawn_blocking | 无取消语义，超时只报告不取消写入——如实标注，设计上避免需要强取消的场景 |

**已知待修**：`agents/pipeline.rs:632,650` — `shutdown()` 持 `shutdown_lock` 期间调用 `wait_for_stopped().await`。修法：只在取/置关闭标志时加锁，等待动作移到锁外。幂等设计使其当前可控，但属应消除的可疑模式。

统计基线：`.await` 506、`tokio::spawn` 14、`spawn_blocking` 151、`tauri::async_runtime::spawn` 127、`tokio::time::timeout` 28、各类锁 240+（均需按规则复核，非全部有问题）。

## 3. 前端专项

| 规则 | 要求 |
|---|---|
| 组件卸载 | 清理定时器/订阅/监听器/未决 Promise；用 AbortSignal |
| 重复请求 | 合并或去重；`featureRuntime` 已有 inFlightLoads 机制可参照 |
| 过期响应 | 用 generation/序号丢弃过期响应，不覆盖新状态 |
| 页面隐藏 | 停轮询/订阅（`useFullViewVisible`/`useWorkbenchPageActive`），不是只判 document.hidden |
| Store 耦合 | 避免 Store 间隐式依赖；用 service 协调 |
| IPC 高频 | 合并/节流（如 100ms 窗口聚合） |

## 4. 移动端专项

- 前台自动同步：单飞 + 退避（1/2/4/8/16/32s，6 次上限）+ `cancelAutoSync()` + 前台切换触发；只在前台运行。
- 网络请求：AbortController + timeout + abort 监听成对（add/remove）。
- 无后台服务：保持无 WorkManager/前台服务（符合 AGENTS.md）。
- 本地 Outbox 写入与业务表同事务，失败入 `sync_conflicts`/`life_sync_deferred`。

## 5. 测试要求

- 并发测试：多读单写、忙超时、队列满、重复请求合并。
- 取消测试：取消后无残留任务/监听器，状态正确。
- 超时测试：超时触发路径、重试次数。
- 泄漏测试：长时间运行后任务数/监听器数有平台期（附可复核条件，不用单次采样宣称无泄漏）。
- 故障注入：网络中断、设备断连、窗口提前关闭、应用异常退出。
