# TaskDock Personal Hub · 架构与安全设计文档集

> **唯一架构事实源：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)（PC-first 架构决策锁定基线）。**
> 本目录其余文档为代码审计、威胁模型、方法级设计与测试细节；与基线冲突时**一律以基线为准**。
> 基线由产品/架构负责人预先锁定，实现方不得重新规划架构、更换协议或降低安全标准。

> 事实优先级遵循 `AGENTS.md`：**代码与可复现输出 > 测试/真机证据 > 文档**。现状结论带代码证据路径；
> 未验证项一律标注「未验证 / 待 PoC」，不用「应该 / 理论上」代替证据。

- 建立日期：2026-11-19
- 当前阶段：**P0 文档决策锁定已完成；进入 P1–P8 实现阶段**（见 [15-development-plan.md](15-development-plan.md)）
- 最高原则：**安全第一 > 稳定性 > 易用性 > 功能丰富度**
- 已锁定关键决策（摘要）：PC-first；独立普通用户进程 Hub；Expo/RN + Kotlin Modules；保留 scrcpy 本地栈 + 新增认证远控栈；
  **v1.0 使用 WebRTC 应用层加密覆盖（HTTPS/WSS + WebRTC P2P + STUN/TURN），不安装 WireGuard 系统 VPN、不分配虚拟网卡 IP**；
  TaskDock 云端 Control Plane；每次会话被控端本机设备凭据认证；严格失败关闭、无 App PIN 自动降级。
- 产品硬门槛：**不输入被控设备本机凭据，就无法执行任何远控操作；任何二维码/IP/设备 ID/云端账户/历史配对都不是远控万能钥匙。**

---

## 1. 文档索引与需求项映射

**架构基线（唯一事实源）：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)** — 18 节，含 D1–D12 决策、P0–P8 阶段门、威胁模型、方法级模块设计与完成定义。

用户规格第七节建议的 16 项文档与本文集的对应关系：

| # | 规格要求文档 | 本文集位置 | 状态 |
|---|---|---|---|
| 1 | Personal Hub 产品需求文档 | [01-product-requirements.md](01-product-requirements.md) | 已完成 |
| 2 | 总体架构设计 | [03-architecture.md](03-architecture.md) | 已完成 |
| 3 | 网络拓扑设计 | [04-network-topology.md](04-network-topology.md) | 已完成 |
| 4 | 设备身份与配对协议 | [05-identity-and-pairing.md](05-identity-and-pairing.md) | 已完成 |
| 5 | 安全威胁模型 | [06-threat-model.md](06-threat-model.md) | 已完成 |
| 6 | 远程控制本地认证设计 | [07-local-auth-design.md](07-local-auth-design.md) | 已完成（含 Windows Hello 可用性验证） |
| 7 | 权限矩阵 | [08-permission-and-session.md](08-permission-and-session.md) §1 | 已完成 |
| 8 | 会话状态机 | [08-permission-and-session.md](08-permission-and-session.md) §2 | 已完成 |
| 9 | 数据模型 | [09-data-model.md](09-data-model.md) | 已完成 |
| 10 | API 与通信协议 | [10-api-and-protocol.md](10-api-and-protocol.md) | 已完成 |
| 11 | Windows 方法及类职责 | [11-windows-method-design.md](11-windows-method-design.md) | 已完成 |
| 12 | Android 方法及类职责 | [12-android-method-design.md](12-android-method-design.md) | 已完成 |
| 13 | 云端服务职责 | [10-api-and-protocol.md](10-api-and-protocol.md) §6 | 已完成 |
| 14 | 错误处理与恢复机制 | [13-error-handling.md](13-error-handling.md) | 已完成 |
| 15 | 测试计划 | [14-test-plan.md](14-test-plan.md) | 已完成 |
| 16 | 分阶段开发计划 | [15-development-plan.md](15-development-plan.md) | 已完成 |
| 17 | ADR 架构决策记录 | [adr/](adr/) | 已完成（关键决策） |
| — | **现状审计 / 能力差距 / 红线冲突** | [02-current-state-audit.md](02-current-state-audit.md) | 已完成（阶段 0 前置） |
| — | **阶段 0 验收结论 / 待用户决策** | [00-phase0-verdict.md](00-phase0-verdict.md) | 已完成 |

---

## 2. 阅读顺序（建议）

1. **决策者**：[00-phase0-verdict.md](00-phase0-verdict.md) → [02-current-state-audit.md](02-current-state-audit.md) → [adr/](adr/)
2. **架构 / 安全评审**：[01](01-product-requirements.md) → [02](02-current-state-audit.md) → [03](03-architecture.md) → [04](04-network-topology.md) → [05](05-identity-and-pairing.md) → [06](06-threat-model.md) → [07](07-local-auth-design.md) → [08](08-permission-and-session.md)
3. **实现负责人**：[09](09-data-model.md) → [10](10-api-and-protocol.md) → [11](11-windows-method-design.md) → [12](12-android-method-design.md) → [13](13-error-handling.md)

---

## 3. 现状一句话总结（务必先读）

当前 TaskDock 是一个**工程质量较高、本地优先、无远程控制、无系统服务、无生物识别强认证**的桌面 + 移动同步应用。
它提供了可复用的高质量安全积木（TLS-only + SPKI 固定、配对/令牌/撤销、XSalsa20-Poly1305 信封、Argon2id/AES-GCM、保险箱会话锁、单飞增量同步、ADB+scrcpy 投屏执行端）。
但规格中的 Personal Hub 能力——**远程控制通道、VPN/WireGuard 组网、Windows Hello 强认证、Windows 服务、轻量云端信令/中继、被控端屏幕采集与输入注入**——**全部为空白或存在根本性技术栈冲突**，需从零建设。

详细差距与证据见 [02-current-state-audit.md](02-current-state-audit.md)。

---

## 4. 文档纪律

- 本文集所有「现状」结论基于 2026-11-19 对 `main`（`7485d92`）的实际代码审计；**只陈述事实，不虚构验收**。
- 「目标设计」是待评审的方案，**不等于已实现**；每个设计都要标明依赖的现有基础与需新建设施。
- 关键安全决策记录在 [adr/](adr/)，不得因后续开发任务多而遗漏已确定的安全要求。
- 本目录为阶段 0 正式文档，归入版本管理；真机/网络/安全证据按 `AGENTS.md` §7 放 `tmp/acceptance/<task>/` 并另行归档。
