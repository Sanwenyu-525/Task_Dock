# 文件工作区验收矩阵

- 日期：2026-11-18
- 阶段：**R9 校准**（Phase 1 基线 + Phase 2 批次 1 实现 + r8 验收记录，三个阶段明确区分）
- 功能台账：[docs/features/files-workspace.md](../features/files-workspace.md)
- 测试矩阵：[docs/testing/files-workspace.md](../testing/files-workspace.md)
- 验收方法论：[docs/ACCEPTANCE_ROUTING.md](../ACCEPTANCE_ROUTING.md)、[AGENTS.md](../../AGENTS.md)

> 本文件只登记验收状态与证据要求，不替代测试日志。任何 `PASS` 必须能追溯到指定
> `buildId`/commit、命令、退出码与证据路径；目前没有任何 `PASS`。
>
> **口径说明**：§2 矩阵的「当前状态」按**最新一轮证据**登记（r8 为最新完整记录）；
> `PARTIAL` 表示已执行部分验收（A 通道单测 / B 通道预览 mock），但完整链路（Rust 单测、
> 正式构建、原生）尚未闭环；历史 r6/r7 结论只作风险提示。Phase 1 基线（36 NOT EXECUTED）
> 与 r8 记录分别见 §3 与 §3.2，不互相覆盖。

---

## 1. 当前验收基线

| 项目 | 事实 |
|---|---|
| 分支/工作树 | `main`；工作树含多个任务未提交/未跟踪改动（bridge.ts、locales、collab 等），不属于文件工作区交付 |
| 最近文件工作区验收 | r8 结论 **部分通过**（A 通道通过；B 通道 mock 范围内通过；C 通道部分执行；Rust 与正式构建 ENVIRONMENT BLOCKED），见 §3.2 |
| 最近正式构建 | r7 的 `b09-desktop-r1..r6` 全部失败；r8 未发起构建（代码经外部定时提交进入基线，无独立交付提交） |
| 可用正式包 | 无（不得复用更早轮次产物冒充本轮） |
| R8 覆盖范围 | P0 批次 1：FW-NAV-001/002、FW-FILE-004、FW-INFO-001、FW-SYS-001、FW-OPS-003、FW-SEARCH-001/002（8 项） |

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
> 「原生」列描述是否已有原生证据；「当前状态」是验收结论。
> r8 已部分验收的 8 项标 `PARTIAL`（证据见 §3.2）；其余已实现项统一为
> `NOT EXECUTED`，历史 r6/r7 结论另注；未实现项为 `NOT IMPLEMENTED`。
> `NOT EXECUTED` ≠ 通过：正式构建与原生验收仍然缺位。

### 2.1 布局、导航、选择与拖拽

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-LAYOUT-001 | 多窗格布局与标签会话 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED（历史 r7 PARTIAL） |
| FW-NAV-001 | 地址栏/面包屑/路径输入/复制路径 | 有（路径历史下拉已实现） | 有 | 有（r8 通过） | 未验证 | PARTIAL（r8 B 通道：路径历史/跳转 mock 通过；原生未验证） |
| FW-NAV-002 | 前进/后退/上一级 | 有（Alt+Left/Right/Up 已实现） | 有 | 有（r8 通过） | 未验证 | PARTIAL（r8 B 通道：Alt 导航 mock 通过；原生未验证） |
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
| FW-FILE-004 | 文件剪贴板状态 | 部分（r8：剪切态视觉与清理入口缺失） | 部分 | 有（r8 通过） | 未验证 | PARTIAL（r8：payload/粘贴可用通过；剪切态视觉与清理入口缺失，R9 修复中） |
| FW-RENAME-001 | 重命名/批量重命名 | 有 | 有 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-OPS-001 | 文件操作任务队列 | 有 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-OPS-002 | 文件操作进度 | 部分（无字节/速度/暂停） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-OPS-003 | 文件操作预演 | 有（前后端+对话框+门禁待 R9 收紧） | 有 | 有（r8 前端通过；Rust 单测未执行） | 未验证 | PARTIAL（r8：前端单测/组件通过；Rust 与原生未执行；确认门禁待收紧） |
| FW-OPS-004 | 冲突处理 | 部分（整批策略） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-UNDO-001 | 文件操作撤销/重做 | 无（仅布局撤销） | 无 | 无 | 未实现 | NOT IMPLEMENTED |

### 2.3 搜索、筛选、信息与预览

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-SEARCH-001 | 多目录搜索 | 有（项目/固定目录来源已实现） | 有 | 有（r8 通过） | 未验证 | PARTIAL（r8：搜索用例通过；新来源组件测试与原生未验证） |
| FW-SEARCH-002 | 搜索条件 | 有（大小区间/隐藏项已实现） | 有 | 有（r8 通过） | 未验证 | PARTIAL（r8：隐藏项/大小区间用例通过；时间区间仍为近似） |
| FW-SEARCH-003 | 搜索生命周期 | 有 | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FILTER-001 | 文件筛选 | 部分（固定 chips） | 部分 | 有（未执行） | 未验证 | NOT EXECUTED |
| FW-FILTER-002 | 筛选预设 | 无 | 无 | 无 | 未实现 | NOT IMPLEMENTED |
| FW-INFO-001 | 文件详细信息 | 部分（多选摘要已实现；侧边详情面板无） | 部分 | 有（r8 摘要走查通过；Rust 单测未执行） | 未验证 | PARTIAL（r8：访问时间/属性/多选摘要 mock 通过；属性对话框夹具崩溃已定位，R9 修复；原生对照未执行） |
| FW-PREVIEW-001 | 文件预览 | 部分（无 PDF/Office） | 有 | 有（未执行） | 未验证 | NOT EXECUTED |

