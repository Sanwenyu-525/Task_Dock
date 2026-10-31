#!/usr/bin/env python3
"""真实 Windows 剪贴板事件激励器（P1-05 联合负载用）。

用途：在 Agent 负载同时进行时，产生**真实的** Windows 剪贴板变更事件
（WM_CLIPBOARDUPDATE），而不是向队列里塞模拟事件。

边界与诚实声明：
- 本脚本会覆盖用户当前剪贴板内容。启动时把剪贴板文本/DIB 读入**进程内存**
  （不落盘、不写日志），结束时尽力恢复；无法恢复时如实记录 restored=false。
- 任何输出都不包含剪贴板正文，只含计数、字节数与序列号。
- 图片用 CF_DIB（32bpp BI_RGB）直接写入：这是真实的系统剪贴板写入，
  且包含全透明/半透明/不透明像素，可在真机上验证 Alpha 语义。
- 不使用任何子进程，避免控制台闪窗。
"""

import argparse
import binascii
import ctypes
import ctypes.wintypes
import json
import struct
import sys
import time
import zlib
from datetime import datetime, timezone

CF_UNICODETEXT = 13
CF_DIB = 14
CF_DIBV5 = 17
CF_HDROP = 15
GMEM_MOVEABLE = 0x0002
MAX_RESTORE_BYTES = 32 * 1024 * 1024
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

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
user32.GetClipboardSequenceNumber.restype = ctypes.c_uint
user32.GetOpenClipboardWindow.restype = ctypes.c_void_p
user32.RegisterClipboardFormatW.argtypes = [ctypes.c_wchar_p]
user32.RegisterClipboardFormatW.restype = ctypes.c_uint
user32.GetWindowThreadProcessId.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.wintypes.DWORD),
]
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.restype = ctypes.c_bool
kernel32.GlobalSize.argtypes = [ctypes.c_void_p]
kernel32.GlobalSize.restype = ctypes.c_size_t
kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
kernel32.GlobalFree.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_bool, ctypes.c_uint]
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.QueryFullProcessImageNameW.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint,
    ctypes.c_wchar_p,
    ctypes.POINTER(ctypes.wintypes.DWORD),
]
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]


def clipboard_sequence():
    return int(user32.GetClipboardSequenceNumber())


def _process_basename(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = ctypes.wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        return buf.value.replace("\\", "/").rsplit("/", 1)[-1]
    finally:
        kernel32.CloseHandle(handle)


def clipboard_blocker():
    """当前持有剪贴板打开的窗口属于哪个进程（只记 exe 名与 PID，不记标题）。"""
    hwnd = user32.GetOpenClipboardWindow()
    if not hwnd:
        return None
    pid = ctypes.wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None
    return {"pid": int(pid.value), "exe": _process_basename(pid.value)}


def open_clipboard(retries=40, delay=0.05):
    """剪贴板是全局独占资源：被占用时按短间隔重试（最长约 2 秒）。"""
    for _ in range(retries):
        if user32.OpenClipboard(None):
            return True
        time.sleep(delay)
    return False


def get_clipboard_text():
    """读取当前剪贴板文本（仅内存）。非文本内容返回 None。"""
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


def _read_format_bytes(fmt, max_bytes):
    """调用方须已打开剪贴板。"""
    if not user32.IsClipboardFormatAvailable(fmt):
        return None
    handle = user32.GetClipboardData(fmt)
    if not handle:
        return None
    size = kernel32.GlobalSize(handle)
    if size == 0 or size > max_bytes:
        return None
    ptr = kernel32.GlobalLock(handle)
    if not ptr:
        return None
    try:
        return ctypes.string_at(ptr, size)
    finally:
        kernel32.GlobalUnlock(handle)


def get_clipboard_dib():
    """读取当前剪贴板 DIB（优先 V5），用于结束时尽力恢复。"""
    if not open_clipboard():
        return None
    try:
        for fmt in (CF_DIBV5, CF_DIB):
            data = _read_format_bytes(fmt, MAX_RESTORE_BYTES)
            if data:
                return (fmt, data)
        return None
    finally:
        user32.CloseClipboard()


def clipboard_formats():
    """当前剪贴板包含哪些格式（只看格式，不看内容）。"""
    out = []
    if not open_clipboard():
        return out
    try:
        for fmt, name in (
            (CF_UNICODETEXT, "text"),
            (CF_DIB, "dib"),
            (CF_DIBV5, "dibv5"),
            (CF_HDROP, "files"),
        ):
            if user32.IsClipboardFormatAvailable(fmt):
                out.append(name)
    finally:
        user32.CloseClipboard()
    return out


def _set_bytes(fmt, data):
    """调用方须已打开剪贴板；接管失败时由调用方负责释放句柄。"""
    handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, max(1, len(data)))
    if not handle:
        return False
    ptr = kernel32.GlobalLock(handle)
    if not ptr:
        kernel32.GlobalFree(handle)
        return False
    try:
        if data:
            ctypes.memmove(ptr, data, len(data))
    finally:
        kernel32.GlobalUnlock(handle)
    if not user32.SetClipboardData(fmt, handle):
        kernel32.GlobalFree(handle)
        return False
    return True


