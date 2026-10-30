#!/usr/bin/env python3
"""文件回退通道故障注入（P1-05 E 组）：容量耗尽 / 关键预留耗尽。

在隔离的 TASK_DOCK_DATA_DIR 下预置大量投递文件，直接调用真实的 Hook CLI
（task-dock.exe --agent-hook），不经过 HTTP（无 transport 配置），强制走文件回退：
- 普通事件在超过 5000 文件后必须被拒绝，并在 .inbox-failures.log 留下原因；
- 关键事件可使用 250 个预留额度；
- 预留也耗尽后关键事件同样被拒绝并记录，已有文件绝不被删除/覆盖。

用法：
  python scripts/perf/file-fallback-fault.py --exe <release task-dock.exe> \
    --dir <隔离数据目录> --out docs/performance/results/E-file-fallback.json
"""

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def count_json(inbox: Path):
    return sum(1 for p in inbox.glob("*.json")) if inbox.exists() else 0


def read_log(inbox: Path):
    log = inbox / ".inbox-failures.log"
    if not log.exists():
        return []
    text = log.read_text(encoding="utf-8", errors="replace")
    return [ln for ln in text.splitlines() if ln.strip()][-8:]


def fill(inbox: Path, target: int):
    inbox.mkdir(parents=True, exist_ok=True)
    existing = count_json(inbox)
    for i in range(existing, target):
        (inbox / f"fill-{i:05d}.json").write_text('{"schema_version":1}', encoding="utf-8")
    return count_json(inbox)


def run_hook(exe: Path, data_dir: Path, event: str, session: str):
    env = dict(os.environ)
    env["TASK_DOCK_DATA_DIR"] = str(data_dir)
    payload = json.dumps({"session_id": session, "cwd": str(data_dir)})
    t0 = datetime.now(timezone.utc)
    proc = subprocess.run(
        [str(exe), "--agent-hook", "--source", "codex", "--event", event],
        input=payload.encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=60,
    )
    return {
        "event": event,
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace")[:500],
        "stderr": proc.stderr.decode("utf-8", "replace")[:500],
        "started_at": t0.isoformat(timespec="seconds"),
        "elapsed_ms": int((datetime.now(timezone.utc) - t0).total_seconds() * 1000),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", default="docs/performance/results/E-file-fallback.json")
    args = ap.parse_args()

    exe = Path(args.exe)
    data_dir = Path(args.dir)
    inbox = data_dir / "agent-inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    # 保证无 HTTP 传输配置，强制走文件回退
    for stale in ("hook-transport.json", "http-ingest.json"):
        p = data_dir / stale
        if p.exists():
            p.unlink()

    cases = []

    # 1) 普通事件：容量耗尽 → 拒绝并记录
    base = fill(inbox, 5050)
    before = count_json(inbox)
    r1 = run_hook(exe, data_dir, "PreToolUse", "quota-normal")
    after = count_json(inbox)
    cases.append({
        "case": "running-over-quota",
        "files_before": before,
        "files_after": after,
        "accepted": after > before,
        **r1,
        "failure_log": read_log(inbox),
    })

    # 2) 关键事件：使用预留额度 → 受理
    before = count_json(inbox)
    r2 = run_hook(exe, data_dir, "Stop", "quota-critical-headroom")
    after = count_json(inbox)
    cases.append({
        "case": "critical-headroom",
        "files_before": before,
        "files_after": after,
        "accepted": after > before,
        **r2,
        "failure_log": read_log(inbox),
    })

    # 3) 关键预留也耗尽（> 5000 + 250）→ 拒绝并记录，不删除既有文件
    filled = fill(inbox, 5260)
    before = count_json(inbox)
    r3 = run_hook(exe, data_dir, "Stop", "quota-critical-exhausted")
    after = count_json(inbox)
    cases.append({
        "case": "critical-exhausted",
        "files_before": before,
        "files_after": after,
        "accepted": after > before,
        "prefilled": filled,
        **r3,
        "failure_log": read_log(inbox),
    })

    report = {
        "scenario": "file-fallback-quota",
        "started_at": now_iso(),
        "data_dir": str(data_dir),
        "exe": str(exe),
        "cases": cases,
        "pass": (
            not cases[0]["accepted"]
            and cases[1]["accepted"]
            and not cases[2]["accepted"]
            and cases[2]["files_before"] == cases[2]["files_after"]
        ),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"[结果] {args.out}")


if __name__ == "__main__":
    main()
