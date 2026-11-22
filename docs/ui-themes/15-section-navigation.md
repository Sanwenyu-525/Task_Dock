# 15 · 全局页面级导航规范（SectionTabs / SectionNavigation）

> 状态：Accepted（2026-11-22 统一导航改造引入；迁移与审计结果见 §9、§10）。
> 事实源：`src/components/ui/SectionTabs.tsx`、`src/components/ui/SectionNavigation.tsx`、
> `src/components/ui/section-navigation.css`；轨道底 Token `--surface-sunken` 定义于
> `src/styles-tokens.css` 语义层（浅/深两块，两套预设共用）。

## 1. 设计目标

页面级（以及页面内内容面板级）的切换入口此前由三个页面各自实现（`planning-source-switch`、
`ws-tabs`、`cap-tabs`），视觉、语义、键盘行为各不相同。本规范收敛为：

1. **统一视觉**：浅色沉降导航轨道 + 白色（`--surface-raised`）抬升选中项 + `--accent` 文字。
2. **统一语义**：内容面板切换用 Tab 语义（`SectionTabs`）；模块/页面导航用导航语义
   （`SectionNavigation`）。二者共享同一套轨道视觉与状态体系。
3. **统一键盘**：不再各页面自写一套焦点管理；键盘契约内置于组件。
4. **Token 驱动**：颜色、圆角、阴影全部走语义 Token，禁止业务页面硬编码导航配色。

## 2. 两种语义，两个组件（不可互换）

| | `SectionTabs` | `SectionNavigation` |
|---|---|---|
| 语义 | 同一页面内**内容面板**互斥切换 | **模块 / 页面**之间的导航 |
| 结构 | `role="tablist"` / `role="tab"` / `aria-selected` / `aria-controls`，面板用 `role="tabpanel"` + `aria-labelledby` | `<nav>` + `aria-label`，选中项 `aria-current="page"` |
| 键盘 | roving tabindex（焦点 = 选中）；←/→、Home/End 移动焦点并自动激活 | Tab 逐项停靠；←/→/↑/↓、Home/End **只移焦点**，Enter/Space 原生激活 |
| 适用 | 能力中心五页签、项目中枢数据来源、项目中枢内部视图、Agent 接入页签 | 工作空间一级模块、二级子模块、后续其他页面模块导航 |
| 不适用 | 筛选器、排序器、视图模式（保留 `.seg-group` 分段控件）、工具栏操作按钮 | 同左 |

判断口诀：**切的是「内容面板」→ Tabs；切的是「去哪里」→ Navigation；切的是「数据怎么过滤/显示」→ 分段控件或按钮，不用本规范。**

禁止把两者做成一个由 Boolean 参数切换语义的万能组件；禁止用 CSS 让两类控件长得完全一样
（Navigation 一级可用同款轨道，二级用 `size="sm"` 轻量层级）。

## 3. 视觉规范

### 3.1 Token

| 用途 | Token |
|---|---|
| 轨道底（沉降面） | `--surface-sunken`（浅 `#eef2f7` / 深 `var(--color-bg-surface-secondary)`，定义于 styles-tokens.css 语义层，两套预设共用） |
| 轨道边框 | `--border-subtle` |
| 轨道圆角 | `--radius-control`（8px）；项圆角 `calc(var(--radius-control) - 2px)` |
| 选中底 | `--surface-raised`（白 / 深色抬升面） |
| 选中文字 | `--accent`；字重 medium（600） |
| 未选中文字 | `--text-secondary` |
| Hover | `--surface-hover` + `--text-primary` |
| 焦点 | `:focus-visible` → `box-shadow: var(--focus-ring)` |
| 禁用 | `--text-disabled`，无底色、`cursor: not-allowed` |

`--surface-sunken` 修复说明：此前 collab.css、capability.css 等处使用该变量但从未定义
（裸引用处计算值失效）。新增后这些存量引用一并获得正确沉降面；禁止依赖
`var(--surface-sunken, var(--surface-raised))` 回退造成「白底叠白底」。

### 3.2 尺寸（默认 `size="md"`；`size="sm"` 用于二级导航）

| 属性 | md | sm |
|---|---|---|
| 轨道内边距 | 3px | 2px |
| 项最小高度 | `--btn-height-sm`（28px） | 26px |
| 轨道总高 | ≈34px | ≈30px |
| 字号 | `--font-size-secondary`（13px） | 12px |
| 图标 / 间距 | 14px / 6px | 13px / 5px |
| 项水平内边距 | 11px | 10px |
| 项间距 | 2px | 2px |