def set_clipboard_text(text, stats):
    """写入真实剪贴板（CF_UNICODETEXT），触发系统级剪贴板更新通知。"""
    if not open_clipboard():
        stats["open_failures"] += 1
        blocker = clipboard_blocker()
        key = "unknown" if blocker is None else f"{blocker['exe']}:{blocker['pid']}"
        stats["open_failure_blockers"][key] = (
            stats["open_failure_blockers"].get(key, 0) + 1
        )
        return False
    try:
        user32.EmptyClipboard()
        data = (text + "\0").encode("utf-16-le")
        if not _set_bytes(CF_UNICODETEXT, data):
            return False
        return bool(user32.IsClipboardFormatAvailable(CF_UNICODETEXT))
    finally:
        user32.CloseClipboard()


def build_dibv5(width, height, seed):
    """32bpp BI_BITFIELDS（BITMAPV5HEADER，带 Alpha 掩码）。

    在本机实测 CF_DIB(14) 写入返回 ERROR_INVALID_HANDLE，而 CF_DIBV5 与
    注册格式 PNG 均可正常写入，因此图片激励以 PNG 为主、V5 为辅。
    """
    stride = width * 4
    buf = bytearray(124 + stride * height)
    struct.pack_into(
        "<IiiHHIIiiII",
        buf,
        0,
        124,  # bV5Size
        width,
        height,  # 正高度 = 自下而上
        1,
        32,
        3,  # BI_BITFIELDS
        stride * height,
        0,
        0,
        0,
        0,
    )
    struct.pack_into("<IIII", buf, 40, 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000)
    for y in range(height):
        dst_row = height - 1 - y
        for x in range(width):
            off = 124 + dst_row * stride + x * 4
            buf[off : off + 4] = bytes(_pixel_bgra(x, width, seed))
    return bytes(buf)


def _pixel_bgra(x, width, seed):
    if x < width // 2:
        # 不透明蓝，seed 改变亮度保证每幅图内容不同（避免被去重合并）
        v = 32 + (seed * 37) % 160
        return (200, 96, v, 255)
    if x < (width * 3) // 4:
        return (60, 180, 60, 128)  # 半透明绿
    return (0, 0, 0, 0)  # 全透明


def build_png_rgba(width, height, seed):
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: None
        for x in range(width):
            b, g, r, a = _pixel_bgra(x, width, seed)
            raw += bytes((r, g, b, a))

    def chunk(kind, data):
        body = kind + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", binascii.crc32(body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )


def _png_format_id():
    fmt = user32.RegisterClipboardFormatW("PNG")
    return fmt


def set_clipboard_image(seed, stats):
    """写入真实图片剪贴板：注册格式 PNG（主）+ CF_DIBV5（辅），一次更新。"""
    width, height = 120, 80
    png = build_png_rgba(width, height, seed)
    dib = build_dibv5(width, height, seed)
    fmt_png = _png_format_id()
    if fmt_png == 0:
        return False
    if not open_clipboard():
        stats["open_failures"] += 1
        blocker = clipboard_blocker()
        key = "unknown" if blocker is None else f"{blocker['exe']}:{blocker['pid']}"
        stats["open_failure_blockers"][key] = (
            stats["open_failure_blockers"].get(key, 0) + 1
        )
        return False
    try:
        user32.EmptyClipboard()
        aux_ok = _set_bytes(CF_DIBV5, dib)
        png_ok = _set_bytes(fmt_png, png)
        stats["image_aux_written"] += int(aux_ok)
        if not png_ok:
            return False
        return bool(user32.IsClipboardFormatAvailable(fmt_png))
    finally:
        user32.CloseClipboard()


