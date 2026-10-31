#!/usr/bin/env bash
# P1-01 内存 A–F 实验串行驱动。
#
# 隔离原则：每个场景独立数据目录 / APPDATA / 端口，只终止本脚本启动的进程；
# 串行执行，避免并发压测互相干扰内存与 CPU 采样。
set -uo pipefail
cd "$(dirname "$0")/../.."

EXE="${EXE:-src-tauri/target/release/task-dock.exe}"
WORK="${WORK:-C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-af}"
PORT_BASE="${PORT_BASE:-47880}"
# 压测来源默认隔离（bench：服务端判为 benchmark 归属，不进入真实状态/行动中心/系统通知）。
# 需要测量「通知路径」时用 SOURCE=bridge 运行（仅隔离实例，脚本会追加 --allow-real-source）。
SOURCE="${SOURCE:-bench}"
EXTRA_ARGS=(--source "$SOURCE")
if [ "$SOURCE" != "bench" ]; then EXTRA_ARGS+=(--allow-real-source); fi
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="docs/performance/results"
mkdir -p "$OUT_DIR"

echo "=== 源码指纹 ==="
bash scripts/perf/source-fingerprint.sh "$EXE" | tee "$OUT_DIR/MEM-fingerprint-$STAMP.txt"
ls -la --time-style=full-iso "$EXE" | tee -a "$OUT_DIR/MEM-fingerprint-$STAMP.txt"
sha256sum "$EXE" | tee -a "$OUT_DIR/MEM-fingerprint-$STAMP.txt"

# 只跑指定场景：ONLY=A,B（默认全跑）
ONLY="${ONLY:-}"
should_run() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}

run() {
  local name="$1"; shift
  local log="$OUT_DIR/MEM-$name-$STAMP.log"
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
  tail -40 "$log"
  return $rc
}

# A：空闲 30 分钟（无负载、无通知）——基线漂移
should_run A-idle-30min && run "A-idle-30min" \
  --idle --mode running --duration 1800 --post 120 \
  --window visible --notify off "${EXTRA_ARGS[@]}" --port "$PORT_BASE"

# B：仅 HTTP、无 UI 30 分钟（窗口隐藏）
should_run B-http-noui-30min && run "B-http-noui-30min" \
  --mode mixed --duration 1800 --post 120 --agents 4 --rate 5 \
  --window hidden --notify off --transport http "${EXTRA_ARGS[@]}" --port "$((PORT_BASE+1))"

# C：完整 UI + HTTP 30 分钟
should_run C-ui-http-30min && run "C-ui-http-30min" \
  --mode mixed --duration 1800 --post 120 --agents 4 --rate 5 \
  --window visible --notify off --transport http "${EXTRA_ARGS[@]}" --port "$((PORT_BASE+2))"

# D：完整桌面 + 文件回退 + 通知 30 分钟
should_run D-ui-file-notify-30min && run "D-ui-file-notify-30min" \
  --mode mixed --duration 1800 --post 120 --agents 4 --rate 5 \
  --window visible --notify on --transport file "${EXTRA_ARGS[@]}" --port "$((PORT_BASE+3))"

# E：负载后空闲 30 分钟（观察是否回落/平台化）
should_run E-idle-after-load-30min && run "E-idle-after-load-30min" \
  --mode mixed --duration 600 --post 1800 --agents 4 --rate 5 \
  --window visible --notify on --transport http "${EXTRA_ARGS[@]}" --port "$((PORT_BASE+4))"

# F：重复负载 60 分钟
should_run F-repeat-load-60min && run "F-repeat-load-60min" \
  --mode mixed --duration 3600 --post 300 --agents 4 --rate 5 \
  --window visible --notify on --transport http "${EXTRA_ARGS[@]}" --port "$((PORT_BASE+5))"

# G：真实来源 + 系统通知 30 分钟
# 复现 2026-10-30 10:13「整桌面 soak」的等价条件（source=bridge 被判为 real，
# 会真正走通知弹窗 / 真实状态跃迁 / 行动中心），用来判定 bench 臂看不到的路径。
# 只在隔离实例内运行：数据目录独立，弹窗来自本轮事件，不触碰用户实例。
should_run G-real-notify-30min && run "G-real-notify-30min" \
  --mode mixed --duration 1800 --post 120 --agents 4 --rate 5 \
  --window visible --notify on --transport http \
  --source bridge --allow-real-source --port "$((PORT_BASE+6))"

# H：真实来源但不弹通知 30 分钟（仅在 G 出现增长时运行，用于隔离弹窗路径）
should_run H-real-nonotify-30min && run "H-real-nonotify-30min" \
  --mode mixed --duration 1800 --post 120 --agents 4 --rate 5 \
  --window visible --notify off --transport http \
  --source bridge --allow-real-source --port "$((PORT_BASE+7))"

echo ""
echo "=== 全部场景完成 $(date '+%H:%M:%S') ==="
ls -la "$OUT_DIR"/DIAG-[A-F]-*.jsonl 2>/dev/null
