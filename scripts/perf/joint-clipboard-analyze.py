#!/usr/bin/env python3
"""P1-05 联合负载对账：真实剪贴板激励 ↔ 数据库 ↔ 应用日志 ↔ 运行时统计。

为什么要对账而不是各看各的：
  激励器只知道自己写成功，数据库只知道落了什么，日志只知道发生了什么；
  只有把三者按序号/时间戳对齐，才能证明「真实 WM_CLIPBOARDUPDATE 被采集」，
  而不是「写了但没采到」或「采到了但不是这次激励」。

用法：
  python scripts/perf/joint-clipboard-analyze.py \
    --data-dir <隔离数据目录> \
    --stimulus DIAG-...-stimulus.json --load DIAG-...-load.json \
    --meta DIAG-...-meta.json --app-log DIAG-...-app.log \
    --lock-sampler <lock-sampler.jsonl> --out analysis-....json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")
TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)")
RECORD = re.compile(r"剪贴板记录：kind=(\w+) size=(\d+) created=(true|false) grouped=(true|false)")
PROBE = re.compile(r"^taskdock-p1-05-clipboard-probe-(\d+)$")


def iso_to_dt(value: str) -> datetime | None:
    if not value:
        return None
    v = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(v)
    except ValueError:
        return None


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    if not path:
        return rows
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return rows


def analyze_db(data_dir: Path) -> dict:
    db_path = data_dir / "task-dock.db"
    out = {"db_path": str(db_path), "exists": db_path.exists()}
    if not db_path.exists():
        return out
    con = sqlite3.connect(db_path)
    try:
        out["items_by_kind"] = {
            k: n for k, n in con.execute("select kind, count(*) from clipboard_items group by kind")
        }
        out["items_total"] = con.execute("select count(*) from clipboard_items").fetchone()[0]
        out["byte_size_sum"] = con.execute("select coalesce(sum(byte_size),0) from clipboard_items").fetchone()[0]
        out["created_at_min"], out["created_at_max"] = con.execute(
            "select min(created_at), max(created_at) from clipboard_items"
        ).fetchone()
        out["groups"] = [
            {"name": r[0], "mode": r[1], "status": r[2], "items": r[3]}
            for r in con.execute(
                "select g.name, g.mode, g.status, count(gi.item_id) "
                "from clipboard_groups g left join clipboard_group_items gi on gi.group_id=g.id "
                "group by g.id"
            )
        ]
        out["group_items"] = con.execute("select count(*) from clipboard_group_items").fetchone()[0]
        out["group_origin"] = {
            o: n for o, n in con.execute("select origin, count(*) from clipboard_group_items group by origin")
        }
        out["assets_by_role"] = {
            role: {"n": n, "bytes": b}
            for role, n, b in con.execute(
                "select role, count(*), coalesce(sum(byte_size),0) from clipboard_assets group by role"
            )
        }
        out["assets_missing"] = con.execute(
            "select count(*) from clipboard_items i where i.kind='image' and not exists "
            "(select 1 from clipboard_assets a where a.item_id=i.id and a.role='image')"
        ).fetchone()[0]
        out["texts"] = con.execute(
            "select id, text, created_at, source_app from clipboard_items where kind='text' order by created_at"
        ).fetchall()
        out["images"] = con.execute(
            "select id, created_at, source_app, image_width, image_height, byte_size "
            "from clipboard_items where kind='image' order by created_at"
        ).fetchall()
    finally:
        con.close()
    return out


def analyze_log(path: Path) -> dict:
    out = {
        "path": str(path),
        "exists": path.exists(),
        "recorded": 0,
        "recorded_created_false": 0,
        "recorded_by_kind": {},
        "skipped": 0,
        "dropped": 0,
        "superseded": 0,
        "mismatch": 0,
        "store_failed": 0,
        "config_unreliable": 0,
        "record_times": [],
        "first_record_at": None,
        "last_record_at": None,
    }
    if not path.exists():
        return out
    kinds: dict[str, int] = {}
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = ANSI.sub("", raw)
            if "剪贴板记录：" in line:
                m = RECORD.search(line)
                if m:
                    out["recorded"] += 1
                    kind = m.group(1)
                    kinds[kind] = kinds.get(kind, 0) + 1
                    if m.group(3) == "false":
                        out["recorded_created_false"] += 1
                    t = TS.match(line)
                    if t:
                        out["record_times"].append((kind, t.group(1)))
                continue
            if "剪贴板跳过：" in line:
                out["skipped"] += 1
            elif "剪贴板丢弃：" in line:
                out["dropped"] += 1
            elif "剪贴板事件已覆盖：" in line:
                out["superseded"] += 1
            elif "剪贴板内容不一致：" in line:
                out["mismatch"] += 1
            elif "剪贴板入库失败" in line:
                out["store_failed"] += 1
            elif "剪贴板配置不可靠" in line:
                out["config_unreliable"] += 1
    out["recorded_by_kind"] = kinds
    if out["record_times"]:
        out["first_record_at"] = out["record_times"][0][1]
        out["last_record_at"] = out["record_times"][-1][1]
    return out


def match_latency(db: dict, stimulus: dict) -> dict:
    start = iso_to_dt(stimulus.get("started_at") or "")
    interval = stimulus.get("text_interval_s")
    result = {
        "scheduled_from": stimulus.get("started_at"),
        "interval_s": interval,
        "text": {},
        "image": {},
        "note": "延迟 = 数据库 created_at − 激励计划写入时刻；激励循环按 next_at += interval 计划写入",
    }
    if start is None or not interval:
        result["note"] = "缺少 started_at/interval，跳过延迟估算"
        return result
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)

    texts = db.get("texts") or []
    by_index: dict[int, list[datetime]] = {}
    extras = []
    for _id, text, created, _src in texts:
        created_dt = iso_to_dt(created)
        m = PROBE.match(text or "")
        if m and created_dt:
            by_index.setdefault(int(m.group(1)), []).append(created_dt)
        else:
            extras.append({"text_prefix": (text or "")[:24], "created_at": created})

    text_lat, missing, duplicated = [], [], []
    expected_text = stimulus.get("text_ok", 0)
    for k in range(1, expected_text + 1):
        stamps = by_index.get(k)
        if not stamps:
            missing.append(k)
            continue
        if len(stamps) > 1:
            duplicated.append(k)
        scheduled = start.timestamp() + (k - 1) * interval
        text_lat.append((stamps[0].timestamp() - scheduled) * 1000)
    result["text"] = {
        "expected": expected_text,
        "matched": len(text_lat),
        "missing": len(missing),
        "missing_examples": missing[:10],
        "duplicated_indexes": len(duplicated),
        "extra_rows": len(extras),
        "extra_examples": extras[:5],
        "latency_ms": {
            "p50": round(percentile(text_lat, 0.5), 2) if text_lat else None,
            "p95": round(percentile(text_lat, 0.95), 2) if text_lat else None,
            "max": round(max(text_lat), 2) if text_lat else None,
            "min": round(min(text_lat), 2) if text_lat else None,
            "negative": sum(1 for v in text_lat if v < 0),
        },
    }

    images = db.get("images") or []
    expected_img = stimulus.get("image_ok", 0)
    img_lat = []
    for idx, row in enumerate(images[:expected_img], start=1):
        created_dt = iso_to_dt(row[1])
        if not created_dt:
            continue
        scheduled = start.timestamp() + (idx * 10 - 1) * interval
        img_lat.append((created_dt.timestamp() - scheduled) * 1000)
    result["image"] = {
        "expected": expected_img,
        "matched": len(img_lat),
        "missing": max(0, expected_img - len(images)),
        "extra_rows": max(0, len(images) - expected_img),
        "latency_ms": {
            "p50": round(percentile(img_lat, 0.5), 2) if img_lat else None,
            "p95": round(percentile(img_lat, 0.95), 2) if img_lat else None,
            "max": round(max(img_lat), 2) if img_lat else None,
            "min": round(min(img_lat), 2) if img_lat else None,
            "negative": sum(1 for v in img_lat if v < 0),
        },
    }
    return result


def analyze_lock_sampler(path: Path | None) -> dict:
    out = {"path": str(path) if path else None, "samples": 0, "owned": 0, "owners": {}}
    if not path:
        return out
    rows = read_jsonl(path)
    owners: dict[str, int] = {}
    for r in rows:
        if "owner" not in r:
            continue
        out["samples"] += 1
        owner = r.get("owner") or None
        if owner:
            out["owned"] += 1
            key = f"{owner.get('exe')}:{owner.get('pid')}"
            owners[key] = owners.get(key, 0) + 1
    out["owners"] = owners
    return out


def compact_runtime(meta: dict) -> dict:
    stats = meta.get("stats_end_of_load") or {}
    summary = meta.get("summary") or {}
    pick = ("taskdock_private_mb", "taskdock_ws_mb", "taskdock_threads", "taskdock_handles",
            "webview2_private_mb", "rust_live_bytes", "rust_peak_bytes")
    return {
        "instance_exited_after_s": meta.get("instance_exited_after_s"),
        "other_task_dock_instances": meta.get("other_task_dock_instances"),
        "notifications": stats.get("notifications"),
        "http": stats.get("http"),
        "pipeline": stats.get("pipeline"),
        "db": stats.get("db"),
        "runtime": stats.get("runtime"),
        "sampler": {k: summary.get(k) for k in pick},
        "slopes": {
            k: v for k, v in summary.items() if str(k).startswith("slope_")
        },
    }


def verify_stored_png(data_dir: Path, db: dict) -> dict:
    """库内图片资产是否与激励器写进剪贴板的 PNG 字节一致（含 Alpha）。

    激励器 PNG 由确定性 zlib 生成，同样的 seed 必然得到同样的字节；
    因此 sha256 相等即可证明「存下来的就是当时真实写入剪贴板的那张图」，
    同时覆盖 Alpha 通道（半透明/全透明像素都在图里）。
    """
    import hashlib
    import importlib.util

    out = {"checked": 0, "matched": 0, "mismatched": [], "missing_files": [], "expected": 0}
    stimulus_py = Path(__file__).resolve().parent.parent / "acceptance" / "clipboard_stimulus.py"
    if not stimulus_py.exists():
        out["error"] = f"找不到激励器：{stimulus_py}"
        return out
    spec = importlib.util.spec_from_file_location("clipboard_stimulus", stimulus_py)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    build = getattr(mod, "build_png_rgba", None)
    if build is None:
        out["error"] = "激励器没有 build_png_rgba"
        return out

    db_path = data_dir / "task-dock.db"
    if not db_path.exists():
        out["error"] = "数据库不存在"
        return out
    con = sqlite3.connect(db_path)
    try:
        images = con.execute(
            "select i.id, i.image_width, i.image_height, a.path "
            "from clipboard_items i join clipboard_assets a on a.item_id=i.id and a.role='image' "
            "where i.kind='image' order by i.created_at"
        ).fetchall()
    finally:
        con.close()

    expected = {}
    for idx in range(1, len(images) + 1):
        png = build(120, 80, idx)
        expected[hashlib.sha256(png).hexdigest()] = idx
    out["expected"] = len(expected)
    for item_id, width, height, rel in images:
        # 资产根是 <数据目录>/clipboard（store::root），不是数据目录本身
        path = data_dir / rel
        if not path.exists():
            path = data_dir / "clipboard" / rel
        if not path.exists():
            out["missing_files"].append(str(path))
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        out["checked"] += 1
        if digest in expected:
            out["matched"] += 1
            if (width, height) != (120, 80):
                out["mismatched"].append({"item": item_id, "reason": f"尺寸 {width}x{height} 不是 120x80"})
        else:
            out["mismatched"].append({"item": item_id, "sha256": digest[:16], "size": path.stat().st_size})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, type=Path)
    ap.add_argument("--stimulus", required=True, type=Path)
    ap.add_argument("--load", required=True, type=Path)
    ap.add_argument("--meta", required=True, type=Path)
    ap.add_argument("--app-log", required=True, type=Path)
    ap.add_argument("--lock-sampler", type=Path)
    ap.add_argument("--verify-png", action="store_true")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    stimulus = load_json(args.stimulus) or {}
    load = load_json(args.load) or {}
    meta = load_json(args.meta) or {}

    db = analyze_db(args.data_dir)
    log = analyze_log(args.app_log)
    latency = match_latency(db, stimulus)
    lock = analyze_lock_sampler(args.lock_sampler)

    expected_events = int(stimulus.get("text_ok", 0)) + int(stimulus.get("image_ok", 0))
    db_items = int(db.get("items_total") or 0)
    seq = {
        "start": stimulus.get("clipboard_sequence_start"),
        "end": stimulus.get("clipboard_sequence_end"),
        "delta": stimulus.get("clipboard_sequence_delta"),
        "expected_writes": expected_events,
        "writes_per_update": round(stimulus.get("clipboard_sequence_delta", 0) / expected_events, 2)
        if expected_events else None,
    }

    report = {
        "scenario": "p1-05-joint-clipboard",
        "stimulus": stimulus,
        "load": {
            "elapsed_ms": load.get("elapsed_ms"),
            "actual_rate": load.get("actual_rate"),
            "counts": load.get("counts"),
            "latency_ms": load.get("latency_ms"),
        },
        "db": {k: v for k, v in db.items() if k not in ("texts", "images")},
        "app_log": {k: v for k, v in log.items() if k != "record_times"},
        "reconciliation": {
            "stimulus_events": expected_events,
            "db_items": db_items,
            "db_minus_stimulus": db_items - expected_events,
            "log_recorded": log.get("recorded"),
            "log_recorded_created_false": log.get("recorded_created_false"),
            "skipped": log.get("skipped"),
            "dropped": log.get("dropped"),
            "superseded": log.get("superseded"),
            "mismatch": log.get("mismatch"),
            "store_failed": log.get("store_failed"),
            "config_unreliable": log.get("config_unreliable"),
            "sequence": seq,
        },
        "ingestion_latency": latency,
        "lock_sampler": lock,
        "png_verify": verify_stored_png(args.data_dir, db) if args.verify_png else None,
        "runtime": compact_runtime(meta),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    r = report["reconciliation"]
    print(f"激励事件 {expected_events}（text={stimulus.get('text_ok')} image={stimulus.get('image_ok')}）")
    print(f"数据库 {db_items}（差值 {r['db_minus_stimulus']}）；日志记录 {log.get('recorded')}"
          f"（created=false {log.get('recorded_created_false')}）")
    print(f"跳过 {r['skipped']} / 丢弃 {r['dropped']} / 覆盖 {r['superseded']} / 入库失败 {r['store_failed']}")
    print(f"序列号 delta={seq['delta']} ≈ {seq['writes_per_update']} 次系统写入/事件")
    for kind in ("text", "image"):
        lat = latency.get(kind) or {}
        ms = lat.get("latency_ms") or {}
        print(f"{kind}: 匹配 {lat.get('matched')}/{lat.get('expected')}，缺失 {lat.get('missing')}，"
              f"多余 {lat.get('extra_rows')}，p50={ms.get('p50')}ms p95={ms.get('p95')}ms max={ms.get('max')}ms")
    print(f"OpenClipboard 采样 {lock['samples']}，被占用 {lock['owned']}，占用方 {lock['owners']}")
    png = report.get("png_verify")
    if png is not None:
        print(f"PNG 字节比对：{png.get('matched')}/{png.get('checked')} 与激励字节一致，"
              f"差异 {len(png.get('mismatched') or [])}，缺失文件 {len(png.get('missing_files') or [])}")
    print(f"输出：{args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
