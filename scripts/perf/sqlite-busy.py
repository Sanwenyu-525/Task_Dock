#!/usr/bin/env python3
"""SQLite 写锁 + 队列过载故障注入（P1-05 E 组）。

在 Task Dock 运行时持有数据库写锁（BEGIN IMMEDIATE）一段时间，同时向其 HTTP
接入发送 running 与关键状态事件，观测：
- 写锁窗口内事件是否被受理、是否出现 429/503、是否产生提交失败；
- 锁释放后同一 event_id 重试是否最终落库（去重，不重复、不丢失）；
- 队列在高写入压力下是否保持有界。

所有数字来自本次真实 HTTP/SQLite 往返；结果 JSON 含待与数据库对账的 ID。

用法：
  python scripts/perf/sqlite-busy.py --db <app_data>/task-dock.db --token <tok> \
    --hold 12 --running 1200 --critical 24 --out docs/performance/results/E-sqlite-busy.json
"""

import argparse
import json
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

MAX_RETRIES = 30


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def post(base, token, payload, timeout=12.0):
    started = time.perf_counter()
    req = urllib.request.Request(
        base.rstrip("/") + "/api/v1/events",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return {"ok": True, "status": resp.status, "body": safe_json(body), "ms": (time.perf_counter() - started) * 1000}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return {"ok": False, "status": e.code, "body": safe_json(body), "ms": (time.perf_counter() - started) * 1000}
    except Exception as e:  # 网络/超时
        return {"ok": False, "error": str(e), "ms": (time.perf_counter() - started) * 1000}


def safe_json(text):
    try:
        return json.loads(text) if text else None
    except Exception:
        return {"raw": text[:300]}


def event(run_id, name, state):
    return {
        "schema_version": 1,
        "event_id": f"{run_id}-{name}",
        "source_id": "bridge",
        "instance_id": "sqlite-busy",
        "session_id": f"{run_id}-session-{name.split('-')[0]}",
        "run_id": f"{run_id}-run-{name.split('-')[0]}",
        "task_title": f"SQLite busy 注入 {run_id}",
        "state": state,
        "message": f"sqlite-busy {name}",
        "occurred_at": now_iso(),
        "evidence_type": "observed",
        "confidence": 1,
    }


def stats_endpoint(base, token):
    req = urllib.request.Request(
        base.rstrip("/") + "/api/v1/stats",
        headers={"authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:
        return {"error": str(e)}


def percentile(values, p):
    if not values:
        return 0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int((p / 100) * len(s) + 0.999999) - 1))
    return round(s[idx], 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--base", default="http://127.0.0.1:47821")
    ap.add_argument("--token", required=True)
    ap.add_argument("--hold", type=float, default=12.0)
    ap.add_argument("--running", type=int, default=1200)
    ap.add_argument("--critical", type=int, default=24)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--out", default="docs/performance/results/E-sqlite-busy.json")
    args = ap.parse_args()

    run_id = "sqlbusy-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    before = stats_endpoint(args.base, args.token)
    latencies = []
    statuses = {}
    retries = 0
    lock_state = {}

    events = []
    for i in range(args.running):
        events.append((event(run_id, f"run-{i:04d}", "running"), False))
    for i in range(args.critical):
        state = "completed" if i % 3 == 2 else "waiting"
        events.append((event(run_id, f"crit-{i:04d}", state), True))

    results_lock = threading.Lock()

    def send(ev, critical):
        nonlocal retries
        last = None
        for attempt in range(MAX_RETRIES):
            r = post(args.base, args.token, ev)
            with results_lock:
                latencies.append(r["ms"])
            last = r
            if r["ok"] and r.get("status") == 200:
                return {**r, "attempts": attempt + 1}
            if r.get("status") in (429, 503) or r.get("ok") is False:
                retry_after = 0.0
                body = r.get("body") or {}
                if isinstance(body, dict):
                    retry_after = float(body.get("retry_after_ms") or 0) / 1000.0
                with results_lock:
                    retries += 1
                time.sleep(min(2.0, max(0.1, retry_after or 0.1 * (2 ** min(attempt, 4)))))
                continue
            return {**r, "attempts": attempt + 1}  # 4xx 协议错误不重试
        return {**(last or {}), "attempts": MAX_RETRIES, "gave_up": True}

    outcomes = {}
    lock_ready = threading.Event()

    def lock_holder():
        conn = sqlite3.connect(args.db, timeout=10)
        conn.execute("PRAGMA busy_timeout=10000")
        t0 = time.perf_counter()
        conn.execute("BEGIN IMMEDIATE")
        lock_state["acquired_at"] = now_iso()
        lock_state["acquire_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        lock_ready.set()
        time.sleep(args.hold)
        conn.execute("ROLLBACK")
        conn.close()
        lock_state["released_at"] = now_iso()
        lock_state["released_monotonic"] = time.perf_counter()

    holder = threading.Thread(target=lock_holder, daemon=True)
    holder.start()
    lock_ready.wait(timeout=15)
    send_start = time.perf_counter()

    queue = list(events)
    queue_lock = threading.Lock()

    def worker():
        while True:
            with queue_lock:
                if not queue:
                    return
                ev, critical = queue.pop()
            out = send(ev, critical)
            key = ev["event_id"]
            with results_lock:
                outcomes[key] = {"state": ev["state"], "critical": critical, **out}
                st = out.get("status", "error")
                statuses[str(st)] = statuses.get(str(st), 0) + 1

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    send_elapsed = time.perf_counter() - send_start
    holder.join(timeout=max(0, args.hold + 10))

    # 恢复确认：锁释放后另发标记事件，证明写入通道恢复正常。
    time.sleep(1.0)
    markers = []
    for i in range(10):
        ev = event(run_id, f"marker-{i:02d}", "completed")
        r = send(ev, True)
        markers.append({"id": ev["event_id"], "status": r.get("status"), "ok": r["ok"], "attempts": r["attempts"]})
        time.sleep(0.05)
    time.sleep(5)

    after = stats_endpoint(args.base, args.token)
    critical_ids = [e["event_id"] for e, c in events if c]
    critical_final = {k: outcomes.get(k) for k in critical_ids}
    failed_critical = [k for k, v in critical_final.items() if not (v or {}).get("ok")]
    running_ids = [e["event_id"] for e, c in events if not c]

    report = {
        "scenario": "sqlite-busy+queue-overload",
        "started_at": now_iso(),
        "run_id": run_id,
        "config": {"hold_s": args.hold, "running": args.running, "critical": args.critical, "workers": args.workers},
        "lock": lock_state,
        "send_elapsed_s": round(send_elapsed, 2),
        "statuses": statuses,
        "retries": retries,
        "latency_all_ms": {
            "count": len(latencies),
            "p50": percentile(latencies, 50),
            "p95": percentile(latencies, 95),
            "p99": percentile(latencies, 99),
            "max": round(max(latencies), 2) if latencies else 0,
        },
        "critical_total": len(critical_ids),
        "critical_failed": failed_critical,
        "critical_status": {k: (v or {}).get("status") for k, v in critical_final.items()},
        "markers": markers,
        "markers_ok": sum(1 for m in markers if m["ok"]),
        "stats_before": before,
        "stats_after": after,
        # 供 db-audit --mode sqlite-busy 对账
        "critical_ids": critical_ids,
        "running_ids_sample": running_ids[:50],
        "running_total": len(running_ids),
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: report[k] for k in ("lock", "statuses", "retries", "latency_all_ms", "critical_total", "critical_failed", "markers_ok")}, ensure_ascii=False, indent=2))
    print(f"[结果] {args.out}")


if __name__ == "__main__":
    main()
