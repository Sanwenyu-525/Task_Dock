# 手机配对与局域网连接（v0.16，2026-11-12 起传输硬切 TLS v2）

> 状态：**已实现配对与连接闭环**（2026-11-08）；**2026-11-12 起传输为 TLS-only（协议 v2）**，
> 二维码携带证书 SPKI 指纹，手机端从首个字节起固定桌面端身份。
> 数据同步见 [07-sync.md](07-sync.md)。手机端规范入口见 [README.md](README.md)。

## 1. 范围

| 已实现 | 未实现（下一轮） |
|---|---|
| 桌面端生成二维码 + 6 位配对码（120s TTL） | 字段级自动合并（任务/收集箱/笔记同步见 [07-sync.md](07-sync.md)） |
| **TLS-only 监听（自签证书 + schannel）+ SPKI 指纹固定（v2）** | 系统相机深链之外的发现（mDNS） |
| 手机端应用内扫码（expo-camera）与手动输码（无指纹时首用信任） | 后台同步、远程推送、剪贴板传输 |
| 桌面端授权设备落库、列表、撤销 | 设备重命名、二维码刷新轮换 |
| 手机端令牌进 SecureStore、连接元数据进 kv | 手机端下载后本地 SHA-256 复核（见 [08-file-transfer.md](08-file-transfer.md)） |
| `/v1/ping` 连通性测试与最近连接时间 | |

**桌面端是配对发起方与授权中心**；手机端只能接受授权，不能自行声明已配对。

## 2. 端到端流程

```
桌面端：标题栏「配对新设备（手机）」 或 左侧导航「手机互传」
  1) 开启「允许手机连接」（默认关闭）；标题栏入口在服务未开启时会直接给出开启按钮
  2) 主管任务绑定 0.0.0.0:<port>（默认 47822），状态变为运行中；
     首次启用时生成自签证书（RSA-3072，落盘 data_dir/mobile_tls/）并常驻
  3) 点「配对新设备」→ 生成一次性码 + 二维码
        QR = taskdock://pair?v=2&host=<LAN IPv4>&port=<port>&code=<6位>
             &name=<URL编码设备名>&instance=<实例ID>&fp=<8位展示指纹>
             &tls=<64位小写hex 证书SPKI SHA-256>
  4) 弹层每 1s 轮询状态；配对成功显示设备名，可「完成」关闭或「查看已配对设备」直接
     定位到 左侧导航「手机互传」

手机端：设备 → 配对新设备
  1) 「扫描二维码」申请相机权限后取景；或「手动输入」填地址 + 6 位码
  2) 扫码成功 → 确认页（设备名 / 地址 / 配对码 / TLS 指纹 / 展示指纹）→ 确认配对；
     连接从首个字节起按 tls= 指纹做 SPKI 固定，不匹配即拒绝（无明文回退）
  3) POST /v1/pair {code, device_name, platform, device_uid}（全程 TLS）
  4) 成功后令牌写 SecureStore，其余元数据（含 tlsFingerprint）写 kv；显示「配对成功」
  5) 同步页可「测试连接」→ GET /v1/ping；可「解除本机配对」
```

手动输码没有二维码携带的指纹：连接仍是 TLS，但首轮按**首用信任（TOFU）**建立，
配对成功后把连接上观察到的指纹（原生层回传）落库钉住后续同步。该窗口的中间人风险
见 §5.1；建议优先使用扫码配对。

桌面端配对弹层是 App 根部常驻的**唯一实例**（`MobilePairingDialog`），标题栏快捷入口与
设置分区共用；关闭/成功后广播变更事件，设置分区据此刷新状态与设备列表。极简模式保持
「只有窗口操作」，不渲染快捷入口，可切到完整/紧凑模式使用。

系统相机扫描 `taskdock://pair?...` 也会经 scheme 深链唤起 App（`App.tsx` 的
`Linking.getInitialURL` / `url` 事件）；应用内扫码是主路径。

## 3. API（v2）

> v1 → v2 的唯一协议变化是传输层（明文 HTTP → TLS-only）与二维码新增 `tls=` 参数；
> 请求/响应字段结构未变。v1 客户端连 v2 服务端会在 TLS 握手处失败（不再有明文监听）。

### 3.1 POST /v1/pair（无需令牌）