### 2.4 系统、压缩、工作区与项目

| Feature ID | 功能 | UI | API | 自动化 | 原生 | 本轮状态 |
|---|---|---|---|---|---|---|
| FW-SYS-001 | 系统集成命令 | 有（打开方式/终端/Windows 属性入口已实现） | 有 | 部分（r8 右键入口 mock 通过；真实命令未执行） | 未验证 | PARTIAL（r8：入口存在性通过；错误反馈吞异常待 R9 修复；原生弹窗未执行） |
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

| 当前状态 | 数量 |
|---|---|
| `PASS` | **0** |
| `FAIL` | **0** |
| `PARTIAL`（r8 已部分验收） | **8** |
| `NOT EXECUTED` | **28** |
| `NOT IMPLEMENTED` | **11** |
| `BLOCKED` | **0** |
| 合计 | **47** |

> 8 个 `PARTIAL`：FW-NAV-001、FW-NAV-002、FW-FILE-004、FW-INFO-001、FW-SYS-001、
> FW-OPS-003、FW-SEARCH-001、FW-SEARCH-002（证据见 §3.2 r8 记录）。
> `PARTIAL` ≠ 通过：上述各项的 Rust 单测、正式构建与原生验收均未闭环，不得标 PASS。
> 28 个 `NOT EXECUTED` 为已实现但未在正式构建上验收的项；r6/r7 历史结论只用于风险提示。
> （Phase 1 基线统计为 0 PARTIAL / 36 NOT EXECUTED / 11 NOT IMPLEMENTED，见 §9 变更记录。）

### 3.0 PARTIAL 项明细（r8 证据映射）

| Feature | r8 已验证 | r8 未验证（缺口） |
|---|---|---|
| FW-NAV-001 | 路径历史下拉、跨目录显示与清空（B 通道 mock） | 原生交互、无效路径显式反馈 |
| FW-NAV-002 | Alt+Up/Left/Right 导航与面包屑同步（B 通道 mock） | 原生快捷键、关闭标签历史清理断言 |
| FW-FILE-004 | 剪贴板 payload/来源/粘贴可用（单测 + B 通道） | 剪切态视觉、清理入口（R9 修复）、与系统剪贴板隔离原生断言 |
| FW-INFO-001 | 多选摘要（6 项/大小/类型分布，B 通道） | 属性对话框真实数据（夹具缺字段）、Rust 单测、Explorer 对照 |
| FW-SYS-001 | 右键含打开方式/终端/Windows 属性入口（B 通道 + 静态） | 真实系统命令执行、失败反馈（R9 修复）、原生弹窗 |
| FW-OPS-003 | 预演阈值/参数透传/对话框组件用例 | Rust `preview_transfer` 单测（已编写未执行）、确认门禁（R9 收紧）、原生大批量 |
| FW-SEARCH-001 | 项目/固定目录来源单测 | 新来源组件测试、原生 |
| FW-SEARCH-002 | 隐藏项/大小区间单测 | 时间区间（现为「最近 N 天」近似）、原生 |

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

### 3.2 Phase 2 批次 1 验收记录（r8，2026-11-18）

| 项 | 结果 | 证据 |
|---|---|---|
| A 通道：前端定向回归 | **通过**：36 文件 / 341 用例，exit 0 | `tmp/acceptance/files-workspace/round8/logs/A1-vitest.log` |
| A 通道：`npm run typecheck` | **通过**：exit 0 | `tmp/acceptance/files-workspace/round8/logs/A2-typecheck.log` |
| A 通道：Rust `cargo check/build/test` | **ENVIRONMENT BLOCKED**：rustc 连续 3 次 `STATUS_STACK_BUFFER_OVERRUN`（非编译诊断），debug 二进制随后丢失 | 调度日志 `h-mwm3q70x-b5ecfd`、`m-mwm38sse-3abe33`、`m-mwm3893f-7974a5` |
| B 通道：预览 harness（内存 mock） | **通过（mock 范围）**：Alt+Up/Left/Right 目录切换、跨目录后「最近目录」显示 `MyGame`、多选摘要（6 项 / 5.5 KB / 类型分布）、复制后空白右键「粘贴」可用、右键含「打开方式…/在终端中打开/Windows 属性…」 | `tmp/acceptance/files-workspace/round8/logs/32-preview-wb.json`、`34-preview-paste.json` |
| C 通道：隔离实例 + CDP | **部分执行**：实例启动（独立 `TASK_DOCK_DATA_DIR`）、进入文件工作区、打开路径对话框、打开夹具目录、刷新 27 项；随后 debug 二进制丢失，交互中断 | `tmp/acceptance/files-workspace/round8/logs/12-open-result.json`、`13-refresh-toolbar.json` |
| 正式构建 / 原生验收 | **未执行**：本批代码未进入任何集成快照（`snap-09` 仅含 r7） | `tmp/integration/snapshots/snap-09.json` |

