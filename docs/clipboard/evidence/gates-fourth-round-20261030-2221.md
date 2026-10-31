# 第四轮工程门禁原始记录

生成时间: 2026-10-30 22:21:17
仓库: /d/Develop/task_dock
Git HEAD: 356bc44fade4c400bfffa17de4c9fa3bd7e184ee
CARGO_TARGET_DIR: $CARGO_TARGET_DIR=src-tauri/target-accept（与并行会话的 target 隔离，避免互相覆盖构建产物）
Rust 工具链: cargo 1.95.0 (f2d3ce0bd 2026-03-21) / rustc 1.95.0 (59807616e 2026-04-14)
Node: v22.22.3 / npm: 10.9.8

| 门禁 | 命令 | 开始 | 结束 | Exit | 测试统计 | 原始输出 |
| --- | --- | --- | --- | --- | --- | --- |
| fmt | `cargo fmt --all -- --check` | 2026-10-30 22:21:18 | 2026-10-30 22:21:20 | 0 |  | `docs/clipboard/evidence/gate-fmt-20261030-2221.log` |
| clippy | `cargo clippy --all-targets --all-features` | 2026-10-30 22:21:20 | 2026-10-30 22:22:48 | 0 |  | `docs/clipboard/evidence/gate-clippy-20261030-2221.log` |
| test-all | `cargo test --all-targets --no-fail-fast` | 2026-10-30 22:22:48 | 2026-10-30 22:25:39 | 0 | test result: ok. 449 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 18.30s test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.79s test result: ok. 0 passed; 0 failed; 6 ignored; 0 measured; 0 filtered out; finished in 0.00s test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.00s test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s  | `docs/clipboard/evidence/gate-test-all-20261030-2221.log` |
| test-clipboard | `cargo test --lib clipboard::` | 2026-10-30 22:25:39 | 2026-10-30 22:25:42 | 0 | test result: ok. 89 passed; 0 failed; 0 ignored; 0 measured; 363 filtered out; finished in 1.17s  | `docs/clipboard/evidence/gate-test-clipboard-20261030-2221.log` |
| tsc | `npx tsc --noEmit` | 2026-10-30 22:25:42 | 2026-10-30 22:25:48 | 0 |  | `docs/clipboard/evidence/gate-tsc-20261030-2221.log` |
| vitest | `npx vitest run` | 2026-10-30 22:25:48 | 2026-10-30 22:26:35 | 0 |  | `docs/clipboard/evidence/gate-vitest-20261030-2221.log` |
| npm-build | `npm run build` | 2026-10-30 22:26:35 | 2026-10-30 22:26:46 | 0 |  | `docs/clipboard/evidence/gate-npm-build-20261030-2221.log` |
| perf-clipboard | `cargo test --release --test clipboard_perf -- --ignored --nocapture` | 2026-10-30 22:26:46 | 2026-10-30 22:32:18 | 0 | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 38.60s  | `docs/clipboard/evidence/gate-perf-clipboard-20261030-2221.log` |
