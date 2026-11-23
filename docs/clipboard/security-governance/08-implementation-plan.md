# 08 · 实施计划、风险与回滚

| 项目 | 内容 |
|---|---|
| 状态 | 规划草案（待主 Agent 审核；获得实施授权后才改代码） |
| 日期 | 2026-11-23 |
| 前置 | 本目录 01–07 文档；ADR-0012 经审核 Accepted |
| 红线 | 不破坏现有剪贴板历史与工作篮/任务引用关系；不重复上一轮已完成功能；最小改动，不顺手重构 |

## 1. 实施阶段划分（建议，非开工指令）

### Phase 0：评审与定稿（本阶段交付物）

- 完成现状盘点、威胁模型、方案对比、ADR、隐私授权、迁移/备份方案、测试矩阵。
- 评审未决项：恢复 slot 形态、检索范围、资产加密容器布局、ACL 范围、旧库授权补确认策略。
- 输出实施授权清单：改动路径、契约变更、测试准入。

### Phase 1：加密基础设施（不含历史迁移）

1. 新增剪贴板密码学模块：CEK 随机生成、DPAPI 封装/解封装（独立 entropy/错误类型）、信封结构、AAD 与 info 命名空间。
2. 字段/资产加解密原语：复用 `aes-gcm`/`zeroize`/`sha2`/`base64`；记录与文件容器格式版本位。
3. 信封持久化落点（表或小文件）与设置白名单登记；DB 迁移只在 `MIGRATIONS` 末尾追加。
4. 单元测试：封装往返、篡改拒绝、AAD 绑定、空值/超限失败路径。
5. 此阶段不批量迁移旧数据；新写入路径可在特性开关下双写/灰度。

### Phase 2：采集与读取链路接入

1. `store.rs` 入库/读取路径改造：敏感字段加密落库、按需解密；资产写入/读取加密容器。
2. 预览缓存、缩略图、缺图/损坏路径对接；补预览缓存孤儿清理。
3. 前端设置页：授权状态、图片授权、清理入口、加密状态与文案局限；IPC 命令同步类型与 Rust 签名。
4. 隐私开关回归：暂停、图片关闭、排除名单、配置 fail-closed、OCR 缓存失效。

### Phase 3：迁移工具与历史数据加密

1. 迁移状态机（PENDING → BACKED_UP → ENCRYPTING → VERIFYING → SWITCHED → OBSERVING → CLEANED）与断点水位。
2. 备份校验、影子库/影子资产、计数对账、往返抽样、哨兵扫描、WAL checkpoint 策略。
3. 旧明文库读取兼容；切换与回滚路径；观察期旧副本保留策略。
4. 迁移回放测试：v 当前版本旧夹具 → 新格式；中断续跑、失败回滚、关联一致性。

### Phase 4：备份/恢复与 Agent 导出

1. bundle 加密标记、BEK 双 slot、恢复口令/密钥包流程；旧明文包导入迁移路径。
2. 恢复流程校验、staging 不明文落地、资产还原、journal 续跑。
3. Agent 导出能力登记、授权粒度、审计落点、导出目录清理与提示。
4. 备份往返集成测试与干净环境恢复验收。

### Phase 5：加固与验收

1. 数据目录/剪贴板目录显式 ACL；跨用户隔离真机验证。
2. 诊断/日志白名单复核：不回含正文、图片、路径正文、密钥材料。
3. 全量测试矩阵执行；Dev 真机验收取证入 `tmp/acceptance/<task-name>/`。
4. 文档同步：`docs/clipboard/03-data-model.md`、`04-monitor-security.md`、备份/恢复归属文档；更新索引。

## 2. 依赖与接口影响

| 区域 | 变更类型 | 注意事项 |
|---|---|---|
| DB schema | 末尾追加迁移；新增信封表/列 | 不改已发布迁移；新设置键同步 `db::Settings`/`ALLOWED_KEYS`；新表登记 `BACKUP_TABLES`（若入备份） |
| `clipboard/store.rs` | 读写路径加解密 | 主键/外键/UUID/哈希不动；去重与索引语义不变 |
| `clipboard/image.rs` / 资产写入 | 容器格式 | 临时文件原子替换与失败清理保留 |
| `commands/backup.rs` / `restore.rs` | bundle 版本与加密层 | 旧格式可读；完整性校验先于解密 |
| `agent_access` | 剪贴板能力登记 | 未授权拒绝；审计不记正文 |
| 前端 bridge / store / 设置页 | 命令与状态类型同步 | 遵循按需加载与组件层规范，不绕统一组件 |
| `secure_vault/` | 仅复用原语经验 | 不共享密钥、信封、会话、entropy |

