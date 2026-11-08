# TaskDock Mobile（Android 骨架，独立模式）

Task Dock 的手机端。本轮只实现**独立模式**：全部数据落在本机 SQLite，不连接桌面端。
联动模式（配对 / 同步 / 远程）只有表结构与设计，没有实现，见 `docs/MOBILE_STACK.md`。

## 技术栈

- Expo SDK 58.0.23 / React Native 0.88.1 / React 19.3 / New Architecture + Hermes
- TypeScript 6（strict + noUnusedLocals）
- 本地库：expo-sqlite（WAL）
- 通知：expo-notifications（默认精度排期，不申请 `SCHEDULE_EXACT_ALARM`）
- 主题：`useColorScheme` + 本地偏好，三态（跟随系统 / 浅色 / 深色）

框架选型依据与实测数据见 `tmp/acceptance/mobile-stack-selection/report.md`（RN 7.65 vs Flutter 6.80）。

规范文档（正式口径，优先于本 README）：

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 本目录开发红线与提交前自检 |
| [docs/mobile/README.md](../../docs/mobile/README.md) | 规范索引与能力现状矩阵 |
| [docs/mobile/01-architecture.md](../../docs/mobile/01-architecture.md) | 分层、启动序列、提醒子系统 |
| [docs/mobile/02-data-model.md](../../docs/mobile/02-data-model.md) | 表结构、迁移、三态补丁、重复规则契约 |
| [docs/mobile/03-ui-spec.md](../../docs/mobile/03-ui-spec.md) | Token、表面规则、组件约束 |
| [docs/mobile/04-testing.md](../../docs/mobile/04-testing.md) | 验收层级、真机命令、用例矩阵 |
| [docs/mobile/05-build.md](../../docs/mobile/05-build.md) | 构建环境、版本管理、故障表 |

## 目录

```
apps/mobile/
  App.tsx                    启动：开库 → 注册通知动作 → 对账提醒 → 读主题偏好 → 挂载界面
  src/
    domain/                  纯函数层：类型 + 筛选/排序/时间格式化 + 重复规则（零 React、零 SQLite）
    db/                      schema(迁移序列) / 连接 / tasks / taskUpdate / captures / kv / diagnostics
    notifications/           reminders（通道与排期）+ reminderEngine（全局对账）+ actions（通知按钮）
    lib/                     insets / errors / id / sync（协议与客户端骨架，不发真实请求）
    screens/                 任务 / 收集箱 / 设置
    components/              GlassCard / SwipeRow / BottomSheet / SearchField / TaskEditorSheet / ...
    theme/                   Token / 主题上下文 / 动效（含减少动态效果）/ 阴影
```

分层约束（与桌面端一致）：**UI 不直接访问数据库**，所有 SQL 只出现在 `src/db/`；
`src/domain/` 不 import 任何平台模块，将来可整体迁入 `shared/`。

## 数据

`tasks` / `captures` / `outbox` / `reminder_schedule` / `kv` 五张表，字段名与桌面端 SQLite 对齐
（`due_at`、`remind_at`、`recurrence_rule` 等），手机端额外保留 `rev` 作为同步版本号占位。

- 迁移：`MIGRATIONS` 序列 + `PRAGMA user_version`，append-only；v1 库升级到 v2 不丢数据。
- 写操作：业务表 + `outbox` 在**同一事务**内完成；收集箱「转为任务」是建任务 + 删条目单事务。
- 编辑：`updateTask` 采用**三态补丁**——缺键=不改、`null`=清空、有值=写入。这是硬约定：
  少写 `null` 会导致用户清不掉截止时间，误传 `undefined` 会静默清空字段。
- 版本号 `rev`：完成 / 推进期次 / 软删除 / 编辑都 `rev + 1`，outbox 同时记 `base_rev`，
  作为后续同步的冲突判定基础。
- 提前提醒：有截止时间时使用 `advance_minutes`（与桌面端同义），提醒时刻 = 截止 - N 分钟；
  重复任务推进期次时按该字段重算提醒，没有该字段才退回 `due - remind` 偏移。
- 标签：`tags` 存 JSON 数组，编辑器按空格/逗号分隔录入，列表显示前 2 个，搜索覆盖标签。
- 收集箱幂等：`captures.client_id` 唯一索引，重复提交只落一条（与桌面端 `quick_capture_items.client_id` 同思路）。
- 删除是软删除（`deleted_at`），为后续生成同步墓碑留出数据。
- 重复：`recurrence_rule` 存 JSON，字段名与桌面端 `recurrence_rules` 对齐
  （`freq`/`interval`/`by_weekday`/`by_monthday`/`by_setpos`/`anchor`）。独立模式下由
  `src/domain/recurrence.ts` 本地计算下一次发生（本地时区、补偿休眠期错过的期次）。