本轮发现（详见 `tmp/acceptance/files-workspace/round8/report.md`）：

- `P2` FW-FILE-004：剪切后行无视觉标记，`clearFwClipboard` 无 UI 入口；目标 UI 未完成，状态下调为 PARTIAL。
- `P3` 预览夹具：`make-preview.mjs` 的 `fs_stat` 未同步 `accessedMs/attributes`，打开「属性」时
  `propsData.attributes.length` 抛 TypeError 并被 error boundary 捕获，属夹具滞后而非产品缺陷；
  建议同步夹具，避免后续走查误判。
- `P1` 流程风险：本批改动被外部定时提交混入基线提交（`9b025a4`），无法形成独立交付提交，
  正式 `task verify → ready → snapshot` 链路需等下一次未混入的交付提交才能干净执行。

本轮结论：**部分通过**（A 通道通过，B 通道 mock 范围内通过，C 通道部分执行，Rust 与正式构建阻塞）；
47 项 Feature 仍为 **0 PASS**。

### 3.3 R9 缺陷修复验收记录（r9，2026-11-19）

| 项 | 结果 | 证据 |
|---|---|---|
| A 通道：前端全量回归 | **通过**：38 文件 / 370 用例，exit 0（r8 基线 36/341 → +2 文件 / +29 用例） | `tmp/acceptance/files-workspace/round9/logs/`（调度 `l-mwmbct95-918c3a`） |
| A 通道：`npm run typecheck` | **通过**：exit 0 | 同上 |
| A 通道：`npm run cargo -- check` | **通过**：exit 0（r8 rustc 崩溃未复现，环境阻塞解除） | 调度 `m-mwmbgxrq-1d57c2` |
| A 通道：Rust `file_workspace::` 单测 | **通过**：66/66（mt.exe 嵌清单后直调测试 exe；`--lib` 绕过其他任务在途的 `virtual_display_live.rs` 编译错误） | `round9/logs/fw-rust-test.log` |
| B 通道：预览 harness（剪切态/属性/预演门禁走查） | 待执行 | — |
| C/E 通道：隔离实例原生验收（剪切/属性/系统动作/预演） | 待执行 | — |
| 正式构建 | 待执行（交付提交后走 `snapshot create` → `build --snapshot`） | — |

r9 修复范围（对应 §3.2 的 r8 发现）：

- `FW-FILE-004`（r8 P2）：剪切态订阅 + `is-cut` 视觉 + 「已剪切 N 项/取消剪切」横幅与
  右键清理入口已实现，单测覆盖；状态回升 `TESTING`（原生待验收）。
- `FW-INFO-001`（r8 P3）：属性对话框空值兜底 + `make-preview` 夹具补齐 `accessedMs/attributes`，
  属性对话框不再崩进 error boundary（6 例组件测试）。
- `FW-OPS-003`（安全门禁）：Rust `measure_tree` 元数据失败不再伪完整；`complete=false` 时
  对话框禁止直接确认（勾选「只处理可访问项」后方可继续）；确认前二次验证目标/源/冲突。
- `FW-SYS-001`：系统动作不再吞异常，失败有 toast 与单条诊断。

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
| 2026-11-18（r8 更正） | 更正统计口径：已实现 36 项（非 35）、未实现 11 项（非 12）；全部已实现项在正式构建层面 NOT EXECUTED |
| 2026-11-18（r9 校准） | 按 r8 证据把 8 项（FW-NAV-001/002、FW-FILE-004、FW-INFO-001、FW-SYS-001、FW-OPS-003、FW-SEARCH-001/002）从 NOT EXECUTED 更正为 PARTIAL；统计 0 PASS / 8 PARTIAL / 28 NOT EXECUTED / 11 NOT IMPLEMENTED；Phase 1 基线、Phase 2 批次 1 实现进度（§3.1）、r8 验收记录（§3.2）三个阶段明确区分 |
| 2026-11-19（R10 方案） | 登记 §10 R10 验收方案（场景 A–E + 报告要求），FW-LAYOUT-001 扩展标签会话模型；本轮未执行任何测试/构建/原生验收，不产生 PASS |

## 10. R10 验收方案（2026-11-19，未执行）

> 本轮只登记方案与证据要求。任何结论必须在**合格构建**（`status=succeeded` 且 `dirty=false`）
> 上按 §4 通道执行并留存证据后，才允许写 PASS；代码完成 ≠ 验收通过。
> 报告写入 `tmp/acceptance/files-workspace/round10/report.md`。

### 10.1 场景 A：标签名称（通道 B + C）

1. 添加目录 `D:\Test\正文` → 进入 `第一卷` → 标签仍显示「正文」。
2. 再进入 `第一章` → 标签仍「正文」；返回父目录 → 标签正确。
3. 悬停标签 → Tooltip 显示「正文 + `D:\Test\正文`」，标签文字不含完整长路径、超长省略。
4. 打开两个同名「正文」不同父路径 → Tooltip 可区分。
5. 目录改名/移动后标签路径状态同步、无错乱。

### 10.2 场景 B：分割窗格会话（通道 B + C）

1. 打开三个标签，激活第二个、进入子目录、改视图/排序、加类型筛选。
2. 向右分割 → 新窗格只含复制后的当前标签；原窗格三个标签都在。
3. 两窗格显示相同当前目录、会话状态一致但 tabId 不同。
4. 新窗格进入其他目录 → 原窗格不变；原窗格切换标签 → 新窗格不变。
5. 多次分割：横向/纵向/嵌套/中间窗格关闭/重启恢复结构不损坏。

