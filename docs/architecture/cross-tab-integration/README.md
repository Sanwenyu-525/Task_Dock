# 全局跨 Tab 联动系统（Cross-Tab Integration System）

> 状态：P0 数据层与面板已实现（编译、单测、渲染测试通过）；剪贴板 ↔ 工作篮 ↔ 文件工作区为
> **代码完成、未手工验收**。P1 仅任务创建动作部分接入，其余**未开始**，详见 [MODULE_MATRIX.md](MODULE_MATRIX.md)。
> 本目录是这套系统的**唯一设计事实源**。代码与文档冲突时以代码为准，并回写本文档。

## 1. 这套系统解决什么问题

TaskDock 原本是一组相对独立的页面：剪贴板只负责复制历史，文件工作区只负责浏览磁盘，
任务页只负责待办。用户把一段剪贴板文本变成文件、把一个文件挂到任务、把一个采集素材
关联到项目时，只能靠手工复制粘贴或反复切换页面。

本系统提供三层能力，让内容、文件、任务、项目、规划、知识可以**显式、可追踪**地流动：

| 层 | 职责 | 代码位置 |
|---|---|---|
| 第一层：全局工作篮 Transfer Tray | 临时收集、整理、批量传递内容 | `src/components/transfer/`、`src/store/useTransferStore.ts` |
| 第二层：跨 Tab Integration Layer | 模块注册、上下文识别、动作分发、实体关联、跨模块通信 | `src/lib/crossTab/`、`src-tauri/src/transfer/` |
| 第三层：智能上下文 Context Layer | 识别当前项目/任务/目录/条目，给出可解释的目标建议 | `src/lib/crossTab/contextResolver.ts`、`src-tauri/src/transfer/context.rs` |

三层职责**严格分离**：

- 工作篮组件不写业务规则，只渲染 store 与调用服务；
- 各 Tab 不互相 import 业务方法，只通过 `ActionRegistry` / `EntityLinkService` /
  `IntegrationEventBus` 交互；
- 智能推荐只排序和解释，**永不自动执行**。

## 2. 文档索引

| 文档 | 内容 |
|---|---|
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | 产品定位、工作篮与剪贴板的边界、交互规范 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层、复用映射（现有服务 → 本系统职责）、模块注册 |
| [DATA_MODEL.md](DATA_MODEL.md) | 表结构、实体关系、生命周期、迁移与回滚 |
| [API_SPEC.md](API_SPEC.md) | Rust 命令、前端服务方法、入参/出参/错误码 |
| [UI_SPEC.md](UI_SPEC.md) | 右侧面板结构、响应式规则、拖拽与菜单规范 |
| [MODULE_MATRIX.md](MODULE_MATRIX.md) | 各 Tab 的接入能力与实现状态 |
| [SECURITY.md](SECURITY.md) | 路径安全、文件操作保护、数据最小化 |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 阶段划分与当前进度 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收标准、测试命令与证据要求 |

## 3. 关键设计决策（先读这里）

### D1. 工作篮不新建一套文件操作，也不新建剪贴板监听

- 文件写入/复制/移动一律走既有 **FileOperationService**（`src-tauri/src/fsops/`）：
  受控队列（2 个 worker）、有界排队（32）、逐条结果、部分成功、取消。本系统只新增
  `write` 任务类型（生成文本/图片文件），不新增调度器。
- 剪贴板历史一律走既有 `clipboard_*` 命令；工作篮只保存**引用**（`clipboardItemId`），
  不复制图片字节、不重复监听系统剪贴板。
- 已经存在的暂存架（shelf）保留为「长期暂存/归档架」；工作篮是「当前这一批要送走的
  临时篮」。两者数据独立、互不复制，但通过 `ActionRegistry` 可互相投递。

### D2. 数据模型：引用优先，内容分级存储

- 业务实体（任务/项目/规划/知识/采集）只存 `type + sourceId`，不复制业务正文；
- 图片只存剪贴板条目 id + 尺寸，不存 Base64；
- 文本 ≤ 64KB 内联在 `transfer_items.content`，超过则入 `transfer_contents` 表；
- 去重键 `dedupe_key` 由「类型 + 稳定来源 + 内容哈希/长度」计算，部分唯一索引
  （仅对未发送状态生效），发送后可再次加入同一内容。

### D3. 两种「关系」不混用

- **关系**（持久）：`reference`（引用）、`attachment`（附件）、`parent`（父子）、
  `derived`（派生）。写入 `entity_links`。
