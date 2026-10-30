#!/usr/bin/env python3
"""Task Dock 真机验收数据库审计：计数、完整性、与压测/故障注入报告对账。

用法：
  python scripts/perf/db-audit.py --db <path> --out <json> [--report <report.json>]
                                  [--compare-db <restored.db>]
"""

import argparse
import json
import os
import sqlite3
import sys


def connect(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def table_counts(con):
    names = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {n: con.execute(f"SELECT COUNT(*) FROM {n}").fetchone()[0] for n in names}


def general(con, db_path):
    out = {
        "db_path": db_path,
        "db_bytes": os.path.getsize(db_path),
        "wal_bytes": os.path.getsize(db_path + "-wal") if os.path.exists(db_path + "-wal") else 0,
        "user_version": con.execute("PRAGMA user_version").fetchone()[0],
        "integrity_check": con.execute("PRAGMA integrity_check").fetchone()[0],
        "foreign_key_violations": len(con.execute("PRAGMA foreign_key_check").fetchall()),
        "tables": table_counts(con),
    }
    if out["tables"].get("agent_events", 0):
        out["events_by_source"] = dict(con.execute(
            "SELECT source_id, COUNT(*) FROM agent_events GROUP BY source_id"))
        out["events_by_state"] = dict(con.execute(
            "SELECT state, COUNT(*) FROM agent_events GROUP BY state"))
        out["event_seq"] = dict(zip(
            ["min", "max", "distinct"],
            con.execute("SELECT MIN(ingest_seq), MAX(ingest_seq), COUNT(DISTINCT ingest_seq) FROM agent_events").fetchone()))
        out["received_range"] = con.execute(
            "SELECT MIN(received_at), MAX(received_at) FROM agent_events").fetchone()
        out["dedupe_key_duplicates"] = con.execute(
            "SELECT COUNT(*) FROM (SELECT dedupe_key FROM agent_events GROUP BY dedupe_key HAVING COUNT(*) > 1)").fetchone()[0]
    if out["tables"].get("agent_runs", 0):
        out["runs_by_status"] = dict(con.execute(
            "SELECT status, COUNT(*) FROM agent_runs GROUP BY status"))
        out["runs_with_watermark"] = con.execute(
            "SELECT COUNT(*) FROM agent_runs WHERE last_ingest_seq > 0").fetchone()[0]
        out["runs_without_last_event_at"] = con.execute(
            "SELECT COUNT(*) FROM agent_runs WHERE last_event_at = ''").fetchone()[0]
    return out


def ids_with_prefix(con, prefix):
    return {r[0] for r in con.execute(
        "SELECT event_id FROM agent_events WHERE event_id LIKE ?", (prefix + "%",))}


def reconcile_http_load(con, report):
    cfg = report.get("config", {})
    rid = cfg.get("runId")
    agents = int(cfg.get("agents", 0))
    counts = report.get("counts", {})
    existing = ids_with_prefix(con, f"http-{rid}-a")
    # 客户端按序号顺序发送；压测在 stopAt 截止，尾部序号可能根本没发。
    # 以每个 Agent 实际落库的最大关键序号重建「已发送」集合，避免把未发送当丢失。
    import re
    per_agent_max = {}
    pattern = re.compile(rf"^http-{re.escape(str(rid))}-a(\d+)-e(\d+)$")
    for eid in existing:
        m = pattern.match(eid)
        if not m:
            continue
        agent, idx = int(m.group(1)), int(m.group(2))
        if idx % 20 in (10, 19):
            per_agent_max[agent] = max(per_agent_max.get(agent, -1), idx)
    expected = set()
    for a in range(agents):
        top = per_agent_max.get(a, -1)
        for i in range(0, top + 1):
            if i % 20 in (10, 19):
                expected.add(f"http-{rid}-a{a}-e{i}")
    return {
        "run_id": rid,
        "reconstructed_critical_ids": len(expected),
        "client_critical_sent": counts.get("critical_sent"),
        "client_critical_ok": counts.get("critical_ok"),
        "client_critical_failed": counts.get("critical_failed"),
        "db_critical_present": len(expected & existing),
        "db_critical_missing": len(expected - existing),
        "db_events_with_prefix": len(existing),
        "client_running_sent": counts.get("running_sent"),
        "client_ok": counts.get("ok"),
        "client_sampled": counts.get("sampled"),
        "client_validation_errors": counts.get("validation_errors"),
        "client_network_errors": counts.get("network_errors"),
        "client_rejected_429": counts.get("rejected_429"),
        "client_rejected_503": counts.get("rejected_503"),
        "ok": len(expected - existing) == 0
              and len(expected) == int(counts.get("critical_sent") or -1)
              and (counts.get("validation_errors") or 0) == 0,
    }


def reconcile_fault(con, report):
    result = report.get("result", {})
    mode = result.get("mode")
    out = {"mode": mode}
    if mode == "duplicate":
        ids = result.get("unique_event_ids", [])
        rows = {rid: n for rid, n in con.execute(
            "SELECT event_id, COUNT(*) FROM agent_events WHERE event_id IN (%s) GROUP BY event_id"
            % ",".join("?" * len(ids)), ids)} if ids else {}
        out.update({
            "unique_ids": len(ids),
            "present": len(rows),
            "duplicates_in_db": {k: v for k, v in rows.items() if v > 1},
            "missing": sorted(set(ids) - set(rows)),
            "ok": len(rows) == len(ids) and all(v == 1 for v in rows.values()),
        })
    elif mode == "timeout":
        marker_ids = result.get("marker_ids", [])
        aborted = [x["id"] for x in result.get("aborted_ids", [])]
        def present(ids):
            if not ids:
                return 0
            return con.execute(
                "SELECT COUNT(*) FROM agent_events WHERE event_id IN (%s)" % ",".join("?" * len(ids)),
                ids).fetchone()[0]
        out.update({
            "markers_total": len(marker_ids),
            "markers_present": present(marker_ids),
            "aborted_total": len(aborted),
            "aborted_present": present(aborted),
            "ok": present(marker_ids) == len(marker_ids),
            "note": "客户端中断后服务端可能已提交；只要求标记事件完整、无重复行",
        })
    elif mode == "burst":
        ok_ids = result.get("critical_ok_ids", [])
        failed = [x["id"] for x in result.get("critical_failed", [])]
        def count_in(ids):
            if not ids:
                return 0
            return con.execute(
                "SELECT COUNT(*) FROM agent_events WHERE event_id IN (%s)" % ",".join("?" * len(ids)),
                ids).fetchone()[0]
        ok_in = count_in(ok_ids)
        out.update({
            "critical_ok": len(ok_ids),
            "critical_ok_present": ok_in,
            "critical_failed": len(failed),
            "critical_failed_present": count_in(failed),
            "ok": ok_in == len(ok_ids) and len(failed) == 0,
        })
    elif mode == "interleave":
        session = result.get("session_id")
        run_ext = result.get("run_id_external")
        row = con.execute(
            "SELECT status, last_ingest_seq, last_event_at, updated_at FROM agent_runs WHERE external_run_id = ?",
            (run_ext,)).fetchone()
        ev = con.execute(
            "SELECT event_id, state, occurred_at FROM agent_events WHERE session_external_id = ? ORDER BY ingest_seq",
            (session,)).fetchall()
        final_events = [{"event_id": e[0], "state": e[1], "occurred_at": e[2]} for e in ev]
        out.update({
            "session_id": session,
            "external_run_id": run_ext,
            "run_row": None if row is None else {
                "status": row[0], "last_ingest_seq": row[1], "last_event_at": row[2], "updated_at": row[3]},
            "events": final_events,
            "expected_final_state": result.get("expect_final_state"),
            "ok": row is not None and row[0] == result.get("expect_final_state"),
        })
    return out


def reconcile_sqlite_busy(con, report):
    ids = report.get("critical_ids", [])
    markers = [m["id"] for m in report.get("markers", [])]
    def rows_for(ids):
        if not ids:
            return {}
        return {r[0]: r[1] for r in con.execute(
            "SELECT event_id, COUNT(*) FROM agent_events WHERE event_id IN (%s) GROUP BY event_id"
            % ",".join("?" * len(ids)), ids)}
    crit = rows_for(ids)
    mark = rows_for(markers)
    return {
        "critical_total": len(ids),
        "critical_present": len(crit),
        "critical_missing": sorted(set(ids) - set(crit)),
        "critical_duplicates": {k: v for k, v in crit.items() if v > 1},
        "markers_total": len(markers),
        "markers_present": len(mark),
        "markers_missing": sorted(set(markers) - set(mark)),
        "client_critical_failed": report.get("critical_failed", []),
        "ok": (not (set(ids) - set(crit))) and len(mark) == len(markers)
              and all(v == 1 for v in list(crit.values()) + list(mark.values())),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report")
    ap.add_argument("--compare-db")
    args = ap.parse_args()

    con = connect(args.db)
    report = {}
    report["scenario"] = "db-audit"
    report["general"] = general(con, args.db)
    if args.compare_db:
        other = connect(args.compare_db)
        report["compare"] = {
            "other_db": args.compare_db,
            "other": general(other, args.compare_db),
        }
        a = report["general"]["tables"]
        b = report["compare"]["other"]["tables"]
        diff = {k: [a.get(k), b.get(k)] for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)}
        report["compare"]["count_diff"] = diff

    src = None
    if args.report:
        with open(args.report, "r", encoding="utf-8") as f:
            src = json.load(f)
        scenario = src.get("scenario")
        if scenario == "http-load":
            report["reconcile"] = reconcile_http_load(con, src)
        elif scenario == "fault-inject":
            report["reconcile"] = reconcile_fault(con, src)
        elif scenario == "sqlite-busy+queue-overload":
            report["reconcile"] = reconcile_sqlite_busy(con, src)

    con.close()
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2)[:4000])


if __name__ == "__main__":
    sys.exit(main())