### 10.3 场景 C：空窗格关闭（通道 B + C）

1. 建四窗格、仅两个打开目录，两个保持空。
2. 分别关闭一个空窗格 → 其他窗格无变化。
3. 「关闭所有空窗格」→ 只保留有内容窗格。
4. 全部窗格为空时执行 → 至少保留一个。
5. 最后一个窗格关闭入口禁用且 Tooltip 正确；空白标签不会被误判为空窗格。
6. 关闭空窗格不触发任何文件 IPC（日志/网络断言）。

### 10.4 场景 D：持久化（通道 A + C + E）

1. 多标签、多窗格、不同子目录、改排序/视图 → 保存模板 → 重启。
2. 检查标签名称（openedPath 名）、当前路径、导航历史、窗格数量/比例。
3. 应用旧模板 → 完整恢复（含旧数据缺 openedPath 的兜底）。
4. 旧持久化数据升级后再次保存/恢复稳定，不丢标签/窗格/比例。

### 10.5 场景 E：布局稳定性（通道 B + C + E）

单窗格 / 双栏横向 / 双栏纵向 / 三窗格 / 四窗格 / 多次嵌套分割 / 关闭中间窗格 /
关闭最后一个空窗格 / 窗口缩小放大 / 保存恢复——不得出现无法恢复状态或白屏。

### 10.6 R10 报告必填（除 §7 通用项外）

- 产品规则逐条落地确认（§8 的 9 条）。
- 代码变更表：修改/新增文件、修改/新增方法、数据结构变化、持久化变化。
- 测试结果分列：标签名称 / 持久化 / 分割 / 空窗格 / UI / 性能 / TypeScript / Rust / Windows 原生。
- 构建结果：commit、snapshotId、buildId、build status、安装包路径（无则写未执行）。
- 遗留问题区分：已完成 / 部分完成 / 未完成 / 环境阻塞。
- 明确「代码实现」与「真实验收」的区分；无证据项不得标 PASS。

## 11. R10 实现与验证状态（2026-11-19）

> 本节只登记**已真实执行**的检查；原生与正式构建未执行，因此 R10 相关能力**仍不得标 PASS**。

| 项 | 结果 | 证据 |
|---|---|---|
| 数据模型/持久化实现 | 完成 | `useFilesWorkspaceStore.ts`、`model.ts`、`persist.ts`（见架构 §12.9） |
| 分割/空窗格 UI | 完成 | `FilePane.tsx`、`FilesWorkspacePanel.tsx` |
| 视觉修复 | 代码完成（像素未验收） | `files.css`、`styles-ui.css`（`.ui-tooltip` pre-line） |
| 前端全量回归 | **通过**：45 文件 / 475 用例，exit 0（2026-11-19 更正：原记 474，按原始日志 `tmp/acceptance/files-workspace/round10/logs/r10-vitest-full-2.log` 的 `Test Files 45 passed (45)` / `Tests 475 passed (475)` 修正） | 本轮命令见测试矩阵 §12 |
| TypeScript | **通过**：exit 0 | 同上 |
| Rust `cargo check` | **通过**：exit 0（109s） | 调度 `m-mwn10usc-5b5f4e` |
| 集成快照 | 未执行 | — |
| 正式构建（buildId/安装包） | 未执行 | — |
| Windows 原生验收（场景 A–E） | 未执行 | — |

**FW-LAYOUT-001 状态**：保持 `TESTING`（自动化通过、原生未验证），不标 PASS。
**待真机验证项**：标签名恒为起始目录名、Tooltip 两行与边界、分割会话独立、空窗格关闭/批量清空、
最后一个窗格保护、重启恢复（openedPath/历史/比例）、搜索框单层焦点、筛选栏紧凑度、表头像素对齐。

## 12. R11 空目录右键修复状态（2026-11-19）

> 缺陷：真实空目录（0 项）的内容区空白右键弹出 WebView2 原生菜单，无法新建文件夹/新建文件/
> 粘贴/刷新。根因与四种情况边界见架构文档 §12.10。

| 项 | 结果 | 证据 |
|---|---|---|
| 修复实现 | 完成：`.fw-body-empty` 复用 `onBodyContextMenu` | `src/components/files/FilePane.tsx` |
| 新增专项测试 | **通过**：6 用例，exit 0 | `src/components/files/FilePane.emptyDirectoryContextMenu.test.tsx` |
| 失败对照（回归有效性） | 预期失败：移除 `onContextMenu` 后 `defaultPrevented=false` | 本轮终端记录，未另存日志 |
| 文件工作区全量回归 | **通过**：46 文件 / 481 用例，exit 0 | `tmp/acceptance/files-workspace/round11/logs/r11-vitest-full.log` |
| TypeScript | **通过**：exit 0 | `tmp/acceptance/files-workspace/round11/logs/r11-tsc.log` |
| 集成快照 / 正式构建 / Windows 原生 | 见 `tmp/acceptance/files-workspace/round11/empty-directory-context-menu.md`（未完成前不得标 PASS） | — |

**范围**：只修空目录右键；不新增 Store/IPC/迁移/全局右键拦截，不改 `.fw-empty-pane` 语义，
不把 `FilePane` 迁到 `PointerMenu`（列为独立改造评审）。

