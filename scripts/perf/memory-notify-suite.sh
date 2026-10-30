#!/usr/bin/env bash
# 内存增长的「通知路径 vs 接入路径 vs 基线漂移」三臂对照。
#
# 与 memory-af-suite.sh 的区别：
#   - memory-af-suite.sh 是 30 分钟量级的发布级长跑（A–F 六臂），用于稳定性判据；
#   - 本脚本是同口径的短对照（默认 8 分钟负载），一次跑出三个可相减的差值：
#       N1 负载 + 通知开   ──┐
#       N2 负载 + 通知关   ──┼─→ 通知路径贡献 = N1 − N2
#       N3 空闲（无负载）  ──┘─→ 接入路径贡献 = N2 − N3，基线漂移 = N3
#
# 三臂使用同一个 release 二进制，各自独立数据目录 / APPDATA / 端口，互不干扰。
# 每臂都会记录 alloc_stats 的 live_bytes（Rust 侧活跃分配）与进程 Private Bytes，
# 二者之差用于区分「Rust 泄漏」与「分配器保留/原生内存增长」。
set -uo pipefail
cd "$(dirname "$0")/../.."

EXE="${EXE:-src-tauri/target/release/task-dock.exe}"
WORK="${WORK:-C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-abc}"
PORT_BASE="${PORT_BASE:-47890}"
DURATION="${DURATION:-480}"
POST="${POST:-90}"
# 三臂对照默认使用真实类别来源 bridge：服务端按 origin 判定，**只有 real 事件**
# 才会产生系统通知——若用隔离来源 bench，N1 与 N2 的通知路径完全相同，差值恒为 0，
# 「通知路径贡献」无法测量。隔离保证来自「隔离实例」：独立数据目录 / APPDATA / 端口，
# 用完即弃，绝不接触用户真实库。
# 要验证「隔离来源永不产生通知」的行为，改用 SOURCE=bench 运行本脚本。
SOURCE="${SOURCE:-bridge}"
EXTRA_ARGS=(--source "$SOURCE")
if [ "$SOURCE" != "bench" ]; then EXTRA_ARGS+=(--allow-real-source); fi
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="docs/performance/results"
mkdir -p "$OUT_DIR"

echo "=== 源码指纹 ==="
bash scripts/perf/source-fingerprint.sh 2>/dev/null | grep -E "^(git_head_short|dirty)" | tee "$OUT_DIR/MEMABC-fingerprint-$STAMP.txt"
ls -la --time-style=full-iso "$EXE" | tee -a "$OUT_DIR/MEMABC-fingerprint-$STAMP.txt"
sha256sum "$EXE" | tee -a "$OUT_DIR/MEMABC-fingerprint-$STAMP.txt"

run() {
  local name="$1"; shift
  local log="$OUT_DIR/MEMABC-$name-$STAMP.log"
  echo ""
  echo "=== [$name] 开始 $(date '+%H:%M:%S') ==="
  echo "    args: $*"
  echo "    log:  $log"
  # 不走管道：管道会缓冲到进程结束才输出，长场景看起来像卡死
  python scripts/perf/memory-scenario.py --exe "$EXE" --name "$name" --work-dir "$WORK" "$@" \
    > "$log" 2>&1
  # rc 必须在 $(date) 之前捕获：命令替换会先把 $? 覆盖成 0，
  # 写成 echo "… rc=$?" 会把失败轮次谎报成成功（v0.5 三臂对照曾因此误判 N3 成功）。
  local rc=$?
  echo "=== [$name] 结束 $(date '+%H:%M:%S') rc=$rc ==="
  tail -30 "$log"
  return $rc
}

# N1：负载 + 通知开（完整用户路径）
run "N1-load-notify-on" \
  --mode mixed --duration "$DURATION" --post "$POST" --agents 4 --rate 5 \
  --window visible --notify on --transport http "${EXTRA_ARGS[@]}" --port "$PORT_BASE"

# N2：同样负载，通知关（隔离通知路径）
run "N2-load-notify-off" \
  --mode mixed --duration "$DURATION" --post "$POST" --agents 4 --rate 5 \
  --window visible --notify off --transport http "${EXTRA_ARGS[@]}" --port "$((PORT_BASE+1))"

# N3：空闲基线（无负载，窗口可见）
run "N3-idle" \
  --mode running --duration 0 --post "$DURATION" \
  --window visible --notify off "${EXTRA_ARGS[@]}" --port "$((PORT_BASE+2))"

echo ""
echo "=== 三臂完成 $(date '+%H:%M:%S') ==="
ls -la "$OUT_DIR"/DIAG-N[123]-*.jsonl 2>/dev/null
