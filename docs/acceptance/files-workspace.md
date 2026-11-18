# 文件工作区验收矩阵

- 日期：2026-11-18
- 阶段：Phase 1 开发前基线（**未执行本轮验收**）
- 功能台账：[docs/features/files-workspace.md](../features/files-workspace.md)
- 测试矩阵：[docs/testing/files-workspace.md](../testing/files-workspace.md)
- 验收方法论：[docs/ACCEPTANCE_ROUTING.md](../ACCEPTANCE_ROUTING.md)、[AGENTS.md](../../AGENTS.md)

> 本文件只登记验收状态与证据要求，不替代测试日志。任何 `PASS` 必须能追溯到指定
> `buildId`/commit、命令、退出码与证据路径；本轮没有任何 `PASS`。

---

## 1. 当前验收基线

| 项目 | 事实 |
|---|---|
| 分支/工作树 | `main`；工作树含多个任务未提交/未跟踪改动（含文件工作区文件），不属于本轮交付 |
| 本轮改动 | 仅新增 4 份文档（features/architecture/testing/acceptance）；未改业务代码 |
| 最近文件工作区验收 | r7 结论 **PARTIAL**（组件级通过；正式构建、原生视觉、真实落盘拖拽、大目录未闭环） |
| 最近正式构建 | r7 的 `b09-desktop-r1..r6` 全部失败，无安装包产物 |
| 可用正式包 | 无（不得复用更早轮次产物冒充本轮） |
| 本轮测试 | **未执行**（Vitest / Rust / 类型检查 / 构建均未执行） |
| 本轮验收结论 | **未进入验收**；不得宣布任何 Feature 通过 |

### 1.1 状态口径

| 状态 | 含义 |
|---|---|
| `PASS` | 指定 buildId 上，自动化 + 必要原生证据齐全，结论可复核 |
| `FAIL` | 指定 buildId 上复现失败，有现象/复现/证据 |
| `PARTIAL` | 部分场景通过，其余未覆盖或有缺陷 |
| `NOT EXECUTED` | 本轮未执行；不代表通过或失败 |
| `NOT IMPLEMENTED` | 功能尚未实现 |
| `BLOCKED` | 环境/外部依赖阻塞，单列原因 |
| `N/A` | 该层不适用（如纯元数据功能无需原生窗口） |

---

## 2. 全量验收矩阵（47 项，一个都不能漏）

> 「UI/API/自动化」列描述**当前代码是否存在入口/契约/测试文件**；
> 「原生」列描述是否已有本轮原生证据；「本轮状态」是验收结论。
> 既有但未在本轮执行的项统一为 `NOT EXECUTED`，历史 r7 结论另注。

### 2.1 布局、导航、选择与拖拽

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-LAYOUT-001 | 多窗格布局与标签会话 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED（历史 r7 PARTIAL） |
| FW-NAV-001 | 地址栏/面包屑/路径输入/复制路径 | 部分（无路径历史） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-NAV-002 | 前进/后退/上一级 | 有（缺 Alt 快捷键） | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-SELECT-001 | 文件选择系统 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED（历史 r7 PARTIAL） |
| FW-SELECT-002 | 矩形框选 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED（历史 r7 PARTIAL） |
| FW-DRAG-001 | 应用内文件拖拽 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-DRAG-002 | 外部 OS 拖入/拖出 | 有 | 有 | 有（未执行） | 未验证（OLE 需 F 通道） | NOT EXECUTED |

### 2.2 文件剪贴板与操作

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-FILE-001 | 文件复制 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FILE-002 | 文件剪切 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FILE-003 | 文件粘贴 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FILE-004 | 文件剪贴板状态 | 有 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-RENAME-001 | 重命名/批量重命名 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-OPS-001 | 文件操作任务队列 | 有 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-OPS-002 | 文件操作进度 | 部分（无字节/速度/暂停） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-OPS-003 | 文件操作预演 | 有 | 有 | 有（已执行前端用例） | 未验证 | NOT EXECUTED |
| FW-OPS-004 | 冲突处理 | 部分（整批策略） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-UNDO-001 | 文件操作撤销/重做 | 无（仅布局撤销） | 无 | 无 | 未实现 | NOT IMPLEMENTED |