## 13. R12 交互收尾与第一阶段文件内容预览（2026-11-19）

> 本节只登记**本轮真实执行**的结果。B 通道＝浏览器 harness（真实组件 + IPC 桩 + 真实 pdf.js/Chromium 渲染）；
> C 通道＝Windows 原生窗口（正式构建包），本轮**未执行**（见 §13.6）。

### 13.1 R11 收尾：右键菜单关闭生命周期

| 场景 | 结果 | 证据 |
|---|---|---|
| 点击菜单外部空白 → 关闭 | PASS（B 通道，真实 DOM 事件） | `pane-shots.mjs` 输出 `MENU_AFTER_OUTSIDE 0`；截图 `shots/pane-context-closed.png` |
| 窗口失焦 → 关闭 | PASS（自动化） | `FilePane.contextMenuClose.test.tsx`「窗口失焦关闭」 |
| Escape → 关闭 | PASS（B 通道 + 自动化） | `MENU_AFTER_ESCAPE 0`；截图 `shots/pane-context-escape.png`；用例「Escape 关闭，且只关这一层」 |
| 点击菜单项 → 关闭并执行操作 | PASS（自动化） | 用例「菜单项执行后关闭，并触发对应操作」 |
| 关闭后再次右键 → 新位置重新打开 | PASS（B 通道 + 自动化） | `MENU_REOPEN 1`；用例「关闭后再次右键在新位置重新打开」 |
| 快速连续右键不同位置 → 只有一个菜单实例 | PASS（自动化） | 用例「快速连续右键不同位置：不产生多个菜单实例」；实现为 `FreeMenu` 按 `x:y` 重建实例 |
| 菜单内部 pointerdown 不误关 | PASS（自动化） | 用例「菜单内部 pointerdown 不误关」 |
| 卸载不残留菜单/监听器 | PASS（自动化） | 用例「组件卸载时菜单随之移除，后续事件不报错」 |

### 13.2 刷新目录反馈

| 场景 | 结果 | 证据 |
|---|---|---|
| 点击后立即有过程反馈 | PASS（B 通道） | `REFRESH_DURING {"busy":"true","spinning":true,"status":"正在刷新…","rows":7}`；截图 `shots/pane-refreshing.png` |
| 刷新期间保留旧列表（不闪空态） | PASS（B 通道） | 同一采样中 `rows:7`（旧条目仍在） |
| 成功后结束并显示「已更新」 | PASS（B 通道） | `REFRESH_AFTER {"busy":"false","status":"已更新"}`；截图 `shots/pane-refreshed.png` |
| 失败有反馈且保留旧列表 | PASS（自动化） | `FilePane.refresh.test.tsx`「刷新失败：结束 loading、显示行内错误、保留旧列表」 |
| 连续点击不产生重复请求 | PASS（自动化） | `dirCache.refresh.test.ts`「同一路径并发刷新合并为同一个 Promise」；`FilePane.refresh.test.tsx`「连续点击合并为一次请求」 |
| 旧请求晚到不覆盖新结果 | PASS（自动化） | `dirCache.refresh.test.ts`「旧刷新晚到不覆盖新刷新结果（序号裁决）」 |
| 不同窗格刷新状态独立 | PASS（自动化） | `FilePane.refresh.test.tsx`「不同窗格的刷新状态互相独立」 |
| 工具栏与右键菜单同一入口 | PASS（自动化） | `FilePane.refresh.test.tsx`「右键菜单刷新与工具栏共用同一入口」 |

### 13.3 第一阶段文件内容预览（FW-PREVIEW-001）

| 类型 | 走查结果 | 证据（B 通道真实渲染） |
|---|---|---|
| 图片（SVG → Blob URL） | PASS | `poster.svg {"stage":"image","hasImg":true}`；截图 `shots/preview-image-svg.png` |
| 文本/代码（TS） | PASS | `main.ts {"stage":"text","hasText":true}`；行号 + 高亮 + 编码/语言/行数芯片；截图 `shots/preview-code-ts.png` |
| 文本（Markdown） | PASS | `notes.md {"stage":"text","hasText":true}`；截图 `shots/preview-text-md.png` |
| 大文本截断提示 | PASS | `access.log` 命中截断分支；截图 `shots/preview-text-truncated.png` |
| PDF 渲染 | PASS | `report.pdf {"stage":"pdf","hasCanvas":true,"canvasSize":"356x505"}`（pdf.js 真实渲染当前页）；截图 `shots/preview-pdf.png` |
| PDF 翻页 | PASS | 翻页后计数 `第 2 / 3 页`；截图 `shots/preview-pdf-page2.png` |
| 音频自定义控制条 | PASS | `theme.wav {"audio":true,"play":true,"seek":true,"err":""}`；截图 `shots/preview-audio.png` |
| 不支持格式（DOCX） | PASS | `spec.docx` 显示「该类型不支持内嵌快速预览，可使用系统默认程序打开。」；截图 `shots/preview-unsupported.png` |
| 视频 | PARTIAL | 自动化覆盖 token 获取/释放与错误态；**未取得可播放视频样本**（环境无 ffmpeg/媒体夹具），原生播放未验证 |

