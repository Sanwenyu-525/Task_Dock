# 生活效率系统 v1（Life Efficiency）

> 状态：第一阶段工程修复完成（2026-11-22）。本文是**当前规范**；实际执行过的命令、退出码与结论见
> [验收报告](acceptance/life-efficiency-v1/report.md) 与 [测试结果](acceptance/life-efficiency-v1/test-results.md)。
> 未完成项与风险以验收报告的「剩余风险」为准，不以本文替代验收结论。

## 1. 范围

第一阶段只覆盖四个真实闭环：购买记录与历史、生活待办（复用任务系统）、生活票据引用与关联、
桌面/移动生活页、入口显隐排序、全局搜索、双端同步、备份恢复。

明确不在本阶段：购物清单、OCR 自动识别、保修/物品管理、AI 自然语言理解、记账/库存/家庭成员/
消费分析、复杂图表、商家比价、在线购物、社交、新 Agent 框架或新的跨设备连接协议。

## 2. 数据模型与迁移

桌面迁移 `MIGRATION_65`（四表/索引/12 个同步触发器）+ `MIGRATION_66`（票据远端引用两列）+
`MIGRATION_67`（`life_event_items.amount_scale`）；移动端 `MIGRATION_10` + `MIGRATION_11` +
`MIGRATION_12`（`amount_scale` + `life_sync_deferred`）。所有迁移只追加，历史版本不修改。

### `life_items`

长期查询的商品/物品身份。字段：`id`、`name`、`normalized_name`、`category`、`aliases`（JSON）、
`note`、`created_at`、`updated_at`、`deleted_at`、`rev`、`server_rev`。

`normalized_name` 由共享规则生成（全角转半角、空白折叠、首尾常见句读剥离、英文小写）。相似但
不同的名称不自动合并；别名由用户维护。Rust `normalize_name` 与 TS `normalizeLifeName` 读取同一份
[契约向量](life/life-contract-vectors.json)。

### `life_events`

实际发生的生活事件。字段：`id`、`event_type`、`title`、`description`、`occurred_at`、`merchant`、
`source`、`created_at`、`updated_at`、`deleted_at`、`rev`、`server_rev`。

- `event_type`：`purchase` / `maintenance` / `general`。
- `source`：`manual` / `capture`。
- `occurred_at` 是实际发生日期，不取 `created_at`；补录历史必须保留真实日期。

### `life_event_items`

一次事件涉及的明细。字段：`id`、`event_id`、`item_id`、`item_name_snapshot`、`quantity_value`、
`quantity_unit`、`unit_price_minor`、`total_price_minor`、`currency`、`amount_scale`、`note`、
`created_at`、`updated_at`、`rev`、`server_rev`。

#### `amount_scale` 数据契约

- 金额以最小货币单位整数（`*_minor`）存储和累计，禁止浮点累计；
- `amount_scale` 是该**行**金额的小数位：旧数据默认 2，按原两位解释，绝不重算历史金额含义；
  新写入按货币 ISO 精度（CNY/USD=2、JPY=0、KWD=3）；编辑历史行允许沿用更细的旧精度
  （如旧 JPY 行 scale=2），但**不得低于**货币 ISO 精度；
- 展示、编辑回显、多币种汇总都使用行自己的 `amount_scale`；不同货币绝不直接相加；
- 金额与数量的解析规则事实源：`docs/life/life-contract-vectors.json`。Rust 与 TypeScript
  测试读取同一份数据，任何一端单独放宽/收紧都会失败。
  - 金额：只接受 ASCII 数字与至多一个小数点；必须有整数位、小数点后必须有数字；
    拒绝负号、显式正号、千分位、空格、科学计数法；小数位不超过行精度；
    结果不超过 `MAX_AMOUNT_MINOR = 1_000_000_000_000`；
  - 数量：同样的书写规则，最多 3 位小数、整数部分最多 12 位，**购买数量必须大于 0**；
    同步复制（既有记录）仍接受历史值 `0`，避免旧数据卡住同步队列。

### `life_document_links`

票据/文件与生活事件的关联。字段：`id`、`owner_type`、`owner_id`、`document_ref`、`document_source`、
`document_name`、`mime`、`byte_size`、`remote_ref`、`remote_source`、`transfer_state`、`created_at`、
`updated_at`、`deleted_at`、`rev`、`server_rev`。

- `document_source`：`capture_asset`（手机采集素材）/ `shelf_item`（暂存架条目）/ `attachment` /
  `file`（本机绝对路径）。
- `document_ref` 保留**本机来源** ID；原图传到桌面后不覆盖它。
- `remote_ref`/`remote_source` 记录桌面实际收到原图后的稳定引用，两者必须一起判断：
  - `remote_source = shelf_item`：原图已导入桌面暂存架，`remote_ref` 是暂存架条目 ID，可预览；
  - `remote_source = file`：文件已到电脑（文件互传接收目录），`remote_ref` 是传输记录 ID，
    **尚未导入暂存架**。界面显示「已到电脑 · 待导入」，只能定位文件，不显示为“原图尚未传输”；
  - 两者都为 null：原图还在另一台设备，界面显示「仅元数据同步」。
- `transfer_state`：`local` / `metadata_only` / `transferred` / `missing`。
  `transferred` 必须带有效 `remote_ref`；创建入口不接受裸 `transferred`（无法提供远端引用）。
- 创建关联按 `owner_type + owner_id + document_ref + document_source` 幂等，重复请求返回已有行 ID、
  不创建副本；owner 必须存在且未软删；`shelf_item` 引用必须真实存在；`byte_size` 不得为负。
- 关联只引用稳定 ID，不复制图片字节；删除关联只写 `deleted_at`，多次删除幂等，原文件不删除。

## 3. 桌面端