### 2.3 搜索、筛选、信息与预览

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-SEARCH-001 | 多目录搜索 | 有（范围受限） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-SEARCH-002 | 搜索条件 | 部分 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-SEARCH-003 | 搜索生命周期 | 有 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FILTER-001 | 文件筛选 | 部分（固定 chips） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FILTER-002 | 筛选预设 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-INFO-001 | 文件详细信息 | 部分（单文件） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-PREVIEW-001 | 文件预览 | 部分（无 PDF/Office） | 有 | 有（未执行） | 未验证 | NOT EXECUTED |

### 2.4 系统、压缩、工作区与项目

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-SYS-001 | 系统集成命令 | 部分（缺打开方式/终端/属性） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-SYS-002 | 右键系统操作菜单 | 部分 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-ARCHIVE-001 | 压缩与解压 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-WORKSPACE-001 | 多目录工作区 | 部分 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-WORKSPACE-002 | 目录状态保持 | 部分 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-WORKSPACE-003 | 多目录联合搜索 | 有（部分） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-COLLECT-001 | 智能文件收集（暂存架） | 有（复用暂存架） | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-COLLECT-002 | 多目录暂存→统一投递 | 部分 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-PROJECT-001 | 项目文件工作空间 | 部分（单根目录） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-PROJECT-002 | 项目目录角色 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |

### 2.5 收藏、标签、集合、关系

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-FAV-001 | 收藏夹 | 部分（仅固定目录） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FAV-002 | 最近访问 | 部分（仅目录） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-TAG-001 | 文件颜色与标签 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-COLLECTION-001 | 文件收藏集 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-RELATION-001 | 文件关系与项目引用 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |

### 2.6 智能、自动化、历史、设备与回收站

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-AUTO-001 | 文件自动化 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-SMART-001 | 大文件分析 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-SMART-002 | 重复文件 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED（历史 r6 部分通过） |
| FW-SMART-003 | 相似图片 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-HISTORY-001 | 文件变更时间线 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-DEVICE-001 | 跨设备文件传输 | 部分（设置页） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-RECYCLE-001 | 回收站索引视图 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-COMPARE-001 | 文件夹对比 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |

---

## 3. 统计

| 本轮状态 | 数量 |
|---|---|
| `PASS` | **0** |
| `FAIL` | **0** |
| `PARTIAL`（本轮） | **0** |
| `NOT EXECUTED` | **36** |
| `NOT IMPLEMENTED` | **11** |
| `BLOCKED` | **0** |
| 合计 | **47** |

> 36 个已实现项在**正式构建验收**层面均未执行，因此不得标 PASS；
> 其中 r7/r6 的历史结论只用于风险提示，不构成本轮通过证据。

### 3.1 Phase 2 批次 1 实现进度（2026-11-18）

| Feature | 实现 | 前端定向测试 | Rust 测试 | 原生/正式构建 |
|---|---|---|---|---|
| FW-NAV-001 | 路径历史下拉 + 清除 | Store 用例通过 | — | 未验证 |
| FW-NAV-002 | Alt+Left/Right/Up | 面板用例通过 | — | 未验证 |
| FW-FILE-004 | 剪贴板 payload/清理/来源 | 单测通过 | — | 未验证 |
| FW-INFO-001 | 访问时间/属性/多选摘要 | 未单独覆盖 | 已编写未执行 | 未验证 |
| FW-SYS-001 | 打开方式/终端/原生属性 | 未单独覆盖 | 命令编译未报错 | 未验证 |
| FW-OPS-003 | 预演后端 + 对话框 + 接入 | 单测/组件通过 | 已编写未执行 | 未验证 |
| FW-SEARCH-001 | 项目/固定目录来源 | 搜索用例通过 | — | 未验证 |
| FW-SEARCH-002 | 大小区间/隐藏项 | 搜索用例通过 | — | 未验证 |

