#!/usr/bin/env python3
"""按时间分段计算内存斜率：整体斜率会被启动预热拉高，判断「是否泄漏」要看
后段（负载稳定后）是否仍在增长。只读 sampler jsonl，不做任何测量。

用法：python scripts/perf/analyze-memory.py docs/performance/results/DIAG-B-*.jsonl
"""

import json
import sys
from pathlib import Path


def slope(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


def seg(rows, lo, hi, pick):
    pts = [(r["elapsed_s"], pick(r)) for r in rows]
    pts = [(t, v) for t, v in pts if lo <= t < hi and isinstance(v, (int, float))]
    if len(pts) < 3:
        return None
    m = slope([p[0] for p in pts], [p[1] for p in pts]) * 60
    return round(m, 3), len(pts), round(pts[-1][1], 2)


def main(paths):
    for p in paths:
        path = Path(p)
        rows = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        samples = [r for r in rows if r.get("record") == "sample"]
        if not samples:
            print(f"{path.name}: 无样本")
            continue
        total = samples[-1]["elapsed_s"]
        stats = [r for r in samples if isinstance(r.get("stats"), dict) and not r["stats"].get("error")]
        print(f"\n=== {path.name}  samples={len(samples)} elapsed={total:.0f}s ===")
        picks = {
            "taskdock_private_mb": lambda r: r["taskdock"]["private_mb"],
            "taskdock_ws_mb": lambda r: r["taskdock"]["ws_mb"],
            "webview2_tree_private_mb": lambda r: r["webview2_tree"]["private_mb"],
            "handles": lambda r: r["taskdock"].get("handles"),
            "threads": lambda r: r["taskdock"].get("threads"),
        }
        segs = [(0, 300, "0-5min"), (300, 900, "5-15min"), (900, total + 1, "15min-end")]
        for name, pick in picks.items():
            parts = []
            for lo, hi, label in segs:
                got = seg(samples, lo, hi, pick)
                parts.append(f"{label}={got[0] if got else 'n/a'} MB/min" if got else f"{label}=n/a")
            vals = [v for v in (pick(r) for r in samples) if isinstance(v, (int, float))]
            parts.append(f"range=[{min(vals)}, {max(vals)}] end={vals[-1]}")
            print(f"  {name:26s} " + " · ".join(parts))
        if stats:
            live = [s["stats"]["process"]["live_bytes"] for s in stats if "process" in s["stats"]]
            tasks = [s["stats"].get("runtime", {}).get("alive_tasks") for s in stats]
            tasks = [t for t in tasks if isinstance(t, (int, float))]
            wal = [s["stats"]["db"]["wal_bytes"] for s in stats if s["stats"].get("db")]
            n = [s["stats"].get("notifications", {}).get("attempted") for s in stats]
            n = [x for x in n if isinstance(x, (int, float))]
            print(
                f"  rust_live_bytes            range=[{min(live)}, {max(live)}] end={live[-1]}"
                if live
                else "  rust_live_bytes            n/a"
            )
            print(
                f"  alive_tasks                range=[{min(tasks)}, {max(tasks)}] end={tasks[-1]}"
                if tasks
                else "  alive_tasks                n/a"
            )
            print(
                f"  wal_bytes                  range=[{min(wal)}, {max(wal)}] end={wal[-1]}"
                if wal
                else "  wal_bytes                  n/a"
            )
            print(f"  notifications.attempted    end={n[-1] if n else 'n/a'}")


if __name__ == "__main__":
    main(sys.argv[1:])
