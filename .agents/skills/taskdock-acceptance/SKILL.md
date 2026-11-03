---
name: taskdock-acceptance
description: "验收 task_dock 已开发功能、Bug 修复或跨模块回归；用户说验收一下、复查、检查实现、验收并给提示词时使用。基于当前仓库和实际执行证据输出 P0–P3，不自动修改代码。"
---

# task_dock：功能验收

## 权限与事实边界
- **默认只读**；验收不等于修复授权。不开启会抢鼠标、改剪贴板、动用户数据库或结束未知进程的操作。
- 仓库 `AGENTS.md` 优先约束 Git/数据/架构安全；`docs/ACCEPTANCE_ROUTING.md` 是 A–F 通道权威；`docs/TESTING.md` 是测试策略与历史记录。**不要复制这些文件为快照**，现有代码与当次证据优先于历史报告。
- 区分四类证据：本轮执行、静态检查、历史记录、用户截图。后两种不当作当前真机通过。
- 仅在用户确实要求 UI 专项或性能专项时，关联 `taskdock-ui-acceptance` 或 `taskdock-performance-audit`；明确要求修复提示词时再关联 `taskdock-remediation-prompt`。不要无条件遍历所有 Skill。

## 顺序
1. 确认仓库根、任务范围、原需求与非目标；先读 `AGENTS.md`/就近子目录规则，查 `git status` 和相关 diff，保留并行会话改动。
2. 从实际代码、类型、测试、配置、迁移、模块文档确认实现；定位到文件/函数及条件分支。参考 [references/acceptance-matrix.md](references/acceptance-matrix.md) 选择检查项。
3. 可用终端时先运行 `python .agents/skills/taskdock-acceptance/scripts/preflight.py --repo .` 获取**只读**环境快照；这不是测试通过证据。不可运行时报告能力限制。
4. 建立“需求→可观察结果→失败判据→验证通道→证据”矩阵；只检查本次范围，未开发功能标“规划中/未实施”而不是自动记 Bug。
5. 根据 `docs/ACCEPTANCE_ROUTING.md` 选最低干扰通道 A–F；原生、系统或物理行为不能用 mock、CDP 页面截图替代。按需使用已有 `scripts/acceptance/` 和 `scripts/perf/`；执行任何现有脚本**先检查参数、写入与副作用**。
6. 先做相关单测/类型/契约，再按风险扩大；Rust 在 `src-tauri/` 执行，构建前检查 `scripts/build-guard.mjs` 约束。不能执行则写“未执行”，不要借历史输出伪称通过。
7. 分辨本轮缺陷、并行工作树噪声、已有失败、环境阻塞。对每项注明根因是“确认”还是“待查”。只对有证据的问题按 P0–P3 分级。
8. 如有实际证据，可按 [references/evidence-contract.md](references/evidence-contract.md) 记录；运行 `scripts/validate_evidence.py` 校验**证据引用存在性与字段完整性**，注意这不能证明结论真实。

## 产物与结果
- 简短输出：**结论（通过/部分通过/不通过/证据不足）→ P0–P3 问题 → 本轮动作 → 实际验证/未验证 → 遗留风险 → 文件位置**。
- 每项说明触发步骤、实际观察、影响、文件位置、来源、验证通道及未覆盖边界；环境阻塞使用 `ENVIRONMENT BLOCKED`，不计为通过。
- 低风险纯视觉任务不留大量报告；需要留存的本轮资料写 `tmp/acceptance/<task-name>/`，不覆盖历史文件，不写敏感剪贴板或个人数据。
- 可复制报告骨架：`assets/templates/report.template.md`；可检查的证据清单格式：`assets/templates/evidence.template.json`。所有模板只能复制到 `tmp/acceptance/...` 后填写，Skill 内禁止保存真实执行报告。
