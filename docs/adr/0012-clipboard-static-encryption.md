# ADR-0012 剪贴板历史静态加密：DPAPI 封装随机 CEK + 独立备份加密层

| 项目 | 内容 |
|---|---|
| 状态 | Accepted（2026-11-23 用户授权实施；分批落地，见 §14 实施状态） |
| 日期 | 2026-11-23 |
| 决策类型 | 安全架构 / 数据模型 / 备份兼容 |
| 影响模块 | `clipboard/`、`db/`、`commands/backup.rs`、`commands/restore.rs`、`clipboard/agent_bridge.rs`、剪贴板设置页、`secure_vault/`（仅复用原语，不共享密钥） |
| 关联 | 威胁模型 `02-threat-model.md`；方案对比 `03-encryption-options.md`；迁移 `05-migration-plan.md`；备份恢复 `06-backup-recovery.md` |

## 1. 背景

TaskDock 剪贴板历史当前以 SQLite 明文保存正文/HTML/预览，图片原图、缩略图、预览缓存以明文 PNG 落盘；备份 bundle 明文携带正文与 base64 图片；Agent 导出包为明文目录。静态保护主要依赖 Windows 用户目录的默认 ACL，缺少密码学边界。现有敏感内容过滤基于固定正则与系统隐私标记，已在文档中声明不能识别全部凭据；图片无内容级识别。

上一轮已完成：保险箱锁定时剪贴板指纹清除、Session Generation、`Zeroizing<String>`。本 ADR 不重复这些工作。

## 2. 当前问题

1. 离线拷贝 `task-dock.db`、`clipboard/` 目录、备份 bundle 或导出目录即可读取全部历史。
2. WAL、临时文件、staging 目录可能滞留明文；删除条目不擦除旧页。
3. 备份/换机场景无独立加密层；明文 bundle 随网盘/移动介质扩散。
4. 跨 Windows 用户访问只依赖目录权限，无密钥边界。
5. 现有保险箱加密体系面向口令解锁记录，其 DEK/KEK 不适合直接作为剪贴板静默历史的保护根。

## 3. 决策

### 3.1 本机静态加密

- 为剪贴板生成**独立随机 256-bit CEK**（OsRng），与保险箱密钥体系完全隔离；不复用、不导出、不引用保险箱 DEK/KEK。
- CEK 由 **Windows DPAPI 当前用户作用域**封装（`CryptProtectData` / `CryptUnprotectData`，不传 `CRYPTPROTECT_LOCAL_MACHINE`，`CRYPTPROTECT_UI_FORBIDDEN`，应用固定 entropy，命名空间 `TaskDock.Clipboard.CEK.v1`）。
- 记录与资产使用 **AES-256-GCM** 加密：每条记录/每个资产独立 12B nonce；AAD 绑定记录类型、条目 UUID、版本，防止跨记录/跨类型密文搬运。
- 明文 CEK 只存在于受保护内存（`Zeroizing`），进程退出清零；信封内不含明文 CEK、不含 DPAPI 主密钥。

### 3.2 加密范围

- 加密：`text`、`html`、`preview`、`title`、`file_paths`、`source_app`、`source_title`；图片原图、缩略图、预览缓存文件级加密。
- 明文保留：`id`、`kind`、`content_hash`、`byte_size`、尺寸、时间戳、计数、收藏/置顶、分组与关联表、`source_kind` 枚举。
- 粘贴审计表 `clipboard_paste_jobs` / `clipboard_paste_items` 的列（`target_title`、`target_exe`、`message`、`error_message`、`remaining_items`、`uncertain_items`、序号、时间与标志）**不纳入字段加密**：逐列复核确认它们只记录粘贴操作元数据，不写入剪贴板正文；`remaining_items`/`uncertain_items` 只存条目 UUID，`message`/`error_message` 为固定状态文案、序号、错误码或数据库错误，不含正文。`target_title` 来自前台窗口标题，可能包含文档名/网页标题，属于已登记的残余风险；若未来要求连窗口标题一起隐藏，应作为独立字段迁移，不与正文加密混为一谈。
- 关联关系（任务链接、分组、快照链接）继续依赖 UUID 外键，加密改造不改主键与外键语义。

### 3.3 备份加密

