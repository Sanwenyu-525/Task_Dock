#!/usr/bin/env python3
"""采样期间记录主进程是否附着了输入法（TSF/IME）模块。

背景：本机装有搜狗输入法，IME 附着到应用窗口时会向进程加载 24 个模块
（SogouTSF.ime / TextShaping.dll / dwrite.dll …），Private Bytes 会一次性抬升约 32 MB。
这个台阶是环境产物，不是应用的增长项；把它单独标出来，曲线才可解读。

用法：
  python scripts/perf/ime-watch.py --out docs/performance/results/IMEWATCH-<ts>.jsonl \\
      --duration 2100 --interval 15
"""

import argparse
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

IME_MARKERS = ("sogou", ".ime", "textshaping", "bundle", "dwrite.dll", "d2d1.dll")


def task_dock_pids():
    out = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-Process task-dock -ErrorAction SilentlyContinue | "
            "ForEach-Object { $_.Id }",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return [int(x) for x in out.stdout.split() if x.strip().isdigit()]


def snapshot(pid):
    script = (
        "$p=Get-Process -Id " + str(pid) + "; "
        "$mods=@($p.Modules | ForEach-Object { $_.ModuleName }); "
        "$ime=@($mods | Where-Object { $_ -match '(?i)(sogou|\\.ime$|textshaping|bundle64)' }); "
        "[string]$p.PrivateMemorySize64 + '|' + [string]$p.WorkingSet64 + '|' + "
        "[string]$p.Modules.Count + '|' + [string]($ime -join ',')"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        timeout=90,
    )
    lines = [l for l in out.stdout.splitlines() if "|" in l]
    if not lines:
        return None
    raw = lines[-1].strip()
    parts = raw.split("|")
    if len(parts) < 4:
        return None
    try:
        priv = int(parts[0])
        ws = int(parts[1])
        mods = int(parts[2])
    except ValueError:
        return None
    ime = [m for m in parts[3].split(",") if m]
    return {
        "private_mb": round(priv / 1048576, 2),
        "ws_mb": round(ws / 1048576, 2),
        "module_count": mods,
        "ime_modules": ime,
        "ime_attached": bool(ime),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration", type=int, default=2100)
    ap.add_argument("--interval", type=int, default=15)
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    start = time.time()
    with open(out, "w", encoding="utf-8") as f:
        while time.time() - start < args.duration:
            pids = task_dock_pids()
            row = {
                "record": "ime",
                "t": datetime.now(timezone.utc).isoformat(),
                "elapsed_s": round(time.time() - start, 1),
                "pids": pids,
            }
            if pids:
                snap = snapshot(pids[0])
                if snap:
                    row.update(snap)
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            time.sleep(args.interval)
    print(f"[ime-watch] done -> {out}")


if __name__ == "__main__":
    main()
