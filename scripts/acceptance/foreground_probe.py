"""P2-06 前台权限实测：区分「Windows 前台锁定（环境限制）」与「产品焦点实现缺陷」。

不修改被测应用代码，只用与 Rust 焦点实现相同的 Win32 惯用法，在本机实测
一个「由后台代理/终端拉起的控制台进程」到底能不能拿到设置前台的资格：

1. 直接 SetForegroundWindow
2. 先按一次 ALT（keybd_event，产品当前做法）再 SetForegroundWindow
3. AttachThreadInput 挂到前台线程再 SetForegroundWindow
4. AllowSetForegroundWindow(ASFW_ANY) 后重试

每个策略都独立测量「API 返回值 + GetForegroundWindow 是否真的等于目标」。
目标窗口只允许是**本脚本自己拉起的**记事本子进程窗口（与测试进程安全策略一致），
清理仅针对自己的子进程树。

用法：
    python scripts/acceptance/foreground_probe.py [--out docs/clipboard/evidence]
"""

from __future__ import annotations

import argparse
import ctypes
import json
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

SW_RESTORE = 9
GWLP_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
KEYEVENTF_KEYUP = 0x0002
VK_MENU = 0x12
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x00000002


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def descendant_pids(parent_pid: int) -> list[int]:
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    pids: list[int] = []
    if snap != ctypes.c_void_p(-1).value:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
            while True:
                if entry.th32ParentProcessID == parent_pid and entry.szExeFile.lower() == "notepad.exe":
                    pids.append(int(entry.th32ProcessID))
                if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                    break
        kernel32.CloseHandle(snap)
    return pids


def owned_windows(child_pid: int) -> list[tuple[int, int, str]]:
    """返回 [(hwnd, pid, title)]，只包含本测试子进程树（含 Win11 存根形态）的可见顶层窗口。"""
    owned = set(descendant_pids(child_pid)) | {child_pid}
    found: list[tuple[int, int, str]] = []
    seen_pids: set[int] = set()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        if user32.GetWindowLongW(hwnd, GWLP_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in owned:
            seen_pids.add(pid.value)
            found.append((int(hwnd), pid.value, buf.value))
        return True

    user32.EnumWindows(enum_proc, 0)
    del seen_pids
    return found


def wait_owned_window(child_pid: int, timeout: float):
    deadline = time.time() + timeout
    while time.time() < deadline:
        wins = owned_windows(child_pid)
        if wins:
            return wins[0]
        time.sleep(0.2)
    return None


def is_foreground(hwnd: int) -> bool:
    return int(user32.GetForegroundWindow()) == hwnd


def alt_press() -> None:
    user32.keybd_event(VK_MENU, 0, 0, 0)
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)


def attach_to_foreground_thread() -> tuple[bool, int]:
    fg = user32.GetForegroundWindow()
    tid = user32.GetWindowThreadProcessId(fg, None)
    own = kernel32.GetCurrentThreadId()
    if not tid or tid == own:
        return False, 0
    return bool(user32.AttachThreadInput(own, tid, True)), int(tid)


def strategy_direct(hwnd: int) -> dict:
    ret = user32.SetForegroundWindow(hwnd)
    time.sleep(0.25)
    return {"api_ret": int(ret), "foreground": is_foreground(hwnd)}


def strategy_alt_then_set(hwnd: int) -> dict:
    alt_press()
    time.sleep(0.06)
    ret = user32.SetForegroundWindow(hwnd)
    time.sleep(0.25)
    return {"api_ret": int(ret), "foreground": is_foreground(hwnd)}


def strategy_attach_then_set(hwnd: int) -> dict:
    attached, tid = attach_to_foreground_thread()
    try:
        ret = user32.SetForegroundWindow(hwnd)
        time.sleep(0.25)
        return {"attached": attached, "attached_thread": tid, "api_ret": int(ret), "foreground": is_foreground(hwnd)}
    finally:
        if attached:
            user32.AttachThreadInput(kernel32.GetCurrentThreadId(), tid, False)


