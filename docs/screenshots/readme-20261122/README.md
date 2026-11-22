# README 界面截图（2026-11-22）

本目录是 README「界面预览」使用的当前版本截图，替代 `readme-20261108`。

## 采集条件

- 应用：`src-tauri/target/debug/task-dock.exe`，2026-11-22 20:35 构建；大型工作台窗口（`workspace.html`）。
- 前端：Vite dev server（`localhost:1420`）提供当前工作树代码。采集时工作树含其他会话的未提交改动，
  因此截图**不等同于干净 checkout 的 Release 版本**。
- 通道：真实 WebView2 + CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=17440`），
  Playwright 通过 `connectOverCDP` 附加并截图。不是设计稿，也不是纯浏览器 harness。
- 实例隔离：`TASK_DOCK_DATA_DIR=tmp/acceptance/readme-screenshots-20261122/data`，
  独立 `WEBVIEW2_USER_DATA_FOLDER`，未触碰 `%APPDATA%` 中的真实数据。
- 窗口：1200×760 CSS px，显示缩放 1.25（输出 1500×950）。
- 主题：浅色 + 柔光玻璃 + 玻璃材质；`07-tasks-dark.png` 为暗色 + 柔光玻璃。
- 数据：`tmp/acceptance/readme-screenshots-20261122/seed.py` 写入隔离 SQLite 的演示数据；
  任务、剪贴板条目、Agent 会话、项目、工作流、笔记均为虚构，不含真实用户数据。
- 截图时仅用 CSS 隐藏了页脚的 dev 构建标记（`.wb-status-build`），其余界面均为原样渲染。
  页脚版本号是构建产物自带的 `0.5.0`；功能迭代版本与包版本尚未同步。

## 截图清单

| 文件 | 页面 |
|---|---|
| `01-home.png` | 工作台首页（浅色） |
| `02-tasks.png` | 任务管理（全部任务） |
| `03-agents.png` | Agent 监控（Codex → codex-cli → 会话，展开三层） |
| `04-clipboard.png` | 智能剪贴板（条目 + 右侧内容预览） |
| `05-workflows.png` | 工作流 |
| `06-settings.png` | 设置 · 外观与主题 |
| `07-tasks-dark.png` | 任务管理（暗色） |

## 边界说明

- 这些是 WebView2 **页面截图**，不是桌面合成截图；不等同于原生窗口圆角、DWM 材质或贴边手感验收。
- 当前环境原生毛玻璃不可用（`nativeGlass=false`），截图中的玻璃为 CSS 回退效果。
- 演示数据通过直接写隔离数据库生成；截图证明的是当前界面外观与数据呈现，不是原生真机功能验收。
