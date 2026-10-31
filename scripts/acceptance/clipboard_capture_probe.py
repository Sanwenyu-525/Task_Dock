"""真实剪贴板采集链路探针（诊断用）。

用途：在**没有**浏览器窗口参与的情况下，只做一次真实剪贴板文本写入，
观察 Task Dock 的采集链路（WM_CLIPBOARDUPDATE → 事件队列 → 采集线程 →
入库）到底发生了什么：是被过滤（skip）、读到的内容不可分类（empty），
还是事件根本没被观察到。

边界：
- 会覆盖用户当前剪贴板文本，结束后尽力恢复（内容只在进程内存，不落盘、不打日志）。
- 日志与输出只含计数、原因与字节数，绝不含剪贴板正文。
- 所有子进程一律 CREATE_NO_WINDOW，不弹控制台窗口。

用法：
  python scripts/acceptance/clipboard_capture_probe.py \
      --exe src-tauri/target-accept/release/task-dock.exe \
      --out docs/clipboard/evidence/capture-probe-<stamp>.json
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

import win32clipboard
import win32con
import win32gui
import win32process

ROOT = Path(__file__).resolve().parents[2]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CREATE_NO_WINDOW = 0x08000000
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.OpenClipboard.argtypes = [ctypes.c_void_p]
user32.OpenClipboard.restype = ctypes.c_bool
user32.GetClipboardData.argtypes = [ctypes.c_uint]
user32.GetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
user32.SetClipboardData.restype = ctypes.c_void_p
user32.IsClipboardFormatAvailable.argtypes = [ctypes.c_uint]
user32.IsClipboardFormatAvailable.restype = ctypes.c_bool
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.restype = ctypes.c_bool
user32.GetClipboardSequenceNumber.argtypes = []
user32.GetClipboardSequenceNumber.restype = ctypes.c_uint


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", port)) != 0


def reserve_port(preferred: int) -> int:
    if port_is_free(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def open_clipboard(retries=30, delay=0.05) -> bool:
    for _ in range(retries):
        if user32.OpenClipboard(None):
            return True
        time.sleep(delay)
    return False


def clipboard_sequence() -> int:
    return int(user32.GetClipboardSequenceNumber())


def get_clipboard_text() -> str | None:
    if not open_clipboard():
        return None
    try:
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def write_text_pywin32(text: str) -> bool:
    """与 P1-03 验收脚本完全相同的写法：pywin32 SetClipboardData。"""
    if not open_clipboard():
        return False
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, text)
        return True
    finally:
        win32clipboard.CloseClipboard()


def write_text_manual(text: str) -> bool:
    """显式 NUL 结尾的 UTF-16LE 写法（与 clipboard_stimulus.py 一致）。"""
    if not open_clipboard():
        return False
    try:
        user32.EmptyClipboard()
        data = (text + "\0").encode("utf-16-le")
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            return False
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return False
        try:
            ctypes.memmove(ptr, data, len(data))
        finally:
            kernel32.GlobalUnlock(handle)
        user32.SetClipboardData(CF_UNICODETEXT, handle)
        return True
    finally:
        user32.CloseClipboard()


def node_bridge(action: str, port: int, *args: str, timeout: float = 60.0) -> dict:
    cmd = ["node", str(ROOT / "scripts" / "acceptance" / "cdp-bridge.mjs"), action, str(port), *args]
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=NO_WINDOW,
    )
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError(f"CDP 桥无输出（exit={proc.returncode}）: {proc.stderr[-500:]}")
    return json.loads(out)


def http_json(url: str, timeout: float = 1.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_http(url: str, timeout: float) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            return http_json(url)
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.25)
    raise RuntimeError(f"等待 CDP 超时: {url}: {last}")


def invoke(port: int, command: str, args: dict | None = None, timeout: float = 30.0, attempts: int = 10):
    last = None
    for _ in range(attempts):
        try:
            result = node_bridge(
                "invoke", port, command, json.dumps(args or {}, ensure_ascii=False), timeout=timeout
            )
            if result.get("ok"):
                return result.get("value")
            last = RuntimeError(str(result.get("error")))
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(0.75)
    raise RuntimeError(f"{command} 调用失败: {last}")


def minimize_windows_of(pid: int) -> list[int]:
    """最小化本次隔离实例自己的窗口：前台是本应用时来源会被判成「自身」而跳过。"""
    minimized: list[int] = []

    def enum(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        _, wpid = win32process.GetWindowThreadProcessId(hwnd)
        if wpid == pid:
            win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
            minimized.append(hwnd)

    win32gui.EnumWindows(enum, None)
    time.sleep(0.4)
    return minimized


def monitor_stats(port: int) -> dict:
    return invoke(port, "clipboard_status").get("monitor", {})


def view_items(port: int) -> list[dict]:
    view = invoke(port, "clipboard_view", {"filter": {"favorite": False, "limit": 50}})
    return view.get("items", [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default=str(ROOT / "src-tauri" / "target-accept" / "release" / "task-dock.exe"))
    ap.add_argument("--cdp-port", type=int, default=9427)
    ap.add_argument("--timeout", type=float, default=12.0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    exe = Path(args.exe)
    if not exe.is_file():
        print(f"找不到可执行文件: {exe}", file=sys.stderr)
        return 2

    work = Path(tempfile.mkdtemp(prefix="taskdock-capture-probe-"))
    data_dir = work / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = work / "app.log"
    cdp = reserve_port(args.cdp_port)

    original = get_clipboard_text()
    evidence: dict = {
        "name": "clipboard capture probe",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "exe": str(exe),
        "exe_mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(exe.stat().st_mtime)),
        "work_dir": str(work),
        "app_cdp": cdp,
        "cases": [],
    }

    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(data_dir)
    env["WEBVIEW2_USER_DATA_FOLDER"] = str(work / "webview2")
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={cdp}"
    env["RUST_LOG"] = "info,task_dock_lib::clipboard=debug"

    app = None
    try:
        with open(log_path, "w", encoding="utf-8") as log:
            app = subprocess.Popen(
                [str(exe)],
                cwd=str(ROOT),
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        wait_http(f"http://127.0.0.1:{cdp}/json/version", timeout=60)
        deadline = time.time() + 60
        status = None
        while time.time() < deadline:
            try:
                status = invoke(cdp, "clipboard_status", timeout=15)
                if status.get("monitoring"):
                    break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        if not status or not status.get("monitoring"):
            raise RuntimeError("应用未进入监听状态")

        # 本实例自己的窗口不能在前台，否则来源会被判成「Task Dock 自身」。
        evidence["own_windows_minimized"] = minimize_windows_of(app.pid)

        for case_name, writer in (("pywin32", write_text_pywin32), ("manual_utf16", write_text_manual)):
            before = monitor_stats(cdp)
            items_before = len(view_items(cdp))
            marker = f"CAPTURE-PROBE-{case_name.upper()}-{uuid.uuid4().hex[:8]}"
            payload = f"{marker}-采集探针"
            seq_before = clipboard_sequence()
            wrote = writer(payload)
            seq_after = clipboard_sequence()
            time.sleep(args.timeout)
            after = monitor_stats(cdp)
            items = view_items(cdp)
            hit = [i for i in items if marker in (i.get("preview") or "") or marker in (i.get("text") or "")]
            evidence["cases"].append(
                {
                    "case": case_name,
                    "wrote": wrote,
                    "sequence_before": seq_before,
                    "sequence_after": seq_after,
                    "items_before": items_before,
                    "items_after": len(items),
                    "captured_delta": after.get("captured", 0) - before.get("captured", 0),
                    "recorded_delta": after.get("recorded", 0) - before.get("recorded", 0),
                    "skipped_delta": after.get("skipped", 0) - before.get("skipped", 0),
                    "observed_delta": after.get("observed_events", 0) - before.get("observed_events", 0),
                    "dropped_events_delta": after.get("dropped_events", 0) - before.get("dropped_events", 0),
                    "merged_delta": after.get("merged_events", 0) - before.get("merged_events", 0),
                    "hit": bool(hit),
                }
            )
            print(json.dumps(evidence["cases"][-1], ensure_ascii=False), flush=True)
    finally:
        if app is not None and app.poll() is None:
            app.terminate()
            try:
                app.wait(timeout=10)
            except subprocess.TimeoutExpired:
                app.kill()
        if original is not None:
            try:
                write_text_pywin32(original)
                evidence["clipboard_restored"] = get_clipboard_text() == original
            except Exception:  # noqa: BLE001
                evidence["clipboard_restored"] = False
        evidence["clipboard_restored"] = evidence.get("clipboard_restored", False)
        log_text = log_path.read_bytes().decode("utf-8", "replace") if log_path.is_file() else ""
        evidence["clipboard_log_lines"] = [
            line for line in log_text.splitlines() if "clipboard" in line or "剪贴板" in line
        ]
        if args.out:
            out_path = Path(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        shutil.rmtree(work, ignore_errors=True)

    for line in evidence["clipboard_log_lines"]:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
