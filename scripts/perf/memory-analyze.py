#!/usr/bin/env python3
"""从 sampler JSONL 提取内存增长斜率（每分钟趋势），用于 P1-01 内存根因分析。

用法：
    python scripts/perf/memory-analyze.py docs/performance/results/DIAG-xxx.jsonl [...]
    python scripts/perf/memory-analyze.py --json out.json <jsonl...>

输出：每个指标的 min / max / 首末值 / 线性斜率(每分钟) / 尾段斜率(后半程每分钟)。
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

def _dig(obj, *keys, default=None):
    cur = obj
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
        if cur is None:
            return default
    return cur


# 采样记录里关注的标量指标：名称 -> 取值函数
METRICS = {
    "taskdock.private_mb": lambda s: _dig(s, "taskdock", "private_mb"),
    "taskdock.ws_mb": lambda s: _dig(s, "taskdock", "ws_mb"),
    "webview2_tree.private_mb": lambda s: _dig(s, "webview2_tree", "private_mb"),
    "webview2_tree.ws_mb": lambda s: _dig(s, "webview2_tree", "ws_mb"),
    "rust.live_bytes": lambda s: _dig(s, "stats", "process", "live_bytes"),
    "rust.peak_bytes": lambda s: _dig(s, "stats", "process", "peak_bytes"),
    "rust.total_allocated_bytes": lambda s: _dig(s, "stats", "process", "total_allocated_bytes"),
    "rust.alloc_calls": lambda s: _dig(s, "stats", "process", "alloc_calls"),
    "tokio.alive_tasks": lambda s: _dig(s, "stats", "runtime", "alive_tasks"),
    "http.active_connections": lambda s: _dig(s, "stats", "http", "active_connections"),
    "http.max_active_requests": lambda s: _dig(s, "stats", "http", "max_active_requests"),
    "db.wal_bytes": lambda s: _dig(s, "stats", "db", "wal_bytes"),
    "db.db_bytes": lambda s: _dig(s, "stats", "db", "db_bytes"),
    "db.page_count": lambda s: _dig(s, "stats", "db", "pragma", "page_count"),
    "pipeline.queue_depth_events": lambda s: _dig(s, "stats", "queue_depth_events"),
    "pipeline.merge_buffer": lambda s: _dig(s, "stats", "merge_buffer"),
    "pipeline.events_received": lambda s: _dig(s, "stats", "events_received"),
    "notify.attempted": lambda s: _dig(s, "stats", "notifications", "attempted"),
    "proc_count": lambda s: _dig(s, "system", "process_count"),
}


def load_samples(path: Path) -> list[dict]:
    samples = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("record") == "sample":
                samples.append(rec)
    return samples


def slope_per_min(xs: list[float], ys: list[float]) -> float | None:
    """最小二乘斜率，换算成「每分钟」增量。"""
    n = len(xs)
    if n < 3:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    return b * 60.0


def analyze(path: Path) -> dict:
    samples = load_samples(path)
    if not samples:
        return {"file": str(path), "error": "no samples"}
    ts = [s.get("elapsed_s", 0.0) for s in samples]
    out: dict = {
        "file": str(path),
        "samples": len(samples),
        "span_s": round(max(ts) - min(ts), 3) if ts else 0.0,
        "first_t": samples[0].get("t"),
        "last_t": samples[-1].get("t"),
        "metrics": {},
    }
    for name, getter in METRICS.items():
        pairs = [(t, getter(s)) for t, s in zip(ts, samples)]
        pairs = [(t, v) for t, v in pairs if isinstance(v, (int, float))]
        if len(pairs) < 3:
            continue
        xs = [p[0] for p in pairs]
        ys = [float(p[1]) for p in pairs]
        half = len(xs) // 2
        m = {
            "min": min(ys),
            "max": max(ys),
            "first": ys[0],
            "last": ys[-1],
            "delta": round(ys[-1] - ys[0], 4),
            "slope_per_min": None,
            "tail_slope_per_min": None,
            "samples": len(ys),
        }
        s = slope_per_min(xs, ys)
        if s is not None:
            m["slope_per_min"] = round(s, 5)
        st = slope_per_min(xs[half:], ys[half:])
        if st is not None:
            m["tail_slope_per_min"] = round(st, 5)
        out["metrics"][name] = m
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", default=None, help="把完整结果写到这个 JSON 文件")
    args = ap.parse_args()

    reports = [analyze(Path(f)) for f in args.files]
    for r in reports:
        print(f"=== {r['file']}  samples={r.get('samples')} span={r.get('span_s')}s")
        for name, m in r.get("metrics", {}).items():
            print(
                f"  {name:34s} min={m['min']:>12} max={m['max']:>12} "
                f"first={m['first']:>12} last={m['last']:>12} d={m['delta']:>12} "
                f"slope/min={m['slope_per_min']} tail/min={m['tail_slope_per_min']}"
            )
    if args.json:
        Path(args.json).write_text(
            json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n写入 {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
