# 手机端构建与环境（Windows → Android）

> 只在 Windows 上验证过。命令均在 `apps/mobile` 或其 `android/` 下执行。
> `android/` 由 `expo prebuild` 生成且被 `.gitignore` 忽略——**不是**可手改的源文件。

## 1. 工具链

| 组件 | 版本/位置 | 说明 |
|---|---|---|
| Node / npm | 仓库现有版本 | 依赖已锁定在 `package-lock.json` |
| JDK | **17** | Expo 的 Gradle settings 插件用它做 toolchain；只有 JDK 22 时会尝试联网下载而失败 |
| Android SDK | `android/local.properties` 指向 | 需要 platform-tools 与对应 compileSdk |
| Gradle | 9.4.1（本机 `D:/Develop/mobile-stack-tools/gradle-9.4.1`） | 也可用 prebuild 生成的 wrapper |
| Expo SDK | 58.0.23 | RN 0.88.1 / React 19.3 / New Architecture / Hermes |
| 目标 ABI | 默认只出 `arm64-v8a` | 见 `android/gradle.properties` 的 `reactNativeArchitectures` |

## 2. 首次初始化

```bash
cd apps/mobile
npm install
npx expo prebuild --platform android    # 生成 android/（不入库）
```

`android/local.properties` 需要 `sdk.dir=...` 指向本机 SDK。prebuild 会**清空 `android/`**，
`local.properties` 随之丢失，必须重建，并且该 SDK 里要有 NDK 27.1（见 §6 第一行）。
prebuild 会按 `app.json` 重新生成 `versionName` / `versionCode` / 包名（`dev.taskdock.mobile`），
不要手改生成物。

## 3. 日常命令

```bash
cd apps/mobile
npx tsc --noEmit                       # 类型检查（提交前必须 exit 0）
npm run icons:generate                 # iconMap.json → iconAssets.g.ts（构建期位图）
npm run icons:check                    # 只校验生成物是否最新，不写文件
npm run android                        # 调试构建 + 装机（expo run:android）
```

图标生成器是 `scripts/gen-ui-icons.mjs`：路径全部相对脚本位置，不依赖盘符/用户名；
几何读取仓库已有的 `lucide-react`（根或 `apps/mobile` 的 `node_modules`），栅格化使用仓库已有的
Playwright + Chromium。环境准备只需 `npx playwright install chromium`，**不新增 npm 依赖**。
`iconMap.json` 的 `overrides` 用于少量业务图标的同语言微调；生成物首行的 `ICON_MAP_HASH`
由契约测试校验，改映射后必须重跑生成器。

Release 构建（验收用）：

```bash
cd apps/mobile/android
"D:/Develop/mobile-stack-tools/gradle-9.4.1/bin/gradle.bat" assembleRelease \
  -g D:/Develop/mobile-stack-tools/gradle-home \
  -I D:/Develop/mobile-stack-tools/rn-mirrors.gradle
```

`-g` 指共享 Gradle Home（复用缓存），`-I` 是 Maven 镜像初始化脚本——本机不加镜像会在
仓库 TLS 握手阶段失败。没有这套工具链时用 wrapper：

```bash
cd apps/mobile/android && ./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`。