- 备份使用**独立 BEK**，与本机 CEK 分离；bundle 头部标注格式版本、算法、KDF 参数、nonce 与校验信息。
- 本机备份可由 DPAPI 封装 BEK；跨设备恢复提供独立恢复口令（Argon2id 派生）或离线恢复密钥包，二选一在实施阶段定稿。
- 旧格式明文 bundle 可被读取，但导入时必须经一次性明文→密文迁移并提示用户；不允许把明文 bundle 内容直接写回加密库而不经过迁移路径。

### 3.4 隐私授权与局限口径

- 首次启动提供剪贴板历史采集明确授权；图片采集单独授权。
- 保留：暂停/恢复监听、关闭图片采集、清理全部历史、保留期、来源应用排除名单。
- UI 与帮助文案必须声明：敏感过滤是固定模式匹配，不保证识别全部密码/令牌/验证码/银行卡号；图片内容不做敏感识别；来源应用不是安全边界。

## 4. 备选方案

| 方案 | 结论 | 理由 |
|---|---|---|
| A. DPAPI 封装随机 CEK（采纳） | 基线 | 无口令负担、契合静默历史形态；跨用户密码学隔离；现有 `dpapi.rs` 模式可借鉴；备份层独立解决换机 |
| B. Windows Credential Manager 存 CEK | 拒绝 | 同用户边界内无额外壁垒；条目易被清理/漫游导致丢失；API 封装成本高、无先例 |
| C. 独立主口令 KEK | 本期拒绝，预留扩展 | 改变产品形态（每次解锁输口令），与保险箱口令叠加负担；未来可在信封增加 passphrase slot |
| D. 复用保险箱 DEK | 禁止 | 违反隔离要求；保险箱锁定/解锁语义与剪贴板历史生命周期不同；耦合会扩大故障域 |

## 5. 选择原因

1. 本期目标是补齐静态离线加密兜底，而非把剪贴板改造成口令保险库；方案 A 与现有后台采集形态一致。
2. DPAPI 用户作用域提供跨用户不可解的边界，弥补现状仅靠 ACL 的缺口；失败 fail-closed，后台不弹系统对话框。
3. 原语齐备：`aes-gcm 0.10`、`zeroize 1`、`sha2 0.10`、`base64 0.23`、`argon2 0.5`、`windows-sys` 的 `Win32_Security_Cryptography` 已在依赖中。
4. 信封结构预留多 slot 能力：未来叠加口令二次加密不需要重写数据格式。

## 6. 优点

- 离线拷库/拷目录/拿旧备份在无 DPAPI 上下文（跨用户）或无备份密钥（跨设备）时不可读。
- 不改变现有采集、去重、分组、粘贴、任务关联的业务语义；关联 UUID 与索引保留。
- 密钥材料随机生成，不依赖用户选择口令，避免弱口令风险。
- 与保险箱故障域隔离：保险箱锁定/重置不影响剪贴板可解性，反之亦然。

## 7. 缺点与已知风险

1. **DPAPI 绑定本机本用户**：换机、用户配置文件损坏、DPAPI 主密钥还原后，本机 CEK 可能不可解；只能依赖备份加密层恢复。
2. **不防同用户恶意进程**：运行时同用户进程可调用 DPAPI 解出 CEK、读取解密后内存；这是威胁模型外边界。
3. **不防物理残留**：SSD 磨损均衡、回收站、卷影副本、崩溃转储中的旧块不在应用层擦除范围。
4. **密文检索受限**：本期不做密文全文检索；搜索范围与性能需在实施阶段评估。
5. **缩略图/预览是派生图**：即使文件加密，降采样派生信息在解密后仍可能可读。
6. DPAPI 主密钥损坏时若无有效备份，历史不可恢复——必须在首次启用时引导用户保存恢复材料。

## 8. 密钥丢失风险与恢复方式

| 场景 | 本机 CEK 可解性 | 恢复路径 |
|---|---|---|
| 同机同用户正常运行 | 可解（DPAPI slot） | 无需用户操作 |
| 同机换 Windows 用户 | 不可解 | 本机历史不跨用户迁移；从备份包经恢复口令/恢复密钥恢复到新用户数据目录 |
| 换机/重装系统 | DPAPI slot 不可解 | 仅能从加密备份包 + 恢复口令/恢复密钥恢复；无备份材料则不可恢复 |
| DPAPI 主密钥损坏/密码被重置还原 | 本机 CEK 不可解 | 同上，依赖备份；首次启用时必须生成并提示保存恢复包 |
| 信封文件损坏/被篡改 | 解密封装失败，fail-closed | 从最近有效备份恢复；不回退到明文存储 |