```json
// 请求（上限 4KB）
{ "code": "482913", "device_name": "Android 手机", "platform": "android",
  "device_uid": "0f8fad5b-d9cb-469f-a165-70867728950e" }

// 200
{ "token": "<64 位十六进制>", "device_id": "<uuid>", "server_name": "DESKTOP-PC",
  "api_version": 2, "paired_at": "2026-11-08T14:30:00Z" }
```

`device_uid` 是手机端持久化的安装级标识（8–64 位 ASCII 字母/数字/`-`/`_`，可选）。
桌面端在配对成功、会话确认后撤销同一 uid 此前的有效记录，列表只保留最新一条，旧令牌
立即失效；旧客户端不传该字段时保持原有「每次配对新增一条」的行为。撤销记录是软删除，
保留审计历史。

错误码（HTTP 状态）：

| error | 状态 | 含义 |
|---|---|---|
| `invalid_request` | 400 | JSON/字段不合法 |
| `invalid_code` | 401 | 配对码错误，仍可重试（累计 5 次后转 `too_many_attempts`） |
| `too_many_attempts` | 429 | 尝试次数耗尽，需桌面端重新生成 |
| `pairing_closed` | 409 | 没有活动会话、已过期、已使用或已取消 |
| `internal_error` | 500 | 落库/任务失败；可重试 |

### 3.2 GET /v1/ping（Bearer 设备令牌）

```json
{ "ok": true, "api_version": 2, "server_name": "DESKTOP-PC",
  "device_id": "<uuid>", "device_name": "Android 手机", "now": "..." }
```

令牌无效/已撤销返回 401 `unauthorized`。成功会刷新桌面端 `last_seen_at` 与 `last_ip`。

### 3.3 GET /v1/health

无鉴权，只返回 `{ok, service, api_version}`，用于连通性诊断；不暴露设备或用户数据。

## 4. 本地数据

### 桌面端（SQLite v42 / v46）

```sql
CREATE TABLE mobile_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256(令牌)，绝不存明文
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  revoked_at TEXT,                   -- 软删除，立即失效
  device_uid TEXT                    -- v46：手机端安装标识，NULL=旧客户端/旧记录
);
```

- 迁移只追加 v42/v46，不改历史迁移；旧库升级后空表可用，旧记录 `device_uid` 为 NULL。
- `mobile_devices` 已登记 `BACKUP_TABLES`，但按 `is_local_transient_table` 处理：备份只写
  空 section，不把令牌哈希迁移到其他机器；恢复旧备份也不会写回设备信任。
- 设备名/平台只作展示；`last_ip` 只用于「最近连接」诊断，不参与鉴权；HWND/PID 不落库。
- `device_uid` 是手机端生成的安装级随机标识，不是硬件序列号，也不参与鉴权；只在重新配对时
  用于撤销同一安装的旧授权。

### 手机端

| 数据 | 位置 | 键 |
|---|---|---|
| 设备令牌 | `expo-secure-store`（Android Keystore） | `taskdock.sync.token.v1` |
| 连接元数据 | SQLite `kv` | `sync.connection.v1` |
| 安装级设备标识 | SQLite `kv` | `device.uid.v1` |

元数据只含 `baseUrl/host/port/serverName/deviceId/platform/instanceId/fingerprint/
tlsFingerprint/pairedAt/lastSeenAt`，不含配对码；`tlsFingerprint` 是已钉住的桌面端证书
SPKI SHA-256（v2 扫码配对必有；手动输码配对在首轮连接后落库，v1 遗留记录为空串）。
`device.uid.v1` 为随机 UUID，解除配对不清除。`clearConnection()` 只删除令牌与连接元数据；
任一步失败会向 UI 报错。

## 5. 安全边界

### 5.1 传输：TLS-only + SPKI 指纹固定（v2，2026-11-12 起已实现）

> 历史：2026-11-08～2026-11-11 的 v1 基线为局域网明文 HTTP（当时记录为「明确偏差」）。
> 2026-11-12 的 v2 硬切 TLS 后该偏差**已消除**；v1 偏差记录保留在本文末尾变更记录中。

实现要点：

- **桌面端**（`src-tauri/src/mobile_sync/tls.rs`）：首次启用时生成持久自签证书
  （RSA-3072 + SHA-256 签名，CN=TaskDock Mobile Sync，10 年有效期，剩余 <30 天整体轮换），
  落盘 `data_dir/mobile_tls/{cert.pem,key.pem}`，不进数据库与备份。监听经
  native-tls（Windows schannel）acceptor 完成 TLS 握手；**没有明文监听、没有静默降级**，
  明文客户端在握手处被直接断开。选 RSA 而非 ECDSA 的原因：native-tls 的 Windows 后端
  经 legacy CryptoAPI 导入私钥，不支持 EC 密钥（实测报 ASN.1 错误）。
