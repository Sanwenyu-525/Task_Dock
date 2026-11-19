# ADR-0005：Windows 后台服务形态

- 日期：2026-11-19
- 状态：**Accepted**（按架构基线第 17 节锁定；基线 D2）
- 决策人：产品/架构负责人
- 关联：[ARCHITECTURE_BASELINE_v1.0.md](../ARCHITECTURE_BASELINE_v1.0.md) D2/§4.1、[03-architecture.md](../03-architecture.md)

## Context

基线 D2/§4.1 明确锁定：v1.0 采用**独立、普通用户权限的后台进程**，不使用自研 SYSTEM 权限 Windows Service。
理由：远控必须在目标设备本机认证，无需为无人值守以 SYSTEM 运行；最小权限优先。
现状只有 `tauri-plugin-autostart`（Run 注册表键）+ 应用内 supervisor；无 SCM Windows Service。

## Decision（基线 D2：普通用户独立进程，已锁定）

1. 新增独立可执行目标 `taskdock-personal-hub`，核心实现在 `src-tauri/src/personal_hub/`。
2. 由 TaskDock 登录自启机制启动；关闭主窗口不停止 Hub；用户从托盘/设置显式退出才停止。
3. **以当前登录用户权限运行；不以 SYSTEM 运行；不监听公网网卡。**
4. 本地管理接口仅用**当前用户 ACL 保护的 Named Pipe**；禁止无鉴权 localhost HTTP；不把 `0.0.0.0` 设为默认监听地址。
5. Hub 进程与 WebView2 分离，WebView 崩溃不导致安全状态丢失。
6. Windows 用户注销或电脑休眠时 Hub 不承诺可用，UI 显示离线/休眠状态。

## Considered Options

- 自建 SYSTEM Windows Service：基线否决（D2，无人值守非 v1.0 目标，最小权限优先）。
- 普通用户独立进程 + 登录自启 + Named Pipe（采纳）。

## Consequences

- 无 SYSTEM 提权面；本机管理员仍可对抗用户态保护（剩余风险 R0，已知披露）。
- 不引入 Windows 服务安装/提权流程；与便携安装定位一致。
- 服务异常恢复由进程内 HealthMonitor + 登录自启承担，不依赖 SCM。
