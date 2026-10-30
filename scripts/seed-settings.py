"""写入/读取 Task Dock 的本地设置（仅用于视觉验收，不参与产品逻辑）。

用法：
    python scripts/seed-settings.py <data_dir> [key=value ...]

例：
    python scripts/seed-settings.py %TEMP%\\taskdock-v06 visual_preset=liquid-glass theme=light

值按 JSON 编码写入 application_settings.value（与 Rust 端 set_setting 一致）：
字符串写成 "\"liquid-glass\""，布尔/数字原样。数据库不存在时直接报错退出。
"""

import json
import sqlite3
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    data_dir = Path(sys.argv[1])
    db = data_dir / "task-dock.db"
    if not db.exists():
        print(f"数据库不存在：{db}")
        return 1

    pairs = []
    for raw in sys.argv[2:]:
        if "=" not in raw:
            print(f"非法参数：{raw}（需要 key=value）")
            return 2
        key, value = raw.split("=", 1)
        if key == "window_rect":
            # 特殊形式：x,y,w,h（物理像素），与前端保存口径一致
            try:
                x, y, w, h = (int(v) for v in value.split(","))
            except ValueError:
                print("window_rect 需要 x,y,w,h 四个整数")
                return 2
            parsed = {"x": x, "y": y, "w": w, "h": h}
        else:
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                parsed = value  # 纯字符串按字面处理
        pairs.append((key, parsed))

    conn = sqlite3.connect(db)
    try:
        with conn:
            for key, value in pairs:
                conn.execute(
                    "INSERT INTO application_settings (key, value, updated_at) "
                    "VALUES (?, ?, datetime('now')) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                    (key, json.dumps(value, ensure_ascii=False)),
                )
        rows = conn.execute(
            "SELECT key, value FROM application_settings ORDER BY key"
        ).fetchall()
        for key, value in rows:
            if not pairs or key in {k for k, _ in pairs}:
                print(f"{key} = {value}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
