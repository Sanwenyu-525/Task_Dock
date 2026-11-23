# 01 · 当前真实数据流与明文盘点

| 项目 | 内容 |
|---|---|
| 状态 | 第一阶段调查结论（仅文档，未改代码） |
| 日期 | 2026-11-23 |
| 调查范围 | `src-tauri/src/clipboard/`、`src-tauri/src/db/`、`src-tauri/src/secure_vault/`、剪贴板设置页、备份/恢复、数据目录初始化 |
| 依据 | 源码逐文件核对；证据行号见各条目 |

> 边界：本文件只描述 **2026-11-23 当前代码事实**。上一轮已完成的「保险箱锁定时剪贴板指纹清除、Session Generation、`Zeroizing<String>`」不在本次重复开发范围。

## 1. 数据目录与文件布局

数据目录解析（`lib.rs`）：

- 优先环境变量 `TASK_DOCK_DATA_DIR`（测试/便携隔离）；否则 Tauri `app_data_dir()`（Windows 下为 `%APPDATA%\com.taskdock.desktop` 一类按应用身份隔离的目录）。
- 建目录：`create_dir_all`，失败仅 `ok()` 吞掉（`lib.rs` 数据目录初始化段）。

当前剪贴板相关落盘位置（相对 `data_dir`）：

| 路径 | 内容 | 是否含敏感原文 |
|---|---|---|
| `task-dock.db` | SQLite 主库（WAL 模式） | 是：剪贴板正文/HTML/预览/来源 |
| `task-dock.db-wal` | WAL 日志 | 是：未 checkpoint 的正文以明文页存在 |
| `task-dock.db-shm` | WAL 共享内存索引 | 一般不含正文，但随库删除/迁移一并处置 |
| `clipboard/images/<item_id>.png` | 图片原图（采集 PNG 字节落盘） | 是：截图/图片原文 |
| `clipboard/thumbs/<item_id>.png` | 192px 缩略图 | 是（派生自原图，可能含可读文字/人脸） |
| `clipboard/thumbs/<item_id>-preview-640.png` | 640px 预览缓存（**不写 `clipboard_assets`**） | 是（派生图） |
| `clipboard-exports/<uuid>/clipboard.md` | Agent 本地导出正文 | 是：明文 Markdown |
| `clipboard-exports/<uuid>/<nnn>-image.png` | 导出图片 | 是：明文 PNG |
| `clipboard-exports/<uuid>/manifest.json` | 导出元数据（无正文） | 元数据 |
| 系统临时目录 `td-clip-<uuid>` / `td-agent-<uuid>` 等 | 个别临时文件/测试夹具 | 需排查（见 §6） |

## 2. 数据库字段明文盘点

### 2.1 `clipboard_items`（`db/mod.rs` v7 + v15/v16 增量）

| 列 | 明文等级 | 说明 |
|---|---|---|
| `text` | **明文敏感** | 纯文本正文（≤512 KB），密码/令牌/邮件/地址/会议纪要等均在此列 |
| `html` | **明文敏感** | 消毒后的 HTML 片段（`sanitize_html` 去主动内容，但文本仍在） |
| `preview` | **明文敏感** | ≤220 字符预览，是正文截断，仍可能携带凭据片段 |
| `title` | 半明文 | 用户可手动编辑；自动生成标题取自正文 |
| `file_paths` | 半明文 | JSON 路径数组；路径本身可能含用户名/项目名等隐私 |
| `source_app` / `source_title` | 元数据（隐私） | 窗口标题常含文件名/客户名；不是密钥但属隐私 |
| `source_kind` | 非敏感 | 识别方式枚举 |
| `content_hash` | 非敏感 | SHA-256；**注意：哈希本身可用于离线爆破弱口令/短令牌** |
| `kind` / `byte_size` / `image_width` / `image_height` | 非敏感 | 类型与尺寸元数据 |
| `favorite` / `pinned` / `copy_count` / `created_at` / `last_seen_at` | 非敏感 | 状态与时间 |
| `title_source` | 非敏感 | 枚举 |

### 2.2 `clipboard_assets`（元数据，二进制不入库）

| 列 | 明文等级 | 说明 |
|---|---|---|
| `path` | 非敏感 | 相对路径（`images/...` / `thumbs/...`），不含正文 |
| `role` / `byte_size` / `width` / `height` / `created_at` | 非敏感 | 资产元数据 |
| 图片二进制 | **明文敏感（在文件系统，不在库内）** | 见 §1 |

### 2.3 其余剪贴板表

| 表 | 是否含正文 | 说明 |
|---|---|---|
| `clipboard_groups` | 否（`name` 可能来自自动生成的截图描述，属低敏元数据） | 分组元数据 |
| `clipboard_group_items` | 否 | 组内顺序关系 |
| `clipboard_task_links` | 否 | 任务/条目关联，`target_id` 是 UUID |
| `clipboard_paste_jobs` / `clipboard_paste_items` | 部分含文本 | `message`、`remaining_items`、`uncertain_items` 为 JSON/文本；粘贴审计原则上不记正文，但需在加密改造时逐列复核 |
| `clipboard_snapshot_links` | 否 | 现场快照关联 |