- **服务端身份 = 证书 SPKI（SubjectPublicKeyInfo DER）的 SHA-256**，64 位小写 hex，
  通过二维码 `tls=` 参数离线送达。二维码经「屏幕 → 相机」的短时信道 + 一次性 6 位码
  双保险，攻击者无法在不被发现的情况下替换指纹。
- **手机端**（`apps/mobile/modules/secure-http/`，本地 Expo 模块）：Kotlin
  `HttpsURLConnection` + 自定义 `X509TrustManager`，校验
  `SHA-256(certificate.publicKey.encoded) == pin`（`publicKey.encoded` 即 SPKI DER，
  与桌面端同一份字节）；不依赖系统根证书库，指纹就是信任锚。只接受 `https://` URL。
- **同步密钥不变**：仍由设备令牌哈希派生（`SHA-512("taskdock-sync-v1:" + SHA256(token))[0..32]`），
  信封（XSalsa20-Poly1305）保留为第二层。TLS 已切断 token 嗅探链后，KDF 无需更换；
  「独立 sync_key（服务器不持 KDF 输入）」列为后续增强项，本轮不实现。
- 令牌轮换与撤销：撤销设备 = 服务端删授权（软删除 `revoked_at`，令牌立即失效）；
  重新配对 = 同 `device_uid` 替换旧授权（旧令牌立即失效，列表只保留最新一条）。
  升级到 v2 后用户只需重新扫码配对，本机 SQLite 数据与配对记录不受影响
  （重新配对只更新传输凭据，走现有 `syncConnection` 存储路径）。

威胁模型（配对 → 发放 → 鉴权 → 同步 → 文件 → 撤销/轮换）：

| 风险 | 现状 | 缓解 |
|---|---|---|
| 同网段被动嗅探配对码/令牌 | **已消除** | 全程 TLS；令牌只在成功响应出现一次；不写日志 |
| 同网段中间人替换桌面端（扫码路径） | **已消除** | 从首个字节起 SPKI 固定，指纹经二维码离线送达；不匹配即断 |
| 同网段中间人（手动输码首轮） | 残留窗口 | TLS 强制但无预置指纹（首用信任）；配对完成后指纹落库钉住；建议优先扫码 |
| 陌生人爆破 6 位码 | 1e6 空间 | 会话级 5 次尝试上限；会话只在用户点配对后存在 120s |
| 桌面端误开放到公网 | — | 默认关闭；只绑 LAN IPv4；Windows 防火墙建议只允许专用网络 |
| 令牌落盘泄露 | — | 桌面只存 SHA-256 哈希；手机存 Keystore；撤销立即失效 |
| 私钥/证书文件被读取 | 本机攻击面 | `data_dir/mobile_tls/` 随用户数据目录权限；文件损坏时整体重建并要求重新配对 |
| 协议降级（旧明文客户端） | 不可能 | v2 无明文监听；v1 客户端连接直接失败并得到升级提示 |
| 证书/密钥入日志 | 禁止 | 日志只允许公开的 SPKI 指纹；证书内容、私钥、令牌、配对码不落日志 |

### 5.2 其他边界

- 手机端不信任服务端返回的任意字段：`api_version` 必须为 2、令牌必须 64 位十六进制、
  缺少 `device_id/server_name/paired_at` 直接报 `invalid_response`。
- 手机端连接 URL 只接受 `https://`：v1 遗留的 `http://` 连接元数据在客户端即被拒绝，
  提示「桌面端协议已升级，请重新扫码配对」。
- 桌面端配对成功后立即作废配对码（单次使用）；取消/重新生成会让并发中的配对请求失败，
  已落库设备会补偿删除。
- 关闭开关后 `complete_pairing` 先读设置 fail-closed，避免监听循环 2s 退出窗口内继续授权。
- 日志只记录方法/路径/状态与失败分类，不记录 Authorization、请求体、配对码、令牌、设备名；
  TLS SPKI 指纹是公开值，允许出现在日志与状态接口中。

## 6. 生命周期与故障

- **启用**：设置写入 → 主管任务 1s 内读取 → `TcpListener::bind(("0.0.0.0", port))` →
  `running=true`。绑定失败（端口占用/权限）状态显示错误，5s 重试，不崩应用。
