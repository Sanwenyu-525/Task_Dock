"""Self-test for check-corners.py using synthetic composited frames.

The acceptance analyzer is the thing that once produced a false PASS, so it
needs its own regression test that does not depend on a desktop session:

- a clean rounded window over a controlled backdrop must PASS;
- an opaque square window (black wedges) must FAIL;
- a clean frame with an invalid or missing baseline must be UNVERIFIED,
  never PASS.

The images are generated with PIL: the visible frame draws the "window" over
the backdrop colour, the baseline frame is only the backdrop. This mirrors the
real visible/hidden capture pair produced by corner-lab.ps1.

Run: python scripts/test-check-corners.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_corners", ROOT / "check-corners.py")
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

BACKDROP = (0, 255, 0)
FACE = (246, 244, 253)
WIN = (40, 40, 120, 120)  # x, y, w, h inside a 200x200 capture
RADIUS = 23
CAPTURE = (200, 200)


def make_frames(tmp: Path, rounded: bool) -> tuple[Path, Path]:
    base = Image.new("RGB", CAPTURE, BACKDROP)
    vis = base.copy()
    draw = ImageDraw.Draw(vis)
    x, y, w, h = WIN
    if rounded:
        draw.rounded_rectangle([x, y, x + w - 1, y + h - 1], radius=RADIUS, fill=FACE)
    else:
        draw.rectangle([x, y, x + w - 1, y + h - 1], fill=FACE)
    vis_path = tmp / "visible.png"
    base_path = tmp / "baseline.png"
    vis.save(vis_path)
    base.save(base_path)
    return vis_path, base_path


def make_meta(
    tmp: Path,
    vis: Path,
    base: Path,
    *,
    valid: bool = True,
    region: str = "1",
    missing_baseline: bool = False,
) -> Path:
    x, y, w, h = WIN
    meta = {
        "visible": str(vis),
        "baseline": str(base if not missing_baseline else tmp / "does-not-exist.png"),
        "reshow": str(vis),
        "window": {"x": x, "y": y, "w": w, "h": h},
        "capture": {"x": 0, "y": 0, "w": CAPTURE[0], "h": CAPTURE[1]},
        "dpi": 96,
        "scale": 1.0,
        "radius_logical": RADIUS,
        "radius_phys": RADIUS,
        "region_probe": "00001 bounds=0,0,121,121" if region == "1" else "no-region",
        "region_env": region,
        "dwm_env": "1",
        "dwm": {
            "corner_preference": 2,
            "system_backdrop": 1,
            "border_color": -2,
            "border_hr": 0,
            "dark_mode": 0,
            "nc_policy": 0,
        },
        "material": "solid",
        "glass_backend": "auto",
        "backdrop": {"r": BACKDROP[0], "g": BACKDROP[1], "b": BACKDROP[2]},
        "baseline_check": {
            "expected": "%d,%d,%d" % BACKDROP,
            "corner_px": "%d,%d,%d" % BACKDROP,
            "far_px": "%d,%d,%d" % BACKDROP,
            "valid": valid,
        },
    }
    path = tmp / "meta.json"
    path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return path


def run_case(name: str, rounded: bool, *, valid: bool = True, missing_baseline: bool = False, region: str = "1"):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        vis, base = make_frames(tmp, rounded)
        meta = make_meta(tmp, vis, base, valid=valid, region=region, missing_baseline=missing_baseline)
        result = cc.analyze_case(meta)
    print(
        f"{name}: status={result['status']} "
        f"reasons={len(result.get('reasons', []))} unverified={len(result.get('unverified', []))}"
    )
    return result


def main() -> int:
    failures = []

    clean = run_case("clean-rounded", True)
    if clean["status"] != "PASS":
        failures.append(f"clean rounded frame should PASS, got {clean['status']}: {clean['reasons']}")

    black = run_case("square-black-wedges", False)
    if black["status"] != "FAIL":
        failures.append(f"opaque square frame should FAIL, got {black['status']}")

    invalid = run_case("invalid-baseline", True, valid=False)
    if invalid["status"] == "PASS":
        failures.append("invalid baseline must never PASS")

    missing = run_case("missing-baseline", True, missing_baseline=True)
    if missing["status"] == "PASS":
        failures.append("missing baseline must never PASS")

    dwm_only = run_case("dwm-only-rounded", True, region="0")
    if dwm_only["status"] == "PASS":
        failures.append("exploratory region=0 cell must not be reported as product PASS")

    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("OK: analyzer verdicts match expectations")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
