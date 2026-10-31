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
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

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
  printf 'cargo: %s\n' "$(cargo --version 2>&1)"
  printf 'rustc: %s\n' "$(rustc --version 2>&1)"
  printf 'node: %s\n' "$(node --version 2>&1)"
} | tee "$OUT_DIR/gate-env-${STAMP}.log"

run_gate fmt cargo fmt --manifest-path "$CARGO_MANIFEST" --all -- --check
run_gate clippy cargo clippy --manifest-path "$CARGO_MANIFEST" --all-targets --all-features -- -D warnings
run_gate test-all cargo test --manifest-path "$CARGO_MANIFEST" --all-targets --no-fail-fast
run_gate clipboard-lib cargo test --manifest-path "$CARGO_MANIFEST" --lib clipboard::
run_gate tsc npx tsc --noEmit
run_gate vitest npx vitest run
run_gate npm-build npm run build

if [ "${GATE_SKIP_PERF:-0}" != "1" ]; then
  run_gate perf-clipboard cargo test --manifest-path "$CARGO_MANIFEST" --release --test clipboard_perf -- --ignored --nocapture
fi

{
  printf '# 工程门禁原始记录\n\n'
  printf '生成时间: %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'Git HEAD: %s\n\n' "$(git rev-parse HEAD)"
  printf '| 门禁 | 命令 | 开始 | 结束 | Exit | 原始输出 |\n|---|---|---|---|---|---|\n'
  printf '%s\n' "${ROWS[@]}"
} >"$OUT_DIR/gates-${STAMP}.md"

printf '\n=== 汇总 ===\n'
cat "$OUT_DIR/gates-${STAMP}.md"
