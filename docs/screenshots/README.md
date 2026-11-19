# 截图索引（docs/screenshots）

本文件是仓库内**界面截图**的统一入口。历史目录只做索引，不删除、不重命名；同一主题的新
截图放独立日期目录，避免覆盖旧结论。

## 边界说明（先读）

- `docs/screenshots/` 里的图片分为三类：**preview harness / Chromium 页面截图**、
  **WebView2 页面截图**、**Windows 桌面合成截图**。文件名与目录说明会写明采集通道，
  不能把前两类当成原生窗口圆角、DWM 材质、贴边吸附或系统级命中的验收。
- 截图只证明采集时的界面状态；功能是否可用以对应验收报告中的测试记录为准。
- 所有正式截图使用**确定性合成数据**；不含用户真实剪贴板正文、私人路径、聊天内容或令牌。

## 一、当前正式验收：剪贴板第三轮 UI/UX 精修（2026-11-19）

- 验收报告：`../clipboard/14-2026-11-19-ui-polish-acceptance.md`
- 截图目录：`clipboard/2026-11-19/`
- 机器可读清单：`clipboard/2026-11-19/manifest.json`
- 采集通道：Playwright Chromium（headless）+ 项目 `preview harness`；
  **不是 Windows 原生窗口截图**，原生功能复测在报告第十节单列。
- 代码版本 / 构建产物标识 / DPR / 内容区宽度等逐张记录在 `manifest.json`；本轮为
  `codeVersion=27f7e11`、`buildId=3632F251E88C`（工作树含未提交改动，`codeDirty=true`）。

| 文件 | 场景 |
|---|---|
| `01-default-light.png` | 1600×1000 默认工作台：浅色、舒适密度、筛选展开、内容区 1294px、4 列 |
| `02-card-alignment.png` | 同页下滚：内容区 1294px、4 列，图片卡与文字卡混合行的底部基线 |
| `03-long-text.png` | 长文字卡片：1600 窗口内容区 1294px，标题 2 行、正文最多 5 行 |
| `04-image-card.png` | 1024×900 竖图卡片：内容区 718px、2 列、卡宽 340，竖图舞台 186–206px、不裁切 |
| `05-files-card.png` | 1024×900 多文件卡片：内容区 718px、2 列、路径截断、元数据贴底 |
| `06-groups.png` | 分组页：1600 窗口内容区 1294px、3 列，整组复制带文字、删除收进更多菜单 |
| `07-preview-text.png` | 1600×1000 文字**右侧预览**：页面在无外壳宿主时启用本地右栏（320px），内容区 974px、3 列，卡片 `previewed` 强调 |
| `08-preview-image.png` | 1600×1000 图片**右侧预览**：同一本地右栏，竖图完整展示；预览态与批量选择互不覆盖 |
| `09-batch.png` | 批量管理：1600 内容区 1294px、4 列，勾选 3 项，预览态不覆盖选择态 |
| `10-compact.png` | 紧凑密度：1600 内容区 1294px、5 列、卡宽 247，缩略图 + 2 行正文 + 140px 最小高度；来源名保留、使用次数隐藏 |
| `11-list.png` | 列表密度：19 行单列密排，缩略图保留，元数据在行内右侧 |
| `12-dark.png` | 深色主题：1600 内容区 1294px、4 列，卡片 / 工具栏 / 筛选同一套语义 Token |
| `13-narrow.png` | 720×900 窄窗：内容区 414px、1 列，工具栏两行（70px），筛选不消失 |
| `14-medium.png` | 1024×900 中等窗口：内容区 718px、2 列，列数由内容宽度决定 |
| `15-wide.png` | 1920×1080 大窗口：内容区 1614px、舒适 5 列（每列 309px） |

## 二、README 展示图

| 目录 / 文件 | 用途 |
|---|---|
| `readme-20261108/` | README「界面预览」的 11 张 WebView2 页面截图（2026-11-08，含采集条件与边界说明） |
| `01-tasks-light-glass.png` ～ `09-compact-light-glass.png` | 早期 README 主图（任务 / Agent / 历史 / 设置 / 深色 / 320 窄窗） |
| `resource-manager-quad-layout-20261114.png` | 资源管理器四象限布局效果图 |

## 三、历史功能验收（剪贴板）

| 目录 | 内容 |
|---|---|
| `v05/clipboard-accept/` | 剪贴板抽屉阶段的 12 张功能验收图（空态、文字、历史、分组、详情、粘贴完成、任务关联、导出、设置、长列表、重启恢复） |
| `../clipboard/11-final-release-acceptance.md` | 剪贴板最终发布验收，对应证据在 `../clipboard/evidence/` |
| `../clipboard/13-fifth-round-final-acceptance.md` | 第五轮 GUI 联合验收与发布证据链 |
| `../clipboard/evidence/p1-05-gui-20261031/`、`p1-05-rerun-20261031-0943/` | GUI 联合验收的原始截图与机器结果 |

## 四、历史设计迭代

| 目录 | 内容 |
|---|---|
| `v04/` | 320 / 400 窄窗、浅色 / 深色、紧凑 / 完整 / 极简布局 |
| `v05/` | v04 基础上的动作行、右键菜单、上下文详情延伸 |
| `v06/` | 液态玻璃、梦幻渐变、320 窄窗、设置与菜单浮层 |
| `v07/` | DWM 玻璃区域、圆角、缩放与材质实验（含 `audit-v07.json`） |

历史目录中的 `audit*.json` 是采集时的机器审计数据，不是本轮验收依据。

## 五、临时测试证据（不进正式目录）

| 目录 | 说明 |
|---|---|
| `../../tmp/acceptance/clipboard-workbench-responsive/` | 2026-11-16 第二轮响应式改造的原始截图与 manifest；报告见同目录 `report.md`，正式结论以 `../clipboard/14-2026-11-19-ui-polish-acceptance.md` 的「历史材料」一节为准 |
| `../../tmp/acceptance/clipboard-ui-polish-20261119/` | 2026-11-19 第三轮精修的原始截图、矩阵 JSON、截图脚本；正式筛选图归档到 `docs/screenshots/clipboard/2026-11-19/` |
| `../../tmp/acceptance/projection-unify/` | 其他并行任务的投屏专项证据，与本目录无关 |

> 临时目录已被 `.gitignore` 忽略；需要复核时按报告中的路径在本机查看，不把临时截图冒充
> 当前正式验收图。
