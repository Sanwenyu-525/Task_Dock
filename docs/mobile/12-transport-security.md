# 传输安全（TLS-only + SPKI 指纹固定，协议 v2）

> 状态：**代码已实现并集成**（2026-11-12，`integration/mobile-final-acceptance`）。
> 证据来自 Rust/TS 自动化测试、`expo prebuild` 清单核验、Debug APK 构建，以及
> 2026-11-12 晚的真机 fail-closed 走查（vivo V2323A / Android 16）。
> **v2 扫码配对与同步端到端真机复验未执行**（当时桌面端未运行），本文不把构建层结论写成真机结论。
>
> 本文是手机端安全要求的索引与偏差清单；协议字段与端点细节见
> [06-pairing.md](06-pairing.md)、[07-sync.md](07-sync.md)、[08-file-transfer.md](08-file-transfer.md)。

## 1. 威胁模型

| 防护目标 | 手段 |
|---|---|
| 局域网被动嗅探（任务/笔记正文、文件名、分块内容、设备令牌） | TLS 通道 + 载荷信封加密（双层） |
| 主动中间人冒充桌面端（ARP/DNS 欺骗、伪造 AP） | 自签证书 + SPKI SHA-256 指纹固定（扫码离线传递，不经网络） |
| 明文降级 | 桌面端 TLS 握手先行、手机端只接受 `https://`，两端都不提供明文回退 |
| 令牌明文落盘 | 手机端仅存 SecureStore；桌面端只存 SHA-256 哈希 |
| 跨端点/跨分块重放 | 信封 AAD 绑定方法 + 完整路径；分块 AAD 绑定文件 id 与序号 |
| 已撤销设备继续访问 | `revoked_at` 软删除，撤销后请求返回 401 |

**非目标 / 残余风险**：流量元数据（端点、时序、体积）仍可见；设备被 root、桌面主机被攻破、
二维码在配对有效期内被拍照，均不在本层防护范围。

## 2. 信任锚

| 项 | 实现 | 位置 |
|---|---|---|
| 证书类型 | 自签 RSA-3072，有效期 3650 天 | `src-tauri/src/mobile_sync/tls.rs`（`RSA_KEY_BITS`、`CERT_LIFETIME_DAYS`） |
| 指纹定义 | `SHA-256(leaf.publicKey.encoded)`，即 SPKI DER，64 位小写 hex | 同上 `spki_fingerprint_from_cert_pem` |
| 证书文件 | `data_dir/mobile_tls/cert.pem`、`key.pem`；损坏/被篡改时整体重建 | 同上 `load_or_create` |
| 轮换 | 剩余有效期 ≤ 30 天（或文件不可解析）时**重新生成证书与私钥**，指纹随之改变，日志明确提示「已配对设备需重新配对」 | 同上 `cert_renewal_needed`、`RENEWAL_WINDOW` |
| 下发路径 | 配对二维码 v2 的 `tls=` 参数（离线信道）；二维码只含配对码（120 秒 TTL、配对成功后不可复用），**不含设备令牌** | `src-tauri/src/mobile_sync/mod.rs` `qr_payload` |
| 手机端持久化 | 指纹进 kv（`sync.connection`），令牌进 SecureStore | `apps/mobile/src/db/syncConnection.ts` |
| 手动输码 | 无 `tls=` 时首轮为 TOFU：仍是 TLS，但不比对指纹；由原生层回传观察到的指纹并由 JS 落库钉住 | `apps/mobile/src/lib/sync/pairClient.ts` |

## 3. 桌面端：TLS-only 监听

- 用户开启手机接入后监听 `0.0.0.0:{port}`，日志写明「TLS-only，仅局域网」；
  未开启时不监听（`mobile_sync/mod.rs`）。
- 每条连接**先完成 TLS 握手再解析 HTTP**；握手失败直接关闭，不返回任何 HTTP 响应
  （`mobile_sync/server.rs` `handle_conn`）。
- 并发占满时只关闭 TCP，不降级为明文或返回错误页。
- 自动化证据（`cargo test --lib mobile_sync::`）：
  - `tls_handshake_succeeds_and_health_reports_v2`
  - `plaintext_clients_get_no_http_response`
  - `untrusted_root_fails_handshake`（不受信根证书握手失败）
  - `generates_loadable_identity_with_stable_fingerprint`、`corrupted_files_are_regenerated`、
    `fingerprint_matches_spki_of_signing_key`（指纹与 SPKI 一致）

## 4. 手机端：强制 HTTPS + 指纹比对

原生模块 `apps/mobile/modules/secure-http/`（autolinking 链接，无 JS 回退路径）：

- 只接受 `https://`，明文 URL 直接以 `E_INSECURE_URL` 拒绝；
- `pin` 非空时用自定义 `X509TrustManager` 比对
  `SHA-256(leaf.publicKey.encoded)` 与钉住值，并校验 `leaf.checkValidity()`；
  自签证书不在系统根库，**指纹就是信任锚**；
