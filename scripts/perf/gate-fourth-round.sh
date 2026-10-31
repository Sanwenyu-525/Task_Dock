#!/usr/bin/env bash
# 第四轮工程门禁：逐条执行并留存原始输出与退出码。
# 用法：bash scripts/perf/gate-fourth-round.sh <证据前缀> [跳过前端门禁]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX="${1:?用法: gate-fourth-round.sh <证据前缀>}"
SKIP_FRONTEND="${2:-no}"

STAMP="$(date +%Y%m%d-%H%M)"
OUT_DIR="$ROOT/docs/clipboard/evidence"
mkdir -p "$OUT_DIR"

export CARGO_TARGET_DIR="$ROOT/src-tauri/target-accept"
# 构建前守卫：磁盘空间不足或缓存异常时阻塞（退出码 2）。
node "$ROOT/scripts/build-guard.mjs" precheck || exit 2
cd "$ROOT/src-tauri"

run() {
  local name="$1"; shift
  local log="$OUT_DIR/gate-$name-$STAMP.log"
  local start end code
  start="$(date +%s)"
  echo "[gate] $name 开始 $(date -Iseconds)"
  "$@" >"$log" 2>&1
  code=$?
  end="$(date +%s)"
  echo "[gate] $name 退出码=$code 用时=$((end - start))s 日志=$log"
  printf '%s\t%s\t%s\t%s\n' "$name" "$code" "$((end - start))" "$log" >>"$OUT_DIR/gate-fourth-round-$STAMP.tsv"
  return $code
}

FAIL=0
run fmt cargo fmt --all -- --check || FAIL=1
run clippy cargo clippy --all-targets --all-features || FAIL=1
run test-all cargo test --all-targets --no-fail-fast || FAIL=1
run test-clipboard cargo test --lib clipboard:: || FAIL=1

if [ "$SKIP_FRONTEND" != "skip" ]; then
  cd "$ROOT"
  run tsc npx tsc --noEmit || FAIL=1
  run vitest npx vitest run || FAIL=1
  run npm-build npm run build || FAIL=1
fi

echo "[gate] 汇总前缀=$STAMP 失败标记=$FAIL"
exit $FAIL
