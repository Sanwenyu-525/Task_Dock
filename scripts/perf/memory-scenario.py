#!/usr/bin/env python3
"""隔离实例内存场景编排：启动 GUI → 采样 → 施加 HTTP 负载 → 结束负载 → 观察平台。

只操作本脚本启动的进程；不关闭、不修改任何用户正在使用的 Task Dock 实例。
所有数据目录/APPDATA 均位于 --work-dir 下。

用法示例：
  python scripts/perf/memory-scenario.py --exe <task-dock.exe> --name diag-mixed-notify \
    --mode mixed --duration 480 --post 120 --notify on --window visible \
    --work-dir C:/Users/ASUS/AppData/Local/Temp/taskdock-mem-v05 --port 47841
"""

import argparse
import ctypes
import ctypes.wintypes
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(r"D:\Develop\task_dock")
SAMPLER = ROOT / "scripts" / "perf" / "sampler.ps1"
PROBE = ROOT / "scripts" / "perf" / "memory-probe.mjs"
STIMULUS = ROOT / "scripts" / "acceptance" / "clipboard_stimulus.py"
RESULTS = ROOT / "docs" / "performance" / "results"

user32 = ctypes.windll.user32

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080


def find_main_window(pid):
    """找主窗口：必须排除托盘插件的隐藏工具窗。

    单实例插件会创建一个 WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE 的顶层消息窗，
    它在窗口枚举里排在主窗口之前且 IsWindowVisible 为真。
    直接取第一个可见窗口会拿到它，--window visible 就变成了「显示插件消息窗」，
    主窗口始终隐藏（界面未真正渲染，IME/毛玻璃等路径也没被走到）。
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
    # 取面积最大的可见窗口，避免拿到辅助窗
    def area(hwnd):
        rect = ctypes.wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return (rect.right - rect.left) * (rect.bottom - rect.top)

    return max(hwnds, key=area)


def set_window(pid, mode):
    hwnd = find_main_window(pid)
    if not hwnd:
        return {"ok": False, "error": "未找到主窗口"}
    cmd = {"visible": 9, "minimized": 6, "hidden": 0}[mode]
    user32.ShowWindow(hwnd, cmd)
    time.sleep(1)
    return {
        "ok": True,
        "hwnd": int(hwnd),
        "visible": bool(user32.IsWindowVisible(hwnd)),
        "iconic": bool(user32.IsIconic(hwnd)),
    }


def http_json(url, token=None, timeout=5):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_health(base, timeout=90):
    started = time.time()
    last = None
    while time.time() - started < timeout:
        try:
            return http_json(f"{base}/api/v1/health", timeout=2)
        except Exception as e:  # noqa: BLE001
            last = str(e)
            time.sleep(0.5)
    raise RuntimeError(f"等待健康检查超时: {last}")


def seed_and_patch(exe, data_dir, appdata, port, notify, extra_settings=None, reuse=False):
    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(data_dir)
    env["APPDATA"] = str(appdata)
    db = data_dir / "task-dock.db"
    if reuse:
        # 复用既有大库（复制到隔离目录后）测量数据规模对内存的影响；
        # 只允许调用方显式开启，默认路径仍然拒绝覆盖任何已有数据库。
        if not db.exists():
            raise RuntimeError(f"--reuse-db 需要已存在的数据库: {db}")
    else:
        if db.exists():
            raise RuntimeError(f"数据目录已存在数据库（拒绝覆盖）: {db}")
    data_dir.mkdir(parents=True, exist_ok=True)
    appdata.mkdir(parents=True, exist_ok=True)
    if not reuse:
        r = subprocess.run(
            [str(exe), "--agentctl", "status", "codex"],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
            errors="replace",
        )
        if not db.exists():
            raise RuntimeError(f"agentctl 未创建数据库: rc={r.returncode} out={r.stdout} err={r.stderr}")
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
    if extra_settings:
        settings.update(extra_settings)
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
            con.execute("SELECT value FROM application_settings WHERE key='http_token'").fetchone()[0]
        )
    finally:
        con.close()
    return token, settings


def running_image_pids(image_name):
    """列出指定镜像名的进程 PID（一次 tasklist 查询）。

    采样器按进程名归组 Task Dock 的资源占用：同名实例的进程树会混进
    'taskdock' 分组，使单臂数据失真（上一轮 N3 基线即因环境实例干扰而作废）。
    不同名的实例（如改名后的测量副本）进程树相互独立，不会串组，
    只作为环境干扰记录，不阻断测量。
    """
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {image_name}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=20,
            errors="replace",
        ).stdout
    except Exception:  # noqa: BLE001
        return []
    pids = []
    for line in out.splitlines():
        parts = [p.strip('" ') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == image_name.lower():
            try:
                pids.append(int(parts[1]))
            except ValueError:
                continue
    return pids


def start_app(exe, data_dir, appdata, app_log=None):
    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(data_dir)
    env["APPDATA"] = str(appdata)
    env.setdefault("RUST_LOG", "info")
    if app_log is None:
        return subprocess.Popen([str(exe)], env=env)
    # 显式接管 stdout/stderr：应用自身的 tracing 日志是判断「进程为何退出」的唯一一手证据，
    # 靠 shell 重定向继承句柄并不可靠（GUI 子系统程序在部分启动方式下拿不到有效句柄）。
    handle = open(app_log, "wb")
    return subprocess.Popen(
        [str(exe)], env=env, stdout=handle, stderr=subprocess.STDOUT
    )


def terminate(proc, timeout=20):
    if proc.poll() is not None:
        return
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=30)
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        pass


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


def linear_slope(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom


def analyze_sampler(path):
    rows = read_jsonl(path)
    samples = [r for r in rows if r.get("record") == "sample"]
    if not samples:
        return {"samples": 0}
    xs = [r["elapsed_s"] for r in samples]

    def series(fn):
        return [fn(r) for r in samples]

    def stat(values):
        vals = [v for v in values if isinstance(v, (int, float))]
        if not vals:
            return None
        ordered = sorted(vals)
        return {
            "n": len(vals),
            "first": round(vals[0], 3),
            "last": round(vals[-1], 3),
            "min": round(ordered[0], 3),
            "max": round(ordered[-1], 3),
            "mean": round(sum(vals) / len(vals), 3),
        }

    td_private = series(lambda r: r["taskdock"]["private_mb"])
    td_ws = series(lambda r: r["taskdock"]["ws_mb"])
    wv_private = series(lambda r: r["webview2_tree"]["private_mb"])
    td_threads = series(lambda r: r["taskdock"].get("threads"))
    td_handles = series(lambda r: r["taskdock"].get("handles"))
    committed = series(lambda r: (r.get("system") or {}).get("committed_bytes"))
    stats_rows = [r["stats"] for r in samples if r.get("stats")]
    live = [
        s.get("process", {}).get("live_bytes")
        for s in stats_rows
        if isinstance(s.get("process", {}).get("live_bytes"), (int, float))
    ]
    peak = [
        s.get("process", {}).get("peak_bytes")
        for s in stats_rows
        if isinstance(s.get("process", {}).get("peak_bytes"), (int, float))
    ]
    total_alloc = [
        s.get("process", {}).get("total_allocated_bytes")
        for s in stats_rows
        if isinstance(s.get("process", {}).get("total_allocated_bytes"), (int, float))
    ]
    alloc_calls = [
        s.get("process", {}).get("alloc_calls")
        for s in stats_rows
        if isinstance(s.get("process", {}).get("alloc_calls"), (int, float))
    ]
    alive_tasks = [
        s.get("runtime", {}).get("alive_tasks")
        for s in stats_rows
        if isinstance(s.get("runtime", {}).get("alive_tasks"), (int, float))
    ]
    wal_bytes = [
        s.get("db", {}).get("wal_bytes")
        for s in stats_rows
        if isinstance(s.get("db", {}).get("wal_bytes"), (int, float))
    ]
    db_bytes = [
        s.get("db", {}).get("db_bytes")
        for s in stats_rows
        if isinstance(s.get("db", {}).get("db_bytes"), (int, float))
    ]
    page_count = [
        (s.get("db", {}).get("pragma") or {}).get("page_count")
        for s in stats_rows
        if isinstance((s.get("db", {}).get("pragma") or {}).get("page_count"), (int, float))
    ]
    stats_t = [r["elapsed_s"] for r in samples if r.get("stats")]

    def slope_per_min(xs_, ys_, scale=1.0):
        if len(xs_) > 2 and len(ys_) == len(xs_) and all(
            isinstance(v, (int, float)) for v in ys_
        ):
            return round(linear_slope(xs_, ys_) * 60 / scale, 4)
        return None

    return {
        "samples": len(samples),
        "elapsed_s": samples[-1]["elapsed_s"],
        "taskdock_private_mb": stat(td_private),
        "taskdock_ws_mb": stat(td_ws),
        "webview2_private_mb": stat(wv_private),
        "taskdock_threads": stat(td_threads),
        "taskdock_handles": stat(td_handles),
        "system_committed_mb": stat(
            [c / 1048576 for c in committed if isinstance(c, (int, float))]
        ),
        "slope_private_mb_per_min": (
            round(linear_slope(xs, td_private) * 60, 3) if len(xs) > 2 else None
        ),
        "slope_ws_mb_per_min": (
            round(linear_slope(xs, td_ws) * 60, 3) if len(xs) > 2 else None
        ),
        "slope_live_mb_per_min": (
            round(linear_slope(stats_t, live) * 60 / 1048576, 4) if len(live) > 2 else None
        ),
        "slope_threads_per_min": slope_per_min(xs, td_threads),
        "slope_handles_per_min": slope_per_min(xs, td_handles),
        "slope_committed_mb_per_min": slope_per_min(
            xs, [c for c in committed], scale=1048576
        ),
        "slope_alive_tasks_per_min": slope_per_min(stats_t, alive_tasks),
        "slope_wal_mb_per_min": slope_per_min(stats_t, wal_bytes, scale=1048576),
        "slope_db_mb_per_min": slope_per_min(stats_t, db_bytes, scale=1048576),
        "rust_live_bytes": stat(live),
        "rust_peak_bytes": stat(peak),
        "rust_total_allocated_bytes": stat(total_alloc),
        "rust_alloc_calls": stat(alloc_calls),
        "tokio_alive_tasks": stat(alive_tasks),
        "sqlite_wal_bytes": stat(wal_bytes),
        "sqlite_db_bytes": stat(db_bytes),
        "sqlite_page_count": stat(page_count),
        "first_last": {
            "taskdock_private_mb": [td_private[0], td_private[-1]],
            "taskdock_ws_mb": [td_ws[0], td_ws[-1]],
            "webview2_private_mb": [wv_private[0], wv_private[-1]],
            "live_bytes": [live[0], live[-1]] if live else None,
            "alive_tasks": [alive_tasks[0], alive_tasks[-1]] if alive_tasks else None,
            "wal_bytes": [wal_bytes[0], wal_bytes[-1]] if wal_bytes else None,
            "db_bytes": [db_bytes[0], db_bytes[-1]] if db_bytes else None,
        },
        "stats_first": stats_rows[0] if stats_rows else None,
        "stats_last": stats_rows[-1] if stats_rows else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--mode", default="mixed")
    ap.add_argument("--duration", type=int, default=480)
    ap.add_argument("--post", type=int, default=120)
    ap.add_argument("--rate", type=int, default=5)
    ap.add_argument("--agents", type=int, default=4)
    ap.add_argument("--notify", choices=["on", "off"], default="on")
    ap.add_argument("--window", choices=["visible", "minimized", "hidden"], default="visible")
    ap.add_argument("--work-dir", default=r"C:\Users\ASUS\AppData\Local\Temp\taskdock-mem-v05")
    ap.add_argument("--port", type=int, default=47841)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--source", default="bench")
    ap.add_argument(
        "--allow-real-source",
        action="store_true",
        help="允许向非 bench（真实类别）来源投递：事件会被服务端判为 real，"
        "产生真实状态与系统通知。仅在隔离实例内做通知路径测量时使用。",
    )
    ap.add_argument("--settings-json", default="")
    ap.add_argument(
        "--clipboard-stimulus",
        choices=["on", "off"],
        default="off",
        help="在负载期间产生真实 Windows 剪贴板变更事件（P1-05 联合负载）",
    )
    ap.add_argument("--clipboard-interval", type=float, default=5.0)
    ap.add_argument("--clipboard-image-every", type=int, default=6)
    ap.add_argument("--clipboard-marker", default="taskdock-p1-05-clipboard-probe-", help="剪贴板测试文本唯一标识前缀")
    ap.add_argument(
        "--transport",
        choices=["http", "file"],
        default="http",
        help="http=HTTP 接入端点；file=直接写 agent-inbox 目录（文件投递通道）",
    )
    ap.add_argument(
        "--idle",
        action="store_true",
        help="空载：不施加任何 Agent 负载（场景 A/E：纯静置基线）",
    )
    ap.add_argument(
        "--reuse-db",
        action="store_true",
        help="复用 data 目录内已存在的数据库（用于大库规模对照）；"
        "调用方须先把目标库复制进 <work>/<name>-data/，默认仍拒绝覆盖",
    )
    args = ap.parse_args()

    work = Path(args.work_dir)
    data_dir = work / f"{args.name}-data"
    appdata = work / f"{args.name}-appdata"
    if args.reuse_db:
        if not (data_dir / "task-dock.db").exists():
            raise RuntimeError(f"--reuse-db 但数据目录内没有数据库: {data_dir / 'task-dock.db'}")
    elif data_dir.exists():
        raise RuntimeError(f"数据目录已存在（拒绝覆盖）: {data_dir}")
    RESULTS.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    sampler_out = RESULTS / f"DIAG-{args.name}-{ts}.jsonl"
    probe_out = RESULTS / f"DIAG-{args.name}-{ts}-load.json"
    meta_out = RESULTS / f"DIAG-{args.name}-{ts}-meta.json"
    base = f"http://127.0.0.1:{args.port}"
    extra = json.loads(args.settings_json) if args.settings_json else None

    print(f"[setup] data={data_dir} appdata={appdata} port={args.port}", flush=True)
    exe_path = Path(args.exe)
    image_name = exe_path.name
    foreign = running_image_pids(image_name)
    if foreign:
        raise RuntimeError(
            f"检测到 {len(foreign)} 个已在运行的同名实例 {image_name}（PID {foreign}）："
            "采样器按进程名归组资源占用，同名多余实例会污染本臂数据。请先关闭它们再测量。"
        )
    # 异名实例（例如并行会话跑着的正式产物 task-dock.exe）进程树独立，
    # 不会串入本臂分组，但会占用 CPU/磁盘，如实记录为环境干扰。
    other_instances = running_image_pids("task-dock.exe")
    if other_instances:
        print(
            f"[env] 检测到 {len(other_instances)} 个异名 Task Dock 实例（task-dock.exe，PID {other_instances}）："
            "进程树独立不串组，但会竞争 CPU/磁盘，已记录为环境干扰。",
            flush=True,
        )
    token, settings = seed_and_patch(
        exe_path, data_dir, appdata, args.port, args.notify == "on", extra,
        reuse=args.reuse_db,
    )
    app_log = RESULTS / f"DIAG-{args.name}-{ts}-app.log"
    proc = start_app(exe_path, data_dir, appdata, app_log)
    started = time.time()
    window = None
    stats_end_of_load = None
    stats_after = None
    error = None
    instance_exited_after_s = None
    try:
        health = wait_health(base)
        print(f"[app] pid={proc.pid} health={health}", flush=True)
        window = set_window(proc.pid, args.window)
        time.sleep(2)
        sampler = subprocess.Popen(
            [
                "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(SAMPLER),
                "-Out", str(sampler_out),
                "-IntervalSec", "5",
                "-DurationSec", str(args.duration + args.post + 15),
                "-Base", base,
                "-Token", token,
                "-ProcessNamePattern", "^" + re.escape(exe_path.stem),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(6)
        # 真实剪贴板激励：与 Agent 负载同时进行（P1-05）。
        stimulus = None
        stimulus_out = RESULTS / f"DIAG-{args.name}-{ts}-stimulus.json"
        if args.clipboard_stimulus == "on":
            stimulus = subprocess.Popen(
                [
                    sys.executable,
                    str(STIMULUS),
                    "--duration",
                    str(args.duration),
                    "--interval",
                    str(args.clipboard_interval),
                    "--image-every",
                    str(args.clipboard_image_every),
                    "--out",
                    str(stimulus_out),
                    "--marker",
                    str(args.clipboard_marker),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            print(f"[stimulus] 真实剪贴板激励已启动 pid={stimulus.pid}", flush=True)
        inbox_dir = data_dir / "agent-inbox"
        if args.transport == "file":
            inbox_dir.mkdir(parents=True, exist_ok=True)
        probe_cmd = [
            "node", str(PROBE),
            "--base", base,
            "--token", token,
            "--mode", args.mode,
            "--agents", str(args.agents),
            "--rate", str(args.rate),
            "--duration", str(args.duration),
            "--batch", str(args.batch),
            "--run-id", f"{args.name}-{ts}",
            "--source", args.source,
            *(["--allow-real-source"] if args.allow_real_source else []),
            "--transport", args.transport,
            "--inbox", str(inbox_dir),
            "--out", str(probe_out),
        ]
        if args.idle:
            print(f"[load] 空载模式：不施加 Agent 负载，持续 {args.duration}s", flush=True)
            probe = subprocess.CompletedProcess(probe_cmd, 0, "", "idle")
            # 空载臂同样要占用与负载臂相同的墙钟时间：采样器按 duration+post 采集，
            # 若这里不等待，流程会提前去等采样器而触发 TimeoutExpired，
            # 本臂就会以「实例退出码 1」作废（2026-10-30 23:57 A 臂即如此）。
            idle_deadline = time.time() + args.duration
            while time.time() < idle_deadline:
                if proc.poll() is not None:
                    instance_exited_after_s = round(time.time() - started, 1)
                    print(
                        f"[instance] 进程在空载段 {instance_exited_after_s}s 自行退出 "
                        f"(code={proc.returncode})，剩余观察窗口作废",
                        flush=True,
                    )
                    break
                time.sleep(min(2.0, max(0.0, idle_deadline - time.time())))
        else:
            probe = subprocess.run(
                probe_cmd,
                capture_output=True,
                text=True,
                timeout=args.duration + 300,
                errors="replace",
            )
            print(f"[load] rc={probe.returncode}", flush=True)
            if probe.returncode != 0:
                print(probe.stderr[-2000:], flush=True)
        if stimulus is not None:
            try:
                stimulus.wait(timeout=60)
            except subprocess.TimeoutExpired:
                stimulus.kill()
            print(
                f"[stimulus] 真实剪贴板激励结束 rc={stimulus.returncode} 证据={stimulus_out}",
                flush=True,
            )
        stats_end_of_load = http_json(f"{base}/api/v1/stats", token, timeout=10)
        # 结束后段：逐秒盯进程存活，实例自行退出时立刻记录时刻，
        # 否则「实例已死但采样还在跑」会被误读成「内存回落到 0」。
        deadline = time.time() + args.post
        while time.time() < deadline:
            if proc.poll() is not None:
                instance_exited_after_s = round(time.time() - started, 1)
                print(
                    f"[instance] 进程在负载结束后 {instance_exited_after_s}s 自行退出 "
                    f"(code={proc.returncode})，剩余观察窗口作废",
                    flush=True,
                )
                break
            time.sleep(min(2.0, max(0.0, deadline - time.time())))
        if instance_exited_after_s is None:
            stats_after = http_json(f"{base}/api/v1/stats", token, timeout=10)
        # 采样器自身要跑满 duration+post+15 秒；等待上限必须覆盖整段墙钟，
        # 只按 post 计时会把长负载臂判成超时。
        sampler.wait(timeout=args.duration + args.post + 120)
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
        print(f"[error] {error}", flush=True)
    finally:
        terminate(proc)

    summary = analyze_sampler(sampler_out) if sampler_out.exists() else {"samples": 0}
    # 0 样本 = 本臂没有任何测量数据（采样器脚本解析失败、进程名没匹配上、
    # 或采样器根本没跑起来）。这必须判失败：曾经出现过「采样器被 GB2312 解码
    # 吞掉换行导致解析失败 → 0 样本」，而场景仍以 rc=0 退出，
    # 差点被当成「内存平稳」的空结果。
    if not summary.get("samples"):
        error = error or (
            "采样器未产出任何样本："
            f"sampler_jsonl={sampler_out} exists={sampler_out.exists()}；"
            "多为 sampler.ps1 解析失败（UTF-8 无 BOM 会被 Windows PowerShell 5.1 "
            "按 GB2312 解码并吞掉换行）或进程名未匹配 -ProcessNamePattern"
        )
        print(f"[error] {error}", flush=True)
    meta = {
        "scenario": args.name,
        "source_exe": str(args.exe),
        "source_exe_bytes": Path(args.exe).stat().st_size,
        "source_exe_image_name": image_name,
        "sampler_process_name_pattern": "^" + re.escape(exe_path.stem),
        "other_task_dock_instances": other_instances,
        "started_at": datetime.fromtimestamp(started, timezone.utc).isoformat(),
        "duration_s": args.duration,
        "post_s": args.post,
        "mode": args.mode,
        "idle": args.idle,
        "source": args.source,
        "allow_real_source": args.allow_real_source,
        "rate_per_agent": args.rate,
        "agents": args.agents,
        "batch": args.batch,
        "transport": args.transport,
        "notifications": args.notify,
        "window": window,
        "settings": settings,
        "data_dir": str(data_dir),
        "sampler_jsonl": str(sampler_out),
        "app_log": str(app_log),
        "load_json": str(probe_out) if probe_out.exists() else None,
        "clipboard_stimulus": (
            json.loads(stimulus_out.read_text(encoding="utf-8"))
            if stimulus_out.exists()
            else None
        ),
        "clipboard_stimulus_json": str(stimulus_out) if stimulus_out.exists() else None,
        "stats_end_of_load": stats_end_of_load,
        "stats_after_post": stats_after,
        "error": error,
        "instance_exited_after_s": instance_exited_after_s,
        "instance_exit_code": proc.returncode,
        "summary": summary,
    }
    meta_out.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"meta": str(meta_out), "summary": summary}, ensure_ascii=False, indent=2))
    if error or instance_exited_after_s is not None:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
