# AGENTS.md — apps/mobile

本文件约束 `apps/mobile` 内的开发。与根 `AGENTS.md` 同时生效；本目录规则更具体时以本文件为准，
本文件没写的仍按根规范（Git 安全、验收纪律、构建产物管理）执行。

## 1. 定位

> 更正（2026-11-12）：本节此前写「只做 Android 独立模式：不连接桌面端、不发真实网络请求」，
> 与代码不符——2026-11-08 起有局域网配对，2026-11-09 起有手动同步与文件互传，
> 2026-11-12 起传输为 TLS-only（协议 v2）。以下为当前边界；历史描述见 git 历史。

- 业务数据全部在本机 SQLite；网络只限**用户显式发起**的局域网配对、连接测试、
  手动同步与文件互传（协议 v2，TLS-only + SPKI 指纹固定，见 `docs/mobile/06-pairing.md`）。
  不得新增后台轮询/自动同步（A3 设计另行归属）。
- 所有请求必须走 `src/lib/sync/secureFetch.ts`（本地原生模块 `modules/secure-http/`，
  仅接受 `https://`）；不得引入绕过指纹固定的网络路径，不得恢复明文放行插件。
  已配对连接缺少已钉住的 SPKI 指纹时必须 **fail-closed**（提示重新配对），
  不得退回「首用信任」继续发送设备令牌。
- 本地 Expo 模块共三个，均由 autolinking 链接、由 `plugins/` 里的 config plugin 写清单：
  `secure-http`（TLS + 指纹固定）、`share-intent`（ACTION_SEND 接收）、
  `taskdock-widget`（AppWidgetProvider 2×2 / 4×2）。改原生代码后必须重跑
  `npx expo prebuild --platform android` 并做 Gradle 编译验证；`android/` 仍不入库。
- 小组件与分享接收**只允许事件驱动**：小组件 `updatePeriodMillis=0`，不得引入后台轮询、
  常驻服务或定时刷新；快照只写标题/勾选态/计数/时间戳，绝不写令牌、密钥或同步元数据。
- 桌面端 `http_ingest` 只监听 `127.0.0.1`，不得改成局域网/公网监听，也不得把它当作手机接入点。
- 不新增依赖（新增必须单独说明理由、体积影响与回退路径并取得同意）。

## 2. 分层红线

| 层 | 规则 |
|---|---|
| `src/domain/` | 纯函数，**不得** import `react` / `react-native` / `expo-*` / `db` |
| `src/db/` | 唯一允许出现 SQL 的目录；`screens`/`components` 不得直接调 `expo-sqlite` |
| `src/notifications/` | 管通道与排期；不得直接渲染 UI、不得绕过 `db` 写库 |
| `src/components/` | 展示组件；不得直接查库或写库 |
| `src/screens/` | 编排与交互；只调 `db` 暴露的函数 |

`src/theme/` 不依赖业务层；组件不自行读 `useColorScheme`，统一用 `useTheme()`。

## 3. 数据层硬规则

1. **迁移 append-only**：只往 `MIGRATIONS` 末尾追加，不改已发布 SQL、不重排；版本号与 DDL 同事务。
2. **三态补丁**：`undefined` = 不改，`null` = 清空，有值 = 写入。禁止用 `?? null` 抹平两种状态。
3. **写操作同事务**：业务表 + `outbox` 必须同一事务；`tasks` 的每次写都要 `rev = rev + 1`。
4. **重复任务完成只推进期次**，不标成已完成（与桌面端 `toggle_task` 一致）；提醒偏移优先
   `advance_minutes`，没有才退回 `due - remind`，原本没提醒就保持没有。
5. **时区**：存 epoch ms（UTC），按设备本地时区展示与计算；不得按墙钟重算已排定的绝对时刻。
6. **提醒对账**：改排期必须同时维护 `reminder_schedule` 与系统通知；对账要用
   `getAllScheduledNotificationsAsync()` 核对，不能只信本地记录。
