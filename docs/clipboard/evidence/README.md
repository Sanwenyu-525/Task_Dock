# 剪贴板验收证据索引

本目录只存放**可公开复核的测试输出**：不含用户剪贴板正文、聊天内容、令牌或完整图片。
机器相关路径（临时目录、隔离实例路径）在原始日志中可能保留，归档时未做脱敏改写。

| 文件 | 日期 | 内容 |
|---|---|---|
| `acceptance-final13.log` | 2026-10-29 | 隔离实例真机验收 final13：46/46（历史） |
| `apps-matrix-report.json` | 2026-10-29 | 第三方应用矩阵 5/5（记事本/资源管理器/Edge/VS Code） |
| `apps-matrix-initial.log` | 2026-10-29 | 矩阵首轮记录 |
| `matrix-vscode-report.json` | 2026-10-29 | VS Code 保存后磁盘读回 |
| `mix-paste-prefix-20261029.txt` | 2026-10-29 | 图文混合修复前真机记录：顺序正确但三图 Alpha 全 0 |
| `alpha-audit-20261029.txt` | 2026-10-29 | 目标图片逐点 Alpha 审计（0/5760 不透明） |
| `hyper-timer-panic-20261029.txt` | 2026-10-29 | hyper 1.x `header_read_timeout` 缺 timer 的 panic |
| `perf-a-idle-30min-20261030.json` | 2026-10-30 | 场景 A：30 分钟空闲（58 样本） |
| `perf-a-idle-30min-final-20261030.json` | 2026-10-30 | 场景 A：独立第二次 30 分钟采样（58 样本，交叉核对） |
| `idle-before.json` / `idle-mid.json` / `idle-after.json` | 2026-10-30 | 场景 A 前/中/后监听状态与统计 |
| `perf-c-concurrency-20261030.json` | 2026-10-30 | 场景 C：Agent 并发两轮（HTTP/pipeline/UI） |
| `perf-c-resources-20261030.json` | 2026-10-30 | 场景 C：进程树 CPU/RSS/线程/句柄 |
| `perf-d-ui-release-20261030.json` | 2026-10-30 | 场景 D：抽屉/滚动/搜索/清理/删除 |
| `perf-d-ui-release-raw-20261030.log` | 2026-10-30 | 场景 D 原始控制台输出 |
| `perf-d-filter-release-20261030.json` | 2026-10-30 | 场景 D：类型筛选计数与耗时 |
| `p0-config-runtime-20261030.json` | 2026-10-30 | P0 配置损坏真实运行：status/UI/修复/DB 摘要（已去除令牌） |
| `gates-20261030.log` | 2026-10-30 | 最终工程门禁：fmt/clippy/tsc/vitest/build/cargo test/release perf/tauri build |
| `final-release-smoke-20261030.json` | 2026-10-30 | 最终 release 产物启动：health/status/pipeline |

历史性能记录仍在 `docs/performance/results/`：
`CLIP-20261029-080326.json`（10-29 通过）、`CLIP-20261029-130853.json`（通过）、
`CLIP-20261029-233606.json` 与 `CLIP-20261029-235948.json`（**失败，保留**）、
以及本轮的最终重跑记录。
