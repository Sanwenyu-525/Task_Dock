#!/usr/bin/env python3
"""按阶段切分采样序列做内存/资源趋势分析。

memory-analyze.py 给的是整段线性斜率，但长跑结论必须按阶段给：
  warmup（预热）→ load（负载）→ post（负载结束后的观察窗）
把三段拼在一起算斜率，会把「负载期爬升 + 负载后回落」平均成一条无意义的直线。

阶段边界用数据驱动：负载期 = /api/v1/stats 里 http_accepted 开始增长到停止增长的那段；
没有 http 接入时退化为 meta 里的 duration/post + 采样启动偏移。
进程死亡后的样本一律剔除（内存读数 0 会把「实例已退出」读成「内存回落」）。

用法：
  python scripts/perf/memory-phases.py \
      --jsonl docs/performance/results/DIAG-R4-xxx.jsonl \
      --meta docs/performance/results/DIAG-R4-xxx-meta.json \
      --out docs/performance/results/MEM-R4-xxx.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

SCALARS = {
    "taskdock.private_mb": lambda s: s.get("taskdock", {}).get("private_mb"),
    "taskdock.ws_mb": lambda s: s.get("taskdock", {}).get("ws_mb"),
    "taskdock.threads": lambda s: s.get("taskdock", {}).get("threads"),
    "taskdock.handles": lambda s: s.get("taskdock", {}).get("handles"),
    "taskdock.cpu_pct": lambda s: s.get("taskdock", {}).get("cpu_pct"),
    "webview2_tree.private_mb": lambda s: s.get("webview2_tree", {}).get("private_mb"),
    "webview2_tree.threads": lambda s: s.get("webview2_tree", {}).get("threads"),
    "rust.live_bytes": lambda s: (s.get("stats") or {}).get("process", {}).get("live_bytes"),
    "rust.peak_bytes": lambda s: (s.get("stats") or {}).get("process", {}).get("peak_bytes"),
    "tokio.alive_tasks": lambda s: (s.get("stats") or {}).get("runtime", {}).get("alive_tasks"),
    "db.page_count": lambda s: (s.get("stats") or {}).get("db", {}).get("pragma", {}).get("page_count"),
    "db.db_bytes": lambda s: (s.get("stats") or {}).get("db", {}).get("db_bytes"),
    "db.wal_bytes": lambda s: (s.get("stats") or {}).get("db", {}).get("wal_bytes"),
    "db.read_avg_ms": lambda s: (s.get("stats") or {}).get("db", {}).get("read", {}).get("avg_ms"),
    "pipeline.queue_depth_events": lambda s: (s.get("stats") or {}).get("queue_depth_events"),
    "pipeline.merge_buffer": lambda s: (s.get("stats") or {}).get("merge_buffer"),
    "pipeline.events_received": lambda s: (s.get("stats") or {}).get("events_received"),
    "pipeline.events_processed": lambda s: (s.get("stats") or {}).get("events_processed"),
    "pipeline.events_merged": lambda s: (s.get("stats") or {}).get("events_merged"),
    "pipeline.commit_failures": lambda s: (s.get("stats") or {}).get("commit_failures"),
    "pipeline.overload_rejects": lambda s: (s.get("stats") or {}).get("overload_rejects"),
    "http.accepted": lambda s: (s.get("stats") or {}).get("http_accepted"),
    "notify.attempted": lambda s: (s.get("stats") or {}).get("notifications", {}).get("attempted"),
    "notify.succeeded": lambda s: (s.get("stats") or {}).get("notifications", {}).get("succeeded"),
    "notify.failed": lambda s: (s.get("stats") or {}).get("notifications", {}).get("failed"),
    "system.process_count": lambda s: s.get("system", {}).get("process_count"),
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
    n = len(xs)
    if n < 3:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom
    return b * 60.0


def phase_bounds(samples: list[dict], meta: dict | None) -> dict:
    """定位 warmup / load / post 的时间边界（相对采样起点，单位秒）。"""
    span = samples[-1]["elapsed_s"] if samples else 0.0
    load_start = load_end = None
    prev_accepted = None
    first_growth = None
    last_growth = None
    for s in samples:
        st = s.get("stats")
        if not st:
            continue
        acc = st.get("http_accepted")
        if not isinstance(acc, (int, float)):
            continue
        if prev_accepted is not None and acc > prev_accepted:
            if first_growth is None:
                first_growth = s["elapsed_s"]
            last_growth = s["elapsed_s"]
        prev_accepted = acc
    if first_growth is not None:
        load_start = first_growth
        # 负载结束 = 最后一个增长样本之后的第一条样本
        after = [s["elapsed_s"] for s in samples if s["elapsed_s"] > last_growth]
        load_end = after[0] if after else span
    elif meta:
        duration = float(meta.get("duration_s") or 0)
        post = float(meta.get("post_s") or 0)
        # memory-scenario.py：采样器启动后固定 sleep 6s 才开始打负载
        load_start = 6.0
        load_end = load_start + duration
    else:
        load_start, load_end = 0.0, span
    return {
        "warmup": (0.0, load_start),
        "load": (load_start, load_end),
        "post": (load_end, span),
        "span_s": round(span, 1),
        "boundary_source": "http_accepted 增长区间" if first_growth is not None else "meta duration/post",
    }


def segment(samples: list[dict], lo: float, hi: float) -> list[dict]:
    return [s for s in samples if lo <= s["elapsed_s"] <= hi]


def summarize(samples: list[dict]) -> dict:
    out: dict = {}
    for name, getter in SCALARS.items():
        pairs = [(s["elapsed_s"], getter(s)) for s in samples]
        pairs = [(t, v) for t, v in pairs if isinstance(v, (int, float))]
        if not pairs:
            continue
        xs = [p[0] for p in pairs]
        ys = [float(p[1]) for p in pairs]
        entry = {
            "n": len(ys),
            "first": ys[0],
            "last": ys[-1],
            "min": min(ys),
            "max": max(ys),
            "mean": round(statistics.fmean(ys), 3),
            "delta": round(ys[-1] - ys[0], 3),
        }
        sl = slope_per_min(xs, ys)
        entry["slope_per_min"] = round(sl, 5) if sl is not None else None
        out[name] = entry
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jsonl", required=True)
    ap.add_argument("--meta", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    jsonl = Path(args.jsonl)
    meta = None
    if args.meta and Path(args.meta).exists():
        meta = json.loads(Path(args.meta).read_text(encoding="utf-8"))

    samples = load_samples(jsonl)
    alive = [s for s in samples if (s.get("taskdock") or {}).get("count", 0) > 0]
    dead = len(samples) - len(alive)
    if not alive:
        print(json.dumps({"error": "无存活样本", "samples_total": len(samples)}, ensure_ascii=False))
        return 1
    bounds = phase_bounds(alive, meta)

    phases = {}
    for name in ("warmup", "load", "post"):
        lo, hi = bounds[name]
        seg = segment(alive, lo, hi)
        phases[name] = {
            "window_s": [round(lo, 1), round(hi, 1)],
            "samples": len(seg),
            "metrics": summarize(seg),
        }

    # 负载期按四分之一再切一次：线性增长会在后半段平坦，尾段斜率最能暴露泄漏。
    lo, hi = bounds["load"]
    load_seg = segment(alive, lo, hi)
    tail_lo = lo + (hi - lo) * 0.75
    tail = segment(alive, tail_lo, hi)
    phases["load_tail_quarter"] = {
        "window_s": [round(tail_lo, 1), round(hi, 1)],
        "samples": len(tail),
        "metrics": summarize(tail),
    }

    report = {
        "jsonl": str(jsonl),
        "meta": str(args.meta) if args.meta else None,
        "scenario": (meta or {}).get("scenario"),
        "source_exe": (meta or {}).get("source_exe"),
        "source_exe_bytes": (meta or {}).get("source_exe_bytes"),
        "samples_total": len(samples),
        "samples_alive": len(alive),
        "samples_after_process_exit": dead,
        "process_exited_during_run": dead > 0,
        "bounds": bounds,
        "phases": phases,
        "load_json": (meta or {}).get("load_json"),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"写入 {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