### 3.3 状态体系（不得仅靠颜色区分）

Default（透明底 + secondary 文字）→ Hover（`--surface-hover` + primary 文字）→
Active（raised 底 + accent 文字 + 1px 内描边 + 轻投影 + 加粗）→
Focus（focus-ring，仅键盘）→ Disabled（灰字、无底、不可聚焦激活）。
Loading 属于页面职责（如工作空间 `ws-tab-loading` 指示条），不在导航项内做 spin。

## 4. 组件 API

```tsx
// SectionTabs：内容面板切换
interface SectionTabItem { id: string; label: string; icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; disabled?: boolean; }
interface SectionTabsProps {
  items: readonly SectionTabItem[];
  activeId: string;
  onChange: (id: string) => void;   // 自动激活：方向键移动即触发
  "aria-label": string;
  idPrefix: string;                  // 生成 `${idPrefix}-tab-${id}` / `${idPrefix}-panel-${id}`
  size?: "md" | "sm";
  className?: string;
}
// 面板由调用方提供：id={`${idPrefix}-panel-${id}`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${id}`}

// SectionNavigation：模块导航
interface SectionNavItem { id: string; label: string; icon?: …同上; disabled?: boolean; }
interface SectionNavigationProps {
  items: readonly SectionNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
  "aria-label": string;
  size?: "md" | "sm";
  className?: string;
}
```

实现约束：

- 两组件共享 `section-navigation.css` 与 `sectionNavKeyboard.ts` 的索引推进函数；键盘行为各自内置。
- 轨道 `width: fit-content; max-width: 100%`；**不做全宽拉伸**，右侧操作区（如工作空间「布局」
  按钮）由页面容器（flex + spacer）并排放置，不进入导航组件。
- `items` 来自页面既有数据结构（如工作空间 `navGroups`/`modules`），组件不做任何业务排序/过滤。
- 切换 `activeId` 后组件将选中项 `scrollIntoView({ block: "nearest", inline: "nearest" })`，
  保证横向溢出时选中项可见。

## 5. 响应式

- 窄容器：轨道保持单行，`overflow-x: auto` 滚动消化溢出；`scrollbar-width: none` +
  `::-webkit-scrollbar { display: none }` 隐藏滚动条但保留滚动。
- 导航项 `flex-shrink: 0; white-space: nowrap`：不压缩文字、不换行成两行高。
- 工作空间一级导航行（`ws-tabs` 容器）：左侧导航滚动区 + 加载指示 + spacer + 独立「布局」按钮；
  布局按钮不得进入滚动区。
- 长模块名 / 极窄窗：允许轨道横向滚动，禁止截断后无法辨认。

## 6. 主题适配

- 浅色：轨道 `#eef2f7` 明显区别于卡片白面；选中项白底 + accent 文字。
- 深色：轨道 `#111c2e` 低于抬升面 `#162032`（深色「下沉 = 更暗、抬升 = 更亮」）。
- 两套预设（默认/材质类）共用语义层，Token 定义一次覆盖全部预设；不得在业务 CSS 覆盖
  `--surface-sunken`。
- 圆角预设通过 `--radius-control` 全局换算，组件内不写死像素圆角。

## 7. 治理规则（强制）

**今后新增页面必须优先使用 `SectionTabs` / `SectionNavigation`；无登记理由不得自行定义
页面级 Tab 样式。** 例外（分段控件、筛选器、工具栏按钮）按 §2 口诀判定并在
`docs/ui-themes/15-section-navigation.md` §9 登记审计结论。新增导航用例先读本规范与组件
测试（`SectionTabs.test.tsx` / `SectionNavigation.test.tsx`）确认键盘与 ARIA 契约。

## 8. 迁移记录（2026-11-22）

| 页面 | 迁移前 | 迁移后 |
|---|---|---|
| 能力中心 `CapabilityCenterPanel` | `.cap-tabs`/`.cap-tab`（白叠白） | `SectionTabs`（idPrefix `cap`） |
| Agent 接入 `AgentAccessSection`（复用同一 CSS 块） | `.cap-tabs`/`.cap-tab` | `SectionTabs`（idPrefix `agent-access`） |
| 项目中枢数据来源 `PlanningCenterPanel` | `seg-group.subtle` + `aria-pressed`（无面板关联） | `SectionTabs`（idPrefix `planning-source`，保留「数据来源」标签） |
| 项目中枢内部视图 `ProjectHubPanel` `.ph-tabs` | `role="tablist"` 但 panel 无关联 | `SectionTabs`（idPrefix `ph`，六个 `ph-view` 补 tabpanel 关联） |
| 工作空间一级 `ProjectWorkspacePanel` | `.ws-tab` 独立按钮样式 | `SectionNavigation`（保留 `navGroups`/`switchGroup`/布局按钮/加载指示） |
| 工作空间二级 `.ws-subtabs` | 自绘轨道 | `SectionNavigation size="sm"` |

