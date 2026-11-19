# ADR-0002：Windows 严格系统凭据认证（无 App PIN 降级）

- 日期：2026-11-19
- 状态：**Accepted**（按架构基线第 17 节锁定；旧 `TD_LOCAL_GRANT` 自动降级路径已删除）
- 决策人：产品/架构负责人（基线 D10/D11、§4.2、§8.1）
- 关联：[ARCHITECTURE_BASELINE_v1.0.md](../ARCHITECTURE_BASELINE_v1.0.md)、[07-local-auth-design.md](../07-local-auth-design.md) §3

## Context

规格与基线都要求 Windows 被控端使用系统提供的安全认证，禁止收集系统密码。基线 §4.2/§8.1 明确：
若当前 Windows API/系统版本不能提供合规的本机凭据验证，**必须关闭 Windows 远控并报告阻塞**，
不允许退化成自建 App PIN。旧稿曾设计 `TD_LOCAL_GRANT`（DPAPI 保护的应用内授权）作为降级 2，
该方案与基线 D11「严格失败关闭、禁止自建密码框或跳过认证」冲突，故废除。

技术事实：桌面应用须用 `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd, msg)`（真实 HWND），
不能用 UWP 的 `RequestVerificationAsync`；windows-rs 有 `Class not registered (0x80040154)` 历史报告，须在 P5 做 PoC。

## Decision

1. Windows 本机认证只用 OS 系统凭据：Windows Hello / 设备 PIN，经真实 HWND interop，应用只读结果码。
2. TaskDock 不收集、保存、传输 Windows 账户密码；不创建仿系统登录框。
3. **删除 `TD_LOCAL_GRANT` 及任何 App PIN 自动降级路径**。
4. 系统凭据不可用 / 认证失败 / 取消 / 超时 / 未配置 / 组策略禁用 → 拒绝远控，Windows 远控功能关闭并标 `BLOCKED`，提交 PoC 命令/日志/环境/已尝试步骤。
5. 认证成功才在本机签发一次性 `LocalAuthGrant`（≤60s，绑定 controller/target/session/nonce/scopes），且只在 `LOCAL_AUTH_REQUIRED` 状态后产生。

## Considered Options

- 自建 App PIN 降级：违反基线 D11 / §4.2，否决。
- 收集 Windows 账户密码：违反红线，否决。
- 直接跳过认证：违反最高原则，否决。
- 严格系统凭据 + 不可用时关闭并报告阻塞：**采纳**。

## Consequences

- Windows Hello 桌面 PoC（P5 A7）是 Windows 远控能否交付的前置；PoC 失败即 Windows 远控 BLOCKED，但不影响 Android 端与其它阶段。
- 牺牲了「无 Hello/PIN 配置用户」的可用性——这是基线的明确取舍，安全优先。
- 不因 Windows 端阻塞而降低 Android 端或其它链路的安全标准。
