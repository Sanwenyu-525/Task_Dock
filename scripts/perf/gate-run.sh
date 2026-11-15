#!/usr/bin/env bash
# 工程门禁一键复跑：逐条执行门禁并记录命令、开始/结束时间、退出码与原始日志。
#
# 为什么要这个脚本：
#   1) 历史记录里的门禁结果散落在多份日志里，无法核对「哪条命令、什么时候、退出码是多少」；
#   2) `cmd | tee` 这类写法会丢掉退出码（管道最后一个命令的码不是被测命令的码）；
#   3) 与并行会话共用 cargo target 目录会互相锁文件、互相覆盖构建产物。
#
# 用法：
#   bash scripts/perf/gate-run.sh [输出目录]
# 环境变量：
#   CARGO_TARGET_DIR  隔离的 cargo 产物目录（默认 src-tauri/target-gate）
#   GATE_SKIP_PERF=1  跳过 release 性能测试（默认跑）
#   GATE_DRY_RUN=1    只打印每条门禁真正会被执行的命令行，不执行（用于核对调度接入，零资源）
#   GATE_NO_SCHED=1   逃生门：不经调度器（仅在调度器自身故障时用于排障，会绕过内存准入与队列）
#
# 2026-11-15 变更：所有高资源门禁统一经 `scripts/build-sched.mjs`（AGENTS.md §5.1）。
#   cargo 步改走 `cargo` 子命令（自动 cwd=src-tauri/，因此不再用 --manifest-path 从仓库根执行）；
#   tsc / vitest 强制过 `npm run build` / `npm run test`（它们本身已接调度器，内层自动直通）。
#   注意退出码语义：0=通过；3=资源等待/运行超时；4=被取消；5=调度器错误；6=磁盘预检阻塞。
#   只有「子进程自己的退出码」才代表代码失败，判定时请读日志尾部的 `sched:` 行。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

SCHED_CLI="$REPO_ROOT/scripts/build-sched.mjs"
GATE_MODE="sched"
[ "${GATE_NO_SCHED:-0}" = "1" ] && GATE_MODE="raw"
GATE_DRY_RUN="${GATE_DRY_RUN:-0}"

# 经调度器执行一条普通门禁命令；GATE_NO_SCHED=1 时退化为直接执行（排障用）
run_sched() {
  local name="$1" priority="$2"; shift 2
  if [ "$GATE_MODE" = "raw" ]; then
    run_gate "$name" "$@"
    return
  fi
  run_gate "$name" node "$SCHED_CLI" run --priority "$priority" -- "$@"
}

# cargo 门禁：走 cargo 子命令（自动 cwd=src-tauri/，遵守 rust-toolchain.toml）
run_sched_cargo() {
  local name="$1" priority="$2"; shift 2
  if [ "$GATE_MODE" = "raw" ]; then
    run_gate "$name" cargo --manifest-path "$CARGO_MANIFEST" "$@"
    return
  fi
  run_gate "$name" node "$SCHED_CLI" cargo -- --priority "$priority" "$@"
}

OUT_DIR="${1:-docs/clipboard/evidence}"
STAMP="$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target-gate}"
# 构建前守卫：磁盘空间不足或缓存异常时阻塞（退出码 2），先清理再跑门禁。
node "$REPO_ROOT/scripts/build-guard.mjs" precheck || exit 2
# Rust 工程在 src-tauri/，仓库根目录没有 Cargo.toml。
# cargo 命令必须显式带上 manifest，否则会以 exit_code=101 失败
# （此前版本在仓库根执行，fmt/clippy/test 三条 Rust 门禁全部假失败）。
CARGO_MANIFEST="$REPO_ROOT/src-tauri/Cargo.toml"

declare -a ROWS=()

