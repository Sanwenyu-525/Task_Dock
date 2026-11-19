# 文件工作区唯一功能登记表（Feature Registry）

- 日期：2026-11-19（Asia/Shanghai）
- 阶段：**R10 开发前方案**（三层会话模型重构；只做盘点、登记、方案；未改业务代码、未执行测试）
- 模块：`workspace/files`
- 相关文档：[技术架构与数据模型](../architecture/files-workspace.md)、
  [测试矩阵](../testing/files-workspace.md)、[验收矩阵](../acceptance/files-workspace.md)
- 既有专项记录：[矩形框选与选择状态](../files-workspace-marquee-selection.md)、
  [ARCHITECTURE 文件工作区章节](../ARCHITECTURE.md)、[WORKSPACE_PROJECTS](../WORKSPACE_PROJECTS.md)、
  [shelf/README](../shelf/README.md)、[global-search/README](../global-search/README.md)

> 本文件是文件工作区**唯一**功能台账。功能、接口、数据结构变化时必须同步更新本文件；
> 其他文档只记录实现细节、测试结果与验收结论，不另建第二份功能清单。

---

## 1. 维护规则与事实优先级

1. **事实优先级**：代码与可复现输出 > 测试/真机证据（命令、时间、退出码、证据路径）> 文档。
   本文档与代码冲突时以代码为准，并在本文「变更记录」中更正。
2. **禁止重复登记**：同一能力只能有一个 Feature ID；发现重复实现时先登记「重复实现风险」，
   在架构文档确定唯一实现后再开发。
3. **状态只允许**：`PLANNED`、`DESIGNING`、`IMPLEMENTING`、`TESTING`、`PARTIAL`、`PASS`、
   `BLOCKED`、`DEPRECATED`。
4. **本轮不产生 PASS**：Phase 1 未执行任何测试或原生验收，因此既有功能最高只能标
   `TESTING` 或 `PARTIAL`；历史报告中的 PASS 只用于定位，不自动复制为本轮结论。
5. **每个 Feature 的 DoD**（进入 `TESTING` 的最低条件）：
   产品方案、UI 入口、API/函数、数据模型、错误处理、自动化测试、实际交互测试、验收证据、
   本表状态更新，九项齐全。缺少任一项不得标 `PASS`。
6. **防遗漏流程**：代码完成 → 测试完成 → 本文状态更新 → 验收文档更新 → 记录 commit/snapshot。
   禁止「代码完成但文档没更新」「文档标 PASS 但无测试证据」「UI 完成就认为功能完成」。

### 1.1 状态判定口径

| 状态 | 判定 |
|---|---|
| `PLANNED` | 无实现；仅有产品或技术方案 |
| `DESIGNING` | 方案评审中；数据结构/接口未冻结 |
| `IMPLEMENTING` | 本轮正在写代码 |
| `TESTING` | 代码已实现，测试文件存在，但本轮回归/原生验收未完成 |
| `PARTIAL` | 只实现一部分能力或只覆盖部分边界；缺口在「现有/目标」中写明 |
| `PASS` | 本轮或指定构建版本上，自动化 + 必要原生验收均有可追溯证据 |
| `BLOCKED` | 外部依赖或环境阻塞，且不能在当前范围解决 |
| `DEPRECATED` | 被唯一新实现替代，保留登记与迁移说明 |

### 1.2 优先级口径

- **P0**：文件工作区作为可用文件管理器的基础闭环；缺失会导致核心流程不可用或数据风险。
- **P1**：TaskDock 差异化能力（多目录工作台、暂存、项目空间、设备互传、撤销、标签）。
- **P2**：高级/长期能力（自动化、智能分析、压缩、关系图），允许分阶段交付。

---

## 2. 总览

| 维度 | 数量 |
|---|---|
| Feature 总数 | **47** |
| P0 / P1 / P2 | **21 / 17 / 9** |
| 已有实现（TESTING + PARTIAL） | **36** |
| 待开发（PLANNED） | **11** |
| PASS（本轮） | **0** |
| BLOCKED / DEPRECATED | **0 / 0** |

按状态：

| 状态 | 数量 | Feature |
|---|---|---|
| TESTING | 15 | FW-LAYOUT-001、FW-SELECT-001、FW-SELECT-002、FW-DRAG-001、FW-FILE-001、FW-FILE-002、FW-FILE-003、FW-FILE-004、FW-NAV-002、FW-OPS-003、FW-SEARCH-002、FW-RENAME-001、FW-RECYCLE-001、FW-SMART-002、FW-COMPARE-001 |
| PARTIAL | 21 | FW-NAV-001、FW-OPS-001、FW-OPS-002、FW-OPS-004、FW-SEARCH-001、FW-SEARCH-003、FW-INFO-001、FW-SYS-001、FW-SYS-002、FW-WORKSPACE-001、FW-WORKSPACE-002、FW-WORKSPACE-003、FW-FAV-001、FW-FAV-002、FW-FILTER-001、FW-COLLECT-001、FW-COLLECT-002、FW-PROJECT-001、FW-DEVICE-001、FW-PREVIEW-001、FW-DRAG-002 |
| PLANNED | 11 | FW-UNDO-001、FW-FILTER-002、FW-TAG-001、FW-HISTORY-001、FW-AUTO-001、FW-SMART-001、FW-SMART-003、FW-ARCHIVE-001、FW-PROJECT-002、FW-COLLECTION-001、FW-RELATION-001 |

> 说明：`FW-LAYOUT-001`、`FW-SELECT-001/002`、`FW-DRAG-001/002`、`FW-RENAME-001`、
> `FW-RECYCLE-001`、`FW-COMPARE-001`、`FW-PREVIEW-001` 是为覆盖现有能力而**补充登记**的 ID；
> 任务原文 P0 清单中的「矩形框选/多选/跨目录拖拽」因此有了永久标识，不再以自然语言散落。

---

## 2.5 产品方案

### 2.5.1 定位

> **Windows 文件系统之上的多目录生产力工作台**，不是「另一个资源管理器」。

差异化不在于「能复制/删除」，而在于：

1. **多目录同时在场**：一个窗口内多个目录并排/分栏，跨目录操作不需要来回切窗口。
2. **选择 → 暂存 → 预演 → 执行**：批量操作前先收集、先预演、再执行，降低误操作。
3. **项目文件空间**：项目绑定多个目录与角色，打开项目即恢复现场。
4. **与 TaskDock 其他能力联动**：暂存架、任务、项目、手机互传、回收站、活动历史。

### 2.5.2 核心工作流（目标）

```text
打开项目
  → 恢复上次文件工作区布局
  → 同时打开多个目录（代码 / 素材 / 构建 / 文档）
  → 搜索 / 筛选 / 框选 / 多选
  → 加入暂存架
  → 跨目录拖拽或构建投递计划
  → 操作预演（数量 / 字节 / 冲突 / 无权限）
  → 确认
  → 后台操作队列（进度 / 暂停 / 取消 / 重试）
  → 完成
  → 操作历史
  → 必要时撤销（仅可逆操作）
```

### 2.5.3 UI 信息架构

```text
顶部工具栏
├── 导航（前进 / 后退 / 上一级 / 地址栏）
├── 搜索（当前目录 / 所有打开目录 / 工作区 / 项目）
├── 筛选（类型 / 大小 / 时间 / 预设）
├── 排序
└── 更多（布局 / 模板 / 重复文件 / 文件夹对比 / 回收站）

主区域
├── 多目录窗格（标签 / 分栏 / 最大化）
├── 文件列表或网格（虚拟化 / 框选 / 多选）
└── 操作队列条（底部，运行中与最近任务）

右键菜单
├── 打开 / 打开方式 / 在资源管理器中显示 / 在终端中打开
├── 复制 / 剪切 / 粘贴 / 复制路径 / 复制文件名
├── 重命名 / 批量重命名 / 删除 / 永久删除
├── 收藏 / 加入暂存架 / 加入收藏集 / 标签
├── 压缩 / 解压（P2）
└── 属性

侧边面板（按需，不挤占主区域）
├── 详细信息
├── 操作队列
├── 收藏 / 最近访问
├── 暂存架
└── 活动历史
```

### 2.5.4 产品原则

1. **非破坏优先**：默认回收站；永久删除独立入口；外部拖入恒复制；标签/收藏/集合不移动文件。
2. **先预演后执行**：批量移动/复制/删除/解压/自动化默认先给预演；高风险操作不得绕过。
3. **可观察**：每个长任务有进度、终态、失败明细；不显示假取消、假成功。
4. **能力复用**：暂存架、设备传输、回收站、项目容器不重建；文件工作区只做入口与编排。
5. **渐进披露**：主界面保持干净，高级能力进「更多」/侧栏/对话框，不把所有按钮堆进文件行。
6. **大目录优先**：任何新功能都必须先证明不破坏虚拟化与 25k 文件的交互。

### 2.5.5 非目标

- 不实现完整的 Windows Shell 替代（不接管系统右键菜单、不替换默认文件关联）。
- 不实现云盘同步/版本控制（设备互传仅限已配对移动端）。
- 不基于 AI 猜测文件关系或自动移动用户文件。
- 不在本轮实现压缩/自动化/相似图片等 P2 能力（仅登记）。

---

## 3. Feature Registry

### 3.1 窗格、布局与导航

