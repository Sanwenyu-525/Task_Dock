# 测试结果与未解决问题

> 测试日期：2026-10-25 · 环境：Windows 11 · Node 22.22.2 · Rust 1.95.0 (MSVC)
> 原则：**不以模拟测试冒充真实接入**；所有未验证项明确列出。

## 一、自动化测试结果

### 1. Rust 单元测试（cargo test）

```
running 29 tests
test result: ok. 29 passed; 0 failed
```

覆盖：
- **NLP 中文解析（18 例）**：明天下午三点、后天晚上八点、每周一早上九点、30 分钟后、
  提前 30 分钟、今晚 8 点、下周三下午 2 点、每月 3 号、每周一至周五、9:30、十二点、
  日期-only 默认 09:00、无时间保留原文、10 月 28 日、三点半、每天晚上十点、每两周周一、马上；
- **重复规则（9 例）**：每天/隔天/每周单日/每周多日/隔周锚点/每月当日/月末钳制
  （2 月 28 日）/未知 freq/中文描述；
- **调度器（2 例）**：到期提醒查询与触发路径、重复任务推进（旧提醒清理、新提醒生成、
  fired 状态不变）。

### 2. 前端测试（vitest）

```
Test Files  1 passed (1)
     Tests  11 passed (11)
```

覆盖：日期标签（今天/明天/后天/月日）、截止格式化、相对时间（分钟/小时/天、过去/未来）、
过期判断、时长格式化、优先级标签边界、datetime-local 互转。

### 3. 类型检查与构建

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit`（strict + noUnusedLocals） | ✅ 0 错误 |
| `npm run build`（tsc + vite build） | ✅ 通过（dist/ 286 KB JS + 17 KB CSS） |
| `cargo check` | ✅ 通过（6 个 dead_code 警告，均为预留 API） |

### 4. 已知测试缺口（诚实记录）

- AgentHub::ingest 的**集成测试**未编写（需要 AppHandle）；
  其 SQL 状态机逻辑经手工端到端验证（见下）。
- 前端组件无自动化 UI 测试（未引入 testing-library）；
  经真实运行验证（见下）。
- 休眠/唤醒补偿未经真实休眠测试（按挂钟比对的设计经代码审查，逻辑等价实现有参考实现）。

## 二、端到端运行验证（真实运行，非模拟冒充）

以下在 Windows 11 上真实运行 `target/debug/task-dock.exe` 完成：

### 1. 应用启动（冒烟测试）

```
INFO task_dock_lib::db: 数据库迁移至 v1
INFO task_dock_lib::agents::mock: Mock Adapter 启动（模拟状态源）
INFO task_dock_lib::scheduler: 提醒调度引擎启动（1s 粒度）
INFO task_dock_lib::agents::file_drop: 文件投递 Adapter 启动，监听目录 ...\agent-inbox
INFO task_dock_lib::commands::data: 启动自动备份完成: ...\backups\backup-20261025-162633.json
INFO task_dock_lib: Task Dock 启动完成（数据目录: ...）
INFO task_dock_lib::agents::http_ingest: 本地 HTTP 接入监听 127.0.0.1:47821
INFO task_dock_lib::agents::mock: [模拟] 会话开始 mock-sess-... (重构登录模块)
INFO task_dock_lib::agents::mock: [模拟] 会话结束 mock-sess-... outcome=completed
```

窗口持续运行 170 秒无崩溃；Mock 会话按 30 秒周期完整走完 running → completed 生命周期。

### 2. HTTP 接入端点（curl 实测）

| 用例 | 请求 | 结果 |
|---|---|---|
| 健康检查 | `GET /api/v1/health` | ✅ 200 `{"ok":true}` |
| 错误令牌 | `POST /api/v1/events`（Bearer wrong-token） | ✅ 401 unauthorized |
| 合法事件 | 正确令牌 + codex running 事件 | ✅ 200 `{"accepted":1}` |
| 未注册来源 | 正确令牌 + source_id=unknown-source | ✅ 422 event rejected |
| 日志脱敏 | 日志仅含方法/路径/状态/对端/耗时 | ✅ 无请求体 |

### 3. 文件投递通道（实测）

| 用例 | 结果 |
|---|---|
| mock 源事件文件 | ✅ 已处理并删除 |
| 已禁用源（qoder）事件文件 | ✅ 正确拒绝（来源已禁用）并移入 failed/ |
| waiting + pending_items 事件 | ✅ 正常进入状态机 |

### 4. Release 安装包（已验证）

```
npm run tauri build   → EXIT=0（20m33s，含 WiX 下载）
Finished 2 bundles at:
  bundle/nsis/Task Dock_0.1.0_x64-setup.exe (2.42 MiB)
  bundle/msi/Task Dock_0.1.0_x64_en-US.msi  (3.30 MiB)
