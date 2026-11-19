# ADR-0003：投屏路线（scrcpy 与合规被控端 Agent）

- 日期：2026-11-19
- 状态：**Accepted**（按架构基线第 17 节锁定；基线 D4）
- 决策人：产品/架构负责人
- 关联：[ARCHITECTURE_BASELINE_v1.0.md](../ARCHITECTURE_BASELINE_v1.0.md) D4、[02-current-state-audit.md](../02-current-state-audit.md) C1、[12-android-method-design.md](../12-android-method-design.md)

## Context

现有屏幕控制是 Windows 借 ADB+scrcpy 对手机单向下发（shell uid 2000 注入），手机 APK 无被控端 Agent，且 PoC 论证 MediaProjection 不能替代 scrcpy（FLAG_SECURE 黑屏、每次需用户确认）。
规格要求 Android 被控端用 BiometricPrompt 本地认证 + MediaProjection + AccessibilityService，且锁屏不得绕过。
开发纪律第 12 条：不允许删除现有功能规避架构冲突。

## Decision（基线 D4：并行双栈，已锁定）

1. **保留** ADB+scrcpy 作为本地/开发调试能力，不删除、不回退；**scrcpy/ADB 不得公网暴露**。
2. **新建**独立的、强制本机认证的远控链路（Android DEVICE_CREDENTIAL + MediaProjection + AccessibilityService；Windows 系统凭据 + Graphics Capture），仅在活动会话内激活、绑定 session_id。
3. 两条栈在 UI 与代码边界隔离；合规远控走强制认证门槛，scrcpy **不接入 Personal Hub 授权体系**（基线 §1.1）。

## Considered Options

- 仅 scrcpy：达不到本地认证硬门槛，否决。
- 用 MediaProjection 替换 scrcpy：PoC 已论证不能替代且会删现有功能，否决。
- 并行双栈（采纳）：兼顾现有功能与规格，代价是两套能力并存。

## Consequences

- 双栈维护成本已被基线接受，不再是待决项。
- 屏幕采集授权独立于远控认证（每次 MediaProjection 系统授权，基线 §5.2）。
- 实现方不得把 scrcpy 接入远控授权链路，也不得因远控需求删除 scrcpy。