- `instanceFollowRedirects=false`，避免跟随跳转绕过固定；
- 响应体上限 4 MB；按 `requestId` 支持取消（`interrupt` + 断开连接）；
- 模块内不输出 URL、证书、指纹或响应内容到日志；
- JS 层 `src/lib/sync/secureFetch.ts` 统一入口：pin 格式非法直接抛
  `AppError("validation")`；原生 `E_PIN_MISMATCH` 映射为
  「桌面端证书指纹不匹配（可能存在中间人），请重新扫码配对」。

## 5. fail-closed 契约（缺指纹即拒绝）

已配对连接必须持有 64 位 hex 指纹；**缺少指纹时在创建传输前失败**，不退回 TOFU、
不发送令牌：

| 入口 | 行为 | 位置 | 回归用例 |
|---|---|---|---|
| 同步 | `validation`：「缺少桌面端 TLS 指纹，请重新扫码配对后再同步」 | `src/lib/sync/engine.ts` | `engine.test.ts` → `syncNow（TLS 指纹 fail-closed）` |
| 文件互传 | 同上（延迟加载指纹，加载后仍为空即失败） | `src/lib/sync/files.ts` | `files.test.ts` → `文件传输 TLS 指纹 fail-closed` |
| 连接测试 | 发请求前校验指纹并 toast，不发起请求 | `src/screens/SyncScreen.tsx` | 同 engine/files 共用 `normalizeTlsFingerprint` |
| 扫码配对 | 二维码无 `tls=` 视为无效 v2 二维码 | `src/lib/sync/pairing.ts` | `pairing.test.ts`（含大写指纹归一化） |

指纹比对失败时不再被 `SSLHandshakeException` 掩盖为「普通网络错误」：Kotlin 沿异常
cause 链识别 `CertificateException` 并返回 `E_PIN_MISMATCH`（`SecureHttpModule.kt`
`isCertificateFailure`）。

## 6. 令牌与会话

- 配对成功后由桌面端签发令牌；手机端只写 SecureStore（Android Keystore 加密），
  不写 kv / SQLite / 日志（`syncConnection.ts`）。
- 令牌只出现在 `Authorization: Bearer` 头；桌面端按 `SHA-256(token)` 查
  `mobile_devices.token_hash`，明文不落库（`mobile_sync/mod.rs`、`server.rs`）。
- 撤销设备写 `revoked_at`；其令牌立即失效（`changes_with_revoked_device_returns_401`），
  伪造/失效令牌同样 401（`changes_with_invalid_token_returns_401`）。
- 同一 `device_uid` 再次配对会撤销该设备的旧记录，避免重装后留下可用旧令牌
  （`mobile_sync/mod.rs` 中 `device_uid` 更新语句）。
- 撤销后手机端表现为 401 → 需重新扫码配对；本地不会自动降级为明文或跳过校验。

## 7. 应用层加密

- 请求/响应均为 `{v,n,d}` 信封，XSalsa20-Poly1305；密钥
  `SHA-512("taskdock-sync-v1:" + token_hash_hex)[0..32]`，两端各自推导
  （`mobile_sync/sync.rs`、`apps/mobile/src/lib/sync/crypto.ts`）。
- AAD 绑定 `taskdock-sync-v1|METHOD|/path`；分块另绑定文件 id 与序号，
  换端点、换文件或换序号都会解密失败（跨端点重放无效）。

## 8. 已知偏差与残余风险

