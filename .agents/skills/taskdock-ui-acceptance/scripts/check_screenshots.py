#!/usr/bin/env python3
"""Check screenshot manifest, PNG dimensions and optional light/dark coverage."""
import argparse
import json
from pathlib import Path
import struct
import sys

PNG = b'\x89PNG\r\n\x1a\n'


def dimensions(path: Path) -> tuple[int, int]:
    with path.open('rb') as f:
        header = f.read(24)
    if len(header) < 24 or header[:8] != PNG or header[12:16] != b'IHDR' or header[8:12] != b'\x00\x00\x00\x0d':
        raise ValueError('不是有效的 PNG 头/IHDR')
    width, height = struct.unpack('>II', header[16:24])
    if not (0 < width <= 30000 and 0 < height <= 30000):
        raise ValueError('PNG 尺寸异常')
    return width, height


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo', type=Path, default=Path('.'))
    ap.add_argument('--manifest', type=Path, required=True)
    ap.add_argument('--require-pair', action='store_true', help='每个视图/状态都要求 light 和 dark 两张图')
    args = ap.parse_args()
    repo = args.repo.resolve()
    manifest = args.manifest if args.manifest.is_absolute() else repo / args.manifest
    errors, entries, groups, used = [], [], {}, set()
    try:
        data = json.loads(manifest.read_text(encoding='utf-8-sig'))
        cases = data.get('cases') if isinstance(data, dict) else None
        if not isinstance(cases, list) or not cases:
            raise ValueError('cases 必须为非空数组')
        for i, case in enumerate(cases):
            if not isinstance(case, dict):
                errors.append(f'cases[{i}] 必须是对象')
                continue
            label = f'cases[{i}]'
            view, state, theme, channel, raw = (case.get(k) for k in ('view', 'state', 'theme', 'channel', 'path'))
            if not all(isinstance(x, str) and x.strip() for x in (view, state, theme, channel, raw)):
                errors.append(f'{label} 缺少 view/state/theme/channel/path 字符串')
                continue
            if theme not in ('light', 'dark') or channel not in ('B', 'C', 'E', 'F'):
                errors.append(f'{label} 主题必须 light/dark，截图通道必须 B/C/E/F')
            rel = Path(raw)
            path = (repo / rel).resolve()
            if rel.is_absolute() or not path.is_relative_to(repo):
                errors.append(f'{label} 文件不在仓库内: {raw}')
                continue
            if raw in used:
                errors.append(f'{label} 同一截图路径重复: {raw}')
            used.add(raw)
            try:
                width, height = dimensions(path)
                entries.append({'view': view, 'state': state, 'theme': theme,
                                'channel': channel, 'pixels': [width, height], 'path': raw})
            except (OSError, ValueError) as exc:
                errors.append(f'{label} 文件无法验证: {raw} ({exc})')
            groups.setdefault((view, state), set()).add(theme)
        if args.require_pair:
            for (view, state), themes in groups.items():
                if themes != {'light', 'dark'}:
                    errors.append(f'{view}/{state} 缺少主题：{sorted({"light", "dark"} - themes)}')
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        errors.append(str(exc))
    for e in errors:
        print('ERROR:', e, file=sys.stderr)
    print(json.dumps({'checked': len(entries), 'entries': entries, 'structural_errors': len(errors),
                      'note': '未判断视觉正确性、截图来源或原生交互'}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