#### FW-LAYOUT-001 多窗格布局与标签会话 `P0` · `TESTING`
- 目的/场景：一个窗口同时浏览多个目录；布局变化不丢已打开目录。
- 现有：是。`src/lib/filesWorkspace/model.ts:27-33`（窗格≤12/树深≤6/标签≤12/比例）、
  `model.ts:82-189`（分割/移除/交换/比例）；`src/store/useFilesWorkspaceStore.ts:167-278`
  （树、标签、最大化、收纳、布局撤销栈）；`src/lib/filesWorkspace/persist.ts:14-267`；
  `src/components/files/FilesWorkspacePanel.tsx:1754-1940`（工具栏/预设/模板）；
  `src/components/files/FilePane.tsx:1348-1616`（标签栏/分栏菜单）。
- 目标 UI：顶部工具栏布局菜单、模板抽屉、布局编辑模式；保持现入口，不新增第二套布局面板。
- 目标 API/函数：沿用 `splitPane/removePane/updateRatio/swapPanes/applyLayoutPresetPreservingTabs/
  applyTemplate/saveCurrentAsTemplate/undoLayout/redoLayout`；不新增替代 Store。
- 数据模型：`SplitNode`、`PaneState`、`FolderTab`、`FilesWorkspacePersisted`（设置键
  `file_workspace_layouts`，states≤8/模板≤20/≤256KB）。
- 依赖：无（其他能力的容器）。
- 测试/验收：`model.test.ts`、`persist.test.ts`、`layoutTransfer.test.ts`、
  `FilesWorkspacePanel.splitter.test.tsx`、`FilesWorkspacePanel.drawer.test.tsx`、
  `FileList.layout.test.tsx`、`FileList.scroll.test.tsx`；本轮未执行。
  验收：布局切换保留标签/导航/选择语义；强制重启恢复；容量阻止不静默丢标签。

  **R10 扩展（2026-11-19，方案已定，代码/测试未执行）**：本 Feature 是 R10「标签会话模型、
  分割窗格与空窗格管理重构」唯一承载 ID，不另建新 ID。扩展子能力（均为本 Feature 的实现细节，
  不单列 Feature）：
  - **标签起始目录身份**：`FolderTab` 新增 `openedPath`（用户最初添加的目录），与 `path`
    （当前浏览位置）分离；`openedPath` 是身份与显示来源，不是权限边界。
  - **标签名称稳定**：`tabTitle()` 由 `basename(tab.path)` 改为 `basename(tab.openedPath)`；
    面包屑继续用实时 `path`。悬停 Tooltip 显示「名称 + 完整起始路径」。
  - **标签完整会话复制**：新增纯函数 `duplicateTab(sourceTab)` 深拷贝全部可持久化浏览状态；
    `splitPane()` 改用它复制当前激活标签，不再只复制 path 后 `makeTab()` 重建。
  - **空窗格管理**：新增 `closeEmptyPane()` / `closeAllEmptyPanes()`，UI 空窗格保留统一窗格框架与
    关闭/更多入口；最后一个窗格受 Store 层保护。
  - **持久化兼容**：`PersistedTab` 追加 `openedPath` 及会话字段（可选），
    `hydrate()` 以 `openedPath ?? path` 迁移旧数据；模板/归一化同步扩展。
  - 三层职责：**标签=独立可恢复的目录浏览会话；窗格=承载标签的容器；布局=窗格的组织结构**。
  - 状态：本轮先 `DESIGNING` → 代码实现后转 `IMPLEMENTING` → 测试/原生证据齐全才可 `PASS`。

#### FW-NAV-001 地址栏（面包屑 / 路径输入 / 复制路径） `P0` · `PARTIAL`
- 目的/场景：快速看清当前位置并跳转到任意绝对路径；Windows 用户习惯 Ctrl+L。
- 现有：是（部分，本批扩展）。`FilePane.tsx:1410-1484` 面包屑 + 可编辑路径输入（Enter 跳转、
  Escape 取消、blur 取消）；`FilesWorkspacePanel.tsx` Ctrl+L 聚焦路径输入；
  `FilePane.tsx` 复制路径；`useFilesWorkspaceStore.ts:73-88,207` 每标签导航历史；
  本批新增地址栏路径历史下拉（最近目录，可清除；`clearRecentDirs` + Store 测试）。
- 目标 UI：路径栏支持直接输入、面包屑分段、复制路径；**路径历史下拉**（最近访问路径）。
- 目标 API/函数：新增 `getPanePath / setPanePathInput / commitPanePathInput /
  cancelPanePathInput / navigatePaneToPath / getPaneNavigationHistory /
  clearPaneNavigationHistory`；复用 `openInPane / navigate`。
- 数据模型：`FolderTab.history[] + historyIndex`（已有）；路径输入为 UI 会话态，不落库。
- 依赖：FW-WORKSPACE-002。
- 测试/验收：`FilePane.browse.test.tsx`、`useFilesWorkspaceStore.test.ts`；缺口：路径历史
  列表、历史清理 API、无效路径的显式校验反馈。验收：Ctrl+L→输入→Enter 跳转；Escape
  不改路径；复制路径与真实路径一致；历史前进/后退不串标签。

#### FW-NAV-002 前进 / 后退 / 上一级 `P0` · `TESTING`
- 目的/场景：像资源管理器一样按历史导航，每个窗格独立。
- 现有：是。`useFilesWorkspaceStore.ts:207` `navigate(paneId, "back"|"forward"|"up")`；
  `FilePane.tsx:1249-1251` 可用性判断、`1390-1404` 工具栏按钮；
  `FilesWorkspacePanel.tsx` 键盘处理新增 `Alt+Left / Alt+Right / Alt+Up`（活动窗格）。
- 目标 UI：工具栏前进/后退/上一级按钮 + 键盘快捷键。
- 目标 API/函数：`canNavigateBack / canNavigateForward / canNavigateUp / navigatePaneBack /
  navigatePaneForward / navigatePaneUp`（包既有 `navigate`）。
- 数据模型：每标签 `history/historyIndex`（已有）。
- 依赖：FW-NAV-001、FW-LAYOUT-001。
- 测试/验收：`useFilesWorkspaceStore.test.ts`、`FilesWorkspacePanel.dragLifecycle.test.tsx`
  新增 Alt 导航用例（本批已通过）；缺口：关闭标签后的历史清理断言。
  验收：每窗格历史独立；换布局不丢历史；关闭窗格无残留。

### 3.2 选择与拖拽

#### FW-SELECT-001 文件选择系统（单选/多选/Ctrl/Shift/键盘） `P0` · `TESTING`
- 目的/场景：所有高级文件操作的统一选择基础；不允许第二套 selection state。
- 现有：是。`useFilesWorkspaceStore.ts:168,275-276`（`selection: Record<paneId,{paths,anchor}>`、
  `setSelection/clearSelection/removePathsFromSelections`）；`FilePane.tsx:352`（focusedPath
  与选择分离）、`649-740`（点击/右键/键盘合并）；`FileList.tsx:389-437`（选中/焦点/落点 props）。
- 目标 UI：行/卡片选中、焦点环、Shift 范围、Ctrl 切换、Ctrl+A、方向键/Home/End、右键保留多选。
- 目标 API/函数：`getSelectedItems / setSelectedItems / addSelectedItems / removeSelectedItems /
  clearSelection / selectAll`（薄封装既有 Store action，不复制状态）。
- 数据模型：`PaneSelection { paths: string[]; anchor: string | null }`。
- 依赖：FW-LAYOUT-001。
- 测试/验收：`FilePane.selection.test.tsx`、`useFilesWorkspaceStore.test.ts`；
  本轮未执行。验收：焦点≠选中；右键已选项保留整组；过滤/刷新后选择与真实条目一致。

#### FW-SELECT-002 矩形框选 `P0` · `TESTING`
- 目的/场景：空白处拖拽快速选择区域；大目录下不遍历全部 DOM。
- 现有：是。`src/lib/filesWorkspace/marqueeSelection.ts` 全量（几何/合并/自动滚动/键盘索引）；
  `FileList.tsx:242-269,537-643`（虚拟可见范围、5px 阈值、rAF、Escape/PointerCancel）；
  `FilePane.tsx:702-740`（replace/add/toggle 合并）；专项说明
  `docs/files-workspace-marquee-selection.md`。
- 目标 UI：半透明矩形、自动滚动、Shift 并集、Ctrl 对称差、Escape 恢复基准。
- 目标 API/函数：`beginMarqueeSelection / updateMarqueeSelection / commitMarqueeSelection /
  cancelMarqueeSelection`（现有实现为组件内状态机 + 纯函数，计划提取薄 facade）。
- 数据模型：`MarqueeRect / MarqueeGeometry / MarqueeEntry`（内存态，不落库）。
- 依赖：FW-SELECT-001。
- 测试/验收：`marqueeSelection.test.ts`（含 25000 项候选）、`FileList.marquee.test.tsx`；
  本轮未执行。验收：贴边不命中；取消恢复基准；框选自身零文件 IPC。

#### FW-DRAG-001 应用内文件拖拽（同目录/跨窗格/跨目录） `P0` · `TESTING`
- 目的/场景：把文件拖到另一窗格/文件夹行，完成复制或移动。
- 现有：是。`src/lib/filesWorkspace/interactions.ts:22-275`（单例拖拽协调器、默认同卷移动/
  跨卷复制、Ctrl=复制/Shift=移动、释放前显示）；`FilePane.tsx:444-600`（命中与落点）；
  `src/lib/filesWorkspace/transfer.ts`（冲突探测/目标选择/成功源清理）；
  `volumeCache.ts`（真实卷键）。
