"""P1-03 真实图文混合粘贴验收（Windows GUI / 像素级）。

流程：
1. 用隔离数据目录启动 Release 版 Task Dock（WebView2 CDP 9417）。
2. 在安全测试页面上复制 红图A、绿图B、文字C、蓝图D；图片同时提供
   CF_DIB（32bpp、Alpha 全 0）与 Alpha 全 0 的 PNG，复现 Windows 合成
   PNG 丢失 Alpha 的真实场景。
3. 通过真实命令 clipboard_create_group / clipboard_paste_group 粘贴到
   Edge 的 contenteditable 测试页。
4. 在 Edge 内用 canvas.getImageData() 读取实际像素，验证数量/顺序/
   尺寸/RGB/Alpha/可见性/重复；再验证剪贴板恢复、历史条数、copy_count
   与自写记录。

所有内容均为合成数据，不读取也不写入用户私人剪贴板之外的任何内容。
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.wintypes
import hashlib
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

import win32api
import win32clipboard
import win32con
import win32gui
import win32process
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EXE = ROOT / "src-tauri" / "target" / "release" / "task-dock.exe"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
# 默认调试端口；上一轮残留的 WebView 进程可能仍在监听，实际使用前必须实测占用情况
APP_CDP = 9417
EDGE_CDP = 9418


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", port)) != 0


def port_listener(port: int) -> list[str]:
    """记录「谁在监听这个端口」，用于把 CDP 失败如实归因，而不是含糊重试。"""
    result = subprocess.run(
        ["netstat", "-ano", "-p", "TCP"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=NO_WINDOW,
    )
    listeners = []
    for line in (result.stdout or "").splitlines():
        if f":{port}" in line and "LISTENING" in line:
            listeners.append(line.strip())
    return listeners


def reserve_port(preferred: int) -> int:
    """CDP 端口被别的实例占用时，连上的就不是本次隔离实例——必须换用空闲端口。"""
    if port_is_free(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
WIDTH, HEIGHT = 240, 160
COLORS = {
    "A-red": (220, 30, 30),
    "B-green": (30, 180, 60),
    "D-blue": (30, 60, 220),
}
TEXT_C = "MIXED-TEXT-C-7f3a9d-图文混合粘贴"
# 用于把本次验收写入的文本与并行外部复制区分开（只比对局部标记，不记录内容）
TEXT_MARKER = "MIXED-TEXT-C-7f3a9d"
assert TEXT_MARKER in TEXT_C
# 粘贴前哨兵：与分组里的任何一项都不同，才能证明「恢复」真的把粘贴前内容写了回去。
# 若不设哨兵，粘贴基线就是最后一项 D-blue，剪贴板结束时是 D-blue 既可能是恢复成功，
# 也可能是任务把第 4 项留在原地——两种结果无法区分。
SENTINEL_TEXT = "PASTE-BASELINE-SENTINEL-4d71be-粘贴前哨兵"
SENTINEL_MARKER = "PASTE-BASELINE-SENTINEL-4d71be"
OUR_TEXT_MARKERS = (TEXT_MARKER, SENTINEL_MARKER)
# 本脚本自己向剪贴板写了几次：用于把「全局序列号增长」拆成自写与外部写入，
# 多出历史条目只有在确实存在等量外部写入时才允许解释成环境噪声。
OWN_CLIPBOARD_WRITES = {"count": 0}

pass_checks: list[dict] = []
fail_checks: list[dict] = []
# 既不算通过也不算产品缺陷的断言：本机剪贴板是全局共享资源，被并行复制污染的
# 断言如实记在这里（附证据），绝不折算成 PASS，也绝不冒充产品失败。
blocked_checks: list[dict] = []

# 辅助进程（netstat/powershell/node/taskkill）一律不弹控制台窗口
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def check(name: str, ok: bool, detail=None) -> None:
    entry = {"name": name, "ok": bool(ok), "detail": detail}
    (pass_checks if ok else fail_checks).append(entry)
    print(("PASS " if ok else "FAIL ") + name + ("" if detail is None else f" :: {detail}"))


def check_blocked(name: str, reason: str, detail=None) -> None:
    """断言无法在本机判定：如实记为 BLOCKED，不判产品失败，也不写成通过。"""
    entry = {"name": name, "ok": None, "reason": reason, "detail": detail}
    blocked_checks.append(entry)
    print(f"BLOCKED {name} :: {reason}" + ("" if detail is None else f" :: {detail}"))


def http_json(url: str, timeout: float = 1.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_http(url: str, timeout: float) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            return http_json(url)
        except Exception as exc:  # noqa: BLE001 - 环境探测
            last = exc
            time.sleep(0.25)
    raise RuntimeError(f"等待 CDP 超时: {url}: {last}")


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
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"CDP 桥输出非 JSON: {out[:500]}") from exc


APP_PROC: subprocess.Popen | None = None
CDP_DIAGNOSTICS: list[dict] = []
APP_LOG: Path | None = None


def app_log_tail(limit: int = 4000) -> str:
    if APP_LOG is None or not APP_LOG.is_file():
        return ""
    return APP_LOG.read_bytes()[-limit:].decode("utf-8", "replace")


def invoke(command: str, args: dict | None = None, timeout: float = 60.0, attempts: int = 8):
    """CDP 桥重试包装。

    WebView2 调试端点在窗口重建/进程刚起时会短暂拒绝连接；这里不吞错误，
    而是重试并在最终失败时把「本次应用进程是否还活着 + 谁在监听端口」写进
    诊断，让失败能如实归因（实例已退出 / 端口被别的实例占用 / 命令本身报错）。
    """
    last: Exception | None = None
    for _ in range(attempts):
        try:
            result = node_bridge(
                "invoke",
                APP_CDP,
                command,
                json.dumps(args or {}, ensure_ascii=False),
                timeout=timeout,
            )
            if result.get("ok"):
                return result.get("value")
            last = RuntimeError(str(result.get("error")))
        except Exception as exc:  # noqa: BLE001 - 传输层抖动
            last = exc
        time.sleep(0.75)
    diag = {
        "command": command,
        "error": str(last),
        "app_alive": bool(APP_PROC and APP_PROC.poll() is None),
        "app_exit_code": APP_PROC.poll() if APP_PROC else None,
        "cdp_port": APP_CDP,
        "port_listeners": port_listener(APP_CDP),
    }
    CDP_DIAGNOSTICS.append(diag)
    if not diag["app_alive"]:
        # 隔离实例中途消失：必须区分「产品自己 panic」与「被第三方进程终止」。
        # 本机存在会批量 Stop-Process task-dock 的验收脚本（native-verify.ps1 旧版），
        # 把第三方击杀记成产品缺陷同样是伪造验收。
        tail = app_log_tail()
        if "panicked" in tail:
            raise RuntimeError(
                f"隔离实例 panic 退出（exit={diag['app_exit_code']}，命令={command}），日志尾部：{tail[-400:]}"
            )
        raise EnvironmentBlocked(
            f"隔离实例在 {command} 期间被外部终止（exit={diag['app_exit_code']}，日志无 panic）："
            "本机有其他流程在批量结束 task-dock 实例，本次真实 GUI 验收无法继续；"
            "请独占实例后重跑（不据此判定产品行为）"
        )
    raise RuntimeError(f"{command} 调用失败（重试 {attempts} 次）: {last} :: {diag}")


def wait_app_ready(timeout: float = 60.0) -> dict:
    wait_http(f"http://127.0.0.1:{APP_CDP}/json/version", timeout)
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        if APP_PROC is not None and APP_PROC.poll() is not None:
            # Single Instance 插件让第二个实例「静默秒退」：日志为空 + 退出码 0/-1
            raise RuntimeError(
                f"Task Dock 实例已退出（exit={APP_PROC.poll()}）：极可能是已有其他实例占用 Single Instance 锁"
            )
        try:
            status = invoke("clipboard_status", timeout=15)
            if status.get("monitoring") and status.get("configError") is None:
                return status
            last = status
        except Exception as exc:  # noqa: BLE001 - WebView 初始化期
            last = str(exc)
        time.sleep(0.4)
    raise RuntimeError(f"Task Dock 未就绪: {last}")


def open_clipboard() -> None:
    for _ in range(100):
        try:
            win32clipboard.OpenClipboard()
            return
        except Exception:  # noqa: BLE001 - 剪贴板被监听线程短暂占用
            time.sleep(0.03)
    raise RuntimeError("无法打开剪贴板")


def set_image_clipboard(png: bytes, dib: bytes) -> None:
    png_fmt = win32clipboard.RegisterClipboardFormat("PNG")
    open_clipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32con.CF_DIB, dib)
        win32clipboard.SetClipboardData(png_fmt, png)
    finally:
        win32clipboard.CloseClipboard()
    OWN_CLIPBOARD_WRITES["count"] += 1


def set_text_clipboard(text: str) -> None:
    open_clipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, text)
    finally:
        win32clipboard.CloseClipboard()
    OWN_CLIPBOARD_WRITES["count"] += 1


def clipboard_png_bytes() -> tuple[bytes | None, str]:
    png_fmt = win32clipboard.RegisterClipboardFormat("PNG")
    open_clipboard()
    try:
        if win32clipboard.IsClipboardFormatAvailable(png_fmt):
            data = win32clipboard.GetClipboardData(png_fmt)
            if isinstance(data, str):
                data = data.encode("latin-1", "ignore")
            return bytes(data), "PNG"
        if win32clipboard.IsClipboardFormatAvailable(win32con.CF_DIB):
            data = win32clipboard.GetClipboardData(win32con.CF_DIB)
            if isinstance(data, str):
                data = data.encode("latin-1", "ignore")
            return bytes(data), "CF_DIB"
        return None, "none"
    finally:
        win32clipboard.CloseClipboard()


def clipboard_text() -> str | None:
    open_clipboard()
    try:
        if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
            return win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
        return None
    finally:
        win32clipboard.CloseClipboard()


def make_png(rgb: tuple[int, int, int]) -> bytes:
    image = Image.new("RGBA", (WIDTH, HEIGHT), (rgb[0], rgb[1], rgb[2], 0))
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def make_dib_bi_rgb(rgb: tuple[int, int, int]) -> bytes:
    header = struct.pack(
        "<IiiHHIIiiII",
        40,
        WIDTH,
        HEIGHT,
        1,
        32,
        0,
        WIDTH * HEIGHT * 4,
        2835,
        2835,
        0,
        0,
    )
    row = b"".join(struct.pack("<BBBB", rgb[2], rgb[1], rgb[0], 0) for _ in range(WIDTH))
    return header + row * HEIGHT


def make_dib_bitfields(rgb: tuple[int, int, int]) -> bytes:
    header = struct.pack(
        "<IiiHHIIiiII",
        108,
        WIDTH,
        HEIGHT,
        1,
        32,
        3,
        WIDTH * HEIGHT * 4,
        2835,
        2835,
        0,
        0,
    )
    masks = struct.pack("<IIII", 0x00FF0000, 0x0000FF00, 0x000000FF, 0x00000000)
    v4_rest = struct.pack("<I", 0) + b"\x00" * 36 + struct.pack("<III", 0, 0, 0)
    row = b"".join(struct.pack("<BBBB", rgb[2], rgb[1], rgb[0], 0) for _ in range(WIDTH))
    return header + masks + v4_rest + row * HEIGHT


def decode_png(data: bytes) -> dict:
    image = Image.open(io.BytesIO(data)).convert("RGBA")
    width, height = image.size
    pixels = image.load()
    samples = {
        "center": list(pixels[width // 2, height // 2]),
        "topLeft": list(pixels[2, 2]),
        "bottomRight": list(pixels[width - 3, height - 3]),
    }
    alpha_values = [pixels[x, y][3] for x in range(width) for y in range(height)]
    rgb_sum = [0, 0, 0]
    rgb_sum_all = [0, 0, 0]
    total = width * height
    opaque = 0
    for x in range(width):
        for y in range(height):
            r, g, b, a = pixels[x, y]
            rgb_sum_all[0] += r
            rgb_sum_all[1] += g
            rgb_sum_all[2] += b
            if a:
                rgb_sum[0] += r
                rgb_sum[1] += g
                rgb_sum[2] += b
                opaque += 1
    # Windows 用同源 32bpp CF_DIB 合成出的「PNG」容器 Alpha 全为 0（通道未被使用），
    # 按与产品一致的规则：全 0 视为未使用 → 颜色仍按不透明判定；任一非 0 是真实透明信息。
    alpha_unused = total > 0 and all(a == 0 for a in alpha_values)
    return {
        "width": width,
        "height": height,
        "alphaMin": min(alpha_values),
        "alphaMax": max(alpha_values),
        "alphaChannelUnused": alpha_unused,
        "transparentPixels": sum(1 for a in alpha_values if a == 0),
        "opaquePixels": opaque,
        "avgRgb": ([round(v / total) for v in rgb_sum_all] if alpha_unused
                   else ([round(v / opaque) for v in rgb_sum] if opaque else None)),
        "samples": samples,
    }


def data_url_bytes(url: str) -> bytes:
    if "," not in url:
        raise ValueError("data URL 格式异常")
    return base64.b64decode(url.split(",", 1)[1])


def view_items() -> list[dict]:
    view = invoke("clipboard_view", {"filter": {"favorite": False, "limit": 100}})
    return view["items"]


def sanitize_items(items: list[dict]) -> list[dict]:
    """证据只保留结构字段，绝不写入 preview/text/source_app/source_title 等用户内容。"""
    return [
        {
            "id": item["id"],
            "kind": item["kind"],
            "byte_size": item["byte_size"],
            "image_width": item["image_width"],
            "image_height": item["image_height"],
            "copy_count": item["copy_count"],
            "created_at": item["created_at"],
            "last_seen_at": item["last_seen_at"],
            "has_image": item["has_image"],
        }
        for item in items
    ]


def wait_item_count(expected_min: int, timeout: float = 10.0) -> list[dict]:
    deadline = time.time() + timeout
    items: list[dict] = []
    while time.time() < deadline:
        items = view_items()
        if len(items) >= expected_min:
            return items
        time.sleep(0.2)
    return items


def find_window(title_part: str, timeout: float = 30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = []

        def enum(hwnd, _):
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd)
            if title_part in title:
                found.append((hwnd, title, win32gui.GetClassName(hwnd)))

        win32gui.EnumWindows(enum, None)
        for item in found:
            return item
        time.sleep(0.25)
    return None


def foreground_window(hwnd: int) -> bool:
    """置前目标窗口。

    后台进程直接 SetForegroundWindow 会被 Windows 前台锁拒绝；产品自身用的就是
    「先按一次 Alt 再重试」这一系统允许的惯用法，验收沿用同一手法，
    不绕过锁屏或安全桌面（那类情况由 interactive_desktop() 判环境）。
    """
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001 - 前台锁
        pass
    time.sleep(0.15)
    if win32gui.GetForegroundWindow() == hwnd:
        return True
    user32 = ctypes.windll.user32
    user32.keybd_event(0x12, 0, 0, 0)  # VK_MENU down
    user32.keybd_event(0x12, 0, 0x0002, 0)  # VK_MENU up
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001 - 前台锁
        return False
    time.sleep(0.2)
    return win32gui.GetForegroundWindow() == hwnd


def minimize_windows_of(pid: int) -> list[int]:
    """最小化本次隔离实例自己的窗口。

    采集侧按前台窗口进程判定来源：Task Dock 自己的窗口在前台时，这次复制会被正确地
    判为「来源是 Task Dock 自身」并跳过入库。真实用户是在别的应用里复制，
    所以验收先把本实例窗口收下去，让来源保持为外部应用。
    """
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


def monitor_stats() -> dict:
    return invoke("clipboard_status")["monitor"]


MONITOR_DELTA_KEYS = (
    "observed_events",
    "captured",
    "recorded",
    "duplicates",
    "skipped",
    "dropped_events",
    "dropped_contents",
    "failed",
)


def foreground_source_exe() -> str:
    """当前前台窗口的进程可执行文件名——采集侧的「来源应用」就是按它推断的。

    Task Dock 自己的窗口在前台时，产品把这次复制判为「来源是 Task Dock 自身」
    并跳过入库（这是正确的自写抑制）。所以合成复制必须在别的应用前台时进行，
    否则测到的是抑制分支，而不是要验收的采集链路。
    """
    hwnd = win32gui.GetForegroundWindow()
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x00001000, 0, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = ctypes.wintypes.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value).lower()
        return ""
    finally:
        kernel32.CloseHandle(handle)


class EnvironmentBlocked(RuntimeError):
    """环境前置条件不成立：如实上报，既不把外部干扰算成产品缺陷，也不装作没看到。"""


def clipboard_sequence() -> int:
    return int(ctypes.windll.user32.GetClipboardSequenceNumber())


def clipboard_quiet_window(quiet_for_s: float = 6.0, max_wait_s: float = 180.0) -> dict:
    """等到「没有任何进程改动剪贴板」的安静窗口，并如实记录期间的外部写入次数。

    本机同时有并行会话在批量真实复制（截图/文件/HTML/文本混在一起，一次几秒内十几条）。
    全局历史条数、粘贴期间零新增、粘贴后剪贴板内容这类断言只有在剪贴板安静时才成立；
    不安静就判环境不满足，而不是把外部流量算成产品缺陷。
    """
    begin = time.time()
    deadline = begin + max_wait_s
    seq = clipboard_sequence()
    start_seq = seq
    changes = 0
    quiet_since = begin
    while time.time() < deadline:
        time.sleep(0.5)
        now = clipboard_sequence()
        if now != seq:
            changes += 1
            seq = now
            quiet_since = time.time()
        elif time.time() - quiet_since >= quiet_for_s:
            return {
                "quiet": True,
                "external_changes": changes,
                "waited_s": round(time.time() - begin, 1),
                "sequence_start": start_seq,
                "sequence_now": seq,
            }
    return {
        "quiet": False,
        "external_changes": changes,
        "waited_s": round(time.time() - begin, 1),
        "sequence_start": start_seq,
        "sequence_now": seq,
    }


def clipboard_still_baseline(quiet_sequence: int | None = None) -> dict:
    """守卫报「被其他程序更新」时，剪贴板是否仍是验收自己写入的那份基线。

    两路独立证据，任一成立即判定「没有外部接管」，产品停写只能是自己内容判定出错，
    这种情况必须照实 FAIL，绝不能记成「环境不安静」：
    - 全局剪贴板序列号与安静窗口结束时完全一致 → 这段时间根本没有第二次写入
      （守卫失败发生在写入之前，本任务自己也没写）；
    - 可见内容仍是粘贴前哨兵（或最后一张自写图 D-blue）→ 不比容器字节，Windows
      会用同源 CF_DIB 重新合成 PNG 容器，容器字节本来就会变。
    """
    sample = clipboard_content_sample()
    now_seq = sample.get("sequence")
    seq_frozen = quiet_sequence is not None and now_seq == quiet_sequence
    still_sentinel = bool((sample.get("text") or {}).get("is_sentinel"))
    still_last_image = (
        sample.get("color") == "D-blue" and sample.get("size") == [WIDTH, HEIGHT]
    )
    return {
        **sample,
        "sequence_at_quiet_window_end": quiet_sequence,
        "sequence_frozen_since_quiet": seq_frozen,
        "still_sentinel": still_sentinel,
        "still_last_our_image": still_last_image,
        "still_ours": seq_frozen or still_sentinel or still_last_image,
    }


def text_probe() -> dict:
    """剪贴板文本只记录判定所需的结构信息，绝不把用户正文写进证据。"""
    raw = clipboard_text()
    if raw is None:
        return {"has_text": False}
    return {
        "has_text": True,
        "length": len(raw),
        "markers": [m for m in OUR_TEXT_MARKERS if m in raw],
        "is_sentinel": SENTINEL_MARKER in raw,
        "is_our_text": TEXT_MARKER in raw,
        "sha256_12": hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:12],
    }


def clipboard_content_sample() -> dict:
    """一次剪贴板内容采样：按可见内容判定，容器编码差异不算换内容。"""
    raw, kind = clipboard_png_bytes()
    sample = {"sequence": clipboard_sequence(), "format": kind, "color": None, "size": None}
    if raw and kind == "PNG":
        try:
            decoded = decode_png(raw)
            sample["color"] = matched_color(decoded)
            sample["size"] = [decoded["width"], decoded["height"]]
            sample["alpha_container"] = [decoded.get("alphaMin"), decoded.get("alphaMax")]
            sample["alpha_channel_unused"] = decoded.get("alphaChannelUnused")
        except Exception as exc:  # noqa: BLE001 - 容器异常时仍要留下文本判定
            sample["decode_error"] = str(exc)
    elif raw:
        sample["bytes"] = len(raw)
    # 文本与图片可能同时在剪贴板上（不同格式），两边都采到才能判定内容归属。
    sample["text"] = text_probe()
    return sample


def sample_is_ours(sample: dict) -> bool:
    """采样内容是否属于本次验收自己写入的四张图/两条文本之一。"""
    if sample.get("color") in COLORS:
        return True
    text = sample.get("text") or {}
    return bool(text.get("markers"))


def clipboard_samples_at_completion(window_s: float = 0.8, step_s: float = 0.06) -> list[dict]:
    """任务结束的瞬间连续采样，抢在外部复制之前拿到「恢复后的那一刻」。

    本机剪贴板是全局共享资源：验收结束时任何一次 sleep/命令都可能让别的程序
    覆盖它，事后单点读取无法证明产品有没有恢复。密集采样把观测窗口压到亚秒级。
    """
    deadline = time.time() + window_s
    samples = []
    while True:
        samples.append(clipboard_content_sample())
        if time.time() >= deadline:
            return samples
        time.sleep(step_s)


def image_signature(item_id: str) -> dict | None:
    """按 id 解码入库图片，只返回判定所需的最小信息（尺寸/颜色/Alpha）。"""
    url = invoke("clipboard_image", {"itemId": item_id})
    if not url:
        return None
    try:
        decoded = decode_png(data_url_bytes(url))
    except Exception as exc:  # noqa: BLE001 - 无关条目解析失败只影响归类，不参与判定
        return {"error": type(exc).__name__}
    decoded["id"] = item_id
    return decoded


def is_our_image(sig: dict | None, color_name: str | None = None) -> bool:
    """尺寸必须与本次合成图完全一致，颜色在 ±3 内；外部截图/杂图不可能命中。"""
    if not sig or sig.get("width") != WIDTH or sig.get("height") != HEIGHT:
        return False
    if color_name is not None:
        return matched_color(sig) == color_name
    return matched_color(sig) is not None


def matched_color(decoded: dict | None) -> str | None:
    if not decoded or not decoded.get("avgRgb"):
        return None
    return next(
        (
            name
            for name, rgb in COLORS.items()
            if all(abs(a - b) <= 3 for a, b in zip(decoded["avgRgb"], rgb))
        ),
        None,
    )


def existing_instances() -> tuple[list[int], str | None]:
    """Single Instance 插件会让第二个实例直接退出，启动前必须先确认没有别的实例。

    用 tasklist（快、无 PowerShell 依赖）。探测本身失败时返回 error，
    让调用方按「无法确认」处理——不能把「没查到」当成「没有实例」。
    """
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq task-dock.exe", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=NO_WINDOW,
    )
    if result.returncode != 0:
        return [], f"tasklist 失败（exit={result.returncode}）: {result.stderr[:200]}"
    pids = []
    for line in (result.stdout or "").splitlines():
        cols = [c.strip('"') for c in line.split('","')]
        if len(cols) >= 2 and cols[0].lower() == "task-dock.exe" and cols[1].isdigit():
            pids.append(int(cols[1]))
    return pids, None


def wait_clear_window(wait_s: float = 180.0, quiet_rounds: int = 2) -> tuple[list[int], str | None, float]:
    """并行会话随时可能拉起自己的 Task Dock 实例（Single Instance 会让隔离实例秒退）。

    等到「连续 quiet_rounds 次都没有别的实例」才算窗口干净；超时则把最后一次
    观测交给调用方判定为环境阻塞——不能靠运气跑验收，也不能凭空归因。
    """
    deadline = time.time() + wait_s
    quiet = 0
    pids, probe_error = [], None
    while time.time() < deadline:
        pids, probe_error = existing_instances()
        if probe_error or pids:
            quiet = 0
        else:
            quiet += 1
            if quiet >= quiet_rounds:
                return pids, probe_error, wait_s - (deadline - time.time())
        time.sleep(3.0)
    return pids, probe_error, wait_s


def interactive_desktop() -> dict:
    """锁屏/安全桌面下真实按键无法送达目标窗口，必须如实判定为环境阻塞。"""
    user32 = ctypes.windll.user32
    handle = user32.OpenInputDesktop(0, False, 0x0100)  # DESKTOP_READOBJECTS
    info = {
        "input_desktop": bool(handle),
        "desktop_name": None,
        "foreground_hwnd": user32.GetForegroundWindow(),
    }
    if handle:
        buf = ctypes.create_unicode_buffer(256)
        needed = ctypes.wintypes.DWORD(0)
        if ctypes.windll.user32.GetUserObjectInformationW(
            handle, 2, buf, ctypes.sizeof(buf), ctypes.byref(needed)
        ):
            info["desktop_name"] = buf.value
        ctypes.windll.user32.CloseDesktop(handle)
    return info


def main() -> int:
    global APP_CDP, EDGE_CDP, APP_PROC, APP_LOG
    # 证据日志统一 UTF-8：Git Bash 下默认 cp936 会让中文证据变成乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - 老 stdout 包装不可重配置时保持原样
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", default=str(DEFAULT_EXE))
    parser.add_argument("--out-dir", default=str(ROOT / "docs" / "clipboard" / "evidence"))
    parser.add_argument("--keep", action="store_true")
    parser.add_argument(
        "--wait-clear-s",
        type=float,
        default=180.0,
        help="等待没有其他 Task Dock 实例的最长秒数（并行会话随时会抢占 Single Instance 锁）",
    )
    parser.add_argument(
        "--quiet-s",
        type=float,
        default=6.0,
        help="剪贴板需要连续安静多少秒才允许开始合成复制/粘贴（外部写入会让全局条数类断言失效）",
    )
    parser.add_argument(
        "--quiet-wait-s",
        type=float,
        default=240.0,
        help="等待上述安静窗口的最长秒数，超时即判环境不满足",
    )
    args = parser.parse_args()

    exe = Path(args.exe)
    if not exe.is_file():
        print(f"缺少 Release 可执行文件: {exe}", file=sys.stderr)
        return 3
    app_exe_name = exe.name.lower()
    if not EDGE.is_file():
        print(f"缺少 Edge: {EDGE}", file=sys.stderr)
        return 3

    desktop = interactive_desktop()
    preexisting, probe_error, waited = wait_clear_window(args.wait_clear_s)
    blocked = []
    if not desktop["input_desktop"] or desktop.get("desktop_name") not in (None, "Default"):
        blocked.append(f"输入桌面不可用（desktop={desktop.get('desktop_name')}）：疑似锁屏/安全桌面")
    if probe_error:
        blocked.append(f"无法确认既有实例（{probe_error}）：不能把「查不到」当作「没有实例」")
    if preexisting:
        blocked.append(
            f"等待 {waited:.0f}s 后仍存在 Task Dock 实例 {preexisting}：Single Instance 会阻止隔离实例启动"
        )
    if blocked:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        record = {
            "name": "P1-03 mixed image/text paste acceptance",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "overall": "ENVIRONMENT BLOCKED",
            "reasons": blocked,
            "desktop": desktop,
            "preexisting_instances": preexisting,
            "waited_for_clear_window_s": round(waited, 1),
            "checks": {"pass": [], "fail": []},
        }
        path = out_dir / f"p1-03-mixed-paste-blocked-{stamp}.json"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print("ENVIRONMENT BLOCKED: " + "; ".join(blocked), file=sys.stderr)
        print(f"EVIDENCE {path}")
        return 3

    # CDP 端口被上一轮残留 WebView 占用时，连上的可能不是本次实例
    stale_app_listeners = port_listener(APP_CDP)
    APP_CDP = reserve_port(APP_CDP)
    EDGE_CDP = reserve_port(EDGE_CDP)

    nonce = uuid.uuid4().hex[:8]
    work = Path(tempfile.mkdtemp(prefix="taskdock-p1-03-"))
    data_dir = work / "data"
    edge_profile = work / "edge-profile"
    data_dir.mkdir(parents=True, exist_ok=True)
    edge_profile.mkdir(parents=True, exist_ok=True)
    title_token = f"TaskDock Paste Acceptance {nonce}"
    html_path = work / "paste-target.html"
    html_path.write_text(
        f"""<!doctype html>
