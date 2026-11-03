# 全局快速捕获（Quick Capture）

> 模块文档：功能与用户说明 / 交互语义 / 数据模型 / 隐私与限制。
> 实现契约见 [`tmp/acceptance/quick-capture/PLAN.md`](../../tmp/acceptance/quick-capture/PLAN.md)
> （`tmp/` 不提交）；**实现细节与接口以代码为准**，本文与代码冲突时以代码为准并回写本文。
> 状态口径：本文描述功能设计；真机验收结论只在验收报告中记录，本文不代填验证结果。

## 1. 功能范围

目标：在不打断当前工作的前提下完成一次捕获——任意界面按一次全局快捷键，弹出独立的轻量捕获
窗口，输入内容、选择类型、键盘提交，提交后窗口隐藏、主界面不展开。

本版本（v0.7，2026-11-03）交付：

- 独立捕获窗口（静态窗口 `capture`，常驻隐藏、复用 WebView、唤起即显示）；
- 全局快捷键 `Ctrl+Shift+Space` 行为变更：从「显示主窗并聚焦快速录入」改为「打开/聚焦快速捕获窗口」；
- 第二入口：托盘菜单与主窗右键菜单的「快速捕获」，与全局热键共用同一 toggle 行为；
- 五种捕获类型：快速任务 / 简单待办 / 想法 / 文字片段 / 链接；
- 临时收集箱（未归类的捕获内容集中存放，可转为任务、标记已处理、删除）；
- 草稿自动保存与恢复（进程重启/再次唤起不丢未提交内容）；
- 提交幂等（重试不产生重复任务/重复记录）与唤起后焦点恢复（尽力而为）；
- 数据模型 SQLite 迁移 v17（捕获记录表 + 草稿表），并纳入备份注册表。

明确不做（范围红线，不属本功能缺陷）：完整笔记系统、全局搜索、网页正文抓取、额外 AI/网络服务、
场景工作区、文件暂存架、剪贴板采集改造、Agent 队列改造。不新增 npm / cargo 依赖。

## 2. 快捷键与窗口行为变更

| 项目 | 旧行为 | v0.7 行为 |
|---|---|---|
| `Ctrl+Shift+Space` | 显示主窗口并聚焦任务快速录入框 | 打开/聚焦独立快速捕获窗口；**不显示、不展开主窗，不改胶囊状态** |
| 再次按下（窗口已可见且聚焦） | — | 隐藏捕获窗口（toggle） |
| 窗口已可见但未聚焦 | — | 聚焦该窗口，不重复创建 |

- 注册仍沿用 `src-tauri/src/lib.rs` setup 与 `set_hotkeys_enabled` 的两条固定组合，**不重复注册**；
  快捷键总开关语义不变。
- 捕获窗口为第 4 个静态窗口（`main` / `context-menu` / `notification` / `capture`），
  `src-tauri/tauri.conf.json` 中常驻声明，默认 `visible: false`，关闭后隐藏而非销毁，复用同一 WebView。

窗口属性（逻辑像素）：

| 属性 | 值 |
|---|---|
| label / 页面 | `capture` / `capture.html` |
| 尺寸 | 640 × 360，不可调整大小、不可最大化/最小化 |
| 装饰 | 无边框、透明、无系统阴影、始终置顶、不占任务栏 |
| 初始状态 | `visible: false`、`focus: false`（首次唤起才显示并聚焦） |

- 窗口**不**参与贴边磁吸/停靠/区域裁剪，不改主窗与胶囊状态；不可调整大小 + 无边框 + 不占任务栏，
  不触发 Windows Snap Layout。
- capability 仅 `core:default`、`core:event:default`；捕获窗口前端不直接调用 Tauri window API，
  创建/显示/隐藏/关闭全部由后端 `quick_capture` 模块管理。

### 2.1 唤起定位

1. 唤起前记录当前前台窗口 HWND（无效或属于本进程则忽略），只存运行时内存，绝不落库；
2. 目标显示器：前台窗口所在显示器 → 光标所在显示器 → 主显示器；
3. 逻辑尺寸 640×360，物理尺寸按目标显示器 `scale_factor` 换算；在显示器 **work_area**（物理像素、
   排除任务栏）内居中并整体收敛到 work_area 内；可用区小于窗口时先缩小窗口；
4. `show()` + `set_focus()`（unminimize/set_focus 语义，与 `show_and_focus` 一致），不显示/不展开主窗；
5. 唤起后发出 `quick-capture-summoned` 事件，前端据此重载草稿与状态。

