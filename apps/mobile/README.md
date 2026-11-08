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

## 目录

```
apps/mobile/
  App.tsx                    启动：开库 → 读主题偏好 → 挂载界面
  src/
    domain/                  纯函数层：类型 + 筛选/排序/时间格式化（零 React、零 SQLite）
    db/                      schema / 连接 / tasks / captures / kv，SQL 只在这一层
    notifications/           本地通知排期与权限
    screens/                 任务 / 收集箱 / 设置
    components/              列表行、统计卡、筛选片、新建弹层、底部 Tab
    theme/                   设计 Token 与主题上下文
```

分层约束（与桌面端一致）：**UI 不直接访问数据库**，所有 SQL 只出现在 `src/db/`；
`src/domain/` 不 import 任何平台模块，将来可整体迁入 `shared/`。

## 数据

`tasks` / `captures` / `outbox` / `kv` 四张表，字段名与桌面端 SQLite 对齐（`due_at`、
`remind_at`、`recurrence_rule` 等），手机端额外保留 `rev` 作为同步版本号占位。

- 写操作：业务表 + `outbox` 在**同一事务**内完成；收集箱「转为任务」是建任务 + 删条目单事务。
- 收集箱幂等：`captures.client_id` 唯一索引，重复提交只落一条（与桌面端 `quick_capture_items.client_id` 同思路）。
- 删除是软删除（`deleted_at`），为后续生成同步墓碑留出数据。
- 时间统一存 epoch ms（UTC），展示按设备本地时区计算。

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
- 重复任务的下一次时间计算：只存规则，不计算（由桌面端权威计算）。
- 主屏小组件、系统分享接收、后台同步、远程推送：**未实现**。
- iOS：**未验证**（本机无 macOS/Xcode）。