- **端口变更**：监听循环每 2s 比对设置，变更后退出并由主管重新绑定；配对会话作废。
- **关闭**：监听循环退出、会话清空；已配对设备保留在桌面端列表（可撤销），手机端仍存令牌
  但连接会失败。
- **应用退出**：复用 `shutdown_signal`，先停监听再退出；无悬挂任务。
- **防火墙**：首次绑定可能弹出 Windows 防火墙询问；本应用不自动写防火墙规则（需管理员权限，
  属系统安全设置），由用户选择允许专用网络。
- **多网卡**：默认路由网卡的 IPv4 用作二维码地址；若手机与桌面不在同一网段，改用手动输入
  正确地址。
- **手机端失败提示**：网络/超时 → 检查同一 Wi-Fi、地址、防火墙；`invalid_code` → 核对 6 位码；
  `pairing_closed/too_many_attempts` → 桌面端重新生成；401 → 桌面端已撤销，需要重新配对。

## 7. 兼容性

- 桌面端：SQLite v42/v46 表与设置键不变；不修改既有命令签名；TLS 证书为文件态
  （`data_dir/mobile_tls/`），不新增设置键、不新增数据库迁移。
- **旧 APK（v1）连接新桌面端**：端口不变（47822），但明文 HTTP 在 TLS 握手处失败，
  得到连接层错误（不再有任何明文监听）；需要升级 APK 并**重新扫码配对**。
  预发布阶段该破坏性变更是有意为之（硬切 + 重新配对可接受）。
- **新 APK（v2）连接旧桌面端（v1）**：二维码 `v=2` 不匹配被拒；手动输码后 `/v1/pair`
  返回 `api_version: 1`，客户端报「桌面端协议过旧（v1 明文），请升级桌面端后重新生成二维码」。
- 重新配对与 Token 轮换：撤销设备 = 服务端软删除授权；重新配对 = 同 `device_uid`
  替换旧授权（旧令牌立即失效）。升级 v2 只影响传输凭据，本机 SQLite 数据不丢。
- 备份：`mobile_devices` 不迁移令牌哈希；TLS 证书不进备份；恢复旧备份后设备需要
  重新配对（预期行为）。

## 8. 验收证据

### 2026-11-13（真机 v2 收口，本轮）

| 项 | 命令/通道 | 结果 |
|---|---|---|
| 桌面 v2 服务真实运行 + 明文 fail-closed | 隔离实例 + `adb reverse` + 手机 `curl` | PASS（TLS 握手 200 `{"api_version":2}`；明文连接 0 字节断开） |
| **TLS 叶证书修复** | 真机 `curl -v` 观察握手 | 旧 CA 根证书被 Android 拒绝（`KEY_USAGE_BIT_INCORRECT`）；改 `Profile::Leaf` 后握手成功。8 项 TLS 单测（含叶证书扩展断言与代际轮换）PASS |
| **secure-http 方法/头部/请求体落地** | 真机配对（深链=扫码等价载荷，预置 SPKI 指纹） | 修复前 POST /v1/pair 变 GET → 405「方法不允许」；修复后配对 200，桌面设备列表出现「Android 手机」 |
| 配对成功与令牌持久化 | 手机 UI + 桌面 `mobile_sync_list_devices` | PASS（令牌入 SecureStore，桌面只存哈希；`last_ip=127.0.0.1`（reverse 通道）） |
| **重配对游标重置** | 重新配对后 pull | 修复前旧 cursor=44 > 新库 seq=3 → `pulled:0`；修复后 cursor 0→3、`applied:3` |
| 设备撤销即时失效 | 桌面撤销 → 手机刷新 | PASS（HTTP 401） |
| 撤销后重新配对恢复 | 再走深链配对 | PASS（设备列表恢复 1 台，同步恢复） |
| 环境备注 | Windows 防火墙 Private profile 未放行 LAN 入站 | 真机经 `adb reverse` 回环通道验证；真实局域网使用需放行桌面端入站或手动输码核对 IP |

### 2026-11-12（TLS v2，历史）

