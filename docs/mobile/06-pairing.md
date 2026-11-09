# 手机配对与局域网连接（v0.16）

> 状态：**已实现配对与连接闭环**（2026-11-08）。数据同步（任务/笔记 pull/push）仍属下一轮，
> 本文不把「已配对」写成「已同步」。手机端规范入口见 [README.md](README.md)。

## 1. 范围

| 已实现 | 未实现（下一轮） |
|---|---|
| 桌面端生成二维码 + 6 位配对码（120s TTL） | 任务/收集箱/笔记的增量同步、冲突合并、墓碑 |
| 手机端应用内扫码（expo-camera）与手动输码 | 系统相机深链之外的发现（mDNS） |
| 桌面端授权设备落库、列表、撤销 | TLS / SPKI 指纹固定（本轮为局域网 HTTP，见 §5） |
| 手机端令牌进 SecureStore、连接元数据进 kv | 后台同步、远程推送、剪贴板传输 |
| `/v1/ping` 连通性测试与最近连接时间 | 设备重命名、二维码刷新轮换 |

**桌面端是配对发起方与授权中心**；手机端只能接受授权，不能自行声明已配对。

## 2. 端到端流程

```
桌面端：标题栏「配对新设备（手机）」 或 设置 → 手机与同步
  1) 开启「允许手机连接」（默认关闭）；标题栏入口在服务未开启时会直接给出开启按钮
  2) 主管任务绑定 0.0.0.0:<port>（默认 47822），状态变为运行中
  3) 点「配对新设备」→ 生成一次性码 + 二维码
        QR = taskdock://pair?v=1&host=<LAN IPv4>&port=<port>&code=<6位>
             &name=<URL编码设备名>&instance=<实例ID>&fp=<8位十六进制展示指纹>
  4) 弹层每 1s 轮询状态；配对成功显示设备名，关闭弹层即结束会话

手机端：设置 → 手机与同步 → 配对新设备
  1) 「扫描二维码」申请相机权限后取景；或「手动输入」填地址 + 6 位码
  2) 扫码成功 → 确认页（设备名 / 地址 / 配对码 / 展示指纹）→ 确认配对
  3) POST /v1/pair {code, device_name, platform}
  4) 成功后令牌写 SecureStore，其余元数据写 kv；显示「配对成功」
  5) 同步页可「测试连接」→ GET /v1/ping；可「解除本机配对」
```

桌面端配对弹层是 App 根部常驻的**唯一实例**（`MobilePairingDialog`），标题栏快捷入口与
设置分区共用；关闭/成功后广播变更事件，设置分区据此刷新状态与设备列表。极简模式保持
「只有窗口操作」，不渲染快捷入口，可切到完整/紧凑模式使用。

系统相机扫描 `taskdock://pair?...` 也会经 scheme 深链唤起 App（`App.tsx` 的
`Linking.getInitialURL` / `url` 事件）；应用内扫码是主路径。

## 3. API（v1）

### 3.1 POST /v1/pair（无需令牌）

```json
// 请求（上限 4KB）
{ "code": "482913", "device_name": "Android 手机", "platform": "android" }

// 200
{ "token": "<64 位十六进制>", "device_id": "<uuid>", "server_name": "DESKTOP-PC",
  "api_version": 1, "paired_at": "2026-11-08T14:30:00Z" }
```

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
{ "ok": true, "api_version": 1, "server_name": "DESKTOP-PC",
  "device_id": "<uuid>", "device_name": "Android 手机", "now": "..." }