- 完成重复任务**只推进期次**（due/remind 前移到下一次），任务保持待办，与桌面端
  `toggle_task` 一致；把它标成已完成会让列表越滚越长，也让两端表现不一致。
- 提醒对账：`reminder_schedule` 记录「排过什么」，每次对账还会用系统
  `getAllScheduledNotificationsAsync()` 核对通知是否仍在，避免重启/更新后记录还在、
  闹钟已丢导致提醒静默失效。
- 通知动作：提醒通知带「完成 / 10 分钟后」两个按钮，走与界面相同的数据层路径
  （`toggleTask` / `updateTask`），处理完显式收起通知。动作按钮是排期时写进通知的，
  所以用 `reminder_actions_version` 记录能力版本，变化时整体重排一次。
- 时间统一存 epoch ms（UTC），展示按设备本地时区计算。

已知限制：**应用退到后台后，提醒在本机（vivo Funtouch / Android 16）上未被投递**；
同一安装包在前台时正常。接收器与通知权限均已确认，判断为厂商后台策略，需要把应用加入
「自启动 / 后台高耗电」白名单。详见验收报告 §10.7。

## 视觉与表面

- **卡片一律不用 `elevation`**：Android 会把阴影画在半透明卡片下方并透出来，浅色模式下表现为
  卡片里嵌一块矩形白/灰框（真机实测）。分层只靠实色表面 + hairline 边框 + 顶边高光。
- 表面 Token 全部不透明：浅色 `#FFFFFF`、深色 `#121A28`；`cardDone` 是完成行的淡绿表面。
- 统计用**色块磁贴**（只有非零数值上色），现在四块统一压成一行（360dp 也不换行）；
  分组头用色条 + 数量胶囊 + 折叠箭头，整行可点开合。
- TabBar 是浮动圆角栏；页头显示年月日时分秒。
- 所有 `TextInput` 显式底色并设 `underlineColorAndroid="transparent"`，否则浅色主题下会出现
  直角白块；收集箱的底色放在外层壳上，同时包住「换行可继续写」与「记录」按钮。
- 滑删只保留一个方向（向左滑出右侧删除）。红底透明度跟随位移，闭合时为 0——卡片入场是淡入，
  红底常驻会在切页时闪一下；开启时卡片右侧圆角插值成直角，与红底内侧的直角相接。
  红底外圈圆角必须与卡片一致，否则卡片圆角缺口处会透出红线。

## 开发

```bash
cd apps/mobile
npm install
npx expo prebuild --platform android   # 生成 android/（已 gitignore，不入库）
npx expo run:android                   # 调试构建 + 装机
npm run typecheck                      # tsc --noEmit
```

Release 构建（本机验证用）：

```bash
cd apps/mobile/android && gradle assembleRelease
```

`android/local.properties` 需要指向本机 Android SDK；`reactNativeArchitectures` 默认只出
`arm64-v8a`，出多架构包时改回 `android/gradle.properties`。

Windows 构建已知约束：

- 需要 **JDK 17** 供 Expo 的 Gradle settings 插件做 toolchain，仅有 JDK 22 时会尝试联网下载而失败。
- 仓库路径过长会让 `react-native-safe-area-context` 的 codegen 对象名超出 260 字符，因此本工程
  **不依赖**该库，insets 由 `src/lib/insets.ts` 用纯 JS 计算。若将来要换回，需要先解决长路径
  （缩短工程路径或启用系统长路径支持）。
- 首次构建需要 Maven 镜像（本机用 `-I rn-mirrors.gradle`），否则仓库 TLS 握手失败。


## 图标

与桌面端一致，源文件直接取 `src-tauri/icons/icon.png`（1024×1024，清单+机器人插画）。
`node scripts/gen-icons.mjs` 生成：

- `assets/icon.png`：**逐字节复制**桌面图标，用于传统图标与商店列表
- `assets/adaptive-foreground.png`：插画缩到 78% 居中的透明前景（避开启动器遮罩裁剪）
- `assets/adaptive-background.png`：纯色背景 `#fdfdfd`（从插画底色采样，与前景区无缝衔接）

生成脚本零依赖（自行解码/编码 PNG）。桌面图标换图后，重跑该脚本 + `npx expo prebuild` 即可同步。

## 未实现（明确边界）

- 配对、设备身份、同步协议、冲突合并、墓碑推进：只有设计与表结构，**未实现**。
- 重复规则按自然周/自然日计算，**不支持法定节假日与调休跳过**；UI 不宣称支持。
- 主屏小组件、系统分享接收、后台同步、远程推送：**未实现**。
- iOS：**未验证**（本机无 macOS/Xcode），本轮只做 Android。