### 13.4 自动化测试结果（本轮）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc --noEmit` | 0 | 全项目类型检查通过 |
| `npx vitest run src/components/files src/lib/filesWorkspace --maxWorkers=1` | 0 | **49 文件 / 520 用例通过** |
| `npx vitest run src/components/files/preview/previewKind.test.ts` | 0 | 63 用例通过（格式矩阵） |
| `npx vitest run src/lib/filesWorkspace/dirCache.refresh.test.ts` | 0 | 6 用例通过（刷新入口） |
| `npx vitest run src/components/files/FilePane.refresh.test.tsx` | 0 | 4 用例通过（刷新反馈） |
| `npx vitest run src/components/files/FilePane.contextMenuClose.test.tsx` | 0 | 8 用例通过（右键生命周期） |
| `npx vitest run src/components/files/QuickPreviewDialog.preview.test.tsx` | 0 | 26 用例通过（预览矩阵/竞态/释放） |
| `npx vite build --outDir dist-r12 --emptyOutDir=false` | 0 | pdf.js 独立 chunk（451 KiB）+ worker 资源（1.3 MiB）+ `dist-r12/pdfjs/`（CMap/字体/WASM 3.6 MiB）均产出 |

### 13.5 本轮结论

- **FW-PREVIEW-001**：`PARTIAL`。第一阶段功能（图片/文本代码/PDF/视频/音频）已实现并通过自动化 + B 通道真实渲染走查；
  **正式构建包上的原生验收（C 通道）与 Office 内嵌渲染未完成**，因此不得标 PASS。
- **右键菜单关闭（R11 收尾）**：`PASS`（自动化 + B 通道真实事件）。
- **刷新反馈（R12）**：`PASS`（自动化 + B 通道真实事件）。

### 13.6 未执行 / 阻塞项（必须如实记录）

| 项 | 状态 | 原因 |
|---|---|---|
| Windows 原生窗口验收（C 通道，真实安装包） | **BLOCKED** | 本轮未能从集成快照产出正式安装包：Rust 依赖编译在并行构建下崩溃（`STATUS_STACK_BUFFER_OVERRUN`，`image`/`windows` crate），且共享 `src-tauri/target` 被其他在途构建占用（`.cargo-lock` 拒绝访问）。 |
| 正式构建 buildId / 安装包 / snapshotId | **未执行** | 同上；`npx vite build` 在 `dist/` 上还会被环境安全删除守卫拦截（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），本轮改用 `--outDir dist-r12` 验证打包。 |
| 视频播放（真实编码） | **NOT EXECUTED** | 环境无 ffmpeg 与媒体样本，无法生成可播放视频夹具；仅自动化覆盖 token 生命周期与错误态。 |
| 中文字形显示 | 环境限制 | 走查用的 headless Chromium 缺少中文字体，截图中汉字呈窄形占位；**布局/几何/交互结论有效，字形渲染需在原生 WebView2 复核**。 |

## 14. R14 预览系统与检查器 Dev 验收（2026-11-23）

- 通道：**Dev 功能验收**（真实 `vitest` jsdom + 生产打包），未推进 Release 状态机、未生成 `buildId`。
- 范围：FW-PREVIEW-001（升级）、FW-PREVIEW-002/003/004（新增）、FW-INFO-001（侧栏详情部分）。
- 事实来源：源码 + `docs/testing/files-workspace.md §14` 的命令输出。

### 14.1 必测场景逐项结论

| # | 场景 | 结论 | 证据/说明 |
|---|---|---|---|
| 1 | 单选文件自动预览 | Dev 通过 | `FilesWorkspacePanel.previewPane.test.tsx`「活动窗格单选」；读取 1 次 |
| 2 | 多选文件显示统计 | Dev 通过 | 同上「多选显示统计」；无 `.fw-preview-code`、未读文件 |
| 3 | 文件夹选择显示信息 | Dev 通过（纯函数层） | `previewSelection.test.ts` 文件夹身份与「不递归」口径；组件空态由 `FilePreviewContent` 覆盖 |
| 4 | 活动窗格切换 | Dev 通过 | 非活动窗格上报被忽略；渲染层按 `paneId === activePaneId` 二次校验 |
| 5 | 标签切换 | Dev 部分覆盖 | 依赖 `FilePane` effect（dirPath/selection 变化）；面板层用同一快照链路；未做真实标签点击的端到端用例 |
| 6 | 关闭右侧面板 | Dev 通过 | 关闭按钮写 store，`aria-label` 检查器节点消失 |
| 7 | Alt+P 开关 | Dev 通过 | 两次 `keydown` 断言 store 布尔值翻转 |
| 8 | 调整面板宽度 | Dev 通过（键盘） | ←/→ ±16、Shift ±40、Home/End、Enter 复位；指针拖拽只有代码路径，未在 jsdom 断言几何 |
| 9 | 窗口缩小/放大 | 未验证 | jsdom 无布局；断点（<900px → 浮层）只做代码审查 |
| 10 | 快速切换 50 个文件 | Dev 通过（回归） | `QuickPreviewDialog.lifecycle` 既有「50 个视频」用例；文本侧靠 `key={path}` 重挂载 |
| 11 | 关闭预览后媒体资源释放 | Dev 通过 | 既有 lifecycle 用例（token 恰好释放一次） |
| 12 | PDF worker 释放 | Dev 通过 | 既有 PDF 销毁链路用例未改动 |
| 13 | 图片 Blob URL 释放 | Dev 通过 | 既有图片用例 |
| 14 | 视频音频 token 释放 | Dev 通过 | 既有用例 |
| 15 | 旧请求晚到不覆盖新文件 | Dev 通过 | 既有「晚到响应」用例 + 选择联动 paneId 校验 |
| 16 | Markdown 源码/阅读切换 | Dev 通过 | `FileTextPreview.test.tsx`：切换后 `fsReadText` 仍为 1 次 |
| 17 | 文本长行自动换行 | Dev 通过（状态） | `data-wrap="true"` 默认；CSS `pre-wrap + overflow-wrap:anywhere` |
| 18 | 文本文件内搜索 | Dev 通过 | 阅读/源码两种模式各 2 命中、当前命中唯一、清空后 0 |
| 19 | 编码错误与截断 | Dev 通过（回归） | 既有编码/截断用例保持通过 |
| 20 | 不支持格式回退 | Dev 通过 | 既有 `.exe` 用例：不读文本、显示 unsupported；本轮补信息头部 |

