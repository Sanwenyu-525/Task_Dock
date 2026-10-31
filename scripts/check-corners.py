"""圆角真机验收：可见帧 vs 同位置“隐藏窗口”背景基线。

旧脚本把同一张截图里的窗口角块与窗外桌面块比较，两者是同一批像素，
即使四角是黑色直角也恒等于 0.0 —— 结论无效。本脚本改为：

1. 读取 corner-lab.ps1 产出的元数据 + 可见帧 + 隐藏窗口后的基线帧；
2. 先用**基线**证明背景是受控纯色（不是壁纸/其它窗口），否则 UNVERIFIED；
3. 以窗口矩形为基准，检查四角“窗口区域之外、圆角之内”的像素是否等于背景；
4. 检测圆角附近的深色连通块（黑色楔形/黑色描边），以及直边的 1px 描边、
   外扩阴影；
5. 从可见/基线差分掩码测量实际圆角半径与边缘阶跃，和 GetWindowRgn/DWM
   读数联合判定；
6. 缺少有效基线、窗口不在预期位置或区域状态异常时返回 UNVERIFIED/FAIL，
   绝不会因为“GetWindowRgn 成功”或“同一帧自比”而 PASS。

用法：
    python scripts/check-corners.py docs/screenshots/v07/lab-solid-region-dwm.json
    python scripts/check-corners.py docs/screenshots/v07/*.json --summary

退出码：0 全部 PASS；1 至少一个 FAIL；2 没有 FAIL 但存在 UNVERIFIED。
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

CORNER_NAMES = ("top-left", "top-right", "bottom-left", "bottom-right")


def resolve(path: str, meta_path: Path) -> Path:
    p = Path(path)
    if p.is_absolute():
        return p
    for base in (meta_path.parent, Path.cwd()):
        cand = (base / p).resolve()
        if cand.exists():
            return cand
    return p


def parse_rgb(value) -> tuple[int, int, int] | None:
    if isinstance(value, dict):
        return (int(value.get("r", 0)), int(value.get("g", 0)), int(value.get("b", 0)))
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return (int(value[0]), int(value[1]), int(value[2]))
    if isinstance(value, str):
        parts = [p.strip() for p in value.split(",")]
        if len(parts) == 3:
            try:
                return (int(parts[0]), int(parts[1]), int(parts[2]))
            except ValueError:
                return None
    return None


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def dilate(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    """3x3 可分离膨胀，用于填补阈值造成的内容掩码小孔。"""
    out = mask.copy()
    for axis in (0, 1):
        acc = out.copy()
        for shift in range(1, radius + 1):
            acc |= np.roll(out, shift, axis=axis)
            acc |= np.roll(out, -shift, axis=axis)
        out = acc
    return out


def label_components(mask: np.ndarray) -> list[dict]:
    """8 连通分量（纯 numpy 泛洪，掩码通常只有几千像素）。"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    for y in range(h):
        row = np.nonzero(mask[y] & ~seen[y])[0]
        for x in row:
            if seen[y, x]:
                continue
            stack = [(int(y), int(x))]
            seen[y, x] = True
            pts = []
            while stack:
                cy, cx = stack.pop()
                pts.append((cy, cx))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dy == 0 and dx == 0:
                            continue
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            ys = [p[0] for p in pts]
            xs = [p[1] for p in pts]
            comps.append(
                {
                    "area": len(pts),
                    "bbox": [int(min(xs)), int(min(ys)), int(max(xs) + 1), int(max(ys) + 1)],
                }
            )
    comps.sort(key=lambda c: c["area"], reverse=True)
    return comps


def corner_view(arr: np.ndarray, name: str, k: int) -> np.ndarray:
    """把四角统一成左上角坐标系，便于共用几何公式。"""
    h, w = arr.shape[:2]
    if name == "top-left":
        return arr[:k, :k]
    if name == "top-right":
        return arr[:k, w - k :][:, ::-1]
    if name == "bottom-left":
        return arr[h - k :, :k][::-1, :]
    return arr[h - k :, w - k :][::-1, ::-1]


