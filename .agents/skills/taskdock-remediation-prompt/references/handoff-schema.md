# 结构化问题交接

`assets/templates/findings.template.json` 是零证据占位示例；使用时必须替换、不能假装案例已复现。

字段：
- `task`：简洁任务名，非空。
- `task_type`（可选）：`defect_fix`（缺陷修复）或 `feature_delivery`（新功能实现）。缺省按 `defect_fix` 兼容旧文件；新功能必须写 `feature_delivery`，标题与汇报据此区分。
- `context`：为什么需要修复/实现、原始用户诉求。
- `scope`：允许关注的模块/功能；`out_of_scope`：不得顺手改的事项。
- `findings`：每项 `id`, `severity`(P0–P3), `status`(`CONFIRMED` 或 `NEEDS_VERIFICATION`), `observed`, `expected`, `evidence` (证据位置或说明), `suspected_cause` (可选，推测不得改写为事实)。
- `acceptance`：可操作的正反验收标准字符串列表。
- `constraints`：本任务特有的限制（除了 `AGENTS.md` 的全局规则）。

生成方式：

```bash
python .agents/skills/taskdock-remediation-prompt/scripts/render_prompt.py --input tmp/acceptance/my-task/findings.json
```

脚本是**提示词脚手架**：检查基本字段、拼接章节并打印，不能证明 `evidence` 真实、不能替代阅读代码与判断实现方案。建议先由验收者确认材料再交给 Codex。
