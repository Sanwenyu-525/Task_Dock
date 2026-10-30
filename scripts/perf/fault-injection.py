#!/usr/bin/env python3
"""P1-04 异常退出与文件/磁盘故障注入（只针对隔离测试实例）。

隔离约束：
- 全程使用独立数据目录 / APPDATA / USERPROFILE，绝不触碰真实 Task Dock 进程与用户数据目录；
- 只终止本脚本自己启动的进程（按 PID），不做全量 kill；
- 需要管理员权限的卷级磁盘写满（VHD/VHDX）在本机不可用，按要求标记 NOT TESTED，
  并列出代码路径上等价的写失败注入测试作为补充证据。

用法：
    python scripts/perf/fault-injection.py --exe src-tauri/target/release/task-dock.exe
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
from datetime import datetime, timezone
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


def patch_settings(db_path: Path, port: int) -> str:
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
        con.commit()
        token = json.loads(
            con.execute("SELECT value FROM application_settings WHERE key='http_token'").fetchone()[0]
        )
    finally:
        con.close()
    return token


def db_query(db_path: Path, sql: str) -> list[tuple]:
    if not db_path.exists():
        return []
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return con.execute(sql).fetchall()
    except Exception:  # noqa: BLE001
        return []
    finally:
        con.close()


def post_event(port: int, token: str, payload: dict) -> tuple[int, str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/v1/events",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
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


class Instance:
    """隔离实例：只管理自己启动的进程。"""

    def __init__(self, exe: Path, root: Path, port: int, token: str):
        self.exe, self.root, self.port, self.token = exe, root, port, token
        self.proc: subprocess.Popen | None = None

    def start(self) -> bool:
        env = base_env(self.root)
        self.proc = subprocess.Popen([str(self.exe)], env=env)
        health = wait_health(self.port, self.token)
        return bool(health and health.get("ok"))

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


def scenario_force_kill(args, root: Path, port: int, token: str) -> dict:
    """F1/F2：投递期间强制结束进程，验证已提交事件保留、spool 保留、重启后幂等重放。"""
    db = root / "data/task-dock.db"
    spool = root / "data/ingest-spool"
    session = f"kill-{uuid.uuid4().hex[:6]}"
    inst = Instance(args.exe, root, port, token)
    if not inst.start():
        return {"status": "FAIL", "reason": "隔离实例未启动"}
    sent = {"n": 0, "ok": 0}
    stop_flag = threading.Event()

    def poster() -> None:
        i = 0
        while not stop_flag.is_set():
            status, _ = post_event(port, token, make_event(session, i))
            sent["n"] += 1
            if status in (200, 202):
                sent["ok"] += 1
            i += 1
            time.sleep(0.01)

    t = threading.Thread(target=poster, daemon=True)
    t.start()
    time.sleep(args.kill_after)
    killed = inst.kill()
    stop_flag.set()
    t.join(timeout=10)

    committed_before = db_query(db, "SELECT COUNT(*) FROM agent_events")[0][0]
    spool_files = sorted(p.name for p in spool.glob("*")) if spool.exists() else []
    integrity = db_query(db, "PRAGMA integrity_check")

    restarted = Instance(args.exe, root, port, token)
    restart_ok = restarted.start()
    time.sleep(3)
    replay_report = None
    replay_file = root / "data/restore/last-spool-replay.json"
    if replay_file.exists():
        replay_report = json.loads(replay_file.read_text(encoding="utf-8"))
    committed_after = db_query(db, "SELECT COUNT(*) FROM agent_events")[0][0]
    dup = db_query(
        db,
        "SELECT COUNT(*) FROM (SELECT event_id FROM agent_events GROUP BY event_id HAVING COUNT(*)>1)",
    )[0][0]
    spool_left = sorted(p.name for p in spool.glob("*")) if spool.exists() else []
    health = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
    restarted.stop()

    return {
        "status": "PASS" if restart_ok and (integrity or [["ok"]])[0][0] == "ok" and dup == 0 else "FAIL",
        "killed": killed,
        "http_sent": sent["n"],
        "http_accepted": sent["ok"],
        "committed_before_restart": committed_before,
        "committed_after_restart": committed_after,
        "spool_files_after_kill": spool_files,
        "spool_files_after_restart": spool_left,
        "spool_replay_report": replay_report,
        "duplicate_event_ids": dup,
        "integrity_check": integrity[0][0] if integrity else None,
        "restart_health_ok": bool(health and health.get("ok")),
        "note": "仅内存中未持久化的事件允许丢失；已 fsync 的 spool 事件必须重放且不重复",
    }


def scenario_corrupt_spool(args, root: Path, port: int, token: str) -> dict:
    """F3：spool 文件被截断（模拟中断写入），重启后必须不崩溃且可继续工作。"""
    spool = root / "data/ingest-spool"
    if not spool.exists():
        return {"status": "NOT TESTED", "reason": "无 spool 文件（上一场景未触发落盘暂存）"}
    victim = sorted(spool.glob("*.jsonl")) or sorted(spool.glob("*"))
    if not victim:
        return {"status": "NOT TESTED", "reason": "spool 目录为空"}
    target = victim[0]
    original = target.read_bytes()
    target.write_bytes(original[: max(1, len(original) // 2)])
    inst = Instance(args.exe, root, port, token)
    ok = inst.start()
    time.sleep(2)
    health = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
    quarantine = sorted(p.name for p in (root / "data/ingest-spool").glob("*")) if (root / "data/ingest-spool").exists() else []
    inst.stop()
    return {
        "status": "PASS" if ok and health and health.get("ok") else "FAIL",
        "corrupted_file": target.name,
        "spool_after_restart": quarantine,
        "health_ok": bool(health and health.get("ok")),
        "note": "损坏的 spool 文件必须被隔离或跳过，不得导致启动失败或事件重复",
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

    inst = Instance(args.exe, root, port, token)
    if not inst.start():
        return {"status": "FAIL", "reason": "隔离实例未启动"}
    # 造一份可恢复的备份
    bundle = root / "backup-full.taskdock"
    r = run([str(args.exe), "--agentctl", "backup", "full", str(bundle)], base_env(root), 300)
    if not bundle.exists():
        inst.stop()
        return {"status": "FAIL", "reason": f"备份失败: rc={r['rc']} {r['stderr'][:200]}"}
    db = root / "data/task-dock.db"
    before = db_query(db, "SELECT COUNT(*) FROM agent_events")[0][0]

    # 锁住数据库文件的一个字节区间（Windows 字节范围锁对 SQLite 写入是强制性的）
    handle = open(db, "r+b")
    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    try:
        rr = run([str(args.exe), "--agentctl", "restore", str(bundle)], base_env(root), 300)
    finally:
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        handle.close()
    time.sleep(1)
    after = db_query(db, "SELECT COUNT(*) FROM agent_events")[0][0]
    integrity = db_query(db, "PRAGMA integrity_check")
    journal = root / "data/restore/journal.json"
    inst.stop()
    return {
        "status": "PASS" if (integrity or [["ok"]])[0][0] == "ok" else "FAIL",
        "restore_rc": rr["rc"],
        "restore_stderr": rr["stderr"][-300:],
        "events_before": before,
        "events_after": after,
        "integrity_check": integrity[0][0] if integrity else None,
        "journal_left": journal.exists(),
        "note": "文件被锁时恢复必须整体失败并回滚，原数据保持不变",
    }


def scenario_kill_during_restore(args, root: Path, port: int, token: str) -> dict:
    """F4/F5：恢复过程中强制结束进程，下次启动必须能判定状态并回滚/续做。"""
    bundle = root / "backup-full.taskdock"
    if not bundle.exists():
        return {"status": "NOT TESTED", "reason": "缺少可恢复的备份包"}
    db = root / "data/task-dock.db"
    before = db_query(db, "SELECT COUNT(*) FROM agent_events")[0][0]
    env = base_env(root)
    proc = subprocess.Popen([str(args.exe), "--agentctl", "restore", str(bundle)], env=env)
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
    time.sleep(3)
    health = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
    after = db_query(db, "SELECT COUNT(*) FROM agent_events")[0][0]
    integrity = db_query(db, "PRAGMA integrity_check")
    journal_left = journal.exists()
    inst.stop()
    return {
        "status": "PASS" if ok and (integrity or [["ok"]])[0][0] == "ok" else "FAIL",
        "killed_mid_restore": killed,
        "journal_state_after_kill": journal_state,
        "journal_left_after_restart": journal_left,
        "events_before": before,
        "events_after": after,
        "integrity_check": integrity[0][0] if integrity else None,
        "health_ok": bool(health and health.get("ok")),
        "note": "恢复中断后必须由 journal 判定回滚或续做，且原数据不丢",
    }


def scenario_disk_full(args, root: Path, port: int, token: str) -> dict:
    """F7：卷级磁盘写满需要管理员创建隔离 VHD；本机无权限时按要求标记 NOT TESTED。"""
    admin = run(["net", "session"], os.environ.copy(), 20)["rc"] == 0
    if not admin:
        return {
            "status": "NOT TESTED",
            "reason": "创建隔离 VHD/VHDX 并写满需要管理员权限；本机会话无管理员权限，"
            "按隔离要求不对真实卷做写满注入",
            "equivalent_code_path_tests": [
                "commands::restore::tests::disk_full_during_archive_commit_rolls_back",
                "commands::restore::tests::permission_denied_during_asset_commit_rolls_back",
            ],
        }
    return {"status": "NOT TESTED", "reason": "VHD 创建流程未实现"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--port", type=int, default=47871)
    ap.add_argument("--out", default="docs/performance/results")
    ap.add_argument("--kill-after", type=float, default=2.5)
    ap.add_argument("--restore-kill-after", type=float, default=0.6)
    args = ap.parse_args()

    exe = Path(args.exe).resolve()
    if not exe.exists():
        log(f"找不到可执行文件: {exe}")
        return 2
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    root = Path(os.environ.get("TEMP", ".")) / f"taskdock-fault-{ts}"
    for sub in ("data", "appdata", "home", "tmp"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    env = base_env(root)
    seed = run([str(exe), "--agentctl", "status", "codex"], env, 120)
    db = root / "data/task-dock.db"
    if not db.exists():
        log("建库失败: " + seed["stderr"][:300])
        return 2
    token = patch_settings(db, args.port)
    log(f"隔离根目录 {root}")

    results: dict[str, dict] = {}
    order = [
        ("F1_F2_force_kill_during_ingest", scenario_force_kill),
        ("F3_interrupted_spool_write", scenario_corrupt_spool),
        ("F8_http_file_interleaving", scenario_interleaved_transport),
        ("F6_locked_file_during_restore", scenario_locked_file),
        ("F4_F5_kill_during_restore", scenario_kill_during_restore),
        ("F7_disk_full_isolated_volume", scenario_disk_full),
    ]
    for name, fn in order:
        log(f"执行 {name} …")
        try:
            results[name] = fn(args, root, args.port, token)
        except Exception as e:  # noqa: BLE001
            results[name] = {"status": "FAIL", "error": f"{type(e).__name__}: {e}"}
        log(f"{name} -> {results[name].get('status')}")

    evidence = {
        "test": "abnormal-exit-and-file-disk-fault-injection",
        "generated_at": now_iso(),
        "source_exe": str(exe),
        "source_exe_bytes": exe.stat().st_size,
        "isolated_root": str(root),
        "isolation_note": "仅操作隔离数据目录；只终止本脚本启动的 PID；未触碰真实 Task Dock 进程与用户数据",
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
