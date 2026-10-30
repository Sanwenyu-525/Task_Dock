#!/usr/bin/env python3
"""多臂内存对照分析：把若干 DIAG-*.jsonl 采样放在一起比较。

输出每个臂的：
  - task-dock 主进程 Private Bytes（首/末/线性斜率 MB/min）
  - Rust 侧活跃分配 alloc_stats.live_bytes（首/末/斜率 MB/min）
  - 差值 = Private 增长 − live 增长：分配器保留 / 原生内存（COM、GDI、SQLite 页缓存）

N1/N2/N3 三臂同时给出时，额外输出差值归因：
  N1（负载+通知开）− N2（负载+通知关）= 通知路径贡献
  N2（负载+通知关）− N3（空闲基线）  = 接入路径贡献
  N3                                   = 基线漂移

用法：
  python scripts/perf/memory-compare.py docs/performance/results/DIAG-N1-*.jsonl \\
      docs/performance/results/DIAG-N2-*.jsonl docs/performance/results/DIAG-N3-*.jsonl
"""

import json
import sys
from pathlib import Path


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def slope(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom


def mb(v):
    return None if v is None else round(v / 1048576, 3)


def analyze(path):
    rows = read_jsonl(path)
    samples = [r for r in rows if r.get("record") == "sample"]
    if not samples:
        return {"file": path.name, "samples": 0}
    # 进程不在时采样器仍会写一行（分组计数 0、内存读数 0）。
    # 把这些行算进斜率，会把「进程已经退出」读成「内存回落到 0」——
    # 2026-10-30 第二轮 N3 臂就是这样得出「空闲释放内存」的假结论。
    # 因此这里只用进程存活期内的样本，并显式标出进程消失过。
    alive = [r for r in samples if (r.get("taskdock") or {}).get("count", 0) > 0]
    gone = len(samples) - len(alive)
    if alive:
        samples = alive
    xs = [r["elapsed_s"] for r in samples]
    priv = [r["taskdock"]["private_mb"] for r in samples]
    ws = [r["taskdock"]["ws_mb"] for r in samples]
    wv = [r.get("webview2_tree", {}).get("private_mb") for r in samples]
    wv = [v for v in wv if isinstance(v, (int, float))]

    stats_rows = [r["stats"] for r in samples if r.get("stats")]
    live, live_t = [], []
    for r in samples:
        st = r.get("stats")
        if not st:
            continue
        v = st.get("process", {}).get("live_bytes")
        if isinstance(v, (int, float)):
            live.append(v)
            live_t.append(r["elapsed_s"])

    out = {
        "file": path.name,
        "samples": len(samples),
        "samples_total": len(read_jsonl(path)),
        "process_gone_samples": gone,
        "process_exited_during_run": gone > 0,
        "elapsed_s": round(samples[-1]["elapsed_s"], 1),
        "private_mb": {"first": priv[0], "last": priv[-1], "delta": round(priv[-1] - priv[0], 2)},
        "ws_mb": {"first": ws[0], "last": ws[-1], "delta": round(ws[-1] - ws[0], 2)},
        "private_slope_mb_per_min": (
            round(slope(xs, priv) * 60, 3) if slope(xs, priv) is not None else None
        ),
        "webview2_private_mb": (
            {"first": wv[0], "last": wv[-1], "delta": round(wv[-1] - wv[0], 2)} if wv else None
        ),
    }
    if live:
        out["live_mb"] = {
            "first": mb(live[0]),
            "last": mb(live[-1]),
            "delta": mb(live[-1] - live[0]),
        }
        s = slope(live_t, live)
        out["live_slope_mb_per_min"] = round(s * 60 / 1048576, 4) if s is not None else None
        out["private_minus_live_mb"] = round(
            (priv[-1] - priv[0]) - (live[-1] - live[0]) / 1048576, 2
        )
    if stats_rows:
        out["stats_first"] = stats_rows[0]
        out["stats_last"] = stats_rows[-1]
    return out


def arm_key(path):
    """从文件名提取臂标识：DIAG-N1-xxx.jsonl → N1。"""
    stem = Path(path).stem
    parts = stem.split("-")
    for p in parts:
        if len(p) == 2 and p[0].upper() == "N" and p[1].isdigit():
            return p.upper()
    return stem


def attribution(results):
    """三臂差值归因：通知路径 / 接入路径 / 基线漂移。"""
    arms = {arm_key(r["file"]): r for r in results}
    if not {"N1", "N2", "N3"} <= set(arms):
        return None
    # 任一臂的进程中途退出 → 该臂的差值不可信，禁止直接输出归因结论
    exited = [k for k in ("N1", "N2", "N3") if arms[k].get("process_exited_during_run")]
    if exited:
        return {
            "error": "有臂的进程在采样期间退出，归因无效",
            "exited_arms": exited,
            "arms": {k: arms[k] for k in ("N1", "N2", "N3")},
        }

    def priv_delta(a):
        return a["private_mb"]["delta"]

    def slope(a):
        return a.get("private_slope_mb_per_min")

    def live_delta(a):
        return (a.get("live_mb") or {}).get("delta")

    def notifications(a):
        st = a.get("stats_last") or {}
        n = st.get("notifications") or {}
        return {
            "attempted": n.get("attempted"),
            "succeeded": n.get("succeeded"),
            "failed": n.get("failed"),
        }

    def events(a):
        st = a.get("stats_last") or {}
        return {
            "received": st.get("events_received"),
            "processed": st.get("events_processed"),
            "committed_failures": st.get("commit_failures"),
            "http_requests": st.get("http_requests"),
        }

    out = {
        "arms": {
            "N1_load_notify_on": {
                "private_delta_mb": priv_delta(arms["N1"]),
                "private_slope_mb_per_min": slope(arms["N1"]),
                "live_delta_mb": live_delta(arms["N1"]),
                "notifications": notifications(arms["N1"]),
                "events": events(arms["N1"]),
            },
            "N2_load_notify_off": {
                "private_delta_mb": priv_delta(arms["N2"]),
                "private_slope_mb_per_min": slope(arms["N2"]),
                "live_delta_mb": live_delta(arms["N2"]),
                "notifications": notifications(arms["N2"]),
                "events": events(arms["N2"]),
            },
            "N3_idle": {
                "private_delta_mb": priv_delta(arms["N3"]),
                "private_slope_mb_per_min": slope(arms["N3"]),
                "live_delta_mb": live_delta(arms["N3"]),
                "notifications": notifications(arms["N3"]),
                "events": events(arms["N3"]),
            },
        },
        "attribution_mb": {
            "notification_path_N1_minus_N2": round(
                priv_delta(arms["N1"]) - priv_delta(arms["N2"]), 2
            ),
            "ingest_path_N2_minus_N3": round(
                priv_delta(arms["N2"]) - priv_delta(arms["N3"]), 2
            ),
            "baseline_drift_N3": priv_delta(arms["N3"]),
        },
        "attribution_slope_mb_per_min": {
            "notification_path_N1_minus_N2": (
                round(slope(arms["N1"]) - slope(arms["N2"]), 3)
                if slope(arms["N1"]) is not None and slope(arms["N2"]) is not None
                else None
            ),
            "ingest_path_N2_minus_N3": (
                round(slope(arms["N2"]) - slope(arms["N3"]), 3)
                if slope(arms["N2"]) is not None and slope(arms["N3"]) is not None
                else None
            ),
            "baseline_drift_N3": slope(arms["N3"]),
        },
    }
    # 每条系统通知的平均驻留成本（仅在两侧弹窗数都拿到时计算）
    n1_notif = (notifications(arms["N1"]) or {}).get("attempted")
    n2_notif = (notifications(arms["N2"]) or {}).get("attempted")
    diff = out["attribution_mb"]["notification_path_N1_minus_N2"]
    if isinstance(n1_notif, int) and isinstance(n2_notif, int) and n1_notif > n2_notif:
        out["kb_per_notification"] = {
            "notifications_N1": n1_notif,
            "notifications_N2": n2_notif,
            "delta_notifications": n1_notif - n2_notif,
            "kb_per_notification": round(diff * 1024 / (n1_notif - n2_notif), 1),
        }
    return out


def main():
    paths = [Path(p) for p in sys.argv[1:]]
    if not paths:
        print("用法: memory-compare.py <DIAG-*.jsonl> [...]")
        return 1
    results = [analyze(p) for p in paths]
    for r in results:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    attr = attribution(results)
    if attr:
        print("")
        print("=== 三臂差值归因 ===")
        print(json.dumps(attr, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
