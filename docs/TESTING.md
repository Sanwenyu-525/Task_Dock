# 测试结果与未解决问题

> 测试日期：2026-10-29（v0.5）· 环境：Windows 11 · Node 24.18.0 · Rust 1.95.0 (MSVC)
> 原则：**不以模拟测试冒充真实接入**；所有未验证项明确列出。
> v0.5 智能剪贴板的详细测试、性能与阻塞项见
> [clipboard/08-testing-performance.md](clipboard/08-testing-performance.md)、
> [clipboard/09-implementation-report.md](clipboard/09-implementation-report.md) 与
> [clipboard/10-remediation-acceptance.md](clipboard/10-remediation-acceptance.md)。

## 一、自动化测试结果

### 0. v0.5 汇总（2026-10-29）

| 检查 | 结果 |
|---|---|
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets --all-features` | 通过，0 警告 |
| `cargo test --all-targets` | **244 passed / 0 failed**（lib）；10 ignored（手动性能与真机工具） |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | 16 文件 / 109 测试通过 |
| `npm run build` | 通过（459.80 kB JS / 67.70 kB CSS） |
| `npx tauri build`（release） | 通过，4m49s；NSIS 3.98 MiB / MSI 6.11 MiB |
| release 剪贴板性能 | 2/2 通过，列表 p95 1.001 ms、200 连拍 2.799 s（预算 8 s） |
| 真机验收 | **46/46 PASS**（`clipboard/evidence/acceptance-final13.log`） |
| 第三方应用矩阵 | **5/5 PASS**；微信 ENVIRONMENT BLOCKED、Agent NOT VERIFIED |

其中 v0.5 剪贴板模块内 Rust 测试 61 例：分类优先级、去重哈希、45s 分组与文本穿插、
300/组上限、HTML 清洗、高置信敏感模式、来源未知保守凭据模式、排除名单 basename、
恢复不覆盖用户新内容、富文本整组顺序、DIB/PNG/缩略图、CF_HTML 偏移、HDROP 解析、
资产清理与引用安全、保留期/条数上限、任务删除级联保留内容、图片落盘失败无半行、
粘贴状态机（写后不重发、取消保留未处理、目标关闭/焦点失败、内容竞态、恢复失败、
续跑不重发）、监听有界队列（100/1000 事件峰值与丢弃计数）、panic 隔离。
前端 109 例：`useClipboardStore` 4 例、`clipboardUi` 预检 9 例、
`PastePanel` 3 例、`ClipboardDrawer` 3 例、`AgentExportPanel` 2 例及既有测试。

### 1. Rust 单元测试（cargo test，v0.4 记录）

```
running 111 tests
test result: ok. 111 passed; 0 failed
```

覆盖（v0.3 的 80 例之上，v0.4 新增 31 例导航相关）：
- **统一导航安全校验（4 例）**：URL 协议白名单（file:/javascript:/ms-settings:/控制字符/超长拒绝）、
  exe 路径规则（相对路径/非 exe/不存在/cmd 黑名单拒绝，notepad 通过）、
  AUMID 字符集、启动参数长度与控制字符；
- **窗口管理（5 例，真机）**：顶层窗口枚举结构校验 + exe 关联、TTL 缓存命中、
  死句柄报 WindowVanished、测试进程自解析、空输入匹配拒绝；
- **软件发现（5 例）**：分类判定（浏览器/通讯/音乐/开发）、中文应用标题提示、
  app_key 去重与空 key 拒绝、**真机扫描只产出通过安全校验的目标**、
  运行状态分级（无 GUI 测试进程不得报 HasWindow）；
- **目标持久化（6 例）**：app_key 幂等去重（含覆盖改名）、危险目标拒绝
  （相对路径/cmd/ftp/javascript/不存在文件/未知类型）、任务关联 CRUD 与默认唯一、
  未知 target_id 拒绝、exe 失效标记 unavailable、导航日志读写与清理；
- **路由（4 例）**：exe 消失如实失败（不假装跳转）、URL 执行时重校验（防库内篡改）、
  **真机 notepad 启动/唤醒（验证级别如实）**、禁启设置下只允许唤醒；
- **Agent 导航（5 例）**：未知 Agent 能力全不支持（证据标注）、非法/不存在会话 ID 拒绝、
  非白名单来源拒绝、无效目录/无工作区接口拒绝、codex 能力证据化；
- **DB 迁移 v4（1 例）**：v3→v4 新表齐备 + task_agent_links 原样保留 +
  唯一约束/CHECK 生效 + 任务删除级联清理两种关联。

### 2. 前端测试（vitest，v0.4 记录）

```
Test Files  5 passed (5)
     Tests  44 passed (44)
