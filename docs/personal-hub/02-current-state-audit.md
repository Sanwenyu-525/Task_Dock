# Personal Hub · 现状审计与能力差距

- 日期：2026-11-19
- 审计基线：`main` @ `7485d92`；工作树另有未跟踪目录（`.preview-pop/`、投屏验收证据等）属其他任务，未纳入
- 方法：只读代码审计（Windows `src-tauri/`、Android `apps/mobile/`、文档体系、`Cargo.toml`、`AndroidManifest.xml`），结论均带证据路径

> 本文回答规格第七节前置要求：「检查 TaskDock 当前目录、架构、Windows 端、Android 端和已有投屏实现，不能凭空假设现有代码。」

---

## 1. 技术栈画像（决定一切实现路径的底座）

| 端 | 实际技术栈 | 关键证据 | 与个人 Hub 规格的关系 |
|---|---|---|---|
| Windows 桌面 | Tauri 2 + Rust（双 bin：`task-dock` GUI / `taskdock` CLI），React 19 + TS + Vite + Zustand，SQLite（rusqlite bundled） | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src-tauri/src/main.rs` | 基线可用；Personal Hub 后台服务可在 Rust 侧新增 |
| Android | **不是原生 Kotlin App**，而是 **Expo SDK 58 + React Native 0.88.1**；原生代码仅 8 个本地 Expo Module（Kotlin），经 autolinking 链接；minSdk 24 / targetSdk 36 | `apps/mobile/package.json`、`apps/mobile/app.json`、`apps/mobile/android/app/build.gradle:90-96`、合并 Manifest | **重大约束**：BiometricPrompt / VpnService / MediaProjection / AccessibilityService 必须经新增 Kotlin 原生模块 + JS bridge 实现，不能假设「Kotlin 原生桥接」已就绪 |
| 云端 | 无独立云端。`RELAY_INTEGRATION.md` 的 "Relay" 是本地 Agent 编排系统（Fastify 5 + PostgreSQL 的 sidecar，绑回环 `127.0.0.1`），**不是**设备信令/发现/NAT 穿透/中继服务 | `docs/RELAY_INTEGRATION.md` §1、§3.2 | 规格要求的轻量云端为**全新建** |
| 投屏 | ADB + scrcpy 5.0.1，画面/键鼠由 scrcpy 独立窗口提供，Task Dock 不自建渲染管线；截图用 Windows `PrintWindow` 抓 scrcpy 窗口 | `src-tauri/src/commands/virtual_display.rs`、`virtual_display/process.rs`、`projection_window.rs`、`docs/mobile/13-android-screen-control.md` | 与规格「被控端 MediaProjection + AccessibilityService」是**两条不同路线**（见 §4 冲突 C1） |

---

## 2. 已存在能力清单（有 / 部分 / 无 + 证据）

### 2.1 Windows 端

| 能力 | 状态 | 证据与说明 |
|---|---|---|
| 局域网 HTTPS 手机接入 | **有** | `mobile_sync/server.rs`：`0.0.0.0:<port>`（默认关）、TLS-only、Bearer 设备令牌；`mobile_sync/mod.rs::run_supervisor` |
| 设备配对 | **有（完整）** | `mobile_sync/mod.rs`：`PAIRING_TTL_SECS=120`、`MAX_PAIR_ATTEMPTS=5`、6 位配对码、`generate_device_token()`（256 位）、`authenticate_device()`、`complete_pairing()`、`revoke_device()`（软删除） |
| TLS + SPKI 固定 | **有** | `mobile_sync/tls.rs`：`TlsIdentity` 自签 RSA-3072 + SPKI SHA-256 指纹，走系统 schannel（native-tls）；二维码 `taskdock://pair?...&tls=<指纹>` 固定证书；fail-closed |
| 载荷二次加密 | **有** | `mobile_sync/sync.rs`：`SHA-512("taskdock-sync-v1:"+token_hash)[0..32]` 派生密钥 + XSalsa20-Poly1305 + 24B nonce + AAD 绑方法/路径 |
| 凭据加密（DPAPI） | **有** | `capability/external_mcp.rs:178-306`：`CryptProtectData/UnprotectData` |
| 保险箱强加密 | **有** | `secure_vault/crypto/*`：Argon2id + HKDF + HMAC-SHA256 + AES-256-GCM + zeroize；会话锁 + 锁屏即锁（`WTS_SESSION_LOCK`） |
| 本地 HTTP / REST 鉴权 | **有** | `agents/http_ingest.rs`（`127.0.0.1`、Bearer）、`agent_access/rest.rs`（`127.0.0.1:47911`、拒 Origin、限流 120/min、token 只存 SHA-256） |
| 进程生命周期管理 | **有** | `spawn_supervisor` 1s 轮询/5s 退避/退出信号 2s 收拢；scrcpy 子进程 Job Object |
| 自动启动 | **部分** | `tauri-plugin-autostart`（Run 注册表键，非 Windows Service）`lib.rs:597-601` |
| 屏幕采集（投屏） | **部分** | ADB+scrcpy 的画面；Windows 侧 `PrintWindow` 抓 scrcpy 窗口；**无 Windows.Graphics.Capture** |
| 本地输入注入 | **部分** | `clipboard/platform.rs` 的 `SendInput`（智能剪贴板自动粘贴）；`vd_nav` 走 `adb shell input`（Android 端） |
| 远程控制通道（网络下发键鼠/屏幕） | **无** | `mobile_sync/server.rs:1119-1133` 路由仅 `/health,/pair,/ping,/changes,/ops,/files,/shelf/groups`，无 input/control 端点 |
| WireGuard / VPN / TUN | **无** | Grep 无匹配；Cargo 无 `wintun`/`tun2socks`；仅 `pick_lan_ip` 过滤 fake-ip/CGNAT 网段 |
| Windows Hello / 生物识别 / WebAuthn | **无** | `secure_vault` 凭据仅 `password`/`recovery`；无 `UserConsentVerifier`/`KeyCredential`；详见 [07-local-auth-design.md](07-local-auth-design.md) §3 |
| Windows Service（SCM 守护） | **无** | Grep `CreateService/OpenSCManager/WinSW/NSSM` 无匹配 |
| ed25519 / x25519 长期设备密钥 | **无** | 设备身份靠随机 token + RSA-3072 自签 TLS 证书；Cargo 无 ring/ed25519/x25519（注释明确规避 ring/aws-lc-rs：本机构建无 nasm/cmake） |
| 统一「个人设备中枢」实体 | **无** | 代码中 Hub 指 `AgentHub` / `ProjectHub`，不是以个人设备为中心的中枢；`hub_health` 只返回 Agent 计数 |

