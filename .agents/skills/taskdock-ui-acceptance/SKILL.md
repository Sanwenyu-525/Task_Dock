---
name: taskdock-ui-acceptance
description: "专项验收 task_dock 液态玻璃 UI、深浅主题、浮动胶囊、贴边吸附、弹层、WebView2 交互与 Win32/DWM 外观；用户说验收 UI、截图有问题、检查视觉交互时使用，不把浏览器截图冒充原生验证。"
---

# task_dock：UI / 交互专项验收

## 原则
- 默认只读；用户截图是**现象证据**，不是 CSS/Win32 根因结论。源代码、当前状态与真实桌面证据互相核查。
- 先读 `AGENTS.md`、`docs/ACCEPTANCE_ROUTING.md`、`docs/ui-themes/` 相关文档与目标 UI 组件；严格复用语义 Token、现有原语与 overlay stack。
- 与通用功能验收共享结论分级（P0–P3，四选一），不用把整个 `taskdock-acceptance` 重跑一遍。

## 视觉基准检查流程（验收时按顺序执行）
1. **识别范围**：确定涉及的组件、模块、主题（light/dark/both）与 UI 状态；写进本轮检查表。
2. **查正式基准**：在 `assets/design-refs/manifest.json` 中按 `component` / `module` / `theme` / `state` 筛选 `status=approved` 的条目。只有这些条目能作为强制视觉基准。
3. **读图与约束**：打开命中的基准图，同时读 [references/visual-baselines.md](references/visual-baselines.md) 的适用范围、未覆盖场景与对比口径；先跑校验：

   ```bash
   python .agents/skills/taskdock-ui-acceptance/scripts/verify_design_refs.py --repo . --strict --require-approved
   ```

4. **查代码与 Token**：核对实际组件实现、`styles-themes.css` / `styles-ui.css` 语义 Token、主题/材质/预设 Dataset；不得只看设计图推断实现。
5. **选通道**：按 `docs/ACCEPTANCE_ROUTING.md` 选最少充分的 A–F 组合；B 预览只代表 harness，C 只覆盖真实 WebView2 输入，D 只覆盖控件树，E 覆盖原生窗口/合成，F 才覆盖物理手感。
6. **取真实截图**：必须取当前运行实例的截图；无法取真机证据时明确写 `缺少真机证据` / `ENVIRONMENT BLOCKED`，不得用设计图或旧截图代替本轮结果。
7. **对比目标图与真实截图**：逐项比较布局、间距、层级、圆角、玻璃材质、边缘、阴影、文字对比度、状态反馈。动态内容（真实任务数、时间、文件名）不同不判失败。
8. **输出差异**：分别记录“设计偏差”“实现/代码根因”“影响面”“严重度（P0–P3）”“验证通道”；不得把设计偏差直接断言为 CSS/Win32 根因。
9. **无正式基准**：按 `docs/ui-themes/`、语义 Token、现有组件层与用户当前需求验收，明确写“无经批准的效果图基准”；不得凭空生成目标图或把候选图当标尺。

## 对比口径与证据边界
- 图片对比必须考虑 DPI/缩放（100/125/150%）、浏览器与 WebView2 抗锯齿、字体渲染、系统材质/DWM 合成、窗口圆角与背景壁纸差异；**不能只按像素差判失败**，也不因单像素边缘差异直接判 P1。
- 设计效果图是静态输入，**不能证明**交互、动画、磁吸手感、拖拽阻力、系统通知真实展示、系统窗口行为；这些必须走 C/E/F 或明确标注未验证。
- `assets/design-refs/candidates.json` 中的候选图只供方向参考，**不参与 Pass/Fail，不标记 approved**；需要提升为正式基准时必须有明确批准依据并重新导入。
- 验收截图、差异图、日志只留在 `tmp/acceptance/<task-name>/`，不得回写 `assets/design-refs/`，也不得把当次证据登记成基准。

## 执行
1. 根据用户需求划分**纯视觉 / WebView2 行为 / 原生窗口与系统交互**；参考 [references/ui-checklist.md](references/ui-checklist.md) 选择实际检查项。
2. 按 `docs/ACCEPTANCE_ROUTING.md` 选择最少充分的 A/B/C/D/E/F 组合。B 预览只能证明 mock harness；C Playwright 走真实 WebView2 输入管线但不能证明 DWM / Win32；E 原生截图、窗口几何；F 真实鼠标手感需授权。
3. 先检查 `scripts/serve-preview.mjs`、`scripts/layout-regression.mjs`、`scripts/acceptance/cdp-main-window.mjs`、`scripts/acceptance/joint-ui-drive.mjs`、`scripts/native-verify.ps1` 的适用性与**当前参数**；不另外实现平行 CDP/Win32 驱动。
4. 不使用 `dispatchEvent()` / DOM `.click()` 作为真实点击/hover 证据；`page.evaluate` 只读诊断。真实 CDP 必须先识别主窗口；只连回环目标；不操纵用户实例的数据。
5. 如果有匹配且已批准的基准，核对状态/主题和基准哈希；设计差异不等于已确认代码根因。没有基准时不得自行捏造或从验收产物提升为基准。
6. 拍摄尽量少、但能解释问题的前后对比及明暗/关键状态截图。若要验证截图证据是否齐备，可复制 `assets/templates/screenshot-manifest.template.json` 填写后运行 `scripts/check_screenshots.py`。**该脚本只校验 PNG 结构与取证覆盖，不判断视觉通过。**
7. 不获得物理操作授权时不抢前台或移动鼠标；截图不能证明动画流畅与磁吸手感。完成后注明每项实际验证通道及未覆盖层。

## 参考与结果
- 设计图归属、批准依据与 A/B/C/D 分类：[references/design-ref-policy.md](references/design-ref-policy.md)。
- 当前正式基准、候选图与缺失基准：[references/visual-baselines.md](references/visual-baselines.md)。
- 主题、布局、层级、焦点、磁吸状态矩阵：[references/ui-checklist.md](references/ui-checklist.md)。
- 截图与原生证据的可靠性、轻量化选择：[references/evidence-boundaries.md](references/evidence-boundaries.md)。
- 报告采用 `taskdock-acceptance` 的结论契约；纯 UI 尽量只保留少量截图与简短报告，证据在 `tmp/acceptance/<task-name>/`，不写入用户敏感内容。

- `assets/templates/screenshot-manifest.template.json` 只是空白模板；按任务复制到 `tmp/acceptance/...` 后填写证据路径，不在 Skill 内记录任何一次真实测试结果。
