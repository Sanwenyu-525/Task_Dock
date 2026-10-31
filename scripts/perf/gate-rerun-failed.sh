#!/usr/bin/env bash
# 只复跑第四轮失败的两条门禁（test-all / perf-clipboard），沿用 gate-run.sh 的目录与日志口径。
# 第五轮复跑暴露装置缺陷 #16：在仓库根用 --manifest-path 调 cargo 会绕过
# src-tauri/rust-toolchain.toml（固定 MSVC），落到 rustup 默认的 GNU 工具链；
# GNU 的 ld 在 cdylib（本 crate 无导出符号）上自动导出全部符号，导出序号超过 65535
# 直接失败（0907 的 test-all / perf-clipboard 两条 101 均为该原因，不是源码缺陷）。
# 故 cargo 一律在 src-tauri 内执行。
# 复跑必须在源码可编译的窗口内进行，并记录前后的源码指纹与生效工具链。
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$PWD"
OUT_DIR="$REPO_ROOT/docs/clipboard/evidence"
STAMP="$(date +%Y%m%d-%H%M)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target-gate}"

declare -a ROWS=()
run_gate() {
  local name="$1"; shift
  local log="$OUT_DIR/gate-${name}-${STAMP}.log"
  local start end rc
  start="$(date '+%Y-%m-%d %H:%M:%S')"
  printf '\n=== [%s] (cwd=src-tauri) %s\n' "$name" "$*" | tee -a "$log"
  ( cd "$REPO_ROOT/src-tauri" && "$@" ) >"$log" 2>&1
  rc=$?
  end="$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'exit_code=%s\n' "$rc" >>"$log"
  if [ $rc -ne 0 ]; then echo "!!! [$name] 退出码 $rc，日志：$log"; else echo "[$name] rc=0"; fi
  ROWS+=("$name|$*|$start|$end|$rc|$log")
}

echo "源码指纹（复跑前）" | tee "$OUT_DIR/gate-rerun-fingerprint-$STAMP.txt"
bash scripts/perf/source-fingerprint.sh 2>/dev/null | tee -a "$OUT_DIR/gate-rerun-fingerprint-$STAMP.txt"
{ ( cd src-tauri && rustup show active-toolchain && cargo -V && rustc -vV ) 2>&1; } \
  | tee -a "$OUT_DIR/gate-rerun-fingerprint-$STAMP.txt"

run_gate test-all cargo test --all --no-fail-fast
run_gate perf-clipboard cargo test --release --test clipboard_perf -- --ignored --nocapture

echo "" | tee "$OUT_DIR/gate-rerun-fingerprint-$STAMP.txt"
echo "源码指纹（复跑后）" | tee -a "$OUT_DIR/gate-rerun-fingerprint-$STAMP.txt"
bash scripts/perf/source-fingerprint.sh 2>/dev/null | tee -a "$OUT_DIR/gate-rerun-fingerprint-$STAMP.txt"

echo ""
echo "=== 复跑汇总 ==="
for row in "${ROWS[@]}"; do
  IFS='|' read -r name cmd start end rc log <<<"$row"
  echo "| $name | \`$cmd\` | $start | $end | $rc | \`$log\` |"
done
echo "STAMP=$STAMP"