- 目标 UI：拖拽 ghost、落点预览、文件夹行高亮、取消路径。
- 目标 API/函数：`startFwDrag / moveFwDrag / finishFwDrag / cancelFwDrag /
  validateFileDrop / resolveEffect`（已有）。
- 数据模型：`FwDragPayload / FwDropZone / FwDragState`。
- 依赖：FW-SELECT-001、FW-FILE-001/002、FW-OPS-004。
- 测试/验收：`interactions.test.ts`、`FilePane.drag.test.tsx`、
  `FilesWorkspacePanel.dragLifecycle.test.tsx`、`transfer.test.ts`；本轮未执行。
  验收：取消/失焦/卸载零 IPC；跨目录落盘真实成功；同卷移动跨卷复制。

#### FW-DRAG-002 外部 OS 拖入 / 拖出 `P1` · `PARTIAL`
- 目的/场景：从资源管理器拖文件进 TaskDock；从 TaskDock 拖到桌面/微信等外部应用。
- 现有：是（部分）。`src/lib/fileDrop.ts:2-35`（单一消费者仲裁）；`FilesWorkspacePanel.tsx:1280-1330`
  （外部来源恒复制、释放后端会话）；`bridge.ts:6077` `fsDragOut`；Rust 复用暂存架 OLE 数据源。
  缺口：OLE 物理拖入/拖出的原生手感与第三方应用兼容未在本轮验证。
- 目标 UI：外部拖入落点提示、拖出 ghost、不允许时的明确反馈。
- 目标 API/函数：`registerFileDropConsumer / dropTargetAt / fsDragOut`（已有）。
- 数据模型：`DragPayloadView`（运行时身份，不落库）。
- 依赖：FW-DRAG-001。
- 测试/验收：`FilesWorkspacePanel.dragLifecycle.test.tsx`；原生 OLE 需通道 F 授权后验证。

### 3.3 文件剪贴板与文件操作

#### FW-FILE-001 文件复制 `P0` · `TESTING`
- 目的/场景：Ctrl+C / 右键复制选中项，再粘贴到目标目录或另一窗格。
- 现有：是。`interactions.ts:269-276` 文件剪贴板；`FilesWorkspacePanel.tsx:1430-1454` Ctrl+C；
  `FilePane.tsx:1145-1160` 右键复制；`fsCopyJobStart`（`bridge.ts:6060-6065`）后台任务；
  跨窗格复制 `requestCrossPane("copy")`。
- 目标 UI：右键/快捷键/跨窗格按钮；复制后源项不被删除。
- 目标 API/函数：`copySelectedFiles(paneId)` → `setFwClipboard({mode:"copy"})`；
  实际执行复用 `requestTransfer/applyFileDrop`。
- 数据模型：`FileClipboardPayload { operation, items, sourcePaneId, createdAt }`（目标；
  现有仅 `{mode, paths}` 内存态）。
- 依赖：FW-SELECT-001、FW-OPS-001。
- 测试/验收：`interactions.test.ts`、`transfer.test.ts`、`fileJobs.test.ts`；本轮未执行。
  验收：复制不删源；跨卷/同卷均可；失败项保留在剪贴板。

#### FW-FILE-002 文件剪切 `P0` · `TESTING`
- 目的/场景：Ctrl+X 后粘贴为移动；同卷原子重命名优先，跨卷复制+删除。
- 现有：是。`FilesWorkspacePanel.tsx:1434-1437` Ctrl+X；`FilePane.tsx:1153-1160`；
  粘贴完成后只移除报告明确成功的源项（`remainingSourcesAfterTransfer`）。
- 目标 UI：剪切态视觉（可选，现有仅 toast）；右键/快捷键。
- 目标 API/函数：`cutSelectedFiles(paneId)`；复用 `fsMoveJobStart`。
- 数据模型：同 FW-FILE-001。
- 依赖：FW-FILE-001。
- 测试/验收：`transfer.test.ts`、`fileJobs.test.ts`；缺口：剪切态跨刷新/重启的清理策略。
  验收：移动成功后源消失、目标存在；部分失败保留未完成源项。

#### FW-FILE-003 文件粘贴 `P0` · `TESTING`
- 目的/场景：Ctrl+V / 空白右键粘贴到当前目录；有冲突时先询问。
- 现有：是。`FilesWorkspacePanel.tsx:1438-1454`（剪切收尾绑定本次请求）；
  `FilePane.tsx:1219-1234` 空白右键粘贴（事件交面板执行）；
  `transfer.ts:33-61` 冲突探测；`FilesWorkspacePanel.tsx:2449-2531` 整批冲突对话框
  （跳过/覆盖/保留两者）；`applyFileDrop` 默认 `rename`。
- 目标 UI：右键粘贴、Ctrl+V、禁用态、冲突对话框。
- 目标 API/函数：`canPasteFiles(targetPaneId) / pasteFiles(targetPaneId)`。
- 数据模型：`FileClipboardPayload`；冲突策略 `skip|rename|overwrite`。
- 依赖：FW-FILE-001/002、FW-OPS-004。
- 测试/验收：`transfer.test.ts`、`fileJobs.test.ts`；缺口：逐项冲突（当前整批单一策略）、
  目标目录自身/子目录自引用拒绝的显式断言。验收：同名冲突不静默覆盖；取消不产生 IPC。

#### FW-FILE-004 文件操作剪贴板状态 `P0` · `TESTING`
- 目的/场景：文件剪贴板与系统文本剪贴板严格分离；状态可查询、可清理。
- 现有：是。`interactions.ts` 新增 `FwClipboardPayload { mode, paths, sourcePaneId, createdAt }`、
  `clearFwClipboard / hasFwClipboardItems / getFwClipboardOperation`；空路径等同清空；
  复制/剪切调用点（FilePane 右键、面板 Ctrl+C/X）均带 `sourcePaneId`；剪切部分失败时保留
  未完成项与来源窗格。
- 目标 UI：粘贴可用性、剪切态提示、清理入口。
- 目标 API/函数：`getFileClipboard / setFileClipboard / clearFileClipboard / hasClipboardItems /
  getClipboardOperation`。
- 数据模型：`FwClipboardPayload`（内存态，不落库；不写系统剪贴板）。
- 依赖：无。
- 测试/验收：`interactions.test.ts` 新增来源/创建时间/清空/空路径用例（已通过）；
  缺口：与系统剪贴板隔离的原生断言、过期清理策略。
  验收：复制文件不覆盖用户文本剪贴板；粘贴后状态符合预期。
- 2026-11-18 r8 验收发现（B 通道，预览 harness）：复制后空白处右键「粘贴」为可用态；
  但**剪切项无任何视觉标记**（`fw-row` 仍为 `is-selected is-active`、opacity=1、无 cut 类），
  且 `clearFwClipboard` **没有 UI 入口**（仅单测调用）。目标 UI 的「剪切态提示、清理入口」
  仍未实现，故由 `TESTING` 下调为 `PARTIAL`。
- 2026-11-19 r9 修复（代码 + 单测完成，原生验收待做）：`interactions.ts` 新增
  `subscribeFwClipboard` + `useFwClipboard`（`useSyncExternalStore`，权威状态仍只有模块级
  一份）；`FileList` 新增 `cutPaths`（小写归一化 Set，O(1) 命中），列表 `.fw-row.is-cut` 与
  网格 `.fw-cell.is-cut` 按资源管理器习惯降透明度；面板新增「已剪切 N 项 + 取消剪切」横幅
  （`fw-cut-banner`）与空白菜单「取消剪切」入口；粘贴可用性随订阅实时变化；剪切收尾保留
  `sourcePaneId`。新增/扩展测试：`interactions.test.ts`（订阅 3 例）、`FilePane.selection.test.tsx`
  （剪切 7 例，含跨窗格/网格/25k 性能）、`FilesWorkspacePanel.dragLifecycle.test.tsx`
  （Ctrl+X/C/V 链路 5 例）。缺口不变：与系统剪贴板隔离的原生断言。

#### FW-RENAME-001 重命名与批量重命名 `P1` · `TESTING`
- 目的/场景：F2 重命名；多选批量前缀/后缀/替换/序列等。
- 现有：是。`FilePane.tsx:1377-1386` F2；`BatchRenameDialog.tsx`；
  `src/lib/filesWorkspace/batchRename.ts:6-152`（模式/校验/预览）；Rust `fs_rename`、
  `fs_batch_rename`、`fs_batch_rename_job_start`；`fsOpFeedback.ts`。
- 目标 UI：右键重命名/批量重命名、冲突预览、逐项报告。
- 目标 API/函数：`fsRename / fsBatchRename`（已有）+ 服务层 `renameSelected`。
- 数据模型：`BatchRenameOptions / BatchRenamePreviewItem`。
- 依赖：FW-SELECT-001、FW-OPS-001。
- 测试/验收：`batchRename.test.ts`；缺口：`BatchRenameDialog` 组件测试、原生逐项失败验收。
  验收：非法名/冲突预检；部分成功如实显示。