装机与校验：

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
sha256sum android/app/build/outputs/apk/release/app-release.apk
adb shell pm path dev.taskdock.mobile        # 取设备上的路径
adb pull <设备路径> tmp/.../pulled.apk && sha256sum tmp/.../pulled.apk   # 两值必须一致
```

## 4. 版本管理

| 位置 | 字段 | 角色 |
|---|---|---|
| `app.json` | `expo.version` | **唯一事实源**（当前 `0.1.7`） |
| `app.json` | `expo.android.versionCode` | **唯一事实源**（当前 `24`） |
| `android/app/build.gradle` | `versionName` / `versionCode` | 生成物，prebuild 写入；不要当作源 |
| `src/screens/SettingsScreen.tsx` | 「关于 → 版本」 | 直接读 `app.json`，无需手改 |

规则：

- `versionCode` **单调递增**，永不回退。vivo 安装器会拒绝「已安装相同版本」的重装，
  报 `INSTALL_FAILED_ABORTED`，弹窗写「已安装相同版本」——这不是签名或权限问题，
  提升 `versionCode` 后重装即可（0.1.0/1 → 0.1.1/2 → 0.1.2/5 已实测通过）。
  同一版本名下来回调试时，可以只加 `versionCode`、不改 `version`。
- 改版本只改 `app.json`；如果直接手改了 `android/` 里的值，下次 prebuild 会被覆盖，
  不要依赖手改。本轮为不改 prebuild 目录，同时改了 `app.json` 与
  `android/app/build.gradle`（0.1.6 / 12），后续 prebuild 会以 `app.json` 为准。
- 正式发布前确认 `android/` 是重新 prebuild 出来的，而不是带旧补丁的残留目录。

## 5. 产物与磁盘

- `android/`、`ios/`、`node_modules/`、`*.apk` 不入库；构建缓存在 Gradle Home 与
  `android/.gradle`、`android/app/build`。
- 临时构建缓存按根 `AGENTS.md` §5 登记与回收；本任务只产出 APK 与日志，结束后不清理
  其他会话的缓存目录。
- 交付时记录：APK 相对路径、sha256、构建时间、构建命令与退出码。

## 6. 故障排查

| 现象 | 根因 | 处理 |
|---|---|---|
| prebuild 后构建报 `LicenceNotAcceptedException: ndk;27.1.12297006` | `expo prebuild` 会**清空整个 `android/`**（含 `local.properties`），Gradle 回退到 `ANDROID_HOME` 指向的 SDK，而那里没装 NDK 27.1 | 重建 `android/local.properties`，`sdk.dir` 指向装有 NDK 27.1 的 SDK（本机 `%LOCALAPPDATA%\\Android\\Sdk`） |
| Gradle 在下载依赖时 TLS 失败/超时 | 直连 Maven 不可用 | 加 `-I rn-mirrors.gradle`，用共享 `-g` Home |
| `settings.gradle` 阶段要求下载 JDK | 只有 JDK 22，toolchain 不匹配 | 装 JDK 17 并让 Gradle 用它 |
| `react-native-safe-area-context` codegen 报标识符过长 | Windows 260 字符路径上限 | 本工程**不依赖**该库，insets 用 `src/lib/insets.ts` 纯 JS；若将来要换回，先缩短工程路径 |
| `Unable to delete .../app-release.apk` / `Device or resource busy` | 残留 `adb install` 进程占着文件 | 只结束那个 adb 进程，不要 `adb kill-server` 影响其他会话；再清目录重编 |
| 安装被拒，弹窗「已安装相同版本」 | 同 `versionCode` 重装 | 提升 `versionCode` 重编重装 |
| 通知栏小图标是系统默认图标/实心白块 | `app.json` 的 expo-notifications 插件没配 `icon`，回退到启动器图标（彩色图只取 alpha 会糊成一块）；或改了配置但没重跑 prebuild | 见 §7「通知图标」，配置后必须 prebuild + 重编装机 |
| 装机后通知栏仍显示旧图标/系统默认图标 | 系统（SystemUI/启动器）按包缓存了更新前的图标，重装 APK 不保证立即刷新 | 重启设备后再发一条通知确认；确认前不要判定为配置未生效（`dumpsys notification` 里 `icon=Icon(typ=RESOURCE pkg=dev.taskdock.mobile …)` 已指向新资源即配置正确） |
| `adb devices` 出现两条同机条目 | USB + 无线调试同时连接 | 所有命令加 `-s <serial>` 指定 |
| Git Bash 把 `/data/local/tmp` 变成 Windows 路径 | MSYS 路径转换 | `export MSYS_NO_PATHCONV=1` |
| `npm run typecheck` 在仓库根报 TS5112 | 根有 `tsconfig.json`，不能用显式文件列表 | 在 `apps/mobile` 下跑，或显式加 `--ignoreConfig` |

## 7. 与桌面端构建的关系

两端构建完全独立：手机端不触发 Vite / Tauri / Rust 构建，桌面端改动也不会自动进入 APK。
唯一共享物是图标源 `src-tauri/icons/icon.png`（`node scripts/gen-icons.mjs` 生成 assets），
换图标后需要重跑脚本 + `npx expo prebuild`。

通知图标是另一套资源，不能直接复用彩色 `assets/icon.png`：

| 资源 | 用途 | 约束 |
|---|---|---|
| `assets/notification-icon.png` | 状态栏小图标 | **纯白 + 透明**单色；Android 只取 alpha 通道并统一染色，彩色图会被压成实心块。由 `node scripts/gen-notification-icon.mjs` 生成（24dp 基准、8× 输出、零依赖，几何与启动页 mark 同构） |
| `assets/icon.png` | 通知展开后右侧大图标 | 彩色启动器图标，经插件缩到 64dp 基准 |

两者在 `app.json` 的 expo-notifications 插件里声明（`icon` / `largeIcon`）；插件会写
`android/app/src/main/res/drawable-*/notification_icon.png`、`notification_large_icon.png`
（含 mdpi…xxxhdpi 五档）与 manifest 的 `expo.modules.notifications.default_notification_icon`、
`large_notification_icon` meta-data。改完必须 `npx expo prebuild --platform android`
（会清空 `android/`，记得重建 `local.properties`）→ Release 构建 → 装机核对状态栏与通知展开后的图标。
已排期的本地通知在触发时才解析图标，因此更新 APK 后无需重排提醒。
系统侧可能按包缓存旧图标：重装后首次通知仍显示旧图标时，先重启设备再用 `dumpsys notification`
核对 `icon=` 是否已指向 `dev.taskdock.mobile` 的 `drawable/notification_icon`，不要据此判定配置失败。

## 配对与相机（2026-11-08）

- `expo-camera` 已加入依赖并在 `app.json` 声明插件（中文相机用途说明、关闭录音权限）；
  `npx expo prebuild --platform android` 会生成 `android.permission.CAMERA`。
- `plugins/withCleartextTraffic.js` 是本地配置插件，prebuild 时给 `<application>` 加
  `android:usesCleartextTraffic="true"`：本轮配对传输是局域网 HTTP（用户确认的 v1 基线），
  Android 9+ 默认拦截明文，不加会表现为「配对请求超时」。TLS 计划见
  [06-pairing.md](06-pairing.md) §5，升级 TLS 后应删除该插件并重新 prebuild。
- `android/` 是生成目录：prebuild 会清空它，构建前必须重建 `android/local.properties`
  （`sdk.dir` 指向含 NDK 27.1 的本机 SDK）；本机 release 构建命令不变（§3）。
- 只出真机 ABI 时附加 `-PreactNativeArchitectures=arm64-v8a`，不要手改生成目录。

## 文件互传（2026-11-09）

- `expo-file-system` 已从 `expo` 的嵌套依赖提升为**直接依赖**（`~58.0.13`）。它是原生模块，
  必须重新 `npx expo prebuild --platform android` 并重编 APK 才会进入安装包；
  仅改 JS 不会生效。模块提供 `File.pickFileAsync`、SAF `Directory.pickDirectoryAsync`、
  `FileHandle` 与 `File.preview`，不需要 `expo-document-picker` / `expo-sharing`。
- 本机在无 npm 网络时按 lock 中同版本条目补齐了 `package-lock.json` 并把包复制到
  `node_modules`；有网络的机器执行 `npm install` 会自行对齐，不要重复添加依赖。
- 本机曾出现 `hermesc.exe` 带 Low 完整性标签、`-emit-binary` 写文件 `permission denied`
  （连 1 行脚本都失败）：把普通目录下的中等完整性副本硬链接回
  `node_modules/hermes-compiler/hermesc/win64-bin/hermesc.exe` 即可。这是 node_modules
  的 ACL 状态，不是项目配置；不要为此改 Gradle/JS 代码。
- 文件互传的协议与上限见 [08-file-transfer.md](08-file-transfer.md)。

## 变更记录

- 2026-11-08 首版：记录 JDK 17、镜像 Gradle、长路径约束与版本号提升流程。
- 2026-11-08 通知图标：补充 expo-notifications `icon`/`largeIcon` 资源分工、单色约束与
  `gen-notification-icon.mjs` 生成流程；故障表增加「图标仍是系统默认」一行。
- 2026-11-08 配对：补充 expo-camera 权限、明文 HTTP 配置插件与 prebuild 后重建
  `local.properties` 的约束。
- 2026-11-09 同步 v1.1：版本提升到 0.1.6 / versionCode 13；本轮未重跑 prebuild，
  `app.json` 与 `android/app/build.gradle` 同步手改，后续 prebuild 以 `app.json` 为准。
  最终 APK sha256 `ad349b80…`。
- 2026-11-09 文件互传：`expo-file-system` 提升为直接依赖；原生模块必须 prebuild + 重编
  APK 才生效。记录无 npm 网络时 lock/node_modules 的补齐方式与不要重复引入的边界。
  补记 `hermesc.exe` Low 完整性导致 `permission denied` 的环境处理；最终 APK
  0.1.6/vc13 sha256 `6356f581…`（arm64-v8a，非 debuggable）。
- 2026-11-09 文件互传 UI 真机走查：vc14 → vc18 连续覆盖安装（仅改 JS，未重跑 prebuild）。
  vivo 的 `start_confirmation_activity=0` 仍可能被「安全守护」拦截，需要在安装器里
  勾选「已了解应用的风险检测结果」再点「继续安装」；安装后把该全局设置恢复为 1。
  最终 APK 0.1.6/vc18 sha256 `605cbc8a…`（arm64-v8a，非 debuggable）。本轮同时修复
  取消竞态与 SAF 半成品清理，见 [08-file-transfer.md](08-file-transfer.md) §5。
- 2026-11-09 设备 Tab 与文件类型图标（vc20/vc21）：仅改 JS，vc20 增量构建 2m45s，
  vc21 补入口文案后 2m01s。vc19 安装被 vivo 安全守护拦截后，vc20/vc21 在解锁状态下
  直接 `adb install -r` 成功（仍临时把 `start_confirmation_activity` 置 0，安装后恢复 1）。
  最终 APK 0.1.6/vc21 sha256 `3cdd309d…`，30,859,837 B（arm64-v8a，非 debuggable）；
  vc20 为文案修正前的中间产物，不作为交付件。
