---
name: taskdock-acceptance
description: "验收 task_dock 功能实现与跨模块回归：用户说验收一下功能、复查实现、检查修复是否生效时使用；按需求到证据的完整业务链路核查并区分未实现、部分实现、已实现未验证、自动化已验证、原生已验证、缺陷与环境阻塞，输出 P0–P3 与四态结论，不自动改代码。纯视觉、拖拽光标或原生窗口问题优先 taskdock-ui-acceptance；常驻 CPU/内存增长优先 taskdock-performance-audit；仅索要提示词优先 taskdock-remediation-prompt。"
---

# task_dock：功能验收

## 权限与事实边界
- **默认只读**；验收不等于修复授权。不开启会抢鼠标、改剪贴板、动用户数据库或结束未知进程的操作。
- 仓库 `AGENTS.md` 优先约束 Git/数据/架构安全；`docs/ACCEPTANCE_ROUTING.md` 是 A–F 通道权威；`docs/TESTING.md` 是测试策略与历史记录。**不要复制这些文件为快照**，现有代码与当次证据优先于历史报告。
- 区分四类证据：本轮执行、静态检查、历史记录、用户截图。后两种不当作当前真机通过。
- **路由**：功能链路或回归为主时用本 Skill；专项视觉/拖拽/原生窗口时用 `taskdock-ui-acceptance`；专项常驻资源增长时用 `taskdock-performance-audit`；仅生成提示词且不做完整验收时用 `taskdock-remediation-prompt`。用户说“验收一下，给我提示词”时先本 Skill 验收，再转交 `taskdock-remediation-prompt`。不要无条件遍历所有 Skill，也不要因提到一个 UI 名词就改跑完整 UI 验收。

## 需求到证据的检查模型
内部检查状态只用于定位，不代替最终四态结论；每个发现必须先定状态再定严重度：
- `UNIMPLEMENTED` 未实现：入口、链路或契约缺失，标规划中/未实施，不自动记 Bug。
- `PARTIAL` 部分实现：成功路径有但失败或边界分支缺失。
- `IMPLEMENTED_UNVERIFIED` 代码已实现但未验证：仅有静态存在或历史记录，无本轮执行。
- `AUTOMATED_VERIFIED` 自动化已验证：A 通道定向测试/类型/契约已跑通。
- `NATIVE_VERIFIED` 原生运行已验证：真实实例与对应 C/D/E/F 通道已跑通。
- `DEFECT` 已确认缺陷：触发条件、预期、实际均有证据。
- `ENVIRONMENT BLOCKED` 环境阻塞：锁屏、前台锁、端口/磁盘等导致无法验证，单列阻塞项。
最终结论只能用**通过 / 部分通过 / 不通过 / 证据不足**，环境阻塞不并入通过，也不折算为代码缺陷。

## 顺序
1. 确认仓库根、任务范围、原需求与非目标；先读 `AGENTS.md`/就近子目录规则，查 `git status` 和相关 diff，保留并行会话改动。
2. 从实际代码、类型、测试、配置、迁移、模块文档确认实现；定位到文件/函数及条件分支。参考 [references/acceptance-matrix.md](references/acceptance-matrix.md) 选择业务链路与检查项。
3. 可用终端时先运行 `python .agents/skills/taskdock-acceptance/scripts/preflight.py --repo .` 获取**只读**环境快照；这不是测试通过证据。不可运行时报告能力限制。
4. 建立“需求→可观察结果→失败判据→验证通道→证据”矩阵；只检查本次范围，未开发功能标 `UNIMPLEMENTED` 而不是自动记 Bug。沿完整业务链路走：功能入口→成功/失败/边界路径→持久化与状态同步，不要以 UI 存在性、测试文件存在性或静态代码代替功能结论。
5. 根据 `docs/ACCEPTANCE_ROUTING.md` 选最低干扰通道 A–F；原生、系统或物理行为不能用 mock、CDP 页面截图替代。按需使用已有 `scripts/acceptance/` 和 `scripts/perf/`；执行任何现有脚本**先检查参数、写入与副作用**。
6. 先做相关单测/类型/契约，再按风险扩大；Rust 在 `src-tauri/` 执行，构建前检查 `scripts/build-guard.mjs` 约束。不能执行则写“未执行”，不要借历史输出伪称通过。
7. 分辨本轮缺陷、并行工作树噪声、已有失败、环境阻塞。对每项注明根因是“确认”还是“待查”。只对有证据的问题按 P0–P3 分级。跨模块回归只选有真实依赖关系的模块，不无限扩大（隐藏入口后的轮询/订阅、重复监听、设置持久化、跨窗口状态同步、错误区分、取消/恢复路径，细节见 references）。
8. 如有实际证据，可按 [references/evidence-contract.md](references/evidence-contract.md) 记录；运行 `scripts/validate_evidence.py` 校验**证据引用存在性与字段完整性**，注意这不能证明结论真实。

## 产物与结果
- 固定顺序输出：**结论（通过/部分通过/不通过/证据不足）→ 主要发现（P0–P3）→ 证据（通道+命令/动作+结果+路径）→ 验证范围 → 未验证项（含环境阻塞）→ 遗留风险**。
- 每项说明触发步骤、实际观察、影响、文件位置、来源、验证通道及未覆盖边界；环境阻塞使用 `ENVIRONMENT BLOCKED`，不计为通过。
- 纯视觉任务不留大量报告；需要留存的本轮资料写 `tmp/acceptance/<task-name>/`，不覆盖历史文件，不写敏感剪贴板或个人数据。
- 可复制报告骨架：`assets/templates/report.template.md`；可检查的证据清单格式：`assets/templates/evidence.template.json`。所有模板只能复制到 `tmp/acceptance/...` 后填写，Skill 内禁止保存真实执行报告。
