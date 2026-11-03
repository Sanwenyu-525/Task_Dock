# 视觉基准索引与使用原则

正式基准唯一权威清单：`assets/design-refs/manifest.json`（`status=approved`）。
候选图独立清单：`assets/design-refs/candidates.json`（`status=candidate`，不参与 Pass/Fail）。

## 当前正式基准（5 张，2026-11-03 导入）

| ID | 组件 | 模块 | 主题 | 状态 | 文件 | 规范 | 未覆盖场景 |
|---|---|---|---|---|---|---|---|
| `capsule-dock-tasks-v07` | `capsule-dock` | dock | light | `expanded-tasks` | `dock/capsule-dock-tasks-v07.png` | `docs/ui-themes/13-capsule-redesign.md` | 深色、四边/横向停靠、展开收起过渡、原生吸附手感、DPI 125/150、320/400 窄窗、真实窗口合成 |
| `capsule-dock-agents-v07` | `capsule-dock` | dock | light | `expanded-agents` | `dock/capsule-dock-agents-v07.png` | 同上 | 深色、Agent 运行中/等待/失败态、四边停靠、原生命中、DPI/窄窗 |
| `capsule-dock-clipboard-v07` | `capsule-dock` | dock | light | `expanded-clipboard` | `dock/capsule-dock-clipboard-v07.png` | 同上 | 深色、图片/文件/富文本条目、四边停靠、原生命中、DPI/窄窗 |
| `capsule-dock-apps-v07` | `capsule-dock` | dock | light | `expanded-apps` | `dock/capsule-dock-apps-v07.png` | 同上 | 深色、多分组/长列表、四边停靠、原生命中、DPI/窄窗 |
| `task-card-scheme-d-v07` | `task-card` | panels | both | `scheme-d-light-dark-interactions` | `panels/task-card-scheme-d-v07.png` | `docs/ui-themes/01-design-spec.md` §12 | 原生窗口合成/字体渲染、真实数据密度与长文本、键盘焦点顺序、reduced-motion、DPI 125/150 |

这 5 张均来自 `docs/design-refs/v07/`，源文件保留在原位置；导入副本仅用于 Skill 内快速查图，`manifest.json` 的 `source` + `sha256` 是可追溯出处。**不得把源文件与副本同时当作并行维护的权威基准。**

## 候选图（5 张，仅供方向参考）

| ID | 组件 | 主题 | 状态 | 来源 | 为什么不是正式基准 |
|---|---|---|---|---|---|
| `notification-c-scheme-light-v07` | `notification-card` | light | `six-state-light-preview` | `docs/design-refs/v07/通知效果图/task_dock_notification_preview_light.png` | 仅被 CSS 称为“视觉来源”，未写“视觉基准”；HTML 原型截图 |
| `notification-c-scheme-dark-stack-v07` | `notification-card` | dark | `stacked-dark-preview` | `docs/design-refs/v07/通知效果图/task_dock_notification_preview_stack.png` | 同上，堆叠态未获最终确认 |
| `planning-center-views-v07` | `planning-center` | light | `multi-view-overview` | `docs/design-refs/v07/规划中心效果图.png` | 规划文档未指定为最终效果图，README 仅称设计输入稿 |
| `theme-system-exploration-v07` | `theme-system` | both | `theme-material-3d-exploration` | `docs/design-refs/v07/3D效果图/3D效果图.png` | 多方案探索板，未见最终批准 |
| `capsule-options-a-g-v07` | `capsule` | both | `design-options-a-g` | `docs/design-refs/v07/capsule-design-options-20261101.png` | 方案 A–G 对比板，未指定单一最终方案 |

候选图不复制进 Skill；`candidates.json` 只记录来源路径与哈希。验收时可以参考其方向，但**不得据此判 Pass/Fail**。

## 验收时的工作流

1. 根据任务筛选 `manifest.json` 中 `component`、`module`、`theme`、`state` 且 `status=approved` 的条目。
2. 运行校验：

   ```bash
   python .agents/skills/taskdock-ui-acceptance/scripts/verify_design_refs.py --repo . --strict --require-approved
   ```

3. 打开命中的基准图，读本文件的“未覆盖场景”，再决定还需要检查哪些真机层。
4. 若无匹配基准：参考 `docs/ui-themes/`、语义 Token、用户当前需求开展常规验收，明确写“无经批准的效果图基准”；不得把候选图当强制标尺，也不得凭空生成目标图。
5. 若有基准：以最少真实截图对比布局、层级、颜色、玻璃强度、边缘、文字对比度、状态反馈；**不能只按像素差判失败**。
6. 把**设计偏差**和**代码根因**分开记录；对比发现不等于已经定位 CSS 或 Win32 根因。布局允许动态内容差异，不因字数/时间不同判定失败。
7. 录入对应执行通道与证据路径；验收截图留在 `tmp/acceptance/<task-name>/screenshots/`，不可回写基准目录。

## 关键项目视觉检查

| 组件 | 先确认的视觉维度 | 必要的行为维度 | 当前基准 |
|---|---|---|---|
| 浮动胶囊与贴边条 | 轮廓、毛边、胶囊长度、不同背景下对比度 | E 原生区域/合成；F 吸附与脱离手感 | 停靠 01–04 仅 light 展开态；折叠/收起/四边/深色无正式基准 |
| 工具面板 / Dock | 距离、阴影、玻璃材质、层级、圆角 | C 点击/聚焦、E 原生停靠几何 | 停靠 01–04（分类面板 light） |
| 菜单、弹窗、筛选器 | 遮挡、最大宽度、语义 Token、长文案处理 | C hover/键盘/Escape、D 可访问性 | 无正式基准，按设计系统验收 |
| 通知 | 卡片信息密度、视觉层级、深浅主题 | F 通知真实可见、A 后端行为 | 仅候选图；无正式基准 |
| 规划中心 | 项目/步骤信息密度、筛选、空状态和响应式布局 | C 真实 WebView2 流程、A 数据契约 | 仅候选图；无正式基准 |
| 任务卡 | 双层玻璃、左侧强调、标题/元信息层级、hover/press/selected | C 交互、E 原生合成 | `task-card-scheme-d-v07`（light/dark 设计板） |

## 缺失的视觉基准

- `docs/ui-themes/images/` 两张 v0.6 主窗效果图：文档引用但目录不存在。
- `停靠效果图.png` 胶囊规格图：`docs/ui-themes/13-capsule-redesign.md`（第 89、108 行）与 `src/lib/capsuleShape.ts` 引用但文件不存在；只能用 01–04 的形态与文档中的尺寸推导。
- 胶囊停靠的深色版本、四边（上/下/左/右）与横向停靠、折叠/展开过渡、hover/selected 停靠条。
- 通知的浅色/深色正式基准（现有仅为 HTML 原型候选图）。
- 规划中心各视图（总览/看板/里程碑/进度统计）的正式基准；现有仅为多视图候选板。
- 菜单、弹窗、筛选器、日期时间、链接抽屉等弹层的正式视觉基准。
- 320/400 窄窗、DPI 100/125/150、高对比度、`prefers-reduced-motion`、原生 DWM 合成/桌面壁纸背景的基准。

## 对比口径

- 设计图与真机截图之间可能存在 DPI/缩放、抗锯齿、字体渲染、系统材质、DWM 圆角与壁纸背景差异；必须区分“设计口径差异”与“实现回归”。
- 静态效果图不能证明交互、动画、磁吸手感、拖拽阻力、系统通知到达与系统窗口行为；这些必须用 C/E/F 通道或标注未验证。
- 设计图是**目标输入**；验收证据是有时间、环境和命令绑定的**任务输出**。
