#!/usr/bin/env bash
# v0.5 第五轮内存测量链：针对 §5.4「内存稳定性 NOT PROVEN」做归因 + 用当前 release 构建复跑长跑曲线。
#
# 组成：
#   1) 三臂归因：N1（负载+通知开）/ N2（负载+通知关）/ N3（空闲基线）
#      → 三者差值可区分「通知路径」「接入路径」「基线漂移」；
#   2) A–F 套件中的 C（UI+HTTP 负载 30 分钟）与 E（负载后空闲 30 分钟）
#      → 当前 release 构建的长跑曲线（对应发布条件第 2 条）。
#
# 隔离要点：
#   - 测量实例用改名副本（进程名同时含 task 与 dock，且与并行会话的副本名不同）：
#     并行会话的托盘退出自动化（quit-under-load.py）会因检测到同名 Task Dock 实例而拒绝执行，
#     避免再次误退被测实例（第四轮 N2/N3 臂就是这样被退掉的）；
#     同时测量脚本按「精确进程名」拒绝同名多实例，避免采样串组。
#   - 每臂独立数据目录 / APPDATA / 端口，绝不接触用户真实库；
#   - SOURCE=bridge + --allow-real-source：服务端按来源判定，只有 real 事件才触发系统通知，
#     否则「通知路径差值」恒为 0、无法归因。
set -uo pipefail
cd "$(dirname "$0")/../.."

EXE="${EXE:-src-tauri/target/release/task-dock.exe}"
WORK="${WORK:-C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-v05r5}"
PORT_TRIAD="${PORT_TRIAD:-47910}"
PORT_AF="${PORT_AF:-47920}"
SOURCE="${SOURCE:-bridge}"
DURATION="${DURATION:-480}"
POST="${POST:-90}"
RESULTS="docs/performance/results"
LOG_DIR="docs/clipboard/evidence"
mkdir -p "$WORK" "$RESULTS" "$LOG_DIR"

ACC_EXE="$WORK/${ACC_NAME:-task-dock-acc9.exe}"
cp -f "$EXE" "$ACC_EXE"
echo "[chain] 测量副本=$ACC_EXE $(date -Iseconds)"
ls -la --time-style=full-iso "$ACC_EXE"
sha256sum "$ACC_EXE"
bash scripts/perf/source-fingerprint.sh 2>/dev/null | grep -E "^(git_head_short|dirty)" || true

echo ""
echo "[chain] === 三臂归因开始 $(date -Iseconds) ==="
EXE="$ACC_EXE" WORK="$WORK" SOURCE="$SOURCE" DURATION="$DURATION" POST="$POST" \
  PORT_BASE="$PORT_TRIAD" bash scripts/perf/memory-notify-suite.sh
echo "[chain] === 三臂归因结束 rc=$? $(date -Iseconds) ==="

echo ""
echo "[chain] === C/E 30 分钟臂开始 $(date -Iseconds) ==="
EXE="$ACC_EXE" WORK="$WORK" SOURCE="$SOURCE" \
  ONLY="C-ui-http-30min,E-idle-after-load-30min" PORT_BASE="$PORT_AF" \
  bash scripts/perf/memory-af-suite.sh
echo "[chain] === C/E 结束 rc=$? $(date -Iseconds) ==="

echo ""
echo "[chain] 全部结束 $(date -Iseconds)"
ls -t "$RESULTS"/DIAG-N[123]-*.jsonl 2>/dev/null | head -6