def measure_radius(fg: np.ndarray, r: float) -> dict:
    """从内容掩码的左上角边界拟合圆角半径（物理像素）。"""
    k = fg.shape[0]
    points = []
    for y in range(1, min(k, int(r) + 8)):
        row = fg[y]
        # 连续 3 像素才算边界，避免抗锯齿/噪声
        run = row[:-2] & row[1:-1] & row[2:]
        xs = np.nonzero(run)[0]
        if xs.size:
            x = int(xs[0])
            if 0 < x < r + 6:
                points.append((x, y))
    if len(points) < 8:
        return {"measured": False, "points": len(points)}

    best_r, best_err, best_pts = None, float("inf"), 0
    for cand in np.arange(max(5.0, r - 10), r + 10, 0.25):
        errs = []
        used = 0
        for x, y in points:
            yy = y + 0.5
            if yy >= cand:
                pred = 0.0
            else:
                v = cand * cand - (cand - yy) ** 2
                pred = cand - math.sqrt(max(0.0, v))
            errs.append(abs(x - pred))
            used += 1
        if used:
            rms = math.sqrt(sum(e * e for e in errs) / used)
            if rms < best_err:
                best_r, best_err, best_pts = float(cand), rms, used
    # 边缘阶跃：沿 y 方向的 x 跳变
    steps = []
    ordered = sorted(points, key=lambda p: p[1])
    prev = None
    for x, _ in ordered:
        if prev is not None:
            steps.append(abs(x - prev))
        prev = x
    return {
        "measured": True,
        "radius_est": round(best_r, 2),
        "radius_err": round(best_err, 2),
        "points": best_pts,
        "max_step": max(steps) if steps else 0,
        "steps_ge3": sum(1 for s in steps if s >= 3),
    }


def analyze_corner(
    vis: np.ndarray,
    base: np.ndarray,
    diff: np.ndarray,
    name: str,
    wx: int,
    wy: int,
    ww: int,
    wh: int,
    r: int,
    region_on: bool,
) -> dict:
    pad = max(4, int(round(r)) + 12)
    win_vis = vis[wy : wy + wh, wx : wx + ww]
    win_base = base[wy : wy + wh, wx : wx + ww]
    win_diff = diff[wy : wy + wh, wx : wx + ww]
    k = min(pad, ww, wh, win_vis.shape[0], win_vis.shape[1])

    v = corner_view(win_vis, name, k).astype(int)
    b = corner_view(win_base, name, k).astype(int)
    d = corner_view(win_diff, name, k)
    ys, xs = np.mgrid[0:k, 0:k]
    px = xs + 0.5
    py = ys + 0.5

    # 左上角坐标下的圆角几何：圆心 (r, r)，半径 r
    outside = (px - r) ** 2 + (py - r) ** 2 > r * r
    outside &= (px < r) & (py < r)
    radial = np.sqrt((px - r) ** 2 + (py - r) ** 2) - r
    band = np.abs(radial) <= 2.5
    core_bg = outside & ~band
    ring_bg = outside & band

    lum_v = luminance(v)
    lum_b = luminance(b)
    dark = (v.max(axis=2) <= 85) & (lum_v < 80)

    transparent_ratio = (
        float((d[core_bg] <= 8).mean()) if core_bg.sum() >= 16 else None
    )
    bg_dark = int(dark[core_bg].sum()) + int(dark[ring_bg].sum())
    bg_diff_px = int((d[core_bg] > 12).sum())

    # 深色连通块只统计“窗口区域之外”的部分，避免深色主题的正文误报
    outside_mask = np.zeros_like(dark)
    outside_mask[core_bg | ring_bg] = dark[core_bg | ring_bg]
    comps = label_components(outside_mask)

    # 半径与阶跃：用与背景差异大的内容掩码（高对比背景运行）
    backdrop = np.array([b[0, 0, 0], b[0, 0, 1], b[0, 0, 2]])
    dist = np.abs(v - backdrop).max(axis=2)
    fg = (dist > 28) | (d > 18)
    fg = dilate(fg, 1)
    # 限制在窗口矩形内，避免把窗口外阴影当内容
    geom = measure_radius(fg, r)

    # 直边：1px 内侧描边、外侧 1~3px 阴影（只取中段，避开圆角）
    edge = {}
    if ww > 2 * r + 8 and wh > 2 * r + 8:
        for side in ("top", "bottom", "left", "right"):
            if side == "top":
                strip_v = win_vis[:4, r : ww - r]
                strip_b = win_base[:4, r : ww - r]
                inner = win_vis[1, r : ww - r]
                ref = win_vis[6, r : ww - r]
            elif side == "bottom":
                strip_v = win_vis[-4:, r : ww - r]
                strip_b = win_base[-4:, r : ww - r]
                inner = win_vis[-2, r : ww - r]
                ref = win_vis[-7, r : ww - r]
            elif side == "left":
                strip_v = win_vis[r : wh - r, :4]
                strip_b = win_base[r : wh - r, :4]
                inner = win_vis[r : wh - r, 1]
                ref = win_vis[r : wh - r, 6]
            else:
                strip_v = win_vis[r : wh - r, -4:]
                strip_b = win_base[r : wh - r, -4:]
                inner = win_vis[r : wh - r, -2]
                ref = win_vis[r : wh - r, -7]
            lum_delta = float(
                np.median(luminance(ref.astype(int)) - luminance(inner.astype(int)))
            )
            # 窗口外 1/2/3px：用可见帧与基线帧比较
            outs = {}
            for dist_px in (1, 2, 3):
                if side in ("top", "bottom"):
                    y = -dist_px if side == "top" else wh + dist_px - 1
                    if 0 <= y < vis.shape[0]:
                        vv = vis[wy + y, wx + r : wx + ww - r].astype(int)
                        bb = base[wy + y, wx + r : wx + ww - r].astype(int)
                        outs[f"d{dist_px}"] = round(
                            float(np.median(luminance(bb) - luminance(vv))), 1
                        )
                else:
                    x = -dist_px if side == "left" else ww + dist_px - 1
                    if 0 <= x < vis.shape[1]:
                        vv = vis[wy + r : wy + wh - r, wx + x].astype(int)
                        bb = base[wy + r : wy + wh - r, wx + x].astype(int)
                        outs[f"d{dist_px}"] = round(
                            float(np.median(luminance(bb) - luminance(vv))), 1
                        )
            edge[side] = {"inner_darken": round(lum_delta, 1), "outer": outs}

    return {
        "corner": name,
        "transparent_ratio": None if transparent_ratio is None else round(transparent_ratio, 4),
        "bg_diff_px": bg_diff_px,
        "bg_dark_px": bg_dark,
        "dark_components": comps[:5],
        "radius": geom,
        "edge": edge,
    }


