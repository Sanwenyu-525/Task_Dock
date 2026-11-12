# 主屏小组件（Android AppWidgetProvider）

> 状态：**已实现（2026-11-12）**，2×2 与 4×2 两种尺寸；构建层验证 + 真机验证情况见文末。
> 4×4 未提供（系统选择器里不出现，配置页有明确提示），保留为后续。

## 1. 设计概要

```
任务/收集箱增删改（TasksScreen / InboxScreen / 分享保存 / 提醒动作 / 前台恢复）
  └─ notifyWidgetDataChanged()（src/lib/widgetSnapshot.ts，400ms 去抖）
       └─ buildWidgetSnapshot()：读 SQLite（listTasks/listCaptures + kv 偏好）
            └─ TaskDockWidget.pushWidgetSnapshot(JSON)
                 ├─ WidgetStore：写入 SharedPreferences（taskdock_widget/snapshot_v1）
                 └─ WidgetRenderer.updateAll()：AppWidgetManager 更新全部实例
                     （TaskDockWidget4x2 / TaskDockWidget2x2 两个 receiver）

系统侧：开机 / 桌面重建 → AppWidgetProvider.onUpdate() → 读同一份快照渲染
```

无永久轮询（`updatePeriodMillis=0`）、无常驻服务、无后台网络；更新完全由应用内数据
变化事件驱动，系统自发事件只读缓存快照。

## 2. 组件与注册链路

| 组件 | 路径 | 职责 |
|---|---|---|
| 本地 Expo module | `apps/mobile/modules/taskdock-widget/` | Provider、渲染器、快照存储、JS 接口；autolinking 自动链接（已验证 `expo-modules-autolinking resolve`） |
| Config plugin | `apps/mobile/plugins/withTaskDockWidgets.js` | prebuild 时注册两个 receiver（幂等）；`exported="false"` + `APPWIDGET_UPDATE` intent-filter + `@xml/taskdock_widget_*_info` 元数据 |
| JS 数据层 | `apps/mobile/src/lib/widgetSnapshot.ts` | 偏好解析（kv `widget_prefs`）、快照构建、推送、去抖 |
| 配置页 | `apps/mobile/src/screens/WidgetScreen.tsx` | 预览（同一份真实快照）、尺寸/内容/外观偏好 |

receiver 每尺寸一个：`TaskDockWidget4x2` / `TaskDockWidget2x2`（继承 `TaskDockWidgetBase`，
仅 layout 资源不同）。类与布局全部在 module 内（prebuild 可再生），不在 `android/` 生成物里。

## 3. 快照契约（snapshot_v1）

```jsonc
{
  "v": 1,
  "updatedAt": 1731380000000,
  "content": "today",        // today | pending | captures（kv widget_prefs.content）
  "appearance": "system",    // system | light | dark（kv widget_prefs.appearance）
  "todayCount": 3,           // 今天到期且未完成
  "pendingCount": 12,        // 全部未完成
  "captureCount": 5,         // 收集箱未删除条数
  "items": [                 // 当前 content 的行，≤4；标题取首行 ≤60 字
    { "t": "写周报：Q4 目标复盘", "done": false }
  ],
  "empty": "今天没有到期任务"
}
```

- 字段只增不改；原生按 `optString/optInt/optBoolean` 容错解析，JSON 损坏按「无快照」
  渲染空态，不抛异常。
- **安全边界**：只写标题、勾选态、计数、时间戳。**绝不写入**配对令牌、密钥、同步元数据、
  正文长文或文件路径。SharedPreferences 为应用私有（MODE_PRIVATE），不跨进程暴露。
- 标题截断与收集箱转任务的 60 字规则一致（`promoteCapture`）。

## 4. 内容语义

| content | 标题 | 计数徽标 | 行数据 |
|---|---|---|---|
| today | 今天 | `todayCount` | 今天到期未完成（`selectTasks(tasks,"today")`，与任务页同排序）≤4 条 |
| pending | 待办 | `pendingCount` | 全部未完成 ≤4 条 |
| captures | 收集箱 | `captureCount` | 最新收集箱条目 ≤4 条（done 恒 false） |

无数据显示 `empty` 文案（「今天没有到期任务」「没有待办任务」「收集箱是空的」）。

## 5. 外观与主题

- `appearance=light/dark`：直接按该配色渲染。
- `appearance=system`：渲染时读 `Configuration.UI_MODE_NIGHT_MASK`。系统切换明暗后，
  下次应用回到前台（App 的 version 效果）重推快照即重渲染——已通过产品文案告知
  「下次打开 TaskDock 时小组件同步重渲染」。
- 配色镜像 `src/theme/tokens.ts` 的语义 Token（RemoteViews 无法复用 TS Token），映射表：

| Token（light/dark） | Android 资源 |
|---|---|
| card `#FFFFFF` / `#121A28` | `taskdock_widget_card_light/dark`（card drawable solid） |
| cardBorder `#E4E8F0` / rgba(148,180,226,.14) | card drawable stroke（`#2494B4E2`） |
| text `#0F172A` / `#E9EFFA` | `taskdock_widget_text_light/dark` |
| muted `#5D6B80` / `#93A5BD` | `taskdock_widget_muted_light/dark`（空态、未完成勾选环） |
| faint `#94A1B5` / `#6C7F99` | `taskdock_widget_faint_light/dark`（页脚） |
| accent `#3A5BEF` / `#8FA8FF` | `taskdock_widget_accent_light/dark`（计数徽标字色） |
| accentSoft rgba(58,91,239,.10) / rgba(143,168,255,.16) | `taskdock_widget_accent_soft_*`（徽标底 `#1A3A5BEF`/`#298FA8FF`） |
| ok `#0E8F63` / `#37D399` | `taskdock_widget_ok_light/dark`（完成勾选圆） |

