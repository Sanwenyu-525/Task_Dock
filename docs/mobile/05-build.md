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
npm run android                        # 调试构建 + 装机（expo run:android）
```

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
| `app.json` | `expo.version` | **唯一事实源**（`0.1.2`） |
| `app.json` | `expo.android.versionCode` | **唯一事实源**（当前 `5`） |
| `android/app/build.gradle` | `versionName` / `versionCode` | 生成物，prebuild 写入；不要当作源 |
| `src/screens/SettingsScreen.tsx` | 「关于 → 版本」文案 | 展示值，改版本号时同步 |

规则：

- `versionCode` **单调递增**，永不回退。vivo 安装器会拒绝「已安装相同版本」的重装，
  报 `INSTALL_FAILED_ABORTED`，弹窗写「已安装相同版本」——这不是签名或权限问题，
  提升 `versionCode` 后重装即可（0.1.0/1 → 0.1.1/2 → 0.1.2/5 已实测通过）。
  同一版本名下来回调试时，可以只加 `versionCode`、不改 `version`。
- 改版本只改 `app.json` + 设置页文案；如果直接手改了 `android/` 里的值，下次 prebuild 会被覆盖，
  不要依赖手改。
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
| `adb devices` 出现两条同机条目 | USB + 无线调试同时连接 | 所有命令加 `-s <serial>` 指定 |
| Git Bash 把 `/data/local/tmp` 变成 Windows 路径 | MSYS 路径转换 | `export MSYS_NO_PATHCONV=1` |
| `npm run typecheck` 在仓库根报 TS5112 | 根有 `tsconfig.json`，不能用显式文件列表 | 在 `apps/mobile` 下跑，或显式加 `--ignoreConfig` |

## 7. 与桌面端构建的关系

两端构建完全独立：手机端不触发 Vite / Tauri / Rust 构建，桌面端改动也不会自动进入 APK。
唯一共享物是图标源 `src-tauri/icons/icon.png`（`node scripts/gen-icons.mjs` 生成 assets），
换图标后需要重跑脚本 + `npx expo prebuild`。

## 变更记录

- 2026-11-08 首版：记录 JDK 17、镜像 Gradle、长路径约束与版本号提升流程。
