#!/usr/bin/env python3
"""Read-only task_dock repository preflight. Does not run tests or change files."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(['git', '-C', str(repo), *args], text=True,
                            encoding='utf-8', errors='replace', capture_output=True,
                            check=False, timeout=20)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('.'), help='仓库根目录（只读）')
    parser.add_argument('--paths', nargs='*', default=[], help='本次任务涉及的相对仓库路径')
    args = parser.parse_args()
    repo = args.repo.resolve()
    try:
        if not (repo / 'AGENTS.md').is_file():
            raise ValueError('仓库根未找到 AGENTS.md')
        if Path(git(repo, 'rev-parse', '--show-toplevel')).resolve() != repo:
            raise ValueError('请将 --repo 指向 Git 仓库根目录')
        status = git(repo, 'status', '--short', '--untracked-files=normal')
        requested = {}
        for item in args.paths:
            p = (repo / item).resolve()
            if not p.is_relative_to(repo):
                raise ValueError(f'路径超出仓库: {item}')
            requested[item] = {'exists': p.exists(), 'type': 'dir' if p.is_dir() else 'file' if p.is_file() else 'missing'}
        result = {
            'repo': str(repo), 'branch': git(repo, 'branch', '--show-current'),
            'head': git(repo, 'rev-parse', '--short', 'HEAD'),
            'dirty': bool(status), 'status_lines': status.splitlines() if status else [],
            'required': {p: (repo / p).is_file() for p in
                         ['AGENTS.md', 'docs/ACCEPTANCE_ROUTING.md', 'docs/TESTING.md']},
            'tool_dirs': {p: (repo / p).is_dir() for p in ['scripts/acceptance', 'scripts/perf']},
            'requested_paths': requested,
            'note': '只读工作区信息；不代表任何测试或原生交互通过',
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f'PRECHECK_ERROR: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
