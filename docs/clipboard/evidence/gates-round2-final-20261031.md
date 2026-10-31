# 第二轮验收工程门禁原始记录（最终轮）

生成时间：2026-10-31 00:2x（本地）
验收基线：`356bc44fade4c400bfffa17de4c9fa3bd7e184ee`（tree `247a0cdbaf75ae7d60cf6eafa95ac779c0da3b4f`）
执行位置：独立 worktree `D:\Develop\task_dock-r2-acc`（`git worktree add --detach` 固定在上述提交；`node_modules` 以 junction 指向主仓库，避免污染主工作树）
隔离原因：主工作树自 22:36 起有其它并行会话的 v0.6 UI/剪贴板未提交改动（Rust 9 个文件、脚本与文档若干）。验收固定在被验证的提交上，既不覆盖他人改动，也保证结果可复现。

工具链：cargo 1.95.0 (f2d3ce0bd 2026-03-21) · rustc 1.95.0 (59807616e 2026-04-14) · Node v22.22.3 · npm 10.9.8 · Windows 11 22631 x64
机器：LAPTOP-RTUVXZ-G / 20 逻辑核 / 验收期间另有 5 个并行 Qoder 会话持续构建与压测（记录为环境噪声，见验收报告 §5.3）

| 门禁 | 命令 | 完成时间 | Exit | 结果摘要 | 原始日志 |
| --- | --- | --- | --- | --- | --- |
| fmt | `cargo fmt --all -- --check` | 23:00:17 | 0 | 无差异 | `docs/clipboard/evidence/round2-final/gate-fmt.log` |
| clippy | `cargo clippy --all-targets --all-features -- -D warnings` | 23:02:41 | 0 | 0 warning（首次编译 2m03s） | `docs/clipboard/evidence/round2-final/gate-clippy.log` |
| test-all | `cargo test --all-targets` | 23:11:08 | 0 | 10 个测试目标合计 **450 passed / 0 failed / 18 ignored**（lib 449+3 ignored；inbox_processes 1 passed；其余真机/性能套件按惯例 ignored） | `docs/clipboard/evidence/round2-final/gate-test-all.log` |
| tsc | `npx tsc --noEmit` | 23:00:22 | 0 | 无类型错误 | `docs/clipboard/evidence/round2-final/gate-tsc.log` |
| vitest（首次） | `npm test` | 23:01:14 | **1** | 36 文件 / **1 failed / 259 passed**：`ClipboardDrawer > 分页：80/100 时加载更多只追加一页` 在 5s 上限超时（当时 clippy 正在并行编译，jsdom 渲染 80 卡片被 CPU 争用拖慢） | `docs/clipboard/evidence/round2-final/gate-vitest.log` |
| vitest（单文件复跑） | `npx vitest run src/components/clipboard/ClipboardDrawer.test.tsx` | 23:06:32 | 0 | 11/11 通过，确认超时来自负载而非功能缺陷；断言未改 | `docs/clipboard/evidence/round2-final/gate-vitest-drawer-retry.log` |
| vitest（全量复跑） | `npx vitest run` | 23:15:02 | 0 | **36 文件 / 260 项全部通过** | `docs/clipboard/evidence/round2-final/gate-vitest-retry.log` |
| npm build | `npm run build` | 23:14:38 | 0 | `index-C4bEYKAS.js` 535.40 kB（gzip 163.28）· `index-CUrl_xzT.css` 114.91 kB（gzip 19.52） | `docs/clipboard/evidence/round2-final/gate-npm-build.log` |
| tauri build | `npx tauri build` | 23:24:36 | 0 | `src-tauri/target/release/task-dock.exe` **15,553,536 B** sha256 `3d6d5f82edacc854dee5db3b8b4c1bbaf8a4af98f14859b9030b73528505b467`；NSIS `Task Dock_0.5.0_x64-setup.exe` 4.25 MiB；MSI 5.83 MiB | `docs/clipboard/evidence/round2-final/gate-tauri-build.log` |

## 失败轮原样保留说明

1. vitest 首次的 1 例超时**未被删除、未被放宽**；同一文件单独复跑与全量复跑均通过，日志同时保留，报告按「负载诱发的 jsdom 渲染超时」归类。
2. 性能场景 C 默认参数（8 Agent × 100/s × 20s）在 release 门禁中**判定 FAIL**（`overload_rejects=0`，过载前置条件未达成本机性能），失败报告原样保留：`docs/performance/results/R2-C-default-fail-20261030-155337.json`。断言未改；以 40 Agent × 100/s 重新达标（见验收报告 §5.2）。
3. 无 `--no-verify`、无 `#[allow]` 压制、无注释掉失败用例、无放宽断言。
