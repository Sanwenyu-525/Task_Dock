# 手机端架构（Android 独立模式 + 局域网配对）

> 适用范围：`apps/mobile` 当前实现。配对与连通性探测自 2026-11-08 接入；
> 任务、收集箱与笔记同步（pull/push）自 2026-11-09 接入（见 [07-sync.md](07-sync.md)）。
> 后台同步、字段级合并与日志清理仍未实现，相关描述不当作能力承诺。

## 1. 定位与边界

手机端业务数据全落在本机 SQLite；网络能力只包括**用户显式发起的局域网配对、心跳与同步**：

- 桌面端保持默认关闭，只有用户开启「允许手机连接」后才监听局域网端口；
- 手机端只在用户点「配对 / 测试连接 / 立即同步」时发请求，不做后台轮询、不自动同步；
- 配对本身不传输业务数据；同步是独立动作，配对成功也不代表已同步。

不可突破的边界：

1. 桌面端 `http_ingest` 只监听 `127.0.0.1`，**不得**直接当作手机接入点，也不得为此改动监听地址；
   手机接入是独立的 `mobile_sync` 监听与端点。
2. 手机端不持有桌面端「权威源」的身份。将来跨设备合并以桌面端规则为准，手机端只做本地副本。
3. 工具链、依赖不擅自新增；2026-11-12 起新增本地 Expo 原生模块
   `modules/secure-http/`（Kotlin HttpsURLConnection + SPKI 指纹固定），作为同步/
   配对/文件互传的唯一安全传输通道；`withCleartextTraffic` 明文放行插件已移除，
   Android 9+ 默认禁明文 = fail-closed。
4. 令牌只允许进 SecureStore；配对码、令牌、证书与私钥不得写日志或 kv 明文
   （TLS SPKI 指纹为公开值，允许进日志与状态接口）。

传输为 **TLS-only（协议 v2）**：二维码携带 SPKI SHA-256 指纹，手机端从首个字节起
固定桌面端身份；威胁模型与实现细节见 [06-pairing.md](06-pairing.md) §5.1
（2026-11-08～11 的明文 HTTP 偏差已消除，历史记录保留在该篇变更记录）。

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
    notes.ts            笔记 CRUD（三态补丁、outbox）
    sync.ts             pull 应用、outbox 合并、push 结算与冲突存储
    reminderSchedule.ts 排期记录表读写
    kv.ts               设置键值（含连接元数据 `sync.connection.v1`）
    syncConnection.ts   令牌 → SecureStore；连接元数据 → kv；解除配对
    diagnostics.ts      PRAGMA quick_check 等只读自检
  notifications/
    reminders.ts        通道、权限、category/action、单条排期、取消
    reminderEngine.ts   全局对账、整体重建、64 条上限
    actions.ts          通知按钮响应、去重、收起通知
  lib/
    insets.ts           纯 JS 安全区（不依赖 safe-area-context，见 §7）
    sync/protocol.ts    补丁载荷、冲突分类、响应解析（纯函数）
    sync/client.ts      同步客户端（超时/退避/加密信封）
    sync/crypto.ts      KDF 与 XSalsa20-Poly1305 信封
    sync/engine.ts      pull → push → 再 pull 的单飞编排
    sync/pairing.ts     二维码 URI（v2，含 TLS 指纹）解析、地址归一化、配对码清洗（纯函数）
    sync/pairClient.ts  `/v1/pair` 与 `/v1/ping` 客户端（超时、稳定错误码）
    sync/secureFetch.ts 安全通道 FetchLike 包装（SPKI 指纹固定；原生实现可注入）
    sync/pendingPairing.ts 深链配对载荷的内存队列 + 订阅
  screens/
    TasksScreen.tsx     任务列表、筛选、搜索、分组、编辑器入口
    InboxScreen.tsx     收集箱、转任务
    SettingsScreen.tsx  主题、权限、本地数据、配对入口
    PairingScreen.tsx   应用内扫码/手动输码 → 确认 → 配对 → 保存令牌
    SyncScreen.tsx      已配对连接、连通性测试、立即同步、解除本机配对
    ConflictScreen.tsx  同步冲突逐条处理（采用桌面端 / 保留本机）
    taskGroups.ts       列表分组（纯展示切分）
  components/           见 03-ui-spec.md §4
  theme/                tokens / ThemeProvider / MotionProvider / shadows