### 2.2 隐藏与焦点恢复

- 统一入口 `hide_capture(app, restore_focus)`：隐藏窗口 → 若 `restore_focus` 且前台仍是 capture 窗口，
  用 `window_manager::focus_window(hwnd)` **单次尽力**恢复唤起前的前台窗口 → 发出
  `quick-capture-hidden` 事件 → 清空记录的前台 HWND。
- 恢复失败（原窗口已关闭、无权限、系统拒绝前台切换）**静默降级**，不重试、不弹错误。
- 失焦（`WindowEvent::Focused(false)`）：通知前端保存草稿后隐藏，但**不抢回焦点**
  （用户已主动切走，禁止把焦点强行拉回）。
- `Alt+F4` / 关闭请求：`api.prevent_close()` 后走 `hide(restore_focus=true)`，窗口常驻复用。
- Esc、关闭按钮、提交成功后隐藏，均走同一隐藏入口（`quick_capture_hide` 命令只在捕获窗口页面可达）。
- 应用退出：若捕获窗口可见，先发出 `capture-flush-draft` 并等待最多 300ms（有界，不无限循环）再继续
  原有退出排空；草稿最终由前端 invoke 保存。
- 生命周期：隐藏后无轮询/无定时器；全局热键不重复注册；窗口事件监听在初始化时注册一次。

## 3. 五种捕获类型与保存目标

| kind | 含义 | 保存目标 |
|---|---|---|
| `task` | 快速任务（自然语言解析时间 / 重复 / 提前提醒） | `tasks` + `quick_capture_items`（`status='converted'`、回写 `task_id`） |
| `todo` | 简单待办（仅标题，不写提醒、不解析时间） | `tasks` + `quick_capture_items`（`status='converted'`、回写 `task_id`） |
| `idea` | 临时想法 | 收集箱（`quick_capture_items.status='inbox'`） |
| `text` | 普通文字片段 | 收集箱（`status='inbox'`） |
| `link` | 临时链接（URL + 可选备注） | 收集箱（`status='inbox'`，`url` 存 URL、`note` 存其余文字） |

- 捕获记录状态：`inbox` 未处理 / `handled` 已标记处理 / `converted` 已转成任务。
- 任务/待办类型复用现有任务创建链路（自然语言解析、时间、重复、提醒、持久化、列表刷新），
  不新建第二套任务系统。
- 类型选择：底部 5 个类型 chip（`role="radiogroup"`，方向键切换、Tab 可进出）；类型切换**不清空**已输入内容。
- 自动识别仅做建议：检测到 URL 或中文时间词时显示「建议：链接/任务」小按钮，**点击才切换**，
  绝不静默改类型。
- 长度与空内容：
  - `content` 1..=4000 字符（trim 后为空直接拒绝，不产生空记录）；
  - `url` ≤ 2048，`note` ≤ 2000；
  - 任务标题取 content 首行 trim 后 ≤200（超长返回校验错误，**不静默截断**），其余内容写入
    description（≤1000）；
  - 前端 textarea `maxLength=4000`，仅在接近上限（>3600）时显示字符计数。

## 4. 临时收集箱

- 完整模式新增「收集箱」导航 tab（导航共 8 个 tab，收集箱第 5 位）：`inbox`，label「收集箱」，
  图标 lucide `Inbox`，徽标 = 未处理数；
  tab 顺序 `tasks, agents, actions, clipboard, inbox, history, roadmap, settings`（`Ctrl+1..8`）。
- 列表默认只显示 `inbox` 未处理项，切换「全部」显示所有状态；按 `created_at DESC` 排序。
- 每项显示：类型图标 + 标签、内容（2–3 行截断）、创建时间、操作按钮
  （复制 / 转为任务 / 标记已处理 / 删除；均带 `aria-label` 与 `data-tip`）；删除使用行内二次确认，
  不弹原生 `confirm`。
- 空状态、加载态、错误态齐备；操作后局部刷新。
- 转为任务：`inbox → converted`，写入 `task_id`，走与快速任务相同的创建链路（`nlp::parse` 提取时间）。
- 主窗口订阅 `quick-capture-created` 事件：刷新任务列表/统计与收集箱未处理计数
  （复用现有 `scheduleTaskRefresh` 合并刷新语义），进入收集箱 tab 时按需加载。

## 5. 草稿与恢复语义

