---
name: taskdock-ui-acceptance
description: "专项验收 task_dock 的视觉、组件交互与原生窗口行为：用户说胶囊圆角、悬停、拖拽光标卡住、贴边吸附、深浅主题不一致或截图与设计图不一致时使用；按静态视觉、组件交互、桌面原生三层分别取证，不把浏览器截图冒充原生验证。只问业务功能是否实现、数据是否落库或常驻 CPU/内存时不用此 Skill。"
---

# task_dock：UI / 交互专项验收

## 原则
- 默认只读；用户截图是**现象证据**，不是 CSS/Win32 根因结论。源代码、当前状态与真实桌面证据互相核查。
- 先读 `AGENTS.md`、`docs/ACCEPTANCE_ROUTING.md`、`docs/ui-themes/` 相关文档与目标 UI 组件；严格复用语义 Token、现有原语与 overlay stack。
- 与通用功能验收共享结论分级（P0–P3，四选一），不用把整个 `taskdock-acceptance` 重跑一遍。业务链路与持久化问题优先 `taskdock-acceptance`。

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

## 分层验收（按实际风险选层，不跨层外推）
- **第一层静态视觉**：排版、字体、间距、对齐、圆角、阴影、图标、文本溢出、深/浅主题、颜色与语义 Token。用 A/B 即可；固定定位遮挡、元素超出容器、原生与自定义样式混用在此层检出。
- **第二层组件交互**：hover/active/focus/disabled、展开收起、下拉、弹窗/抽屉、键盘导航、Escape、搜索筛选。用 A/C，截图只证明视觉结果。长文案截断、双层玻璃可读性、overlay 层级一次关一层在此层检出。
- **第三层桌面原生交互**：窗口贴边吸附、悬浮胶囊、拖拽反馈、磁吸、多显示器、DPI、DWM 透明圆角、原生鼠标命中、前台焦点与窗口恢复。用 E/F；C 不能证明 DWM/Win32，B 不能证明原生窗口。

## 拖拽与鼠标状态（专项必查）
- 分别验证 `cursor: grab`（静止可拖）与 `cursor: grabbing`（拖拽持续中）；只有 CSS 中存在 `grabbing` 不等于已修复，必须走实际指针按下→移动→释放路径。
- 覆盖指针取消、鼠标移出窗口、原生窗口移动、元素覆盖与命中测试、CSS 继承/覆盖、组件卸载后的状态清理。原生窗口拖动与 WebView 内交互分开取证。
- 截图不能证明拖拽流畅或光标持续性；动态行为用 C/E/F 的状态断言或连续采样，不用单张截图判通过。

## 布局与信息密度（按风险核对）
- 重点面：主面板、工具面板、胶囊、导航栏、微件库、设置、Agent 页面、应用管理、剪贴板、文件暂存与收集箱。
- 常见回归：底部无意义空白、按钮位置漂移、内容区被挤压、卡片过大、操作入口不明显、固定定位遮挡、不必要弹窗、图标与功能不一致、深/浅主题不一致。改动一面后回查相邻面，避免修坏其他页面。

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
6. **验收成本分级**：纯视觉改动只取必要的修改后截图+受影响主题截图+简短结论；交互问题取关键状态验证+实际操作结果；原生窗口问题补 E/F 证据。不为圆角改动生成几十张截图与长日志。
7. 拍摄尽量少、但能解释问题的前后对比及明暗/关键状态截图。若要验证截图证据是否齐备，可复制 `assets/templates/screenshot-manifest.template.json` 填写后运行 `scripts/check_screenshots.py`。**该脚本只校验 PNG 结构与取证覆盖，不判断视觉通过。**
8. 不获得物理操作授权时不抢前台或移动鼠标；截图不能证明动画流畅与磁吸手感。完成后注明每项实际验证通道及未覆盖层。

## 参考与结果
- 设计图归属、批准依据与 A/B/C/D 分类：[references/design-ref-policy.md](references/design-ref-policy.md)。
- 当前正式基准、候选图与缺失基准：[references/visual-baselines.md](references/visual-baselines.md)。
- 主题、布局、层级、焦点、磁吸、拖拽状态矩阵：[references/ui-checklist.md](references/ui-checklist.md)。
- 截图与原生证据的可靠性、轻量化选择：[references/evidence-boundaries.md](references/evidence-boundaries.md)。
- 报告采用 `taskdock-acceptance` 的结论契约；纯 UI 尽量只保留少量截图与简短报告，证据在 `tmp/acceptance/<task-name>/`，不写入用户敏感内容。

- `assets/templates/screenshot-manifest.template.json` 只是空白模板；按任务复制到 `tmp/acceptance/...` 后填写证据路径，不在 Skill 内记录任何一次真实测试结果。