### 2.2 Android 端

| 能力 | 状态 | 证据与说明 |
|---|---|---|
| 配对与设备身份 | **有** | `src/lib/sync/pairing.ts::parsePairingUri()`、`pairClient.ts::pairWithDesktop()`、`src/db/syncConnection.ts::loadOrCreateDeviceUid()`（安装级随机 UUID 存 SQLite `kv['device.uid.v1']`） |
| 令牌受 Keystore 保护 | **有** | `expo-secure-store`（底层 Android Keystore / AES-GCM），key `taskdock.sync.token.v1`；连接元数据（含已钉 SPKI 指纹）存 SQLite |
| HTTPS + SPKI 固定 | **有** | `modules/secure-http/.../SecureHttpModule.kt::PinnedTrustManager.checkServerTrusted()` = `SHA256(leaf.publicKey.encoded)` 比对 64 hex pin；缺指纹三入口 fail-closed |
| 端到端加密信封 | **有** | `src/lib/sync/crypto.ts`：同源派生 + XSalsa20-Poly1305 + 方法/路径 AAD |
| 增量同步 / 单飞 / 退避 | **有** | `engine.ts::syncNow()`、`autoSync.ts`（仅前台，AGENTS 明确禁止后台常驻）、`src/db/sync.ts` outbox 同事务 |
| 分块文件互传 + SHA-256 复核 | **有** | `src/lib/sync/files.ts`、`fileIo.ts`、`sha256.ts` |
| 设备私钥 / 非对称密钥对 | **无** | Android 端不生成密钥对；密钥材料只在桌面端（`mobile_tls/{cert,key}.pem`，RSA-3072） |
| BiometricPrompt / 设备凭据校验 | **无** | Manifest 的 `USE_BIOMETRIC` 仅 expo-secure-store 传递权限；`src/` 无 `BiometricPrompt`/`requireAuthentication` 调用 |
| MediaProjection / 屏幕采集 | **无** | 全量 grep 零命中；PoC 文档 `docs/validation/ANDROID_VIRTUAL_DISPLAY_POC.md` 确认 |
| AccessibilityService（输入注入） | **无** | 无 `BIND_ACCESSIBILITY_SERVICE` 权限与类 |
| VpnService / WireGuard / UDP 隧道 | **无** | Manifest/代码零命中；`NetworkStateModule.kt` 的 `"vpn"` 仅网络类型判定 |
| 后台常驻 / 前台服务 | **无（且被规范禁止）** | `apps/mobile/AGENTS.md` §1、`docs/mobile/11-background-sync-design.md` |
| 发布签名 / 代码保护 | **弱** | `android/app/build.gradle:112-115` release 仍用 debug keystore，`R8` 默认关闭（minify=false） |