<meta charset="utf-8">
<title>{title_token}</title>
<style>
  html, body {{ background: #fff; color: #111; font: 16px/1.5 sans-serif; }}
  #editor {{ width: 900px; min-height: 500px; border: 2px solid #333; padding: 12px; outline: none; }}
  #editor img {{ max-width: 100%; }}
</style>
<div id="editor" contenteditable="true"></div>
<script>
  const editor = document.querySelector('#editor');
  function focusEditor() {{ editor.focus(); }}
  window.addEventListener('focus', focusEditor);
  focusEditor();
  window.__acceptance = {{ editor, focusEditor }};
</script>
""",
        encoding="utf-8",
    )

    app_log = open(work / "app.log", "w", encoding="utf-8")
    edge_log = open(work / "edge.log", "w", encoding="utf-8")
    APP_LOG = work / "app.log"
    app = None
    edge = None
    evidence: dict = {
        "name": "P1-03 mixed image/text paste acceptance",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "nonce": nonce,
        "environment": {
            "exe": str(exe),
            "exe_mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(exe.stat().st_mtime)),
            "edge": str(EDGE),
            "screen": [win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)],
            "desktop": desktop,
            "preexisting_instances": preexisting,
            "waited_for_clear_window_s": round(waited, 1),
            "work_dir": str(work),
            "app_cdp": APP_CDP,
            "edge_cdp": EDGE_CDP,
            "default_app_cdp_stale_listeners": stale_app_listeners,
        },
        "checks": {"pass": pass_checks, "fail": fail_checks, "blocked": blocked_checks},
    }

    try:
        env = os.environ.copy()
        env["TASK_DOCK_DATA_DIR"] = str(data_dir)
        env["WEBVIEW2_USER_DATA_FOLDER"] = str(work / "webview2")
        env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={APP_CDP}"
        # 采集跳过原因只写在 debug 级：没有它就分不清「没收到剪贴板变更」和
        # 「收到但被过滤」。日志只含计数/原因，绝不含剪贴板正文。
        env["RUST_LOG"] = "info,task_dock_lib::clipboard=debug"
        app = subprocess.Popen(
            [str(exe)],
            cwd=str(ROOT),
            env=env,
            stdout=app_log,
            stderr=subprocess.STDOUT,
        )
        APP_PROC = app
        status = wait_app_ready()
        evidence["app_status_initial"] = status
        check("应用以隔离数据目录启动并处于监听状态", status.get("monitoring") is True, status.get("configOrigin"))
        check("剪贴板配置无异常", status.get("configError") is None, status.get("configError"))
        # CDP 连上的必须是本次启动的隔离实例：数据目录路径是唯一身份凭据
        inbox_dir = str(invoke("get_agent_inbox_dir"))
        same_instance = os.path.normcase(inbox_dir).startswith(os.path.normcase(str(data_dir)))
        evidence["instance_identity"] = {"agent_inbox_dir": inbox_dir, "data_dir": str(data_dir)}
        check("CDP 目标即本次隔离实例（Agent 收件目录在隔离数据目录内）", same_instance, inbox_dir)

        # 真实用户是在别的应用里复制：先把本实例自己的窗口收下去，
        # 否则复制来源会被正确地判成「Task Dock 自身」，采不到东西。
        own_minimized = minimize_windows_of(app.pid)
        evidence["own_windows_minimized"] = {"pid": app.pid, "hwnds": own_minimized}

        # 安全测试页必须在「合成复制」之前打开并拿到前台：
        # 采集侧按前台窗口进程判定来源，Task Dock 自己的窗口在前台时这次复制会被
        # 判为「来源是 Task Dock 自身」并跳过入库。那是正确的自写抑制分支，
        # 不是本次要验收的采集链路（上一轮 4 次复制全部 skipped 就是这个原因）。
        edge = subprocess.Popen(
            [
                str(EDGE),
                f"--remote-debugging-port={EDGE_CDP}",
                f"--user-data-dir={edge_profile}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-features=msEdgeFirstRunExperience",
                "--new-window",
                html_path.as_uri(),
            ],
            stdout=edge_log,
            stderr=subprocess.STDOUT,
        )
        wait_http(f"http://127.0.0.1:{EDGE_CDP}/json/version", 30)
        found = find_window(title_token, timeout=30)
        check("安全测试窗口已出现", found is not None, None if not found else found[1])
        if not found:
            raise RuntimeError("未找到安全测试窗口")
        hwnd, title, class_name = found
        _, target_pid = win32process.GetWindowThreadProcessId(hwnd)
        evidence["target_window"] = {"hwnd": hwnd, "pid": target_pid, "title": title, "class": class_name}

        def ensure_target_foreground(step: str) -> dict:
            """把合成复制时的前台固定在测试页上，并如实记录每次观测到的来源。

            这里只是把用户本来就会有的「目标应用在前台复制」复原出来，
            不绕过任何系统前台锁：置前失败就照实记录 blocked_by_own_foreground。
            """
            source = foreground_source_exe()
            for _ in range(3):
                if source and source != app_exe_name:
                    break
                if not foreground_window(hwnd):
                    break
                source = foreground_source_exe()
            info = {
                "step": step,
                "foreground_source": source,
                "foreground_hwnd": win32gui.GetForegroundWindow(),
                "target_hwnd": hwnd,
            }
            if source == app_exe_name or not source:
                info["blocked_by_own_foreground"] = True
            return info

        pre_copy_focus = ensure_target_foreground("before-copies")
        evidence["foreground_before_copies"] = pre_copy_focus
        check(
            "复制阶段前台为外部应用（否则命中自写抑制、测不到采集链路）",
            not pre_copy_focus.get("blocked_by_own_foreground"),
            pre_copy_focus,
        )
        if pre_copy_focus.get("blocked_by_own_foreground"):
            raise RuntimeError(
                "复制阶段前台仍是 Task Dock 自身/无法确认（"
                f"source={pre_copy_focus['foreground_source']!r}, hwnd={pre_copy_focus['foreground_hwnd']}）："
                "这次复制会被产品按自写抑制跳过，继续跑只会得到假失败，必须如实终止"
            )

        click = node_bridge("edge-click", EDGE_CDP, title_token, timeout=30)
        check("测试页编辑器已聚焦", click.get("ok") and click.get("activeId") == "editor", click)

        quiet_before = clipboard_quiet_window(quiet_for_s=4.0, max_wait_s=90.0)
        evidence["clipboard_quiet_before_copies"] = quiet_before
        if not quiet_before["quiet"]:
            raise EnvironmentBlocked(
                f"剪贴板在 {quiet_before['waited_s']}s 内没有出现 4s 安静窗口"
                f"（外部改动 {quiet_before['external_changes']} 次）：本机有其他进程正在复制，"
                "全局历史条数这类断言无法把外部流量与产品采集分开。"
                "请独占剪贴板后重跑（不要并行运行 TD_REAL_CLIPBOARD 真机套件）"
            )

        baseline_items = view_items()
        baseline_seq = clipboard_sequence()
        evidence["baseline_items"] = len(baseline_items)
        evidence["baseline_clipboard_sequence"] = baseline_seq

        sources = {
            "A-red": {"png": make_png(COLORS["A-red"]), "dib": make_dib_bi_rgb(COLORS["A-red"]), "formats": ["PNG(alpha=0)", "CF_DIB 32bpp BI_RGB(alpha=0)"]},
            "B-green": {"png": make_png(COLORS["B-green"]), "dib": make_dib_bitfields(COLORS["B-green"]), "formats": ["PNG(alpha=0)", "CF_DIB 32bpp BI_BITFIELDS(alphaMask=0)"]},
            "D-blue": {"png": make_png(COLORS["D-blue"]), "dib": make_dib_bi_rgb(COLORS["D-blue"]), "formats": ["PNG(alpha=0)", "CF_DIB 32bpp BI_RGB(alpha=0)"]},
        }
        evidence["source_content"] = {
            name: {"rgba": list(COLORS[name]) + [0], "formats": src["formats"], "size": [WIDTH, HEIGHT]}
            for name, src in sources.items()
        }

        # 复制 A / B / C / D，每步等待真实采集入库。
        def copy_step(name: str, expected_total: int) -> dict:
            """写入一次剪贴板并等待真实入库；前台被本实例抢走时重做这一步。

            「来源是 Task Dock 自身」的自写抑制是正确行为，不是采集缺陷：
            那种情况下换回外部前台再复制一次，并把每次尝试如实留在证据里。
            """
            attempts = []
            for attempt in range(3):
                stats_before = monitor_stats()
                focus = ensure_target_foreground(f"copy-{name}#{attempt + 1}")
                if name == "text-C":
                    set_text_clipboard(TEXT_C)
                else:
                    set_image_clipboard(sources[name]["png"], sources[name]["dib"])
                items = wait_item_count(expected_total, timeout=12)
                stats_after = monitor_stats()
                attempts.append(
                    {
                        "attempt": attempt + 1,
                        "foreground": focus,
                        "items_total": len(items),
                        "expected_total": expected_total,
                        "monitor_delta": {k: stats_after[k] - stats_before[k] for k in MONITOR_DELTA_KEYS},
                    }
                )
                if len(items) >= expected_total:
                    break
                time.sleep(0.4)
            return {"copied": name, "attempts": attempts, "final": attempts[-1]}

        copy_order = ["A-red", "B-green", "text-C", "D-blue"]
        copy_trace = []
        for step, name in enumerate(copy_order):
            result = copy_step(name, len(baseline_items) + step + 1)
            copy_trace.append(result)
            final = result["final"]
            check(
                f"复制 {name} 后采集入库（{step + 1}/4）",
                final["items_total"] >= final["expected_total"],
                result,
            )
            if any(a["foreground"].get("blocked_by_own_foreground") for a in result["attempts"]):
                evidence.setdefault("own_foreground_suppressed_steps", []).append(
                    {"copied": name, "attempts": [a["foreground"] for a in result["attempts"]]}
                )
            time.sleep(0.35)
        evidence["copy_trace"] = copy_trace

        items = view_items()
        new_items = items[: max(0, len(items) - len(baseline_items))]
        evidence["captured_items"] = sanitize_items(new_items)
        evidence["history_delta_after_copies"] = len(items) - len(baseline_items)

        image_items = [item for item in new_items if item["kind"] == "image"]
        text_items = [item for item in new_items if item["kind"] == "text"]
        # 本次验收写入的文字带唯一标记：并行外部复制也能被准确排除，
        # 不会把「历史里多了一条别人的文本」算成产品采集错误。
        own_text_items = [item for item in text_items if TEXT_MARKER in (item.get("preview") or "")]
        evidence["counts"] = {
            "new_items": len(new_items),
            "images": len(image_items),
            "texts": len(text_items),
        }
        check("采集到 3 张图片与 1 条文字", len(image_items) == 3 and len(text_items) == 1, evidence["counts"])

        by_color: dict[str, dict] = {}
        matched_ids: list[str] = []
        stored_images: list[dict] = []
        unrelated_images = 0
        for item in image_items:
            url = invoke("clipboard_image", {"itemId": item["id"]})
            if not url:
                stored_images.append({"id": item["id"], "error": "no image asset"})
                continue
            decoded = decode_png(data_url_bytes(url))
            decoded["id"] = item["id"]
            decoded["copy_count"] = item["copy_count"]
            decoded["width_field"] = item["image_width"]
            decoded["height_field"] = item["image_height"]
            matched = next(
                (
                    name
                    for name, rgb in COLORS.items()
                    if decoded["avgRgb"] and all(abs(a - b) <= 3 for a, b in zip(decoded["avgRgb"], rgb))
                ),
                None,
            )
            if matched is None:
                # 与本次验收无关的条目：只计数，不记录任何颜色或尺寸细节。
                unrelated_images += 1
                continue
            decoded["expected"] = matched
            by_color[matched] = decoded
            matched_ids.append(item["id"])
            stored_images.append(decoded)
        evidence["stored_images"] = stored_images
        evidence["unrelated_image_items"] = unrelated_images

        for name, rgb in COLORS.items():
            found = by_color.get(name)
            check(
                f"采集入库的 {name} 像素可见且颜色正确",
                bool(found)
                and found["alphaMin"] == 255
                and found["transparentPixels"] == 0
                and all(abs(a - b) <= 3 for a, b in zip(found["avgRgb"], rgb)),
                found,
            )
            check(
                f"采集入库的 {name} 尺寸为 {WIDTH}x{HEIGHT}",
                bool(found) and found["width"] == WIDTH and found["height"] == HEIGHT,
                None if not found else [found["width"], found["height"]],
            )

        if len(own_text_items) == 1:
            full_text = invoke("clipboard_item", {"itemId": own_text_items[0]["id"]})
            stored = full_text.get("text") or ""
            check("文字内容完整入库", stored == TEXT_C, {"length": len(stored), "matches": stored == TEXT_C})
            text_id = own_text_items[0]["id"]
        else:
            text_id = None
            check("本次验收的文本条目恰好一条", False, {"matched": len(own_text_items)})

        if len(by_color) == 3 and text_id:
            group_order = [by_color["A-red"]["id"], by_color["B-green"]["id"], text_id, by_color["D-blue"]["id"]]
        else:
            group_order = []
        evidence["intended_group_order"] = group_order

        # 能证明属于本次验收之外的条目如实记录（只记结构字段），
        # 供报告区分「产品漏采/重复采集」与「本机并行复制造成的噪声」。
        attributed = {i["id"] for i in own_text_items} | {d["id"] for d in by_color.values()}
        external_items = [item for item in new_items if item["id"] not in attributed]
        evidence["external_items_during_run"] = sanitize_items(external_items)
        external_clipboard_changes = clipboard_sequence() - baseline_seq - OWN_CLIPBOARD_WRITES["count"]
        evidence["external_clipboard_changes"] = external_clipboard_changes
        evidence["own_clipboard_writes"] = OWN_CLIPBOARD_WRITES["count"]

        # 断言按「内容归属」而不是「全局条数」下判：本机并行复制会真实产生新条目，
        # 那是产品在正常工作，不是采集错误；但每条多出来的条目都必须能对应到
        # 一次确实发生的外部写入，否则就是产品凭空造条目。
        check(
            "本次验收四项内容各建一条（3 图 + 1 文），无漏采也无重复",
            len(matched_ids) == 3 and len(by_color) == 3 and len(own_text_items) == 1 and unrelated_images == 0,
            {
                "matched_image_items": len(matched_ids),
                "distinct_colors": len(by_color),
                "own_text_items": len(own_text_items),
                "unrelated_image_items": unrelated_images,
                "history_delta": len(items) - len(baseline_items),
            },
        )
        check(
            "多出的历史条目全部可归因于外部复制（序列号等量佐证）",
            len(external_items) == 0 or len(external_items) <= max(0, external_clipboard_changes),
            {
                "external_items": [
                    {"kind": i["kind"], "byte_size": i.get("byte_size")} for i in external_items
                ],
                "external_clipboard_changes": external_clipboard_changes,
            },
        )

        # 粘贴阶段的「零新增」断言同样要求剪贴板安静：不安静就判环境，不判产品。
        quiet_paste = clipboard_quiet_window(quiet_for_s=6.0, max_wait_s=180.0)
        evidence["clipboard_quiet_before_paste"] = quiet_paste
        if not quiet_paste["quiet"]:
            raise EnvironmentBlocked(
                f"粘贴阶段剪贴板未安静（外部改动 {quiet_paste['external_changes']} 次，"
                f"等待 {quiet_paste['waited_s']}s）：外部条目 {len(external_items)} 条；"
                "「粘贴期间不得新增历史」这类断言在有并行复制时不成立"
            )

        # 粘贴前再次确认目标窗口仍在、编辑器仍是焦点：采集阶段可能已经过 30s 以上。
        if not win32gui.IsWindow(hwnd):
            raise RuntimeError(f"安全测试窗口已消失（hwnd={hwnd}）")
        click = node_bridge("edge-click", EDGE_CDP, title_token, timeout=30)
        check("粘贴前测试页编辑器仍是焦点", click.get("ok") and click.get("activeId") == "editor", click)
        # 置前只是便利步骤：真正的焦点保障由粘贴引擎逐项执行，这里只如实记录环境状态。
        evidence["foreground_before_paste"] = {
            "set_foreground_ok": foreground_window(hwnd),
            "foreground_hwnd": win32gui.GetForegroundWindow(),
            "target_hwnd": hwnd,
            "foreground_source": foreground_source_exe(),
        }

        precheck = invoke("clipboard_paste_precheck", {"hwnd": hwnd})
        evidence["precheck"] = precheck
        check(
            "目标预检通过且进程/窗口匹配",
            precheck["hwnd"] == hwnd and precheck["pid"] == target_pid and precheck["pid"] != app.pid,
            precheck,
        )

        group = invoke("clipboard_create_group", {"name": f"P1-03 混合粘贴 {nonce}", "itemIds": group_order})
        evidence["group"] = {
            "id": group["id"],
            "mode": group["mode"],
            "status": group["status"],
            "item_count": group["item_count"],
            "image_count": group["image_count"],
            "items": sanitize_items(group.get("items", [])),
        }
        actual_order = [item["id"] for item in group.get("items", [])]
        check("手动分组顺序为 A/B/C/D", actual_order == group_order, actual_order)
        check("分组包含 4 项", group.get("item_count") == 4, group.get("item_count"))

        # 粘贴前写入哨兵：与分组四项都不同，才能唯一确定「恢复」写回的是粘贴前内容。
        # 不等这一步，剪贴板结束时是 D-blue 既可能是恢复成功，也可能是任务把第 4 项
        # 留在原地，两种结果根本分不开。
        sentinel_before = view_items()
        set_text_clipboard(SENTINEL_TEXT)
        sentinel_item_count = len(sentinel_before) + 1
        sentinel_waited = wait_item_count(sentinel_item_count, timeout=12)
        evidence["sentinel"] = {
            "marker": SENTINEL_MARKER,
            "sequence_after_write": clipboard_sequence(),
            "history_count": len(sentinel_waited),
            "expected_at_least": sentinel_item_count,
        }
        check(
            "粘贴前哨兵已写入并被采集入库",
            len(sentinel_waited) >= sentinel_item_count,
            {"history_count": len(sentinel_waited), "expected_at_least": sentinel_item_count},
        )

        pre_items = view_items()
        pre_ids = {item["id"] for item in pre_items}
        pre_copy_counts = {item["id"]: item["copy_count"] for item in pre_items if item["id"] in group_order}
        monitor_before = monitor_stats()
        evidence["pre_paste"] = {
            "history_count": len(pre_items),
            "copy_counts": pre_copy_counts,
            "captured": monitor_before.get("captured"),
            "recorded": monitor_before.get("recorded"),
            "duplicates": monitor_before.get("duplicates"),
        }
        EXTERNAL_STOP = "剪贴板已被其他程序更新"

        completion_samples: list[dict] = []

        def wait_job(job_id: str, timeout: float = 60.0) -> dict:
            deadline = time.time() + timeout
            job = {}
            while time.time() < deadline:
                job = invoke("clipboard_paste_job", {"jobId": job_id})
                if job.get("status") != "running":
                    completion_samples.clear()
                    completion_samples.extend(clipboard_samples_at_completion())
                    return job
                time.sleep(0.25)
            return job

        start = invoke("clipboard_paste_group", {"groupId": group["id"], "targetHwnd": hwnd, "itemIds": group_order})
        evidence["paste_start"] = start
        job_id = start["job_id"]
        job = wait_job(job_id)

        # 内容守卫在「本项写入前发现剪贴板已经不是快照内容」时停写、并保留用户刚复制的
        # 内容。这个判定以内容为准，因此先确认剪贴板到底换没换：
        # - 仍是验收自己写入的粘贴前基线（哨兵文本/序列号完全没动）→ 没有外部接管，
        #   产品把自己的内容判成了别人的，这是缺陷：不续跑、不判环境，
        #   让下面的 4/4 断言如实失败；
        # - 内容真的被别人换掉 → 本机剪贴板无法独占，等新的安静窗口后用
        #   clipboard_paste_resume 续跑，产品断言不放宽；三次仍被打断才判环境不满足。
        resumptions: list[dict] = []
        misjudged = False
        # 参照序列号取「写完哨兵之后」：安静窗口结束到粘贴开始之间还有验收自己的
        # 一次写入，拿更早的序列号比较会把自写误读成「有人动过」。
        last_quiet = {"sequence_now": evidence["sentinel"]["sequence_after_write"], "source": "post-sentinel"}
        while (
            job.get("status") != "completed"
            and EXTERNAL_STOP in (job.get("message") or "")
            and len(resumptions) < 3
        ):
            still = clipboard_still_baseline(last_quiet.get("sequence_now"))
            evidence["paste_stop_clipboard_state"] = still
            if still.get("still_ours"):
                evidence["paste_stop_is_product_misjudgment"] = {
                    "message": job.get("message"),
                    "clipboard": still,
                    "quiet_before_paste": quiet_paste,
                }
                misjudged = True
                break
            quiet_retry = clipboard_quiet_window(quiet_for_s=6.0, max_wait_s=180.0)
            last_quiet = quiet_retry
            record = {
                "attempt": len(resumptions) + 1,
                "stopped_message": job.get("message"),
                "remaining_items": job.get("remaining_items"),
                "quiet": quiet_retry,
            }
            resumptions.append(record)
            if not quiet_retry["quiet"]:
                evidence["paste_resumptions"] = resumptions
                raise EnvironmentBlocked(
                    f"粘贴被外部复制打断 {record['attempt']} 次后，"
                    f"{quiet_retry['waited_s']}s 内仍等不到 6s 安静窗口"
                    f"（外部改动 {quiet_retry['external_changes']} 次）；"
                    "粘贴 4/4 与恢复原剪贴板这类断言在有并行复制时不成立"
                )
            if not win32gui.IsWindow(hwnd):
                raise RuntimeError(f"安全测试窗口已消失（hwnd={hwnd}）")
            refocus = node_bridge("edge-click", EDGE_CDP, title_token, timeout=30)
            record["refocus"] = refocus
            record["set_foreground_ok"] = foreground_window(hwnd)
            record["foreground"] = {
                "foreground_hwnd": win32gui.GetForegroundWindow(),
                "target_hwnd": hwnd,
                "foreground_source": foreground_source_exe(),
            }
            record["resume"] = invoke("clipboard_paste_resume", {"jobId": job_id, "targetHwnd": hwnd})
            job = wait_job(job_id)
        evidence["paste_resumptions"] = resumptions
        if (
            not misjudged
            and job.get("status") != "completed"
            and EXTERNAL_STOP in (job.get("message") or "")
        ):
            raise EnvironmentBlocked(
                f"粘贴阶段连续 {len(resumptions)} 次被外部复制打断（守卫每次都拒绝覆盖用户内容）："
                "本机剪贴板无法独占，请关闭并行复制的会话后重跑"
            )

        evidence["paste_job"] = job
        check("粘贴任务结束", job is not None and job.get("status") != "running", None if job is None else job.get("status"))
        check("粘贴任务完成且发送 4/4", job is not None and job.get("status") == "completed" and job.get("sent") == 4 and job.get("total") == 4, job)
        check("粘贴任务无剩余项", job is not None and not job.get("remaining_items"), None if job is None else job.get("remaining_items"))
        check("粘贴后恢复原剪贴板", job is not None and job.get("restored") is True, None if job is None else job.get("message"))

        # 给目标 DOM 解码与监听线程处理恢复事件留出时间。
        time.sleep(1.6)

        dump_result = node_bridge("edge-dump", EDGE_CDP, title_token, timeout=60)
        if not dump_result.get("ok"):
            raise RuntimeError(f"读取目标页面失败: {dump_result}")
        dump = dump_result["value"]
        evidence["target_dom"] = dump

        check("目标页面图片数量为 3", dump.get("imageCount") == 3, dump.get("imageCount"))
        check("目标页面文字完整", TEXT_C in (dump.get("textContent") or ""), dump.get("textContent"))
        flat = dump.get("flatOrder") or []
        flat_types = [entry.get("type") for entry in flat]
        check("DOM 顺序为 图/图/文/图", flat_types == ["image", "image", "text", "image"], flat_types)
        check("文字位于第三位且完整", len(flat) >= 3 and flat[2].get("type") == "text" and TEXT_C in flat[2].get("text", ""), flat[2] if len(flat) > 2 else None)

        dom_images = dump.get("images") or []
        expected = [COLORS["A-red"], COLORS["B-green"], COLORS["D-blue"]]
        for index, rgb in enumerate(expected):
            img = dom_images[index] if index < len(dom_images) else {}
            check(
                f"目标第 {index + 1} 张图片尺寸为 {WIDTH}x{HEIGHT}",
                img.get("naturalWidth") == WIDTH and img.get("naturalHeight") == HEIGHT,
                None if not img else [img.get("naturalWidth"), img.get("naturalHeight")],
            )
            check(
                f"目标第 {index + 1} 张图片 Alpha 正确",
                img.get("alphaMin") == 255 and img.get("alphaMax") == 255 and img.get("transparentPixels") == 0,
                None if not img else [img.get("alphaMin"), img.get("alphaMax"), img.get("transparentPixels")],
            )
            check(
                f"目标第 {index + 1} 张图片 RGB 正确",
                img.get("avgRgb") is not None and all(abs(a - b) <= 3 for a, b in zip(img.get("avgRgb"), rgb)),
                None if not img else img.get("avgRgb"),
            )
            check(
                f"目标第 {index + 1} 张图片可见",
                img.get("visible") is True and (img.get("renderedWidth") or 0) > 0 and (img.get("renderedHeight") or 0) > 0,
                None if not img else [img.get("visible"), img.get("renderedWidth"), img.get("renderedHeight")],
            )

        signatures = [tuple(img.get("avgRgb") or []) for img in dom_images]
        check("目标图片无重复颜色/无重复插入", len(signatures) == 3 and len(set(signatures)) == 3, signatures)

        # 恢复判定只认「任务结束瞬间」的密集采样：剪贴板是全局共享资源，
        # 事后单点读取（前面还要等 1.6s DOM 解码）早已被本机并行复制覆盖，
        # 那种读取既证明不了恢复、也证明不了没恢复。
        evidence["clipboard_at_completion"] = completion_samples
        sentinel_restored = [s for s in completion_samples if (s.get("text") or {}).get("is_sentinel")]
        left_on_pasted_item = [
            s for s in completion_samples
            if s.get("color") in {"A-red", "B-green", "D-blue"} or (s.get("text") or {}).get("is_our_text")
        ]
        foreign_samples = [s for s in completion_samples if not sample_is_ours(s) and s.get("format") != "none"]
        evidence["clipboard_after"] = (
            sentinel_restored[-1] if sentinel_restored
            else (completion_samples[-1] if completion_samples else None)
        )
        restore_summary = {
            "samples": len(completion_samples),
            "sequences": [s.get("sequence") for s in completion_samples],
            "sentinel_hits": len(sentinel_restored),
            "left_on_pasted_item": len(left_on_pasted_item),
            "foreign_samples": len(foreign_samples),
            "first_sample": completion_samples[0] if completion_samples else None,
            "job_restored": job.get("restored"),
            "user_takeover_note": "未恢复原内容（保留最新内容）" in (job.get("message") or ""),
        }
        if sentinel_restored:
            check("剪贴板已恢复为粘贴前哨兵（结束瞬间采样）", True, restore_summary)
        elif left_on_pasted_item:
            # 结束时剪贴板仍是分组里被粘贴过的内容：基线明明是哨兵，说明没恢复。
            check("剪贴板已恢复为粘贴前哨兵（结束瞬间采样）", False, restore_summary)
        elif job.get("restored") is True:
            check_blocked(
                "剪贴板已恢复为粘贴前哨兵（结束瞬间采样）",
                "产品自报已恢复，但结束瞬间的采样全是外部内容：恢复之后（或写入之前）"
                "本机其他程序又复制了新内容，事后无法区分「恢复后被覆盖」与「根本没恢复」",
                restore_summary,
            )
        elif restore_summary["user_takeover_note"]:
            check(
                "粘贴期间被用户接管时保留用户内容、不强行恢复",
                bool(foreign_samples),
                restore_summary,
            )
            check_blocked(
                "剪贴板已恢复为粘贴前哨兵（结束瞬间采样）",
                "产品如实报告「粘贴期间被其他程序更新，未恢复原内容」——这是设计行为，"
                "但恢复路径本身这一轮未被覆盖验证",
                restore_summary,
            )
        else:
            check("剪贴板已恢复为粘贴前哨兵（结束瞬间采样）", False, restore_summary)

        check(
            "剪贴板未被 A/B/C 留在原地",
            not left_on_pasted_item,
            {
                "left_on_pasted_item": len(left_on_pasted_item),
                "matched_colors": [s.get("color") for s in left_on_pasted_item],
                "our_text_left": [
                    bool((s.get("text") or {}).get("is_our_text")) for s in left_on_pasted_item
                ],
            },
        )

        after_items = view_items()
        after_ids = {item["id"] for item in after_items}
        new_since_paste = sorted(after_ids - pre_ids)
        post_copy_counts = {item["id"]: item["copy_count"] for item in after_items if item["id"] in group_order}
        monitor_after = monitor_stats()
        evidence["history_after"] = {
            "count": len(after_items),
            "items": sanitize_items(after_items),
            "new_ids_since_paste": new_since_paste,
            "copy_counts": post_copy_counts,
        }
        evidence["monitor_before"] = monitor_before
        evidence["monitor_after"] = monitor_after
        check("粘贴后历史条数不变", not new_since_paste, new_since_paste)
        check(
            "粘贴不增加 copy_count",
            all(post_copy_counts.get(item_id) == pre_copy_counts.get(item_id) for item_id in group_order),
            {"before": pre_copy_counts, "after": post_copy_counts},
        )
        captured_delta = (monitor_after.get("captured") or 0) - (monitor_before.get("captured") or 0)
        recorded_delta = (monitor_after.get("recorded") or 0) - (monitor_before.get("recorded") or 0)
        evidence["self_write_delta"] = {"captured": captured_delta, "recorded": recorded_delta}
        check("粘贴自写内容未进入采集链路", captured_delta == 0 and recorded_delta == 0, evidence["self_write_delta"])
        check("监听无丢弃事件", monitor_after.get("dropped_events") == 0 and monitor_after.get("dropped_contents") == 0, monitor_after)

        overall = len(fail_checks) == 0
        evidence["overall"] = "PASS" if overall else "FAIL"
        if blocked_checks:
            evidence["overall"] = "PASS_WITH_ENVIRONMENT_BLOCKED" if overall else "FAIL_WITH_ENVIRONMENT_BLOCKED"
            print(
                f"BLOCKED {len(blocked_checks)} 条断言：本机剪贴板被并行复制污染，"
                "这些断言既未通过也未判产品失败，详见证据 checks.blocked"
            )
        return 0 if overall else 1
    except EnvironmentBlocked as exc:
        # 前置条件不成立：如实记为环境阻塞，既不算产品缺陷，也不算通过
        evidence["overall"] = "ENVIRONMENT BLOCKED"
        evidence["error"] = f"EnvironmentBlocked: {exc}"
        print(f"ENVIRONMENT BLOCKED {exc}", file=sys.stderr)
        return 3
    except Exception as exc:  # noqa: BLE001 - 验收失败必须留证据
        evidence["overall"] = "FAIL"
        evidence["error"] = f"{type(exc).__name__}: {exc}"
        print(f"ERROR {evidence['error']}", file=sys.stderr)
        return 1
    finally:
        # 清理前先记录实例存活状态：这是「秒退（Single Instance）」与「跑到一半被我们杀掉」的区分依据
        evidence["app_alive_before_cleanup"] = bool(app is not None and app.poll() is None)
        evidence["app_exit_code_before_cleanup"] = app.poll() if app is not None else None
        # 只关闭本次启动的隔离实例，不触碰用户已有进程。
        for proc in (edge, app):
            if proc is not None and proc.poll() is None:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    creationflags=NO_WINDOW,
                )
        app_log.close()
        edge_log.close()
        evidence.setdefault("checks", {})["pass"] = pass_checks
        evidence["checks"]["fail"] = fail_checks
        evidence["app_exit_code"] = app.poll() if app is not None else None
        evidence["cdp_diagnostics"] = CDP_DIAGNOSTICS
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out_path = out_dir / f"p1-03-mixed-paste-{stamp}-{nonce}.json"
        # 原始应用日志随证据一起留存：临时目录会被清掉，失败归因不能只靠 JSON
        app_log_copy = out_dir / f"p1-03-mixed-paste-{stamp}-{nonce}-app.log"
        try:
            app_log_copy.write_bytes((work / "app.log").read_bytes())
        except OSError as exc:  # noqa: BLE001 - 证据副本失败不改变验收结论
            evidence["app_log_copy_error"] = str(exc)
        evidence["raw_logs"] = {
            "app": str(work / "app.log"),
            "app_copy": str(app_log_copy),
            "edge": str(work / "edge.log"),
        }
        out_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"EVIDENCE {out_path}")
        if not args.keep:
            shutil.rmtree(work / "webview2", ignore_errors=True)
            shutil.rmtree(work / "edge-profile", ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
