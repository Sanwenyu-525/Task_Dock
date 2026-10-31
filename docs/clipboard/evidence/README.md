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
| `gates-20261030-2336.md` | 2026-10-30 | 第四轮门禁汇总表（fmt/clippy/tsc/vitest/npm-build 通过；test-all 与 perf-clipboard 退出码 101，根因为并行会话并发编辑把共享工作区改到编译不过，见 `docs/V05_COMPREHENSIVE_REMEDIATION.md` §13.5.5） |
| `gate-{fmt,clippy,test-all,tsc,vitest,npm-build,perf-clipboard}-20261030-2336.log` | 2026-10-30 | 第四轮门禁原始输出（与上表一一对应） |
| `gate-index-20261030-2336.tsv` | 2026-10-30 | 第四轮门禁机器可读索引（命令 / 起止 / 退出码 / 日志路径） |
| `final-release-smoke-20261030.json` | 2026-10-30 | 最终 release 产物启动：health/status/pipeline |
| `gate-test-all-20261031-0907.log` | 2026-10-31 | 第五轮首次复跑（**失败，保留**）：exit 101，根因是 `--manifest-path` 从仓库根调用绕过了 `src-tauri/rust-toolchain.toml`，GNU ld 对零导出 cdylib 报 `export ordinal too large: 175971`；装置缺陷已修复，见 `docs/V05_COMPREHENSIVE_REMEDIATION.md` 装置缺陷 #16 |
| `gate-perf-clipboard-20261031-0907.log` | 2026-10-31 | 同轮 perf 门禁（**失败，保留**），同一 GNU 链接错误 |
| `gate-rerun-fingerprint-20261031-0907.txt` | 2026-10-31 | 第 1 次复跑后的源码指纹（该文件只剩「复跑后」段；**复跑前** `147 files / +5,208`、`sha256=9f06a96f…` 见 `gate-rerun-driver-20261031-0907.log`） |
| `gate-rerun-driver-20261031-{0907,0921,0929}.log` | 2026-10-31 | 三次复跑的驱动日志（含复跑前/后指纹、逐门禁起止、退出码汇总） |
| `gate-test-all-20261031-0921.log` | 2026-10-31 | 第五轮第 2 次 test-all（**失败，保留**）：D: 盘写满，`LNK1201` / `os error 112`，装置缺陷 #18 |
| `gate-perf-clipboard-20261031-0921.log` | 2026-10-31 | 同轮 perf 门禁（**失败，保留**），`failed to write …rmeta: 磁盘空间不足` |
| `gate-rerun-fingerprint-20261031-0921.txt` | 2026-10-31 | 第 2 次复跑指纹（含 MSVC 工具链与 cargo/rustc 版本） |
| `gate-test-all-20261031-0929.log` | 2026-10-31 | 第五轮第 3 次 test-all：lib **472 passed / 3 failed / 3 ignored**，3 个失败全为 `navigation::router` 前台聚焦（ENVIRONMENT-BLOCKED）；其余目标通过 |
| `gate-test-all-filtered-20261031-0943.log` | 2026-10-31 | 显式过滤上述 3 个前台用例后的 lib 复跑：**474 passed / 0 failed / 3 ignored / 3 filtered out** |
| `gate-perf-clipboard-20261031-0929.log` | 2026-10-31 | 第五轮 perf 门禁：**2 passed / 0 failed**（34.82 s），exit 0 |
| `gate-rerun-fingerprint-20261031-0929.txt` | 2026-10-31 | 第 3 次复跑前后源码指纹（152→159 files）与工具链 |
| `gate-final-fmt-20261031-0946.log` | 2026-10-31 | 第五轮第 4 次 fmt（**失败，保留**）：16 处格式差异，均为本次整改新增代码；修复后见 `gate-final2-fmt` |
| `gate-final-clippy-20261031-0946.log` | 2026-10-31 | 同轮 clippy（**失败，保留**）：`needless_borrow`，`src/lib.rs:275`；修复后见 `gate-final2-clippy` |
| `gate-final-{tsc,vitest,npm-build}-20261031-0946.log` | 2026-10-31 | 同轮前端门禁：`tsc --noEmit`、vitest、`npm run build` 全部 exit 0 |
| `gate-final-release-20261031-0946.log` | 2026-10-31 | 同轮 release 构建 exit 0（随后 fmt/clippy 修复后又重建，最终产物见 `gate-final2-release`） |
| `gate-final2-fmt-20261031-1004.log` / `gate-final2-clippy-20261031-1004.log` | 2026-10-31 | 修复后重跑：fmt **0**、clippy **0** |
| `gate-final2-test-all-20261031-1004.log` | 2026-10-31 | lib **474 passed / 3 failed / 3 ignored**：2 前台锁 + `concurrent_writers_never_exceed_capacity` 偶发一次 |
| `gate-final2-test-filtered-20261031-1004.log` | 2026-10-31 | 过滤 3 个前台用例：**474 passed / 0 failed / 3 ignored / 3 filtered out** |
| `gate-final2-release-20261031-1004.log` | 2026-10-31 | release 构建 exit 0，6m10s，15,799,296 B，`sha256=4fddaa06…` |
| `gate-final2-fingerprint-20261031-1004.txt` | 2026-10-31 | 第 5 次门禁前后源码指纹（13 files/+810）与最终二进制哈希 |
| `gate-final3-*-20261031-1019.log` / `gate-final3-fingerprint-20261031-1019.txt` | 2026-10-31 | 第 6 次快照（**无效，保留**）：并行会话 v0.6 编辑使 `window_shape.rs` 等 11 处不可编译，clippy/test-all/perf 均 101 |
| `gate-final4-{fmt,clippy,test-all,summary}-20261031-1028.*` | 2026-10-31 | **补充快照（非 v0.5 验收依据）**：并行会话 v0.6 编辑恢复可编译后，`test-all` exit 0，lib **480 passed / 0 failed / 3 ignored**（含此前失败的 3 例）；同轮 fmt/clippy 失败点只在并行会话的 `context_menu.rs` / `window_shape.rs` |

历史性能记录仍在 `docs/performance/results/`：
`CLIP-20261029-080326.json`（10-29 通过）、`CLIP-20261029-130853.json`（通过）、
`CLIP-20261029-233606.json` 与 `CLIP-20261029-235948.json`（**失败，保留**）、
以及本轮的最终重跑记录。

「被测实例自行退出」的完整取证记录同样在该目录：
`EXIT-FORENSICS-20261030.md`（含四步证据链、排除表、受控复现 transcript 与机理说明）。

第五轮内存链与分段斜率的可复核产物（`docs/performance/results/`）：

| 文件 | 内容 |
|---|---|
| `MEM-CHAIN-v05r5-20261030-2353.log` | 五臂串行驱动日志：起点源码指纹（123 files changed）、每臂起止与 rc、自退标记 |
| `MEM-ATTRIBUTION-v05r5.json` | 三臂归因的**单文档 UTF-8** 结果（N1−N2 通知路径、N2−N3 接入路径、KB/条） |
| `MEM-ATTRIBUTION-v05r5-20261031-0925.log` | 上述结果的生成输出（stdout 留存） |
| `MEM-ATTRIBUTION-v05r5-raw-gbk.txt` | 修复前的原始产物（多文档 + GBK，**保留不删**），仅作对照 |
| `WINDOWS-C-ui-http-30min-20261031-002204.json` | C 臂分段窗口（负载起点 85.2 s）与最小二乘斜率 |
| `WINDOWS-E-idle-after-load-30min-20261031-005450.json` | E 臂分段窗口（负载起点 78.1 s）与最小二乘斜率 |