---

## 3. 现有可复用基础（Personal Hub 的地基）

按规格的安全要求，以下现有实现可直接复用或作为范式（不是从零）：

1. **强制本地认证的现成范式**：`mobile_sync` 的「用户显式开启 → 一次性码(120s/5 次) → 256 位令牌 → 只存哈希 → Bearer 鉴权 → 撤销」，可作为设备 enrolment 内核。
2. **零信任传输内核**：TLS-only + SPKI 指纹固定 + fail-closed（Windows `tls.rs` + Android `SecureHttpModule.kt`），是全仓库最贴近规格要求的安全信道，可直接承载 Hub 控制面。
3. **端到端加密工具箱**：Argon2id / AES-256-GCM / XSalsa20-Poly1305 / HKDF / HMAC / SHA-512 域分离 / zeroize；`secure_vault/crypto/*` 的 DEK/KEK envelope 可作本地主密钥封装参考。
4. **Windows 身份与锁屏信号**：DPAPI 已用；`WTS_SESSION_LOCK` 已用于锁屏即锁保险箱，可作「强制本地认证」触发信号源。
5. **异步生命周期纪律**：可取消、有超时、有上限、可回收的 supervisor 模式，符合 `AGENTS.md` §4.8。
6. **投屏执行端**：ADB+scrcpy 会话管理、`vd_nav` display-id 约束、`SetParent` 一体化——可作未来 Android 远控执行端参考（但受 C1 约束）。
7. **审计/脱敏纪律**：`mcp/audit.rs`、备份 `BACKUP_TABLES` 敏感表空 section 策略、`AGENTS.md` §7 禁写敏感数据。

---

## 4. 安全红线冲突清单（规格 vs 现状，必须先分析再决策）

> 规格开发纪律第 12 条：「不允许删除现有功能来规避架构冲突。如果发现现有架构与安全要求冲突，先提交风险分析和迁移方案，不得直接降低安全标准。」
> 以下冲突只做**风险分析**，把决策留给 [00-phase0-verdict.md](00-phase0-verdict.md) 与用户，不擅自降低安全标准。

### C1 — 投屏路线：ADB+scrcpy（单向 shell 下发） vs 被控端 Agent（MediaProjection + AccessibilityService）

- **现状**：屏幕控制是桌面借 ADB+scrcpy 对手机的**单向下发**，手机是被 shell（uid 2000 `com.android.shell`）控制的被动一端；手机 APK 无被控端 Agent。
- **规格要求**：Android 被控端用 BiometricPrompt 本地认证 + MediaProjection 屏幕采集 + AccessibilityService 输入注入，且手机处于锁屏时不得绕过。
- **冲突点**：scrcpy 通过 ADB 在锁屏/开发者模式下工作，与本规格「必须本机唤醒解锁并完成授权」的语义不同；PoC 已论证 MediaProjection 有 FLAG_SECURE/DRM 黑屏限制、不能替代 scrcpy（`docs/validation/ANDROID_VIRTUAL_DISPLAY_POC.md:322-323`）。
- **风险分析**：两条路线不是简单替换关系；直接废弃 scrcpy 会删除现有功能并损害可用性，直接沿用 scrcpy 又达不到本地认证硬门槛。
- **迁移方向待决策**：并行双栈（scrcpy 保留为开发/调试能力，新建被控端 Agent 承载合规远控） vs 单一路线。见 ADR-0003。

