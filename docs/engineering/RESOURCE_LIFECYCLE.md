# 资源生命周期规范（RESOURCE LIFECYCLE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目 |
| 上级 | [编码规范](CODING_STANDARDS.md) |

---

## 1. 原则

所有稀缺资源（窗口、连接、文件句柄、定时器、监听器、任务、订阅、Tokio/线程池槽位）必须：

1. 有明确的创建者与所有者；
2. 有明确的释放时机（组件卸载 / 页面隐藏 / 窗口关闭 / 应用退出）；
3. 有上限（数量/时长/并发）；
4. 可被取消；
5. 可观测（计数/积压）。

## 2. 资源清单与释放路径

| 资源 | 创建 | 释放 |
|---|---|---|
| Tauri 窗口 | app bootstrap / 运行时 | on_window_event 关闭；退出握手 flush |
| SQLite 连接 | Db::open | 应用退出；只读连接池回收 |
| 文件句柄 | 文件操作服务 | 操作结束/失败；spawn_blocking 内关闭 |
| Tokio 任务 | spawn / spawn_blocking | 协作取消；退出时 drain（pipeline 已有） |
| 前端定时器/轮询 | hooks/store | 组件卸载 / 页面隐藏（useFullViewVisible） |
| 事件监听器 | subscribeEvent | Unsubscribe（组件卸载 / store 清理） |
| 模块级单例缓存 | lib 各模块 | 有 `__resetForTests`；生命周期=进程（文档标注） |
| 移动端前台同步 | autoSync | cancelAutoSync + AppState 后台 |
| 剪贴板访问锁 | ACCESS_LOCK | 锁内比较后写入，锁范围最小 |

## 3. 窗口与退出

- 保存窗口矩形前验证可见性；HWND/PID 只作运行时身份不落库。
- 退出握手：`request_exit` → `flush_workbench_before_exit` → `complete_exit_handshake`（`lib.rs` 现有），拆分时保持。
- 异常退出（强杀）后状态正确：草稿恢复、操作标记 `interrupted` 不重放。

## 4. 模块级单例例外

前端存在大量"模块即单例"（`featureRuntime`、`audioNotification`、`fileDrop`、`diagnostics` 等），生命周期=进程，配套 `__resetForTests`。这是有意为之，但必须：
- 文档标注为单例及其生命周期；
- 状态有上限与清理（如 diagnostics 队列）；
- 隐藏窗口时不继续后台活动。

## 5. 测试要求

- 资源计数测试：反复创建/销毁后无累积（监听器、任务、定时器）。
- 页面隐藏停轮询测试。
- 窗口提前关闭/异常退出后状态一致性测试。
- 长时运行内存平台期测试（附可复核条件）。