#### FW-OPS-001 文件操作任务队列 `P0` · `PARTIAL`
- 目的/场景：复制/移动/删除/重命名不再各写一套线程与进度，统一排队、可取消。
- 现有：是（部分）。Rust `src-tauri/src/fsops/mod.rs:41-97`（事件
  `recycle:job-progress`、固定 2 worker、排队上限 32、历史 24、失败明细 200）；
  `commands/recycle.rs:63-180`（`fs_copy_job_start/fs_move_job_start/fs_delete_job_start/
  fs_job_status/fs_job_cancel/fs_job_report`）；前端 `fileJobs.ts:156-282`；
  `operationQueue.ts:42-127`（前端单并发槽、不可取消标记）。
  缺口：无 `compress/extract`；无 `pause/resume/retry`；任务不持久化（重启不恢复，符合约束）。
- 目标 UI：操作队列条（现有 `OperationQueueBar.tsx`），扩展暂停/继续/重试。
- 目标 API/函数：`enqueueFileOperation / startFileOperation / pauseFileOperation /
  resumeFileOperation / cancelFileOperation / retryFileOperation / getFileOperation /
  getFileOperations`。
- 数据模型：`JobSnapshot`（现有）+ 字节进度/速度/ETA/当前项。
- 依赖：FW-FILE-001/002/003、FW-OPS-002。
- 测试/验收：`fileJobs.test.ts`、`operationQueue.test.ts`；Rust `fsops` 单测。
  验收：排队/运行/取消状态真实；不可取消时 UI 不显示假取消。

#### FW-OPS-002 文件操作进度 `P0` · `PARTIAL`
- 目的/场景：用户能看到当前任务、数量、字节、速度、剩余时间，并可暂停/继续/取消/重试。
- 现有：是（部分）。`JobSnapshot`（`fsops/mod.rs:72-97`）提供
  `status/total/done/ok/failed/partial/skipped/phase/cancelable/cancelRequested/failures`；
  进度事件 100ms 节流；`OperationQueueBar.tsx:51-160` 显示数量与取消。
  缺口：无 `totalBytes/completedBytes/speedBytesPerSecond/estimatedRemainingMs/currentItem`；
  无暂停/继续/重试。
- 目标 UI：队列条展开详情；每任务进度条与速度/ETA。
- 目标 API/函数：`getFileOperationProgress(operationId)`（事件 + 快照）。
- 数据模型：`FileOperationProgress`（目标结构见架构文档）。
- 依赖：FW-OPS-001。
- 测试/验收：`fileJobs.test.ts`；缺口：字节统计与速度计算测试、暂停/恢复测试。
  验收：事件不丢终态；完成后停止轮询；取消后状态正确。

#### FW-OPS-003 文件操作预演（Operation Preview） `P0` · `TESTING`
- 目的/场景：移动/复制大量文件前先告诉用户：多少项、多少字节、多少冲突/无权限/重复，
  再确认执行。
- 现有：是（本批实现）。Rust `file_workspace::preview_transfer`（只读统计，条目上限
  50,000、深度 64、不跟随重解析点）；命令 `fs_preview_operation`；
  前端 `operationPreview.ts` + `OperationPreviewDialog.tsx`；`requestTransfer` 在
  复制≥20 项或移动≥10 项时先预演，确认后才进入冲突决策/执行。
- 目标 UI：确认对话框（即将移动 N 项 / 冲突 M / 无权限 K / 预计字节 / 不完整提示；取消/确认）。
- 目标 API/函数：`previewFileOperation / shouldPreviewTransfer`（已有）；后续可扩展
  `confirmFileOperation(previewId)` 以复用预演结果。
- 数据模型：`OperationPreview { effect, items, files, dirs, bytes, conflicts,
  inaccessible, duplicates, warnings, complete }`。
- 依赖：FW-OPS-001/004、FW-INFO-001。
- 测试/验收：`operationPreview.test.ts`、`OperationPreviewDialog.test.tsx`（已通过）；
  Rust `preview_transfer_counts_and_detects_conflicts` /
  `preview_transfer_rejects_move_into_own_subtree`（已编写，因共享工作树其他模块编译错误
  尚未执行）；原生大批量预演待验收。高风险操作不得绕过预演。
- 2026-11-19 r9 安全收口：Rust `measure_tree` 元数据读取失败不再当作零字节成功——进入
  `inaccessible` 并置 `complete=false`（深度/条目上限与目录读取失败此前已置不完整）；
  顶层 `validate_abs_path` 失败与源消失同样置 `complete=false`。`OperationPreviewDialog`
  新增完整性门禁：`complete=false` 时隐藏普通「确认」，须勾选「我理解本次只会处理能够
  成功访问的文件」后才能「继续处理可访问项」（勾选随每次新预演重置）；面板 `confirmPreview`
  确认前二次验证——目标目录仍存在、源条目仍存在（`transfer.checkSourcesExist`，IPC 失败
  即中止）、重新检测同名冲突（不沿用预演时刻的冲突清单）。Rust 新增 7 个完整性用例
  （源消失/目标缺失/目录冲突/深度上限/条目上限/元数据失败/自身子树），66/66 通过；
  前端对话框门禁 4 例通过。原生大批量预演仍待验收。

#### FW-OPS-004 文件操作冲突处理 `P0` · `PARTIAL`
- 目的/场景：同名文件冲突时统一选择覆盖/跳过/重命名/保留两者/全部应用。
- 现有：是（部分）。`FilesWorkspacePanel.tsx:2449-2531` 整批单一策略；
  Rust `parse_conflict`（`skip|rename|overwrite`）；`transfer.ts` 冲突探测。
  缺口：逐项冲突决策、`resolveFileConflict/resolveAllFileConflicts` API、跨操作统一。
- 目标 UI：逐项冲突列表 + 全部应用；策略预览。
- 目标 API/函数：`resolveFileConflict(conflictId, resolution) /
  resolveAllFileConflicts(operationId, resolution)`。
- 数据模型：`FileConflict { source, target, kind, resolution }`。
- 依赖：FW-OPS-003。
- 测试/验收：`transfer.test.ts`；缺口：逐项决策测试、目录冲突、同名文件夹合并策略。
  验收：绝不静默覆盖；取消保持目标不变。

#### FW-UNDO-001 文件操作撤销 / 重做 `P1` · `PLANNED`
- 目的/场景：误移动/误重命名后快速恢复；不能假设所有操作都可撤销。
- 现有：否（仅布局撤销 `undoLayout/redoLayout`，明确不撤销文件系统操作）。
  回收站还原是人工恢复路径，不等同撤销。
- 目标 UI：操作完成后「撤销」入口；不可撤销时明确置灰与原因。
- 目标 API/函数：`canUndoFileOperation / getUndoableOperations / undoFileOperation /
  redoFileOperation`。
- 数据模型：`FileOperationHistory { id, operation, sourceItems, targetPath, timestamp,
  reversible, inverse? }`；永久删除、外部修改、已被覆盖、第三方移动 → `reversible:false`。
- 依赖：FW-OPS-001、FW-HISTORY-001。
- 测试/验收：单元（可逆矩阵）+ 原生（移动/重命名撤销，永久删除不可撤销）。
  不得把回收站还原冒充撤销。

### 3.4 搜索、筛选、信息与预览

#### FW-SEARCH-001 多目录搜索 `P0` · `PARTIAL`
- 目的/场景：同时搜索所有已打开目录，结果带所在窗格与完整路径，双击定位。
- 现有：是（部分）。`workspaceSearch.ts:94-180`（递归、深度/结果/目录上限、分页、
  `complete` 四态）；`WorkspaceSearchDialog.tsx`；`FilesWorkspacePanel.tsx`
  `searchSources` = 各窗格活动目录；本批新增 `workspaceSearchSources`：项目根目录 +
  固定目录作为可选来源（`revealSearchHit` 对非真实窗格来源回落到活动窗格）。
  缺口：收藏分组/最近目录范围、当前目录即时搜索（现为 `tab.search` 名称过滤）。
- 目标 UI：搜索对话框范围选择（当前目录/当前窗格/所有打开目录/项目/收藏）。
- 目标 API/函数：`searchFiles / searchPaneFiles / searchWorkspaceFiles /
  searchProjectFiles`（服务层封装 `searchWorkspace`）。
- 数据模型：`SearchSource / SearchHit / SearchOptions / SearchResult`（已有）。
- 依赖：FW-WORKSPACE-001、FW-PROJECT-001。
- 测试/验收：`workspaceSearch.test.ts`、`WorkspaceSearchDialog.test.tsx`（已通过）；
  缺口：新来源（项目/固定目录）的组件测试。
  验收：重叠根去重；取消后不再调度；大目录有界。

#### FW-SEARCH-002 搜索条件 `P0` · `TESTING`
- 目的/场景：按名称、扩展名、类型、大小、修改时间、隐藏项组合筛选。
- 现有：是（本批补齐）。`SearchOptions` 支持
  `query/extensions/category/modifiedWithinDays/minSize/maxSize/includeHidden/
  maxDepth/maxResults/maxDirs`；对话框新增最小/最大 MB 与「包含隐藏项」；
  `includeHidden` 透传后端 `fs_list_dir`，目录不参与大小过滤。
- 目标 UI：搜索对话框高级条件区。
- 目标 API/函数：`FileSearchQuery`（`types` 仍以 `category` 近似）。
- 数据模型：`SearchOptions`（已扩展，新字段可选，兼容旧调用）。
- 依赖：FW-SEARCH-001。
- 测试/验收：`workspaceSearch.test.ts` 新增隐藏项与大小区间用例（已通过）；
  缺口：时间区间（`modifiedAfter/Before` 仍以「最近 N 天」近似）。
  验收：条件组合正确；上限仍生效。