| 项 | 命令/通道 | 结果 |
|---|---|---|
| TLS 身份生成/持久/指纹稳定 | `cargo test --lib mobile_sync::tls`（`src-tauri/`，隔离 `CARGO_TARGET_DIR`） | **3/3 PASS** |
| TLS-only 集成测试（真实 TLS 握手、明文拒绝、陌生根拒绝、401、撤销 401、配对限流、op 重放幂等、错钥 400、pull 加密信封） | `cargo test --lib mobile_sync::server`（同上） | **9/9 PASS** |
| KDF 跨端固定向量 | `cargo test --lib mobile_sync::sync::tests::derive_key_matches_mobile_fixed_vector` ↔ `apps/mobile` vitest `crypto.test.ts` | 双端一致 PASS |
| 全量 Rust 单测 | `cargo test --lib`（同上） | **1589 passed / 2 failed（task_analytics 2 例，非本任务改动文件，基线既有/环境相关，见验收报告）/ 8 ignored** |
| 手机端单测（vitest + node:sqlite harness） | `npm test`（`apps/mobile`） | **93 passed / 0 failed** |
| 手机端类型检查 | `npm run typecheck`（`apps/mobile`） | exit 0 |
| 真机 TLS 配对/同步 | 通道 F | **未执行**（本机无连接真机/模拟器；Kotlin 模块未经编译验证，待集成构建） |

### 2026-11-08/09（v1 基线，历史证据）

| 项 | 命令/通道 | 结果 |
|---|---|---|
| Rust 单元测试（配对/令牌/撤销/过期/取消/关闭 fail-closed） | `cargo test --lib mobile_sync::`（`src-tauri/`，隔离 `CARGO_TARGET_DIR`） | **9/9 PASS** |
| Rust 全量单元测试 | `cargo test --lib`（同上） | **1541 passed / 0 failed / 8 ignored** |
| 备份注册表 | `cargo test --lib backup_registry_covers_every_schema_table` | PASS（`mobile_devices` 已登记） |
| 桌面端类型检查 | `npx tsc --noEmit`（仓库根） | exit 0 |
| 二维码矩阵 | `src/lib/qr.test.ts` + OpenCV 独立解码 | 5 项单测 PASS；6/6 解码通过 |
| 手机端类型检查 | `npm run typecheck`（`apps/mobile`） | exit 0 |
| 协议实测（v1 明文，历史） | curl → `127.0.0.1:47922` | 错码 401 / 正确码 200 / ping 200 / 撤销后 401 |
| 双端闭环 | x86_64 模拟器（Release APK）+ 桌面隔离实例（CDP） | 手动配对、设置页刷新、连接测试、撤销失效、解除配对、相机权限与 CameraView 挂载 PASS |
| 真实物理手机 / 真实扫码（2026-11-09） | 通道 D/C | **PASS**（vivo V2323A / Android 16，应用内扫码配对；证据 `tmp/acceptance/mobile-pairing-physical/`） |

> 注：v1 时期的「二维码渲染截图/协议实测」基于明文 HTTP 基线，仅供历史追溯；
> v2 起二维码内容与传输层均已变更，上述 v1 协议实测方法不再适用。

详细命令、退出码与截图见 `tmp/acceptance/mobile-pairing/report.md`（`tmp/` 不入库）。

## 变更记录

- 2026-11-08 首版：配对与连接闭环（二维码、6 位码、设备撤销、SecureStore、/v1/ping）；
  明确局域网 HTTP 偏差与 TLS 后续计划；数据同步仍为未实现。
- 2026-11-09 配对入口前置：标题栏新增「配对新设备（手机）」快捷按钮（完整/紧凑模式），
  与设置分区共用 App 根部唯一配对弹层；服务未开启时可在弹层内一键开启并继续。
  协议、令牌与设置键均无变化；设置分区仍是设备管理（撤销/端口/状态）的唯一位置。
- 2026-11-09 重新生成改为原地换码：不再先取消会话（原先会清空弹层内容造成一次闪烁），
  由 `start_pairing` 原子覆盖旧会话；新码返回后二维码按 code 重新挂载并轻微淡入，
  减少动态时无动画。配对 URI 只变更 6 位码，矩阵差异约 4%，代码与倒计时才是主要视觉信号。
- 2026-11-09 物理机闭环验证：vivo V2323A / Android 16 上应用内扫码配对成功，桌面端写入
  `mobile_devices`（`last_ip=192.168.5.7`）；手机点「连接测试」后 `last_seen_at` 刷新为
  `2026-11-09T04:03:34Z`；`am force-stop` 重启后仍为已配对（SecureStore 令牌持久化）。
  此前「真实物理手机 / 真实扫码」的 ENVIRONMENT BLOCKED 结论以本行为准，证据
  `tmp/acceptance/mobile-pairing-physical/`。
