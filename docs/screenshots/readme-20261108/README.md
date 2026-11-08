# README 界面截图（2026-11-08）

本目录是 README「界面预览」使用的当前版本截图。

## 采集条件

- 构建：`src-tauri/target/debug/task-dock.exe`（commit `0841f38`，2026-11-08 15:03 构建）
- 前端：Vite dev server（`localhost:1420`）从当前工作树提供；采集期间工作树含其他会话的
  未提交改动（本次截取页面未涉及这些 WIP 区域，但不等同于干净 checkout 复现）
- 通道：C — CDP + 真实 WebView2（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`）
- 实例隔离：`TASK_DOCK_DATA_DIR=tmp/acceptance/readme-screenshots-20261108/data`，
  独立 `WEBVIEW2_USER_DATA_FOLDER`，不接触 `%APPDATA%` 真实数据
- 窗口：500×780 CSS px；显示缩放 1.25（输出 625×975）
- 主题：浅色 + 柔光玻璃；`02-tasks-dark.png` 为暗色 + 梦幻渐变
- 数据：`tmp/acceptance/readme-screenshots-20261108/seed.py` 写入隔离 SQLite 的演示数据；
  任务、剪贴板、Agent 会话、项目、工作流均为虚构，不含真实用户数据

## 截图清单

| 文件 | 页面 |
|---|---|
| `01-tasks-light.png` | 任务页（浅色 · 柔光玻璃） |
| `02-tasks-dark.png` | 任务页（暗色 · 梦幻渐变） |
| `03-clipboard.png` | 剪贴板（全部类型） |
| `04-agents.png` | Agent 监控树（展开 Codex 实例与会话） |
| `05-actions.png` | 行动中心（失败 / 等待介入） |
| `06-shelf.png` | 文件暂存架 |
| `07-workflows.png` | 工作流 |
| `08-planning.png` | 规划中心 |
| `09-settings.png` | 设置 · 外观与主题 |
| `10-inbox.png` | 收集箱（快速捕获） |
| `11-capsule.png` | 停靠胶囊（左侧轨道 + 任务面板） |

## 边界说明

- 这些是 WebView2 **页面截图**，不是桌面合成截图；不等同于原生窗口圆角、DWM 材质或贴边手感验收。
- 当前环境原生毛玻璃不可用（`nativeGlass=false`），截图中的玻璃为 CSS 回退效果。
- `11-capsule.png` 的窗口外区域由合成壁纸填充，胶囊本体与面板来自真实页面截图；
  合成脚本见本地任务目录 `tmp/acceptance/readme-screenshots-20261108/compose-capsule.py`
  （不随仓库提交）。
- 采集与数据播种过程记录在本地任务目录
  `tmp/acceptance/readme-screenshots-20261108/report.md`（不随仓库提交）。
