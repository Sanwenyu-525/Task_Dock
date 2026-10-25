# task_dock

Local workspace connected to ChatGPT via **Codex with ChatGPT** (C2C bridge).

- ChatGPT (web) is the planning and review layer.
- Codex owns execution.
- ChatGPT reads this workspace read-only through the `Codex with ChatGPT · task_dock` MCP connector.

This file exists as a hello-style top-level file for connection verification.

---

# Task Dock — 任务驱动的 Windows 桌面工作中枢

轻量级、常驻桌面、可自由拖动与全局置顶：**通用任务管理 + 通用软件启动器 + Windows 窗口切换器
+ AI Agent 监控中心 + Agent 会话导航 + 任务工作区管理**（v0.4）。

- **技术栈**：Tauri 2 + Rust + React + TypeScript + Vite + Zustand + SQLite（rusqlite bundled）
- **快速开始**：`npm install` → `npm run tauri dev`（开发）/ `npm run tauri build`（安装包）
- **测试**：`cd src-tauri && cargo test`（111 项）· `npm test`（44 项）· 无头联调 `task-dock.exe --agentctl scan|install|verify <id>`
- **文档**：
      - [Agent 覆盖矩阵（含跳转能力）](AGENT_COVERAGE_MATRIX.md) · [通用应用导航矩阵](APP_NAVIGATION_MATRIX.md) · [Adapter 开发指南](ADAPTER_DEVELOPMENT.md)
      - [架构说明](docs/ARCHITECTURE.md) · [第三方代码与许可证清单](docs/THIRD_PARTY.md) · [开发与构建指南](docs/DEVELOPMENT.md) · [测试记录](docs/TESTING.md) · [路线图](docs/ROADMAP.md)

核心能力：
- **悬浮任务栏**：无边框透明置顶（极简/紧凑/完整三模式、贴边自动隐藏、托盘、开机自启、毛玻璃/深浅色）、
  中文自然语言快速录入、后端提醒调度、重复任务；
- **统一导航（v0.4）**：任务可关联任意软件 / 网址 / 文件 / 目录 / Agent 会话；任务卡点击图标即可
  打开或唤醒（L1 启动 → L2 唤醒窗口 → L3 打开页面/文件 → L4 恢复 Agent 会话，按偏好降级，
  验证级别如实标注——「进程已启动」绝不冒充「窗口已确认」）；
- **软件发现与窗口管理**：开始菜单 / 卸载注册表 / UWP 商店应用 / 常用路径四源扫描（不全盘搜索）；
  EnumWindows 顶层窗口枚举 + 前台切换（被系统拒绝时如实报错）；
- **任务工作区**：一个任务一组目标（如 VS Code 项目 + GitHub 页面 + Codex 会话 + 日志目录），
  一键顺序启动、已运行优先复用、单目标失败不阻断、可取消、部分成功明确区分；
- **Agent 监控**：自动发现 + 一键接入向导 + 分层监控树（Agent→实例→会话→轮次→事件，
  事务性 ingest + 幂等/乱序/终态保护）；Agent 跳转能力证据化（Codex `codex resume` 实测基线；
  OpenCode 运行时探测；无官方接口的诚实降级，不臆造 Deep Link）；
- **安全**：跳转只执行用户确认过的配置并执行前重校验；exe 绝对路径 + 解释器黑名单；
  URL 仅 http/https；全程结构化进程参数不经 shell；Agent 事件携带的命令永不执行。

无事件证据时状态一律显示「未知」，不推断。所有数据仅存本地，不上传任何 Prompt、代码或隐私信息。