### 14.2 通过项与缺口

- **Dev 功能验收：部分通过**。
  - 通过：预览内容管线、Markdown 双模式、文件内搜索、检查器开关/选择联动/授权命令、
    资源释放回归、类型判定回归、生产打包。
  - 未通过/未执行：原生窗口视觉与 DPI、真实指针拖拽几何、标签切换端到端、窄窗浮层实测、
    正式安装包验收。
- 没有把「既有通过结论」复制到本轮：上表所有 Dev 通过项都有本轮执行记录；未执行项明确标注。

### 14.3 构建与正式验收状态

| 项 | 状态 | 说明 |
|---|---|---|
| `npm run typecheck` | 通过 | 退出码 0 |
| `npm run build` | **ENVIRONMENT BLOCKED** | `vite` 清空 `dist/` 被安全删除守卫拦截（249 文件 / 阈值 50）；`tsc` 与 2296 模块转换均已通过 |
| `npx vite build --emptyOutDir false` | 通过 | 退出码 0，23.72s；`dist/` 中会同时保留旧哈希产物（守卫禁止批量删除），正式发布前应在无守卫环境执行一次 `npm run build` |
| Release 正式验收（snapshot/build/accept） | **未执行** | 本轮为 Dev 功能验收，按规范不推进状态机、不生成 `buildId` |

### 14.4 本轮结论

**Dev 功能验收：部分通过。** 预览系统与右侧检查器已达到「可交付评审」状态；在完成
Windows 原生视觉/DPI 走查与一次干净的 `npm run build` 之前，不得标记 `PASS`。

### 14.5 结构化视图增补（Dev 功能验收，2026-11-23）

| # | 场景 | 结论 | 证据 |
|---|---|---|---|
| 1 | `.csv` 打开即表格：表头、行号列、列名 | Dev 通过 | `FileTextPreview.test.tsx`「默认表格模式」：`thead` 列名 = 数据首列、`tbody` 2 行、首格 = `Alice` |
| 2 | 表格 ↔ 源码切换不重新读盘 | Dev 通过 | 同一用例链断言 `fsReadText` 恰好 1 次；源码模式出现 `fw-preview-code` 与查找框 |
| 3 | 首行表头手动纠正 | Dev 通过 | 点击 `fw.preview.csv.headerToggle` 后 `thead` 消失、数据行由 1 变 2 |
| 4 | `.json` 默认树形：只展开根、逐层展开、全部展开/收起 | Dev 通过 | 可见行 3 → 6 → 1；全程 `fsReadText` 1 次 |
| 5 | 非法 JSON 回退源码并说明原因 | Dev 通过 | 无 `fw-json-tree`、chip `fw.preview.json.fallbackChip`、树形模式按钮 `disabled`、提示条带解析器消息 |
| 6 | `.jsonc` 保持源码视图（允许注释） | Dev 通过（判定层） | `previewKind.test.ts` 结构化口径用例：`isJsonExt("jsonc") === false` 且 kind 仍为 `text` |
| 7 | 表格与树的文件内查找 | 明确不支持 | 结构化模式不显示查找框；切到源码视图可查找（设计见 architecture §15.8） |
| 8 | 原生窗口 / DPI 下黏性表头、600 行渲染上限 | Dev 通过（2026-11-23 21:47 原生窗口） | `run-20261123-214707/screenshots/02-csv-table.png`（黏性表头 + 行号列）、`08-large-csv.png`（700×45 → 600×40 并给出「切到源码视图」提示）；滚动帧率仍未测量，见 §14.7 |

**结论**：结构化视图子项为 **Dev 功能验收：通过（行为与预算）**，但**不改变 §14.4 的总体结论**：
原生视觉/DPI 走查与一次干净的 `npm run build` 完成前，`FW-PREVIEW-005` 保持 `TESTING`，不得标 `PASS`。
（原生窗口部分已于当晚 21:47 补验，见 §14.7；干净 `npm run build` 仍受阻。）

### 14.7 原生窗口 Dev 验收（复用 1420，2026-11-23 21:47）

