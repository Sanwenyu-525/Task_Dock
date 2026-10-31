#!/usr/bin/env bash
# P1-04 / P1-05 第四轮长跑套件：两个可对照的 30 分钟负载臂 + 真实剪贴板联合负载臂。
#
# 说明：
# - 使用改名副本（task-dock-acc1.exe）启动测量实例：采样器按进程名归组资源占用，
#   与并行会话可能存在的 task-dock.exe 实例互不串组；单实例锁按数据目录隔离。
# - 每臂结束后用 memory-phases.py 做分段分析（预热/负载/负载尾段/后段）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_EXE="${SRC_EXE:-$ROOT/src-tauri/target-accept/release/task-dock.exe}"
WORK="${WORK:-C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-v05-fourth}"
DURATION="${DURATION:-1800}"
POST="${POST:-600}"
RESULTS="$ROOT/docs/performance/results"
LOG_DIR="$ROOT/docs/clipboard/evidence"
mkdir -p "$LOG_DIR" "$RESULTS"

if [ ! -f "$SRC_EXE" ]; then
  echo "[suite] 缺少 Release 可执行文件: $SRC_EXE" >&2
  exit 2
fi

ACC_EXE="$WORK/task-dock-acc1.exe"
mkdir -p "$WORK"
cp -f "$SRC_EXE" "$ACC_EXE"

arm() {
  local name="$1"; shift
  local log="$LOG_DIR/perf-$name-$(date +%Y%m%d-%H%M).log"
  echo "[suite] 臂 $name 开始 $(date -Iseconds) 日志=$log"
  python "$ROOT/scripts/perf/memory-scenario.py" --exe "$ACC_EXE" --name "$name" \
    --duration "$DURATION" --post "$POST" "$@" >"$log" 2>&1
  local rc=$?
  echo "[suite] 臂 $name 退出码=$rc"
  local jsonl meta
  jsonl=$(ls -t "$RESULTS"/DIAG-$name-*.jsonl 2>/dev/null | head -1)
  meta=$(ls -t "$RESULTS"/DIAG-$name-*-meta.json 2>/dev/null | head -1)
  if [ -n "$jsonl" ] && [ -n "$meta" ]; then
    local analysis="$RESULTS/analysis-$name-$(date +%Y%m%d-%H%M).json"
    python "$ROOT/scripts/perf/memory-phases.py" --jsonl "$jsonl" --meta "$meta" --out "$analysis" \
      >"$LOG_DIR/analysis-$name-$(date +%Y%m%d-%H%M).log" 2>&1
    echo "[suite] 臂 $name 分段分析=$analysis"
  else
    echo "[suite] 臂 $name 未产出 jsonl/meta，分析跳过" >&2
  fi
  return $rc
}

# 臂 A / 臂 B：同参数对照跑，证明结论可重复（不是一次偶然）。
arm fourth-round-memory-a --mode mixed --notify on --window visible --rate 5 --agents 4 --port 47851
arm fourth-round-memory-b --mode mixed --notify on --window visible --rate 5 --agents 4 --port 47852

# 臂 C：真实 Windows 剪贴板事件 + Agent 负载同时进行（P1-05）。
# clipboard_enabled=true 才会采集；剪贴板来源必须是第三方前台窗口（本臂由记事本承前台）。
arm fourth-round-joint-clipboard --mode mixed --notify on --window minimized --rate 5 --agents 4 \
  --port 47853 --clipboard-stimulus on --clipboard-interval 5 --clipboard-image-every 6 \
  --settings-json '{"clipboard_enabled": true, "clipboard_capture_images": true, "clipboard_capture_html": true}'

echo "[suite] 全部臂结束 $(date -Iseconds)"