恢复材料策略在 `06-backup-recovery.md` 定稿；原则：恢复密钥/口令只交用户保管，应用不上传、不云端托管。

## 9. 影响模块与公共契约

- **DB**：新增剪贴板密钥信封表（或信封文件）；敏感字段改为密文存储格式（版本 + nonce + 密文 base64）；迁移只在 `MIGRATIONS` 末尾追加，不改已发布迁移（遵循 ADR-0004）。
- **资产文件**：加密容器目录布局；文件头记录 nonce/长度/版本；读取路径按需解密。
- **备份/恢复**：bundle 格式版本位、加密标记、KDF 参数；恢复流程校验信封与格式版本。
- **Agent 导出**：导出动作纳入授权与审计；导出包格式与风险提示更新。
- **前端**：采集/图片授权入口、加密状态与恢复材料引导；不暴露密钥/信封内部细节。
- **IPC**：新增命令同步前端类型与 Rust 签名（遵循架构红线 §2）。

## 10. 迁移计划（摘要，详见 05）

1. 迁移前自动备份并校验可读；记录库版本、条目数、资产数、分组/关联计数。
2. 生成 CEK 与 DPAPI 信封；在副本/影子库中逐条加密字段、逐资产加密文件。
3. 校验：条目数/关联一致、抽样可解密往返、哨兵扫描无明文残留（库 + WAL + 资产目录）。
4. 校验通过后原子切换；原始明文数据保留到回滚观察期，确认无问题后按策略清理。
5. 中断可续跑；失败整体回滚到迁移前状态；未完成备份验证前不删除旧数据。

## 11. 测试要求（摘要，详见 07 测试矩阵）

- 明文哨兵扫描（库、WAL、SHM、资产目录、导出目录、staging）。
- 错误密钥/篡改信封解密失败；密钥丢失场景 fail-closed。
- 迁移中断续跑与回滚；备份往返加密/解密；不同用户隔离。
- 暂停监听、图片授权关闭、Agent 导出授权等隐私开关行为。
- 分组、任务链接、快照链接在加密往返后不丢失。

## 12. 回滚条件

- 迁移后条目/资产/关联计数不一致，或抽样往返解密失败。
- DPAPI 封装/解密在目标环境不可用且无法降级（本期不提供明文回退存储）。
- 备份包无法在干净环境恢复，或恢复后关联断裂。
- 出现 P0 数据丢失/泄露/核心不可用：停止推广，按迁移前备份回滚；保留现场与日志。

## 13. 未决项（实施授权后评审定稿）

1. 备份恢复 slot 采用恢复口令 Argon2id 还是离线恢复密钥包（或两者）。
   **已定（批次 4a）**：两者都要——口令 Argon2id + 一次性恢复密钥，任一 slot 可解出同一 BEK，见 §14。
2. 搜索是否保留有限明文索引（如仅 URL/标题片段），还是全部在解密结果集内过滤。
   **已定（批次 6）**：不保留明文索引；列表/分组搜索在解密后的结果集过滤，
   最多扫描最近/最常用 5000 条（见 §14 偏差 1）；全局搜索对剪贴板只解密标题/预览/来源/路径。
3. 资产加密是逐文件 GCM 封装还是目录级容器；预览缓存纳入哪一层。
4. 数据目录与剪贴板目录显式 ACL 加固的具体范围与测试方式。
   **已定（批次 9）**：protected DACL 仅当前用户 + Administrators；覆盖 `data_dir` 根、
   剪贴板/导出/备份/恢复/暂存架与 DB 文件；只递归已存在路径，junction 跳过；模块级单测 +
   独立 crate 验证，启动集成与真机行为列入 Dev 验收。

## 14. 实施状态（2026-11-23，批次 1–11）

代码：`src-tauri/src/clipboard/secure.rs`、`secure_migration.rs`、`store.rs` 读写接入、`db::Settings` 新增开关；前端仅同步类型。