run_gate() {
  local name="$1"; shift
  local log="$OUT_DIR/gate-${name}-${STAMP}.log"
  local start end rc
  start="$(date '+%Y-%m-%d %H:%M:%S')"
  printf '\n=== [%s] %s\n' "$name" "$*" | tee -a "$log"
  if [ "$GATE_DRY_RUN" = "1" ]; then
    printf '[dry-run] 未执行（调度接入核对）\n' | tee -a "$log"
    rc=0
    end="$(date '+%Y-%m-%d %H:%M:%S')"
    printf 'exit_code=dry-run\n' >>"$log"
    printf '%s|%s|%s|%s|%s|%s\n' "$name" "$*" "$start" "$end" "dry-run" "$log" >>"$OUT_DIR/gate-index-${STAMP}.tsv"
    ROWS+=("$(printf '| %s | `%s` | %s | %s | %s | `%s` |' "$name" "$*" "$start" "$end" "dry-run" "$log")")
    return 0
  fi
  "$@" >"$log" 2>&1
  rc=$?
  end="$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'exit_code=%s\n' "$rc" >>"$log"
  printf '%s|%s|%s|%s|%s|%s\n' "$name" "$*" "$start" "$end" "$rc" "$log" >>"$OUT_DIR/gate-index-${STAMP}.tsv"
  ROWS+=("$(printf '| %s | `%s` | %s | %s | %s | `%s` |' "$name" "$*" "$start" "$end" "$rc" "$log")")
  if [ "$rc" -ne 0 ]; then
    printf '!!! [%s] 退出码 %s，日志：%s\n' "$name" "$rc" "$log" >&2
  fi
  return 0
}

printf '=== 环境 ===\n'
{
  printf '生成时间: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf '仓库: %s\n' "$REPO_ROOT"
  printf 'Git HEAD: %s\n' "$(git rev-parse HEAD)"
  printf '工作区: %s\n' "$(git status --porcelain | wc -l) 个条目"
  printf 'CARGO_TARGET_DIR: %s\n' "$CARGO_TARGET_DIR"
  printf '调度模式: %s（sched=经 build-sched 队列；raw=GATE_NO_SCHED 逃生门）\n' "$GATE_MODE"
  printf 'dry-run: %s\n' "$GATE_DRY_RUN"
  printf 'cargo: %s\n' "$(cargo --version 2>&1)"
  printf 'rustc: %s\n' "$(rustc --version 2>&1)"
  printf 'node: %s\n' "$(node --version 2>&1)"
} | tee "$OUT_DIR/gate-env-${STAMP}.log"

run_sched_cargo fmt P2 fmt --all -- --check
run_sched_cargo clippy P2 clippy --all-targets --all-features -- -D warnings
run_sched_cargo test-all P2 test --all-targets --no-fail-fast
run_sched_cargo clipboard-lib P2 test --lib clipboard::
# 前端：直接调 npm 入口（它们本身已接调度器；内层命令会自动直通，不会重复排队）
run_gate tsc npm run build
run_gate vitest npm run test

if [ "${GATE_SKIP_PERF:-0}" != "1" ]; then
  run_sched_cargo perf-clipboard P2 test --release --test clipboard_perf -- --ignored --nocapture
fi

{
  printf '# 工程门禁原始记录\n\n'
  printf '生成时间: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'Git HEAD: %s\n' "$(git rev-parse HEAD)"
  printf '调度模式: %s / dry-run: %s\n\n' "$GATE_MODE" "$GATE_DRY_RUN"
  printf '退出码语义：0=通过；3=资源等待或运行超时；4=被取消；5=调度器错误；6=磁盘预检阻塞。\n'
  printf '只有子进程自己的退出码才代表代码失败——判定时读日志尾部的 `sched:` 行。\n\n'
  printf '| 门禁 | 命令 | 开始 | 结束 | Exit | 原始输出 |\n|---|---|---|---|---|---|\n'
  printf '%s\n' "${ROWS[@]}"
} >"$OUT_DIR/gates-${STAMP}.md"

printf '\n=== 汇总 ===\n'
cat "$OUT_DIR/gates-${STAMP}.md"
