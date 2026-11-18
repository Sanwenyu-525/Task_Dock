# 文件工作区测试矩阵

- 日期：2026-11-18
- 阶段：Phase 1 开发前基线（**本轮未执行测试**）
- 功能台账：[docs/features/files-workspace.md](../features/files-workspace.md)
- 验收矩阵：[docs/acceptance/files-workspace.md](../acceptance/files-workspace.md)
- 通用测试规范：[docs/TESTING.md](../TESTING.md)、[docs/ACCEPTANCE_ROUTING.md](../ACCEPTANCE_ROUTING.md)

> 本文件只定义「要测什么、怎么测、证据在哪」；测试结果写入
> `tmp/acceptance/files-workspace/<round>/` 并在验收矩阵中更新状态。不得在本文伪造结果。

---

## 1. 原则

1. **先局部后全量**：能单文件 Vitest / 单 crate `cargo check` 就不跑全量；全量构建必须走
   `npm run test` / `npm run build`（构建调度器）。
2. **命令可复现**：每条结果必须带工作目录、命令、退出码、时间、日志路径。
3. **不伪造**：未执行写「未执行」；环境阻塞写 `ENVIRONMENT BLOCKED`；证据不足写「证据不足」。
4. **单测不能替代原生**：真实文件系统写入、回收站、拖拽、系统剪贴板、DPI/多显示器必须原生验收。
5. **不新增依赖**：测试优先使用现有 Vitest / jsdom / Rust 单测能力；需要新依赖先申请。

---

## 2. 现有测试资产（盘点）

### 2.1 前端领域层（`src/lib/filesWorkspace/`）

| 文件 | 覆盖主题 |
|---|---|
| `model.test.ts` | 分割树、容量/深度、交换、预设、归一化 |
| `layoutTransfer.test.ts` | 布局增减时的标签分配、收纳、容量阻止 |
| `persist.test.ts` | 状态归一化、上限、损坏回退、RMW |
| `dirCache.test.ts` | 目录缓存、分页 `nextOffset`、停滞保护、失效 |
| `pathUtils.test.ts` | 路径规范化、父级、面包屑、子路径判断 |
| `interactions.test.ts` | 拖拽效果、落点、文件剪贴板、取消 |
| `transfer.test.ts` | 冲突探测、目标选择、移动后源清理 |
| `volumeCache.test.ts` | 卷键缓存与跨卷决策 |
| `operationQueue.test.ts` | 前端单并发槽、条目状态 |
| `fileJobs.test.ts` | 后端任务订阅、终态、报告聚合 |
| `opReport.test.ts` | 失败分类与原因映射 |
| `batchRename.test.ts` | 前缀/后缀/替换/序列/大小写、非法名、冲突 |
| `folderCompare.test.ts` | 双侧分页、`maxFiles` 预算、完整性 |
| `folderPicker.test.ts` | 选择器结果、路径校验 |
| `workspaceSearch.test.ts` | 递归搜索、上限、完整性、重复候选/哈希 |
| `marqueeSelection.test.ts` | 矩形几何、命中、合并、自动滚动、键盘索引 |
| `operationPreview.test.ts` | 预演阈值、参数透传（本批新增） |

### 2.2 前端组件/Store