- 通道：**Dev 功能验收**，真实 `task-dock.exe`（debug，含当前前端改动）。
- 前端来源：**复用已运行的 Vite 1420**（脚本未启动第二个 dev server，也未关闭它）。
- 附加方式：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<空闲端口>` + Playwright `connectOverCDP`；
  按 `__TAURI_INTERNALS__.metadata.currentWindow.label` 区分主窗口（`main`）与完整工作台（`workspace`），
  不靠 URL 猜窗口。
- 隔离：`TASK_DOCK_DATA_DIR` 与 `WEBVIEW2_USER_DATA_FOLDER` 都指向运行目录，不触碰真实用户数据。
- 脚本：`node scripts/acceptance-files-structured-preview.mjs`（`--keep` 可保留窗口供探针复核）。

| # | 场景 | 结论 | 实测证据 |
|---|---|---|---|
| 1 | 工作区按持久化布局直达夹具目录 | 通过 | 列出 6 个夹具文件 |
| 0 | `workbench_open_window(target=files)` 直达 | 通过（修复后复验） | 返回成功并直接落到文件工作区；修复前返回「未知的工作台导航目标: files」，见下方修复记录 |
| 1b | 检查器同步预览 / 弹窗打开时挂起 | 通过 | 选中后检查器出现 `.fw-csv-table`；弹窗打开后检查器表格消失（不双解析） |
| 2 | CSV 表格视图 | 通过 | 表头 `sku,name,city,price,note,stock`，数据 12 行，首格 `SKU-001`，meta `12 行 × 6 列 / 分隔符 ,` |
| 3 | 表头开关 | 通过 | 点「首行作为表头」后数据行 12 → 13，`thead` 消失 |
| 4 | 源码模式 | 通过 | 模式段 `[表格 | 源码]`；切源码后表格消失、查找框出现 |
| 5 | JSON 树形视图 | 通过 | 默认可见 9 行 → 展开全部 45 行；chip `45 个节点 / 深度 8` |
| 6 | 非法 JSON 回退 | 通过 | 无树、chip「已回退源码」、树形按钮禁用（段 `[树形(禁用) | 源码]`） |
| 7 | TSV 分隔符 | 通过 | meta `8 行 × 5 列 / 分隔符 Tab` |
| 8 | 700×45 大 CSV | 通过 | 1460–1765ms 出表（单次采样，非 p50）；渲染 600 行并提示「完整内容请切到源码视图」 |
| 9 | Markdown 回归 | 通过 | `.md` 阅读模式仍保留查找框 |
| 10 | 运行期错误 | 通过 | `pageerror=0`、`console.error=0` |

- 环境：工作台视口 **1200×760 CSS px、`devicePixelRatio=1.25`**（Windows 125% 缩放的实机环境，非 headless 默认值）。
- 证据：修复前 `run-20261123-214707/`（11 项，rail 绕过），修复后 `run-20261123-220408/`
  （12 项含「0 直达 files 路由」，`summary.md`、`acceptance.log`、`screenshots/` 10 张含
  `02-csv-table.png`、`05-json-tree.png`、`08-large-csv.png`）。

**本轮发现并修复的问题（P2：工作台导航白名单漏项）**

| 项 | 内容 |
|---|---|
| 现象 | 主窗口请求打开「文件工作区」时 `workbench_open_window` 返回「未知的工作台导航目标: files（允许: home, workbench, workspace, ...）」 |
| 影响 | 所有走结构化导航到 `files` 的入口（胶囊/主窗口快捷入口/外部调用）都会失败；只能进工作台后手动点 rail，错误文案还会让人误判功能不存在 |
| 根因 | Rust `project_workspace_window.rs` 的 `WORKBENCH_TABS` 白名单漏登记 `files`、`life`、`vault`、`capability` 四项（前端 `workbenchLayout.ts` 的 `WORKBENCH_ROUTES` 早已包含） |
| 修复 | 白名单按前端顺序补齐四项，并在注释里写明「改一侧必须同步另一侧」；新增 Rust 回归用例 `workbench_tabs_match_frontend_routes`（逐项断言白名单 == 前端 23 个路由，且每个都能通过 `normalize_workbench_target`） |
| 验证 | `npm run cargo -- test --lib project_workspace_window::` → 30 passed；`npm run cargo -- build` 退出码 0（4m05s）；重建后原生验收 12/12（`run-20261123-220408`） |

- **未验证**：表格滚动帧率（无 instrumentation，只记录出表耗时）、多档 DPI（100%/150%/200%）、多显示器、
  PDF 内搜索、Office/ZIP 预览。
- 结论：**FW-PREVIEW-005 的原生 Dev 验收通过**；因干净 `npm run build` 仍被删除守卫拦截，台账继续保持
  `TESTING`，不标 `PASS`、不推进 Release 状态机。

### 14.6 本轮环境阻塞记录

| 项 | 状态 | 说明 |
|---|---|---|
| Windows 原生 `npm run tauri dev` 走查 | **已补验（非 `tauri dev` 启动）** | 未另起 dev server：复用已运行的 Vite 1420 + `src-tauri/target/debug/task-dock.exe` + CDP 附加完成原生窗口走查，见 §14.7；`tauri dev` 全流程本身仍未单独执行 |
| 验收提交 | **未提交** | `FilesWorkspacePanel.tsx` 与 `files.css` 同时含本任务与另一 Agent 的 `ui-resizer` 收敛改动（`fw-divider ui-resizer`、`styles-resizer.css`），无法按精确路径分离；不代提交、不整文件覆盖 |
