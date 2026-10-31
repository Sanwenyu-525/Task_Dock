#!/usr/bin/env python3
"""被测实例的退出取证：盯住进程的全部顶层窗口与存活状态。

用途：把「实例为什么自己没了」拆成可判定的三种：
  A. 窗口先失效（IsWindow=False），随后进程退出 → 窗口被销毁，Tauri 因最后一个窗口消失而退出
  B. 窗口还在，进程退出         → 不是窗口销毁，需要查 OS 侧退出请求
  C. 进程被外部杀掉（非 0 退出码且无退出报告）→ 不是产品自身退出

同时落盘 last-shutdown-report.json 的存在性，用来区分
「走完 request_exit 优雅排空（退出码 0 + 有报告）」与「被外部终止」。

用法：
  python scripts/perf/exit-forensics.py <exe> <data_dir> <appdata> <seconds> [--restore] [--seed]
"""
import argparse
import ctypes
import ctypes.wintypes
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
SW_RESTORE = 9
SW_SHOW = 5


def top_windows(pid):
    """进程的全部顶层窗口（含 TOOLWINDOW），按 hwnd 排序。"""
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        wpid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid:
            style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            out.append(
                {
                    "hwnd": int(hwnd),
                    "visible": bool(user32.IsWindowVisible(hwnd)),
                    "tool": bool(style & WS_EX_TOOLWINDOW),
                }
            )
        return True

    user32.EnumWindows(cb, 0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("exe")
    ap.add_argument("data_dir")
    ap.add_argument("appdata")
    ap.add_argument("seconds", type=int)
    ap.add_argument("--restore", action="store_true", help="对主窗口执行 ShowWindow(SW_RESTORE)")
    ap.add_argument("--seed", action="store_true", help="先按场景脚本的方式播种设置")
    ap.add_argument(
        "--scenario",
        action="store_true",
        help="复刻 memory-scenario.py 的流程（采样器 + node 负载探针 + HTTP 轮询）",
    )
    ap.add_argument("--port", type=int, default=47955)
    ap.add_argument(
        "--tray-quit-at",
        type=float,
        default=0.0,
        help="在该秒数后执行托盘「退出」自动化（用于复现退出签名）",
    )
    ap.add_argument("--tray-quit-script", default="")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    appdata = Path(args.appdata)
    exe = Path(args.exe)

    if args.seed or args.scenario:
        import importlib.util  # noqa: PLC0415

        spec = importlib.util.spec_from_file_location(
            "memory_scenario", Path(__file__).resolve().parent / "memory-scenario.py"
        )
        ms = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ms)

        if args.seed:
            # notify 必须是布尔：写成字符串会让应用整体设置加载失败并退回默认值
            token, settings = ms.seed_and_patch(exe, data_dir, appdata, args.port, False)
            print(f"[seed] 已播种设置: {json.dumps(settings, ensure_ascii=False)}", flush=True)
    else:
        ms = None
        token = None

    data_dir.mkdir(parents=True, exist_ok=True)
    appdata.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(data_dir)
    env["APPDATA"] = str(appdata)
    env.setdefault("RUST_LOG", "info")

    log_path = Path(str(data_dir) + "-app.log")
    handle = open(log_path, "wb")
    proc = subprocess.Popen([str(exe)], env=env, stdout=handle, stderr=subprocess.STDOUT)
    t0 = time.time()
    print(f"[app] pid={proc.pid} exe={exe}", flush=True)

    known = {}
    restored = False
    exit_info = None
    sampler_proc = None

    if args.scenario:
        import threading  # noqa: PLC0415

        def scenario_thread():
            base = f"http://127.0.0.1:{args.port}"
            health = ms.wait_health(base)
            print(f"[scn] health={health}", flush=True)
            w = ms.set_window(proc.pid, "visible")
            print(f"[scn] set_window={w}", flush=True)
            time.sleep(2)
            sampler_out = Path(str(data_dir) + "-sampler.jsonl")
            sampler_proc_cmd = [
                "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(ms.SAMPLER),
                "-Out", str(sampler_out),
                "-IntervalSec", "5",
                "-DurationSec", str(args.seconds + 15),
                "-Base", base,
                "-Token", token,
                "-ProcessNamePattern", "^" + re.escape(exe.stem),
            ]
            print(f"[scn] 启动采样器", flush=True)
            subprocess.Popen(
                sampler_proc_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(6)
            print(f"[scn] 运行 node 负载探针", flush=True)
            probe_out = Path(str(data_dir) + "-load.json")
            probe = subprocess.run(
                [
                    "node", str(ms.PROBE),
                    "--base", base,
                    "--token", token,
                    "--mode", "running",
                    "--agents", "4",
                    "--rate", "5",
                    "--duration", "0",
                    "--batch", "1",
                    "--run-id", f"fx-{int(time.time())}",
                    "--source", "bridge",
                    "--allow-real-source",
                    "--transport", "http",
                    "--inbox", str(data_dir / "agent-inbox"),
                    "--out", str(probe_out),
                ],
                capture_output=True,
                text=True,
                timeout=300,
                errors="replace",
            )
            print(f"[scn] probe rc={probe.returncode} {probe.stderr[-300:]}", flush=True)
            print(f"[scn] stats={ms.http_json(base + '/api/v1/stats', token)}", flush=True)

        th = threading.Thread(target=scenario_thread, daemon=True)
        th.start()

    while time.time() - t0 < args.seconds:
        alive = proc.poll() is None
        now = time.time() - t0
        if args.tray_quit_at and now >= args.tray_quit_at and not args.tray_quit_at == -1:
            args.tray_quit_at = -1
            print(f"[{now:6.1f}s] 执行托盘退出自动化", flush=True)
            q = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    args.tray_quit_script,
                ],
                capture_output=True,
                text=True,
                timeout=120,
                errors="replace",
            )
            print(f"[{now:6.1f}s] 托盘脚本输出: {(q.stdout or '').strip()[-300:]}", flush=True)
        if alive:
            for w in top_windows(proc.pid):
                h = w["hwnd"]
                if h not in known:
                    known[h] = w
                    print(
                        f"[{now:6.1f}s] 新窗口 hwnd=0x{h:x} visible={w['visible']} tool={w['tool']}",
                        flush=True,
                    )
                else:
                    known[h] = w
            gone = [h for h in known if not user32.IsWindow(h)]
            for h in gone:
                print(f"[{now:6.1f}s] 窗口失效 hwnd=0x{h:x}", flush=True)
                known.pop(h, None)
            if args.restore and not restored and known:
                main_hwnd = next(
                    (h for h, w in known.items() if not w["tool"] and w["visible"]), None
                )
                if main_hwnd is not None:
                    user32.ShowWindow(main_hwnd, SW_RESTORE)
                    print(f"[{now:6.1f}s] 已对主窗口执行 ShowWindow(SW_RESTORE) 0x{main_hwnd:x}", flush=True)
                    restored = True
        else:
            exit_info = {
                "exited_after_s": round(now, 1),
                "exit_code": proc.returncode,
                "shutdown_report": (data_dir / "last-shutdown-report.json").exists(),
            }
            print(f"[{now:6.1f}s] 进程退出 {json.dumps(exit_info)}", flush=True)
            break
        time.sleep(0.25)

    if exit_info is None:
        print(f"[{time.time()-t0:6.1f}s] 观察窗口结束，进程仍存活", flush=True)
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        verdict = "SURVIVED"
    else:
        if exit_info["shutdown_report"]:
            verdict = "GRACEFUL_REQUEST_EXIT"
        else:
            verdict = "EXTERNAL_KILL"
        print(f"[verdict] {verdict}", flush=True)

    print(f"[log] {log_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
