#!/usr/bin/env python3
"""Import an explicitly approved design reference from docs/design-refs/ into this Skill.

Safety:
- Default is dry-run. A writes require both --apply and --approved.
- Only images under docs/design-refs/ are accepted; never imports tmp/acceptance outputs.
- Never overwrites an existing ID or destination file; re-running an identical
  command is idempotent and reports ALREADY_IMPORTED.
- --candidate registers a non-approved reference in candidates.json without
  copying the image; candidates never enter the approved manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import tempfile
from pathlib import Path

ALLOWED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,80}$")
MODULE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
COMPARE_FIELDS = (
    "source",
    "module",
    "component",
    "state",
    "theme",
    "status",
    "sha256",
    "note",
    "spec",
    "uncovered",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_media(path: Path) -> tuple[str, int, int]:
    """Validate the image header without decoding pixels."""
    data = path.read_bytes()
    if len(data) > 16 * 1024 * 1024:
        raise ValueError("图片体积超过 16MiB，拒绝自动导入")

    suffix = path.suffix.lower()
    if suffix == ".png":
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("扩展名为 .png 但文件头不是 PNG")
        width, height = struct.unpack(">II", data[16:24])
    elif suffix in {".jpg", ".jpeg"}:
        if not data.startswith(b"\xff\xd8"):
            raise ValueError("扩展名为 .jpg/.jpeg 但文件头不是 JPEG")
        width, height = 0, 0
    elif suffix == ".webp":
        if not data.startswith(b"RIFF") or data[8:12] != b"WEBP":
            raise ValueError("扩展名为 .webp 但文件头不是 WebP")
        width, height = 0, 0
    else:
        raise ValueError(f"不支持的图片格式：{suffix}")
    return suffix, width, height


def load_json_file(path: Path, label: str) -> dict:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} 不是合法 JSON：{exc}") from exc
    return obj


def load_manifest(path: Path) -> dict:
    obj = load_json_file(path, "manifest.json")
    if not isinstance(obj, dict) or obj.get("schema_version") != 1:
        raise ValueError("manifest.json 必须是 schema_version=1 的对象")
    if not isinstance(obj.get("items"), list):
        raise ValueError("manifest.json 缺少 items 数组")
    return obj


def load_candidates(path: Path) -> dict:
    if not path.exists():
        return {"schema_version": 1, "items": []}
    obj = load_json_file(path, "candidates.json")
    if not isinstance(obj, dict) or obj.get("schema_version") != 1:
        raise ValueError("candidates.json 必须是 schema_version=1 的对象")
    if not isinstance(obj.get("items"), list):
        raise ValueError("candidates.json 缺少 items 数组")
    return obj


def write_json_atomic(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-", suffix=".tmp")
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(obj, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def same_record(existing: dict, record: dict) -> bool:
    return all(existing.get(key) == record.get(key) for key in COMPARE_FIELDS)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Task Dock 仓库根目录")
    parser.add_argument("--source", required=True, help="docs/design-refs 下的源图片路径（相对仓库根）")
    parser.add_argument("--id", required=True, help="唯一基准 ID，小写短横线")
    parser.add_argument("--module", default="", help="模块目录名，如 dock / panels / notifications")
    parser.add_argument("--component", required=True, help="组件名，如 capsule-dock / task-card")
    parser.add_argument("--state", required=True, help="UI 状态，如 expanded-tasks")
    parser.add_argument("--theme", required=True, choices=["light", "dark", "both"])
    parser.add_argument("--note", required=True, help="对应规范说明或批准依据")
    parser.add_argument("--spec", default="", help="关联规范文档（相对仓库根）")
    parser.add_argument("--uncovered", default="", help="该图未覆盖的场景")
    parser.add_argument("--approved", action="store_true", help="声明为正式视觉基准；写入必填")
    parser.add_argument("--candidate", action="store_true", help="登记为候选，不复制图片、不进入正式清单")
    parser.add_argument("--apply", action="store_true", help="真正写入；缺省只预览")
    args = parser.parse_args()

    try:
        repo = Path(args.repo).resolve()
        target_root = Path(__file__).resolve().parents[1] / "assets" / "design-refs"
        manifest_path = target_root / "manifest.json"
        candidates_path = target_root / "candidates.json"

        source_arg = Path(args.source)
        if source_arg.is_absolute():
            raise ValueError("--source 必须是相对仓库根的路径")
        source = (repo / source_arg).resolve()
        docs_root = (repo / "docs" / "design-refs").resolve()
        if not source.is_relative_to(docs_root):
            raise ValueError("只允许导入 docs/design-refs/ 下的设计图")
        if not source.is_file():
            raise ValueError(f"源图片不存在：{source_arg.as_posix()}")

        if not target_root.is_dir():
            raise ValueError(f"目标目录不存在：{target_root}")

        if not ID_RE.fullmatch(args.id):
            raise ValueError("--id 必须为 3-81 位小写字母、数字或短横线")
        module = args.module.strip()
        if module and not MODULE_RE.fullmatch(module):
            raise ValueError("--module 必须为小写字母、数字、下划线或短横线，最长 32 位")
        if args.candidate and args.approved:
            raise ValueError("--candidate 与 --approved 不能同时使用")

        suffix, width, height = inspect_media(source)
        digest = sha256_file(source)
        if not SHA_RE.fullmatch(digest):
            raise ValueError("SHA256 计算异常")

        manifest = load_manifest(manifest_path)
        candidates = load_candidates(candidates_path)
        approved_ids = {item.get("id") for item in manifest["items"] if isinstance(item, dict)}
        candidate_ids = {item.get("id") for item in candidates["items"] if isinstance(item, dict)}

        source_rel = source.relative_to(repo).as_posix()
        base_record = {
            "source": source_rel,
            "module": module,
            "component": args.component.strip(),
            "state": args.state.strip(),
            "theme": args.theme,
            "sha256": digest,
            "note": args.note.strip(),
            "spec": args.spec.strip(),
            "uncovered": args.uncovered.strip(),
        }

        if args.candidate:
            record = {"id": args.id, **base_record, "status": "candidate"}
            existing = next(
                (item for item in candidates["items"] if isinstance(item, dict) and item.get("id") == args.id),
                None,
            )
            if existing is not None:
                if same_record(existing, record):
                    print(f"ALREADY_REGISTERED: {args.id}（元数据一致，未重复创建）")
                    return 0
                raise ValueError(f"候选 ID 已存在且元数据不同，禁止静默覆盖：{args.id}")
            if args.id in approved_ids:
                raise ValueError(f"ID 已被正式基准占用，不能登记为候选：{args.id}")

            print(json.dumps({
                "mode": "candidate",
                "record": record,
                "source_bytes": source.stat().st_size,
                "source_size": [width, height],
            }, ensure_ascii=False, indent=2))
            if not args.apply:
                print("DRY_RUN_ONLY: 未写入候选索引；确认后使用 --candidate --apply")
                return 0

            candidates["items"].append(record)
            write_json_atomic(candidates_path, candidates)
            print(f"CANDIDATE_REGISTERED: {args.id} -> {candidates_path}")
            print("注意：候选不参与强制视觉验收，也不标记 approved。")
            return 0

        if args.id in candidate_ids:
            raise ValueError(f"ID 已存在于候选索引，不能作为正式基准导入：{args.id}")

        existing = next(
            (item for item in manifest["items"] if isinstance(item, dict) and item.get("id") == args.id),
            None,
        )
        dest_dir = target_root / module if module else target_root
        dest = dest_dir / f"{args.id}{suffix}"
        file_rel = f"{module}/{dest.name}" if module else dest.name
        record = {
            "id": args.id,
            "file": file_rel,
            **base_record,
            "status": "approved",
        }

        if existing is not None:
            if same_record(existing, record):
                print(f"ALREADY_IMPORTED: {args.id}（记录与哈希一致，未重复创建）")
                return 0
            raise ValueError(f"同 ID 基准已存在且元数据不同，禁止静默覆盖：{args.id}")

        if dest.exists():
            raise ValueError(f"目标文件已存在，禁止覆盖：{file_rel}")

        print(json.dumps({
            "mode": "approved",
            "record": record,
            "source_bytes": source.stat().st_size,
            "source_size": [width, height],
        }, ensure_ascii=False, indent=2))
        if not args.apply:
            print("DRY_RUN_ONLY: 无文件修改；查看源图片并明确批准后使用 --apply --approved")
            return 0
        if not args.approved:
            raise ValueError("写入正式基准必须显式传入 --approved")
        if not module:
            raise ValueError("正式基准必须指定 --module，以便按模块归档")

        created = False
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with source.open("rb") as inp:
                with dest.open("xb") as out:
                    created = True
                    shutil.copyfileobj(inp, out)

            copied_digest = sha256_file(dest)
            if copied_digest != digest:
                raise ValueError(f"复制后哈希不一致：{copied_digest} != {digest}")

            manifest["items"].append(record)
            write_json_atomic(manifest_path, manifest)
        except Exception:
            if created and dest.exists():
                dest.unlink()
            raise

        print(f"IMPORTED: {args.id} -> {file_rel}")
        print(f"MANIFEST: {manifest_path}（approved={len(manifest['items'])}）")
        return 0
    except (OSError, ValueError, UnicodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
