# 文件工作区列表列：表头对齐与列宽拖拽

日期：2026-11-22
范围：`src/components/files/FileList.tsx`、`files.css`、
`src/lib/filesWorkspace/columnWidths.ts`、`persist.ts`、`src/store/useFilesWorkspaceStore.ts`

## 1. 对齐契约（更正 R13 结论）

R13（`FileList.headerAlign.test.tsx`）曾约定「表头全部左对齐、数据行时间/大小右对齐」。
2026-11-22 经用户确认改为**全部左对齐**（Windows 11 风格）：数据行时间/大小列不再
`justify-self: end` + `text-align: right`，与表头同起点。列轨道仍由
`.fw-row, .fw-list-head` 共用同一套 `--fw-col-*`（单一事实源不变）。

## 2. 表头列宽拖拽（Windows 资源管理器习惯）

- 手柄 `.fw-col-handle` 渲染在**修改日期/大小/类型**三列的**左缘**（表头内，骑进 8px 列距），
  分隔线静止可见（`--border-subtle`），悬停/拖拽/聚焦变强调色。
- 名称列是前置 `minmax(0, 1fr)` 弹性列：固定列的**右缘被后续轨道钉死**，只有左缘能跟随
  光标。因此拖动手柄调整「手柄右侧那一列」宽度：**向右拖=该列变窄（名称变宽），向左拖=该列变宽**。
  键盘 ←/→ 跟随同一视觉方向；双击手柄恢复默认列宽。
- 钳制：列自身上下限（`MIN/MAX_COL_WIDTHS`）+ 名称列保底 96px（`maxForName` 按容器宽换算）。
  窄栏断点（560/440px）隐藏列时同步隐藏对应手柄；360px 的时间列缩窄仍由 CSS 兜底。
- 表头列与手柄**列与行双双显式定位**（`grid-column: N; grid-row: 1`）：只定列不定行时，
  auto 布局会跳过被手柄占据的单元格，把时间/大小/类型表头挤到隐式第 2 行（真机回归案例）。

## 3. 持久化

列宽存入文件工作区既有设置键 `file_workspace_layouts` 的 `PersistedState.colWidths`
（仅记录用户改过的列，`normalizeColWidths` 丢弃非法/越界值）。旧数据缺失该字段回默认，
版本仍为 1，向后兼容；空列宽不写键（快照与归一形态一致，往返稳定）。全分栏共享一份列宽。