- 前端在内容/类型变化后 **600ms 防抖**调用 `quick_capture_save_draft`；**只有后端返回 `saved_at`
  才显示「草稿已保存 HH:mm」**，否则显示「保存失败，点击重试」，禁止无确认的「已保存」。
- 类型切换立即保存；空内容时只更新「上次类型」，不写空草稿。
- 隐藏/失焦/关闭/提交失败：立即 flush（不等防抖）；提交失败保留输入内容与草稿。
- 提交成功：后端在同一事务内删除草稿，前端重置状态，**不恢复旧草稿**。
- 再次唤起/重启恢复：每次 `quick-capture-summoned` 调用 `quick_capture_state`；有草稿则回填并提示
  「已恢复草稿」；`last_type`（设置键 `quick_capture_last_type`，默认 `task`）决定默认类型。
- 应用退出：`capture-flush-draft` 触发一次立即保存（尽力而为，有界等待 ≤300ms）。
- trim 后为空 → 保存即清空草稿；不产生空记录。

## 6. 数据模型（SQLite 迁移 v17）

迁移在 `src-tauri/src/db/mod.rs` 的 `MIGRATIONS` **末尾追加**（不修改已发布迁移），失败整体回滚：

```sql
CREATE TABLE quick_capture_items (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task','idea','text','todo','link')),
  content TEXT NOT NULL,
  url TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','handled','converted')),
  task_id TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_quick_capture_client ON quick_capture_items(client_id);
CREATE INDEX idx_quick_capture_status_created ON quick_capture_items(status, created_at);
CREATE INDEX idx_quick_capture_task ON quick_capture_items(task_id);

CREATE TABLE quick_capture_draft (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'active'),
  kind TEXT NOT NULL CHECK (kind IN ('task','idea','text','todo','link')),
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- 草稿表为单行表（`id='active'`），只保存一条未提交草稿；提交成功由事务删除。
- 所有时间使用现有 `now_iso()`（UTC ISO8601）；排序按 `created_at DESC`。
- 两张表都是用户数据，登记进 `src-tauri/src/commands/backup.rs` 的 `BACKUP_TABLES`，
  分类与任务数据同组（`core`），随备份导出/恢复；注册表覆盖校验测试会检查新表是否登记。
- 设置键 `quick_capture_last_type` 加入 `db::Settings` 与 `commands/settings.rs` 的 `ALLOWED_KEYS`
  和合法性校验（五个合法值）。

### 6.1 提交幂等（核心）

`quick_capture_submit` 在**单事务**内完成：

1. 按 `client_id` 查询：已存在直接返回 `duplicate=true`，不重复建任务；
2. 插入 `quick_capture_items`（kind/status 按上表）；
3. 若 kind 为 task/todo：同一事务内创建任务并回写 `task_id`、`status='converted'`；
4. 删除 `quick_capture_draft` 中的 active 草稿；
5. COMMIT 后返回记录与任务 ID。

- 事务失败 → 全部回滚（无半条任务、无草稿被误删），前端保留输入并用**同一** `client_id` 重试。
- 唯一索引冲突（并发/重试竞态）→ 回查 `client_id` 返回已存在记录，不报重复错误。
- `client_id` 由前端在首次输入/类型切换时用 `crypto.randomUUID()` 生成一次，提交成功后重置；
  失败重试复用同一 id。
- 提交成功/转换成功后发出 `quick-capture-created` 事件（含 kind/id/task_id/status）。
- 事件清单：`quick-capture-summoned`、`quick-capture-hidden`、`quick-capture-created`、
  `capture-flush-draft`。

## 7. 隐私与数据安全

- **纯本地**：无任何外网请求代码；不上传捕获内容、Prompt、路径或密钥。
- 捕获内容只来自用户显式输入；**不读取剪贴板、不做后台采集**，也不采集密码/凭据；
  收集箱的「复制」按钮是用户显式操作。
- **日志与错误信息绝不记录捕获正文**，只记录类型/计数/耗时等元数据。
- 唤起前的前台窗口 HWND 只存运行时内存，绝不落库；焦点恢复失败静默降级。
- 正文入库是功能必需（用户显式提交后持久化），草稿也只存本地 SQLite，随备份策略处理；
  与剪贴板模块的敏感过滤/排除名单机制相互独立。
- 捕获窗口 capability 最小化（`core:default` + `core:event:default`），业务命令均为自定义命令。

## 8. 已知限制与未验证项

设计限制（不属缺陷）：

- 捕获窗口固定 640×360、不可调整大小/最大化/最小化；多显示器下按 work_area 收敛，
  可用区过小时由后端缩小窗口。
- 焦点恢复是**尽力而为**：原窗口已关闭、无前台切换权限或系统拒绝时静默失败，不提示、不重试。
- 失焦隐藏不抢回焦点；用户切走后再次唤起才重新显示。
- 只支持五种文本类捕获（无图片/文件/富文本/手写）；不含完整笔记编辑、搜索、分类标签、回收站。
- 自动识别只做建议，不做静默类型改写；时间/重复解析沿用现有任务 NLP 能力边界。
- 幂等以 `client_id` 为粒度：同一内容分两次捕获视为两条记录（无内容级去重）。
- 每次唤起重新读取草稿与状态；隐藏后无后台轮询。

未验证项（截至 2026-11-03，需真机/构建验收补齐，本文不宣称通过）：

- Windows 真实桌面下的全局快捷键唤起、`show()`+`set_focus()` 前台行为与焦点恢复效果；
- 多显示器、125%/150%/200% DPI 下的物理尺寸换算、居中与 work_area 收敛；
- 深/浅主题、两套视觉预设下捕获窗口与收集箱的实际渲染（jsdom 单测不能替代真机视觉走查）；
- 与主窗/胶囊/通知窗口并存时的焦点、Z 序与快捷键冲突表现；
- 安装包形态（`npm run tauri build`）下的行为与升级兼容。

## 9. 用户操作说明

1. **唤起**：任意界面按 `Ctrl+Shift+Space`，或点托盘/右键菜单「快速捕获」；屏幕中央（当前窗口
   所在显示器）弹出捕获窗口，输入框自动聚焦；主窗口与其他窗口保持原状。
2. **输入**：直接输入内容（最多 4000 字）；需要换行用 Enter，提交用 `Ctrl+Enter`。
3. **选类型**：底部点击或方向键选择「快速任务 / 待办 / 想法 / 文字 / 链接」；也可点击
   「建议：链接/任务」采纳自动识别建议。类型切换不会清空内容。
4. **提交**：`Ctrl+Enter` 或点击主按钮。成功提示「已保存 · 任务已创建 / 已加入收集箱」约 500ms 后窗口隐藏；
   任务类内容会立即出现在任务列表（重复/提醒等按自然语言解析结果生效），其余进入收集箱。
5. **暂不提交**：直接按 `Esc`、点右上角关闭或切换到别的窗口——已输入内容自动保存在草稿中；
   下次唤起会提示「已恢复草稿」并回填，`last_type` 记上次类型。
6. **关闭并回到原窗口**：`Esc` 或关闭按钮隐藏窗口后会**尽力**把焦点还给唤起前的窗口。
7. **处理收集箱**：完整模式左侧导航「收集箱」（`Ctrl+5`），默认只看未处理；可复制、转为任务、
   标记已处理或删除（删除需行内确认）；徽标显示未处理数量。
8. 应用设置/帮助中关于 `Ctrl+Shift+Space` 的旧说明（「显示主窗口并聚焦快速录入」）已同步为
   「打开快速捕获窗口」。

## 10. 版本记录

- **2026-11-03 · v0.7**：新增全局快速捕获。独立常驻捕获窗口（640×360、居中、无边框透明、不占任务栏）、
  `Ctrl+Shift+Space` 行为改为打开捕获窗口、五种捕获类型、临时收集箱（导航共 8 个 tab，收集箱第 5 位）、
  草稿自动保存与恢复、提交幂等、唤起前焦点恢复（尽力）、SQLite v17 两表与备份登记。
  验证状态：见验收报告与 `docs/TESTING.md` 对应条目；真机项未验证的如实标注，不代填结论。

## 11. 相关代码与文档

- 后端：`src-tauri/src/quick_capture/`（窗口与命令 `mod.rs`、DB 事务与校验 `store.rs`）；
  `src-tauri/src/lib.rs`（热键分支 / 初始化 / 退出 flush / 命令注册）；
  `src-tauri/src/db/mod.rs`（迁移 v17、设置键）；
  `src-tauri/src/commands/tasks.rs`（抽出的任务事务函数）；`src-tauri/capabilities/capture.json`。
- 前端：`capture.html`、`src/capture/`（捕获窗口）、`src/components/inbox/`（收集箱面板）、
  `src/store/useCaptureStore.ts`、`src/lib/bridge.ts`（类型与命令桥接）。
- 相关文档：[架构说明](../ARCHITECTURE.md) · [测试记录](../TESTING.md) · [功能规划](../ROADMAP.md)。