## 9. 全局审计结论（2026-11-22）

审计范围：agents / clipboard / diagnostics / files / resource / tasks / vault / apps / collection /
history / collab / workbench。判定依据 §2 口诀；下表只列命中页面级或内容面板结构的条目，
纯筛选器 / 排序器 / 编辑器内部 Tab / 列表选中态不在此列（保持现状，不算碎片）。

### 9.1 已迁移（本次）

| 文件 | 迁移后 | 说明 |
|---|---|---|
| `capability/CapabilityCenterPanel.tsx` | SectionTabs | 五页签内容面板，ID 前缀 `cap` |
| `capability/AgentAccessSection.tsx` | SectionTabs | 复用同一 CSS 块，顺带收编，ID 前缀 `agent-access` |
| `roadmap/PlanningCenterPanel.tsx` | SectionTabs | 数据来源四面板（原 aria-pressed 分段），ID 前缀 `planning-source` |
| `roadmap/ProjectHubPanel.tsx` | SectionTabs | 六视图（原 ph-tabs），六个 ph-view 补 tabpanel 关联，ID 前缀 `ph` |
| `workbench/ProjectWorkspacePanel.tsx` | SectionNavigation | 一级模块 + 二级子模块（`size="sm"`），行为与既有 nav 测试完全兼容 |

### 9.2 待迁移（已登记，按优先级，后续任务各自带验收执行）

| 优先级 | 文件 | 现状 | 建议 |
|---|---|---|---|
| P1 | `agents/AgentPanel.tsx` 1037-1068 | `agents-rail-nav`，tablist+aria-selected 切 monitor/stats/onboard/access | 迁移 SectionTabs |
| P1 | `diagnostics/DiagnosticsCenterPanel.tsx` 1095-1125 | `diag-tabs`（seg-group）切 runtime/security/performance | 迁移 SectionTabs（与能力中心同型） |
| P1 | `collection/CollectionPanel.tsx` 42-70 | seg-group 切 inbox/shelf/notes 子页 | 迁移 SectionTabs |
| P2 | `collab/CollabPanel.tsx` 468-487 | seg-group subtle 切需求/Bug/方案/可视化（aria-pressed 语义不符） | 迁移 SectionTabs 并修正语义 |
| P2 | `clipboard/ClipboardWorkspace.tsx` 1608-1631 | `clip-side-sections` 侧栏切历史/分组 | 迁移 SectionTabs |
| P2 | `resource/ResourceManagementPanel.tsx` 288-313 | 垂直栏 + 完整 roving 键盘 | 迁移 SectionTabs 前需评估垂直布局支持（当前组件为横向轨道） |
| P3 | `files/FilesWorkspacePanel.tsx` 2032-2050 | `fw-source-switch` 文件/回收站整页切换 | 可迁移；也可按「源切换」保留 |

### 9.3 必须保持现状（含理由）

- `workbench/WorkbenchShell.tsx` `wb-nav`：nav + aria-current 已符合导航语义，但含拖拽排序、
  固定入口、计数与操作区，结构特殊，不收编通用组件。
- `PlanningWorkspace` 视图条（`planning-view-bar`）：内容级工具栏，刻意与一级目录切换区分层级。
- `ProjectHubPanel` 内 `summary/edit`、`intent/template/manual` 模式切换：分段控件语义。
- 全部 `seg-group` 筛选/排序/分段（AgentStatsView、TasksPanel、TaskItem 编辑器、TaskAnalyticsPanel、
  HistoryPanel、AppsPanel、PerformanceSection、ProcessDiagnostics、CollectionRail 等）：筛选器语义。
- 编辑器/对话框内部 Tab：FilePane `fw-pane-tabbar`、ClipboardItemDetail `clip-view-tabs`、
  PrototypePageManager、VisualViewer、VaultPanel（解锁模式 + Dialog 页签）。
- 列表选中态（FileList、RecycleWorkspaceView、comic/novel 行、NovelManuscriptPanel 章节、
  TaskItem aria-current）：非导航语义。

迁移任一待迁移项时：先跑该面板既有测试，迁移后按 §7 治理规则登记到 §9.1。