#### FW-SEARCH-003 搜索生命周期 `P0` · `PARTIAL`
- 目的/场景：连续输入不能启动多个完整磁盘扫描；可取消、可知道状态。
- 现有：是（部分）。`WorkspaceSearchDialog.tsx:56-125` `AbortController` + 请求代际；
  `searchWorkspace` 在目录/分页边界检查 `signal`。当前是手动「搜索」按钮，不是输入即搜。
  缺口：`start/update/cancel/status/results` 统一会话 API；前端防抖策略未固化。
- 目标 UI：搜索中/停止/完成/不完整状态；停止按钮（已有）。
- 目标 API/函数：`startFileSearch / updateFileSearch / cancelFileSearch /
  getFileSearchStatus / getFileSearchResults`。
- 数据模型：`FileSearchSession { id, query, status, progress, result, startedAt }`。
- 依赖：FW-SEARCH-001/002。
- 测试/验收：`WorkspaceSearchDialog.test.tsx`、`workspaceSearch.test.ts`；
  缺口：连续输入只保留最后一代的组件测试、取消后结果不回写。
  验收：a→ab→abc 不产生并行扫描；取消不产生晚到写入。

#### FW-FILTER-001 文件筛选 `P1` · `PARTIAL`
- 目的/场景：在目录内快速只看图片/视频/大文件/最近修改等。
- 现有：是（部分）。`FolderTab.filter`（`useFilesWorkspaceStore.ts:59-87`）；
  `FilePane.tsx:1620-1635` 固定筛选 chips；过滤在 `FilePane.tsx:444-483`。
  支持 all/folder/image/video/audio/doc/sheet/slide/code/archive/large/recent 与隐藏开关。
  缺口：大小区间、修改日期区间、自定义名称/扩展名；无统一 filter 模型。
- 目标 UI：筛选条 + 高级筛选面板。
- 目标 API/函数：`setPaneFileFilter / clearPaneFileFilter / getPaneFileFilter`。
- 数据模型：`FileFilter { kinds, extensions, minSize, maxSize, modifiedAfter,
  modifiedBefore, name, includeHidden, includeFolders }`（目标，兼容现有枚举）。
- 依赖：FW-LAYOUT-001。
- 测试/验收：`useFilesWorkspaceStore.test.ts`、`FileList.layout.test.tsx`；
  缺口：组合筛选、过滤后选择一致性。
  验收：筛选不改变磁盘数据；布局切换保留筛选。

#### FW-FILTER-002 筛选预设 `P1` · `PLANNED`
- 目的/场景：保存「图片 > 5MB > 最近 30 天」等常用条件并一键应用。
- 现有：否。
- 目标 UI：筛选面板保存/管理预设。
- 目标 API/函数：`saveFileFilterPreset / updateFileFilterPreset / deleteFileFilterPreset /
  applyFileFilterPreset`。
- 数据模型：`FileFilterPreset { id, name, filter, sort?, createdAt }`。
- 依赖：FW-FILTER-001。
- 测试/验收：单元 CRUD/归一化；原生应用后列表与选择。

#### FW-INFO-001 文件详细信息 `P0` · `PARTIAL`
- 目的/场景：查看单文件/多选的文件名、路径、类型、大小、创建/修改/访问时间、属性。
- 现有：是（部分，本批扩展）。Rust `fs_stat` 新增 `accessed_ms` 与 Windows `attributes`
  代码；`FsStat`（`bridge.ts`）同步类型；`FilePane.tsx` 属性对话框新增访问时间与属性；
  多选时选择条新增「选中项」摘要（数量/总大小/文件与文件夹数/类型分布）。
  缺口：侧边常驻详细信息面板、扩展名独立字段、逐项属性读取的原生对照。
- 目标 UI：侧边详细信息面板 + 多选摘要。
- 目标 API/函数：`getFileMetadata(path) / getSelectionMetadata(paths)`（当前为组件内聚合）。
- 数据模型：`FileMetadata` / `SelectionMetadata`（目标；当前用 `FsStat` + 前端摘要）。
- 依赖：FW-SELECT-001。
- 测试/验收：Rust `stat_reports_kind_and_children` 与 `attribute_names_maps_bits_without_duplicates`
  （已编写；因共享工作树其他模块编译错误尚未执行）；前端摘要无独立组件测试。
  缺口：访问时间 Windows 延迟更新语义、原生属性值对比资源管理器。
- 2026-11-19 r9 修复：属性对话框对 `attributes`/`accessedMs` 缺失字段按空值兜底
  （`propsData.attributes ?? []`），一个缺失字段不再把整个对话框崩进 error boundary；
  `make-preview.mjs` 的 `fs_stat` 夹具补齐 `accessedMs/attributes`（r8 P3 走查崩溃根因）。
  新增 `FilePane.properties.test.tsx` 6 例：完整字段/文件夹/缺失访问时间/旧夹具缺字段/
  读取失败/快速切换。缺口不变：侧边常驻详情面板、原生与资源管理器对照。

#### FW-PREVIEW-001 文件预览 `P1` · `PARTIAL`
- 目的/场景：不打开外部应用即可看图片/视频/音频/文本/代码；预览失败不伪造成功。
- 现有：是（部分）。`QuickPreviewDialog.tsx:38-55` 支持 image/video/audio/text/code；
  `bridge.ts:5800-5821`（`fs_preview_image/fs_read_text/fs_preview_media_url/
  fs_release_preview_url`）；Rust `file_workspace/preview.rs`、`thumbnail.rs`；
  媒体 token 跟踪器（128 历史上限）。
  缺口：PDF、Office、Markdown 渲染（当前 md 按纯文本）；`canPreviewFile/getFilePreview`
  统一 API。
- 目标 UI：预览对话框（已有），扩展类型与关闭释放。
- 目标 API/函数：`canPreviewFile(path) / getFilePreview(path) / openFilePreview(path) /
  closeFilePreview()`。
- 数据模型：`FilePreview { kind, url|text, truncated, size }`。
- 依赖：FW-INFO-001。
- 测试/验收：`QuickPreviewDialog.test.tsx`、`QuickPreviewDialog.lifecycle.test.tsx`；
  缺口：PDF/Office 原生渲染、超大文件拒绝策略。
  验收：50 次切换 token 注册/释放各一次；二进制不误当文本。

### 3.5 系统集成与压缩

#### FW-SYS-001 系统集成命令 `P0` · `PARTIAL`
- 目的/场景：用默认应用打开、在资源管理器中定位、在终端打开、查看原生属性。
- 现有：是（本批补齐主要入口）。`fs_open/fs_reveal` 保持；新增
  `fs_open_with`（Shell `openas`）、`fs_show_properties`（Shell `properties`）、
  `fs_open_terminal`（优先 Windows Terminal，回退 cmd.exe，目录作为工作目录）；
  已注册到 `lib.rs` 并桥接 `fsOpenWith/fsShowProperties/fsOpenTerminal`；
  右键菜单新增「打开方式… / 在终端中打开 / Windows 属性…」。
  缺口：`openWithApp(path, appId)` 指定应用直开；原生真实弹窗验证。
- 目标 UI：右键「打开方式 / 在资源管理器中显示 / 在终端中打开 / 属性」。
- 目标 API/函数：`openWithDefaultApp / openWithApp / openInWindowsExplorer /
  openTerminalAtPath / showNativeFileProperties`。
- 数据模型：无业务数据；应用标识为运行时参数。
- 依赖：FW-SYS-002。
- 测试/验收：原生（真实默认应用/资源管理器/终端/属性页）**未执行**；
  不得用内部属性对话框冒充 Windows 属性页。
- 2026-11-19 r9 修复：FilePane 右键的打开/定位/打开方式/终端/Windows 属性五个入口不再
  `.catch(() => {})` 吞异常——统一走 `runFileSystemAction`：失败转可读 toast
  （`fw.error.systemAction`）并记一条诊断（`invokeCommand` 已归属的错误不重复记录）；
  不放宽 Rust 侧路径/保护目录校验。新增 `FilePane.systemActions.test.tsx` 5 例
  （成功/失败/去重记录）。原生弹窗仍待验收。

#### FW-SYS-002 右键与系统操作菜单 `P1` · `PARTIAL`
- 目的/场景：把打开、定位、复制路径/文件名/相对路径等常用动作集中到右键。
- 现有：是（部分）。`FilePane.tsx:1085-1243` 右键菜单：打开/定位/预览/复制到/移动到/
  复制路径/批量重命名/对比/复制/剪切/加入暂存架/重命名/删除/永久删除/属性。
  缺口：复制文件名、复制相对路径、打开方式、终端、Windows 原生属性。
- 目标 UI：右键菜单分组与危险项隔离。
- 目标 API/函数：菜单动作走 `FileWorkspaceService`；复制类走 `copyText`。
- 数据模型：无。
- 依赖：FW-SYS-001、FW-SELECT-001。
- 测试/验收：组件菜单项/禁用态测试；原生动作验证。

#### FW-ARCHIVE-001 压缩与解压 `P2` · `PLANNED`
- 目的/场景：右键压缩为 ZIP、预览压缩包、解压到目标目录；算法不进 UI 层。
- 现有：否。仓库内 `archive` 关键词均为备份/事件归档，与文件压缩无关。
- 目标 UI：右键压缩/解压、压缩包预览、冲突预演。
- 目标 API/函数：`createArchive(paths, options) / previewArchive(paths) /
  extractArchive(archivePath, targetPath) / canExtractArchive(path)`。