def analyze_case(meta_path: Path) -> dict:
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:  # noqa: BLE001 - 报告原始错误
        return {"meta": str(meta_path), "status": "UNVERIFIED", "reasons": [f"meta 读取失败: {exc}"]}

    reasons: list[str] = []
    warnings: list[str] = []
    unverified: list[str] = []

    vis_path = resolve(meta["visible"], meta_path)
    base_path = resolve(meta["baseline"], meta_path)
    if not vis_path.exists() or not base_path.exists():
        return {
            "meta": str(meta_path),
            "status": "UNVERIFIED",
            "reasons": ["缺少可见帧或背景基线帧"],
        }

    vis_img = Image.open(vis_path).convert("RGB")
    base_img = Image.open(base_path).convert("RGB")
    if vis_img.size != base_img.size:
        return {"meta": str(meta_path), "status": "UNVERIFIED", "reasons": ["可见帧与基线尺寸不一致"]}

    vis = np.asarray(vis_img).astype(int)
    base = np.asarray(base_img).astype(int)
    diff = np.abs(vis - base).max(axis=2)

    cap = meta.get("capture", {})
    win = meta.get("window", {})
    wx = int(win.get("x", 0)) - int(cap.get("x", 0))
    wy = int(win.get("y", 0)) - int(cap.get("y", 0))
    ww, wh = int(win.get("w", 0)), int(win.get("h", 0))
    if ww <= 0 or wh <= 0 or wx < 0 or wy < 0 or wx + ww > vis.shape[1] or wy + wh > vis.shape[0]:
        return {
            "meta": str(meta_path),
            "status": "UNVERIFIED",
            "reasons": [f"窗口矩形不在抓图范围内: win=({wx},{wy},{ww},{wh}) capture={vis.shape[1]}x{vis.shape[0]}"],
        }

    expected_bg = parse_rgb(meta.get("backdrop")) or parse_rgb(meta.get("baseline_check", {}).get("expected"))
    baseline_valid = bool(meta.get("baseline_check", {}).get("valid"))
    if not baseline_valid:
        unverified.append("corner-lab 报告背景基线无效")
    if expected_bg is None:
        unverified.append("元数据缺少背景色")

    # 基线必须真是受控纯色：窗口外一圈（8..16px）与桌面/其它窗口无关
    if expected_bg is not None:
        ring = []
        for m in (8, 12, 16):
            if wy - m >= 0:
                ring.append(base[wy - m, wx + ww // 4 : wx + 3 * ww // 4])
            if wy + wh + m - 1 < vis.shape[0]:
                ring.append(base[wy + wh + m - 1, wx + ww // 4 : wx + 3 * ww // 4])
            if wx - m >= 0:
                ring.append(base[wy + wh // 4 : wy + 3 * wh // 4, wx - m])
            if wx + ww + m - 1 < vis.shape[1]:
                ring.append(base[wy + wh // 4 : wy + 3 * wh // 4, wx + ww + m - 1])
        if ring:
            ring_px = np.concatenate([r.reshape(-1, 3) for r in ring])
            close = (np.abs(ring_px - np.array(expected_bg)).max(axis=1) <= 4).mean()
            if close < 0.99:
                unverified.append(f"背景基线不是受控纯色（吻合率 {close:.3f}）")

    region_on = str(meta.get("region_env", "1")) != "0"
    dwm_env = str(meta.get("dwm_env", "1"))
    r_phys = meta.get("radius_phys")
    if r_phys is None:
        r_phys = round(float(meta.get("radius_logical", 18)) * float(meta.get("scale", 1.0)))
    r_phys = int(r_phys)

    # 原生几何：区域探测与 DWM 属性（像素判定的必要佐证，不单独构成 PASS）
    native = {
        "region_probe": meta.get("region_probe"),
        "dwm": meta.get("dwm", {}),
    }
    if region_on:
        probe = str(meta.get("region_probe", ""))
        if not probe.startswith("00001"):
            reasons.append(f"窗口区域四角未被裁剪（region_probe={probe}）")
        if "bounds=" in probe:
            try:
                bounds = probe.split("bounds=")[1].split()
                box = [int(v) for v in bounds[0].split(",")] if bounds else []
                if len(box) == 4 and (box[2] < ww or box[3] < wh):
                    reasons.append(f"区域尺寸小于窗口（{bounds[0]} vs {ww}x{wh}）")
            except Exception:  # noqa: BLE001
                pass
    else:
        warnings.append("Region=0（探索组合，不作为产品验收配置）")

    if dwm_env != "0":
        corner = int(native["dwm"].get("corner_preference", 0) or 0)
        if corner not in (1, 2):
            warnings.append(f"DWM 角偏好未生效（corner_preference={corner}）")
        border = native["dwm"].get("border_color")
        border_hr = native["dwm"].get("border_hr")
        if border_hr is None:
            # 旧采集没有记录 HRESULT，读到的 0 可能只是失败后的默认值。
            warnings.append("DWM 边框属性读取结果未记录（旧采集），以像素判定为准")
        elif border_hr != 0:
            # 该 Windows 版本对 DWMWA_BORDER_COLOR 的读取返回 E_INVALIDARG，
            # 读数为 0 不能当成“边框没去掉”；以像素判定为准。
            warnings.append(f"DWM 边框属性不可读（hr={border_hr}），以像素判定为准")
        elif border not in (-2, 4294967294, None):
            warnings.append(f"DWM 边框未去除（border_color={border}）")

    corners = []
    for name in CORNER_NAMES:
        c = analyze_corner(vis, base, diff, name, wx, wy, ww, wh, r_phys, region_on)
        corners.append(c)
        radius = c["radius"]
        # 圆角像素对每种组合都要测：Region=0 时由 DWM 圆角（或完全不圆）决定，
        # 这正是矩阵需要比较的事实，不能因为“探索组合”就跳过。
        if c["transparent_ratio"] is None:
            unverified.append(f"{name}: 背景核心区太小，无法判定透明度")
        elif c["transparent_ratio"] < 0.985:
            reasons.append(f"{name}: 圆角未透出背景（吻合 {c['transparent_ratio']:.3f}）")
        if c["bg_dark_px"] > 0:
            reasons.append(f"{name}: 圆角/弧带内存在 {c['bg_dark_px']} 个深色像素（黑边）")
        if c["bg_diff_px"] > 0:
            reasons.append(f"{name}: 圆角外仍有 {c['bg_diff_px']} 个像素不是背景（未裁净）")
        if not radius.get("measured"):
            unverified.append(f"{name}: 内容与背景对比不足，半径无法从像素测量")
        elif abs(radius["radius_est"] - r_phys) > 3.0:
            reasons.append(
                f"{name}: 实测圆角 {radius['radius_est']}px 与预期 {r_phys}px 不符"
            )
        if radius.get("measured") and radius.get("max_step", 0) > 4:
            reasons.append(f"{name}: 圆角边缘阶跃 {radius['max_step']}px 过大")

    # 直边描边/阴影：四个角已覆盖圆角，直边取各边中段的统计
    edge_stats = {}
    for side in ("top", "bottom", "left", "right"):
        vals = [c["edge"].get(side) for c in corners if c["edge"].get(side)]
        if vals:
            edge_stats[side] = {
                "inner_darken": round(float(np.median([v["inner_darken"] for v in vals])), 1),
                "outer": {
                    k: round(float(np.median([v["outer"].get(k, 0) for v in vals])), 1)
                    for k in ("d1", "d2", "d3")
                },
            }
    for side, stats in edge_stats.items():
        if stats["inner_darken"] > 25:
            reasons.append(f"{side} 边内侧存在深色描边（ΔL={stats['inner_darken']}）")
        if stats["outer"].get("d1", 0) > 25:
            reasons.append(f"{side} 边外 1px 存在深色描边/阴影（ΔL={stats['outer']['d1']}）")

    if not region_on:
        # 探索组合：即使像素干净也不算验收通过
        status = "OBSERVE" if not reasons else "FAIL"
    elif reasons:
        status = "FAIL"
    elif unverified:
        status = "UNVERIFIED"
    else:
        status = "PASS"

    return {
        "meta": str(meta_path),
        "status": status,
        "region": region_on,
        "dwm": dwm_env,
        "material": meta.get("material"),
        "glass_backend": meta.get("glass_backend"),
        "window": {"w": ww, "h": wh, "dpi": meta.get("dpi"), "scale": meta.get("scale")},
        "radius_expected_phys": r_phys,
        "native": native,
        "corners": corners,
        "edges": edge_stats,
        "reasons": reasons,
        "unverified": unverified,
        "warnings": warnings,
        "screenshots": {
            "visible": str(vis_path),
            "baseline": str(base_path),
            "reshow": str(resolve(meta.get("reshow", ""), meta_path)) if meta.get("reshow") else None,
        },
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 2
    summary = "--summary" in argv
    paths = [Path(a) for a in argv[1:] if not a.startswith("--")]
    if not paths:
        print(__doc__)
        return 2

    results = []
    for meta_path in paths:
        if meta_path.suffix.lower() == ".png":
            meta_path = meta_path.with_suffix(".json")
        result = analyze_case(meta_path)
        results.append(result)
        out = meta_path.with_name(meta_path.stem + "-analysis.json")
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{meta_path.name}: {result['status']}")
        for reason in result.get("reasons", []):
            print(f"    FAIL: {reason}")
        for reason in result.get("unverified", []):
            print(f"    UNVERIFIED: {reason}")
        if not summary:
            for c in result.get("corners", []):
                rad = c["radius"]
                rad_s = (
                    f"r={rad.get('radius_est')}px (err {rad.get('radius_err')})"
                    if rad.get("measured")
                    else "r=unmeasured"
                )
                print(
                    f"    {c['corner']:12s} transparent={c['transparent_ratio']} "
                    f"bg_diff={c['bg_diff_px']} bg_dark={c['bg_dark_px']} {rad_s}"
                )
            for side, stats in result.get("edges", {}).items():
                print(
                    f"    edge {side:6s} inner_darken={stats['inner_darken']} "
                    f"outer={stats['outer']}"
                )

    statuses = {r["status"] for r in results}
    if "FAIL" in statuses:
        return 1
    if "UNVERIFIED" in statuses:
        return 2
    if "OBSERVE" in statuses:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
