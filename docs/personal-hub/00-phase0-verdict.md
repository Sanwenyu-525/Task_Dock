# P0 文档决策锁定结论

- 日期：2026-11-19
- 阶段：**P0 完成**（文档决策锁定；P1–P8 实现阶段开始）
- 权威依据：[ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md)
- 文档集：[README.md](README.md)

> 按架构基线第 17 节，本文件**不再要求用户回答 C1–C5**；那些冲突已由基线统一锁定。
> 本文件只记录：基线已锁定的决策、旧文档的对齐结果、进入实现阶段的前置声明。

---

## 1. P0 已完成的交付（真实产出）

| 交付项 | 状态 | 位置 |
|---|---|---|
| 架构基线入库并作为唯一决策源（SHA256 `b87cef16…1c28`） | 完成 | [ARCHITECTURE_BASELINE_v1.0.md](ARCHITECTURE_BASELINE_v1.0.md) |
| 三端代码审计（Windows / Android / 投屏 / 云端现状） | 已执行（只读） | [02-current-state-audit.md](02-current-state-audit.md) |
| Windows Hello 桌面 API 可用性核实 | 已查证 | [07-local-auth-design.md](07-local-auth-design.md) §3 |
| 威胁模型 / 本地认证 / 权限矩阵 / 会话状态机 / 方法级设计 / 测试计划 | 设计完成，按基线对齐 | 本目录 01–15 |
| ADR-0001~0007 状态按基线第 17 节统一 | 完成 | [adr/](adr/) |

**结论口径**：P0 是文档决策锁定，**没有任何业务代码被实现、构建或测试**。规格/基线的全部验收测试当前为「未验证 / 待执行」。

---

## 2. 基线已锁定的决策（D1–D12，实现方不得更改）

| 编号 | 决策 | 对实现的约束 |
|---|---|---|
| D1 | PC-first | v1.0 不支持脱离电脑的手机↔手机组网 |
| D2 | 独立普通用户进程 Hub | 登录自启、关主窗口不停服、不以 SYSTEM 运行、Named Pipe 当前用户 ACL |
| D3 | Android 保留 Expo/RN | 新增 Kotlin Expo Modules，不另起 App |
| D4 | 保留 ADB+scrcpy 本地/调试栈 | 新增独立认证远控栈；scrcpy/ADB 不公网暴露 |
| D5 | WebRTC 应用层加密覆盖 | **不安装 WireGuard 系统 VPN、不分配虚拟网卡 IP** |
| D6 | TaskDock 云端发现/信令 + TURN 中继 | 普通用户不配置服务器/端口/公网 IP |
| D7 | DTLS-SRTP 视频 + DTLS DataChannel | TURN 只转密文 |
| D8 | 设备本地生成身份密钥 | 二维码只建配对申请，不授予远控 |
| D9 | 每次新会话被控端本机系统凭据认证 | 手机验证手机、电脑验证电脑 |
| D10 | 永不采集/保存/传输系统密码 | 使用 OS 设备凭据验证 UI |
| D11 | 严格失败关闭 | 认证不可用/失败/取消/超时/身份不匹配 → 拒绝；禁止自建密码框或跳过 |
| D12 | 预留 WireGuard/手机互控接口但不实施 | 不得由 Agent 擅自提前实施 |

---

## 3. 旧文档对齐结果（基线第 17 节）

- `00-phase0-verdict.md`：由「请示用户回答 C1–C5」改为「记录基线已锁定决策」（本文件）。
- `03-architecture.md`：服务形态改为独立普通用户进程；组网改为 WebRTC 应用层覆盖；移除 WireGuard 实施。
- `04-network-topology.md`：连接策略改为 LAN HTTPS / WSS 信令 / WebRTC P2P / TURN 回退；WireGuard 标注为 D12 未来扩展。
- `07-local-auth-design.md`：删除 `TD_LOCAL_GRANT` App PIN 自动降级；Windows 认证不可用时**关闭远控并报告阻塞**。
- `15-development-plan.md`：阶段编号统一为基线的 P0–P8。
- ADR：0001/0003/0004/0005/0007 → Accepted；0002 → Accepted 严格系统凭据策略（删除 App PIN 降级）；0006 → Superseded/Deferred（WireGuard 不属 v1.0）。
- 代码审计、威胁模型、方法级设计、测试细节保留；只修订与基线冲突段落。

---

## 4. 进入实现阶段的前置声明（不可协商）

1. **阶段门铁律**：P5 本机认证未通过之前，禁止开发或启用 P6 远程输入控制。
2. **技术阻塞处理**：架构指定技术无法落地时停止受影响任务，提交 PoC 命令/错误日志/环境信息/已尝试步骤，标记 `BLOCKED`，不自行换方案。
3. **文件所有权**：Windows / Cloud / Android 三个实现子 Agent 各司其职；主 Agent 负责接口集成、安全审查、统一构建与验收。
4. **协作规范**：遵守根 `AGENTS.md` 的 Git、共享工作区、构建调度与集成规范；不覆盖其他任务未提交文件；不自动 commit/push。
5. **验收口径**：未执行写「未执行」，环境阻塞写 `ENVIRONMENT BLOCKED`，证据不足写「证据不足」；不用「代码已写好/理论可行/应该没问题」充当结论。
