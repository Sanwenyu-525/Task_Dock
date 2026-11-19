# ADR-0004：Android 实现载体与发布签名

- 日期：2026-11-19
- 状态：**Accepted**（按架构基线第 17 节锁定；基线 D3）
- 决策人：产品/架构负责人
- 关联：[ARCHITECTURE_BASELINE_v1.0.md](../ARCHITECTURE_BASELINE_v1.0.md) D3/§5.1、[12-android-method-design.md](../12-android-method-design.md)、[06-threat-model.md](../06-threat-model.md) R5

## Context

`apps/mobile` 是 Expo SDK 58 + RN 0.88.1 应用，原生代码仅 8 个 Expo Module；基线 D3 锁定保留现有技术栈、新增 Kotlin Expo Modules、不另起 App。
基线 §5.1 固定模块：local-auth / screen-capture / input-control / webrtc-transport / device-identity / secure-storage；JS 编排层 `src/lib/hub/`。
另：release 构建仍用 `signingConfigs.debug`（debug keystore）、`R8` 关闭（`minify=false`）。

## Decision（基线 D3：Expo/RN + Kotlin Modules，已锁定）

1. 保留 `apps/mobile` 的 Expo SDK 58 + RN 0.88.1；新增 Kotlin Expo Modules 承载系统能力，JS/TS 只做编排，不在 JS 模拟系统安全能力。
2. 固定模块（基线 §5.1）：`modules/local-auth`、`modules/screen-capture`、`modules/input-control`、`modules/webrtc-transport`、`modules/device-identity`、`modules/secure-storage`；JS 层 `apps/mobile/src/lib/hub/{identity,pairing,hubClient,signaling,webrtc,localAuth,session,permissions,remoteControl,audit}.ts`。
3. 网络传输用 WebRTC 原生桥接（webrtc-transport），**不引入 VpnService/WireGuard**（D5/D12）。
4. **发布阻断项 R5**：P8 前必须改为正式发布签名并启用代码保护；正式签名材料由项目负责人**安全提供**，Agent 不得生成或提交伪生产密钥。

## Considered Options

- 新建独立原生 Kotlin App：基线否决（D3）。
- 在 Expo Module 内扩展（采纳）：复用现有 bridge/SPKI/Keystore。

## Consequences

- 移动端原生代码改动后按规范运行 Expo prebuild 与 Gradle 验证。
- release 签名弱是发布阻断项；未修复的内部开发包不能当正式安全发布包。
- 前台服务例外仅限活动远控/屏幕采集会话（基线 §5.2），不扩大到普通同步。
