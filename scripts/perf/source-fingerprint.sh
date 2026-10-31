#!/usr/bin/env bash
# 源码指纹：把「这次测量用的是哪一份源码」固定下来。
# 性能结论必须指向唯一的源码版本，不能混用旧数据。
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "git_head=$(git rev-parse HEAD)"
echo "git_head_short=$(git rev-parse --short HEAD)"
echo "dirty_tracked=$(git diff --stat | tail -1 || true)"

# 参与构建的源码内容哈希（tracked 改动 + 未跟踪的 src-tauri/src、src、scripts、docs）
{
  git ls-files -s src-tauri/src src-tauri/Cargo.toml src-tauri/tauri.conf.json src scripts 2>/dev/null || true
  git diff -- src-tauri/src src-tauri/Cargo.toml src-tauri/tauri.conf.json src scripts 2>/dev/null || true
  git ls-files --others --exclude-standard src-tauri/src src scripts 2>/dev/null | while read -r f; do
    printf 'untracked %s %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
  done
} | sha256sum | awk '{print "source_tree_sha256=" $1}'

if [ -f src-tauri/target/release/task-dock.exe ]; then
  echo "release_exe_sha256=$(sha256sum src-tauri/target/release/task-dock.exe | cut -d' ' -f1)"
  echo "release_exe_bytes=$(stat -c%s src-tauri/target/release/task-dock.exe)"
  echo "release_exe_mtime=$(stat -c%y src-tauri/target/release/task-dock.exe)"
fi

# 实际被测量的可执行文件：可能是改名后的测量副本（避免与其它会话的同名实例串组）。
# 证据必须指向真正跑出数据的那一份二进制。
MEASURED_EXE="${1:-${EXE:-}}"
if [ -n "$MEASURED_EXE" ] && [ -f "$MEASURED_EXE" ]; then
  echo "measured_exe_path=$MEASURED_EXE"
  echo "measured_exe_sha256=$(sha256sum "$MEASURED_EXE" | cut -d' ' -f1)"
  echo "measured_exe_bytes=$(stat -c%s "$MEASURED_EXE")"
  echo "measured_exe_mtime=$(stat -c%y "$MEASURED_EXE")"
fi