| 项 | 状态 | 说明 |
|---|---|---|
| 随机 CEK + DPAPI 当前用户封装 | 已实现 | 独立 entropy `TaskDock.Clipboard.CEK.v1`；`CRYPTPROTECT_UI_FORBIDDEN`；信封不存在时不凭空创建 |
| 字段编解码 | 已实现 | `tdcl1:<nonce>:<ct>`，AAD 绑定条目 UUID + 字段；旧明文透传；未知版本报错 |
| 资产编解码 | 已实现并接入（批次 2） | `TDCLB1\0 | nonce | ct`；原图/缩略图/640 预览缓存写读均加密；旧明文 PNG 透传 |
| 正文/HTML 入库加密 | 已实现（开关 `clipboard_encrypt_history`，默认关闭） | 开关关闭保持现状明文；开启时缺信封创建 CEK，失败不降级明文 |
| 读取解密 | 已实现 | 行映射与资产读取统一解密，失败整体 fail-closed，不把密文当正文 |
| 启动密钥加载 | 已实现 | `lib.rs` 启动 `prime_cache`；失败只告警，读取加密行时按错误上报 |
| 历史迁移 | 已实现并接入命令（批次 3/6） | 命令 `clipboard_encrypt_history_migrate`：先 `VACUUM INTO` 快照 + 资产拷贝 + 回读计数校验，通过后才加密正文、元数据与历史图片；幂等、断点续跑、WAL checkpoint、明文哨兵扫描；半迁移行中已有 `tdcl1:` 字段原样保留，避免二次套壳 |
| 设置页开关 | 已实现（批次 2/3） | 开关 + 局限说明；「加密现有历史」按钮（需先开启开关），展示计数与备份路径 |
| 明文派生缓存 | 已实现清理 | OCR/另存/外发需要的明文 PNG 落到 `transient/`，启动、删除、清空历史都清理 |
| `preview` / `title` / `source_*` / `file_paths` | 已实现（批次 6） | 与正文共用开关/CEK，按条目 AAD 加密；行映射、分组封面、任务/快照关联标签、来源聚合、自动分组的候选读取全部解密；`file_paths` 解密后才解析 JSON |
| 搜索 | 已改为解密后过滤（批次 6） | 条目列表/计数/分组搜索不再对密文做 SQL LIKE；条目最多扫描 5000 条（按置顶/最近或最常用排序），分组最多扫描 500 个，来源筛选同为解密后等值比较；全局搜索剪贴板只覆盖标题/预览/来源/路径 |
| 图片原图/缩略图/预览缓存 | 已实现（批次 2） | 写入加密、读取透明解密；`image_abs_path` 改为按需解出 `transient/` 明文副本供 OCR/另存/外发 |
| 历史图片资产迁移 | 已实现（批次 3） | 逐文件加密 + 解密往返比对后才落盘；已是密文/缺图跳过；640 预览缓存迁移时清理并按需重建 |
| 备份 bundle 密钥信封 | 已实现（批次 4a） | `clipboard/backup_crypto.rs`：每次备份独立随机 BEK；口令 slot 走 Argon2id（64 MiB/3/1，参数随信封持久化）+ HKDF 域分离；恢复密钥 slot 为 160-bit Crockford Base32，仅 HKDF 域分离；两 slot 解出同一 BEK；段落 AES-256-GCM，AAD `tdclbk\|<backup_id>\|<section>\|v1`，解封前按 `backup_id` 复算 slot AAD 防拼接 |
| 备份 bundle 加密 / BEK / 跨设备恢复 | 已实现剪贴板段口令加密（批次 4b） | `write_bundle_sealed` 把剪贴板类表（正文/分组/粘贴记录）合并为单条 `clipboard_sealed` 记录：BEK + Argon2id 口令信封 + AES-256-GCM，AAD 绑定备份 ID；头记录 `clipboard_sealed:true`，无口令时读取明确报「需要备份口令」。图片字节在批次 4c-2 纳入同一 BEK（见下一行） |
| 恢复密钥导出与消费 | 已实现（批次 4c-1） | 命令 `backup_now_encrypted(full, passphrase, with_recovery?) -> {path, recoveryCode}`；恢复密钥仅返回一次、不落盘；`read_bundle_with_secrets` 与 `import_data(recovery_code?)` 支持「口令优先、密钥兜底」；header `clipboard_recovery_slot` 供界面提示 |
| 剪贴板图片资产备份加密 | 已实现（批次 4c-2） | 密封备份中图片原图/缩略图改写为 `asset_sealed` 分块：逐块 BEK+AES-256-GCM，AAD `tdclbk\|<backup_id>\|asset\|<rel>\|<chunk>\|v1`；文件路径/明文大小/SHA-256 仍随记录保存用于校验，读取时解密后按原 SHA 暂存；明文 `asset` 分块仍兼容旧加密备份与未加密备份 |
| 跨机恢复可移植 | 已实现（批次 4c-3/6） | 密封导出前把 `text`/`html`/`preview`/`title`/`source_*`/`file_paths` 的本机 CEK 密文解回明文、图片容器解出 PNG 后再封入 BEK；恢复时 `normalize_clipboard_for_restore` 按目标机开关重新加密正文、元数据与图片（图片重写为容器并更新暂存大小/SHA）；`clipboard_crypto_envelope` 列为 `EXCLUDED_SETTINGS`，既不导出也不导入（DPAPI 只对原 Windows 用户有效）；`clipboard_encrypt_history` 并入 `LOCAL_PRIVACY_SETTINGS`，恢复旧备份不会悄悄改变本机加密选择 |
| 旧格式剪贴板备份导入一次性迁移 | 已实现并验证（批次 10） | `bundle_meta` 对 `clipboard_sealed=false` 且 `totals` 确有剪贴板行的旧包返回 `clipboard_migration_required=true`，恢复确认框提示「原包只读、先读出再按本机 CEK 重加密」；`ReadBackup.clipboard_sealed` 区分来源，`normalize_clipboard_for_restore` 返回迁移条数/资产数，恢复结果写告警；本机开关关闭时明确提示仍为明文；缺少原机 CEK 的跨机旧包 fail-closed |
| 粘贴审计表列复核 | 已复核（批次 11） | 逐列确认 `clipboard_paste_jobs/items` 不保存剪贴板正文：`remaining_items`/`uncertain_items` 仅 UUID，`message`/`error_message` 为固定文案、序号或错误，`target_title`/`target_exe` 为窗口身份元数据；显式排除字段加密，`target_title` 可能含文档名/网页标题，作为残余风险登记；若需隐藏窗口标题，另立字段迁移 |
| Agent 导出授权门槛 | 已实现导出前确认（批次 7） | 导出必须先调 `clipboard_export_preview`：只读统计条目/图片/字节/类型与是否含任务上下文，并签发 120 秒、单次使用的 `confirmationToken`；token 绑定目标类型/ID、任务 ID 与预览内容指纹（条目 ID/顺序/标题/预览/来源/路径等，不含正文）。`clipboard_export_for_agent` 强制携带 token，命令层重新计算指纹并消费后才写文件；目标/任务/内容变化或 token 过期均拒绝，拒绝写 `gate=denied` 审计，成功写 `confirmed=1`。UI 用危险确认框明示明文留存风险。导出没有暴露给 Agent API/MCP，因此当前不需要能力白名单；同用户被攻陷的渲染进程仍可先预览再导出，此门槛不是针对该威胁的授权边界。 |
| Agent 导出审计 | 已实现（批次 5b） | 成功/失败/清理均写 `security_audit_log`（category=`clipboard`，事件 `CLIPBOARD_EXPORT_SUCCEEDED`/`CLIPBOARD_EXPORT_FAILED`/`CLIPBOARD_EXPORT_PURGED`）；明细只含目标类型、条目/图片计数、保留天数或错误码，**不含目录/文件名/正文**；诊断中心新增「剪贴板」分类 |
| Agent 导出目录手动清理 | 已实现（批次 5a） | `clipboard_purge_agent_exports`：只删 `clipboard-exports/` 直接子目录，按 mtime 保留 N 天（0=全部、默认 7）；跳过符号链接/普通文件，失败保留并计数；返回 `{removed, skipped, failed, bytes}`，不落路径；设置页需危险操作确认 |
| Agent 导出自动清理与设置持久化 | 已实现（批次 8） | 新增 `clipboard_export_retention_days`（1–365，默认 7）与 `clipboard_export_auto_purge`（默认关闭）；两键同时进入 `db::CLIPBOARD_SETTING_KEYS` 与 `commands::settings::ALLOWED_KEYS`，并补齐 `clipboard_encrypt_history` 的历史白名单遗漏。开启后启动阶段在设置加载完成、剪贴板 runtime 启动前用 `spawn_blocking` 清理过期导出，不阻塞启动；审计 reason 追加 `;trigger=startup`，手动清理为 `;trigger=manual`，明细仍不含路径/正文。设置页保留天数改为持久化值，手动与自动清理共用同一窗口；两个清理设置并入 `LOCAL_PRIVACY_SETTINGS`，恢复旧备份不会开启自动清理或改短保留天数 |
| 目录显式 ACL | 已实现（批次 9） | `clipboard/acl.rs`：启动与 `--agentctl` 打开 DB 前，对 `data_dir` 根、`clipboard/`、`clipboard-exports/`、`clipboard-backups/`、`backups/`、`restore/`、`shelf/` 与 `task-dock.db(-wal/-shm/-journal)` 设置 protected DACL，仅当前用户 + `BUILTIN\\Administrators` 完全控制；根与其他目录使用可继承 ACE，已有目录递归处理，符号链接/junction 跳过；失败只计数告警，不阻塞启动 |

