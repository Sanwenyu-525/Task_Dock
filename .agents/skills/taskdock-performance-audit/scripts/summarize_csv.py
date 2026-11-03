#!/usr/bin/env python3
"""Summarize numeric columns in an EXISTING CSV. No test is run, no leak is inferred."""
import argparse
import csv
import math
from pathlib import Path
import statistics
import sys


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    index = (len(ordered) - 1) * pct
    low, high = math.floor(index), math.ceil(index)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (index - low)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--csv', type=Path, required=True, help='已采集并脱敏的 CSV 路径')
    ap.add_argument('--metric', action='append', required=True, help='CSV 数值列名，可重复')
    ap.add_argument('--delimiter', default=',', help='CSV 分隔符，默认逗号')
    args = ap.parse_args()
    if len(args.delimiter) != 1:
        print('INVALID_CSV: 分隔符必须是单个字符', file=sys.stderr)
        return 2
    try:
        with args.csv.open('rb') as stream:
            bom = stream.read(3)
        enc = 'utf-16' if bom[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
        with args.csv.open('r', encoding=enc, newline='') as f:
            reader = csv.DictReader(f, delimiter=args.delimiter)
            if not reader.fieldnames:
                raise ValueError('CSV 缺少表头')
            missing = [m for m in args.metric if m not in reader.fieldnames]
            if missing:
                raise ValueError(f'缺少列 {missing}；已有列 {reader.fieldnames}')
            values = {m: [] for m in args.metric}
            for rownum, row in enumerate(reader, 2):
                for m in args.metric:
                    raw = row.get(m)
                    if raw is None or not raw.strip():
                        raise ValueError(f'第 {rownum} 行列 {m} 为空')
                    v = float(raw.strip())
                    if not math.isfinite(v):
                        raise ValueError(f'第 {rownum} 行列 {m} 非有限数值')
                    values[m].append(v)
        if not all(values.values()):
            raise ValueError('CSV 没有任何采样行')
        for name, seq in values.items():
            print(f'{name}: n={len(seq)}, p50={statistics.median(seq):.3f}, '
                  f'p95={percentile(seq, .95):.3f}, max={max(seq):.3f}, '
                  f'first={seq[0]:.3f}, last={seq[-1]:.3f}, delta={seq[-1]-seq[0]:+.3f}')
        print('注意：描述性统计不证明内存泄漏或性能改善；必须补充同条件基线与时间/负载证据。')
        return 0
    except (OSError, UnicodeError, ValueError, csv.Error) as exc:
        print(f'INVALID_CSV: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
