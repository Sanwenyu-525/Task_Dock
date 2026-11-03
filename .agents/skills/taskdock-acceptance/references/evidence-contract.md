# 证据清单契约

目的：让验收项可追溯。它只校验信息结构与引用路径，**不自动判定代码功能是否通过**。

清单 JSON 形式：

```json
{
  "task": "clipboard-preview",
  "items": [
    {
      "id": "preview-modal",
      "goal": "打开图片详情后看到实际图片",
      "channels": ["C"],
      "status": "NOT_RUN",
      "action": "待运行 Playwright locator.click()",
      "observation": "未执行，禁止预填 PASS",
      "boundary": "尚不能证明第三方软件粘贴",
      "evidence_paths": []
    }
  ]
}
```

- `status`: `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`。
- `channels`: A/B/C/D/E/F 中实际已跑的通道；尚未执行时可保留计划通道，但不能称已验证。
- 若 `PASS`/`FAIL`：需真实操作与观察结果，还需 `evidence_paths` 指向现有文件，或提供 `command` + `exit_code` 的实际执行记录。字段完整不保证证据真实。
- `evidence_paths` 应使用相对仓库路径，既可以是代码位置的文件，也可以是 `tmp/acceptance/...` 下的证据文件；路径必须存在，不允许 `..` 穿越。
- `BLOCKED` 必须交代原因；`NOT_RUN` 是未执行，不属于通过项。
- 如需报告严重程度：`P0` 数据泄漏/丢失/核心崩溃；`P1` 核心功能或严重风险；`P2` 边界/次要问题；`P3` 低风险体验。结论仅四选一（见 `AGENTS.md`）。

示例命令：

```bash
python .agents/skills/taskdock-acceptance/scripts/validate_evidence.py --repo . --manifest tmp/acceptance/my-task/evidence.json
```

## 保存位置
- 证据清单模板位于 `assets/templates/evidence.template.json`；**当次真实** `evidence.json` 写入 `tmp/acceptance/<task-name>/`。
- 校验脚本不会写回 Skill；图片与日志禁止复制进 Skill 作为运行记录。