- 页面：`src/components/life/LifePanel.tsx`，挂载在唯一 `WorkbenchShell` 的 `life` RouteSlot；不新建窗口系统。
- 详情状态：`DetailState` 把实体、数据、关联票据、定位焦点作为一个整体；切换实体立即清空旧数据，
  独立 `requestSeq` 使旧请求（成功或失败）无法覆盖/关闭新详情。事件详情的票据 = 事件级关联 +
  事件内商品的**商品级**关联（后端 SQL 一次查询合并）；商品详情的「关联票据」只显示商品级关联，
  某次购买的小票显示在该购买历史行内，两者不得混拼。
- 全局搜索：`life` 分类覆盖商品、事件与票据。票据结果的 `target_id` 是 owner_id、`parent_id` 是
  `life_document_links.id`；定位时用 `parentId` 调 `life_document_link_get` 明确 `owner_type`，
  再打开对应详情并高亮该票据；没有关联 id 或关联已解除时明确报错，不做 try/catch 猜 owner。
- 主题/响应式：复用语义 Token 与 `life-ui.css` 容器查询；窄窗单列、宽窗分栏。
- 命令：`src-tauri/src/commands/life.rs` 暴露 item/event/history/detail/update/delete/link/list/get
  命令，前端经 `src/lib/lifeBridge.ts` 调用，不直接访问数据库。
- 备份：`backup.rs` 的 `BACKUP_TABLES` 包含四张 life 表；恢复后校验商品、购买日期与关联一致性。

## 4. 移动端

- 页面：`apps/mobile/src/screens/LifeScreen.tsx`；入口走 `entryRegistry`。
- 快速记录：首页输入商品名称即可保存；填写金额但未选货币时拒绝保存。
- 历史：搜索优先展示最近购买，按 `occurred_at` 倒序；同日使用稳定次级键。
- 待办：复用 `TaskEditorSheet` / `tasks` 表，保存时 `category = 生活`；提醒复用现有调度器。
  列表通过 `listTasks({ category, limit })` 在 SQLite 层过滤、排序、限量（上限 60），不再全表读取后
  JS 过滤；未传选项的其它调用方行为不变。已完成任务可在页内展开查看并用同一个 `toggleTask` 恢复，
  不复制任务操作逻辑。
- 票据：复用 `features/capture` 拍照/扫描/导入；票据只存稳定 ID 引用，原图预览复用 `ImageLightbox`。
- 发送原图：复用现有配对、TLS、文件互传与暂存架导入；成功写 `remote_ref` 并标记 `transferred`，
  失败保留本地文件可重试，旧桌面不支持导入时明确提示并降级 `metadata_only`。
- 详情请求代际：列表刷新与详情各自持有 `RequestGeneration`，旧响应（成功、失败、finally）不得写新状态。

## 5. 同步

同步实体：`life_item`、`life_event`、`life_event_item`、`life_document_link`，复用既有 outbox/pull/push，
不新建第二套同步通道。

- **元数据同步**与**原图传输**是两条独立数据通道：票据关联行（含 `remote_ref`/`remote_source`）走
  outbox 同步；图片字节走文件互传 + 暂存架导入。只同步成功不等于原图已到电脑。
- ID 稳定；重复 pull 用 `id` 主键与 `server_rev` 幂等落库；删除使用 `deleted_at` 墓碑。
- 冲突沿既有 `rev/server_rev` 机制，不静默覆盖；关联实体按 item → event → event_item → document_link
  顺序应用。
- 旧客户端遇到未知实体忽略而不是让整个同步失败；协议仍按 `SYNC_ENTITIES` 白名单。
- 复制路径与用户输入路径是两套明确规则：输入拒绝数量 0，复制接受历史 0（`canonical_quantity_for_sync`），
  两者都拒绝千分位/科学计数法等非法格式。

## 6. 关键不变量

1. 购买历史按 `occurred_at` 排序，补录不会变成“最近购买”。
2. 金额只以最小货币单位整数累计；书写规则由双端共享向量固定。
3. 商品改名不回写历史快照；相似名称不自动合并。
4. 生活待办不复制任务表；生活页在 SQL 层按既有任务 ID/分类读取。
5. 票据关联删除 ≠ 原图删除；原图缺失必须显示明确状态。
6. 生活入口隐藏不删除数据；恢复后数据仍在。
7. 没有真实记录时显示“尚无购买记录”，不展示示例数据，不伪造 OCR 结果。
8. 详情切换时旧实体的数据与票据立即失效；任何在途旧请求都不得写回新详情。

## 7. 实现/验证状态与遗留问题

| 项 | 状态 |
|---|---|
| 四张 life 表、迁移 65/66/67 与移动端 10/11/12 | 已实现、已测试（迁移与列存在性用例） |
| 金额/数量/名称跨端契约向量 | 已实现、已测试（Rust + TS 读取同一 JSON） |
| 票据关联幂等、owner/来源/大小/状态校验、软删幂等 | 已实现、已测试（Rust 定向用例） |
| 桌面详情状态隔离、票据定位、状态徽标 | 已实现、已测试（LifePanel 16 项） |
| 生活待办 SQL 过滤与已完成恢复 | 已实现、已测试（移动端数据层用例）；页面交互未做 RN 端到端渲染测试 |
| 双端同步协议、文件互传两条通道 | 已实现、已测试（同步可靠性 14 项、票据传输 3 项，Rust 同步兼容 1 项） |
| Release 安装包、升级/卸载、真实双设备同步 | **未验证**（本次为 Dev/单测范围，未出正式包） |
| 全局搜索结果未直接携带 `owner_type` | **技术债**：目前靠 `parentId` 回读单条关联（多一次 IPC），后续可在搜索结果里补字段 |

详细命令与退出码见验收目录；未执行的项目不写“通过”。