| 级别 | 项 | 说明 |
|---|---|---|
| 设计权衡 | 不校验主机名（`HostnameVerifier` 恒真） | 身份由 SPKI 指纹锚定；自签证书只有 CN，直连 IP 场景无法做有意义的名称比对。**未钉住指纹时不得连接**（§5） |
| 设计权衡 | 手动输码首轮 TOFU | 首次配对没有离线指纹信道；窗口期风险见 [06-pairing.md](06-pairing.md) §8。扫码 v2 从首个字节起即固定 |
| 已知 | 证书轮换等于指纹更换 | 10 年一次（或文件损坏时），已配对设备必须重新配对，没有在线换钉协议 |
| 已知 | 私钥以 PEM 存于应用数据目录 | 依赖宿主文件权限；主机被攻破时不在防护范围 |
| 已知 | 未显式限定 TLS 版本 | 由 Windows schannel 默认策略协商；未做 1.2/1.3 下限的单测断言 |
| 已知 | Debug APK 清单含 `usesCleartextTraffic=true` | 来自 Expo 生成的 `app/src/debug/AndroidManifest.xml`（Metro 调试用），非产品代码；`secure-http` 仍只放行 https。**Release 清单已核验不含该属性**（2026-11-13 `aapt2 dump xmltree`，app-release vc23） |
| 已修复（2026-11-13） | 自签证书必须是 TLS **叶证书** | 此前用 `Profile::Root` 生成 CA 根证书（keyUsage 只有 keyCertSign/cRLSign），Android/OpenSSL 严格校验握手直接失败（`KEY_USAGE_BIT_INCORRECT`，真机实测）；Node 桌面版 OpenSSL 校验宽松，模拟客户端曾掩盖该缺陷。现改用 `Profile::Leaf`（digitalSignature+keyEncipherment，CA=false），并以 `cert-generation` 代际标记自动轮换旧 CA 证书（指纹变化 → 已配对设备需重新配对） |
| 已修复（2026-11-13） | 手机端下载后无本地 SHA-256 复核 | 已在 JS 分块解密处实现流式 SHA-256（`src/lib/sync/sha256.ts`），下载完成与桌面清单比对，不匹配即删除半成品并报错（fail-closed）。真机 16KB 下载三方哈希一致 |
| 已修复（2026-11-13） | 手机端请求方法与头部未落到连接 | `SecureHttpModule.request` 曾只配置 TLS/超时，`method`/`headers`/`body` 从未应用：POST 退化为无头 GET（配对 405 method_not_allowed）、Bearer 丢失（同步/文件 401）。现已显式 `requestMethod`/`setRequestProperty`/`doOutput` + 工作线程写 UTF-8 body；真机配对/同步/文件全链路通过 |
| 已修复（2026-11-13） | 重新配对不重置增量游标 | 旧游标（如 44）指向新桌面实例的早期变更之外，pull 恒为 0；现按连接身份（baseUrl/instanceId/deviceId）变化重置 `sync.cursor.v1`，同身份重复保存不重置 |
| 环境要求 | 桌面端 LAN 入站需放行防火墙 | 真机验证在本机 Windows Private profile 未放行 47822/47899 时通过 `adb reverse` 回环通道完成；用户实际局域网使用需在 Windows 防火墙允许 task-dock 入站（或手动输码核对 IP）。不影响协议正确性，属部署前置条件 |

## 9. 安全验收矩阵

| 要求 | 实现 | 证据 | 状态 |
|---|---|---|---|
| 全部敏感通信走 TLS | 桌面握手先行 + 手机 https-only | Rust 3 例 + `secureFetch` 测试 | PASS（自动化） |
| 不得静默降级明文 | 无明文监听/无回退分支；`E_INSECURE_URL` | `plaintext_clients_get_no_http_response` | PASS（自动化） |
| 配对令牌不落明文 | SecureStore + `token_hash` | `token_hash_is_sha256_and_never_equals_token` | PASS（自动化） |
| 无效证书身份必须失败 | SPKI 比对失败 → `E_PIN_MISMATCH` | `untrusted_root_fails_handshake` + 映射测试 | PASS（自动化） |
| 缺指纹不得发送令牌 | 三入口 fail-closed | `engine.test.ts` / `files.test.ts` | PASS（自动化 + 真机：文件刷新拒绝并提示重新配对） |
| 撤销后立即失效 | `revoked_at` + 401 | `changes_with_revoked_device_returns_401` | PASS（自动化） |
| 重新配对流程 | 二维码/输码 + 同 uid 撤销旧记录 | 配对解析与设备测试 | PASS（自动化） |
| 旧 v1 连接不得显示健康态 | `isLegacyConnection`（http 或缺指纹） | 设备/同步/任务/笔记/收集箱/设置六处统一 | PASS（真机 2026-11-12） |
| 真机 v2 配对 + 同步 + 文件互传端到端 | TLS-only + SPKI 固定 + 叶证书 | vivo V2323A/Android16 ↔ 真实桌面服务（`adb reverse` 通道）：TLS 握手 200、深链预置指纹配对、双向同步（push 桌面落库 / pull cursor 0→3）、文件互传双向 SHA-256 一致、撤销即时 401、撤销后重配对恢复 | **PASS（真机 2026-11-13）** |

## 变更记录

- 2026-11-12 首版：整合 `agent/mobile-stability-fix` 的 TLS v2 成果与集成期审计修复，
  把散落在 06/07/08 的安全要求收成单一索引，并列出 6 项已知偏差与 1 项真机阻塞。
- 2026-11-12 真机补充：旧 v1 `http://` 连接在设备页/同步页/任务/笔记/收集箱/设置六处统一
  显示「需重新配对」并拒绝发请求（新增 `isLegacyConnection` + 5 条用例）；v2 配对/同步/
  文件互传端到端仍未执行（桌面端未运行）。
- 2026-11-13 真机收口（本轮）：v2 端到端首次在物理机跑通，过程中发现并修复两个发布阻断
  缺陷——**CA 根证书被 Android 拒绝**（改叶证书 + 代际轮换）与 **secure-http 未落地
  method/headers/body**（405/401 全断）；同时修复重配对游标不重置（P2）与手机端下载
  SHA-256 复核（原增强项）。Release APK 首次产出并核验清单无明文属性。真机验证经
  `adb reverse` 通道完成（本机防火墙 Private profile 未放行 LAN 入站），用户实际使用需
  放行桌面端入站。