def strategy_allow_any(hwnd: int) -> dict:
    allowed = int(user32.AllowSetForegroundWindow(0xFFFFFFFF))  # ASFW_ANY
    ret = user32.SetForegroundWindow(hwnd)
    time.sleep(0.25)
    return {"allow_ret": allowed, "api_ret": int(ret), "foreground": is_foreground(hwnd)}


def input_desktop_name() -> str | None:
    handle = user32.OpenInputDesktop(0, False, 0x0100)
    if not handle:
        return None
    buf = ctypes.create_unicode_buffer(256)
    needed = wintypes.DWORD(0)
    name = None
    if user32.GetUserObjectInformationW(handle, 2, buf, ctypes.sizeof(buf), ctypes.byref(needed)):
        name = buf.value
    user32.CloseDesktop(handle)
    return name


def kill_owned_tree(child_pid: int) -> None:
    for pid in descendant_pids(child_pid):
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/F"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=NO_WINDOW,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "docs" / "clipboard" / "evidence"))
    parser.add_argument("--rounds", type=int, default=3)
    args = parser.parse_args()

    fg = int(user32.GetForegroundWindow())
    fg_pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(fg, ctypes.byref(fg_pid))
    record: dict = {
        "name": "P2-06 foreground-rights probe",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "own_pid": kernel32.GetCurrentProcessId(),
        "input_desktop": input_desktop_name(),
        "foreground_before": {"hwnd": fg, "pid": int(fg_pid.value)},
        "ppid_chain": [],
        "strategies": {},
        "rounds": {},
    }
    parent = kernel32.GetCurrentProcessId()
    for _ in range(6):
        snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snap == ctypes.c_void_p(-1).value:
            break
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        next_parent = 0
        if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
            while True:
                if int(entry.th32ProcessID) == parent:
                    next_parent = int(entry.th32ParentProcessID)
                    record["ppid_chain"].append({"pid": parent, "exe": entry.szExeFile})
                    break
                if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                    break
        kernel32.CloseHandle(snap)
        if not next_parent or next_parent in (0, 4):
            break
        parent = next_parent

    proc = subprocess.Popen(["C:\\Windows\\notepad.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        win = wait_owned_window(proc.pid, 8)
        if not win:
            record["overall"] = "ENVIRONMENT BLOCKED"
            record["reason"] = "8 秒内没有出现归属本探测进程子树的记事本窗口"
            print(json.dumps(record, ensure_ascii=False, indent=2))
            return 3
        hwnd, win_pid, title = win
        record["target"] = {"hwnd": hwnd, "pid": win_pid, "title": title}
        order = [
            ("alt_then_set", strategy_alt_then_set),
            ("attach_then_set", strategy_attach_then_set),
            ("allow_any_then_set", strategy_allow_any),
            ("direct", strategy_direct),
        ]
        for rnd in range(1, args.rounds + 1):
            results = {}
            for name, fn in order:
                # 每个策略前先把记事本最小化再恢复，制造「非前台」起点，避免上一轮残留状态
                user32.ShowWindowAsync(hwnd, SW_RESTORE)
                time.sleep(0.15)
                results[name] = fn(hwnd)
            record["rounds"][f"round{rnd}"] = results
            for name, res in results.items():
                record["strategies"].setdefault(name, []).append(bool(res["foreground"]))
        for name, values in record["strategies"].items():
            record["strategies"][name] = {"success_of_attempts": sum(values), "attempts": len(values)}
        any_success = any(v["success_of_attempts"] for v in record["strategies"].values())
        record["overall"] = "FOREGROUND GRANTED" if any_success else "FOREGROUND DENIED (all strategies)"
        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = out_dir / f"p2-06-foreground-probe-{stamp}.json"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(record, ensure_ascii=False, indent=2))
        print(f"EVIDENCE {path}")
        return 0
    finally:
        kill_owned_tree(proc.pid)
        proc.kill()
        proc.wait()


if __name__ == "__main__":
    sys.exit(main())
