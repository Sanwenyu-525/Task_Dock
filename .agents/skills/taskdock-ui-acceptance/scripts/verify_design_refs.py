#!/usr/bin/env python3
"""Verify the design-reference manifest, candidate index, paths, and hashes.

This proves asset/metadata integrity only. It does not prove that a runtime
screenshot matches the design reference.

Backward compatibility: schema_version 1 items with only the original required
fields remain valid. `--strict` additionally requires module/spec/uncovered and
module directory consistency for newly imported approved baselines.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ALLOWED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,80}$")
MODULE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_MODULES = {
    "capsule",
    "dock",
    "panels",
    "clipboard",
    "agents",
    "notifications",
    "planning",
}
THEMES = {"light", "dark", "both"}
REQUIRED_FIELDS = ("id", "file", "source", "component", "state", "theme", "status", "sha256", "note")
CANDIDATE_REQUIRED = ("id", "source", "module", "component", "state", "theme", "status", "sha256", "note")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, label: str, errors: list[str]) -> dict:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"{label} 不是合法 JSON：{exc}")
        return {}
    if not isinstance(obj, dict) or obj.get("schema_version") != 1:
        errors.append(f"{label} 必须是 schema_version=1 的对象")
        return {}
    if not isinstance(obj.get("items"), list):
        errors.append(f"{label} 缺少 items 数组")
        return {}
    return obj


def check_hash(path: Path, expected: str, label: str, errors: list[str]) -> None:
    if not isinstance(expected, str) or not SHA_RE.fullmatch(expected):
        errors.append(f"{label} 的 sha256 不是 64 位小写十六进制")
        return
    if not path.is_file():
        return
    actual = sha256_file(path)
    if actual != expected:
        errors.append(f"{label} 哈希不一致：{actual} != {expected}")


def check_source(item: dict, repo: Path, label: str, strict: bool, errors: list[str]) -> None:
    source = item.get("source")
    if not isinstance(source, str) or not source.strip():
        errors.append(f"{label} 的 source 为空或不是字符串")
        return
    rel = Path(source)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        errors.append(f"{label} 的 source 必须是仓库内相对路径：{source}")
        return
    resolved = (repo / rel).resolve()
    if not resolved.is_relative_to(repo):
        errors.append(f"{label} 的 source 越出仓库：{source}")
        return
    if strict:
        docs_root = (repo / "docs" / "design-refs").resolve()
        if not resolved.is_relative_to(docs_root):
            errors.append(f"{label} 的 source 不在 docs/design-refs/ 下：{source}")
    if not resolved.is_file():
        errors.append(f"{label} 的 source 不存在：{source}")
        return
    check_hash(resolved, item.get("sha256"), label, errors)


def check_file(item: dict, root: Path, label: str, seen_files: set[str], errors: list[str]) -> None:
    filename = item.get("file")
    if not isinstance(filename, str) or not filename.strip():
        errors.append(f"{label} 的 file 为空或不是字符串")
        return
    rel = Path(filename)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        errors.append(f"{label} 的 file 必须是 assets/design-refs 内相对路径：{filename}")
        return
    if rel.suffix.lower() not in ALLOWED_SUFFIXES:
        errors.append(f"{label} 的 file 后缀不受支持：{filename}")
        return
    key = rel.as_posix()
    if key in seen_files:
        errors.append(f"{label} 的 file 重复：{key}")
        return
    seen_files.add(key)

    resolved = (root / rel).resolve()
    if not resolved.is_relative_to(root):
        errors.append(f"{label} 的 file 越出 design-refs：{filename}")
        return
    if not resolved.is_file():
        errors.append(f"{label} 的 file 不存在：{filename}")
        return
    check_hash(resolved, item.get("sha256"), label, errors)


def check_common_fields(item: dict, label: str, ids: set[str], errors: list[str]) -> None:
    item_id = item.get("id")
    if not isinstance(item_id, str) or not ID_RE.fullmatch(item_id):
        errors.append(f"{label} 的 id 非法：{item_id!r}")
    elif item_id in ids:
        errors.append(f"{label} 的 id 重复：{item_id}")
    else:
        ids.add(item_id)

    for key in ("component", "state", "note"):
        value = item.get(key)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{label} 的 {key} 为空或不是字符串")

    theme = item.get("theme")
    if theme not in THEMES:
        errors.append(f"{label} 的 theme 必须是 light/dark/both：{theme!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Task Dock 仓库根目录")
    parser.add_argument("--require-approved", action="store_true", help="approved 必须至少 1 条")
    parser.add_argument("--strict", action="store_true", help="要求 module/spec/uncovered 与模块目录一致")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    root = Path(__file__).resolve().parents[1] / "assets" / "design-refs"
    manifest_path = root / "manifest.json"
    candidates_path = root / "candidates.json"
    errors: list[str] = []

    if not root.is_dir():
        print(f"INTEGRITY_FAILED: 目录不存在：{root}", file=sys.stderr)
        return 2
    if not manifest_path.is_file():
        print(f"INTEGRITY_FAILED: 缺少 manifest.json：{manifest_path}", file=sys.stderr)
        return 2

    manifest = load_json(manifest_path, "manifest.json", errors)
    approved = manifest.get("items", []) if manifest else []
    ids: set[str] = set()
    seen_files: set[str] = set()

    for index, item in enumerate(approved):
        label = f"manifest.items[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} 不是对象")
            continue
        for key in REQUIRED_FIELDS:
            if key not in item:
                errors.append(f"{label} 缺少字段 {key}")
        check_common_fields(item, label, ids, errors)
        if item.get("status") != "approved":
            errors.append(f"{label} 的 status 必须为 approved：{item.get('status')!r}")
        check_source(item, repo, label, args.strict, errors)
        check_file(item, root, label, seen_files, errors)

        if args.strict:
            module = item.get("module")
            if not isinstance(module, str) or not module.strip():
                errors.append(f"{label} 缺少 module")
            elif not MODULE_RE.fullmatch(module):
                errors.append(f"{label} 的 module 非法：{module}")
            elif module not in ALLOWED_MODULES:
                errors.append(f"{label} 的 module 不在允许目录：{module}")
            else:
                filename = item.get("file")
                if isinstance(filename, str) and Path(filename).parts and Path(filename).parts[0] != module:
                    errors.append(f"{label} 的 file 目录与 module 不一致：{filename} != {module}/")
            for key in ("spec", "uncovered"):
                if not isinstance(item.get(key), str) or not item[key].strip():
                    errors.append(f"{label} 缺少 {key}")

    candidate_count = 0
    if candidates_path.exists():
        candidates = load_json(candidates_path, "candidates.json", errors)
        for index, item in enumerate(candidates.get("items", []) if candidates else []):
            label = f"candidates.items[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{label} 不是对象")
                continue
            candidate_count += 1
            for key in CANDIDATE_REQUIRED:
                if key not in item:
                    errors.append(f"{label} 缺少字段 {key}")
            check_common_fields(item, label, ids, errors)
            if item.get("status") != "candidate":
                errors.append(f"{label} 的 status 必须为 candidate：{item.get('status')!r}")
            if item.get("approved") is True:
                errors.append(f"{label} 不得标记 approved")
            if item.get("file"):
                errors.append(f"{label} 候选不得包含 file（不复制图片）")
            check_source(item, repo, label, True, errors)
            module = item.get("module")
            if not isinstance(module, str) or not MODULE_RE.fullmatch(module):
                errors.append(f"{label} 的 module 非法：{module!r}")
            if args.strict:
                for key in ("spec", "uncovered"):
                    if not isinstance(item.get(key), str) or not item[key].strip():
                        errors.append(f"{label} 缺少 {key}")

    if args.require_approved and not approved:
        errors.append("approved 为 0，但 --require-approved 要求至少 1 条")

    if errors:
        print("INTEGRITY_FAILED:")
        for message in errors:
            print(f" - {message}")
        return 1

    print(
        f"INTEGRITY_OK: approved={len(approved)}; candidates={candidate_count}; "
        f"files={len(seen_files)}; strict={'on' if args.strict else 'off'}"
    )
    print("说明：本校验只证明路径/哈希/ID/元数据完整，不证明视觉匹配或真机行为。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
