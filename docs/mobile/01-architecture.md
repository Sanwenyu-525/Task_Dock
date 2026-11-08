# 手机端架构（Android 独立模式）

> 适用范围：`apps/mobile` 当前实现。联动/同步相关描述只写「骨架到什么程度」，不当作能力承诺。

## 1. 定位与边界

手机端本轮只做**独立模式**：数据全部落在本机 SQLite，不连接桌面端、不发任何真实网络请求。

不可突破的边界：

1. 桌面端 `http_ingest` 只监听 `127.0.0.1`，**不得**直接当作手机接入点，也不得为此改动监听地址。
2. 手机端不持有桌面端「权威源」的身份。将来跨设备合并以桌面端规则为准，手机端只做本地副本。
3. 工具链、依赖不擅自新增；视觉与数据能力在现有 Expo/RN 依赖内实现。

## 2. 分层与依赖方向

| 目录 | 职责 | 允许依赖 | 禁止 |
|---|---|---|---|
| `src/domain/` | 纯函数：类型、筛选/排序/时间格式化、重复规则、搜索匹配 | 仅标准库 | 任何 `react` / `react-native` / `expo-*` / SQLite |
| `src/db/` | 唯一 SQL 所在层：连接、迁移、各表读写、事务 | `domain`、`lib` | UI 组件、平台通知 API |
| `src/notifications/` | 通道、权限、排期、对账、通知动作 | `db`、`expo-notifications` | 直接渲染 UI |
| `src/lib/` | insets、错误类型、ID、同步协议与客户端骨架 | 标准库 | 业务 SQL |
| `src/theme/` | Token、主题上下文、动效、阴影 | 仅 RN 原语 | `db`、业务状态 |
| `src/components/` | 展示组件 | `theme`、`domain` 类型 | 直接 SQL、直接改库 |
| `src/screens/` | 页面组合与交互编排 | 上述全部（**不写 SQL**） | `expo-sqlite` 直接调用 |

依赖方向单向：`screens → components → theme`，`screens → db/notifications → domain`。
`domain` 不得反向依赖任何层——这是将来整体迁入 `shared/` 的前提。

`App.tsx` 只做启动编排与页面切换，不含业务查询。

## 3. 模块地图

```
App.tsx                 启动编排：通知 handler → 开库 → 动作按钮 → 对账 → 主题 → 挂载
src/
  domain/
    types.ts            Task / Capture / 筛选与补丁入参
    taskQuery.ts        过滤、排序、搜索匹配、日期边界
    recurrence.ts       重复规则解析、下一次发生、描述文案、预设
  db/
    schema.ts           MIGRATIONS（append-only）+ 版本号
    database.ts         单例句柄、迁移事务、版本回退拒绝
    tasks.ts            列表/新建/切换完成/软删除/outbox 计数
    taskUpdate.ts       三态补丁（独立文件，对外仍从 tasks.ts 导出）
    taskRows.ts         行映射、列名、校验（两处共用）
    captures.ts         收集箱：幂等新增、删除、转任务
    reminderSchedule.ts 排期记录表读写
    kv.ts               设置键值
    diagnostics.ts      PRAGMA quick_check 等只读自检
  notifications/
    reminders.ts        通道、权限、category/action、单条排期、取消
    reminderEngine.ts   全局对账、整体重建、64 条上限
    actions.ts          通知按钮响应、去重、收起通知
  lib/
    insets.ts           纯 JS 安全区（不依赖 safe-area-context，见 §7）
    sync/protocol.ts    补丁载荷、冲突分类、响应解析（纯函数）
    sync/client.ts      可注入 fetch 的客户端骨架（未接线）
  screens/
    TasksScreen.tsx     任务列表、筛选、搜索、分组、编辑器入口
    InboxScreen.tsx     收集箱、转任务
    SettingsScreen.tsx  主题、权限、本地数据
    taskGroups.ts       列表分组（纯展示切分）
  components/           见 03-ui-spec.md §4
  theme/                tokens / ThemeProvider / MotionProvider / shadows
```

## 4. 启动序列

`App.tsx` 的启动是**串行且失败可见**的：

1. `installNotificationHandler()` —— 前台展示策略，必须在任何通知到达前注册。
2. `openDatabase()` —— 打开 → `PRAGMA journal_mode=WAL` / `foreign_keys=ON` → 迁移。
3. 迁移失败不降级、不吞异常：进入错误页，写明原因，提示重启与检查存储。
4. 通知对账（异步、失败不阻塞启动）：
   `ensureReminderCategory()` → 读 `kv.reminder_actions_version` →
   版本一致走 `rescheduleAllReminders()`，不一致走 `rebuildAllReminders()` 并写回版本。
5. 读 `kv.theme_mode` → 挂载 `ThemeProvider` / `MotionProvider` / `Shell`。

为什么对账放在开库之后、主题之前：提醒是增强能力，不能因为通知权限或系统 API 失败让应用打不开；
但它依赖数据库，所以不能早于第 2 步。

数据库版本高于当前应用（用户装回旧版）时**拒绝打开**并报错，不允许继续按旧 schema 写新库。

## 5. 状态刷新模型

没有全局 store，也没有订阅式缓存。刷新靠一个自增的 `version` 计数：

| 触发 | 行为 |
|---|---|
| `AppState` 变为 `active` | `version + 1`，列表重查（后台期间通知动作可能已改库） |
| 处理完通知动作 | `subscribeReminderActions` 回调里 `version + 1` |
| 收集箱转任务 | `onPromoted` → `version + 1`（不强制切页，用户通常连续整理） |
| 切换 Tab | 目标页重新挂载并自行查询 |

