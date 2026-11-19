# 安全规范（SECURITY）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 全项目（桌面 / 移动端 / 跨端通信） |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md) |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) §7/§8 & 移动端审计 §4 |
| 红线 | **不得降低现有安全等级** |

---

## 1. 现状评估（已确认的安全机制）

| 领域 | 机制 | 证据 |
|---|---|---|
| IPC 最小权限 | 8 个 capability 按窗口隔离；无 shell/process 执行权限授予 | `capabilities/*.json` |
| CSP | `object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'`；assetProtocol scope 限定 | `tauri.conf.json:101-109` |
| 路径校验 | `fs_safety.rs` canonicalize + 句柄身份核验防 TOCTOU；多模块 `safe_managed_path` + `starts_with(root)` | `fs_safety.rs:10,68,204,410` |
| SQL | 主要用 `?1`/`params` 绑定 | `db/mod.rs` |
| 命令注入 | 37 处 shell 调用多为固定程序 + 参数数组；有 shell 元字符拒绝测试 | `hooks_install.rs:1161,1188` |
| 敏感日志 | 剪贴板正文/图片/路径/密钥不写日志 | 剪贴板模块 |
| 密钥存储 | Argon2 + AES-GCM 信封加密；移动端 SecureStore/Android Keystore | `secure_vault/`、`syncConnection.ts` |
| TLS | TLS-only + SPKI 指纹固定；非 https fail-closed | `secureFetch.ts:98-105`、`SecureHttpModule.kt` |
| 配对授权 | v2 二维码带 TLS 指纹；apiVersion 校验；Bearer 令牌 | `pairing.ts:86-88`、`pairClient.ts:195-206` |
| 重放保护 | 配对码/令牌一次性校验 + 版本门禁 | 配对模块 |
| origin 判定 | 服务端判定，客户端不可伪造来源 | `agents/mod.rs:184-229` |

## 2. 需改善项（不降低现有基线）

| 项 | 现状 | 目标 |
|---|---|---|
| CSP `'unsafe-inline'` | script/style 放宽 | 评估 nonce/hash 收敛；不降低其他防护 |
| 主窗 capability 偏宽 | `default.json` core:default + 5 插件 default | 逐命令收敛，移除未用权限 |
| 动态 SQL 过滤 | `actions/mod.rs:603,685,783` `{filters}` 来源未逐项确认 | 复核来源，白名单化 |
| 路径 `starts_with` | `mobile_sync/files.rs:255` 未见 canonicalize | 先 canonicalize 再边界检查，防符号链接逃逸 |
| TOFU 配对窗口 | 手动输码首次信任（`pairClient.ts:148-149`） | 配对即绑定指纹，后续缺指纹/不匹配一律拒绝 |
| HostnameVerifier 恒 true | 以 SPKI 固定补偿 | 文档记录理由与证书轮换风险，保留 fail-closed |
| shell 参数来源 | 37 处未逐一验证 | 逐一审计，扩展元字符拒绝测试 |

## 3. 规范

### 3.1 IPC 与 Capability
- IPC 命令最小权限；新增命令同步评估 capability。
- 前端只经 bridge 调业务命令；窗口行为等 UI 直连属受控例外。
- Tauri capability 按窗口隔离，主窗权限逐步收敛；不授予 shell/process 全域权限。

### 3.2 敏感数据与日志
- 用户数据库、剪贴板正文/图片、密钥、令牌、个人路径、本机敏感日志不得写入可提交文件。
- 日志只记类型、计数、耗时、退出码、脱敏元数据。
- 错误提示（用户可读）与技术细节（日志）分离，见 [ERROR_HANDLING.md](../engineering/ERROR_HANDLING.md)。

### 3.3 文件系统
- 文件路径必须 canonicalize + 边界检查，防路径穿越与符号链接逃逸。
- 删除/移动经统一文件操作服务（已有 `fs_safety.rs` 与回收站索引），保留 Windows 句柄身份核验。

### 3.4 远程通信
- 跨端通信 TLS-only，密文通道统一经 `secureFetch`；证书/公钥固定不可降级为 TOFU（配对窗口除外，需收窄）。
- 配对授权显式、可撤销；令牌存安全存储；apiVersion 不匹配拒绝。
- 重放保护：一次性配对码、版本号、时间戳窗口。

### 3.5 审计日志
- 安全相关操作（配对、密钥访问、文件删除、权限变更）保留可复核审计元数据，不记正文。

## 4. 测试要求

- 安全单测：路径穿越、SQL 注入、shell 元字符、TLS 降级、SPKI 不匹配、token 伪造。
- 契约测试：跨端协议字段与版本。
- 故障注入：证书错误、中间人、磁盘满、权限不足时 fail-closed。
- 真机：配对端到端、通知、剪贴板系统级行为——单测不替代。