### 实施偏差与影响（必须如实告知）

1. **搜索与来源覆盖面收窄**：字段加密后无法依赖 SQL LIKE/GROUP BY。条目/分组/来源筛选改为解密后过滤，条目单次最多扫描按当前排序的前 5000 条（`POST_FILTER_SCAN_LIMIT`），分组搜索最多扫描 500 个（`GROUP_SEARCH_SCAN_LIMIT`）；来源下拉聚合也只统计最近 5000 条，超过部分不参与搜索或计数。全局搜索对剪贴板的匹配只覆盖标题/预览/来源/文件路径，不读大正文 `text/html`，因此长文中间片段只能在剪贴板页前 220 字符预览中命中。
2. **跨机恢复必须走加密备份**：加密库直接拷贝到新机仍不可解（DPAPI 只对原 Windows 用户有效）；未加密或旧版备份的剪贴板正文可能仍带原机 CEK 密文，新机恢复会明确报错。换机请用当前版本的「备份口令」加密备份（正文、元数据与图片在包内为 BEK 保护的明文）。
3. **恢复路径**：密封备份恢复时按目标机开关重新加密正文、元数据与图片；未密封的旧格式备份导入时，由 `normalize_clipboard_for_restore` 在验证/写入前一次性解密并按本机 CEK 重加密，原备份文件保持只读；本机开关关闭时保持明文并在恢复结果中显式提示。缺少原机 CEK 的跨机旧包仍 fail-closed。
4. **明文派生缓存**：`image_abs_path` 为 OCR/另存/外发解出 `transient/<id>-image.png` 明文，生命周期由启动/删除/清空清理；进程崩溃可能短暂残留，启动即清。这是过渡接口，后续批次改为直接消费字节流。
5. **历史图片与元数据迁移**：开启开关只影响新采集；旧图片是明文 PNG、旧元数据是明文，需执行「加密现有历史」统一迁移。迁移命令已覆盖 `text/html/preview/title/source_app/source_title/file_paths` 与历史图片。
6. **性能**：逐行 AEAD + 进程内 CEK 缓存；元数据搜索每次最多 5000 行 × 5 字段解密，尚未做 p50/p95 基准与真机走查。
7. **未做真机验收**：仅单元/集成测试（含 DPAPI 信封、迁移、WAL、错误密钥、资产往返），未启动 Dev 实例走查 UI。
8. **备份包内剪贴板段是可移植明文**：口令或恢复密钥解封后，正文与元数据按设计可读；资产相对路径、明文大小、SHA-256 仍随记录可见，用于恢复校验。
9. **备份加密覆盖剪贴板文本类表与图片字节**：批次 4b/4c-2 对剪贴板类表和图片原图/缩略图加密，但资产文件名/大小/SHA-256 仍可见；批次 4c-3 恢复时会按本机开关把正文与图片重加密，目标机开关关闭时仍以明文落盘。口令或密钥不落盘，两者都丢失时该备份的剪贴板段不可恢复。
10. **旧版加密备份的兼容边界**：4b/4c-1 生成的密封包若来自已开启加密的机器，包内正文/图片仍是原机 CEK 密文，换机恢复会在 `normalize_clipboard_for_restore` 明确失败（不会写入半解密数据）；需要在新机可用的备份，请用当前版本重新生成。旧包在本机同用户恢复仍可用。
11. **Agent 导出仍是明文，但已有导出前确认与可选的启动清理**：批次 7 增加只读预览 + 120 秒单次 token，命令层校验目标/任务/内容指纹；UI 确认框明示“明文留存、同用户进程可读”。批次 8 增加启动自动清理，默认关闭，用户显式开启后才按持久化保留天数删除过期导出目录；手动与自动清理均只删直接子目录、失败保留并计数，审计用 `trigger` 区分来源。批次 9 对数据目录根与剪贴板/导出/备份/恢复/暂存架/DB 文件设置显式 protected DACL（当前用户 + 管理员），不跟随 junction；FAT/网络盘等不支持 ACL 时只告警。导出未暴露给 Agent API/MCP，token 门槛只防误触与确认后内容漂移，不防已攻陷渲染进程；管理员取得所有权仍可读取，属 Windows 模型固有风险。
