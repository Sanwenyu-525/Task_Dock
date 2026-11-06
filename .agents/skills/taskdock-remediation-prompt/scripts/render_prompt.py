#!/usr/bin/env python3
"""Render a reviewable Codex task draft from supplied findings (no repo changes)."""
import argparse
import json
from pathlib import Path
import sys

SEVERITIES = {'P0', 'P1', 'P2', 'P3'}
CONFIDENCE = {'CONFIRMED', 'NEEDS_VERIFICATION'}
TASK_TYPES = {'defect_fix', 'feature_delivery'}


def require_text(obj: dict, key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{key} 必须是非空字符串')
    return value.strip()


def require_list(obj: dict, key: str) -> list[str]:
    value = obj.get(key)
    if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
        raise ValueError(f'{key} 必须是字符串数组')
    return value


def lines(items: list[str]) -> str:
    return '\n'.join('- ' + x for x in items) or '- （未提供）'


def render(data: dict) -> str:
    if not isinstance(data, dict):
        raise ValueError('顶层必须是对象')
    task, context = require_text(data, 'task'), require_text(data, 'context')
    task_type = data.get('task_type', 'defect_fix')
    if task_type not in TASK_TYPES:
        raise ValueError('task_type 仅允许 defect_fix / feature_delivery')
    scope, out_of_scope = require_list(data, 'scope'), require_list(data, 'out_of_scope')
    acceptance, constraints = require_list(data, 'acceptance'), require_list(data, 'constraints')
    found = data.get('findings')
    if not isinstance(found, list) or not found:
        raise ValueError('findings 必须为非空数组')
    issues = []
    for i, obj in enumerate(found):
        if not isinstance(obj, dict):
            raise ValueError(f'findings[{i}] 必须是对象')
        id_, severity, status = (require_text(obj, k) for k in ('id', 'severity', 'status'))
        if severity not in SEVERITIES or status not in CONFIDENCE:
            raise ValueError(f'findings[{i}] severity/status 不合法')
        observed, expected, evidence = (require_text(obj, k) for k in ('observed', 'expected', 'evidence'))
        cause = obj.get('suspected_cause', '')
        if not isinstance(cause, str):
            raise ValueError(f'findings[{i}].suspected_cause 必须是字符串')
        issues.append(f"### {id_} · {severity} · {status}\n- 现象：{observed}\n- 预期：{expected}\n- 证据（须复核）：{evidence}\n- 根因：{cause or '待定位'}（未经过代码复核不可视为定论）")
    title = '新功能开发任务' if task_type == 'feature_delivery' else '修复任务'
    return f'''# task_dock｜开发 Agent {title}：{task}

任务类型：{task_type}（feature_delivery 为新功能实现，不得虚构已有缺陷；defect_fix 为缺陷修复）

## 背景与事实等级
{context}

{chr(10).join(issues)}

## 目标范围
{lines(scope)}

## 非目标
{lines(out_of_scope)}

## 开工检查（必须）
1. 读取根 `AGENTS.md`、相关子目录规范、正式文档及实际代码/测试；检查 `git status` 与本轮关联 diff，不覆盖其他并行会话改动。
2. 先复现或证实 findings 中的现象；`NEEDS_VERIFICATION` 不得当已确认缺陷；验证真正根因后再确定修改位置。
3. 根据本仓库的 IPC、SQLite/备份、Agent pipeline、剪贴板 Win32、窗口/DPI 与事件释放约束，确认相关边界；不要无关重构或引入新依赖。

## 实施要求
1. 优先复用已有代码/组件/脚本，最小范围处理根因（缺陷修复）或按需求实现（新功能），覆盖异常、取消、并发和生命周期边界；UI/UX 行为与数据安全/兼容、性能与资源释放按本次风险落实。
2. 严禁擅自执行 `git clean`、`git reset --hard`、清理共享构建缓存、终止他人进程、覆盖用户数据或强制暂存提交。
3. 根据 `docs/ACCEPTANCE_ROUTING.md` 选择 A–F 验收通道；真实窗口和系统行为不以 mock/CDP 截图替代；物理操作与抢前台要先获授权。

## 专项限制
{lines(constraints)}

## 验收标准
{lines(acceptance)}

## 最终交付
- 结论仅使用：通过 / 部分通过 / 不通过 / 证据不足。
- 汇报根因确定性、实际修改文件与行为、已执行命令（目录/退出码/时间）及证据位置。
- 未执行、`ENVIRONMENT BLOCKED`、并行其他任务造成的失败和残余风险必须分开说明。
- 验收资料仅按需放 `tmp/acceptance/<task-name>/`，正式文档只更新长期有效的已有章节。
'''


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--input', type=Path, required=True, help='包含真实或明确待验证 findings 的 JSON')
    args = ap.parse_args()
    try:
        data = json.loads(args.input.read_text(encoding='utf-8-sig'))
        print(render(data))
        return 0
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        print('INVALID_FINDINGS:', exc, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