约定：页面只通过 `listTasks()` / `listCaptures()` 这类函数读库，写完主动通知上层 +1，
不做跨页缓存同步。

## 6. 提醒子系统

### 6.1 排期

- 数据来源：`tasks.remind_at` 在未来的未完成、未删除任务，按 `remind_at` 升序取前
  `MAX_SCHEDULED_REMINDERS = 64` 条。
- 通知 identifier 只由任务派生：`remind-<taskId>`。因此**同一任务同一时刻只有一条通知**，
  改提醒时间必须走「更新记录 + 重排」，不能只新增。
- 触发时间用 `SchedulableTriggerInputTypes.DATE`（默认精度，不申请精确闹钟权限）。

### 6.2 对账（`rescheduleAllReminders`）

单飞：并发调用复用同一轮 Promise（`inFlight`），避免前台恢复时重复调用系统通知 API。

一轮对账做三件事：

1. 清理不再需要的记录：任务已删除/已完成/提醒已改时刻 → 删 `reminder_schedule` 行；
   只有当任务**整体**不在本次排期集合内时才 `cancelReminder`（否则会把随后要用的同名新通知取消）。
2. 与系统实际状态核对：`getAllScheduledNotificationsAsync()` 里找不到 `remind-<taskId>`
   的，即使本地有记录也重排一次。典型场景：应用更新、系统清理、换机恢复。
3. 排新条目：写 `reminder_schedule(task_id, occurrence_at, notification_id, scheduled_at)`。

返回值 `{ scheduled, skipped }`：`skipped` 包含「已在排期」「超出 64 条上限」「系统未授权」
「时间已过去」四类，**不是错误计数**，不要当作失败上报。

读取系统通知失败时退回「只信本地记录」（`systemIds = null`），避免对账本身把提醒全清掉。

### 6.3 通知动作

提醒通知带 category `task-reminder-actions`，两个动作：`complete` / `snooze`。

```
点击动作 → handleNotificationResponse
  ├─ 去重：identifier|actionIdentifier|date 已处理过则直接返回
  ├─ complete：toggleTask(id)
  │    ├─ advanced（重复任务推进）→ rescheduleAllReminders()
  │    └─ 否则 cancelReminder(id)
  ├─ snooze：updateTask(id, { remindAt: now + 10min }) → rescheduleAllReminders()
  └─ finally：dismissNotificationAsync(id) 显式收起通知
```

- 动作走的路径与界面完全一致（`toggleTask` / `updateTask`），不另写 SQL。
- 从冷启动进入：`getLastNotificationResponse()` 只在 10 分钟窗口内处理，防止旧响应反复触发。
- 通知被点击后必须主动收起：真机实测过不收起会一直留在通知栏（见验收报告 §10）。

### 6.4 动作能力版本

动作按钮是**排期时**写进通知的，老通知不会自动长出按钮。`kv.reminder_actions_version`
记录能力版本；与代码常量不一致时启动走一次 `rebuildAllReminders()`（取消全部 + 清空记录 +
重排），一致时只做幂等对账。这样升级只付一次全量重排的代价。

## 7. 主题、动效与安全区

- 主题三态（跟随系统 / 浅色 / 深色），偏好存 `kv.theme_mode`；`ThemeProvider` 只暴露
  `tokens` / `scheme` / `mode` / `setMode`，组件不自行判断明暗。
- 动效由 `MotionProvider` 统一处理 `AccessibilityInfo.isReduceMotionEnabled`：
  开启「减少动态效果」时位移/弹簧动画退化为直接呈现。
- 安全区用 `src/lib/insets.ts` 纯 JS 计算，**不引入** `react-native-safe-area-context`：
  仓库路径过长会让该库 codegen 的对象名超过 260 字符而构建失败（见 05-build.md §6）。
  改动这里要同时验证顶部刘海、底部手势条与键盘弹起三种情况。

## 8. 同步骨架（未接入）

- `src/lib/sync/protocol.ts` 是纯函数：`buildPatchPayload`（丢弃 `undefined`、保留 `null`）、
  `classifyConflict`、`parsePullResult` / `parsePushResult`。可单测，不触网。
- `src/lib/sync/client.ts` 接受注入的 `FetchLike`，具备超时与重试参数，但**没有调用方**。
- 独立模式下 `outbox` 只累积不消费；界面上「待同步」是 outbox 行数，不代表正在同步。

接同步时必须先满足：设备配对与令牌存储、`base_rev` 冲突判定、墓碑推进、可取消且有上限的重试；
在此之前不得把 `client.ts` 接到界面按钮上。

## 9. 生命周期与资源

- 全局只有一个数据库句柄，`closeDatabase()` 仅测试/退出用。
- 所有监听在 `useEffect` 清理函数里 `remove()`；通知响应订阅返回取消函数。
- 排期与对账单飞、有上限（64 条）、失败可重试且不写半成品记录。
- 不做常驻轮询、不注册后台任务、不留永不停止的定时器。

## 10. 明确未实现

配对、同步消费、`notes`、墓碑、后台同步、远程推送、主屏小组件、iOS。详见
[README.md](README.md) 的状态表。

## 变更记录

- 2026-11-08 首版：按当前代码（schema v2 / 0.1.1）整理，明确「设计稿 ≠ 现状」。