### C2 — Android 技术栈：Expo/RN vs 规格假设的原生 Kotlin

- **现状**：`apps/mobile` 是 RN 应用，原生代码仅 8 个 Expo Module。
- **规格要求**：多处写「Kotlin 原生桥接」「BiometricPrompt」「VpnService Tunnel Library」。
- **冲突点**：规格描述的实现载体与实际不符；强认证/隧道必须新增 Kotlin 原生模块 + JS bridge，且 release 用 debug keystore、R8 关闭会削弱完整性保护。
- **迁移方向待决策**：在现有 Expo Module 体系内新增 4 类原生模块，还是为远控被控端另建独立原生组件。见 ADR-0004。

### C3 — 后台服务：应用内任务 vs Windows Service

- **现状**：仅 autostart Run 键 + 应用内 supervisor；无 SCM 服务。
- **规格要求**：独立后台服务、自动启动、健康检查、异常恢复、服务停止保护。
- **冲突点**：Windows Service 需要安装/提权，与「桌面应用便携安装」定位有张力；且 `AGENTS.md` §5.3「安装/升级/卸载未经授权不执行」。
- **迁移方向待决策**：真 Windows Service vs 登录自启的独立进程 + 看护。见 ADR-0005。

### C4 — 云端与组网：无信令/中继 + 无 WireGuard，且构建工具链受限

- **现状**：无云端信令/发现/中继；无 WireGuard；Cargo 注释规避 ring/aws-lc-rs（本机构建无 nasm/cmake）。
- **规格要求**：轻量云端（注册/信令/发现/NAT 穿透协调/必要中继）+ WireGuard 加密虚拟网络 + 分流。
- **冲突点**：WireGuard 实现（尤其 WireGuardNT / wintun）与当前工具链、以及「不接管全部流量」的分流策略均需重新评估；云端是新基础设施与持续成本。
- **迁移方向待决策**：WireGuardNT vs 用户态隧道 vs 阶段 4 再定；云端自建 vs 延后。见 ADR-0006 / ADR-0007。

### C5 — Windows Hello 可用性：规格强制 vs 实测障碍

- **现状**：无任何系统强认证；Windows Hello 桌面路径需 `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd, msg)`，windows-rs 有 `Class not registered` 历史实测障碍（详见 [07-local-auth-design.md](07-local-auth-design.md) §3）。
- **规格要求**：优先 Windows Hello，接口不可用时设计明确的本地认证降级（独立 TaskDock 本地授权凭证），**禁止模拟系统密码窗口**。
- **冲突点**：需在阶段 5 开发前做真机 PoC 验证；不能假设可用，也不能因不可用就跳过认证。
- **迁移方向**：Windows Hello 优先 + 明确降级（DPAPI 保护的本地授权凭证 + 用户本机确认），两条都必须落到状态机 `LOCAL_AUTH_REQUIRED`。见 ADR-0002。

---

## 5. 阶段 0 结论

- 现状**不是**一张白纸：有可复用的安全积木（零信任传输、配对、加密、生命周期纪律），这些降低了部分建设成本。
- 但规格的**核心能力（远程控制 + 强制本地认证 + 组网 + 云端）几乎全部缺失**，且存在 **5 处根本性冲突（C1–C5）**，其中 Android 技术栈（C2）和投屏路线（C1）需要用户先拍板，否则后续方法级设计与阶段 1–8 计划会建立在错误前提上。
- **阶段 0 不进入任何业务代码实现**；先请用户对 [00-phase0-verdict.md](00-phase0-verdict.md) 列出的关键决策作出选择，再进入阶段 1。
