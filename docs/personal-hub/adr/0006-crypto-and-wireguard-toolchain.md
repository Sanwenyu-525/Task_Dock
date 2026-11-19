# ADR-0006：加密库选型（WireGuard 部分已废止）

- 日期：2026-11-19
- 状态：**Superseded / Deferred**（按架构基线第 17 节：WireGuard 不属于 v1.0；仅保留设备身份加密库选型的有效部分）
- 决策人：产品/架构负责人（基线 D5/D12/§6.1）
- 关联：[ARCHITECTURE_BASELINE_v1.0.md](../ARCHITECTURE_BASELINE_v1.0.md) D5/§0.1/§6.1、[05-identity-and-pairing.md](../05-identity-and-pairing.md)

## Context

原稿同时讨论 Ed25519/X25519 设备身份库选型与 WireGuard 组网工具链。基线 D5/§0.1 锁定：
**v1.0 使用 WebRTC 应用层加密覆盖，不安装 WireGuard 系统 VPN、不分配虚拟网卡 IP**；WireGuard 为 D12 未来扩展，不得由 Agent 提前实施。
故本 ADR 的 WireGuard 部分作废，仅保留身份加密库的选型约束。

## Decision（有效部分：设备身份加密库）

1. 设备身份签名 Ed25519、临时密钥协商 X25519、哈希 SHA-256、KDF HKDF-SHA-256、AEAD AES-256-GCM 或已审计实现（基线 §6.1）；**不自行实现密码算法**。
2. Rust 侧优先验证 `ed25519-dalek` / `x25519-dalek` 与当前工具链兼容性；本机构建无 nasm/cmake，不引入 `ring`/`aws-lc-rs`。
3. 若指定库构建/审计失败 → 停止并报告 BLOCKED，不得自行换算法或复用同步令牌作设备身份密钥。
4. 密钥用途分离（基线 §6.1）：设备身份私钥 / 会话临时密钥 / WebRTC DTLS 密钥各自独立；**v1.0 不生成 WireGuard 私钥**。

## 废止部分（Superseded）

- 原「WireGuardNT + wintun + Android WireGuard Tunnel Library / VpnService + 分流」方案**不进入 v1.0**（D5/D12）。
- 未来若需通用 IP 访问，另立新 ADR，使用成熟官方实现，不得自研加密协议。

## Consequences

- v1.0 无系统 VPN / 虚拟网卡 / 全局流量接管；不得在产品文案中称"完整虚拟局域网"。
- 网络连通性依赖 WebRTC P2P + STUN/TURN（见 [04-network-topology.md](../04-network-topology.md)）。