## 3. 风险登记与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 迁移导致历史/关联丢失 | P0 | 迁移前备份校验；影子库对账；关联计数断言；观察期保留旧副本；回滚脚本/流程就绪 |
| DPAPI 在目标环境不可用/主密钥损坏 | P1 | fail-closed 不写明文；备份恢复材料引导；错误分类可诊断；不降级到无保护存储 |
| 加密热路径性能回退（入库/列表/预览解密） | P1 | 批量与预览路径基准测试；按需解密；缓存边界明确；p50/p95 附证据 |
| 备份包明文兼容被破坏，旧备份无法导入 | P1 | 旧格式读取路径保留；旧包导入走一次性迁移；往返测试覆盖 |
| 字段加密破坏搜索/去重/排序 | P2 | 哈希与排序元数据明文；检索范围在 Phase 0 定稿；密文检索不承诺 |
| 缩略图/预览派生信息泄露 | P2 | 文件加密；文档登记派生残余风险；不声称派生图不可读 |
| 预览缓存/导出目录/staging 孤儿残留 | P2 | 清理策略补齐；扫描用例覆盖；失败计数如实 |
| 同用户恶意进程读内存/调 DPAPI | 模型外 | 威胁模型明确不承诺；不扩大本期范围 |
| 依赖膨胀/构建失败 | P3 | 现有加密/DPAPI 依赖已在 `Cargo.toml`；不新增未评估 crate |

## 4. 回滚方案

### 4.1 代码回滚

- 改动按精确路径提交；每个 Phase 独立可回退。未获授权不合并主分支。
- 特性开关隔离灰度；开关关闭时行为回到现状明文路径（迁移完成后该开关移除需单独评审）。
- 回滚不使用 `reset --hard`/`clean` 清理用户数据；工作区他人改动不还原。

### 4.2 数据回滚

- 迁移/切换出现 P0：使用迁移前通过校验的明文备份 bundle + 旧资产目录恢复；恢复后库格式回到明文。
- 备份恢复本身失败：保留现场、journal 与诊断日志；不二次覆盖现有数据。
- 观察期内旧副本未清理前，回滚路径始终可用；清理动作必须在观察期结束且验证通过后执行。

### 4.3 回滚触发条件

- 条目/资产/关联计数不一致且无法在限定批次内修复。
- 抽样往返解密失败或哨兵扫描在生产库命中明文。
- 干净环境备份恢复不可用，或恢复后核心历史不可读。
- DPAPI 封装/解封装在受支持环境普遍失败，且无可行兜底。
- 出现数据泄露、崩溃、核心功能不可用的 P0 问题。

## 5. 交付检查清单（实施完成后）

- [ ] ADR-0012 状态更新为 Accepted；未决项逐条闭环或登记。
- [ ] 数据库/资产/备份/导出四条链路加密行为符合方案；测试矩阵全绿或缺口单列。
- [ ] 迁移回放、中断续跑、回滚、备份往返有真机/隔离环境证据。
- [ ] 日志与诊断不含正文、图片、路径正文、密钥材料。
- [ ] 文档归属同步：数据模型、监听安全、备份恢复、帮助文案、索引。
- [ ] 精确路径提交；暂存区复核；不提交用户数据库、产物、证据日志。
- [ ] 残余风险与未覆盖项如实汇报，不宣称绝对安全。

## 6. 本阶段交付边界

### 6.1 批次 1（2026-11-23，已实施）

已落地：

- 加密原语与信封：`clipboard/secure.rs`（独立 CEK、DPAPI 当前用户封装、AAD 绑定、字段/资产编解码、未知版本拒绝、密钥缺失 fail-closed）。
- 写入/读取接入：`clipboard/store.rs` 正文与 HTML 入库加密（开关 `clipboard_encrypt_history`，默认关闭）、行映射统一解密。
- 启动密钥加载：`lib.rs` 启动 `prime_cache`。
- 迁移核心：`clipboard/secure_migration.rs`（幂等批量加密、批内往返校验、WAL `checkpoint(TRUNCATE)`、明文哨兵扫描）。
- 契约同步：`src/lib/contracts/models.ts` 增加可选字段。
- 测试：12（加密原语）+ 4（store 接入）+ 3（迁移）= 19 个新用例；`cargo test --lib clipboard::` 279 通过 / 1 ignored，`db::` 51 通过，`npm run typecheck` 通过。

