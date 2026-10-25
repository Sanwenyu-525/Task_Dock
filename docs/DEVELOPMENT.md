# 开发与构建指南

## 一、环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（开发用 22） | 前端构建 |
| Rust | stable（rustup） | 后端；Windows 需 MSVC 工具链 |
| Windows SDK + MSVC C++ 生成工具 | Win10/11 | 链接 |
| WebView2 运行时 | 常驻 | Windows 10/11 一般已内置 |

> 国内网络：本项目已将 npm 切换到 `registry.npmmirror.com`、cargo 切换到
> `rsproxy.cn` 稀疏索引（见 `~/.npmrc` / `~/.cargo/config.toml`）。

## 二、常用命令

```bash
# 安装前端依赖
npm install

# 开发模式（Vite + Tauri，热更新）
npm run tauri dev

# 仅前端类型检查 + 构建（产物 dist/）
npm run build

# 单元测试（前端 vitest / 后端 cargo test）
npm test
cd src-tauri && cargo test

# 生成应用图标（scripts/gen-icons.mjs，零依赖 PNG/ICO 编码）
npm run icons

# 构建 Windows 安装包（NSIS + MSI）
npm run tauri build
# 产物：src-tauri/target/release/bundle/nsis/Task Dock_0.1.0_x64-setup.exe
```

## 三、项目结构

```
task_dock/
├── src/                        # React 前端
│   ├── lib/bridge.ts           # 类型化 IPC 桥接（唯一 invoke 入口）
│   ├── lib/navigation.ts       # 导航桥接 + 展示辅助纯函数（含单测）
│   ├── lib/format.ts           # 纯函数时间/文本格式化（含单测）
│   ├── store/                  # Zustand：tasks / agents / settings / ui / navigation
│   ├── hooks/useEdgeSnap.ts    # 贴边吸附 + 窗口持久化
│   ├── components/navigation/  # TargetMenu / AppPicker / WorkspaceLauncher
│   └── components/             # TitleBar / 三模式视图 / 任务 / Agent / 历史 / 设置
├── src-tauri/                  # Rust 后端
│   ├── src/commands/           # 命令层（tasks/agents/navigation/settings/data/system）
│   ├── src/db/                 # SQLite + 迁移（当前 v4）+ 设置
│   ├── src/agents/             # Agent 事件总线 + Adapter（只观测，不导航）
│   ├── src/navigation/         # 统一导航（router/app_discovery/window_manager/
│   │                           #   target_resolver/agent_navigation）
│   ├── src/scheduler.rs        # 提醒调度引擎
│   ├── src/nlp.rs              # 中文自然语言解析（含单测）
│   ├── src/recurrence.rs       # 重复规则计算（含单测）
│   ├── src/lib.rs              # 窗口/托盘/热键/自启动装配
│   └── icons/                  # 应用图标与托盘状态图标（脚本生成）
├── scripts/gen-icons.mjs       # 图标生成器
└── docs/                       # 架构 / 许可证 / Adapter / 测试 / 路线图
```

### 导航系统命令速查（v0.4）

| 命令 | 用途 |
|---|---|
| `nav_scan_apps(force?)` | 软件扫描（开始菜单/注册表/UWP/常用路径；后端 5 分钟缓存） |
| `nav_list_windows()` | 当前可交互顶层窗口（窗口选择器） |
| `nav_list_targets` / `nav_save_target` / `nav_update_target` / `nav_delete_target` | 目标 CRUD（保存时全量安全校验 + app_key 幂等去重） |
| `nav_link_task` / `nav_unlink_task` / `nav_update_task_link` / `nav_task_targets` / `nav_all_task_links` | 任务关联管理 |
| `nav_navigate(target_id, options?)` | **统一跳转入口**（前端只传目标 ID；结果含 verification_level / fallback_used） |
| `nav_agent_capabilities(source_id)` | Agent 跳转能力（证据化，动态探测） |
| `nav_agent_action(source_id, "open_app"|"focus_window")` | Agent 树按钮动作 |
| `nav_agent_open_workspace(source_id, dir)` | IDE 类 Agent 打开工作区目录 |
| `nav_recent_logs` / `nav_prune_logs` | 导航执行流水 |

## 四、代码规范

- TypeScript：`strict` + `noUnusedLocals` + `noUnusedParameters`，提交前 `npm run build` 必须通过。
- Rust：正常错误处理（`AppError` 统一出口），不 `unwrap` 用户输入；`cargo clippy` 建议通过。
- 新增设置项必须同时加入：`db::Settings` 字段、`commands::settings::ALLOWED_KEYS` 白名单。
- 新增数据库变更：只在 `MIGRATIONS` 末尾追加新版本 SQL，不修改已发布版本。
- 新增 Agent 事件字段：同步更新 `AgentEvent`、`validate_event`、`docs/AGENT_ADAPTERS.md`。
- 导航新增目标类型：同步 `NavigationTargetType`、`target_resolver::validate_input`、
  `router::execute_with_ctx` 分支与 `APP_NAVIGATION_MATRIX.md`；新增 Agent 跳转能力必须给证据标注。

## 五、调试技巧

- 日志：默认 `info` 级别，`RUST_LOG=debug npm run tauri dev` 看详细日志；
  HTTP 接入日志**不含请求体**（脱敏设计，请勿改为打印 body）。
- 数据库位置：`%APPDATA%\com.taskdock.desktop\task-dock.db`（可用任何 SQLite 客户端打开）。
- Agent 测试：无真实 Agent 时用「模拟控制台」；有真实 Agent 时先
  `GET /api/v1/health` 确认端点存活，再发单条事件。
- 卸载 Codex 钩子：「Agent → Codex 卡片 → 卸载钩子」（只移除 Task Dock 写的条目）。
- 单实例：应用按 `identifier`（`com.taskdock.desktop`）加互斥锁，重复启动只会聚焦已有窗口后退出。
  所以「启动后没反应」先看任务管理器里是不是已有实例（debug 与 release 共用同一把锁）。
  确实需要并行跑两个实例做对照时，用临时配置换 identifier（注意数据目录也会跟着变）：
  `src-tauri/tauri.dev.conf.json` 写 `{ "identifier": "com.taskdock.desktop.dev" }`，
  再 `npm run tauri dev -- --config src-tauri/tauri.dev.conf.json`。

## 六、已知构建注意

- 首次 Rust 编译 5–15 分钟（取决于镜像与机器）；后续增量约 1–2 分钟。
- `cargo test` 会执行 `tauri::generate_context!()`，需 `dist/` 存在（先 `npm run build`）。
  若遇「拒绝访问」写入缓存，删除 `src-tauri/target/debug/build/task-dock-*` 后重试。
- 未签名安装包首次运行会被 SmartScreen 拦截（「更多信息 → 仍要运行」），属预期现象。