modules/secure-http/        本地 Expo 原生模块：HTTPS + SPKI 指纹固定（Android Kotlin）
```

## 4. 启动序列

`App.tsx` 的启动是**串行且失败可见**的：

0. 原生启动图（`expo-splash-screen`）：模块加载时 `preventAutoHideAsync()` 保持原生图；
   原生图与 JS 启动层使用同一张「清单骨架」，见 `03-ui-spec.md` §7.1。
1. `installNotificationHandler()` —— 前台展示策略，必须在任何通知到达前注册。
2. `openDatabase()` —— 打开 → `PRAGMA journal_mode=WAL` / `foreign_keys=ON` → 迁移。
3. 迁移失败不降级、不吞异常：进入错误页，写明原因，提示重启与检查存储；渲染错误页前
   必须 `SplashScreen.hide()`，否则原生图会一直盖住错误信息。
4. 通知对账（异步、失败不阻塞启动）：
   `ensureReminderCategory()` → 读 `kv.reminder_actions_version` →
   版本一致走 `rescheduleAllReminders()`，不一致走 `rebuildAllReminders()` 并写回版本。
5. 读 `kv.theme_mode` → 挂载 `ThemeProvider` / `MotionProvider` / `Shell`。
6. 启动层退场：`Shell` 先在启动层下方挂载（不露脸），动画播完且距 JS 首帧 ≥640ms 后，
   启动层下沉淡出 180ms 再卸载；减少动态效果时跳过动画，就绪即卸载。
   `MotionProvider` 因此提到启动层外层，冷启动与主界面共用同一条「减少动态」偏好。

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

### 5.1 推送页栈（2026-11-08 起）

不引导航库。`Shell` 持有 `Route[]`（`src/lib/nav.ts` 定义 `RouteKey`/`Route`/`Nav` 契约）：
`push` 入栈、`back` 弹栈；栈非空时全屏渲染栈顶页并隐藏 TabBar，硬件返回 = 弹栈
（`BackHandler` 按「后注册先调用」工作，编辑页利用这一点先保存再关，避免绕过保存）。
推送页没有页面缓存：返回后由 `version + 1` 驱动列表重查。

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

提醒通知带两个 category：`task-reminder-actions`（完成 + 10 分钟后）与
`task-reminder-basic`（仅完成）。排期时按 `kv.reminder_snooze_enabled`（缺省开）
选择类别；开关只影响**之后排期**的通知，已排下通知的按钮不会变。

```
点击动作 → handleNotificationResponse
  ├─ 去重：identifier|actionIdentifier|date 已处理过则直接返回
  ├─ complete：toggleTask(id)
  │    ├─ advanced（重复任务推进）→ rescheduleAllReminders()
  │    └─ 否则 cancelReminder(id)
  ├─ snooze：updateTask(id, { remindAt: now + 10min }) → rescheduleAllReminders()
  └─ finally：kv.reminder_dismiss_on_complete ≠ "0" 时 dismissNotificationAsync(id)