> 上表只表示「实现进度」，不是验收通过。本批 `npm run typecheck` 通过，
> `src/lib/filesWorkspace` + `src/components/files` 全量前端回归 **36 文件 / 341 用例通过**；
> Rust 测试与原生/正式构建仍未执行。正式验收仍需在合格构建上按本矩阵执行。

---

## 4. 验收通道与证据要求

| 层 | 通道 | 最低证据 |
|---|---|---|
| 纯逻辑/契约/迁移 | A | 命令、工作目录、退出码、用例数、日志 |
| DOM/视觉/窄窗 | B | `npm run build` + `make-preview.mjs` + `serve-preview.mjs` 截图/断言 |
| 真实 WebView2 交互 | C | 真实实例 + CDP 端口 + locator 操作与可观察结果 |
| 可访问性结构 | D | 真实 `role/aria-*` 或 accessibility snapshot |
| Win32/DWM/几何 | E | 独立数据目录、区域回读、桌面合成截图 |
| 物理拖拽/系统命中/通知 | F | 授权后的真实鼠标/键盘操作与桌面截图 |

硬边界：

- 页面截图不证明桌面合成；`PrintWindow` 不证明背景透出。
- mock IPC / jsdom 不证明真实文件系统写入。
- 设置命令返回成功不证明像素/文件结果正确。
- `dispatchEvent()` / DOM `.click()` 不算真实交互。
- 单测与预览不能替代原生窗口和系统层。

---

## 5. 验收执行顺序（Phase 2 起）

1. 先取得**集成快照 + 正式构建**（`npm run integrate:status` / `batch plan` / `build --snapshot`），
   `status=succeeded` 且 `dirty=false` 才可验收。
2. 按 P0 → P1 → P2 分批；同一 `buildId` 可并行验收不同模块，各写各的记录。
3. 每个 Feature 按「UI 入口 → API → 自动化 → 原生 → 证据 → 状态」逐项填入本矩阵。
4. 失败项记录：buildId、现象、复现步骤、期望/实际、证据路径、责任 Feature。
5. 修复后必须产生新交付提交 → 新快照 → 新构建 → 定向复测 + 受影响链路回归；
   不得用旧版本通过结论证明新版本通过。

---

## 6. 问题清单模板（P0–P3）

```text
[P0/P1/P2/P3] 标题
- Feature ID：
- 构建/commit：
- 现象：
- 复现步骤：
- 期望：
- 实际：
- 根因（若已定位）：
- 影响面：
- 证据路径：
- 修复建议/责任模块：
- 状态：OPEN / FIXED / VERIFIED / WONTFIX
```

判定口径：

- **P0**：数据丢失、安全泄露、崩溃、核心流程不可用。
- **P1**：主要功能错误或严重仓库/数据风险。
- **P2**：边界错误、次要缺陷、文档与实现不一致。
- **P3**：体验/格式/低风险改进。

---

## 7. 最终报告必填项（所有 47 个 ID）

1. 任务范围、构建 ID、commit、快照、`dirty`、运行环境。
2. 逐 Feature 结论：UI / API / 测试 / 原生 / 状态；未实现写 `NOT IMPLEMENTED`。
3. P0–P3 问题清单（现象/根因/影响/证据）。
4. 命令与结果（工作目录/退出码/时间/日志）。
5. 已验证 / 未验证项及原因；`ENVIRONMENT BLOCKED` 单列。
6. 遗留风险与后续建议。
7. 证据路径（`tmp/acceptance/files-workspace/<round>/`）。
8. 结论只允许：**通过 / 部分通过 / 不通过 / 证据不足**。

---

## 8. 本轮结论

- 本轮仅完成开发前基线与矩阵登记；**未执行任何验收**。
- 任何 Feature 不得标记 `PASS`；不得据此发布或宣称“文件工作区完成”。
- 下一步需用户确认后进入 P0 开发，并在正式构建上按本矩阵逐项验收。

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-18 | 建立 Phase 1 验收矩阵：47 个 Feature 全量登记；本轮 0 PASS / 35 NOT EXECUTED / 12 NOT IMPLEMENTED |
