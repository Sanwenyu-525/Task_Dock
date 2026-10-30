"""圆角验收（几何法）：判断原生窗口四角是否「透出桌面」而不是黑色直角块。

原理：
- `native-*.png` 是窗口矩形的桌面合成像素；
- `native-*-context.png` 是同一时刻、窗口外扩 60px 的同一块屏幕；
- 因此窗口四角在 context 图中的对应位置，就是「透过圆角裁剪看到的桌面」；
- 若窗口角落像素与桌面像素几乎一致 → 圆角裁剪生效（四角透明）；
  若角落是一整块与桌面明显不同的深色 → 说明是 v0.5 的黑色直角缺陷。

用法：
    python scripts/check-corners.py docs/screenshots/v06/native-dream-light.png
"""

import sys
from pathlib import Path

from PIL import Image


def mean_abs_diff(a, b):
    pa = list(a.getdata())
    pb = list(b.getdata())
    n = min(len(pa), len(pb))
    total = 0.0
    for i in range(n):
        total += sum(abs(pa[i][j] - pb[i][j]) for j in range(3)) / 3.0
    return total / n


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    failures = []
    for path in sys.argv[1:]:
        p = Path(path)
        ctx_path = Path(str(p).replace(".png", "-context.png"))
        if not p.exists():
            print(f"{p.name}: MISSING")
            failures.append(p.name)
            continue
        if not ctx_path.exists():
            print(f"{p.name}: SKIP (缺少 {ctx_path.name}，无法做几何比对)")
            continue
        win = Image.open(p).convert("RGB")
        ctx = Image.open(ctx_path).convert("RGB")
        # context 图里窗口左上角的位置：context 宽 - 窗口宽 - 2*pad 的偏移不确定，
        # 直接用「窗口右下角在 context 中的位置」反推左上角偏移。
        pad = 60
        off_x = ctx.width - win.width - pad
        off_y = ctx.height - win.height - pad
        size = 6
        report = []
        for name, (cx, cy) in {
            "top-left": (0, 0),
            "top-right": (win.width - size, 0),
            "bottom-left": (0, win.height - size),
            "bottom-right": (win.width - size, win.height - size),
        }.items():
            win_blk = win.crop((cx, cy, cx + size, cy + size))
            ctx_blk = ctx.crop((cx + off_x, cy + off_y, cx + off_x + size, cy + off_y + size))
            diff = mean_abs_diff(win_blk, ctx_blk)
            report.append((name, round(diff, 2)))
        worst = max(d for _, d in report)
        status = "PASS" if worst < 12 else "FAIL"
        print(f"{p.name}: {status} worst_corner_diff_vs_desktop={worst}")
        for name, d in report:
            print(f"    {name:12s} diff={d}")
        if status == "FAIL":
            failures.append(p.name)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