def restore_clipboard(saved):
    """尽力恢复原剪贴板（文本和/或 DIB），单次打开内写入全部可恢复格式。"""
    text = saved.get("text")
    dib = saved.get("dib")
    if text is None and dib is None:
        return "none"
    if not open_clipboard():
        return "none"
    restored = []
    try:
        user32.EmptyClipboard()
        if text is not None:
            if _set_bytes(CF_UNICODETEXT, (text + "\0").encode("utf-16-le")):
                restored.append("text")
        if dib is not None:
            fmt, data = dib
            if _set_bytes(fmt, data):
                restored.append("image")
        return "+".join(restored) if restored else "none"
    finally:
        user32.CloseClipboard()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=int, default=600, help="持续秒数")
    ap.add_argument("--interval", type=float, default=5.0, help="两次文本写入间隔秒")
    ap.add_argument("--marker", default="taskdock-p1-05-clipboard-probe-", help="测试文本唯一标识前缀（用于把本轮激励与外部真实复制区分开）")
    ap.add_argument("--image-every", type=int, default=6, help="每 N 次文本写入插入一次图片")
    ap.add_argument("--out", default="")
    ap.add_argument("--no-restore", action="store_true", help="不恢复用户原剪贴板")
    args = ap.parse_args()

    original = {"text": None, "dib": None}
    original_formats = clipboard_formats()
    if not args.no_restore:
        original["text"] = get_clipboard_text()
        if original["text"] is None and "files" not in original_formats:
            original["dib"] = get_clipboard_dib()

    stats = {
        "text_attempted": 0,
        "text_ok": 0,
        "text_failed": 0,
        "text_verified": 0,
        "image_attempted": 0,
        "image_ok": 0,
        "image_failed": 0,
        "image_verified": 0,
        "image_aux_written": 0,
        "bytes_written": 0,
        "open_failures": 0,
        "open_failure_blockers": {},
        "clipboard_sequence_start": clipboard_sequence(),
        "clipboard_sequence_end": 0,
        "errors": [],
    }

    started = time.time()
    started_iso = datetime.fromtimestamp(started, timezone.utc).isoformat()
    deadline = started + args.duration
    image_index = 0
    index = 0
    next_at = started
    while time.time() < deadline:
        index += 1
        payload = f"{args.marker}{index}"
        stats["text_attempted"] += 1
        try:
            if set_clipboard_text(payload, stats):
                stats["text_ok"] += 1
                stats["text_verified"] += 1
                stats["bytes_written"] += len(payload)
            else:
                stats["text_failed"] += 1
                stats["errors"].append("文本写入失败（剪贴板被占用或写入被拒）")
        except Exception as e:  # noqa: BLE001
            stats["text_failed"] += 1
            stats["errors"].append(f"{type(e).__name__}: {e}")

        if args.image_every > 0 and index % args.image_every == 0:
            image_index += 1
            stats["image_attempted"] += 1
            try:
                if set_clipboard_image(image_index, stats):
                    stats["image_ok"] += 1
                    stats["image_verified"] += 1
                else:
                    stats["image_failed"] += 1
                    stats["errors"].append("CF_DIB 图片写入失败")
            except Exception as e:  # noqa: BLE001
                stats["image_failed"] += 1
                stats["errors"].append(f"{type(e).__name__}: {e}")

        next_at += args.interval
        time.sleep(max(0.2, next_at - time.time()))

    restored_kind = "skipped"
    if not args.no_restore:
        restored_kind = restore_clipboard(original)

    seq_end = clipboard_sequence()
    expected_updates = stats["text_ok"] + stats["image_ok"]
    stats.update(
        {
            "duration_s": round(time.time() - started, 1),
            "started_at": started_iso,
            "ended_at": datetime.now(timezone.utc).isoformat(),
            "text_interval_s": args.interval,
            "image_every": args.image_every,
            "original_clipboard_formats": original_formats,
            "original_clipboard_was_text": original["text"] is not None,
            "original_clipboard_was_image": original["dib"] is not None,
            "restored": restored_kind not in ("none", "skipped"),
            "restored_kind": restored_kind,
            "restore_skipped": bool(args.no_restore),
            "clipboard_sequence_end": seq_end,
            "clipboard_sequence_delta": (seq_end - stats["clipboard_sequence_start"])
            & 0xFFFFFFFF,
            "expected_updates": expected_updates,
        }
    )
    # 错误文本里不含剪贴板正文，只保留条数与首条原因
    first_error = stats["errors"][0] if stats["errors"] else None
    stats["error_count"] = len(stats["errors"])
    stats["errors"] = [] if first_error is None else [first_error]
    print(json.dumps(stats, ensure_ascii=False), flush=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