卡片圆角 16dp（`radius.row`），与配置页预览一致；明暗切换靠 `setBackgroundResource` /
`setTextColor` 程序化覆盖（XML 内为浅色默认值）。

RemoteViews 约束：不能动态增删子视图 → 行槽位固定（4×2 三行、2×2 一行）；
裸 `View` 不在白名单 → 勾选指示用固定尺寸空 `TextView` 换 drawable。

## 6. 点击行为

整卡 `PendingIntent` → `Intent(ACTION_VIEW, "taskdock://route/<tab>")`（`setPackage` 限定
本应用，`FLAG_IMMUTABLE|FLAG_UPDATE_CURRENT`）。`taskdock://route/tasks` / `route/inbox`
由 `src/lib/nav.ts` 的 `parseWidgetRouteUri` 白名单解析，App 深链处理（冷启动 +
`onNewIntent` 双覆盖）切到任务/收集箱 Tab。深链不在白名单的链接一律忽略。

## 7. 更新触发点（当前实现）

| 触发 | 位置 |
|---|---|
| 启动 / 前台恢复 / 转任务 / 提醒动作 / 分享保存 | `App.tsx` 的 `version` 效果 → `notifyWidgetDataChanged()` |
| 任务勾选/删除/新建/编辑 | `TasksScreen` 四个处理器 |
| 收集箱录入/删除 | `InboxScreen.submit/remove`（转任务经 `onPromoted` 走 App version） |
| 小组件偏好变化 | `WidgetScreen.savePrefs` → `refreshWidgetSnapshot(next)` 即时推送 |
| 开机 / 桌面重建 / 应用更新 | 系统 `onUpdate` / `onAppWidgetOptionsChanged` 读缓存快照 |

## 8. 测试矩阵与验证状态

| 用例 | 通道 | 状态（2026-11-12） |
|---|---|---|
| prebuild 清单含两个 receiver 与元数据 | A（静态） | PASS（见验收报告） |
| autolinking 解析本地 module | A | PASS |
| typecheck | A | PASS |
| 原生编译（assembleDebug/assembleRelease） | A | Debug PASS；Release 见验收报告（环境阻塞） |
| 两个 Provider 在真机注册 | D/真机 | **PASS**：`dumpsys appwidget` 列出 `TaskDockWidget2x2/4x2`，`updatePeriodMillis=0`、`resizeMode=3` |
| 快照写入 SharedPreferences | D/真机 | **PASS**：`taskdock_widget.xml` 含 `snapshot_v1`（pendingCount=14、4 行、无令牌字段） |
| 配置页预览/尺寸/内容/外观 | D/真机 | **PASS**：内容切换后快照重建；修复了重进不读回偏好与「待办 0」口径不一致 |
| 添加 2×2 / 4×2 → 显示真实任务数据 | E/真机 | **FAIL（厂商桌面）**：`requestPinAppWidget` 返回 `requested=true`，vivo OriginOS 桌面不弹确认框；长按桌面 → 组件面板也不列标准 AppWidget，无法落桌面 |
| 勾选任务 → 小组件计数与行更新 | E/真机 | 未验证（无实例） |
| 收集箱保存分享 → captures 小组件更新 | E/真机 | 未验证（无实例） |
| 点击小组件 → 进入对应 Tab（冷启动） | D/真机 | 未验证（无实例）；深链 `taskdock://route/inbox` 已单独 PASS |
| 空数据空态 / JSON 损坏不崩 | D/真机 | 未验证（无实例） |
| 系统明暗切换后 system 外观重渲染 | E/真机 | 未验证（无实例） |

真机证据：`tmp/acceptance/mobile-device-debug/`（`dumpsys appwidget`、`taskdock_widget.xml`、
截图 08/23/24/42）。添加流程在 vivo 桌面被厂商实现阻断，文案已改为「若系统未弹确认，
请长按桌面空白处 → 组件 → TaskDock」的手动兜底；其他厂商桌面仍需各自验证。

## 9. 依赖说明

未新增任何 npm 依赖：`AppWidgetManager`/`RemoteViews`/`SharedPreferences` 均为 Android
框架 API，经 Expo Modules API（`expo-modules-core`，已在依赖树内）暴露。expo-widgets 仍为
ALPHA，未采用（符合任务约束）。

## 变更记录

- 2026-11-12 首版：小组件原生接入（module + plugin + widgetSnapshot + WidgetScreen 改造），
  移除「规划中」徽标，配置页预览改用真实快照数据。
- 2026-11-12 添加到主屏幕真实引导：新增 `TaskDockWidget.requestPinWidget(size)`
  （Android 8+ `AppWidgetManager.requestPinAppWidget`，系统弹确认框），
  WidgetScreen 主按钮改为真实请求：支持时系统直接弹添加确认；launcher 不支持
  （`isRequestPinAppWidgetSupported=false`）或原生模块缺失时回退「长按桌面 → 小组件」
  引导文案。4×4 未提供，请求时按最近的 4×2 处理。
- 2026-11-12 真机走查（vivo V2323A / Android 16）：两个 Provider 注册、快照写入、
  配置页真实数据均 PASS；`requestPinAppWidget` 在该桌面返回 `true` 却不弹确认框，
  系统「原子组件」面板也不列标准 AppWidget，**落桌面被厂商桌面实现阻断**。同时修正：
  WidgetScreen 进入时读回 kv 偏好（此前只写不读，会回落默认值并覆盖用户选择）、
  预览标题/计数/行改为同源（消除「待办 0 却列出待办行」）；`DeviceScreen` 的
  「规划中」徽标此前实际未移除，本次改为「已接入」。