- 数据模型：`ArchiveOptions { format:"zip", level, password? }`（密码支持需单独评估）。
- 依赖：FW-OPS-001/003/004。
- 测试/验收：单元 zip-slip/大小上限/符号链接；原生大文件压缩/解压。
  新增 Rust 依赖（如 `zip` crate）必须先获得依赖引入授权。

### 3.6 工作区、项目与协作

#### FW-WORKSPACE-001 多目录工作区 `P0` · `PARTIAL`
- 目的/场景：把多个目录组织成一个命名工作区，而不只是当前打开的标签。
- 现有：是（部分）。多窗格/多标签/固定目录/最近目录/项目根绑定
  （`FilesWorkspacePanel.tsx:698-724,2168-2230`；`persist.ts:63-74` 上限）。
  缺口：显式 `WorkspaceFolder` 注册表（id/label/role/状态）、增删改 API。
- 目标 UI：工作区侧栏（目录列表、添加/移除、恢复现场）。
- 目标 API/函数：`addWorkspaceFolder / removeWorkspaceFolder / getWorkspaceFolders /
  updateWorkspaceFolder`。
- 数据模型：`WorkspaceFolderState { id, path, label, role, viewMode, sort, filter,
  scrollPosition, selectedItems }`。
- 依赖：FW-LAYOUT-001、FW-WORKSPACE-002。
- 测试/验收：Store/persist 单测；原生添加/移除/重启恢复。
  注意：不得与 `workbench_layout`/`workspace_instances` 混写。

#### FW-WORKSPACE-002 目录状态保持 `P0` · `PARTIAL`
- 目的/场景：换布局、切项目、重启后目录的视图/排序/筛选/滚动/选择不丢。
- 现有：是（部分）。`FolderTab` 含 path/history/viewMode/sortField/sortAsc/search/filter/
  showHidden（`useFilesWorkspaceStore.ts:73-88`），随 panes 持久化；布局转换保留标签
  （`layoutTransfer.ts`）；滚动位置在 `FileList.tsx:99-172` 的会话 LRU（**不落库**）；
  选择在 `selection`（会话态）。
  缺口：`scrollPosition/selectedItems` 的持久化策略（是否落库需产品确认）。
- 目标 UI：无需新增入口；行为保证。
- 目标 API/函数：`getWorkspaceFolderState / updateWorkspaceFolderState`（或沿用 Store）。
- 数据模型：同上 `WorkspaceFolderState`。
- 依赖：FW-LAYOUT-001、FW-WORKSPACE-001。
- 测试/验收：`useFilesWorkspaceStore.layout.test.ts`、`FileList.scroll.test.tsx`；
  缺口：跨重启滚动/选择恢复（若产品要求）。
  验收：布局变化不丢状态；关闭标签释放缓存。

#### FW-WORKSPACE-003 多目录联合搜索 `P1` · `PARTIAL`
- 目的/场景：在一个结果列表里看所有打开目录的命中，带窗格/目录/匹配原因。
- 现有：是（部分）。`searchSources` = 各窗格活动目录；结果含 `paneId/paneLabel/dirPath/path`；
  双击/定位会切到原窗格并选中文件。缺口：结果中「匹配原因」、从结果直接拖到目标目录、
  收藏目录范围。
- 目标 UI：联合搜索结果列表（分组/路径/原因/拖拽）。
- 目标 API/函数：`searchAcrossWorkspace(query)`（封装现有 `searchWorkspace`）。
- 数据模型：`SearchHit`（已有，补充 `matchReason`）。
- 依赖：FW-SEARCH-001、FW-WORKSPACE-001。
- 测试/验收：`workspaceSearch.test.ts`、`WorkspaceSearchDialog.test.tsx`；
  缺口：结果拖拽到窗格的原生验收。
  验收：同一文件不重复；定位到正确窗格。

#### FW-FAV-001 收藏夹 `P1` · `PARTIAL`
- 目的/场景：收藏常用文件夹/文件，支持排序、重命名、分组。
- 现有：是（部分）。仅固定目录 `pinnedDirs`（`useFilesWorkspaceStore.ts:172-174,267-268`；
  `FilePane.tsx:1301-1306,2168-2230`），无文件收藏、无重命名/拖拽排序/分组。
- 目标 UI：侧栏收藏区 + 管理菜单。
- 目标 API/函数：`getFavorites / isFavorite / addFavorite / removeFavorite /
  renameFavorite / reorderFavorites / createFavoriteGroup / deleteFavoriteGroup /
  moveFavoriteToGroup`。
- 数据模型：`FavoriteItem { id, path, kind, name, groupId, sortOrder }`、
  `FavoriteGroup { id, name, sortOrder }`；现有 `pinnedDirs` 迁移为 `kind=folder` 收藏，
  **不保留两套固定目录**。
- 依赖：FW-WORKSPACE-001。
- 测试/验收：单元 CRUD/排序/迁移；原生重启恢复。
  验收：删除收藏不动真实文件；路径失效有明确状态。

#### FW-FAV-002 最近访问 `P1` · `PARTIAL`
- 目的/场景：快速回到最近打开的目录/文件/项目目录。
- 现有：是（部分）。`recentDirs`（LRU≤8，`useFilesWorkspaceStore.ts:171-172,267`；
  `FilePane.tsx:1307-1315`；`FilesWorkspacePanel.tsx:2168-2184`）。
  缺口：最近文件、最近项目目录、按 kind 查询、单条删除/清空 API。
- 目标 UI：最近列表（目录/文件分组）。
- 目标 API/函数：`recordRecentPath / getRecentPaths / removeRecentPath / clearRecentPaths`。
- 数据模型：`RecentPath { path, kind:"dir"|"file"|"project", lastUsedAt }`，有界。
- 依赖：FW-WORKSPACE-001。
- 测试/验收：单元上限/LRU/去重；原生重启恢复。
  验收：历史不无限增长；失效路径可见。

#### FW-COLLECT-001 智能文件收集（暂存架） `P1` · `PARTIAL`
- 目的/场景：从多个目录挑选文件先放入暂存架，最后统一投递；不移动原文件。
- 现有：是（部分）。`FilePane.tsx:910-916` `shelfAddPaths(paths,"reference","manual",null)`；
  右键「加入暂存架」与选择条按钮；暂存架模块完整
  （`docs/shelf/README.md`、`src-tauri/src/shelf/`、`src/components/shelf/`）。
  缺口：文件工作区内的收集视图/批量选择计数、与暂存架的跨模块状态同步入口。
- 目标 UI：右键/按钮加入暂存架；暂存架侧栏（复用现有模块，不新建）。
- 目标 API/函数：`collectFile / collectFiles / removeCollectedFile /
  clearCollectedFiles / getCollectedFiles`（前端适配层，底层复用 `shelf_add_paths`）。
- 数据模型：复用 `shelf_items`/`shelf_groups`（v22），不新增第二套暂存表。
- 依赖：暂存架模块（其他会话所有权）、FW-SELECT-001。
- 测试/验收：`ShelfWorkspace.drop.test.tsx`、`ShelfFileOpPanel.test.tsx`；
  缺口：文件工作区→暂存架的组件测试。
  验收：引用模式不复制/不移动原文件；失效条目明确标注。

#### FW-COLLECT-002 多目录暂存 → 统一投递 `P1` · `PARTIAL`
- 目的/场景：A/B/C 目录各选一些 → 暂存架整理 → 选择 D → 预览 → 批量复制/移动。
- 现有：是（部分）。暂存架支持 `shelf_paste_current`、`shelf_move_items`、
  `shelf_copy_to`、`shelf_drop_to_directory`；文件工作区有接收侧
  `taskdock-fw-deliver`。缺口：统一 `FileTransferPlan`（构建/预演/执行/取消）与
  文件工作区 UI 的完整闭环。
- 目标 UI：暂存架「发送到…」+ 操作预演 + 队列。
- 目标 API/函数：`buildFileTransferPlan / previewFileTransferPlan /
  executeFileTransferPlan / cancelFileTransferPlan`。
- 数据模型：`FileTransferPlan { id, items, targetDir, effect, conflicts, previewId }`。
- 依赖：FW-COLLECT-001、FW-OPS-003/004。
- 测试/验收：暂存架现有测试 + 新增计划单测；原生多目录→目标目录落盘。
  验收：原文件语义正确（引用模式不移动）；冲突可预演。

#### FW-PROJECT-001 项目文件工作空间 `P1` · `PARTIAL`
- 目的/场景：项目绑定多个目录（代码/素材/构建/文档），打开项目恢复文件工作区现场。
- 现有：是（部分）。`workspace_projects.root_path` 单目录
  （`db/mod.rs:1603-1620`）；`FilesWorkspacePanel.tsx:698-724` 按项目切换
  `stateKey=project:<id>` 并打开根目录；README 提到五类项目容器。
  缺口：一个项目绑定多目录、目录角色、按角色查询。
- 目标 UI：项目文件区（目录角色分组）。
- 目标 API/函数：`bindProjectFolder / unbindProjectFolder / getProjectFolders /
  getProjectFolderByRole`。
- 数据模型：新表 `project_folders (project_id, folder_id, path, role, sort_order,
  created_at)`；不把多目录塞进 `root_path` JSON。
- 依赖：FW-WORKSPACE-001、项目模块（其他会话所有权）。
- 测试/验收：Rust 迁移/CRUD 单测；前端项目切换测试；原生打开项目恢复现场。
  验收：不移动/不删除外部文件；旧项目（仅 root_path）兼容。

