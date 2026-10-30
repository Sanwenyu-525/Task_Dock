#!/usr/bin/env python3
"""从 sampler.ps1 原始 JSONL 重算时间统计（不修改原始数据）。

背景：2026-10-30 之前的 sampler.ps1 把 `interval_s` 写成了「本轮采样耗时」
（elapsed - tickStart），而不是相邻样本开始间隔；CPU% 内部用的是正确窗口，
因此 CPU 数值不受影响。本脚本以样本时间戳 `t` / `elapsed_s` 重算真实间隔，
并单独报告旧 `interval_s`（实为采样耗时）。

用法：
  python scripts/perf/sampler-recompute.py --out docs/performance/results/sampler-recompute-<ts>.json \
      <raw1.jsonl> [<raw2.jsonl> ...]
"""

import argparse
import json
import statistics
from datetime import datetime, timezone


def parse_ts(text):
    # PowerShell "o" 格式带 7 位小数与偏移，fromisoformat 在 3.11+ 支持
    return datetime.fromisoformat(text)


def analyze(path):
    samples = []
    meta_start = None
    meta_end = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("record") == "meta":
                if "started_at" in obj:
                    meta_start = obj
                elif "ended_at" in obj:
                    meta_end = obj
            elif obj.get("record") == "sample":
                samples.append(obj)

    gaps = []
    prev = None
    for s in samples:
        try:
            t = parse_ts(s["t"])
        except (KeyError, ValueError):
            continue
        if prev is not None:
            gaps.append((t - prev).total_seconds())
        prev = t

    elapsed = [s["elapsed_s"] for s in samples if isinstance(s.get("elapsed_s"), (int, float))]
    span_elapsed = (elapsed[-1] - elapsed[0]) if len(elapsed) >= 2 else 0.0

    legacy = [s["interval_s"] for s in samples if isinstance(s.get("interval_s"), (int, float))]
    durations = [
        s["sample_duration_s"]
        for s in samples
        if isinstance(s.get("sample_duration_s"), (int, float))
    ]
    planned = [
        s["planned_interval_s"]
        for s in samples
        if isinstance(s.get("planned_interval_s"), (int, float))
    ]
    actual = [
        s["actual_interval_s"]
        for s in samples
        if isinstance(s.get("actual_interval_s"), (int, float))
    ]

    def stat(values):
        if not values:
            return None
        ordered = sorted(values)
        n = len(ordered)
        return {
            "n": n,
            "min": round(ordered[0], 3),
            "median": round(statistics.median(ordered), 3),
            "mean": round(statistics.fmean(ordered), 3),
            "max": round(ordered[-1], 3),
            "p95": round(ordered[min(n - 1, int(round(0.95 * (n - 1))))], 3),
        }

    return {
        "file": path,
        "samples": len(samples),
        "meta_started_at": (meta_start or {}).get("started_at"),
        "meta_ended_at": (meta_end or {}).get("ended_at"),
        "planned_interval_sec_meta": (meta_start or {}).get("interval_sec"),
        "timestamp_span_s": round(
            (parse_ts(samples[-1]["t"]) - parse_ts(samples[0]["t"])).total_seconds(), 3
        )
        if len(samples) >= 2
        else 0.0,
        "elapsed_span_s": round(span_elapsed, 3),
        "gap_from_timestamps_s": stat(gaps),
        "actual_interval_s": stat(actual),
        "planned_interval_s": stat(planned),
        "legacy_interval_s": stat(legacy),
        "sample_duration_s": stat(durations),
        "legacy_interval_semantics": (
            "旧 sampler 的 interval_s = 本轮采样耗时（elapsed - tickStart），"
            "不是相邻样本间隔；新 sampler 已拆为 actual_interval_s / sample_duration_s / planned_interval_s，"
            "interval_s 现等于 actual_interval_s。"
        ),
        "cpu_note": (
            "旧版 CPU% 计算使用 tickStart 差值（真实间隔），不是 interval_s 字段，"
            "因此 CPU 统计不受该字段语义错误影响。"
        ),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("inputs", nargs="+")
    args = ap.parse_args()

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tool": "scripts/perf/sampler-recompute.py",
        "raw_data_modified": False,
        "files": [analyze(p) for p in args.inputs],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
