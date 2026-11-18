# 安全保险箱 · 现状调研与架构缺口分析

- 日期：2026-11-18
- 阶段：P0（只读调研；未改任何代码、数据库或依赖）
- 方法：逐文件阅读 + 调用链追踪（不是按文件名推测）。凡本文写"已确认"的结论，都给出代码位置。

---

## 1. 调研范围与结论摘要

### 1.1 检查过的位置

| 层 | 检查对象 | 方式 |
|---|---|---|
| 桌面架构 | `src-tauri/src/lib.rs`（装配顺序、窗口事件、`app.manage(db)`） | 读关键段 + 全局检索 |
| 数据层 | `src-tauri/src/db/mod.rs`（`Db`、`MIGRATIONS`、`Settings`、`BACKUP_TABLES` 依赖） | 读结构体/迁移/背压段 |
| 备份 | `src-tauri/src/commands/backup.rs`、`commands/data.rs`、`commands/restore.rs` | 读注册表、导出结构、恢复状态机 |
| 搜索 | `src-tauri/src/global_search/mod.rs` | 读全部 `search_*` 的 SQL 源表 |
| Agent 接入 | `src-tauri/src/mcp/{permissions,tools,auth}.rs`、`src-tauri/src/agent_access/{permissions,cli,service}.rs`、`src-tauri/src/bin/taskdock.rs` | 读判定顺序与入口 |
| 诊断 | `src-tauri/src/diagnostics/{privacy,writer,mod}.rs`、`commands/diagnostics.rs` | 读白名单与写入链路 |
| 剪贴板 | `src-tauri/src/commands/clipboard.rs`、`src-tauri/src/clipboard/{platform,store,engine}.rs` | 读写入路径与锁 |
| 既有加密 | `src-tauri/src/mobile_sync/sync.rs`、`src-tauri/src/capability/external_mcp.rs` | 读密钥派生与 DPAPI 封装 |
| 移动端 | `apps/mobile/{package.json,AGENTS.md}`、`src/db/{database,schema,syncConnection}.ts`、`modules/secure-http` | 读依赖、库名、SecureStore 用法 |
| 前端注册中心 | `src/lib/navigationRegistry.ts`、`src/store/useUiStore.ts`、`src/lib/workbenchLayout.ts`、`src/lib/settingsSections.ts`、`src/lib/featureCatalog.ts` | 读类型与契约测试 |
| UI 规范 | `src/components/ui/*`、`src/lib/overlayStack.ts`、`docs/ui-themes/01-design-spec.md`、`AGENTS.md` §6 | 读导出组件与规则 |
| 依赖底数 | `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 逐 crate 检索 |

### 1.2 一句话结论

> **当前架构可以承载安全保险箱，但前提是"另起一个数据库文件 + 另起一套加密与锁定状态"，
> 而不是把表加进 `task-dock.db`。** 强行复用主库会同时踩到备份、搜索、CLI 三条现有链路（F-02/F-03/F-04）。

---

## 2. 当前架构事实（可复用面）

### 2.1 技术栈（与 `AGENTS.md` 一致）

- 桌面：Tauri 2 + Rust 1.85（`src-tauri/`），React 19 + TypeScript + Vite + Zustand（`src/`），
  SQLite `rusqlite` bundled，Windows-only（`docs/ARCHITECTURE.md` §一）。
- 移动：Expo 58 / React Native 0.88 / `expo-sqlite` / `expo-secure-store`（`apps/mobile/package.json`）。
- 数据目录：`TASK_DOCK_DATA_DIR` 优先，否则 `app_data_dir()`；主库固定 `task-dock.db`
  （`lib.rs:590-596, 653`）。隔离实例规则已存在，可直接用于保险箱的真机/破坏性验收。

### 2.2 数据层

- `Db { writer: Mutex<Connection>, readers: Vec<Mutex<Connection>>, path, ... }`：单写 + 3 读（WAL
  `query_only=ON`），`with_read` 在长快照读时跳过繁忙连接（`db/mod.rs:2201-2310`）。
- 迁移：`MIGRATIONS` 按 `PRAGMA user_version` 顺序应用，**只追加**；测试 `migrations_for_test()`
  暴露迁移序列（`db/mod.rs:2683`）。
- 设置：`application_settings` 键值表 + `Settings` 强类型视图（逐键 salvage，`db/mod.rs:2722+`）；
  `ALLOWED_KEYS` 白名单。
- **结论**：`Db` 的"单写多读 + 迁移序列 + 设置视图"是一套成熟模式，保险箱应**照抄模式、另建实例**，
  而不是拿到 `Arc<Db>` 的句柄。

### 2.3 备份与导出（关键约束）

- `BACKUP_TABLES` 用 `BackupTableRule { table, class, quick_policy, restore_order, depends_on, extended }`
  描述每张表（`commands/backup.rs:242-269`）。
- 测试 `backup_registry_covers_every_schema_table` **枚举 `sqlite_master` 的全部表**，任何未登记表
  直接 `panic`（`backup.rs:4742-4777`）。这是仓库的硬契约。
- `application_settings` 在 `BACKUP_TABLES` 内（`backup.rs:383`）→ **设置会被备份导出**。
- 全量导出为强类型行结构 + `EXPORT_VERSION=5`（`data.rs:53`）；分块备份为
  `rows_dir/<table>.jsonl` + registry（`data.rs:1044-1100`）。
- 恢复有 staging/vault/journal 状态机与启动 `recover_pending`（`restore.rs`；
  `lib.rs:667-679`）。

### 2.4 全局搜索

- `global_search/mod.rs` 的 `search_tasks / search_clipboard / search_capture / search_shelf /
  search_apps / search_agents / search_workspace / search_planning / search_notes / search_knowledge`
  全部是**查询期 SQL `LIKE`**，没有 FTS 虚拟表（`grep "fts|VIRTUAL TABLE"` 于 `db/mod.rs` 无命中）。
- 影响两面：**好处**——没有持久索引可泄漏；**坏处**——它直接拿 `Db` 的读连接，任何主库表都可能被
  未来的 `search_*` 顺手加进去。

### 2.5 MCP 与 Agent 接入（已有权限模型，可参考）

- `mcp::permissions::CAPABILITIES` 固定 16 项（`tasks.read` … `handoffs.write`），
  判定顺序 `scope → 能力 → 资源范围`，能力存在 `mcp_agent_capabilities`（`permissions.rs:16-35, 205-236`）。
- 审计表 `mcp_audit_log`、项目级授权 `mcp_agent_grants`、工作区根 `mcp_workspace_roots`。
- `agent_access::permissions::require` 供 CLI/MCP/REST/文件四入口共用；**注意**
  `if !principal.is_agent() { return Ok(()) }`——无令牌的**本机 CLI 等同 UI**（`permissions.rs:43-46`）。
- `agent_access::cli` 与 `service::data_dir()` 直接拼 `task-dock.db`（`cli.rs:151, 320`）。

### 2.6 诊断

- 单写线程 + 有界队列 + 轮转；`diagnostics/privacy.rs` 是**闭集白名单**：
  `ALLOWED_META_KEYS`（约 70 个 key）+ `FORBIDDEN_KEY_PARTS`（token/password/secret/content…）
  + `sanitize_message`（去堆栈/SQL/路径/凭证，限 400 字符）。
- 对象/数组型 metadata 一律丢弃；`message` 仍是自由文本（需调用方自律）。
- 诊断日志**不进 SQLite**（`docs/ARCHITECTURE.md` §诊断日志）。

### 2.7 剪贴板

- 唯一平台层 `clipboard/platform.rs`；三线程 + 有界队列；进程级 `ACCESS_LOCK`；
  **自写序列号在写入锁内登记**，采集线程同锁复核 → 自己写的内容不会入库。
- 通用写入命令 `clipboard_copy_text` 走 `write_payload_notifying`（`commands/clipboard.rs:236-241`），
  不写库、不记日志。
- 日志约定：只记类型/大小/计数/原因，绝不记正文/图片/路径/密钥。

### 2.8 既有加密能力（必须分清能复用与不能复用）

| 能力 | 位置 | 性质 | 能否用于保险箱 |
|---|---|---|---|
| DPAPI 封装 MCP 环境变量 | `capability/external_mcp.rs:181-306`（`dpapi:<base64>`） | 绑定**当前 Windows 用户 + 本机**；换机/换用户不可解 | **不能**作为主保护（不可恢复、不可同步）；可作 P2 "本机便捷解锁"的一层 |
| 移动同步载荷加密 | `mobile_sync/sync.rs:62-121` | `XSalsa20-Poly1305`；密钥 = `SHA-512("taskdock-sync-v1:"+token_hash)`；24B nonce；AAD 在明文内 | **不能**：服务端（桌面）持有 token 即可派生密钥 → 不满足"服务端不可读"；且无口令 KDF |
| 手机 TLS + SPKI 固定 | `apps/mobile/modules/secure-http` | 传输层认证 | **可复用**为 P2 同步传输 |
| SecureStore（移动） | `apps/mobile/src/db/syncConnection.ts` | Android Keystore 支持 | **可复用**存设备私钥/包裹后的 DEK |

### 2.9 前端接入点

| 事项 | 位置 | 说明 |
|---|---|---|
| 导航入口 | `src/lib/navigationRegistry.ts`（`NAV_ENTRIES`、`NavEntryId`） | 唯一元数据源；左侧导航与胶囊轨道都从这里取 |
| Tab 身份 | `src/store/useUiStore.ts`（`Tab`、`TAB_ORDER`） | `Ctrl+1..9` 已发布语义；**新入口不得占用数字键** |
| 工作台路由 | `src/lib/workbenchLayout.ts`（`WORKBENCH_ROUTES`，22 项） | 契约测试与 `NAV_ENTRIES.tabs` 对齐 |
| 设置分区 | `src/lib/settingsSections.ts`（17 个 id） | 折叠状态本地存储 |
| 功能目录 | `src/lib/featureCatalog.ts`（61 项，测试锁计数） | **本阶段不改**（D-02） |
| 弹层 | `src/lib/overlayStack.ts` | Escape 一次只关一层；优先级 dialog > menu > modalTop > sublayer > modal > drawer |
| UI 基元 | `src/components/ui/*` | Dialog/Popover/Select/Toggle/SearchField/Tooltip/StatusBadge/NumberInput/DatePicker/EmptyState |
| 桥接 | `src/lib/bridge.ts`（234KB，单文件） | 类型 + `invoke` 封装；新命令必须加在这里 |

### 2.10 依赖底数（决定 P1 的成本）

`Cargo.lock` 检索结果（2026-11-18）：

- **已存在**（可作直接依赖，零新增下载）：`zeroize 1.9.1`、`subtle 2.6.1`、`poly1305 0.8`、
  `salsa20 0.10`、`aead 0.5`、`digest 0.10`、`sha2`、`rand 0.8`、`getrandom 0.2`、`parking_lot 0.12`。
- **不存在**（P1 需新增，待批准）：`argon2`、`aes-gcm`、`hkdf`、`hmac`、`base32`、
  `unicode-normalization`；P2 还需 `p256`（ECDH）。
- `windows-sys` 现有 features 里**没有** `Win32_System_RemoteDesktop` → WTS 会话通知需要**追加 feature**
  （不是新 crate）。

---

## 3. 八条关键现状结论（F-01…F-08）

| ID | 结论 | 证据 | 对保险箱的强制含义 |
|---|---|---|---|
| F-01 | 主库设置会被备份导出，且 `get_settings` 全量返回前端 | `backup.rs:383`；`db/mod.rs:2722+` | 保险箱设置**不得**写 `application_settings` |
| F-02 | 主库所有表必须登记备份，否则测试红 | `backup.rs:4742-4777` | 若 vault 表进主库 → 被迫进明文 JSON 备份；**故必须独立库** |
| F-03 | 无令牌的 CLI 等同 UI 权限，且硬编码 `task-dock.db` | `agent_access/permissions.rs:43-46`；`cli.rs:151` | 保险箱在主库 = CLI 全量可读；**故必须独立库 + 独立状态** |
| F-04 | 全局搜索用主库读连接，任何表都可能被新 `search_*` 触达 | `global_search/mod.rs` 各 `search_*` | 保险箱不注册任何 `search_*`；库分离是物理保障 |
| F-05 | 诊断 metadata 是闭集白名单，未登记 key 会被丢弃 | `diagnostics/privacy.rs:23-89` | 新增 vault 事件 key 必须显式登记；`message` 禁止拼接记录内容 |
| F-06 | 移动同步密钥可由桌面端从 token 哈希派生 | `mobile_sync/sync.rs:62-70` | **不得**把同步密钥/配对密钥当保险箱密钥；P2 必须独立设备信封 |
| F-07 | 剪贴板自写登记能防入库，但通用写入命令任何 UI 都能调 | `commands/clipboard.rs:236`；`clipboard/platform.rs` 自写序列 | 保险箱复制必须是**专用命令**，在 Rust 侧强制"不入库 + 定时清除" |
| F-08 | DPAPI 可用但绑定用户+机器 | `capability/external_mcp.rs:181-256` | 只能做"本机便捷解锁"附加层，不能作为唯一/可恢复保护 |

---

## 4. 可复用清单（按复用强度排序）

| 复用项 | 复用方式 | 需改造吗 |
|---|---|---|
| `TASK_DOCK_DATA_DIR` 隔离实例机制 | 保险箱验收/破坏性演练直接复用 | 否 |
| `Db` 的"单写 + WAL + 迁移 + 逐键 salvage"模式 | 照抄到 `VaultStore`（不复用类型） | 否（新模式） |
| `commands/restore.rs` 的 staging → 校验 → 原子替换 → 回滚 | 保险箱导入/恢复照抄状态机 | 少量（路径与文件名） |
| `clipboard/platform.rs` 的受控写入 + 自写登记 + `ACCESS_LOCK` | `copy_secret` 调用同一写入原语 | 需加"内容指纹比对"接口 |
| `diagnostics` 单写线程 + 白名单脱敏 | 直接发 `vault/*` 事件 | 需登记 4–6 个新 key |
| `overlayStack` + `components/ui/*` | 全部弹层/表单复用 | 否 |
| `navigationRegistry` + `navVisibility` + `workbenchLayout` | 新增 `vault` 入口/路由 | 是（见 §6） |
| 移动 `secure-http`（TLS + SPKI 固定） | P2 同步传输 | 否 |
| 移动 `SecureStore` | P2 存设备私钥/包裹 DEK | 否 |
| `zeroize` / `subtle`（已在 lockfile） | 密钥清零 / 常量时间比较 | 否 |

---

## 5. 架构缺口（必须新增的东西）

| 缺口 | 现状 | 需要新增 |
|---|---|---|
| 独立加密存储 | 只有主库 `task-dock.db`（明文列） | `VaultStore`（独立连接、独立迁移、独立 PRAGMA） |
| 口令 KDF | 无（只有 SHA-512 派生） | Argon2id 封装/解封装 + 参数持久化 |
| AEAD 记录加密 | 只有同步载荷的 XSalsa20 | 记录级 AES-256-GCM + HKDF 子密钥 |
| 解锁会话 | 无"进程内受保护状态"概念 | `VaultSession`（DEK + 内存索引 + 活动时间 + 世代） |
| 锁定事件源 | 无系统锁屏/休眠检测 | Win32 会话通知 + 电源广播 + 后端定时器 |
| 敏感内存处理 | 无（Rust 侧未用 `zeroize`） | 密钥/明文 `Zeroizing` 包装与生命周期约定 |
| 剪贴板定时清除 | 只有"写入/粘贴"，无"限时撤销" | `vault_clipboard_*` 定时器 + 内容指纹比对 |
| 加密备份格式 | 主备份是明文 JSON | `.tdvault` 容器（独立版本号） |
| 设备身份 | 手机配对是"令牌 + 局域网" | P2：设备密钥对 + 信封 + 撤销/轮换 |
| 保险箱专属诊断命名空间 | 无 | `vault/*` 事件与 key 白名单 |

---

## 6. 与桌面端 / 移动端的集成位置（精确到文件）

### 6.1 桌面端（P1）

| 文件 | 改动 | 风险级别 |
|---|---|---|
| `src-tauri/src/secure_vault/**`（新目录） | 全部新代码 | 低（新文件） |
| `src-tauri/src/commands/secure_vault.rs`（新） | Tauri 命令层 | 低 |
| `src-tauri/src/commands/mod.rs` | 加一行 `pub mod secure_vault;` | **中**（共享枢纽，需唯一所有者串行） |
| `src-tauri/src/lib.rs` | `app.manage(VaultState)` + 注册命令 + 窗口事件接线 | **高**（共享枢纽，必须串行） |
| `src-tauri/src/diagnostics/privacy.rs` | 追加 4–6 个 metadata key | **中**（共享，白名单是闭集） |
| `src-tauri/Cargo.toml` | 追加 6 个依赖 + 1 个 windows-sys feature | **高**（需批准；影响构建指纹） |
| `src/lib/bridge.ts` | 追加类型与命令封装 | **高**（234KB 单文件，多人同时改） |
| `src/lib/navigationRegistry.ts` | 新增 `vault` 入口 | **中** |
| `src/store/useUiStore.ts` | `Tab` 增加 `vault`（不进 `TAB_ORDER`） | **中**（已发布语义） |
| `src/lib/workbenchLayout.ts` | `WORKBENCH_ROUTES` 增加 `vault` | **中**（契约测试） |
| `src/lib/settingsSections.ts` | 增加 `secure-vault` 分区 id | 低 |
| `src/components/vault/**`、`src/store/useVaultStore.ts`、`src/lib/vault.ts`（新） | 全部新代码 | 低 |

### 6.2 移动端（P2）

| 文件 | 改动 |
|---|---|
| `apps/mobile/src/db/vault.ts`（新） | 独立 `vault.db`（`SQLite.openDatabaseAsync("vault.db")`） |
| `apps/mobile/modules/secure-vault/`（新原生模块） | Keystore 密钥、AES-GCM、HKDF(HmacSHA256)、SecureRandom |
| `apps/mobile/src/screens/VaultScreen.tsx`、`VaultUnlockScreen.tsx`（新） | 页面 |
| `apps/mobile/src/domain/vault*.ts`（新） | 纯函数（字段模型、校验、搜索语义） |
| `apps/mobile/plugins/` | 新模块的 config plugin |

> 移动端"不新增依赖"的规则（`apps/mobile/AGENTS.md` §1）意味着**优先走项目内原生模块**，
> 而不是引入第三方密码库；这也是选择 AES-GCM 而非 XChaCha20 的原因（decision-log D-04）。

---

## 7. 需要提前解决的架构问题（按阻塞度）

1. **库分离与备份契约**：必须先确认"保险箱库不进 `BACKUP_TABLES`"，且主备份不扫描数据目录下的
   `*.db`。核对点：备份读取按表枚举（`SectionSource::Value` / `SectionSource::Dir` 读
   `rows_dir/<table>.jsonl`，`data.rs:308-320, 890-910`），**不遍历数据根目录**
   → 不会带走 `secure-vault.db`；仍需 P1 用测试锁定（T-BKP-09）。
   另有边界：`list_backups` / `prune_backups` 枚举的是 `<数据目录>/backups` 整个目录并**按保留天数删除
   所有文件**（`data.rs:767-822`），因此**保险箱备份不得写入 `backups/`**，否则会被主备份的保留策略
   误删、也会混进主备份列表。
2. **CLI 二进制是否会被链接进保险箱代码**：`taskdock` bin 与桌面 app 共用 `task_dock_lib`。
   保险箱命令依赖 `State<VaultState>`，CLI 不 `manage` 该状态 → **结构上不可调用**；
   但必须在 `agent_access/cli.rs` 不新增 `vault` 子命令（列入评审清单）。
3. **`lib.rs` 装配顺序**：诊断 → 主库 → 恢复 → 保险箱状态（不自动解锁）。保险箱必须在主库之后
   初始化（复用人格：数据目录解析已完成），但**不得**在启动时解密任何数据。
4. **`featureCatalog` 与路线图登记**：见 D-02，P1 启动时由集成负责人单独提交（避免与并行会话冲突）。
5. **`bridge.ts` 体量**：已 234KB。建议 P1 新建 `src/lib/vaultBridge.ts` 由 `bridge.ts` 末尾
   re-export，避免继续膨胀共享文件（D-05）。

---

## 8. 明确不建议的"强行复用"

| 想法 | 为什么不行 |
|---|---|
| 用 `application_settings` 存保险箱配置/包裹密钥 | 进备份、进 `get_settings` 返回值（F-01） |
| 用主库表 + 应用层加密列 | 备份强制登记（F-02）、CLI 可读（F-03）、搜索可触达（F-04） |
| 用 DPAPI 包 DEK 当主保护 | 换机/换 Windows 用户即不可解（F-08），无法恢复 |
| 用手机配对令牌派生保险箱密钥 | 桌面端持有 token 即可派生（F-06），破坏"服务端不可读" |
| 复用 `mobile_sync::encrypt_envelope` | 同上；且 AAD 在明文内、无版本化 KDF 参数 |
| 把密码存进 `notes` 再"加密显示" | 笔记明文进备份、MCP 可读 |
| 用前端 `setTimeout` 做自动锁定 | 刷新/崩溃/后台节流都会绕过（AGENTS §4.8 要求可取消、有超时） |

---

## 9. 调研的局限（诚实声明）

- 未运行应用、未执行任何测试；所有结论来自源码与文档阅读。
- 未验证 Win32 会话通知在 Tauri 无边框窗口上的实际行为（P1 首个验证点）。
- 未验证 `secure-vault.db` 与主库同时开启 WAL 的 I/O 竞争（P1 性能门禁项）。
- 未评估 WebView2 内存中 JS 明文的实际残留时间（无法用现有工具量化，只能按"不可保证"处理）。
