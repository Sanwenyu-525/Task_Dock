#!/usr/bin/env python3
"""隔离实例启动后的模块/内存指纹采样。

用途：解释同一次测量里主进程 Private Bytes 出现两个稳定簇（~9 MB / ~41 MB）的原因。
只启动本脚本自己的实例，只读本进程信息，结束后只终止自己启动的进程。
"""

import argparse
import ctypes
import ctypes.wintypes
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(r"D:\Develop\task_dock")
RESULTS = ROOT / "docs" / "performance" / "results"

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080


def find_main_window(pid):
    """找主窗口：排除单实例插件的隐藏工具窗，并取面积最大的可见窗口。

    插件会创建一个 WS_EX_TOOLWINDOW 顶层消息窗，它在枚举里排在主窗口之前且
    IsWindowVisible 为真。直接取第一个会把「显示/聚焦主窗口」变成「显示插件消息窗」，
    主窗口始终隐藏（输入法也就不会附着），对照组因此失效。
    """
    hwnds = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def callback(hwnd, _lparam):
        wpid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid and user32.IsWindowVisible(hwnd):
            style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            if not (style & WS_EX_TOOLWINDOW):
                hwnds.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    if not hwnds:
        return None

    def area(hwnd):
        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return (rect.right - rect.left) * (rect.bottom - rect.top)

    return max(hwnds, key=area)


def process_info(pid):
    """返回 (private_bytes, working_set) 。"""
    script = (
        "$p=Get-Process -Id " + str(pid) + "; "
        "[string]$p.PrivateMemorySize64 + '|' + [string]$p.WorkingSet64"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    raw = out.stdout.strip().splitlines()[-1]
    priv, ws = raw.split("|")
    return int(priv), int(ws)


def module_names(pid):
    """列出进程已加载的模块名。"""
    script = (
        f"$p=Get-Process -Id {pid}; "
        "$p.Modules | ForEach-Object { $_.ModuleName }"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return sorted({l.strip() for l in out.stdout.splitlines() if l.strip()})


def seed(data_dir, appdata, port, notify, exe):
    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(data_dir)
    env["APPDATA"] = str(appdata)
    data_dir.mkdir(parents=True, exist_ok=True)
    appdata.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        [exe, "--agentctl", "status", "codex"],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        errors="replace",
    )
    db = data_dir / "task-dock.db"
    if not db.exists():
        raise RuntimeError(f"agentctl 未创建数据库: rc={r.returncode} {r.stdout} {r.stderr}")
    settings = {
        "http_enabled": True,
        "http_port": port,
        "mock_enabled": False,
        "clipboard_enabled": False,
        "auto_backup": False,
        "notify_agent": notify,
        "notify_reminder": False,
        "notify_muted": False,
        "snap_enabled": False,
        "hotkey_enabled": False,
        "stale_run_minutes": 15,
        "perf_diagnostics_enabled": True,
    }
    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(db)
    try:
        for k, v in settings.items():
            con.execute(
                "INSERT INTO application_settings(key, value, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (k, json.dumps(v), now),
            )
        con.commit()
        token = json.loads(
            con.execute(
                "SELECT value FROM application_settings WHERE key='http_token'"
            ).fetchone()[0]
        )
    finally:
        con.close()
    return token


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--port", type=int, default=47930)
    ap.add_argument("--notify", choices=["on", "off"], default="on")
    ap.add_argument("--wait-s", type=int, default=25)
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument(
        "--window-mode",
        choices=["visible", "minimized", "hidden"],
        default="visible",
        help="visible=SW_RESTORE；minimized=SW_MINIMIZE；hidden=SW_HIDE",
    )
    ap.add_argument(
        "--focus-out",
        action="store_true",
        help="启动后把前台焦点让给桌面（SetForegroundWindow(hwnd_desktop)），用于隔离输入法是否附着",
    )
    args = ap.parse_args()

    work = Path(args.work_dir)
    exe = str(Path(args.exe).resolve())
    RESULTS.mkdir(parents=True, exist_ok=True)
    records = []
    for i in range(args.rounds):
        name = f"{args.name}-{i}"
        data_dir = work / f"{name}-data"
        appdata = work / f"{name}-appdata"
        if data_dir.exists():
            shutil.rmtree(data_dir)
        if appdata.exists():
            shutil.rmtree(appdata)
        token = seed(data_dir, appdata, args.port + i, args.notify == "on", exe)
        env = os.environ.copy()
        env["TASK_DOCK_DATA_DIR"] = str(data_dir)
        env["APPDATA"] = str(appdata)
        exe = str(Path(args.exe).resolve())
        proc = subprocess.Popen([exe], env=env)
        try:
            time.sleep(3)
            hwnd = find_main_window(proc.pid)
            if hwnd:
                cmd = {"visible": 9, "minimized": 6, "hidden": 0}[args.window_mode]
                user32.ShowWindow(hwnd, cmd)
            if args.focus_out:
                # 把前台焦点交给桌面窗口，避免 Task Dock 窗口附着输入法
                shell = user32.GetShellWindow()
                user32.SetForegroundWindow(shell)
            time.sleep(args.wait_s)
            priv, ws = process_info(proc.pid)
            mods = module_names(proc.pid)
            rec = {
                "round": i,
                "name": name,
                "pid": proc.pid,
                "private_mb": round(priv / 1048576, 1),
                "ws_mb": round(ws / 1048576, 1),
                "window_found": hwnd is not None,
                "window_mode": args.window_mode,
                "focus_out": args.focus_out,
                "ime_modules": sorted(
                    m for m in mods
                    if any(k in m.lower() for k in ("sogou", "ime", "tsf", "textshaping", "bundle"))
                ),
                "module_count": len(mods),
                "modules": mods,
            }
            records.append(rec)
            print(
                f"[{name}] pid={proc.pid} private={rec['private_mb']}MB ws={rec['ws_mb']}MB "
                f"window={rec['window_found']} modules={len(mods)}",
                flush=True,
            )
        finally:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=60,
            )
            time.sleep(2)

    out = RESULTS / f"MODFINGER-{args.name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[report] {out}")


if __name__ == "__main__":
    main()
