# 第三方开源代码与许可证清单

Task Dock 遵循「优先复用成熟开源项目」原则。本清单记录所有参考/复用的上游项目、
许可证与复用方式。**仅复制了许可证允许复用的代码；未获得许可证授权的仓库仅作设计参考，
未复制任何源码。**

> v0.2 更新：Agent 接入格式依据各产品**官方文档与本机实测配置**实现（Codex hooks.json 组结构
> 以本机 cc_ring 第三方钩子实体为证；DSH 插件事件以本机 dsh-task-chime 宿主插件为参考实现），
> 均为原创实现，未复制上述第三方仓库代码。新增依赖无。

## 一、调研结论（2026-10-25）

| 仓库 | 许可证 | 技术栈 | 结论 |
|---|---|---|---|
| [lan374/float-todo](https://github.com/lan374/float-todo) | MIT © 2025 morning | Tauri 2 + React + Zustand | **选作应用基础**。窗口/托盘/热键模式与本项目技术栈一致 |
| [followG/todo-tauri](https://github.com/followG/todo-tauri) | MIT © 2026 G | Tauri 2 + Vue 3 | 参考贴边自动隐藏交互逻辑（按本项目架构重写，未复制代码；前端为 Vue 不兼容） |
| [BUG-gao/floating-todo](https://github.com/BUG-gao/floating-todo) | **无 LICENSE 文件** | Tauri 2 + 原生 JS | **仅设计参考，禁止复制代码**（GitHub 公开 ≠ 可自由使用） |
| [hktjayaranga/deephud](https://github.com/hktjayaranga/deephud) | MIT | Tauri + React + TS + SQLite | 参考架构：紧凑/完整显示模式、Rust 本地调度器、SQLite 存储模式 |
| [mxyhi/AgentMonitor](https://github.com/mxyhi/AgentMonitor) | MIT © 2026 Thomas Ricouard | Tauri + Rust + TS | 参考 Codex `app-server` stdio JSON-RPC 接入方式（列入后续路线，第一版未采用） |
| [Guimathis/agent-tray-monitor](https://github.com/Guimathis/agent-tray-monitor) | MIT © Guilherme Mathis | Node 守护进程 + Hooks | 参考「生命周期 Hooks → 本地 IPC → 托盘状态灯」架构 |
| [cuihp/code-light-ai](https://github.com/cuihp/code-light-ai) | MIT | Tauri v2 + Rust | **参考并采用其文件钩子模式**：Claude Code / Codex 生命周期钩子写 JSON 状态文件，Tauri 端轮询（本项目改为统一事件总线 + 文件投递目录） |
| [DFreeMind/simple-to-do](https://github.com/DFreeMind/simple-to-do) | MIT | Tauri 2 + Vue 3 + SQLite | 参考任务数据模型与重复/提醒设计思路（前端为 Vue 不兼容） |

## 二、直接复用的代码

| 来源 | 复用内容 | 许可证义务 |
|---|---|---|
| lan374/float-todo (MIT) | 无边框透明置顶窗口配置、`data-tauri-drag-region` 拖拽、托盘菜单与左键切换、全局热键注册模式（参考其 `src-tauri/src/lib.rs` 结构重写） | 保留版权声明（见 NOTICE） |
| cuihp/code-light-ai (MIT) | Codex 生命周期钩子事件映射设计（SessionStart/PreToolUse/PermissionRequest/Stop → running/waiting/completed） | 保留版权声明（见 NOTICE） |
| followG/todo-tauri (MIT) | 贴边自动隐藏的交互策略（靠近边缘 + 光标离开才收起；光标回边缘展开） | 保留版权声明（见 NOTICE） |

> 说明：上述「复用」均为**模式与接口设计层面的借鉴后重写**（Rust/TS 实现为本项目原创），
> 并按 MIT 要求保留归属。如未来直接复制代码片段，将在对应文件头注明来源。

## 二·五、Agent 官方接口依据（v0.2 新增，均为文档/实测参考、原创实现）

| 产品 | 依据 | 许可证相关性 |
|---|---|---|
| OpenAI Codex | 官方仓库 github.com/openai/codex（Apache-2.0 源码，本项目未复制代码）；hooks.json 组结构以本机已装 cc_ring 钩子实体与 codex.exe 0.130.0-alpha.5 二进制字符串核验 | 无代码复用 |
| Trae | 官方文档 docs.trae.ai/ide/hook-configuration-reference | 无代码复用 |
| WorkBuddy / CodeBuddy | 官方文档 workbuddy.ai/docs/zh/cli/hooks 与 /cli/sdk | 无代码复用 |
| Qoder | 官方文档 docs.qoder.cn/qoder/hooks | 无代码复用 |
| OpenCode | 官方文档 opencode.ai/docs/plugins（插件事件 API） | 无代码复用 |
| DeepSeek Harness | github.com/libukai/awesome-deepseek-harness（指南）+ 本机 dsh-task-chime 插件结构参考（宿主插件 apply(ctx)/ctx.on 事件模型，实现原创） | 无代码复用 |
| ZCode | 本机 zcode.cjs 打包产物字符串勘验（HookEventNames 枚举），仅用于能力判断 | 无代码复用 |

## 三、Rust 依赖（Cargo）

| Crate | 版本 | 许可证 |
|---|---|---|
| tauri | 2.x | MIT OR Apache-2.0 |
| tauri-plugin-notification / autostart / global-shortcut / opener / dialog / single-instance | 2.x | MIT OR Apache-2.0 |
| rusqlite (bundled SQLite) | 0.32 | MIT（SQLite 为 Public Domain） |
| serde / serde_json | 1.x | MIT OR Apache-2.0 |
| chrono | 0.4 | MIT OR Apache-2.0 |
| tokio | 1.x | MIT |
| uuid | 1.x | Apache-2.0 OR MIT |
| tiny_http | 0.12 | MIT |
| regex | 1.x | MIT OR Apache-2.0 |
| tracing / tracing-subscriber | 0.1 / 0.3 | MIT |
| thiserror | 2.x | MIT OR Apache-2.0 |

## 四、前端依赖（npm）

| 包 | 版本 | 许可证 |
|---|---|---|
| react / react-dom | 19.x | MIT |
| zustand | 5.x | MIT |
| @tauri-apps/api | 2.x | Apache-2.0 |
| @tauri-apps/plugin-* | 2.x | MIT OR Apache-2.0 |
| lucide-react | 0.4xx | ISC |
| vite / @vitejs/plugin-react | 7.x / 4.x | MIT |
| typescript | 5.x | Apache-2.0 |
| vitest | 3.x | MIT |

## 五、数据与隐私

- 所有用户数据（任务、设置、Agent 状态元数据）仅保存在本地 SQLite 与本地备份文件。
- Agent 事件只记录状态元数据（来源/会话/轮次/状态/简短说明），**不记录 Prompt、聊天内容、代码、密钥**。
- 应用不包含任何网络请求代码（无遥测、无云同步）；本地 HTTP 接入端点仅绑定 127.0.0.1。