| 文件 | 覆盖主题 |
|---|---|
| `src/store/useFilesWorkspaceStore.test.ts` | 打开/导航/选择/关闭/标签 |
| `src/store/useFilesWorkspaceStore.layout.test.ts` | 布局转换、撤销/重做、收纳、持久化 |
| `FilePane.selection.test.tsx` | 焦点/选中、键盘、右键、框选后拖拽 |
| `FilePane.drag.test.tsx` | 标签/文件拖拽命中、编辑模式 |
| `FilePane.browse.test.tsx` | 系统选择器取消/打开 |
| `FilePane.pagingError.test.tsx` | 分页停滞错误 |
| `FilePane.cancel.test.tsx` | 取消路径 |
| `FileList.marquee.test.tsx` | 框选状态机、自动滚动、视觉契约 |
| `FileList.layout.test.tsx` | 列表/网格布局 |
| `FileList.scroll.test.tsx` | 滚动锚点、LRU、标签隔离 |
| `FilesWorkspacePanel.splitter.test.tsx` | 分割线/比例 |
| `FilesWorkspacePanel.drawer.test.tsx` | 抽屉/模板/收纳 |
| `FilesWorkspacePanel.dragLifecycle.test.tsx` | 外部拖入/取消/生命周期 |
| `QuickPreviewDialog.test.tsx` / `.lifecycle.test.tsx` | 预览类型、token 生命周期 |
| `DuplicateFinderDialog.test.tsx` | 扫描完整性、取消、删除门禁 |
| `FolderCompareDialog.test.tsx` | 对比、预算、禁用同步 |
| `WorkspaceSearchDialog.test.tsx` | 搜索会话、取消、旧结果丢弃 |
| `RecycleWorkspaceView.test.tsx` | 回收站分页/搜索/还原/清空 |
| `OperationPreviewDialog.test.tsx` | 预演统计/冲突/不完整提示/确认与取消（本批新增） |
| `FilesWorkspacePanel.dragLifecycle.test.tsx` | 新增 Alt+Left/Right/Up 导航用例 |

**明确缺口（组件级）**：`BatchRenameDialog`、`OperationQueueBar` 无组件测试；
文件工作区→暂存架、设备发送、收藏、筛选预设、标签、集合、自动化均无测试。

### 2.3 Rust

| 模块 | 覆盖主题 |
|---|---|
| `src-tauri/src/file_workspace` | 路径规范化/清洗、列目录分页、复制/移动/删除、冲突策略、重解析点、卷键、预览、缩略图 |
| `src-tauri/src/fsops` | 任务队列、状态机、取消、失败明细、回收站任务 |
| `src-tauri/src/recycle` | 索引扫描、查询、恢复/清空语义、残留元数据 |
| `src-tauri/src/mobile_sync/files.rs` | 文件 offer/下载/导入暂存架 |

**明确缺口**：操作预演（未实现）、撤销（未实现）、压缩（未实现）、自动化（未实现）、
文件活动事件（未实现）、项目多目录（未实现）。

---

## 3. 命令与证据规范

在仓库根执行：

```powershell
npm run typecheck                # tsc --noEmit
npm test                         # 调度器 + vitest run
npm run test:raw                 # 仅供调度器排障，不作为正式通过证据
npm run build                    # 调度器 + tsc + vite build
```

在 `src-tauri/` 内执行：

```powershell
cargo test
cargo test --lib
cargo fmt --check
cargo clippy --all-targets --all-features
```

- `cargo test` 需要先有 `dist/`；不得用 `cargo build --release` 代替 Tauri 发布验收。
- 每条证据记录：**命令 + 工作目录 + 退出码 + 开始/结束时间 + 日志路径**。
- 结果文件放 `tmp/acceptance/files-workspace/<round>/`；命名含日期/对象，例如
  `vitest-files-workspace-20261118.log`。
- 禁止把旧的通过日志复制到新轮次；禁止用 `[ignore]` 套件冒充通过。

---

## 4. 单元测试矩阵（按 Feature）

