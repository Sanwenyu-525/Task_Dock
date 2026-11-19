# 测试策略（TESTING STRATEGY）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目 |
| 上级 | [编码规范](CODING_STANDARDS.md) |
| 相关 | `docs/TESTING.md`、`docs/ACCEPTANCE_ROUTING.md` |

---

## 1. 测试金字塔

```
真机/系统验收（少而关键，不可被替代）
集成测试（Command→Service→Repository、SQLite、IPC、事件、跨模块）
契约测试（TS↔Rust DTO、IPC、事件、同步协议、Agent Provider）
单元测试（Domain 规则、Service、Repository、状态机、错误转换、并发）
```

## 2. 单元测试

覆盖：Domain 业务规则、Service、Repository、状态机合法/非法转换、错误转换、数据转换、并发控制、重试机制。命令：`npm test`（vitest）、`cargo test`（在 src-tauri/ 内，需先 dist）。

## 3. 集成测试

覆盖：Command → Service → Repository、SQLite 事务（含迁移回放）、IPC 全链路、事件订阅清理、跨模块调用、多窗口、文件操作、移动端通信。

## 4. 契约测试（当前缺失，Phase 2/3 建立）

| 契约 | 方法 |
|---|---|
| TS ↔ Rust DTO / IPC | 命令签名 golden 文件比对或脚本校验 |
| 事件载荷 | payload schema 版本校验 |
| 移动端同步协议 | 共享 schema + 两端字段比对（见 MOBILE_ARCHITECTURE.md） |
| Agent Provider | 适配器接口契约 |
| 外部工具接口 | MCP/CLI 契约 |
| 跨端错误码 | 三端错误码表一致性 |

## 5. 故障恢复测试

必须覆盖：数据库 busy、磁盘空间不足、文件权限不足、网络中断、设备断连、应用异常退出、窗口提前关闭、重复请求、超时、取消、部分成功、任务重试。用故障注入验证 fail-closed 与可恢复。

## 6. 性能测试

重点：启动时间、首屏加载、页面切换、大文件操作、大列表、大型 SQLite 查询、内存平台期、后台 CPU、IPC 延迟、多窗口资源占用。量具：`scripts/theme-perf.mjs`、`render-perf.mjs`、`on-demand-audit.mjs`、`scripts/perf/`。**性能结论必须有可复核条件**（二进制 sha256、构建模式、工具链、数据目录隔离、样本数、机器空闲、p50/p95、证据文件）；不用单次采样宣称无泄漏。

## 7. 真机验收（不可被单测替代）

Windows 原生窗口、贴边吸附、DPI、多显示器、系统剪贴板、文件拖拽、系统通知、投屏；Android 配对、文件传输、后台运行。通道分级见 `docs/ACCEPTANCE_ROUTING.md` A–F；CDP 不证明 Win32 裁剪/吸附手感/系统级命中。

## 8. 基线事实

- 桌面前端：vitest 测试覆盖广（含大量样式契约测试）。
- 移动端：79 个测试；盲区在 `notifications/`、原生 `SecureHttpModule.kt`、`App.tsx`、超大页面。
- Rust：`cargo test` 需 dist；`#[ignore]` 的性能/真机套件不计普通通过。
- 工具链：`npm test`、`npm run build`（tsc+vite）、`cargo test/fmt/clippy`。

## 9. 结论口径

未执行的测试写"未执行"；环境阻塞写 `ENVIRONMENT BLOCKED`；证据不足写"证据不足"。不用历史结果冒充本轮结果。结论只用：通过 / 部分通过 / 不通过 / 证据不足。
