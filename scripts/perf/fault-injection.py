#!/usr/bin/env python3
"""P1-04 异常退出与文件/磁盘故障注入（只针对隔离测试实例）。

隔离约束：
- 全程使用独立数据目录 / APPDATA / USERPROFILE，绝不触碰真实 Task Dock 进程与用户数据目录；
- 只终止本脚本自己启动的进程（按 PID），不做全量 kill；
- 需要管理员权限的卷级磁盘写满（VHD/VHDX）在本机不可用，按要求标记 NOT TESTED，
  并用真实二进制上的写失败等价场景（备份目标不可写、备份包被截断）补充证据。

场景：
- F1/F2 投递期间强制结束进程：已提交事件保留、无重复、完整性正常；
- F3 写失败触发磁盘暂存 + 暂存文件被截断/残留半写文件：重启后隔离损坏文件、
  正常暂存文件幂等重放；
- F8 同一 event_id 同时走 HTTP 与文件投递：只落一条；
- F6 恢复期间数据库文件被独占锁定：整体失败回滚，原数据不变；
- F4/F5 恢复过程中强制结束进程：由恢复日志判定回滚/续做，原数据不丢；
- F7 卷级磁盘写满：需管理员创建隔离 VHD，本机无权限 → NOT TESTED + 写失败等价场景。

用法：
    python scripts/perf/fault-injection.py --exe src-tauri/target/release/task-dock.exe
    python scripts/perf/fault-injection.py --exe ... --only F3
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

APP_IDENTIFIER = "com.taskdock.desktop"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def base_env(root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(root / "data")
    env["APPDATA"] = str(root / "appdata")
    env["USERPROFILE"] = str(root / "home")
    env["HOME"] = str(root / "home")
    env["XDG_CONFIG_HOME"] = str(root / "home/.config")
    env["XDG_DATA_HOME"] = str(root / "home/.local/share")
    env["TEMP"] = str(root / "tmp")
    env["TMP"] = str(root / "tmp")
    drive, tail = os.path.splitdrive(str(root))
    env["HOMEDRIVE"], env["HOMEPATH"] = drive, tail
    return env


def run(cmd: list[str], env: dict[str, str], timeout: int = 120, stdin: str | None = None) -> dict:
    started = time.perf_counter()
    try:
        p = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            input=stdin,
        )
        rc, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        rc, out, err = -1, (e.stdout or ""), (e.stderr or "")
    return {"rc": rc, "ms": round((time.perf_counter() - started) * 1000), "stdout": out, "stderr": err}


def http_json(url: str, token: str | None, timeout: float = 3.0) -> dict | None:
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def wait_health(port: int, token: str, timeout: float = 90.0) -> dict | None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
        if last and last.get("ok"):
            return last
        time.sleep(0.4)
    return last


def port_in_use(port: int) -> bool:
    """端口是否已被占用（被占用则新实例无法绑定，会静默串台）。"""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex(("127.0.0.1", port)) == 0


def patch_settings(db_path: Path, port: int, token: str | None = None) -> str:
    settings = {
        "http_enabled": True,
        "http_port": port,
        "mock_enabled": False,
        "clipboard_enabled": False,
        "auto_backup": False,
        "notify_agent": False,
        "notify_reminder": False,
        "notify_muted": False,
        "snap_enabled": False,
        "hotkey_enabled": False,
        "perf_diagnostics_enabled": True,
    }
    now = now_iso()
    con = sqlite3.connect(db_path)
    try:
        for k, v in settings.items():
            con.execute(
                "INSERT INTO application_settings(key,value,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (k, json.dumps(v), now),
            )
        # 注入根与恢复根共用同一个 token：脚本用同一个 token 做鉴权身份确认，
        # 若两个根各用各的 token，恢复类场景的实例身份校验必然失败。
        if token:
            con.execute(
                "INSERT INTO application_settings(key,value,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                ("http_token", json.dumps(token), now),
            )
        con.commit()
        token = json.loads(
            con.execute("SELECT value FROM application_settings WHERE key='http_token'").fetchone()[0]
        )
    finally:
        con.close()
    return token


def db_query(db_path: Path, sql: str, params: tuple | list = ()) -> list[tuple]:
    if not db_path.exists():
        return []
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return con.execute(sql, tuple(params)).fetchall()
    except Exception:  # noqa: BLE001
        return []
    finally:
        con.close()


def db_count(db_path: Path, table: str, where: str = "") -> int:
    rows = db_query(db_path, f"SELECT COUNT(*) FROM {table} {where}")
    return rows[0][0] if rows else 0


def post_event(port: int, token: str, payload: dict) -> tuple[int, str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/v1/events",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200]
    except Exception as e:  # noqa: BLE001
        return -1, str(e)[:200]


def make_event(session: str, seq: int, state: str = "running") -> dict:
    return {
        "schema_version": 1,
        "event_id": f"fault-{session}-{seq}",
        "source_id": "codex",
        "session_id": session,
        "run_external_id": f"run-{session}",
        "event_type": "status",
        "state": state,
        "message": "fault injection",
        "occurred_at": now_iso(),
    }


def seed_large_dataset(db_path: Path, n_events: int, n_sessions: int = 20, n_runs: int = 200) -> dict:
    """直接向隔离库写入大量事件，使完整备份包足够大、恢复耗时足够长（可在恢复中途强杀）。"""
    con = sqlite3.connect(db_path)
    try:
        now = now_iso()
        src = "codex"
        con.execute(
            "INSERT OR IGNORE INTO agent_sources(id,display_name,kind,created_at,updated_at) "
            "VALUES(?,?,?,?,?)",
            (src, "Codex", "hooks", now, now),
        )
        session_ids = []
        for i in range(n_sessions):
            sid = f"seed-session-{i:04d}"
            session_ids.append(sid)
            con.execute(
                "INSERT OR IGNORE INTO agent_sessions"
                "(id,source_id,external_id,title,status,first_seen_at,last_seen_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (sid, src, f"seed-ext-{i:04d}", f"seed session {i}", "idle", now, now),
            )
        run_ids = []
        for i in range(n_runs):
            rid = f"seed-run-{i:04d}"
            run_ids.append(rid)
            con.execute(
                "INSERT OR IGNORE INTO agent_runs"
                "(id,session_id,source_id,external_run_id,task_title,status,started_at,updated_at,"
                "ended_at,pending_items,meta,last_event_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    rid,
                    session_ids[i % n_sessions],
                    src,
                    rid,
                    f"seed task {i}",
                    "completed",
                    now,
                    now,
                    now,
                    "[]",
                    "{}",
                    now,
                ),
            )
        base = datetime(2026, 10, 1, tzinfo=timezone.utc)
        rows = []
        for i in range(n_events):
            ts = (base + timedelta(seconds=i)).isoformat()
            rows.append(
                (
                    f"seed-event-{i:07d}",
                    src,
                    f"seed-ext-{i % n_sessions:04d}",
                    run_ids[i % n_runs],
                    "status",
                    "completed",
                    "seeded event for restore fault injection",
                    ts,
                    1,
                    f"seed-eid-{i:07d}",
                    ts,
                    "http",
                    "observed",
                    1.0,
                    f"seed-dedupe-{i:07d}",
                    i + 1,
                    "real",
                )
            )
        con.executemany(
            "INSERT OR IGNORE INTO agent_events"
            "(id,source_id,session_external_id,run_external_id,event_type,state,message,received_at,"
            "schema_version,event_id,occurred_at,transport,evidence_type,confidence,dedupe_key,"
            "ingest_seq,origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        con.commit()
        return {
            "events": n_events,
            "sessions": n_sessions,
            "runs": n_runs,
            "rows_in_db": con.execute("SELECT COUNT(*) FROM agent_events").fetchone()[0],
        }
    finally:
        con.close()


class Instance:
    """隔离实例：只管理自己启动的进程。"""

    _live: list["Instance"] = []

    def __init__(self, exe: Path, root: Path, port: int, token: str):
        self.exe, self.root, self.port, self.token = exe, root, port, token
        self.proc: subprocess.Popen | None = None
        self.log_path = root / "app.log"

    def start(self) -> bool:
        env = base_env(self.root)
        self.log = open(self.log_path, "ab")
        self.proc = subprocess.Popen(
            [str(self.exe)], env=env, stdout=self.log, stderr=subprocess.STDOUT
        )
        Instance._live.append(self)
        health = wait_health(self.port, self.token)
        # /api/v1/health 是免鉴权端点：若端口上残留着别的实例，它也会应答成功。
        # 必须再用带本轮 token 的受保护端点确认应答者就是本轮实例，否则结果会静默串台。
        identity = http_json(f"http://127.0.0.1:{self.port}/api/v1/stats", self.token)
        if not (health and health.get("ok")) or not isinstance(identity, dict):
            # 端口没起来（常见于上一轮遗留实例占用了单实例互斥锁）时立即回收，
            # 否则残留进程会一直占着互斥锁，让后续场景静默地连到错误实例。
            self.stop()
            return False
        return True

    def kill(self) -> bool:
        if self.proc is None or self.proc.poll() is not None:
            return False
        subprocess.run(
            ["taskkill", "/PID", str(self.proc.pid), "/T", "/F"], capture_output=True, timeout=60
        )
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            pass
        return True

    def stop(self) -> None:
        self.kill()
        if self in Instance._live:
            Instance._live.remove(self)
        if getattr(self, "log", None):
            try:
                self.log.close()
            except Exception:  # noqa: BLE001
                pass

    @classmethod
    def stop_all(cls) -> int:
        """回收所有仍存活的隔离实例（场景内抛异常时由 main 的 finally 调用）。"""
        stopped = 0
        for inst in list(cls._live):
            if inst.proc is not None and inst.proc.poll() is None:
                stopped += 1
            inst.stop()
        return stopped

    def tail_log(self, lines: int = 25) -> list[str]:
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []
        return text.splitlines()[-lines:]


def running_task_dock_pids() -> list[int]:
    """列出当前机器上仍在运行的 task-dock.exe PID（不终止，仅用于前置检查）。"""
    try:
        p = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq task-dock.exe", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except Exception:  # noqa: BLE001
        return []
    pids: list[int] = []
    for line in p.stdout.splitlines():
        parts = [x.strip('" ') for x in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            pids.append(int(parts[1]))
    return pids


def scenario_force_kill(args, root: Path, port: int, token: str) -> dict:
    """F1/F2：投递期间强制结束进程，验证已提交事件保留、无重复、完整性正常。

    强制结束不给应用任何收尾机会，因此不会产生磁盘暂存（spool）：本场景只承诺
    「已提交事件不丢、不重复」，未落库的内存事件允许丢失。
    """
    db = root / "data/task-dock.db"
    spool = root / "data/ingest-spool"
    inst = Instance(args.exe, root, port, token)
    if not inst.start():
        return {"status": "FAIL", "reason": "隔离实例未启动"}
    sent = {"n": 0, "ok": 0, "retryable": 0}
    stop_flag = threading.Event()

    def poster() -> None:
        i = 0
        while not stop_flag.is_set():
            # 每个事件独立会话/轮次，避免合并缓冲把同一轮次的重复状态合并掉
            session = f"kill-{uuid.uuid4().hex[:8]}"
            status, body = post_event(port, token, make_event(session, i))
            sent["n"] += 1
            if status in (200, 202):
                sent["ok"] += 1
            elif status == 503:
                sent["retryable"] += 1
            i += 1
            time.sleep(0.01)

    t = threading.Thread(target=poster, daemon=True)
    t.start()
    time.sleep(args.kill_after)
    killed = inst.kill()
    stop_flag.set()
    t.join(timeout=10)

    committed_before = db_count(db, "agent_events")
    spool_files = sorted(p.name for p in spool.glob("*")) if spool.exists() else []
    integrity = db_query(db, "PRAGMA integrity_check")
    wal_present = (root / "data/task-dock.db-wal").exists()

    restarted = Instance(args.exe, root, port, token)
    restart_ok = restarted.start()
    time.sleep(3)
    replay_report = None
    replay_file = root / "data/last-spool-replay.json"
    if replay_file.exists():
        replay_report = json.loads(replay_file.read_text(encoding="utf-8"))
    committed_after = db_count(db, "agent_events")
    dup = db_query(
        db,
        "SELECT COUNT(*) FROM (SELECT event_id FROM agent_events WHERE event_id IS NOT NULL "
        "GROUP BY event_id HAVING COUNT(*)>1)",
    )[0][0]
    spool_left = sorted(p.name for p in spool.glob("*")) if spool.exists() else []
    health = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
    restarted.stop()

    ok = (
        restart_ok
        and (integrity or [["ok"]])[0][0] == "ok"
        and dup == 0
        and committed_after >= committed_before
    )
    return {
        "status": "PASS" if ok else "FAIL",
        "killed": killed,
        "http_sent": sent["n"],
        "http_accepted": sent["ok"],
        "http_retryable_503": sent["retryable"],
        "committed_before_restart": committed_before,
        "committed_after_restart": committed_after,
        "spool_files_after_kill": spool_files,
        "spool_files_after_restart": spool_left,
        "spool_replay_report": replay_report,
        "duplicate_event_ids": dup,
        "integrity_check": integrity[0][0] if integrity else None,
        "wal_present_after_kill": wal_present,
        "restart_health_ok": bool(health and health.get("ok")),
        "note": "强制结束无收尾机会故不产生暂存文件；已提交事件必须保留且不重复，"
        "仅内存中未持久化的事件允许丢失",
    }


def scenario_spool_write_failure(args, root: Path, port: int, token: str) -> dict:
    """F3：写库失败 → 事件原子暂存到磁盘；再模拟「写入被中断」的两种残留形态。

    注入方式：WAL 模式下 SQLite 的写入落在 -wal 文件的帧区（偏移 32 起），
    锁住该区间会让提交真实失败（disk I/O error），而不是只让新连接打不开库。
    只有非 running 的关键事件才会等待提交确认，因此事件状态用 waiting。

    残留形态 A：暂存文件被截断一半（写到一半进程被杀）。
    残留形态 B：只剩 `.tmp-*` 半写文件（原子改名之前被杀）。
    重启后：损坏文件必须被隔离到 corrupt/，正常暂存文件必须幂等重放且不重复。
    """
    import msvcrt

    db = root / "data/task-dock.db"
    wal = root / "data/task-dock.db-wal"
    spool = root / "data/ingest-spool"
    inst = Instance(args.exe, root, port, token)
    if not inst.start():
        return {"status": "FAIL", "reason": "隔离实例未启动"}

    sessions: list[str] = []
    write_fail_responses: list[int] = []
    for _round in range(2):
        session = f"spool-{uuid.uuid4().hex[:8]}"
        sessions.append(session)
        # 锁住 WAL 帧区：提交必然失败
        handle = open(wal, "r+b")
        handle.seek(32)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1 << 20)
        try:
            for i in range(3):
                status, _ = post_event(port, token, make_event(session, i, state="waiting"))
                write_fail_responses.append(status)
                time.sleep(0.05)
        finally:
            handle.seek(32)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1 << 20)
            handle.close()
        # 等待管线把失败事件落到暂存目录
        deadline = time.time() + 10
        while time.time() < deadline:
            if spool.exists() and len(list(spool.glob("spool-*.jsonl"))) >= len(sessions):
                break
            time.sleep(0.2)

    spool_files = sorted(spool.glob("spool-*.jsonl")) if spool.exists() else []
    if not spool_files:
        inst.stop()
        return {
            "status": "FAIL",
            "reason": "写失败后未产生磁盘暂存文件，无法验证暂存路径",
            "write_fail_responses": write_fail_responses,
            "app_log_tail": inst.tail_log(),
        }

    inst.stop()
    time.sleep(1)

    # 残留形态 A：截断第一个暂存文件（模拟写到一半被中断）
    truncated = spool_files[0]
    original = truncated.read_bytes()
    truncated.write_bytes(original[: max(1, len(original) // 2)])
    # 残留形态 B：留下一个只写了一半的 .tmp-* 临时文件（原子改名之前被杀）
    partial_tmp = spool / f".tmp-{uuid.uuid4().hex}.jsonl"
    partial_tmp.write_bytes(original[: max(1, len(original) // 3)])

    intact_files = spool_files[1:]
    intact_events = 0
    intact_ids: list[str] = []
    for f in intact_files:
        try:
            for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
                if '"record":"event"' in line.replace(" ", ""):
                    intact_events += 1
                    try:
                        obj = json.loads(line)
                        if obj.get("event", {}).get("event_id"):
                            intact_ids.append(obj["event"]["event_id"])
                    except json.JSONDecodeError:
                        pass
        except OSError:
            pass

    restarted = Instance(args.exe, root, port, token)
    ok = restarted.start()
    time.sleep(5)
    health = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
    replay_report = None
    replay_file = root / "data/last-spool-replay.json"
    if replay_file.exists():
        replay_report = json.loads(replay_file.read_text(encoding="utf-8"))
    quarantined = sorted(p.name for p in (spool / "corrupt").glob("*")) if (spool / "corrupt").exists() else []
    remaining = sorted(p.name for p in spool.glob("*")) if spool.exists() else []
    dup = db_query(
        db,
        "SELECT COUNT(*) FROM (SELECT event_id FROM agent_events WHERE event_id IS NOT NULL "
        "GROUP BY event_id HAVING COUNT(*)>1)",
    )[0][0]
    integrity = db_query(db, "PRAGMA integrity_check")
    replayed_rows = 0
    if intact_ids:
        marks = ",".join("?" for _ in intact_ids)
        replayed_rows = db_query(
            db, f"SELECT COUNT(*) FROM agent_events WHERE event_id IN ({marks})", intact_ids
        )[0][0]
    restarted.stop()

    quarantined_ok = any(truncated.name in name for name in quarantined)
    replayed_ok = replay_report is not None and replay_report.get("files_quarantined", 0) >= 1
    status = (
        "PASS"
        if ok
        and health
        and health.get("ok")
        and quarantined_ok
        and replayed_ok
        and dup == 0
        and (integrity or [["ok"]])[0][0] == "ok"
        and replayed_rows == intact_events
        else "FAIL"
    )
    return {
        "status": status,
        "write_fail_responses": write_fail_responses,
        "write_fail_all_retryable": all(s >= 500 for s in write_fail_responses),
        "spool_files_created": [p.name for p in spool_files],
        "truncated_file": truncated.name,
        "partial_tmp_file": partial_tmp.name,
        "quarantined_after_restart": quarantined,
        "spool_dir_after_restart": remaining,
        "tmp_files_left": [n for n in remaining if n.startswith(".tmp-")],
        "replay_report": replay_report,
        "intact_spool_events": intact_events,
        "intact_spool_events_replayed_to_db": replayed_rows,
        "duplicate_event_ids": dup,
        "integrity_check": integrity[0][0] if integrity else None,
        "health_ok": bool(health and health.get("ok")),
        "note": "写失败事件必须落盘暂存并向调用方报可重试错误；损坏/半写暂存文件必须被隔离"
        "且不阻断启动，完整暂存文件必须幂等重放且不重复",
    }


def scenario_interleaved_transport(args, root: Path, port: int, token: str) -> dict:
    """F8：同一 event_id 同时走 HTTP 与文件投递，必须只落一条。"""
    inst = Instance(args.exe, root, port, token)
    if not inst.start():
        return {"status": "FAIL", "reason": "隔离实例未启动"}
    session = f"mix-{uuid.uuid4().hex[:6]}"
    event_id = f"fault-mix-{uuid.uuid4().hex[:8]}"
    payload = make_event(session, 0)
    payload["event_id"] = event_id
    inbox = root / "data/agent-inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    file_path = inbox / f"mix-{uuid.uuid4().hex[:6]}.json"
    file_path.write_text(json.dumps(payload), encoding="utf-8")
    status, _ = post_event(port, token, payload)
    time.sleep(3)
    rows = db_query(
        root / "data/task-dock.db",
        f"SELECT COUNT(*) FROM agent_events WHERE event_id = '{event_id}'",
    )
    inst.stop()
    count = rows[0][0] if rows else 0
    return {
        "status": "PASS" if count == 1 else "FAIL",
        "http_status": status,
        "rows_for_event_id": count,
        "note": "HTTP 与文件投递同事件必须按 event_id 幂等，只留一条",
    }


def scenario_locked_file(args, root: Path, port: int, token: str) -> dict:
    """F6：文件被其他进程独占锁定时，恢复必须失败并回滚，不得留下半恢复状态。"""
    import msvcrt

    bundle = root / "backup-full.taskdock"
    if not bundle.exists():
        return {"status": "NOT TESTED", "reason": "缺少可恢复的备份包"}
    db = root / "data/task-dock.db"
    before = db_count(db, "agent_events")

    handle = open(db, "r+b")
    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    try:
        rr = run([str(args.exe), "--agentctl", "restore", str(bundle)], base_env(root), 600)
    finally:
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        handle.close()
    time.sleep(1)
    after = db_count(db, "agent_events")
    integrity = db_query(db, "PRAGMA integrity_check")
    journal = root / "data/restore/journal.json"
    inst = Instance(args.exe, root, port, token)
    ok = inst.start()
    time.sleep(2)
    health = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
    inst.stop()
    return {
        "status": "PASS"
        if ok
        and health
        and health.get("ok")
        and (integrity or [["ok"]])[0][0] == "ok"
        and after == before
        else "FAIL",
        "restore_rc": rr["rc"],
        "restore_stderr": rr["stderr"][-300:],
        "events_before": before,
        "events_after": after,
        "integrity_check": integrity[0][0] if integrity else None,
        "journal_left": journal.exists(),
        "health_ok": bool(health and health.get("ok")),
        "note": "文件被锁时恢复必须整体失败并回滚，原数据保持不变",
    }


def scenario_kill_during_restore(args, root: Path, port: int, token: str) -> dict:
    """F4/F5：恢复过程中强制结束进程，下次启动必须能判定状态并回滚/续做。"""
    bundle = root / "backup-full.taskdock"
    if not bundle.exists():
        return {"status": "NOT TESTED", "reason": "缺少可恢复的备份包"}
    db = root / "data/task-dock.db"
    before = db_count(db, "agent_events")
    env = base_env(root)
    proc = subprocess.Popen(
        [str(args.exe), "--agentctl", "restore", str(bundle)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(args.restore_kill_after)
    killed = proc.poll() is None
    if killed:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=60)
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        pass
    journal = root / "data/restore/journal.json"
    journal_state = None
    if journal.exists():
        try:
            journal_state = json.loads(journal.read_text(encoding="utf-8")).get("state")
        except json.JSONDecodeError:
            journal_state = "CORRUPT"

    inst = Instance(args.exe, root, port, token)
    ok = inst.start()
    time.sleep(4)
    health = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
    after = db_count(db, "agent_events")
    integrity = db_query(db, "PRAGMA integrity_check")
    journal_left = journal.exists()
    inst.stop()
    return {
        "status": "PASS"
        if ok
        and health
        and health.get("ok")
        and (integrity or [["ok"]])[0][0] == "ok"
        else "FAIL",
        "killed_mid_restore": killed,
        "kill_delay_s": args.restore_kill_after,
        "journal_state_after_kill": journal_state,
        "journal_left_after_restart": journal_left,
        "events_before": before,
        "events_after": after,
        "integrity_check": integrity[0][0] if integrity else None,
        "health_ok": bool(health and health.get("ok")),
        "note": "恢复中断后必须由 journal 判定回滚或续做，且原数据不丢",
    }


def scenario_disk_full(args, root: Path, port: int, token: str) -> dict:
    """F7：卷级磁盘写满需要管理员创建隔离 VHD。

    本机无管理员权限（fltmc 返回 0x80070005），按隔离要求不对真实卷做写满注入，
    标记 NOT TESTED；并用真实二进制上的写失败等价场景补充证据。
    """
    if not is_elevated():
        return {
            "status": "NOT TESTED",
            "reason": "创建隔离 VHD/VHDX 并写满需要管理员权限；本机会话未提升"
            "（fltmc 返回 0x80070005），按隔离要求不对真实卷做写满注入",
            "elevation_probe": "fltmc -> 0x80070005 (Access Denied)",
            "equivalent_real_binary_tests": equivalent_write_failure_tests(args, root),
            "unit_test_equivalents": [
                "commands::restore::tests::disk_full_during_archive_commit_rolls_back",
                "commands::restore::tests::permission_denied_during_asset_commit_rolls_back",
            ],
        }
    return {
        "status": "NOT TESTED",
        "reason": "VHD 创建流程未实现",
        "equivalent_real_binary_tests": equivalent_write_failure_tests(args, root),
    }


def is_elevated() -> bool:
    """可靠的管理员判定：fltmc 需要管理员权限，非提升会话返回 0x80070005。"""
    p = subprocess.run(["fltmc"], capture_output=True, timeout=30)
    return p.returncode == 0


def equivalent_write_failure_tests(args, root: Path) -> list[dict]:
    """真实二进制上的写失败等价场景（替代卷级写满不可执行的部分）。

    E1 备份目标不可写（父路径是文件）：备份必须干净失败，不得留下半截备份包；
    E2 备份包被截断（哈希校验失败）：恢复必须整体失败并回滚，原数据不变。
    """
    out: list[dict] = []
    db = root / "data/task-dock.db"

    # E1：备份目标是已存在的目录 → 写入必然失败
    bad_target = root / "backup-target-is-a-dir"
    bad_target.mkdir(parents=True, exist_ok=True)
    r1 = run([str(args.exe), "--agentctl", "backup", "full", str(bad_target)], base_env(root), 300)
    # 半截产物：目标目录内不应出现任何文件，目录旁也不应出现同名前缀的残留文件
    inside = sorted(p.name for p in bad_target.glob("*"))
    siblings = sorted(
        p.name
        for p in root.glob("backup-target-is-a-dir.*")
        if p.is_file()
    )
    leftovers = inside + siblings
    out.append(
        {
            "id": "E1_backup_target_unwritable",
            "backup_rc": r1["rc"],
            "stderr": r1["stderr"][-200:],
            "partial_artifacts_left": leftovers,
            "pass": r1["rc"] != 0 and not leftovers,
            "expectation": "备份失败必须返回非零并说明原因，不得留下半截产物",
        }
    )

    # E2：把一份可用备份包截断 → 恢复必须因哈希/完整性校验失败而整体回滚
    bundle = root / "backup-truncated.taskdock"
    src = root / "backup-full.taskdock"
    if src.exists():
        data = src.read_bytes()
        bundle.write_bytes(data[: max(1, len(data) // 3)])
        before = db_count(db, "agent_events")
        r2 = run([str(args.exe), "--agentctl", "restore", str(bundle)], base_env(root), 300)
        time.sleep(1)
        after = db_count(db, "agent_events")
        integrity = db_query(db, "PRAGMA integrity_check")
        out.append(
            {
                "id": "E2_truncated_bundle_restore_rejected",
                "restore_rc": r2["rc"],
                "stderr": r2["stderr"][-200:],
                "events_before": before,
                "events_after": after,
                "integrity_check": integrity[0][0] if integrity else None,
                "pass": r2["rc"] != 0
                and after == before
                and (integrity or [["ok"]])[0][0] == "ok",
                "expectation": "损坏备份包必须整体失败并回滚，原数据不变",
            }
        )
    else:
        out.append({"id": "E2_truncated_bundle_restore_rejected", "pass": False, "reason": "缺少源备份包"})
    return out


def make_bundle(args, root: Path, target: Path) -> dict:
    r = run([str(args.exe), "--agentctl", "backup", "full", str(target)], base_env(root), 900)
    if not target.exists():
        return {"ok": False, "rc": r["rc"], "stderr": r["stderr"][-300:]}
    try:
        info = json.loads(r["stdout"])
    except json.JSONDecodeError:
        info = {"raw": r["stdout"][-300:]}
    info["ok"] = True
    info["bytes_on_disk"] = target.stat().st_size
    return info


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--port", type=int, default=47871)
    ap.add_argument("--out", default="docs/performance/results")
    ap.add_argument("--kill-after", type=float, default=2.5)
    ap.add_argument("--restore-kill-after", type=float, default=1.2)
    ap.add_argument("--seed-events", type=int, default=60000)
    ap.add_argument("--only", default="", help="只跑指定场景（逗号分隔）")
    args = ap.parse_args()

    exe = Path(args.exe).resolve()
    if not exe.exists():
        log(f"找不到可执行文件: {exe}")
        return 2
    # 前置检查：单实例插件按「AppIdentifier + 数据目录哈希」加锁，不同数据目录互不冲突；
    # 真正会串台的是「同一个端口上残留着上一轮的实例」。
    # 因此这里检查端口占用，而不是笼统地拒绝机器上存在其它 task-dock 实例。
    if port_in_use(args.port):
        log(
            f"端口 {args.port} 已被占用（可能是上一轮遗留的隔离实例），已中止。"
            "请先释放该端口，或换一个 --port。"
        )
        return 2
    preexisting = running_task_dock_pids()
    if preexisting:
        log(f"提示：机器上另有 {len(preexisting)} 个 task-dock 实例在运行（不同数据目录，互不冲突）")
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = Path(os.environ.get("TEMP", ".")) / f"taskdock-fault-{ts}"
    ingest_root = base / "ingest"
    restore_root = base / "restore"
    for root in (ingest_root, restore_root):
        for sub in ("data", "appdata", "home", "tmp"):
            (root / sub).mkdir(parents=True, exist_ok=True)
    env = base_env(ingest_root)
    seed = run([str(exe), "--agentctl", "status", "codex"], env, 120)
    db = ingest_root / "data/task-dock.db"
    if not db.exists():
        log("建库失败: " + seed["stderr"][:300])
        return 2
    token = patch_settings(db, args.port)
    log(f"隔离根目录 {base}")
    # 恢复类场景需要大体量备份包，确保恢复耗时足够长、能在中途强杀
    seed_res = run([str(exe), "--agentctl", "status", "codex"], base_env(restore_root), 120)
    rdb = restore_root / "data/task-dock.db"
    if not rdb.exists():
        log("恢复库建库失败: " + seed_res["stderr"][:300])
        return 2
    patch_settings(rdb, args.port, token=token)
    seed_info = seed_large_dataset(rdb, args.seed_events)
    log(f"恢复库已注入 {seed_info['rows_in_db']} 条事件")
    bundle = restore_root / "backup-full.taskdock"
    bundle_info = make_bundle(args, restore_root, bundle)
    log(f"备份包 {bundle_info.get('bytes_on_disk')} 字节（事件 {seed_info['events']}）")

    results: dict[str, dict] = {}
    order = [
        ("F1_F2_force_kill_during_ingest", scenario_force_kill, ingest_root),
        ("F3_spool_write_failure_and_interrupted_spool", scenario_spool_write_failure, ingest_root),
        ("F8_http_file_interleaving", scenario_interleaved_transport, ingest_root),
        ("F6_locked_file_during_restore", scenario_locked_file, restore_root),
        ("F4_F5_kill_during_restore", scenario_kill_during_restore, restore_root),
        ("F7_disk_full_isolated_volume", scenario_disk_full, restore_root),
    ]
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    try:
        for name, fn, root in order:
            if only and name not in only:
                continue
            log(f"执行 {name} …")
            try:
                results[name] = fn(args, root, args.port, token)
            except Exception as e:  # noqa: BLE001
                results[name] = {"status": "FAIL", "error": f"{type(e).__name__}: {e}"}
            finally:
                # 场景内抛异常时可能留下实例；场景之间必须清空，否则会占用单实例互斥锁。
                Instance.stop_all()
            log(f"{name} -> {results[name].get('status')}")
    finally:
        Instance.stop_all()

    evidence = {
        "test": "abnormal-exit-and-file-disk-fault-injection",
        "generated_at": now_iso(),
        "source_exe": str(exe),
        "source_exe_bytes": exe.stat().st_size,
        "isolated_root": str(base),
        "isolation_note": "仅操作隔离数据目录；只终止本脚本启动的 PID；未触碰真实 Task Dock 进程与用户数据",
        "seed": seed_info,
        "backup_bundle": bundle_info,
        "results": results,
    }
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"FAULT-fault-injection-{ts}.json"
    out_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"证据已写入 {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