### 2.4 设置项（`application_settings`）

- 采集开关、暂停、图片/文件/HTML 采集、保留天数、最大条数、资产容量、排除名单、粘贴间隔、敏感过滤开关、OCR 开关等均为**配置明文**（非密钥）。
- `clipboard_config_corrupt_backup` 是损坏配置的原始值备份 JSON：可能回含被损坏的配置文本，需纳入敏感处置复核。

## 3. 图片采集与派生链路

`clipboard/image.rs`、`store.rs`：

1. 采集：DIB/DIBV5/PNG → 解码 RGBA（内存）。
2. 原图：`images/<item_id>.png`，写临时文件 `*.png.tmp` 后 `rename` 原子替换（`store.rs` 写入段）。
3. 缩略图：192px 区域平均缩放 → `thumbs/<item_id>.png`。
4. 预览缓存：640px → `thumbs/<id>-preview-640.png`，仅缓存，不登记 `clipboard_assets`；`purge_orphan_files` 只按 `clipboard_assets.path` 反查，**预览缓存不在引用集合内**（由缓存自身失效/重生成处理）。
5. 解码上限：64 MB 原始字节、20 000px 边长、1 亿像素（`mod.rs` 常量）。

**现状结论：图片原图、缩略图、预览缓存均为未加密 PNG 文件**；没有内容级敏感识别（无 OCR 自动入史、无图像分类），截图中的密码/人脸/证件照随原图落盘。

## 4. WAL / SHM / 临时文件中的敏感内容