7. 通知动作只走 `toggleTask` / `updateTask`，不在 `actions.ts` 里另写 SQL。

## 4. 视觉硬规则（详见 `docs/mobile/03-ui-spec.md`）

- 卡片**不用** `elevation`，表面必须不透明——半透明 + elevation 会在浅色模式下透出矩形白框。
- 所有 `TextInput` 显式底色 + `underlineColorAndroid="transparent"`。
- 滑删红底外圈圆角与卡片一致，并比卡片内缩 1dp。
- 只用 `tokens.*`，不写字面量颜色；可点区域 ≥44dp。
- 改视觉不改业务语义（分组、完成态、重复文案、提醒模式）。

## 5. 构建与版本

- `android/` 是 `expo prebuild` 生成物且被 gitignore：**不要手改**，也不要提交。
- 版本号唯一事实源是 `app.json`（`version` + `android.versionCode`）；
  `SettingsScreen` 的「关于」文案随版本同步。`versionCode` 单调递增（同版本重装会被安装器拒绝）。
- 构建命令与故障处理见 `docs/mobile/05-build.md`。

## 6. 改完必须做

1. `cd apps/mobile && npx tsc --noEmit` → exit 0；`npm test`（vitest）→ 全过。
   纯函数/数据层/协议改动必须补 vitest 用例（node:sqlite harness 跑真实 SQL，
   不为测试重写业务逻辑）。
2. 纯函数改动：执行与受影响功能直接相关的专项测试并补回归用例（重复任务规则、任务查询/搜索、
   同步协议、导航纯函数、数据模型各按对应测试入口），报告实际 PASS/FAIL 数，不许只说「通过」。
   `tmp/acceptance/mobile-app-skeleton/logic/check.cjs` 是 2026-11-08 的历史专项脚本（`tmp/`
   不入库，新环境默认不存在），只覆盖
   重复规则/搜索匹配/笔记文本，且需先把 `src/domain/*.ts` 编译到 `tmp/.../logic/js` 并补
   `{"type":"commonjs"}`（见 `docs/mobile/04-testing.md`）；仅在改动落入其覆盖范围且产物可用时
   执行，产物不可用则如实写「未执行」并改用对应测试入口，不得当作全移动端统一测试框架。
3. 涉及数据/通知/UI：真机走一遍受影响用例；模拟器或「看起来没问题」不算证据。
4. 任务级报告写 `tmp/acceptance/<task-name>/report.md`（当前任务专属目录，短横线英文）；
   历史报告保持原样，不改写。分节：范围/根因/修改/命令与退出码/已验证/未验证/证据路径/结论。
5. 交付前列 `git status`，只含本次预期改动；不自动 commit / push。

## 7. Skill 路由（移动端）

- 新增页面或重做界面：`frontend-design` + `ui-ux-pro-max`（只取适用于 Flat/touch-first 的原则，
  其 landing 模板与配色不适用于本产品）。
- 视觉精修/字号层级：`impeccable`（窄幅精修，先跑 `scripts/impeccable context`）+ 适用的
  `design-taste-frontend`。
- 动效与减少动态：`animate` / `emil-design-eng`；性能问题用 `animation-performance`。
- Expo/RN 具体能力：`expo-native-ui`、`expo-design-system`、`expo-project-structure` 等
  `expo-*` Skill；只读当前栈适用的条目。
- **项目规范优先**：`docs/mobile/` 与根 `AGENTS.md` 的约束高于 Skill 建议；Skill 不得另造设计语言。

## 8. 禁止

- 伪造真机验证、截图、耗时或测试数字；未执行就写「未执行」，环境阻塞写 `ENVIRONMENT BLOCKED`。
- 把设计稿（`docs/MOBILE_STACK.md`）里的未实现能力写成现状。
- 在 `apps/mobile` 内执行桌面端构建（Vite/Tauri/cargo），或修改 `src-tauri/`。
- 清理他人的 `tmp/` 目录、构建缓存或验收证据；新证据用独立文件名。
