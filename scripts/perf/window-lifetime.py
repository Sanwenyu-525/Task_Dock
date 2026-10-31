#!/usr/bin/env python3
"""盯住被测实例的主窗口句柄：窗口何时失效、进程何时退出。

用途：区分「窗口被销毁（Tauri 因最后一个窗口消失而退出）」与
「进程被外部杀掉」。两者在应用日志里都表现为优雅退出，只有句柄存活能区分。

用法：python scripts/perf/window-lifetime.py <exe> <data_dir> <appdata> <seconds>
"""
import ctypes
import ctypes.wintypes
import os
import subprocess
import sys
import time
from pathlib import Path

user32 = ctypes.windll.user32
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080


def visible_windows(pid):
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        wpid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid and user32.IsWindowVisible(hwnd):
            style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            if not (style & WS_EX_TOOLWINDOW):
                out.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return out


def main():
    exe, data_dir, appdata, seconds = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4])
    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(data_dir)
    env["APPDATA"] = str(appdata)
    env["RUST_LOG"] = "info"
    log = Path(str(data_dir) + "-app.log")
    handle = open(log, "wb")
    proc = subprocess.Popen([exe], env=env, stdout=handle, stderr=subprocess.STDOUT)
    t0 = time.time()
    hwnds = []
    while time.time() - t0 < seconds:
        alive = proc.poll() is None
        if not hwnds and alive:
            hwnds = visible_windows(proc.pid)
            if hwnds:
                print(f"[{time.time()-t0:6.1f}s] 主窗口句柄: {[hex(h) for h in hwnds]}", flush=True)
        if hwnds and alive:
            gone = [h for h in hwnds if not user32.IsWindow(h)]
            if gone:
                print(f"[{time.time()-t0:6.1f}s] 窗口已失效（IsWindow=False）: {[hex(h) for h in gone]}", flush=True)
                hwnds = [h for h in hwnds if user32.IsWindow(h)]
        if not alive:
            print(f"[{time.time()-t0:6.1f}s] 进程退出 code={proc.returncode}", flush=True)
            break
        time.sleep(0.5)
    else:
        print(f"[{time.time()-t0:6.1f}s] 观察窗口结束，进程仍存活", flush=True)
    if proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


if __name__ == "__main__":
    main()