- **操作**（一次性）：`copy` / `move` / `write`。写入 `transfer_batches`，不是关系。
- 已有归属的关系**不重复建表**：知识↔任务/项目走 `knowledge_links`；暂存架↔任务/项目走
  `shelf_*_links`；项目↔任务走 `workspace_task_links`。`EntityLinkService` 是这些表的
  统一读写门面，只有没有归属的配对（如 规划↔任务）才落到通用 `entity_links`。

### D4. 目标识别与执行分离

`ContextResolver` 只回答「当前可能往哪里发」，`TransferService.executeTransfer`
才真正落盘/建实体。任何自动推荐都必须经用户确认（`TransferConfirmDialog`）。

### D5. 面板状态分级持久化

| 状态 | 存储 | 生命周期 |
|---|---|---|
| 显示/固定/宽度 | `localStorage` 键 `taskdock.transfer.panel.v1`（两份窗口共享） | 跨窗口、跨重启 |
| 上次页签/筛选 | 组件内 state | 页面内（尚未持久化） |
| 当前目录/项目/任务上下文 | Rust 内存态 `TransferContext` + 事件广播 | 跨窗口、进程内 |
| 选中项、滚动位置、搜索词 | 组件内 state | 页面内 |

> 2026-11-19 实现差异：后端已登记 `transfer_tray_state` 设置键，但
> `db::Settings` 与前端 `Settings` 均未扩字段，本轮面板状态改用 `localStorage`；
> 后续迁移到设置表时需同时补两端字段与迁移测试。

## 4. 代码地图

```
src/lib/crossTab/
  types.ts             # 全部数据契约（与 Rust serde 字段一一对应）
  transferClient.ts    # 工作篮命令封装（列表/预览/执行/重试/撤销/上下文）
  eventBus.ts          # Tauri 事件分发与模块级退订
  actionRegistry.ts    # 全局动作注册/查询/校验/执行（内置动作尚未注册）
  contextResolver.ts   # 上下文读写与展示标签
  panelState.ts        # 面板状态规范化、localStorage 持久化、跨窗口同步
  modules/clipboard.ts # 剪贴板条目 → TransferItemInput 映射（只读既有历史）
src/store/
  useTransferStore.ts  # 工作篮列表/选择/批次轮询/面板状态
src/components/transfer/
  TransferPanel.tsx    # 右侧工作篮面板（工作篮 / 剪贴板两个页签 + 内嵌预览对话框）
  TransferDrawer.tsx   # 主窗口与窄工作台抽屉
  transfer.css

> 尚未创建：`entityLinks.ts`、`targets.ts`、`useCrossTabStore.ts`、
> `TransferItemRow.tsx`、`TransferPreviewDialog.tsx`、`SendToMenu.tsx`、`TargetPicker.tsx`。
> 关联能力目前只有后端 `entity_link_*` 命令，前端接口未封装。
src-tauri/src/transfer/
  mod.rs               # 模型、SQL、生命周期
  store.rs             # transfer_items CRUD + 去重 + 内容分级存储
  batches.rs           # 批次记录、逐条结果、重试、撤销
  context.rs           # 跨窗口上下文（内存态 + 事件）
  links.rs             # 通用实体关联
  execute.rs           # 目标=文件工作区 的预览与执行编排
  tests.rs
src-tauri/src/commands/transfer.rs
```

## 5. 如何新增一个 Tab 接入

1. 在 `src/lib/crossTab/types.ts` 增加该模块的 `TransferSourceModule` / 目标类型（若需要）；
2. 新建 `src/lib/crossTab/modules/<module>.ts`，导出 `register<Module>Module()`：
   - 用 `actionRegistry.registerAction` 声明它能做什么（含支持的内容类型、权限、是否需要确认）；
   - handler 内只调用该模块**既有**的 bridge 方法；
3. 在 `installCrossTabModules()` 里登记（唯一装配点）；
4. 在 `MODULE_MATRIX.md` 补一行（能力、状态、限制）；
5. 补 `*.test.ts`：动作可见性、不可执行原因、handler 调用参数；
6. 若要支持拖拽，按 [UI_SPEC.md](UI_SPEC.md) §6 的载荷协议投递。

**禁止**：在适配器里复制文件、直接访问 SQLite、直接调用其他模块组件、绕过
`ActionRegistry` 往菜单里硬编码条目。