- 模式：`configure_writer` 设置 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5s`（`db/mod.rs`）。未见到显式 `wal_checkpoint(TRUNCATE/PASSIVE)` 策略；`wal_autocheckpoint` 取库默认值（诊断段可读 `wal_autocheckpoint_pages`）。
- **WAL**：写入未 checkpoint 前，`text/html/preview` 的明文页驻留 `-wal`；回滚段、旧版本记录同样可能在 WAL 内。删除条目不会立即从 WAL 擦除明文。
- **SHM**：索引与共享内存映射，一般不存业务正文；但处置时随主库一并保护，避免被单独拷贝分析。
- **临时文件**：
  - 资产写入 `*.png.tmp` 与预览缓存 `.tmp`：失败路径已尝试删除；崩溃中断可能残留明文临时文件。
  - 备份写入先落 `.{uuid}.tmp-<n>` 再 `commit_file` 原子替换（`backup.rs`）；恢复读取把行数据落到 `staging_dir/rows/*.jsonl`、资产/归档落到 staging 目录——**staging 阶段是明文**，恢复完成后由会话清理。
  - 系统 `temp_dir()` 下的 `td-clip-*` / `td-agent-*` 路径需在实施阶段逐一核对生命周期（测试夹具除外）。

## 5. 备份与恢复覆盖范围

### 5.1 备份 bundle（`commands/backup.rs`）

- `EXTENDED_TABLES` 登记并导出：`clipboard_items`、`clipboard_assets`、`clipboard_groups`、`clipboard_group_items`、`clipboard_task_links`、`clipboard_paste_jobs`、`clipboard_paste_items`、`clipboard_snapshot_links`。
- 图片资产：`StagedAsset` 按 `clipboard_assets.path` 读取 `clipboard/` 下文件，base64 分块（512 KB/块）写入 bundle；完整备份全量，快速备份按收藏/置顶 + 最近 N 条裁剪（`QUICK_CLIPBOARD_ITEM_LIMIT=2000`、`QUICK_CLIPBOARD_PASTE_LIMIT=500`）。
- **现状：bundle 内的正文文本、HTML、预览与图片资产都是明文**（JSON 行 + base64 PNG）；bundle 本身只有 SHA-256 完整性校验，无加密。
- 设置项：`clipboard_enabled`、`clipboard_paused` 列入 `LOCAL_PRIVACY_SETTINGS`，备份可存但恢复时不写回本机；其余剪贴板配置随备份迁移。
- 快速备份对剪贴板历史做裁剪，不代表完整隐私清理。

### 5.2 恢复（`commands/restore.rs`）

- 先校验 bundle 完整性/结构/引用；恢复前自动备份当前数据；单事务替换数据库；资产按计划从 staging 落回 `clipboard/`、`shelf/`、`voice/`、`collab-assets/`。
- `restore/journal.json` 与会话目录支持中断恢复；资产落盘前 `safe_asset_rel` 防路径穿越。
- **现状：恢复流程假定 bundle 与本机库同加密等级；一旦库内文本/资产加密，备份与导入链路必须同步改造（见方案文档 §迁移/备份恢复）。**

## 6. 清理与资产联动现状

- 单条删除：`delete_items` → 删库行（FK CASCADE 删 `clipboard_assets` 行）→ `remove_files_unreferenced` 清理文件。
- 清空历史 / 过期清理：按保留天数、最大条数、资产容量淘汰；`purge_orphan_files` 扫描 `images/`、`thumbs/`，删除 `clipboard_assets` 未引用的普通文件；IO 失败计数保留，下次重试。
- 预览缓存（`-preview-640.png`）不进资产表，依赖缓存失效与重生成，**孤儿回收范围不覆盖它**，需在加密/清理方案中明确。
- OCR 缓存随条目/分组/清空失效（`04-monitor-security.md` §九）。
- 现有删除是文件 `remove_file`，**未做覆写/擦除**；SSD/回收场景下明文残留不在本方案默认范围内，需作为已知限制记录。

## 7. Agent 导出与额外暴露路径

### 7.1 剪贴板 → Agent 本地导出包（`clipboard/agent_bridge.rs`）

- `export_package` 按条目或分组生成 `clipboard-exports/<uuid>/`：`clipboard.md`（正文/HTML/URL/文件路径/任务描述）、原图 PNG、`manifest.json`。
- 文案声明「仅保存在本机；不自动上传或发送」；导出目录独占创建，写失败由 `ExportDirGuard` Drop 清理半成品。
- **现状（批次 5a/5b 更新）**：
  - 能力矩阵区分 `direct_send / file_import / desktop_paste / export` 与证据等级；导出仍由本机 UI 显式触发，**尚无 `agent_access` 能力白名单/逐次授权**。
  - 导出成功/失败/手动清理已写 `security_audit_log`（`category=clipboard`），明细不含目录、文件名或正文。
  - 导出包含关联任务的 `title`/`description`（`task_context`），属于跨模块数据带出。
  - 导出目录仍长期保留明文，现由设置页按保留天数手动清理（默认 7 天，需确认）；无自动过期策略。

### 7.2 其他可能带出剪贴板数据的路径（实施阶段逐一核对）

- 全局搜索 / 上下文装配：是否检索 `clipboard_items.text/preview` 并经 Agent 能力读取。
- MCP / Agent 能力白名单：`agent_access` 能力枚举中是否存在读取剪贴板历史的通道。
- 手机同步 / 跨端：`sync_changes`、`mobile_files` 属本机瞬时状态不进备份；需确认剪贴板正文不进入同步载荷。
- 诊断日志 / 崩溃转储：现有原则是不记正文；加密改造后需复核内存转储与诊断层不回含明文。

## 8. 不同 Windows 用户之间的隔离现状

- 数据目录按 Tauri `app_data_dir()` 解析到当前用户 `%APPDATA%`；ACL 继承用户目录权限。**代码内未对 `data_dir`、`clipboard/`、`clipboard-exports/` 显式设置受限 ACL**（未发现 `SetNamedSecurityInfo`/显式 DACL 调用）。
- DPAPI 既有封装（`personal_hub/crypto/dpapi.rs`）仅当前用户作用域，不传 `CRYPTPROTECT_LOCAL_MACHINE`，带应用固定 entropy，`CRYPTPROTECT_UI_FORBIDDEN` 失败即 fail-closed；可作为剪贴板密钥保护的参考实现，但其 entropy 与错误类型属 Personal Hub 用途，**不得直接复用其常量**。
- 风险：同机另一管理员用户若能读取该用户 `%APPDATA%`（或磁盘镜像/卷影副本/备份盘），当前明文库与图片可被直接读取；现有模型只依赖目录位置隔离，没有密码学边界。

## 9. 现有敏感内容过滤能力与边界

`engine.rs`：

- `sensitive_reason`（高置信，与来源无关，始终开启）：PEM 私钥头、AWS `AKIA...`、GitHub `gh[pousr]_...`、Slack `xox[baprs]-...`。
- `conservative_sensitive_reason`（仅来源未知时启用）：凭据赋值（`password/secret/token/api_key/...=`）、`Authorization: Bearer/Basic`、JSON 凭据字段。
- 系统/应用隐私标记：`ExcludeClipboardContentFromMonitorProcessing`、`Clipboard Viewer Ignore`、`CanIncludeInClipboardHistory=0`。
- **明确局限（现状文档已声明）**：固定模式不可能识别全部密码、验证码、银行卡号、自定义令牌；图片内容无识别；排除名单只覆盖可推断来源的应用。方案中隐私文案必须延续这一口径，不得宣传为绝对安全。

## 10. 现状缺口小结（供后续方案引用）

1. 库内正文/HTML/预览、图片原图/缩略图/预览缓存均为静态明文。
2. WAL 未做面向隐私的 checkpoint/擦除策略；删除条目后明文可能滞留 WAL。
3. 备份 bundle 明文携带剪贴板正文与图片；无备份加密层。
4. Agent 导出包为明文目录，授权粒度、过期清理、审计待复核。
5. 目录隔离依赖 Windows 用户目录 ACL，缺少密码学保护；跨用户/磁盘镜像场景无边界。
6. 图片采集无内容级敏感识别；OCR 文本不自动入史（现状）。
7. 预览缓存、导出目录、staging 临时文件、配置损坏备份的明文处置未纳入统一生命周期。