- 2026-11-09 任务同步落地：配对令牌哈希同时作为同步载荷的 KDF 输入（域分离前缀），
  新增 `/v1/changes`、`/v1/ops` 与 v43 变更日志；配对协议与设备表未变。详见
  [07-sync.md](07-sync.md)。
- 2026-11-09 收集箱/笔记同步：v44 变更日志覆盖 `notes` / `quick_capture_items`；
  配对协议、令牌存储与设备表均未变，现有配对无需重新扫码。
- 2026-11-09 配对成功态新增「查看已配对设备」：关闭弹层并切到「手机互传」页，
  不复制设备列表；设备行按 `last_seen_at` + 固定 2 分钟窗口显示「在线」，超窗回落
  「最近连接」/「尚未连接」。同步仍是无状态请求，不引入可配置的连接/断开时长；
  无新增设置键、协议或数据结构变化。
- 2026-11-09 配对去重：手机端生成并持久化安装级 `device_uid`（kv `device.uid.v1`，
  解除配对不清除），`/v1/pair` 可选携带；桌面端 v46 给 `mobile_devices` 增加
  `device_uid`，同 uid 重新配对在会话确认后撤销旧授权，列表只保留最新一条。
  旧客户端不传该字段时仍按原行为新增；历史记录该列为 NULL，不受影响。
- 2026-11-12 **传输硬切 TLS（协议 v2）**：桌面端自签证书（RSA-3072，schannel）+
  `handle_conn` TLS-only（明文握手即断，无明文回退）；二维码升级 `v=2` 并新增
  `tls=<SPKI SHA-256>`，手机端本地 Expo 模块 `secure-http` 按指纹固定桌面端身份，
  移除 `withCleartextTraffic` 明文放行插件。§5.1 的 v1「局域网 HTTP 明文偏差」
  自本日起**已消除**；旧 APK 需升级并重新扫码配对（见 §7）。手动输码路径为
  首用信任（残留窗口见 §5.1 威胁模型）。本轮未实现：证书透明化备份/轮换提醒 UI、
  mDNS 发现、手机端下载文件 SHA-256 复核。
- 2026-11-12 集成审计补充（缺指纹 fail-closed）：同步、文件互传与「连接测试」三条
  已认证路径在 `syncConnection.tlsFingerprint` 为空（手动配对未观察到 / 元数据损坏 /
  v1 旧记录）时**拒绝发送令牌**并提示重新扫码配对，不再以「首用信任」继续通信。
  首用信任仅保留在配对请求本身（尚无指纹可用）。回归用例：
  `src/lib/sync/__tests__/engine.test.ts`、`files.test.ts` 各 1 例。
  另：原生层证书/指纹失败沿 cause 链识别为 `E_PIN_MISMATCH`，界面给出
  「证书指纹不匹配（可能存在中间人）」提示；连接本身在此之前已经失败。
- 2026-11-13 真机收口（v2 首次在物理机跑通，发现并修复 2 个发布阻断 + 1 个 P2）：
  - **证书必须是 TLS 叶证书**：旧 `Profile::Root` 生成的是 CA 根证书（keyUsage 只有
    keyCertSign/cRLSign），Android/OpenSSL 严格校验握手直接失败
    （`KEY_USAGE_BIT_INCORRECT`，手机 `curl -v` 实测）；Node 桌面版校验宽松曾掩盖。
    现用 `Profile::Leaf`（digitalSignature+keyEncipherment，CA=false），并以
    `cert-generation=leaf-v1` 代际标记自动轮换旧证书（指纹变化，已配对设备需重新配对）。
  - **`SecureHttpModule` 落地请求方法/头部/请求体**：此前只配置 TLS/超时，
    `method`/`headers`/`body` 从未写到连接——POST /v1/pair 退化为 GET（405
    method_not_allowed）、Bearer 头丢失（同步/文件 401）、请求体为空。修复后真机
    配对、同步 push/pull、文件双向互传全部通过。
  - **重新配对重置增量游标**：旧连接 `sync.cursor.v1=44` 对新桌面实例（seq=3）无效，
    pull 恒为 0；现按连接身份（baseUrl/instanceId/deviceId）变化清空游标，同身份
    重复保存不重置（重放幂等）。
  - 环境：真机验证经 `adb reverse` 回环通道完成（本机 Windows Private profile 防火墙
    未放行 47822/47899 入站，日常实例同样不可达）；真实局域网使用需放行桌面端入站。
