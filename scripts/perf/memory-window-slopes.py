#!/usr/bin/env python3
"""按时间窗计算采样序列的分段斜率（MB/min），用于长跑曲线的平台期判据。

用法：
  python scripts/perf/memory-window-slopes.py <DIAG-*.jsonl> \
      --metric taskdock.private_mb --windows 120:1200,1200:1800,1829:1946

窗口按 elapsed_s 左闭右开；进程不在的样本（taskdock.count == 0）不参与拟合。
"""

import argparse
import json
import sys


def slope(points):
    n = len(points)
    if n < 3:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    mx = sum(xs) / n
    my = sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


def metric_value(row, metric):
    cur = row
    for part in metric.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl")
    ap.add_argument("--metric", default="taskdock.private_mb")
    ap.add_argument(
        "--windows",
        required=True,
        help="逗号分隔的 起始:结束（秒），左闭右开",
    )
    args = ap.parse_args()

    windows = []
    for spec in args.windows.split(","):
        start_s, end_s = (float(x) for x in spec.split(":"))
        windows.append((start_s, end_s))

    rows = []
    for line in open(args.jsonl, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    samples = [r for r in rows if r.get("record") == "sample"]
    alive = [
        r
        for r in samples
        if (r.get("taskdock") or {}).get("count", 0) > 0
        and r.get("elapsed_s") is not None
    ]

    out = {
        "file": args.jsonl,
        "metric": args.metric,
        "samples_total": len(samples),
        "samples_alive": len(alive),
        "windows": [],
    }
    for start_s, end_s in windows:
        pts = []
        for r in alive:
            t = float(r["elapsed_s"])
            if start_s <= t < end_s:
                v = metric_value(r, args.metric)
                if isinstance(v, (int, float)):
                    pts.append((t, float(v)))
        s = slope(pts)
        out["windows"].append(
            {
                "start_s": start_s,
                "end_s": end_s,
                "n": len(pts),
                "first": round(pts[0][1], 3) if pts else None,
                "last": round(pts[-1][1], 3) if pts else None,
                "delta_mb": round(pts[-1][1] - pts[0][1], 3) if pts else None,
                "slope_mb_per_min": round(s * 60, 4) if s is not None else None,
            }
        )

    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    raise SystemExit(main())