| Feature | 必测单元 | 目标文件（新增/扩展） |
|---|---|---|
| FW-LAYOUT-001 | 树操作、容量阻止、撤销合并、持久化归一化 | 现有 `model/layoutTransfer/persist` |
| FW-NAV-001 | 路径输入提交/取消、历史前进后退、无效路径 | `navigation.test.ts`（新） |
| FW-NAV-002 | canBack/canForward/canUp、每标签独立、关闭清理 | `navigation.test.ts` |
| FW-SELECT-001 | 单选/多选/Shift/Ctrl/全选/焦点 | `selection.test.ts`（新） |
| FW-SELECT-002 | 矩形规范化/命中/合并/自动滚动 | 现有 `marqueeSelection.test.ts` |
| FW-DRAG-001 | 效果判定、落点、取消、同卷/跨卷 | 现有 `interactions/volumeCache/transfer` |
| FW-DRAG-002 | 外部投递仲裁、恒复制、释放 | 现有 `dragLifecycle` |
| FW-FILE-001/002 | 剪贴板操作、剪切成功项移除、失败保留 | `clipboard.test.ts`（新） |
| FW-FILE-003 | canPaste、冲突策略、目标自引用拒绝 | `clipboard.test.ts` + `transfer.test.ts` |
| FW-FILE-004 | 与系统文本剪贴板隔离、过期清理 | `clipboard.test.ts` |
| FW-RENAME-001 | 预览/非法名/冲突/序列 | 现有 `batchRename.test.ts` |
| FW-OPS-001 | 入队/启动/取消/重试、队列上限 | `operations.test.ts`（新） |
| FW-OPS-002 | 字节/速度/ETA、终态停止、暂停/恢复 | `operations.test.ts` |
| FW-OPS-003 | 计划统计、冲突/无权限/重复、超限不完整 | `operationPreview.test.ts`（新） |
| FW-OPS-004 | 覆盖/跳过/重命名/保留两者/全部应用 | `operationPreview.test.ts` |
| FW-UNDO-001 | 可逆矩阵、撤销/重做、不可逆拒绝 | `operationHistory.test.ts`（新） |
| FW-SEARCH-001 | 多源去重、上限、取消 | 现有 `workspaceSearch.test.ts` |
| FW-SEARCH-002 | 大小/时间/扩展名/隐藏组合 | `search.test.ts`（新） |
| FW-SEARCH-003 | 连续输入只保留最后会话、晚到结果丢弃 | `search.test.ts` |
| FW-FILTER-001 | 组合筛选、与选择/排序一致 | `filters.test.ts`（新） |
| FW-FILTER-002 | 预设 CRUD/归一化/应用 | `filters.test.ts` |
| FW-INFO-001 | 单文件元数据、多选聚合、缺失字段 | `metadata.test.ts`（新） |
| FW-PREVIEW-001 | 类型判定、截断、token 释放 | 现有 `QuickPreviewDialog.*` |
| FW-SYS-001/002 | 命令参数、菜单禁用态 | `FilePane` 菜单测试（新） |
| FW-ARCHIVE-001 | zip-slip、大小上限、重解析点 | Rust `archive` 单测 |
| FW-WORKSPACE-001/002 | 目录状态、迁移、容量、恢复 | `workspace.test.ts`（新） |
| FW-WORKSPACE-003 | 联合结果去重、定位窗格、匹配原因 | `search.test.ts` |
| FW-FAV-001/002 | 收藏 CRUD/排序/分组/迁移、最近 LRU | `favorites.test.ts`（新） |
| FW-COLLECT-001/002 | 加入暂存架、计划构建、投递语义 | `collect.test.ts`（新） |
| FW-PROJECT-001/002 | 多目录绑定、角色枚举、旧项目兼容 | Rust + `projectWorkspace.test.ts`（新） |
| FW-TAG-001 | 路径键归一化、增删查、不写 NTFS | `tags.test.ts`（新） |
| FW-COLLECTION-001 | 多集合归属、删除不删文件 | `collections.test.ts`（新） |
| FW-RELATION-001 | 白名单解析器、未知不猜测 | `relations.test.ts`（新） |
| FW-AUTO-001 | 规则匹配、循环防护、预演、日志 | `automation.test.ts`（新） |
| FW-SMART-001 | 预算、取消、不完整标注 | `largeFiles.test.ts`（新） |
| FW-SMART-002 | 大小预筛、SHA-256、每组保留一项 | 现有 `workspaceSearch.test.ts` |
| FW-SMART-003 | 感知哈希、分组、性能上限 | `similarImages.test.ts`（新） |
| FW-HISTORY-001 | 事件写入/有界/来源标注 | `activity.test.ts`（新） |
| FW-DEVICE-001 | 设备列表、发送、状态、失败重试 | Rust + `deviceTransfer.test.ts`（新） |
| FW-RECYCLE-001 | 分页/搜索/还原/清空语义 | 现有 `RecycleWorkspaceView.test.tsx` + Rust |
| FW-COMPARE-001 | 双侧分页、预算、完整性 | 现有 `folderCompare.test.ts` |