#### FW-PROJECT-002 项目目录角色 `P2` · `PLANNED`
- 目的/场景：用 Source/Assets/Build/Docs 等角色标识目录，用户不必记完整路径。
- 现有：否（`project_folders` 尚未建立）。
- 目标 UI：角色徽标、按角色筛选/打开。
- 目标 API/函数：`setProjectFolderRole / listProjectFolderRoles`（或并入
  `bindProjectFolder(projectId,path,role)`）。
- 数据模型：`role: source|assets|documents|build|export|reference|cache|custom`。
- 依赖：FW-PROJECT-001。
- 测试/验收：角色枚举校验、重复角色策略、自定义角色显示。

#### FW-TAG-001 文件颜色与标签 `P1` · `PLANNED`
- 目的/场景：给文件打 TaskDock 自己的标签（重要/待处理/已完成/素材/临时/发布），
  不改 Windows 文件系统属性。
- 现有：否（暂存架标签 `shelf_item_tags` 仅属于暂存条目，不是文件路径标签）。
- 目标 UI：右键标签、标签色点、按标签筛选。
- 目标 API/函数：`getFileTags / setFileTags / addFileTag / removeFileTag`。
- 数据模型：`file_tags { path_key, tag, color, created_at, updated_at }`（路径键需
  大小写/规范化规则）。
- 依赖：FW-WORKSPACE-001。
- 测试/验收：单元 CRUD/路径键归一化；原生重启保持；明确不写 NTFS 属性/替代数据流。

#### FW-COLLECTION-001 文件收藏集 `P2` · `PLANNED`
- 目的/场景：文件可属于多个虚拟收藏集，不移动真实文件（游戏素材/论文素材/本周待处理）。
- 现有：否。
- 目标 UI：收藏集列表、加入/移出、集合内文件操作。
- 目标 API/函数：`createFileCollection / deleteFileCollection / addToFileCollection /
  removeFromFileCollection / getFileCollection / getFileCollections`。
- 数据模型：`file_collections` + `file_collection_items`（唯一键 collection_id+path_key）。
- 依赖：FW-TAG-001、FW-WORKSPACE-001。
- 测试/验收：多集合归属、删除集合不删文件、失效路径状态。

#### FW-RELATION-001 文件关系与项目引用 `P2` · `PLANNED`
- 目的/场景：展示可可靠解析的文件依赖（如 prefab → texture → animation）；
  不能靠 AI 猜测当事实。
- 现有：否。
- 目标 UI：关系面板/引用列表；仅对有解析器的类型显示。
- 目标 API/函数：`analyzeFileRelations(path) / getFileDependents(path) /
  getFileDependencies(path)`。
- 数据模型：`file_relations { from_path, to_path, kind, parser, confidence, updated_at }`。
- 依赖：FW-INFO-001、项目目录角色。
- 测试/验收：解析器白名单、解析失败明确「未知」；性能上限（不递归扫描超大项目）。

### 3.7 智能、自动化、历史与设备

#### FW-AUTO-001 文件自动化 `P2` · `PLANNED`
- 目的/场景：Downloads 出现图片 → 自动归类到 Images/YYYY/MM；导出 zip → 移到 Release。
- 现有：否。
- 目标 UI：规则列表、启停、预演、日志、撤销入口。
- 目标 API/函数：`createFileAutomation / updateFileAutomation / deleteFileAutomation /
  enableFileAutomation / disableFileAutomation / previewFileAutomation /
  executeFileAutomation / getFileAutomationLogs`。
- 数据模型：`file_automations { id, name, enabled, trigger, conditions, actions,
  last_run_at }` + `file_automation_logs`。
- 依赖：FW-OPS-001/003/004、FW-UNDO-001、FW-HISTORY-001。
- 测试/验收：规则匹配/循环触发防护/高风险确认/暂停/日志；不得做简陋规则充数。
  验收：所有自动化可预演、可暂停、有日志；危险操作必须确认。

#### FW-SMART-001 大文件分析 `P2` · `PLANNED`
- 目的/场景：扫描范围内的大文件，辅助清理磁盘。
- 现有：否（资源管理模块有磁盘/应用占用，但不是文件工作区的大文件列表）。
- 目标 UI：扫描范围/阈值/结果列表/取消。
- 目标 API/函数：`scanLargeFiles(scope, options) / getLargeFileResults(scanId) /
  cancelLargeFileScan(scanId)`。
- 数据模型：`LargeFileScan { id, scope, threshold, status, results, cancelled }`。
- 依赖：FW-SEARCH-003。
- 测试/验收：大目录预算、取消、结果不完整标注；不得阻塞 UI。

#### FW-SMART-002 重复文件 `P2` · `TESTING`
- 目的/场景：按大小预筛 + SHA-256 确认重复文件，安全删除（保留每组至少一项）。
- 现有：是。`workspaceSearch.ts:226-260`（sizeGroups/hashDuplicateGroups）；
  `DuplicateFinderDialog.tsx`；`fsHashFiles`、`fsDeleteVerifiedDuplicates`
  （`bridge.ts:5794-5844`）；后端重新哈希后才进回收站。
- 目标 UI：重复查找对话框（已有）。
- 目标 API/函数：`findDuplicateFiles`（唯一实现，复用现有；不新建第二套）。
- 数据模型：`DuplicateGroup { size, files, hash }`。
- 依赖：FW-SEARCH-001/003。
- 测试/验收：`workspaceSearch.test.ts`、`DuplicateFinderDialog.test.tsx`；
  本轮未执行。验收：不完整扫描禁止删除；哈希确认；每组至少保留一项。

#### FW-SMART-003 相似图片 `P2` · `PLANNED`
- 目的/场景：按感知哈希分组相似图片；性能可控，不阻塞 UI。
- 现有：否。
- 目标 UI：相似图片分组、预览、选择删除/移动。
- 目标 API/函数：`findSimilarImages(scope) / groupSimilarImages(results)`。
- 数据模型：`SimilarImageGroup { hash, files, distance }`。
- 依赖：FW-SMART-002、FW-PREVIEW-001。
- 测试/验收：感知哈希误差/性能上限/取消；不得对几十万文件做全量解码。

#### FW-HISTORY-001 文件变更时间线 `P1` · `PLANNED`
- 目的/场景：展示 TaskDock 自己观测到的文件操作（移入/重命名/修改/发送到手机）。
- 现有：否（`layoutHistory` 只是布局；诊断中心有操作日志但不是用户文件时间线）。
- 目标 UI：侧栏活动历史/单文件时间线。
- 目标 API/函数：`getFileActivityTimeline(scope) / getFileActivity(path)`。
- 数据模型：`file_activity_events { id, path_key, kind, source:"taskdock",
  operation_id, at }`；**外部修改只能标注「未知/可能由外部程序」**。
- 依赖：FW-OPS-001、FW-DEVICE-001。
- 测试/验收：事件写入/有界清理/路径脱敏；明确区分「TaskDock 观察到」与「外部修改」。
  不得假装知道所有外部变化。

#### FW-DEVICE-001 跨设备文件传输 `P1` · `PARTIAL`
- 目的/场景：文件工作区选中文件 → 发送到已配对手机；手机文件也能回到电脑。
- 现有：是（部分）。`mobile_sync/files.rs:360` `create_offers`；
  `commands/mobile_sync.rs:62-134`（`mobile_file_list/offer/delete/reveal/import_shelf`）；
  `bridge.ts:4831-4850`；UI 仅在设置页 `MobileSyncSection.tsx`。
  缺口：文件工作区入口、配对设备选择、传输进度/暂停/继续/取消/重试 API。
- 目标 UI：右键「发送到手机」、传输队列、设置页复用。
- 目标 API/函数：`getPairedDevices / sendFilesToDevice / getFileTransferStatus /
  pauseDeviceTransfer / resumeDeviceTransfer / cancelDeviceTransfer /
  retryDeviceTransfer`。
- 数据模型：复用 `mobile_files`（v45）+ 新增传输任务视图；不新建第二套协议。
- 依赖：mobile_sync 模块（其他会话所有权）、FW-OPS-001。
- 测试/验收：现有 Rust `mobile_sync/files.rs` 单测；缺口：桌面→手机真实传输、断线重连、
  大文件进度。验收：TLS-only + SPKI 固定不变；失败可重试。

#### FW-RECYCLE-001 回收站索引视图 `P1` · `TESTING`
- 目的/场景：在文件工作区内查看/搜索/筛选/还原/清空回收站，不直接操作 `$Recycle.Bin`。
- 现有：是。`RecycleWorkspaceView.tsx`；`recycle_*` 命令
  （`commands/recycle.rs:27-58,185-220`）；`recycle/index.rs:20-70` 表
  `recycle_index/recycle_volume_state/recycle_restored_metadata`；`fsops` 任务。
- 目标 UI：文件工作区数据源切换（文件/回收站）。
- 目标 API/函数：`recycle_stats/list/sync/sync_status/sync_cancel/restore/purge/empty`。
- 数据模型：上述三表 + `mobile_files` 无关；备份策略需登记。
- 依赖：FW-OPS-001。
- 测试/验收：`RecycleWorkspaceView.test.tsx`、Rust recycle 单测；本轮未执行。
  验收：4 万条分页/搜索/还原；清空语义区分 `volumes=null` 与 `[]`。

