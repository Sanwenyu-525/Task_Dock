# task_dock

Local workspace connected to ChatGPT via **Codex with ChatGPT** (C2C bridge).

- ChatGPT (web) is the planning and review layer.
- Codex owns execution.
- ChatGPT reads this workspace read-only through the `Codex with ChatGPT · task_dock` MCP connector.

This file exists as a hello-style top-level file for connection verification.

---

# Task Dock — Windows 桌面悬浮任务与 AI Agent 监控中心

轻量级、常驻桌面、可自由拖动与全局置顶的任务中心：通用任务管理（待办/日程/提醒/重复）
+ 通用 AI Agent 监控（v0.2：自动发现 + 一键接入 + 活动监控树）+ 任务与 Agent 关联。

- **技术栈**：Tauri 2 + Rust + React + TypeScript + Vite + Zustand + SQLite（rusqlite bundled）
- **快速开始**：`npm install` → `npm run tauri dev`（开发）/ `npm run tauri build`（安装包）
- **测试**：`cd src-tauri && cargo test`（52 项）· `npm test` · 无头联调 `task-dock.exe --agentctl scan|install|verify <id>`
- **文档**：
  - [v0.2 验收报告](../ACCEPTANCE_REPORT.md) · [Agent 覆盖矩阵](../AGENT_COVERAGE_MATRIX.md) · [Adapter 开发指南](../ADAPTER_DEVELOPMENT.md)
  - [架构说明](docs/ARCHITECTURE.md) · [第三方代码与许可证清单](docs/THIRD_PARTY.md) · [开发与构建指南](docs/DEVELOPMENT.md) · [测试记录](docs/TESTING.md) · [路线图](docs/ROADMAP.md)

核心能力：无边框透明置顶悬浮窗（极简/紧凑/完整三模式、贴边自动隐藏、托盘、开机自启）、
中文自然语言快速录入、后端提醒调度、统一 Agent 事件总线（分层 Agent→实例→会话→轮次→事件，
事务性 ingest + 幂等/乱序/终态保护状态机）、**Agent 自动发现引擎**（安装/进程/能力/事件证据四层，
覆盖 Codex、Trae、WorkBuddy、Qoder、DeepSeek Harness、OpenCode、ZCode）、
一键接入向导（预览→确认→安装→验证→可回滚，第三方 hooks 原样保留）、动态来源注册、
任务↔Agent 会话关联、JSON 导入导出与本地自动备份。
无事件证据时状态一律显示「未知」，不推断。所有数据仅存本地，不上传任何 Prompt、代码或隐私信息。

**安装包**（未签名，首次运行需「更多信息 → 仍要运行」）：
`release/Task Dock_0.2.0_x64-setup.exe`（NSIS，推荐）· `release/Task Dock_0.2.0_x64_en-US.msi`（MSI）