---

## 5. 集成测试矩阵

| 链路 | 场景 | 通道 |
|---|---|---|
| 多目录复制 | A 窗格选 3 项 → 拖到 B 窗格 → 目标出现、源按效果保留/删除 | A + C |
| 剪切粘贴 | Ctrl+X → 目标 Ctrl+V → 成功项移除、失败项保留 | A + C |
| 冲突处理 | 同名文件 → 跳过/覆盖/保留两者 → 目标数量与内容正确 | A + C |
| 取消 | 大批量复制中取消 → 已处理项保留、未处理项不动、状态正确 | A + C |
| 撤销 | 移动/重命名后撤销 → 恢复原位；永久删除无可撤销 | A + C |
| 搜索 | 多窗格搜索 → 结果去重 → 定位原窗格并选中 | A + C |
| 筛选 | 组合筛选 → 虚列表仍正确 → 切换布局保持 | A + C |
| 暂存架 | A/B/C 选择 → 加入暂存架 → 发送到 D → 原文件不移动 | A + C |
| 项目目录 | 打开项目 → 恢复现场 → 多目录角色显示 | A + C |
| 设备传输 | 桌面选文件 → 发送手机 → 进度/取消/重试 | A + C + F |
| 回收站 | 删除 → 回收站找到 → 还原/清空 | A + C + E |
| 文件夹对比 | 两侧目录 → 差异 → 仅在不完整时禁用同步 | A + C |

---

## 6. 原生测试矩阵（Windows 真机）

必须真实执行并记录证据（窗口/文件系统/回收站/系统对话框）：

| 场景 | 观察点 | 通道 |
|---|---|---|
| 创建文件/目录 | 真实落盘、重名拒绝、非法名提示 | C/E |
| 复制文件/目录 | 目标内容、字节一致、源保留 | C/E |
| 移动/剪切 | 源消失、目标存在、跨卷可用 | C/E |
| 重命名/批量重命名 | F2 进入编辑、Enter 提交、Esc 取消、部分失败 | C |
| 删除到回收站 | 回收站真实可见、可还原 | C/E |
| 永久删除 | 独立确认、回收站无记录 | C/E |
| 粘贴 | Ctrl+V、右键、冲突对话 | C |
| 多选/框选 | Ctrl/Shift、矩形、自动滚动、Escape | C |
| 跨目录拖拽 | 真实落盘复制/移动、取消无写入 | C/F |
| 外部拖入/拖出 | 资源管理器 → TaskDock；TaskDock → 桌面 | F（需授权） |
| 冲突 | 跳过/覆盖/保留两者真实结果 | C/E |
| 取消/恢复 | 取消后文件状态、重启后任务不伪装运行 | C/E |
| 预览 | 图片/视频/音频/文本真实渲染、关闭释放 | C |
| 属性 | 与资源管理器对照（大小/时间/属性） | C/E |

> 原生验收必须在**独立数据目录**（`TASK_DOCK_DATA_DIR`）与隔离实例中进行；不得操作
> 用户真实文件或真实回收站，除非任务明确授权并使用专用测试文件。

---

## 7. 大目录与性能测试

至少三档：**1,000 / 5,000 / 25,000** 文件（含隐藏项、长文件名、深层子目录）。

| 维度 | 方法 | 通过条件（待基线测量后冻结数值） |
|---|---|---|
| 首屏 | 打开目录到可交互 | 不阻塞主线程；分页 `nextOffset` 正确 |
| 滚动 | 连续滚动到底部再回顶 | 无白屏/跳行；锚点稳定 |
| 框选 | 全选/局部矩形/自动滚动 | 只遍历可视范围；无每帧全量 setState |
| 多选 | Ctrl+A / Shift 范围 | 选择集合正确；操作前不产生 IPC |
| 搜索 | 名称/类型/时间条件 | 有界；取消后停止调度；`complete` 语义正确 |
| 筛选 | 组合条件切换 | 虚拟列表仍正确；切布局保持 |
| 排序 | 名称/时间/类型/大小 | 目录恒在前；切换无错位 |
| 多窗格 | 4 窗格同时浏览/操作 | 目录缓存复用；不重复全量刷新 |
| 内存/CPU | 30 分钟操作 + 进程采样 | 有平台期；无持续增长；证据含 RSS/句柄/线程 |

