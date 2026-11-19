# 实施计划与当前进度

> 更新时间：2026-11-19（以实际代码与执行结果为准；未执行项明确标「未执行」）

## 阶段划分

### 阶段 0：审查（已完成）

- 主窗口 / 工作台 / 侧栏 / 抽屉 / 浮层机制；
- 剪贴板、文件工作区、暂存架、任务、项目、规划、知识库、采集、移动端；
- 事件、状态、持久化、窗口通信、右键菜单、拖拽、撤销、错误处理；
- 结论见 [ARCHITECTURE.md](ARCHITECTURE.md) §2「复用映射」。

### 阶段 1：文档（已完成）

本目录 10 份文档。文档先于编码，与实现同步更新。

### 阶段 2：P0 公共底层（已完成，真实编译 + 单测）

- 迁移 79：`transfer_items` / `transfer_contents` / `transfer_batches` / `entity_links`；
- `transfer::store`：CRUD、去重、正文分级、排序、生命周期；
- `transfer::batches`：批次、逐条结果、撤销信息；
- `transfer::execute`：文件目标预览与执行（write + copy/move）；
- `transfer::context`：跨窗口上下文；
- `transfer::links`：通用关联；
- `fsops::start_write`：写文本/图片文件的任务类型（复用调度器）；
- `fsops::write_one_for_test`：测试专用入口，真实写盘验证；
- 前端 `crossTab`：`types` / `transferClient` / `actionRegistry` / `eventBus` /
  `contextResolver` / `panelState`（`entityLinks`、`targets` 尚未创建）；
- 面板状态：`localStorage`（键 `taskdock.transfer.panel.v1`），跨同源窗口同步；
  后端 `transfer_tray_state` 设置键已登记，但 `db::Settings` / 前端 `Settings` 均未扩字段，
  本轮**不使用**该键。

### 阶段 3：P0 UI（代码完成，渲染测试通过）

- `TransferPanel`：工作篮/剪贴板两页签、多选、搜索、类型筛选、固定、预览、目标、发送；
- 发送预览：内嵌 `Dialog`（计数、冲突、unsupported、warnings），不是独立 `TransferPreviewDialog` 组件；
- 工作台右侧固定列 / 窄窗与主窗口抽屉；
- 面板宽度拖拽 + 键盘调整 + 持久化；
- `SendToMenu` / `TargetPicker` / `ActionDispatcher` **未实现**；面板当前只有一条发送路径。

### 阶段 4：剪贴板 ↔ 工作篮 ↔ 文件工作区（代码完成，未手工验收）

- 剪贴板多选加入（文本/图片/文件/链接/HTML/混合）；
- 写 TXT / Markdown / 合并 / 单独（预览对话框可选择文本格式与合并策略）；
- 图片 PNG 批量保存；
- 文件复制/移动（含跨盘、占用、权限、同名冲突；预览对话框可选择复制/移动与冲突策略）；
- URL 保存 `.url` / Markdown（预览对话框可选择保存方式）；
- 混合内容预览与执行；
- 部分成功、失败清单、重试失败项、撤销（回收站）；
- 未执行：真实窗口手工发送、真实文件写入/撤销、磁盘满/权限不足等异常真机复现。

### 阶段 5：P1 模块接入（部分完成）

已接入：

- 文件工作区工具栏「加入工作篮」（文件/目录引用）；
- 面板底部可选择目标目录 / 使用文件工作区当前目录；
- 工作篮「更多 → 创建任务」：文本/文件/目录/链接创建任务，真实文件以 `attachment` 关联
  （`tasks.createFromTray`，3 个单测通过；未手工验收）。

未开始（页面入口与动作均未实现）：

- 工作篮/文件 → 添加到已有任务；
- 工作篮/文件 → 关联项目；
- 工作篮 → 关联规划功能；
- 文本 → 知识库文档；文件 → 知识库导入；
- 工作篮 → 暂存架 / 收集箱；
- 知识条目 / 采集条目 → 工作篮；
- 任务详情「关联文件/知识/规划」区块；
- 项目页「关联资料」列表；
- 规划中心「生成任务」按钮与进度联动；
- 资源管理结果 → 文件工作区/工作篮入口；
- 手机素材直接入篮。

### 阶段 6：P1 全局拖拽（未开始）

- 协议已定（UI_SPEC §6）；工作篮条目已能发出 `application/x-taskdock-transfer`；
- 尚未实现任何投放目标、合法性校验、排序与失败反馈；
- 跨窗口拖拽不在本期。

### 阶段 7：P2 上下文与智能推荐（未开始）

- 已有：`TransferContext` 的命令与工作台路由级 `module` / `directory` 写入；
- 未实现：最近使用上下文、`suggestTargets`、推荐解释、关闭偏好、全局统一搜索聚合。

## 已执行验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（exit 0） |
| `npm run cargo -- check` | 通过（exit 0，仅有 warning） |
| `npm run cargo -- test transfer::tests --lib` | 7 passed / 0 failed（exit 0） |
| `npm run test -- src/lib/crossTab` | 8 passed（2 文件） |
| `npm run test -- src/components/transfer/TransferPanel.test.tsx` | 2 passed |
| `npm run test -- src/components/clipboard` | 109 passed（6 文件；含本模块改动后的剪贴板页） |

未执行：`npm run tauri` 正式构建、真实窗口手工验收、真实文件写入/撤销、性能采样。

## 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| 迁移 79 与其他并行任务撞号 | 迁移失败 | 只改 `MIGRATIONS` 一行重新分配号；新表无数据时可直接删除 |
| `fsops::start_write` 影响既有任务 | 复制/移动回归 | 新增 kind 分支，不改既有 copy/move 代码路径 |
| 工作台右栏互斥导致详情不可见 | 页面详情暂时隐藏 | 关闭工作篮即恢复；顶部「上下文」按钮重新打开 |
| 面板在小窗口挤压内容 | 内容不可用 | `resolvePanelMode` 自动降级抽屉；单测覆盖阈值 |
| 面板状态只在 localStorage | 换机器/清缓存丢失 | 已在后端登记 `transfer_tray_state`，后续可迁移 |

## 下一步（按优先级）

1. 真实窗口手工验收阶段 4（写入/复制/移动/重试/撤销/异常）；
2. `SendToMenu` + `ActionRegistry` 内置动作，接任务/项目/知识；
3. 规划中心「生成任务」动作入口 + 进度派生指标；
4. 资源管理 → 文件工作区定位入口；
5. 应用内拖拽投放目标与排序；
6. 全局搜索聚合（扩展现有 `global_search`，不建第二套索引）。