未落地（后续批次）：

- 图片资产加密接入（`paste`/导出/工作篮路径改造）、`preview`/`title`/`source_*`/`file_paths` 加密与解密后搜索。
- 迁移命令与设置页 UI（开关、状态、恢复材料引导、首次授权流程）。
- 备份 bundle 加密（BEK/恢复口令）、旧明文包导入迁移、staging 清理。
- Agent 导出授权与审计、目录显式 ACL。
- 真机 Dev 验收与性能基准。

### 6.2 批次 2（2026-11-23，已实施）

已落地：

- 图片资产加密接入：`write_assets` 写入容器密文（原图/缩略图），`read_asset_plain` 透明解密；
  `image_png`/`image_data_url`/`thumb_data_url`/`preview_data_url` 全部改走解密读取；
  640 预览缓存在有密钥时加密落盘。
- `image_abs_path` / `image_abs_path_by_conn`：密文资产按需解出 `transient/<id>-image.png`
  明文供 OCR/另存/外发/工作篮使用；`purge_transient_assets` 在启动、删除、清空历史时清理。
- 设置页开关与文案：`clipboard_encrypt_history` Switch + 局限说明（中英），说明已有历史仍需迁移、
  备份/导出/OCR 未覆盖。
- 测试新增 3 项：资产密文写入与透明读取、旧明文 PNG 兼容与路径保持、预览缓存加密复用。

未落地（后续批次）：

- 历史**图片资产**迁移（当前迁移工具只处理正文/HTML）。
- `preview`/`title`/`source_*`/`file_paths` 加密与“解密后过滤”搜索。
- 迁移命令与设置页迁移入口（现有历史 -> 密文）。
- 备份 bundle 加密（BEK/恢复口令）、Agent 导出授权与审计、目录显式 ACL。
- 真机 Dev 验收与性能基准。

### 6.3 批次 3（2026-11-23，已实施）

已落地：

- `secure_migration::encrypt_existing_history_with_backup`：迁移前 `VACUUM INTO` 一致性快照 +
  图片/缩略图目录拷贝 + SHA-256 与回读计数校验；校验失败直接中止且不写任何密文。
- 历史**图片资产**加密：逐文件加密后解密往返比对，一致才原子落盘；已是密文/缺图跳过。
- 640 预览缓存迁移时清理，按需重建为密文；`transient/` 明文副本一并清理。
- 命令 `clipboard_encrypt_history_migrate`：在阻塞线程池执行，与采集写入共用 `capture_gate` 临界区。
- 设置页维护区新增「加密现有历史」按钮（需先开启开关），展示加密条数、资产数与备份路径。
- 测试新增 2 项：带备份的整体迁移（含图片、幂等重跑）、备份不可创建时零写入中止。

未落地：

- `preview`/`title`/`source_*`/`file_paths` 加密与“解密后过滤”搜索。
- 备份 bundle 加密（BEK/恢复口令）、Agent 导出授权与审计、目录显式 ACL。
- 真机 Dev 验收与性能基准。

### 6.4 批次 4a（2026-11-23，已实施）

已落地（`src-tauri/src/clipboard/backup_crypto.rs`，仅密钥信封原语，不改 bundle 行为）：

- 每次备份独立随机 BEK，不复用剪贴板 CEK 或保险箱 DEK/KEK。
- 口令 slot：Argon2id（64 MiB / 3 / 1），盐与参数随信封持久化；HKDF info
  `taskdock-clipboard/kek/backup-password/v1` 域分离；口令最少 8 字符并做 NFKC 规范化。
- 恢复密钥 slot：160-bit 随机，Crockford Base32 展示（忽略分隔符/易混字符），
  HKDF info `taskdock-clipboard/kek/backup-recovery/v1`。
