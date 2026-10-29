# task_dock

Local workspace connected to ChatGPT via **Codex with ChatGPT** (C2C bridge).

- ChatGPT (web) is the planning and review layer.
- Codex owns execution.
- ChatGPT reads this workspace read-only through the `Codex with ChatGPT · task_dock` MCP connector.

This file exists as a hello-style top-level file for connection verification.

---

# Task Dock — 任务驱动的 Windows 桌面工作中枢

轻量级、常驻桌面、可自由拖动与全局置顶：**通用任务管理 + 通用软件启动器 + Windows 窗口切换器
+ AI Agent 监控中心 + Agent 会话导航 + 任务工作区管理 + 统一任务上下文**（v0.5）。

- **技术栈**：Tauri 2 + Rust + React + TypeScript + Vite + Zustand + SQLite（rusqlite bundled）
- **快速开始**：`npm install` → `npm run tauri dev`（开发）/ `npm run tauri build`（安装包）
- **测试**：`cd src-tauri && cargo test`（244 项；另有 10 个手动性能/真机工具 ignored）· `npm test`（109 项）· 无头联调 `task-dock.exe --agentctl scan|install|verify <id>`
- **文档**：
      - [Agent 覆盖矩阵（含跳转能力）](AGENT_COVERAGE_MATRIX.md) · [通用应用导航矩阵](APP_NAVIGATION_MATRIX.md) · [Adapter 开发指南](ADAPTER_DEVELOPMENT.md)
      - [架构说明](docs/ARCHITECTURE.md) · [第三方代码与许可证清单](docs/THIRD_PARTY.md) · [开发与构建指南](docs/DEVELOPMENT.md) · [测试记录](docs/TESTING.md) · [路线图](docs/ROADMAP.md)
      - 性能专项：[性能架构](docs/PERFORMANCE_ARCHITECTURE.md) · [压测方法](docs/PERFORMANCE_TESTING.md) · [验收报告](docs/PERFORMANCE_ACCEPTANCE_REPORT.md)
      - 智能剪贴板（v0.5）：[需求与验收](docs/clipboard/01-requirements.md) · [架构](docs/clipboard/02-architecture.md) · [数据模型](docs/clipboard/03-data-model.md) · [监听与安全](docs/clipboard/04-monitor-security.md) · [分组引擎](docs/clipboard/05-grouping-engine.md) · [复制粘贴与保护](docs/clipboard/06-copy-paste-protection.md) · [UI 与集成](docs/clipboard/07-ui-and-integrations.md) · [测试与性能](docs/clipboard/08-testing-performance.md) · [实施与验收](docs/clipboard/09-implementation-report.md) · [整改分类验收](docs/clipboard/10-remediation-acceptance.md)

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
- **行动中心（v0.5）**：跨 Agent 聚合「执行失败 / 等待授权（推断）/ 等待输入 / 正在执行 /
  本轮完成 / 连接中断 / 任务提醒」，按来源、任务、类型、优先级筛选；相同高频事件合并并可批量
  确认；未接入或通道未验证的来源只显示覆盖度，不伪造监控状态；
- **任务上下文（v0.5）**：每张任务卡可打开统一抽屉，集中查看工作现场、Agent 会话、关联目标、
  剪贴板素材与待处理动作；**工作现场快照**记录窗口标题/类名/exe、文件与网址（不读窗口内容、
  不截图、不存 HWND/PID），可一键恢复，已运行窗口优先复用，恢复结果按验证级别如实标注；
- **智能剪贴板（v0.5）**：自动记录文字/链接/富文本/截图/文件列表，连续截图按 45 秒窗口
  自动分组（文字按实际顺序穿插）；历史搜索/筛选/收藏/置顶，手动重排/拆分/合并；整组富文本或
  多文件复制（复制前预检 6 MB 内嵌预算/HTML/文件模式限制），选择目标窗口后逐项粘贴
  （逐项状态、分类型间隔、独立收尾、可取消/继续、失败审计，只报告“动作已发送”）；剪贴板
  快照恢复在锁内比较内容，绝不覆盖用户新复制；采集使用三线程 + 有界队列（64/8 条/128 MB），
  丢弃可计数；任务手动关联与 Agent 本地导出（能力矩阵明确“直接发送不支持/文件导入未验证/桌面
  粘贴仅手动/本地导出可用”，不上传、不自动发送），素材可进一步绑定到工作现场快照；
  2026-10-29 真机验收 46/46、第三方矩阵 5/5（记事本/资源管理器/Edge 文本与富文本/VS Code），
  微信与 Agent 应用因环境阻塞未验证，详见 [整改分类验收](docs/clipboard/10-remediation-acceptance.md)；
- **Agent 监控**：自动发现 + 一键接入向导 + 分层监控树（Agent→实例→会话→轮次→事件，
  事务性 ingest + 幂等/乱序/终态保护）；Agent 跳转能力证据化（Codex `codex resume` 实测基线；
  OpenCode 运行时探测；无官方接口的诚实降级，不臆造 Deep Link）；
- **性能与稳定性（v0.5 专项）**：所有接入通道统一进入**有界队列**（默认 1024）→ 合并窗口
  250ms → 单事务批处理；关键状态（waiting/failed/completed）永不合并、过载时返回可重试错误；
  前端快照**单飞 + 节流**（100 条事件不再触发 100 次全量刷新）；SQLite 读写分离（WAL 读池）+
  索引 + 事件归档保留（仅清理 running/idle）；设置页内置性能诊断（队列/延迟分位/拒绝/慢查询）；
  压测工具见 `src-tauri/tests/ingest_perf.rs` 与 `scripts/perf/ingest-load.mjs`；
- **安全**：跳转只执行用户确认过的配置并执行前重校验；exe 绝对路径 + 解释器黑名单；
  URL 仅 http/https；全程结构化进程参数不经 shell；Agent 事件携带的命令永不执行。

无事件证据时状态一律显示「未知」，不推断。所有数据仅存本地，不上传任何 Prompt、代码或隐私信息。