```
release exe 直接运行验证：进程稳定、全部适配器启动、`GET /api/v1/health` 返回 200。
安装包已归档至仓库 `release/` 目录（未签名，首次运行需「更多信息 → 仍要运行」）。

### 5. 单实例保护（实测）

首个实例运行中，再启动同一个 exe：

| 用例 | 操作 | 结果 |
|---|---|---|
| 重复启动 | 已有实例运行时再启动一次 | ✅ 第二进程立即退出（EXIT=0），进程数保持 1 |
| 窗口聚焦 | 已有实例窗口处于隐藏状态时再启动 | ✅ 已有实例窗口显示并获得焦点 |
| 端口独占 | 重复启动后 `GET /api/v1/health` | ✅ 仍 200，未出现双绑定/绑定失败 |
| 托盘图标 | 观察通知区域 | ✅ 始终 1 个图标 |

### 6. 修复记录（测试驱动发现的问题）

1. Tauri v2 事件回调为单参数（`on_window_event`）；
2. `tauri_plugin_autostart` 方法名为 `autolaunch()` 而非 `autostart()`；
3. 主线程直接 `tokio::spawn` 无 reactor → 改 `tauri::async_runtime::spawn`；
4. 前端 invoke 参数名需 snake_case（Tauri v2 不做驼峰转换）；
5. NLP：裸时刻 1-6 点按下午、今晚 +12、无日期默认今天、周一至周五的周前缀；
6. 重复规则：月度先查当月；SQL 占位符编号唯一化；
7. `formatRelative` 单位阈值错误（30 分钟显示为 1 小时）。
8. **缺少单实例保护**：重复启动会多开进程 → 抢占 47821 端口、通知区域出现多个托盘图标，
   非正常结束的实例还会留下「幽灵图标」。已接入 `tauri-plugin-single-instance`，
   并放在 `Builder` 的**第一个**插件位置（插件按注册顺序初始化，必须早于建库/绑端口/建托盘）。

## 三、明确未验证项（不冒充完成）

| 项 | 状态 | 说明 |
|---|---|---|
| **Codex 真实接入** | ⚠️ 未验证 | 钩子安装器已实现，但本机无 Codex CLI 安装，未经真实 Codex 环境联调 |
| **Qoder / WorkBuddy 官方接口** | ⚠️ 未验证 | 未找到公开官方状态接口；当前为 stub 来源（UI 标注「未验证」），可走通用接入 |
| **Codex App Server** | ⬜ 未实现 | 路线已评估并记录在 docs/AGENT_ADAPTERS.md，列入 v0.2 |
| **休眠/唤醒补偿** | ⚠️ 未经真实休眠 | 按挂钟每秒比对的设计；休眠恢复后到期提醒会补触发（逻辑已验证，未做真实休眠测试） |
| **Windows 通知** | ⚠️ 未经真实弹窗 | 通知插件调用路径已通（Mock 完成时会触发）；未截图验证 toast 样式 |
| **安装包** | ✅ 已构建 | `release/Task Dock_0.1.0_x64-setup.exe`（NSIS 2.42 MiB）与 `release/Task Dock_0.1.0_x64_en-US.msi`（3.30 MiB）；release exe 已验证可启动、HTTP 端点 200 |
| **UI 视觉细节** | ⚠️ 未走查 | 严格类型 + 构建通过 + 运行无报错；未经人工视觉走查 |

## 四、复现命令

```bash
npm test                              # 前端 11 例
cd src-tauri && cargo test            # Rust 29 例
npm run build                         # tsc + vite
npm run tauri build                   # 安装包
```