- 双 slot 解出同一 BEK；信封 AAD 绑定 `backup_id`，解封前复算校验，防跨备份拼接。
- 段落密文 AES-256-GCM，AAD `tdclbk|<backup_id>|<section>|v1`。
- 测试 6 项：口令往返与错误口令、恢复密钥往返与异码、双 slot 一致、篡改信封、
  形状校验（无 slot/未知格式/超版本/短口令）、段落 AAD 绑定。

### 6.5 批次 4b（2026-11-23，已实施）

已落地（备份写入 / 读取 / 恢复链路接入，默认不改变现有备份行为）：

- `backup::write_bundle_sealed`：剪贴板类表（`clipboard_items`/`assets` 元数据/`groups`/
  `group_items`/`task_links`/`paste_jobs`/`paste_items`）合并为单条 `clipboard_sealed` 记录，
  整段用 BEK + AES-256-GCM 加密，AAD 绑定 `backup_id` 与段名。
- header 新增 `clipboard_sealed` 标记；`bundle_meta` 透出 `clipboard_sealed` 供界面提示。
- `read_bundle_with_secret` / `RestoreOptions.clipboard_secret`：缺口令报
  `PermissionRequired("…需要输入备份口令…")`，错误口令/篡改按解密失败拒绝；解密后按表落回暂存行。
- 命令 `backup_now(full, passphrase?)`、`import_data(path, allowPartial, passphrase?)` 透传口令；
  自动备份保持不加密（无用户口令可用）。
- 设置页「数据与备份」新增备份口令输入与说明，恢复加密备份前校验口令长度（≥8）。
- 测试新增 1 项：密封备份正文/预览/哈希不落明文、缺口令与错口令拒绝、正确口令往返并导入、
  未加密备份行为不变。

未落地：图片资产字节仍未纳入口令加密（加密开关开启时随 CEK 密文、关闭时为明文 PNG）；
恢复密钥 slot 导出 UI 已在 4c-1 补齐（见 §6.6）；跨设备恢复剪贴板正文仍受图片资产与检索限制。

### 6.6 批次 4c-1（2026-11-23，已实施）

已落地（恢复密钥通道真正可用，不改变未加密备份行为）：

- `backup::write_bundle_sealed_with_recovery` / `write_bundle_inner(..., with_recovery)`：
  sealed 备份可同时写入恢复密钥 slot；header 增 `clipboard_recovery_slot`，`bundle_meta` 透出。
- 读取侧 `read_bundle_with_secrets(path, staging, secret, recovery)`：口令优先，其次恢复密钥；
  两者皆缺报 `PermissionRequired("…备份口令或恢复密钥…")`；错口令/错密钥按解密失败拒绝。
- 命令 `backup_now_encrypted(full, passphrase, with_recovery?) -> {path, recoveryCode}`：
  仅在填写口令时使用；返回的一次性恢复密钥不落盘。`import_data(..., recovery_code?)` 与
  `RestoreOptions.clipboard_recovery` 透传到恢复链路。
- 设置页「数据与备份」：恢复密钥输入框、`withRecovery` 勾选、备份后一次性密钥展示与复制
  （`navigator.clipboard`），恢复时「口令 ≥8 优先，否则用恢复密钥」；确认框标注恢复方式。
- 测试新增 1 项：恢复密钥不落盘、header 标记、缺口令且缺密钥拒绝、错密钥拒绝、正确密钥往返导入、
  口令通道同一备份仍可用、无 slot 的 sealed 备份不能用恢复密钥。
- 本批验证：`cargo test --lib commands::backup` 31 passed / 1 failed（既有
  `quick_and_full_bundles_include_all_voice_tables_and_assets` 计数口径缺陷，非本批引入）；
  `npm run typecheck` 0；`cargo check` 0。

未落地：图片资产字节仍未纳入口令加密；恢复后的正文未按本机开关重新加密；旧明文包一次性加密
迁移未做。

### 6.7 尚未执行（等待后续批次）

- 批次 4c（余项）：图片资产随口令加密、正文跨机可移植（恢复后按本机开关重加密）、
  旧明文包一次性加密迁移。
- `preview`/`title`/`source_*`/`file_paths` 加密与“解密后过滤”搜索。
- Agent 导出授权与审计、目录显式 ACL、真机 Dev 验收与性能基准。
- 本批次未执行：数据库 schema 迁移、Dev 真机走查。
- 残余风险按 ADR §14「实施偏差与影响」如实登记，不得对外宣称剪贴板历史已全面加密。
