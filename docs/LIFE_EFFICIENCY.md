# 生活效率系统 v1（Life Efficiency）

> 状态：第一阶段开发中（2026-11-16）。本文描述已落地的数据契约、模块边界与验收口径；
> 未完成项以 `tmp/acceptance/life-efficiency-v1/report.md` 为准，不以本文替代验收结论。

## 1. 范围

第一阶段只覆盖四个真实闭环：购买记录与历史、生活待办（复用任务系统）、生活票据引用与关联、
桌面/移动生活页、入口显隐排序、全局搜索、双端同步、备份恢复。

明确不在本阶段：购物清单、OCR 自动识别、保修/物品管理、AI 自然语言理解、记账/库存/家庭成员/
消费分析、复杂图表、商家比价、在线购物、社交、新 Agent 框架或新的跨设备连接协议。

## 2. 数据模型

桌面迁移 `MIGRATION_65`（四表/索引/12 个同步触发器）+ `MIGRATION_66`（票据远端引用两列）；
移动端 `MIGRATION_10` + `MIGRATION_11`。旧迁移只追加，不修改已发布版本。

### `life_items`

长期查询的商品/物品身份。字段：`id`、`name`、`normalized_name`、`category`、`aliases`（JSON）、
`note`、`created_at`、`updated_at`、`deleted_at`、`rev`、`server_rev`。

`normalized_name` 由共享规则生成（全角转半角、去首尾空白、连续空白折叠、英文小写、去句末
中文/英文句号）。相似但不同的名称不自动合并；别名由用户维护。

### `life_events`

实际发生的生活事件。字段：`id`、`event_type`、`title`、`description`、`occurred_at`、`merchant`、
`source`、`created_at`、`updated_at`、`deleted_at`、`rev`、`server_rev`。

- `event_type`：`purchase` / `maintenance` / `general`。
- `source`：`manual` / `capture`。
- `occurred_at` 是实际发生日期，不取 `created_at`；补录历史必须保留真实日期。

### `life_event_items`

一次事件涉及的明细。字段：`id`、`event_id`、`item_id`、`item_name_snapshot`、`quantity_value`、
`quantity_unit`、`unit_price_minor`、`total_price_minor`、`currency`、`note`、`created_at`、
`updated_at`、`rev`、`server_rev`。

- 金额用最小货币单位整数（分）存储和累计，禁止浮点累计。
- `quantity_value` 是规范十进制字符串，支持小数（最多 3 位、去尾零）。
- `item_name_snapshot` 保留购买时的名称，改名不重写历史。

### `life_document_links`

票据/文件与生活事件的关联。字段：`id`、`owner_type`、`owner_id`、`document_ref`、`document_source`、
`document_name`、`mime`、`byte_size`、`remote_ref`、`remote_source`、`transfer_state`、`created_at`、
`updated_at`、`deleted_at`、`rev`、`server_rev`。

- `document_source`：`capture_asset` / `shelf_item` / `attachment` / `file`。
- `document_ref` 保留本机来源 ID；手机原图传到桌面后**不覆盖**它。
- `remote_ref`/`remote_source` 记录桌面实际收到原图的稳定引用（目前为暂存架条目），用于桌面预览。
- `transfer_state`：`local` / `metadata_only` / `transferred` / `missing`。元数据同步不等于图片已传输。
- 关联只引用稳定 ID，不复制图片字节；删除关联不删除原图；原图被删除时关联显示文件缺失。

## 3. 桌面端

- 页面：`src/components/life/LifePanel.tsx`，挂载在唯一 `WorkbenchShell` 的 `life` RouteSlot；不新建窗口系统。
- 主题/响应式：复用语义 Token 与 `life-ui.css` 容器查询；窄窗单列、宽窗分栏，按钮不压缩、正文不强截断。
- 导航：`navigationRegistry` 注册 `life`（`ShoppingBasket`，默认隐藏，可显示/隐藏/排序/恢复）。
- 命令：`src-tauri/src/commands/life.rs` 暴露 item/event/history/detail/update/delete/link/list 命令，前端经
  `src/lib/lifeBridge.ts` 调用，不直接访问数据库。
- 搜索：`src-tauri/src/global_search/mod.rs` 新增 `life` 分类，覆盖商品名称、事件标题、票据名称；结果带
  `target_id`/`parent_id`，软删除记录不返回；查询参数化并受统一 limit 约束。
- 备份：`backup.rs` 的 `BACKUP_TABLES` 包含四张 life 表；恢复后校验商品、实际购买日期与关联一致性。

## 4. 移动端

- 页面：`apps/mobile/src/screens/LifeScreen.tsx`；入口走 `entryRegistry`，支持显示/隐藏/排序。
- 快速记录：首页输入商品名称即可保存；日期默认当天；金额、数量、商家、备注等为选填；填写金额但未选
  货币时拒绝保存。
- 历史：搜索优先展示最近购买，按 `occurred_at` 倒序；同日使用稳定次级键。
- 待办：复用 `TaskEditorSheet`/`tasks` 表，保存时强制 `category = 生活`；提醒复用现有调度器。
- 票据：复用 `features/capture` 拍照/扫描/导入；保存为普通素材或生活票据；票据只存 `capture_asset`
  引用，原图预览复用 `ImageLightbox`。
- 发送原图：复用现有配对、TLS、文件互传与暂存架导入；成功写 `remote_ref` 并标记 `transferred`，
  失败保留本地文件可重试，旧桌面不支持导入时明确提示并降级 `metadata_only`。

## 5. 同步

同步实体：`life_item`、`life_event`、`life_event_item`、`life_document_link`，复用既有 outbox/pull/push，
不新建第二套同步通道。

- ID 稳定；重复 pull 用 `id` 主键与 `server_rev` 幂等落库，不产生副本。
- 删除使用 `deleted_at` 墓碑；墓碑继续同步，避免另一端旧数据“复活”。
- 冲突沿既有 `rev/server_rev` 机制，不静默覆盖；关联实体按 item → event → event_item → document_link
  顺序应用，外键不满足时跳过并在依赖到达后重放。
- 旧客户端遇到未知实体必须忽略而不是让整个同步失败；协议仍按 `SYNC_ENTITIES` 白名单。
- 票据元数据走同步，图片走文件互传；`remote_ref/remote_source` 仅在原图实际到达桌面后写入。

## 6. 关键不变量

1. 购买历史按 `occurred_at` 排序，补录不会变成“最近购买”。
2. 金额只以最小货币单位整数累计；数量允许多位小数。
3. 商品改名不回写历史快照；相似名称不自动合并。
4. 生活待办不复制任务表；生活页读取现有任务 ID。
5. 票据关联删除 ≠ 原图删除；原图缺失必须显示明确状态。
6. 生活入口隐藏不删除数据；恢复后数据仍在。
7. 没有真实记录时显示“尚无购买记录”，不展示示例数据，不伪造 OCR 结果。
