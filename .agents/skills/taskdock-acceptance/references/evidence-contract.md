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

## 字段边界（不要新增校验器不认的字段）

`scripts/validate_evidence.py` 校验的字段就是上面这些：`task`、`items[]`，其中每条含
`id` / `goal` / `channels` / `status` / `action` / `observation` / `boundary` / `evidence_paths`，
以及条件字段 `command` + `exit_code`（PASS/FAIL 至少满足其一）、`block_reason`（BLOCKED 必填）。

**不要**为了表达 Dev/Release 模式而新增 `mode`、`buildId`、`build_id` 等字段——校验器不认，
写了也不会被校验覆盖。要表达的信息放在现有字段里：

- **Dev 功能验收**：在 `action` 里写明运行实例与命令（如「`npm run tauri dev`（Debug），
  `TASK_DOCK_DATA_DIR=tmp/debug/<task-name>/`，点击…操作」），在 `observation` 写实测到的现象，
  在 `boundary` 写「未覆盖安装/升级/卸载、生产资源加载、正式性能（需 Release 正式验收）」。
- **Release 正式验收**：在 `action` 写明构建版本（如「`b02-desktop-r1` 安装包…」），在
  `boundary` 写明该结论绑定哪个构建。
- **未验证 / 环境阻塞**：用 `status=NOT_RUN` 或 `status=BLOCKED` + `block_reason`，
  不要用 `observation` 写「大概没问题」。

## Dev 验收与 Release 验收的记录区别

| | Dev 功能验收 | Release 正式验收 |
|---|---|---|
| 清单落点 | `tmp/acceptance/<task-name>/evidence.json` | `<构建目录>/acceptance/<任务>.json` |
| 绑定构建版本 | **不绑定**（也不伪造 `buildId`） | 绑定真实 `buildId` |
| 报告结论用语 | 「Dev 功能验收通过 / 部分通过 / 不通过 / 证据不足」 | 「验收通过 / 验收失败」 |
| 是否推进集成状态机 | **否**（不改 `verifying` / `accept-passed` / `accept-failed`） | 是 |
| 必写的边界 | 安装/升级/卸载、生产资源加载、正式性能 | 该构建未覆盖的部分 |

Dev 验收的每一条 PASS 都应能回答：**在哪个代码快照（Git HEAD + dirty 状态）、哪个运行模式
（Debug）、哪个数据目录下，实际做了什么、观察到什么**。这些写进 `action` / `observation`，
报告层面写进 `assets/templates/report.template.md` 的对应行。

示例命令：

```bash
python .agents/skills/taskdock-acceptance/scripts/validate_evidence.py --repo . --manifest tmp/acceptance/my-task/evidence.json
```

## 保存位置
- 证据清单模板位于 `assets/templates/evidence.template.json`；**当次真实** `evidence.json` 写入 `tmp/acceptance/<task-name>/`。
- 校验脚本不会写回 Skill；图片与日志禁止复制进 Skill 作为运行记录。
