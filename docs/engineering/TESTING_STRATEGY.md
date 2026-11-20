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
Release 专项验收（少而关键，不可被替代）
Tauri Dev 真实运行验收（日常功能验证的默认层）
集成测试（Command→Service→Repository、SQLite、IPC、事件、跨模块）
契约测试（TS↔Rust DTO、IPC、事件、同步协议、Agent Provider）
单元测试（Domain 规则、Service、Repository、状态机、错误转换、并发）
```

**自下而上逐层加强**：下层通过的结论不自动覆盖上层。上层未被执行时，结论只能覆盖已执行的层。

### 1.1 各层的定位与边界

| 层 | 运行环境 | 回答什么问题 | 不回答什么 |
|---|---|---|---|
| 单元测试 | Node / Rust 进程内 | 规则、状态机、错误转换是否正确 | 真实渲染、真实 IPC、真实窗口 |
| 契约测试 | 两端比对 | 跨端接口是否一致 | 运行时行为 |
| 集成测试 | 进程内多模块 | 链路是否打通、数据是否落库 | 真实桌面环境差异 |
| **Dev Runtime 测试** | **真实 Tauri Debug 桌面应用** | **用户在真实桌面程序里能不能用、能不能看到、能不能存住** | **正式性能、安装升级卸载、生产资源加载** |
| Release 专项验收 | Integration Snapshot 产出的安装包 | 交付版本的正式结论 | — |

**Dev Runtime Testing 层（本层是日常主力）**：

- 运行环境：`npm run tauri dev`（真实 Tauri Debug 应用，不是 Mock，不是浏览器预览）；
- 覆盖：页面交互、前后端 IPC、Rust 业务逻辑、SQLite 数据读写、普通桌面功能、
  普通原生窗口行为、模块级功能与跨模块业务链路；
- 边界：Debug 未优化 → **不能**给性能、内存、动画流畅度、启动耗时等正式结论；
  **不能**证明安装包生成、安装/升级/卸载、签名与更新、生产环境资源加载；
- 结论落点：`tmp/acceptance/<task-name>/`，用语为「Dev 功能验收通过 / 部分通过 / 不通过 /
  证据不足」，**不生成** `buildId`，**不推进**集成任务状态机；
- 操作规范见 [DEVELOPMENT.md](../DEVELOPMENT.md) §2.3，通道映射见
  [ACCEPTANCE_ROUTING.md](../ACCEPTANCE_ROUTING.md) §2.4。

### 1.2 Debug 与 Release 的验证边界

| 维度 | Debug（Dev 实例） | Release（安装包） |
|---|---|---|
| 功能行为 | ✅ 可作为验收依据 | ✅ |
| IPC / SQLite / 文件 | ✅ 真实后端 | ✅ |
| 原生窗口行为 | ✅（但构建配置差异需留意） | ✅（最终依据） |
| 性能 / 内存 / 启动耗时 | ❌ 不能出正式结论 | ✅ |
| 安装 / 升级 / 卸载 | ❌ | ✅ |
| 签名与更新机制 | ❌ | ✅ |
| 生产环境资源加载 | ❌ | ✅ |

**不能用 Dev 结果证明 Release 通过，也不能用 Release 通过掩盖 Dev 未覆盖的路径**——两者的
覆盖范围要分别写清楚。

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

**真机验收可在 Dev 实例上做**：Dev 跑的是真实桌面程序（真实 WebView2、真实 Win32 窗口），
通道 C/E 的测量是真实测量。但涉及**交付结论**的原生行为（材质在 Release 下的表现、安装与升级）
必须补 Release 验收。

## 8. 基线事实

- 桌面前端：vitest 测试覆盖广（含大量样式契约测试）。
- 移动端：79 个测试；盲区在 `notifications/`、原生 `SecureHttpModule.kt`、`App.tsx`、超大页面。
- Rust：`cargo test` 需 dist；`#[ignore]` 的性能/真机套件不计普通通过。
- 工具链：`npm test`、`npm run build`（tsc+vite）、`cargo test/fmt/clippy`。

## 9. 结论口径

未执行的测试写"未执行"；环境阻塞写 `ENVIRONMENT BLOCKED`；证据不足写"证据不足"。不用历史结果冒充本轮结果。结论只用：通过 / 部分通过 / 不通过 / 证据不足。

**Dev 与 Release 的结论必须分开表述**：

- Dev 功能验收 → 「Dev 功能验收通过 / 部分通过 / 不通过 / 证据不足」，记录在
  `tmp/acceptance/<task-name>/`；
- Release 正式验收 → 「验收通过 / 验收失败」，绑定 `buildId`，记录在
  `<构建目录>/acceptance/<任务>.json`；
- **Dev 通过 ≠ Release 通过**：Dev 结论不推进集成任务状态机、不生成 `buildId`；
- **Release 通过也不能替代 Dev 的日常验证**：日常开发不必等安装包。