#### FW-COMPARE-001 文件夹对比 `P2` · `TESTING`
- 目的/场景：对比两个已打开目录，找出仅左/仅右/不同项，支持复制差异。
- 现有：是。`folderCompare.ts`（双侧分页、`maxFiles` 预算、完整性四态）；
  `FolderCompareDialog.tsx`；`FilePane.tsx:1138-1144` 右键对比。
- 目标 UI：对比对话框（已有）。
- 目标 API/函数：`compareFolders / compareEntries`（已有）。
- 数据模型：`CompareItem / CompareFoldersResult`。
- 依赖：FW-SEARCH-003、FW-OPS-004。
- 测试/验收：`folderCompare.test.ts`、`FolderCompareDialog.test.tsx`；本轮未执行。
  验收：不完整对比禁用差异同步；预算生效；不把未读到当不存在。

---

## 4. 现有实现与重复实现检查

| 能力 | 唯一实现 | 明确禁止的第二实现 |
|---|---|---|
| 复制/移动/删除/重命名 | Rust `src-tauri/src/file_workspace/` + `fsops/` | UI 直接调用 Win32；新模块另写复制引擎 |
| 回收站浏览/恢复/清空 | `src-tauri/src/recycle/` + `RecycleWorkspaceView` | 直接操作 `$Recycle.Bin`；第二套回收站索引 |
| 重复文件 | `workspaceSearch.ts` + `DuplicateFinderDialog` + `fsDeleteVerifiedDuplicates` | 新增第二套 `findDuplicateFiles` |
| 目录搜索 | `workspaceSearch.ts` | 与 `global_search`（数据库内容搜索）合并或互替 |
| 选择/框选 | Store `selection` + `marqueeSelection.ts` | 组件内第二套 selection state |
| 文件剪贴板 | `interactions.ts` 的 `fwClipboard` | 复用系统文本剪贴板；第二套文件剪贴板 |
| 预览 | `QuickPreviewDialog` + `file_workspace::preview` | 为文件工作区另建预览器 |
| 暂存架 | `shelf` 模块 | 在文件工作区另建暂存库 |
| 项目根 | `workspace_projects.root_path` | 用 JSON 塞多目录；第二套项目表 |
| 设备传输 | `mobile_sync` + `mobile_files` | 新协议/新数据库 |
| 布局持久化 | 设置键 `file_workspace_layouts` | 写入 `workbench_layout`/`workspace_instances` |

**结论**：本轮不新增与上述唯一实现平行的第二套实现；扩展一律在既有模块内追加能力或加
薄 facade。

---

## 5. 开发前最终方案评审（§41 汇总）

```
Feature Registry 总数：47

P0：21
P1：17
P2：9

已存在：35（TESTING 11 + PARTIAL 24）
待开发：12（PLANNED）
需要重构：0（本轮不推翻既有架构）
需要复用：复制/移动/删除、回收站、重复文件、暂存架、设备传输、目录搜索、预览、
          布局持久化（均已在唯一实现中）
需要废弃：无（pinnedDirs 将以迁移方式并入收藏，不是并行保留）
```

核心数据结构：`SplitNode/PaneState/FolderTab`、`PaneSelection`、`FileClipboardPayload`、
`JobSnapshot`、`FileOperationPreview`、`FileOperationHistory`、`WorkspaceFolderState`、
`FavoriteItem/FavoriteGroup`、`FileSearchQuery/SearchSession`、`FileFilter/FilterPreset`、
`FileTag`、`FileCollection`、`ProjectFolder`、`FileAutomation/Log`、`FileActivityEvent`、
`DeviceFileTransfer`。

核心 Service：`FileWorkspaceService`（组合式 facade，不替代既有模块）。

核心 Store：`useFilesWorkspaceStore`（唯一文件工作区 Store；不新建第二个）。

核心 UI：`FilesWorkspacePanel`、`FilePane`、`FileList`、`OperationQueueBar`、
`BatchRenameDialog`、`QuickPreviewDialog`、`DuplicateFinderDialog`、`FolderCompareDialog`、
`WorkspaceSearchDialog`、`FileDetailsPanel`（待建）、`FileOperationPreviewDialog`（待建）。

核心测试：`src/lib/filesWorkspace/*.test.ts`、`src/components/files/*.test.tsx`、
`src/store/useFilesWorkspaceStore*.test.ts`、`src-tauri/src/file_workspace`/`fsops`/
`recycle` Rust 单测。

### 5.1 重复功能检查结论

- 重复文件：只有一套（见上表），本轮复用，不新建。
- 搜索：`global_search` 是数据库内容搜索，`workspaceSearch` 是文件系统搜索；两者
  数据源与交互不同，**不合并**，但在 UI 上要避免同一入口重复出现。
- 暂存：文件工作区只做「加入暂存架」与投递接收，**不新建暂存架**。
- 设备传输：只复用 `mobile_sync`，**不新建传输协议**。
- 固定目录与收藏：计划迁移为一个收藏模型，避免 `pinnedDirs` 与 `favorites` 双轨。

---

## 6. 本轮范围与下一步

- 本轮只完成：代码审查、现有功能盘点、Feature Registry、产品/技术方案、函数级清单、
  测试/验收矩阵。
- 未执行：任何业务代码修改、Vitest、Rust 测试、原生构建/验收。
- 下一步（需用户确认后）：
  1. 按 P0 顺序开发：FW-NAV-001/002 → FW-FILE-004 → FW-OPS-003/004 → FW-INFO-001 →
     FW-SYS-001 → FW-WORKSPACE-001/002（以及既有 P0 的回归）。
  2. 每完成一个 Feature：代码 → 测试 → 本表状态 → 验收记录 → 交付提交。

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-18 | 建立 Phase 1 基线：47 个 Feature、现状映射、重复实现检查、方案汇总；未执行测试 |
| 2026-11-18 | P0 批次 1（r8）：FW-NAV-001/002、FW-FILE-004、FW-INFO-001、FW-SYS-001、FW-OPS-003、FW-SEARCH-001/002 实现；FW-FILE-004 因剪切态视觉/清理入口缺失下调 PARTIAL |
| 2026-11-19 | R9 缺陷修复：FW-FILE-004 剪切态可见化（订阅/视觉/清理入口，回升 TESTING）；FW-INFO-001 属性空值兜底 + 夹具修复；FW-SYS-001 统一错误出口；FW-OPS-003 预演完整性 + 确认门禁 + 二次验证。新增测试 2 文件，前端 38 文件 / 370 用例、Rust file_workspace 66/66 通过；原生与正式构建待执行 |
| 2026-11-19 | R10 方案登记（未改代码）：FW-LAYOUT-001 扩展标签会话模型（openedPath/path 分离、tabTitle 取起始目录、duplicateTab 完整复制、空窗格关闭/批量清理、持久化兼容、三层职责边界）；三层数据模型与 UI 修复写入架构/测试/验收文档；本轮尚无实现或测试证据，不产生 PASS |

## 8. R10 产品规则（2026-11-19，权威口径）

> 以下规则由本轮任务给定，作为 `FW-LAYOUT-001` 扩展的权威产品口径；实现与文档冲突时，
> 以本节规则为准，代码为准绳，测试/原生证据齐全后才更新状态。

1. **标签显示起始目录名，面包屑显示实时路径**：`tabTitle = basename(openedPath)`，
   两级（如 `正文/第一卷/第一章`）任意深入，标签恒显示「正文」，面包屑显示
   `D: / Projects / Novel / 正文 / 第一卷 / 第一章`。Tooltip 显示「名称 + 完整 openedPath」。
2. **标签 = 独立可恢复的目录浏览会话**：会话状态含 `openedPath / path / history /
   historyIndex / viewMode / sortField / sortAsc / search / filter / showHidden`（及后续新增的
   可持久化浏览状态）；不含选中文件、拖拽、临时焦点、未提交重命名、执行中的 IPC Promise。
3. **窗格 = 会话容器**：`PaneState { tabs, activeTabId }`，只负责承载/组织标签，不承载会话内容语义。
4. **布局 = 窗格组织结构**：`SplitNode` 分割树（方向/比例/窗格 ID），只负责窗格的横向/纵向组织。
5. **分割复制完整会话**：`splitPane()` 仅复制当前激活标签，经 `duplicateTab()` 深拷贝得到**新 tabId**；
   源窗格标签不动；新旧标签 path 相同但导航/选择完全独立。
6. **移动 ≠ 复制**：`extractTabToPane()` 移动原标签、保留原 `tabId`、源窗格移除；
   `duplicateTab()` 复制会话、生成新 `tabId`、原标签保留。二者不合并。
7. **空窗格可关闭，最后一个受保护**：`pane.tabs.length === 0` 为空窗格，提供关闭入口；
   `closeEmptyPane/closeAllEmptyPanes` 在 Store 层校验「至少保留一个窗格」；空窗格右键保留
   「打开文件夹/输入路径/关闭空窗格」。
8. **三种空态严格区分**：A 空窗格（无标签）→ 关窗格；B 空白标签（有标签无有效目录）→ 关标签；
   C 正常窗格 → 保留既有标签逻辑。禁止混淆。
9. **目录改名/移动同步**：TaskDock 内部重命名/移动目录时用统一 `remapTabPaths()` 精确映射
   所有受影响标签的 `openedPath/path/history`（分量边界，大小写不敏感，不误匹配相似前缀）；
   外部程序改动复用现有失效处理，定位不到新路径则显式标注失效，不猜层级。