```

令牌无效/已撤销返回 401 `unauthorized`。成功会刷新桌面端 `last_seen_at` 与 `last_ip`。

### 3.3 GET /v1/health

无鉴权，只返回 `{ok, service, api_version}`，用于连通性诊断；不暴露设备或用户数据。

## 4. 本地数据

### 桌面端（SQLite v42）

```sql
CREATE TABLE mobile_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256(令牌)，绝不存明文
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  revoked_at TEXT                    -- 软删除，立即失效
);
```

- 迁移只追加 v42，不改历史迁移；旧库升级后空表可用。
- `mobile_devices` 已登记 `BACKUP_TABLES`，但按 `is_local_transient_table` 处理：备份只写
  空 section，不把令牌哈希迁移到其他机器；恢复旧备份也不会写回设备信任。
- 设备名/平台只作展示；`last_ip` 只用于「最近连接」诊断，不参与鉴权；HWND/PID 不落库。

### 手机端

| 数据 | 位置 | 键 |
|---|---|---|
| 设备令牌 | `expo-secure-store`（Android Keystore） | `taskdock.sync.token.v1` |
| 连接元数据 | SQLite `kv` | `sync.connection.v1` |

元数据只含 `baseUrl/host/port/serverName/deviceId/platform/instanceId/fingerprint/pairedAt/
lastSeenAt`，不含配对码。`clearConnection()` 同时删除令牌与元数据；任一步失败会向 UI 报错。

## 5. 安全边界与已知偏差

### 5.1 传输：局域网 HTTP（本轮明确偏差）

设计稿（[../MOBILE_STACK.md](../MOBILE_STACK.md) §3.1）要求 TLS + 指纹固定；本轮按用户确认
的 v1 基线使用 **HTTP**，原因：

- 手机端 Expo/RN 的 `fetch` 无法对「运行时生成的自签证书」做 SPKI 固定，需要额外原生网络
  模块（本轮不引入）；桌面端也没有现成 TLS 监听。
- 本轮只传配对码与令牌，不传业务数据；先验证配对闭环，再单独做 TLS。

威胁模型（可信局域网假设）：

| 风险 | 现状 | 缓解 |
|---|---|---|
| 同网段被动嗅探配对码/令牌 | 明文可见 | 一次性码 + 120s TTL + 5 次尝试；令牌只在成功响应出现一次；不写日志 |
| 同网段中间人替换桌面端 | 无证书校验 | 手机确认页展示桌面端设备名/指纹（**展示用途，不是密码学固定**） |
| 陌生人爆破 6 位码 | 1e6 空间 | 会话级 5 次尝试上限；会话只在用户点配对后存在 120s |
| 桌面端误开放到公网 | — | 默认关闭；只绑 LAN IPv4；Windows 防火墙建议只允许专用网络 |
| 令牌落盘泄露 | — | 桌面只存 SHA-256 哈希；手机存 Keystore；撤销立即失效 |

**用户要求**：只在可信 Wi-Fi 使用；不要把端口映射到公网；后续版本升级为 TLS + 指纹固定后，
本文的偏差条目必须改为「已消除」并保留历史记录。

### 5.2 其他边界

- 手机端不信任服务端返回的任意字段：`api_version` 必须为 1、令牌必须 64 位十六进制、
  缺少 `device_id/server_name/paired_at` 直接报 `invalid_response`。
- 桌面端配对成功后立即作废配对码（单次使用）；取消/重新生成会让并发中的配对请求失败，
  已落库设备会补偿删除。
- 关闭开关后 `complete_pairing` 先读设置 fail-closed，避免监听循环 2s 退出窗口内继续授权。
- 日志只记录方法/路径/状态与失败分类，不记录 Authorization、请求体、配对码、令牌、设备名。

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

- 桌面端：SQLite v42 追加表；设置键 `mobile_sync_enabled` / `mobile_sync_port` 带默认值，
  旧库无键可正常反序列化；不修改既有命令签名。
- 手机端：无数据库迁移（只用 `kv` 与 SecureStore）；旧版本 App 不认识新二维码时不会误触，
  因为协议版本 `v=1` 与 App scheme 均需匹配。
- 备份：`mobile_devices` 不迁移令牌哈希；恢复旧备份后设备需要重新配对（预期行为）。

## 8. 验收证据（2026-11-08）

| 项 | 命令/通道 | 结果 |
|---|---|---|
| Rust 单元测试（配对/令牌/撤销/过期/取消/关闭 fail-closed） | `cargo test --lib mobile_sync::`（`src-tauri/`，隔离 `CARGO_TARGET_DIR`） | **9/9 PASS** |
| Rust 全量单元测试 | `cargo test --lib`（同上） | **1541 passed / 0 failed / 8 ignored** |
| 备份注册表 | `cargo test --lib backup_registry_covers_every_schema_table` | PASS（`mobile_devices` 已登记） |
| 桌面端类型检查 | `npx tsc --noEmit`（仓库根） | exit 0 |
| 二维码矩阵 | `src/lib/qr.test.ts` + OpenCV 独立解码 | 5 项单测 PASS；6/6 解码通过 |
| 二维码渲染截图 | OpenCV 解码 `desktop-pair-dialog.png` | 解出与弹层一致的 `taskdock://pair?...code=427498...` |
| 手机端类型检查 | `npm run typecheck`（`apps/mobile`） | exit 0 |
| 协议实测 | curl → `127.0.0.1:47922` | 错码 401 / 正确码 200 / ping 200 / 撤销后 401 |
| 双端闭环 | x86_64 模拟器（Release APK）+ 桌面隔离实例（CDP） | 手动配对、设置页刷新、连接测试、撤销失效、解除配对、相机权限与 CameraView 挂载 PASS |
| 配对快捷入口（2026-11-09） | 隔离 debug exe + CDP 真实 WebView2 | 标题栏一键打开、未开启时弹层内开启并生成二维码、设置入口共用同一弹层、400/320 宽标题栏无溢出 PASS |
| 真实物理手机 / 真实扫码 | 通道 D/C | **ENVIRONMENT BLOCKED**（无物理设备；模拟器相机为黑帧） |

详细命令、退出码与截图见 `tmp/acceptance/mobile-pairing/report.md`（`tmp/` 不入库）。

## 变更记录

- 2026-11-08 首版：配对与连接闭环（二维码、6 位码、设备撤销、SecureStore、/v1/ping）；
  明确局域网 HTTP 偏差与 TLS 后续计划；数据同步仍为未实现。
- 2026-11-09 配对入口前置：标题栏新增「配对新设备（手机）」快捷按钮（完整/紧凑模式），
  与设置分区共用 App 根部唯一配对弹层；服务未开启时可在弹层内一键开启并继续。
  协议、令牌与设置键均无变化；设置分区仍是设备管理（撤销/端口/状态）的唯一位置。