- 现有 r6 证据（25310 条目、4 页 8000/8000/8000/1010、30 分钟稳定性）只能作为历史参考，
  **不能**直接作为本轮新功能通过依据。
- 大目录测试数据的创建/清理必须使用任务专用临时目录，并在报告中记录路径与清理结果；
  不清理用户真实目录。

---

## 8. 执行记录

### 8.1 Phase 1（2026-11-18，基线）

| 项目 | 状态 |
|---|---|
| 单元测试 | **未执行** |
| 集成测试 | **未执行** |
| 原生测试 | **未执行** |
| 大目录测试 | **未执行** |
| 全量类型检查/构建 | **未执行** |
| 结论 | 仅完成测试矩阵设计，不代表任何功能通过 |

### 8.2 P0 批次 1（2026-11-18）

| 命令（工作目录） | 退出码 | 结果 |
|---|---|---|
| `npx vitest run src/lib/filesWorkspace/interactions.test.ts` | 0 | 19/19 通过 |
| `npx vitest run src/lib/filesWorkspace/operationPreview.test.ts src/components/files/OperationPreviewDialog.test.tsx src/components/files/FilesWorkspacePanel.dragLifecycle.test.tsx src/store/useFilesWorkspaceStore.test.ts` | 0 | 40/40 通过（含 Alt 导航、预演对话框、最近目录清理） |
| `npx vitest run src/lib/filesWorkspace/workspaceSearch.test.ts src/components/files/WorkspaceSearchDialog.test.tsx` | 0 | 20/20 通过（新增隐藏项/大小区间） |
| `npx vitest run src/lib/filesWorkspace/interactions.test.ts src/store/useFilesWorkspaceStore.test.ts src/components/files/FilePane.selection.test.tsx src/components/files/FilePane.browse.test.tsx` | 0 | 55/55 通过 |
| `npx vitest run src/lib/filesWorkspace src/components/files` | 0 | **36 文件 / 341 用例全部通过**（文件工作区全量前端回归） |
| `npm run typecheck` | 0（最终一次） | 通过；期间曾被其他任务在途文件阻塞，非本批错误 |
| `npm run cargo -- check` | 0 | 通过（`Finished dev profile`） |
| `npm run cargo -- test file_workspace::` | 101 | **阻塞**：其他任务在途测试代码 `capability/recipes.rs`（`json!` 未导入）与 `mcp/tests.rs`（类型推断）编译失败；本批 `file_workspace` 未报错 |
| Rust `cargo test` | 未执行 | 测试目标被上述其他任务测试代码阻塞；新增 Rust 预演/属性用例待执行 |
| 构建 / 原生 | 未执行 | — |

已编写但未执行的 Rust 用例：
`preview_transfer_counts_and_detects_conflicts`、`preview_transfer_rejects_move_into_own_subtree`、
`stat_reports_kind_and_children`（新增属性断言）、`attribute_names_maps_bits_without_duplicates`。

结论：前端定向回归通过；Rust 与原生验收受共享工作树其他任务阻塞，**不得**标记 PASS。

---

## 9. 结果模板

```text
日期：
任务/Feature：
构建 ID / commit：
工作目录：
命令：
退出码：
开始/结束时间：
用例数：通过 / 失败 / 跳过
证据路径：
结论：PASS / FAIL / PARTIAL / ENVIRONMENT BLOCKED / 证据不足
未覆盖边界：
```

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-18 | 建立 Phase 1 测试矩阵：现有资产、单元/集成/原生/大目录矩阵；未执行任何测试 |
