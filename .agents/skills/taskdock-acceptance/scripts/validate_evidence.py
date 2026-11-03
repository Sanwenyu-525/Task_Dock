#!/usr/bin/env python3
"""Validate evidence manifest structure and referenced local files (not truth)."""
import argparse
import json
from pathlib import Path
import sys

CHANNELS = set('ABCDEF')
STATUSES = {'PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'}


def validate(repo: Path, data: dict) -> list[str]:
    errors = []
    if not isinstance(data, dict) or not isinstance(data.get('task'), str) or not data['task'].strip():
        return ['task 必须为非空字符串']
    items = data.get('items')
    if not isinstance(items, list) or not items:
        return ['items 必须是非空数组']
    ids = set()
    for idx, obj in enumerate(items):
        name = f'items[{idx}]'
        if not isinstance(obj, dict):
            errors.append(f'{name} 必须是对象')
            continue
        for field in ('id', 'goal', 'action', 'observation', 'boundary'):
            if not isinstance(obj.get(field), str) or not obj[field].strip():
                errors.append(f'{name}.{field} 必须为非空字符串')
        item_id = obj.get('id')
        if isinstance(item_id, str):
            if item_id in ids:
                errors.append(f'{name}.id 重复: {item_id}')
            ids.add(item_id)
        channels = obj.get('channels')
        if not isinstance(channels, list) or not channels or any(not isinstance(ch, str) or ch not in CHANNELS for ch in channels):
            errors.append(f'{name}.channels 必须为 A–F 的非空数组')
        status = obj.get('status')
        if not isinstance(status, str) or status not in STATUSES:
            errors.append(f'{name}.status 仅允许 {sorted(STATUSES)}')
        paths = obj.get('evidence_paths', [])
        if not isinstance(paths, list) or any(not isinstance(p, str) or not p.strip() for p in paths):
            errors.append(f'{name}.evidence_paths 必须为非空路径字符串的数组')
            paths = []
        for p in paths:
            rel = Path(p)
            dest = (repo / rel).resolve()
            if rel.is_absolute() or not dest.is_relative_to(repo):
                errors.append(f'{name} 证据路径越界: {p}')
            elif not dest.is_file():
                errors.append(f'{name} 证据文件不存在: {p}')
        has_run = isinstance(obj.get('command'), str) and bool(obj['command'].strip()) and isinstance(obj.get('exit_code'), int) and not isinstance(obj.get('exit_code'), bool)
        if status in {'PASS', 'FAIL'} and not paths and not has_run:
            errors.append(f'{name} 已验证条目须有证据文件或实际执行的 command + exit_code')
        if status == 'BLOCKED' and (not isinstance(obj.get('block_reason'), str) or not obj['block_reason'].strip()):
            errors.append(f'{name} BLOCKED 必须提供 block_reason')
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo', type=Path, default=Path('.'))
    ap.add_argument('--manifest', type=Path, required=True)
    args = ap.parse_args()
    repo = args.repo.resolve()
    path = args.manifest if args.manifest.is_absolute() else repo / args.manifest
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        errors = validate(repo, data)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f'INVALID_MANIFEST: {exc}', file=sys.stderr)
        return 2
    if errors:
        for e in errors:
            print('ERROR:', e, file=sys.stderr)
        return 1
    print(f"STRUCTURE_OK: {len(data['items'])} 个条目；仅验证字段/路径，未验证真实性")
    return 0


if __name__ == '__main__':
    sys.exit(main())