```

- 动作走的路径与界面完全一致（`toggleTask` / `updateTask`），不另写 SQL。
- 从冷启动进入：`getLastNotificationResponse()` 只在 10 分钟窗口内处理，防止旧响应反复触发。
- 通知被点击后必须主动收起：真机实测过不收起会一直留在通知栏（见验收报告 §10）。
  「通知与后台」页可关闭收起行为（关闭后完成的任务通知留在通知栏，便于回看）。

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

## 8. 同步（v1 任务已接入）

- `src/lib/sync/protocol.ts` 是纯函数：`buildPatchPayload`（丢弃 `undefined`、保留 `null`）、
  `classifyConflict`、`parsePullResult` / `parsePushResult`。可单测，不触网。
- `src/lib/sync/client.ts` 接受注入的 `FetchLike`，具备 5s 超时与 1/2/4/8/16/32s 退避；
  传入 `syncKey` 时请求/响应走 `{v,n,d}` 加密信封（[07-sync.md](07-sync.md) §2）。
- `src/lib/sync/engine.ts` 是唯一调用方：拉取 → 按记录合并 outbox 推送 → 再拉取回填
  `server_rev`；单飞，不并发；只在用户点「立即同步」时触发。
- `src/db/sync.ts` 负责落库：pull 跳过本地未发送记录；push ack 清理本批 outbox；
  冲突写入 `sync_conflicts`，由冲突页选择「采用桌面端 / 保留本机」。
- 独立模式下 `outbox` 只累积不消费；接入同步后消费 `task` / `note` / `capture` 三种实体。
- 已满足接入前提：设备配对与令牌存储、`base_rev` 冲突判定、墓碑推进、可取消且有上限的重试。

### 8.1 配对与连接（2026-11-08 已实现）

- **屏幕**：`PairingScreen` 状态机 `scan → confirm → pairing → success`；`SyncScreen` 展示
  已配对连接、连通性测试、立即同步与解除本机配对。配对页不读写业务表；同步页通过
  `sync/engine.ts` 读写任务表与 outbox（不属于配对职责）。
- **纯函数**：`sync/pairing.ts` 严格解析 `taskdock://pair?v=1...`（host/port/code/v 校验），
  归一化手动地址（不接受 https/路径），清洗 6 位码；`sync/pairClient.ts` 带 5s/8s 超时与
  稳定错误码（`invalid_code` / `pairing_closed` / `too_many_attempts` / `unauthorized`）。
- **凭据**：令牌只进 `expo-secure-store`（键 `taskdock.sync.token.v1`）；连接元数据进
  `kv['sync.connection.v1']`。`clearConnection()` 同时删两处，失败可见。
- **深链**：系统相机扫描 `taskdock://pair?...` 经 `Linking` 唤起；载荷先进
  `sync/pendingPairing.ts` 的内存队列，配对页挂载时取走或在运行中订阅更新，不写日志。
- **网络时机**：只在用户点「配对 / 测试连接」时请求；无后台轮询、无自动重试。
- **明文 HTTP**：`plugins/withCleartextTraffic.js` 在 prebuild 时设置
  `android:usesCleartextTraffic=true`（本轮已确认的 v1 基线），威胁模型见
  [06-pairing.md](06-pairing.md) §5。

## 9. 生命周期与资源

- 全局只有一个数据库句柄，`closeDatabase()` 仅测试/退出用。
- 所有监听在 `useEffect` 清理函数里 `remove()`；通知响应订阅返回取消函数。
- 排期与对账单飞、有上限（64 条）、失败可重试且不写半成品记录。
- 不做常驻轮询、不注册后台任务、不留永不停止的定时器。

## 10. 明确未实现

字段级自动合并、后台同步、远程推送、主屏小组件（AppWidgetProvider）、
系统分享接收（intent-filter）、iOS。任务、收集箱、笔记同步已于 2026-11-09 实现；
配对/同步/冲突/小组件/分享的**页面结构**自 2026-11-08 起保持「真实状态 + 规划徽标」，
不给假数据。详见 [README.md](README.md) 的状态表与 [06-pairing.md](06-pairing.md)、
[07-sync.md](07-sync.md)。

## 变更记录

- 2026-11-08 首版：按当前代码（schema v2 / 0.1.1）整理，明确「设计稿 ≠ 现状」。
- 2026-11-08 原型落轮：新增 §5.1 推送页栈；§6.3 更新为双通知类别与「完成后收起」开关；
  §10 更新为「页面结构已就绪、能力未接入」。
- 2026-11-08 配对落轮：§1 边界由「完全离线」改为「用户显式发起的局域网配对」；§3 模块地图
  补齐 sync/pairing、pairClient、pendingPairing、syncConnection 与 prebuild 插件；
  新增 §8.1；§10 区分「已配对」与「已同步」。

## 变更记录

- 2026-11-12 传输硬切 TLS（协议 v2）：新增本地原生模块 `modules/secure-http/` 与
  `src/lib/sync/secureFetch.ts`；移除 `withCleartextTraffic` 明文放行插件；
  传输安全边界从「局域网明文 HTTP（明确偏差）」改为「TLS-only + SPKI 指纹固定」，
  详见 [06-pairing.md](06-pairing.md) §5.1。