```

覆盖：日期标签、截止格式化、相对时间、过期判断、时长格式化、优先级标签、
datetime-local 互转、Agent 树聚合（10 例）；
**导航纯函数（7 例，v0.4）**：头像色稳定、状态徽标分级（有窗口/仅进程/未运行/失效）、
验证级别文案（进程启动 ≠ 窗口确认）、结果消息（失败带原因 / 降级必标注 / 成功不含失败字样）、
目标类型标签齐全。

### 3. 类型检查与构建

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit`（strict + noUnusedLocals） | ✅ 0 错误（v0.5 复测） |
| `npm run build`（tsc + vite build） | ✅ 通过（v0.5：459.80 kB JS + 67.70 kB CSS） |
| `cargo clippy --all-targets --all-features` | ✅ 0 警告（v0.5 复测） |

### 4. 已知测试缺口（诚实记录）

- 真机剪贴板/逐项粘贴验收已完成（46/46）；微信与 Agent 类应用因环境阻塞未验证，
  详见 §六与 `clipboard/10-remediation-acceptance.md`。
- 真实监听 observed/captured/dropped/latency 未单独采样；
  队列压力为进程内测试，不能外推。
- WebView 帧率、空闲 CPU/内存、30 分钟长跑、大分组滚动、多显示器/DPI 未测量。
- 图片/文件粘贴到图形界面应用未验证（仅记事本拒绝图片时如实报告）。
- 安装/卸载/签名未验证。
- ESLint：仓库无配置文件，`npm run lint` 不存在，未伪造 lint 结果。
- 前端既有测试在 CPU 满载并行编译时出现过 3 例 5 s 超时；本次全量通过（未改阈值）。
- v0.3 记录的两项缺口（AgentHub::ingest 集成测试、前端组件 UI 测试）中，
  前端已引入 testing-library 并补充组件测试；AgentHub 集成测试仍缺。

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
npm test                              # 前端 109 例（16 文件）
cd src-tauri && cargo test            # Rust 244 例（另有 10 个 ignored 手动性能/真机工具）
npm run build                         # tsc + vite
npm run tauri build                   # 安装包
```

## 五、v0.4 统一导航真机验收（2026-10-26，Computer Use 驱动）

> 方法：正式版 exe（custom-protocol 构建）+ Windows UIA 自动化逐场景操作，所有结论有
> **数据库审计记录或进程实测**佐证；UI toast 瞬时不过记录的以 navigation_log 为准。
> 验收数据已清理，Agent 历史与设置未触碰。

### 场景结果

| 场景 | 操作 | 结果 | 证据 |
|---|---|---|---|
| 快速添加 | UIA 输入「验收演示：打开记事本」→ 创建 | ✅ Toast「已创建」+ 列表/计数更新 | UIA 树 |
| 应用选择器 | 编辑器「添加目标…」→ 搜索/空态/分类 | ✅ 打开正常；notepad 无 Win32 安装记录为真实结果（Win11 为商店应用） | UIA 树 |
| 窗口选择器 | 「从当前运行的窗口选择…」 | ✅ 列出 Chrome/ZCode/Task Dock 窗口，含标题+exe 身份 | UIA 树 |
| 手动登记 EXE | 「手动添加」C:\Windows
otepad.exe | ✅ 目标落库 → 任务关联落库 → 编辑器条目（上移/下移/默认/解除）→ 任务卡图标 | DB: navigation_targets + task_navigation_targets |
| L1 启动 | 点击任务卡「打开 记事本」 | ✅ Notepad.exe 进程真实启动（PID 102752）；**verification_level=process-spawned**（Win11 记事本 UWP 化，窗口在 ApplicationFrameHost 名下，不谎报 window-confirmed） | DB 日志 + tasklist |
| L2 唤醒 | 点击「打开 02_插件与工具生态」（Chrome 已运行） | ✅ **window-confirmed**：前台句柄核实成功；重复点击复用现有窗口 | DB 日志（focus_window/success=1） |
| 已运行复用 | 再次点击 Chrome 目标 | ✅ 不重复启动，唤醒现有窗口 | DB use_count 递增 |
| 工作区启动 | 任务卡「打开工作区」→ 启动全部（2 目标） | ✅ 顺序执行、逐项状态（等待→启动中→结果）、Chrome window-confirmed + notepad process-spawned | DB 日志 2 条 + use_count |
| Agent 树按钮 | 「全部」筛选展开 8 个来源 | ✅ 本机未装的 7 个 Agent「打开应用」按钮全部 **disabled**（证据化 not-installed） | UIA 树 |
| 会话跳转 | bridge 来源 v04-smoke-2 会话点跳转 | ✅ 诚实拒绝：success=0「该 Agent 无已知窗口身份」（纯数据通道不冒充可用） | DB 日志（resume_session/0） |
| 应用管理 | 设置页「应用与快捷方式」 | ✅ 导航偏好 6 项控件 / 已保存目标（收藏·隐藏·测试跳转·删除）/ 最近导航记录（含失败原因） | UIA 树 |
| 审计闭环 | — | ✅ use_count/last_used_at/navigation_log 全部正确落库 | DB |

### 验收发现并当场修复的缺陷（4 个，全部已修复并回归）

| # | 级别 | 缺陷 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | P0 | 正式版扫描到开始菜单畸形 .lnk 时**整个应用退出** | `[profile.release] panic = "abort"` 使 catch_unwind 失效（单测是 debug 构建未暴露） | 移除 panic=abort（Cargo.toml 注释说明原因）；真机日志确认 5+ 个畸形 lnk 全部被隔离 |
| 2 | P0 | 打开应用选择器**前端崩溃白屏**（WebView UIA 树塌掉） | zustand v5 selector 每次渲染返回新 `Set` → 严格相等比较失败 → 无限重渲染 | AppPicker/WorkspaceLauncher 的 selector 只取稳定引用，派生集合移入 useMemo |
| 3 | P0 | 手动添加后「目标已保存但关联静默失败」 | **Tauri v2 invoke 参数只认 camelCase**：bridge 层全量 snake_case 键——required 参数报 invalid args（toast 实证 `invalid args 'taskId'`），Option 参数静默失效（v0.3 的 linkTaskAgent、快速添加时间参数等同样受累） | bridge.ts + navigation.ts 全部 invoke 键改 camelCase（约 20 处）；调用方同步 |
| 4 | P2 | 关联失败无任何 UI 提示（unhandled rejection） | ManualAddForm.onSaved 未 await async 回调 | afterPick 包 try-catch + 明确错误 toast（该提示直接定位了 #3） |

### 遗留观察

- WebView2 的 UIA 提供程序在长时间高频查询后会卡住（重启进程恢复；Chrome 无此现象）——
  影响自动化测试工具而非用户交互，记录备查。
- Win11 商店版记事本等 UWP 化应用的窗口不在自身 exe 名下 → 窗口级唤醒按设计如实降级为
  process-spawned；如需窗口级支持，后续可按 AUMID/ApplicationFrameHost 特判（列入待办）。

## 六、v0.5 智能剪贴板真机验收（2026-10-29 已执行）

> 方法：隔离实例（identifier `com.taskdock.desktop.accept`、独立 appdata、CDP 9417、
> 内嵌前端 debug 构建）；真实系统剪贴板 + 真实外部窗口；每项读回来自目标应用/磁盘/
> 独立进程。原始证据：`clipboard/evidence/acceptance-final13.log`。

- 结果：**46/46 PASS**（A0、B1–B17 及 b 补充项、C1–C12、D1–D5、E1、F1、
  G1–G2、H1–H2）。覆盖 22 个必测场景；场景与检查项对应关系见
  `clipboard/08-testing-performance.md` §三。
- 关键真机证据：C3 记事本真实接收 3 项且顺序正确；C5 粘贴后恢复原剪贴板；
  C10 目标关闭停止；C11 用户中途复制的新内容不被覆盖；C12 目标拒绝图片时只报
  “动作已发送”；C6 自身粘贴不产生新历史。
- 第三方矩阵：记事本、资源管理器（CF_HDROP）、Edge 文本与 contenteditable 富文本、
  VS Code（保存后磁盘读回）均 **PASS**；微信因已登录真实用户会话
  **ENVIRONMENT BLOCKED / NOT VERIFIED**；Trae CN（Agent）停在登录/引导页
  **NOT VERIFIED**。
- 真机发现并修复两处 UI 缺陷：任务关联模式抽屉 z-index 低于编辑弹窗导致不可点选；
  删除确认框继承 `pointer-events:none` 导致可见但不可点击。D1/D3 回归通过。
- 未执行：WebView 帧率、空闲 CPU/内存、30 分钟长跑、>1000 截图、多显示器/DPI、
  图片/文件粘贴到图形界面应用；微信与 Agent 应用的接收行为未验证。
- 不把格式层单元测试折算为应用层兼容性证明，也不把未验证应用写成“支持”。
