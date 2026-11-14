# Android 独立虚拟屏幕技术可行性验证（PoC）

- 验证日期：2026-11-13
- 任务性质：技术可行性验证（PoC），不含产品功能开发、不含 task_dock 代码改动
- 验证设备：vivo V2323A（PD2323），Android 16 / API 36，无线 ADB
- 工具：scrcpy 5.0.1（winget 安装官方 `Genymobile.scrcpy`）+ adb 1.0.41（37.0.0 / scrcpy 内置 37.0.1）
- 证据根目录：`tmp/acceptance/android-virtual-display-poc/evidence/run2-20261113/`（`tmp/` 已被 `.gitignore` 忽略，截图含个人内容，不纳入仓库）
- 先期证据：同目录 `evidence/`、`logs/` 为本次之前的一次运行（17:44–17:58），本文仅作对照，不当作本次结论依据

---

## 1. 结论摘要

| 评审项 | 结论 |
|---|---|
| 技术可行性 | **部分通过**：虚拟屏创建、指定应用启动、双屏独立前台、多虚拟屏并发、flex 缩放、关闭不影响实体屏均已真机实测通过；**键盘输入未验证**（本机自动化环境无法投递合成按键），锁屏/解锁场景未验证 |
| 当前设备兼容性 | **通过**（仅限 vivo V2323A / Android 16 实测范围）：上述能力全部在本机成立；其他厂商与机型未验证 |
| 是否建议集成 task_dock | **建议**，但限定为「开发者模式（ADB + scrcpy）」能力；普通用户默认路径建议暂缓，需先解决输入法与锁屏边界 |
| 是否建议开始正式开发 | **是**，限定范围：单设备 + 单虚拟屏 + 进程托管 + 窗口生命周期 + 状态可见；键盘/IME、锁屏行为必须先补人工验收 |
| 优先解决问题 | ① 键盘/IME 真实链路 ② 锁屏/息屏行为 ③ ADB 安全边界与授权撤销 ④ 进程与虚拟屏生命周期（强杀孤儿屏）⑤ 窗口集成方式 ⑥ 资源上限与多屏降级 |

判定口径：**官方文档明确支持** ≠ **本机实测通过**。本文逐项标注三类来源：`官方文档`、`本机实测`、`未验证`。

---

## 2. 工作区现状（只读排查结论）

### 2.1 技术栈事实

- 桌面端：Tauri 2 + Rust（`src-tauri/`）、React + TypeScript + Vite + Zustand（`src/`）、SQLite（仅 `src-tauri/src/db/mod.rs` 维护迁移）。
- 移动端：React Native + Expo（`apps/mobile/`），SQLite 本地库，schema v5。
- 桌面/移动配对与同步：HTTPS over TLS（自签叶证书 + SPKI 固定），手机主动轮询，**没有桌面端到手机的推送通道**。
- 窗口：除 `main` 外还有常驻复用窗口（`notification`/`context-menu`/`capture`/`tab-hint`）与动态窗口（`workspace`、`widget-*`）。动态窗口先例：`WebviewWindowBuilder` + 独立 HTML 入口 + 独立 capability + 独立几何设置键（`src-tauri/src/project_workspace_window.rs`）。
- 子进程：`src-tauri/src/winproc.rs` 提供 `hidden()`（`CREATE_NO_WINDOW`）与带超时的 `output_with_timeout`/`run_with_timeout`；无 job object、无进程组、无 `SetParent` 嵌入代码。

### 2.2 与投屏/虚拟显示相关的现有能力

**没有**。全仓库检索结论：

- `scrcpy` 零命中（唯一提及在 `docs/mobile/05-build.md` 的构建前置说明）。
- `src-tauri/src`、`apps/mobile/src`、移动原生模块中无 `MediaProjection`、`VirtualDisplay`、`ImageReader`、`getDisplayMedia`、`desktopCapturer`。
- 无 WebRTC/屏幕流；无投屏、远程控制、虚拟显示端点或占位。
- `adb` 只出现在文档的人工验收步骤里（`docs/mobile/04-testing.md`、`05-build.md`、`06-pairing.md` 等），不是运行时依赖。

### 2.3 相关契约位置（若后续集成需同步）

| 变更类型 | 必改位置 |
|---|---|
| 新增桌面命令 | `src-tauri/src/commands/<module>.rs` → `commands/mod.rs` → `src-tauri/src/lib.rs` 的 `generate_handler!` → `src/lib/bridge.ts` |
| 新增窗口 | `tauri.conf.json`（可选）+ `src-tauri/capabilities/<id>.json` + `<name>.html` + `vite.config.ts` 入口 + `src/lib/bridge.ts` |
| 新增设置项 | `db::Settings` + `commands/settings.rs::ALLOWED_KEYS` + `validate_setting` + `bridge.ts` 类型 |
| 新增表 | `db/mod.rs` 的 `MIGRATIONS` 末尾追加 + `commands/backup.rs` 的 `BACKUP_TABLES` / `EXTENDED_TABLES` |

当前迁移末尾为 v49（本次工作区未提交改动包含 v49，本次未做任何修改）。

---

## 3. 设备与环境信息（本机实测）

| 项 | 值 | 来源 |
|---|---|---|
| 品牌/型号 | vivo V2323A（device `PD2323`） | `adb shell getprop` |
| Android 版本 | 16（`ro.build.version.release=16`） | 同上 |
| API Level | 36 | 同上 |
| ABI | arm64-v8a | 同上 |
| 屏幕 | 物理 1260×2800 @ 480dpi；**系统覆盖 1080×2400** | `wm size` / `wm density` |
| 连接方式 | 无线调试（`_adb-tls-connect`），地址 `<PHONE_IP>:38585` | `adb devices -l` / `adb mdns services` |
| ADB 授权 | 已授权（`device` 状态，非 `unauthorized`） | `adb devices` |
| USB 调试 | 未使用（无线调试替代） | 实测 |
| scrcpy | 5.0.1（SDL 3.4.18 / ffmpeg 63.1.102） | `scrcpy --version` |
| adb | 系统 1.0.41 (37.0.0)；scrcpy 内置 1.0.41 (37.0.1) | `adb version` |
| 锁屏状态（测试期间） | `mDreamingLockscreen=false`，`mAwake=true` | `dumpsys window` |

环境坑（已实测，影响集成实现）：

1. **重复 transport**：mDNS 自动连接与手工 `adb connect` 同时存在时，`adb` 报 `more than one device/emulator`，scrcpy 报 `Multiple (2) ADB devices` 并失败。必须用 `-s <serial>` 固定设备。
2. **mDNS 不稳定**：中途掉线一次，`adb mdns services` 一度为空，需 `adb connect <PHONE_IP>:38585` 恢复。
3. `screencap -d <id>` 对 scrcpy 创建的私有虚拟屏返回 `Display Id 'X' is not valid`，不能用于虚拟屏取证；虚拟屏内容只能通过 scrcpy 流或窗口截图取证。

---

## 4. scrcpy 版本与参数支持（`scrcpy --help` 实测 + 官方文档）

本机 5.0.1 `--help` 中存在以下参数（help 行号为实测）：

| 参数 | 本机 help | 官方文档 | 引入版本（GitHub Release Notes） |
|---|---|---|---|
| `--new-display[=[WxH][/DPI]]` | 第 314 行 | `doc/virtual-display.md` | v3.0 |
| `--start-app=name` | 第 489 行 | `doc/virtual-display.md#start-app` | v3.0 |
| `--no-vd-destroy-content` | 第 363 行 | 同上 | v3.1 |
| `--no-vd-system-decorations` | 第 368 行 | 同上 | v3.x（现有文档） |
| `--display-ime-policy=value` | 第 145 行 | 同上 | 现有文档 |
| `-x, --flex-display` | 第 600 行 | 同上 | **v4.0**（v4.1 修 flex 编码器约束） |
| `--list-displays` / `--display-id` | 第 242 / 139 行 | `doc/video.md` | 现有文档 |

官方文档要点（原文摘录）：

- 「The new virtual display is destroyed on exit.」
- flex：`--new-display=1024x768 --start-app=com.android.settings --flex-display`；不指定尺寸时默认 **1280x960/160**。
- 无 launcher 时虚拟屏为空：「if no app is started, no content will be rendered, so no video frame will be produced at all.」
- 「A secondary display may only be controlled if the device runs at least Android 10.」
- Android 16 相关修复：v3.3.2 修「desktop experience features」开启时虚拟屏失败（Pixel 安全补丁引发）；本机 vivo 未开启该选项，未复现。

`--new-display` 与 `--no-window` 互斥（实测报错 `--new-display is incompatible with --no-video`）；无窗口场景需给视频输出（本机改用 `--record` 验证成功）。

---

## 5. 测试 A：普通屏幕镜像

| 子项 | 结果 | 证据 |
|---|---|---|
| A1 是否正常显示 | **PASS** | `A2-mirror-rendered.png`（镜像窗口 2418×1127，纹理 2400×1088 / 1088×2400） |
| A2 鼠标点击是否有效 | **PASS** | 点击设备坐标 (402,2255) → `Settings$AccountDashboardActivity`；点击搜索框 (594,324) → `vigour_search_edit` `focused=true`；虚拟屏上点击「任务」Tab → App 页面切换 |
| A3 键盘输入是否有效 | **BLOCKED（环境）** | `SendInput`/`keybd_event` 返回已接受事件（sent=6/4），但本机 WinForms TextBox 对照收不到字符；scrcpy 窗口 `foreground/active/focus` 三者均为目标窗口（`GetGUIThreadInfo` 验证），Alt+R / Alt+H 无任何 scrcpy 日志与设备反应。设备侧对照：`adb shell input text xyz` 让 IME 候选条出现 `xyz` 拼音组合（`A22-screen-chrome.png`），说明注入到设备是通的，但文本未提交。**scrcpy 键盘链路本身未验证** |
| A4 屏幕旋转是否正常 | **PASS** | `wm fixed-to-user-rotation enabled` + `wm user-rotation lock 1` → 设备转横屏（`F2-rotate-state.png`），scrcpy 纹理 1088×2400 → 2400×1088；已恢复 `free`/`default` |
| A5 断开连接是否影响手机 | **PASS** | 结束 scrcpy 后 `mWakefulness=Awake`，前台仍为启动器，设备正常 |
| A6 手机触控是否仍然有效 | **NOT TESTED** | Agent 无物理触控能力；未用 `adb input` 冒充真机触控 |

补充观察（与集成相关）：

- vivo 设置的搜索框对 `input keyevent` / `input text` 完全不响应（注入被忽略），属于厂商 UI 行为，不等于 scrcpy 缺陷。
- scrcpy 窗口在纹理比例变化时会自动改窗口尺寸（595×1329 → 577×1282），**坐标映射必须每次读取实时客户区**，不能用固定换算（首轮点击即因此偏移）。

---

## 6. 测试 B：独立虚拟屏幕创建

**PASS**。实测命令与输出：

```
scrcpy -s <PHONE_IP>:38585 --new-display=1080x1920 --no-audio --keep-active --window-title=TD-POC-VD
[server] INFO: New display: 1080x1920/384 (id=17)
INFO: Texture (D3D11VA): 1088x1920
```

| 子项 | 结果 | 证据 |
|---|---|---|
| 是否能创建虚拟显示 | **PASS** | server 日志 `New display: 1080x1920/384 (id=17)`；`dumpsys display` 出现 `virtual:com.android.shell,2000,scrcpy,…`，`type VIRTUAL`、`FLAG_PRIVATE`、`owner com.android.shell (uid 2000)` |
| 是否能正常显示 Android UI | **PASS** | 指定 `--start-app` 后 `C2-vd-settings-window.png` 完整显示设置页 |
| 是否能用鼠标点击 | **PASS** | 窗口点击 → d17 活动切换（`vivo.assistant/.ui.SettingsActivity`）；flex 场景点击 → `Settings$DisplaySettingsActivity` |
| 是否支持键盘输入 | **BLOCKED（同 A3 环境限制）** | 未获得可用键盘投递通道 |
| 是否能启动应用 | **PASS** | `--start-app=com.android.settings`、`com.android.chrome`、`dev.taskdock.mobile` 均成功 |
| 手机实体屏是否保持正常 | **PASS** | 创建期间 d0 前台始终为启动器/Chrome，可独立切换应用 |
| 关闭虚拟屏后是否恢复正常状态 | **PASS** | 关闭窗口后 display 17 消失，仅剩 d0（及第三方 App 自建屏），scrcpy 进程退出 |

**关键发现**：未指定 `--start-app` 时虚拟屏无内容、无视频帧（符合官方文档），因此 PoC 必须「创建 + 启动应用」成对使用。

---

## 7. 测试 C：指定应用启动 + 双屏独立操作

**PASS**。

```
[server] INFO: New display: 1080x1920/384 (id=17)
[server] INFO: Starting app "设置" [com.android.settings] on display 17...
```

同时刻 `dumpsys activity activities`：

```
topResumedActivity=... com.vivo.assistant/.ui.SettingsActivity t1113 d17
topResumedActivity=... com.bbk.launcher2/.Launcher t6 d0
```

- 两个 display **同时各有一个 topResumedActivity**，互不抢占 → 满足「双屏独立前台」。
- 电脑侧点击虚拟屏 → d17 活动变化，d0 不变（反向也成立，见第 9 节）。
- 虚拟屏上还观察到 vivo 自带 `com.bbk.launcher2/.gms.SecondaryDisplayLauncher`，说明厂商为副屏提供了独立 launcher（不是所有机型都有）。

**Task Dock 自身验证（对集成最关键）**：

```
[server] INFO: New display: 1080x1920/384 (id=26)
[server] INFO: Starting app "TaskDock" [dev.taskdock.mobile] on display 26...
```

- 画面正常渲染（`H2-taskdock-window.png`），d26 为前台，d0 仍为启动器。
- 电脑鼠标点击底部「任务」Tab → App 从「首页」切到「任务」列表（`H3-taskdock-after-tap.png`），证明 **PC 鼠标可直接操作运行在虚拟屏上的 task_dock 移动端**。

---

## 8. 测试 D：窗口大小与 flex 缩放

**PASS**。

```
[server] INFO: New display: 1024x768/160 (id=18)
[server] INFO: Starting app "设置" [com.android.settings] on display 18...
```

| 子项 | 结果 | 证据 |
|---|---|---|
| 调整窗口大小是否正确适配 | **PASS** | 窗口 900×640 → `wm size -d 18` = `882x592`，`wm density -d 18` = 160（密度不变） |
| 比例变化是否正常 | **PASS** | 纹理序列 `1024x768` → `896x592` → `592x896`（应用锁定竖屏时自动转向） |
| 触控坐标是否准确 | **PASS** | 缩放后点击设备 (139,688) → 打开 `Settings$DisplaySettingsActivity`（d18） |
| 是否存在黑屏/画面拉伸 | **未观察到** | `D2-flex-resized.png` 无黑边/拉伸 |
| 应用是否意外返回实体屏 | **未观察到** | 全程 d18，d0 保持 Chrome |

---

## 9. 双屏真正独立性矩阵

| # | 场景 | 结果 | 实测证据 |
|---|---|---|---|
| 1 | 应用 A / 应用 B 两边不同 | **PASS** | d0 启动器 + d17 设置；d0 启动器 + d26 TaskDock；d19 设置 + d20 Chrome |
| 2 | 手机操作 A，手机操作不影响电脑 | **PARTIAL** | 设备侧在 d0 启动 Chrome 后 d17 活动不变；**物理触控未验证**（Agent 无触摸能力） |
| 3 | 电脑点击/滑动 B，电脑操作不影响手机 | **PASS** | 虚拟屏点击 → d17 活动变化，d0 保持启动器 |
| 4 | 实体屏切到应用 C，保持 B | **PASS** | d0 启动 Chrome，d17 仍为 vivo.assistant Settings |
| 5 | 虚拟屏切到应用 D，不影响实体屏 | **PASS** | `am start --display 17 -a android.settings.SETTINGS` 后 d17 变设置，d0 仍 Chrome |
| 6 | 关闭虚拟屏，实体屏不受影响 | **PASS** | 关闭后 d17 消失，d0 仍 Chrome，scrcpy 退出 |
| 7 | 手机锁屏，观察 B | **NOT TESTED** | 未执行：锁屏需用户后续解锁，避免使设备停留在锁定态；`--keep-active` 只能阻止息屏，不能绕过锁屏 |
| 8 | 手机解锁，观察 B | **NOT TESTED** | 同上 |

---

## 10. 多个虚拟屏幕验证

**PASS（双虚拟屏）**。

```
[server] INFO: New display: 1080x1920/384 (id=19)   # Settings
[server] INFO: New display: 1080x1920/384 (id=20)   # Chrome
```

| 子项 | 结果 | 证据 |
|---|---|---|
| 能否同时创建两个虚拟显示 | **PASS** | `dumpsys display` 同时存在 Display 19、20 |
| 是否能够分别操作 | **PASS** | 两窗口分别捕获 `E-M1-window.png`、`E-M2-window.png`；各自 topResumed 独立 |
| 两个虚拟屏是否互相抢占焦点 | **未观察到** | d19/d20/d0 三个 display 各有前台 |
| 是否把应用切回实体屏 | **未观察到** | 全程无自动回迁 |
| CPU/内存是否明显增加 | **明显增加（未做受控基准）** | PC 侧 2×scrcpy 工作集约 314 MB；设备侧 2 虚拟屏时 `MemAvailable` 约 3.8 GB，1 虚拟屏时 `MemFree` 404 MB / swap 已用 4.5 GB（设备内存压力明显，含京东等用户应用，不能全部归因） |
| 是否卡顿/黑屏/闪退 | **未观察到**（带告警） | 设备处于内存紧张区间，长时稳定性未验证 |
| 关闭一个窗口是否影响另一个 | **PASS** | 关闭 M1 后 Display 19 消失，Display 20 与 d0 不受影响，M2 进程存活 |

**同应用双实例：证据不足（未确认）**。在 Chrome 已运行于 d24 时执行默认显示启动 Chrome，未在 d0 创建第二任务，已有任务被复用；同时刻 d0 前台变为京东 App（来源未确认）。结论只能表述为：**未观察到同一 launchMode 应用在两个 display 同时出现两个独立实例**，需要按应用逐个验证。

---

## 11. 输入、旋转、锁屏与应用兼容性

### 11.1 输入

| 能力 | 结果 | 说明 |
|---|---|---|
| 鼠标点击 | **PASS（本机实测）** | 普通镜像与虚拟屏均命中；映射需实时读取客户区 |
| 鼠标滑动/拖拽 | 未单独验证 | 点击已证明触点注入链路；手势未单独验收 |
| 键盘字符 | **未验证（环境）** | 见 A3；真实键盘需人工复测 |
| IME/中文输入 | **未验证** | 官方文档：虚拟屏 IME 默认出现在主屏，需 `--display-ime-policy=local`；本机未验证 |
| 剪贴板同步 | **未验证** | `doc/control.md` 说明默认双向同步，可 `--no-clipboard-autosync` 关闭 |
| 独立控制虚拟屏方向/尺寸 | **PASS** | `wm size/density -d <id>` 与 `--flex-display` 均生效 |

### 11.2 旋转

- 设备旋转 → scrcpy 纹理与窗口跟随（`2400x1088` ↔ `1088x2400`）；已恢复用户旋转策略。
- 虚拟屏内容方向由应用与 scrcpy 共同决定（flex 场景出现 `592x896` 自动转竖）。

### 11.3 锁屏

- 未验证。可确认的限制（官方文档口径）：`--keep-active` 只保持屏幕常亮，不能绕过锁屏；锁屏后虚拟屏是否继续渲染、应用是否被冻结属于 Android 电源/Activity 管理行为，必须真机复测。
- 设备锁屏会触发 mDNS/无线调试波动风险（本次已遇到连接中断，原因未确认是否与锁屏相关）。

### 11.4 应用兼容性

| 应用 | 结果 |
|---|---|
| `com.android.settings` | **PASS**（虚拟屏渲染 + 点击导航） |
| `com.android.chrome` | **PASS**（虚拟屏渲染，地址栏可见） |
| `dev.taskdock.mobile` | **PASS**（虚拟屏渲染 + 点击切页） |
| 游戏 / 视频 / DRM | 未验证（未打开个人应用） |
| 强制返回实体屏的应用 | 本次未遇到；同应用双实例未确认（见第 10 节） |

---

## 12. 失败原因、设备限制与安全风险

### 12.1 已确认的设备/系统限制

1. **必须 ADB**：scrcpy 以 `com.android.shell`（uid 2000）身份创建虚拟屏并注入输入；没有 ADB 就没有这条路径。
2. **虚拟屏是 `FLAG_PRIVATE` + `type VIRTUAL`**：`screencap -d` 无法取证；第三方工具也不能随意截取。
3. **无应用则无画面**：虚拟屏空置时不产生视频帧（官方文档 + 实测）。
4. **IME 默认落在主屏**：需要 `--display-ime-policy=local` 才能让输入法出现在虚拟屏（未实测）。
5. **强杀会遗留虚拟屏**：先期运行中观察到 `virtual:com.android.shell,2000,scrcpy,13/14` 在进程消失后仍被 DisplayManager 枚举（`committedState UNKNOWN`），直到后续进程清理才消失；优雅关闭不会遗留。
6. **vivo 部分 UI 忽略注入按键**：设置搜索框对 `input keyevent`/`input text` 无响应（设备行为）。
7. **无线调试稳定性**：本次出现一次掉线；mDNS 与手工连接并存会产生重复 transport。

### 12.2 安全与权限（区分四类能力）

| 类别 | 结论 |
|---|---|
| **官方明确支持** | scrcpy 官方文档：`--new-display` 创建虚拟屏、`--start-app` 启动应用、`--flex-display` 动态缩放、退出销毁虚拟屏、副屏输入需 Android 10+ |
| **本机实测成功** | 上述能力在 vivo V2323A / Android 16 上成立（键盘除外） |
| **理论可行但未验证** | 键盘/IME/剪贴板、锁屏后继续渲染、多应用双实例、`--no-vd-destroy-content` 内容回迁、音频转发（Android 11+） |
| **普通第三方 App 无法获得** | 以 shell 身份创建「可注入输入」的虚拟屏；在虚拟屏上启动**其他应用**并控制；读取其他应用画面（需 MediaProjection 授权，且 DRM/FLAG_SECURE 画面为空） |

补充事实：本次在设备上观察到京东 App 自建 `virtual:com.jingdong.app.mall,…,.vv_virtual_display`（1×1）。这说明普通 App 可以用 `DisplayManager` 创建虚拟屏做**自身内容**的离屏渲染，但**不能**把它变成「可运行并控制任意应用」的第二桌面。

**ADB 授权风险**（集成前必须写清）：开启无线调试后，同一网络内持有配对凭证的一端可获得 shell 级能力（读应用数据、安装/卸载、注入输入、截屏）。task_dock 不应静默启用 ADB，不应代用户开启开发者选项，必须显式授权、可撤销、可审计，并避免在日志中记录设备序列号/配对码。

---

## 13. 三种集成方案对比

### 方案 A：集成 scrcpy（Tauri/Rust 进程托管 + 独立窗口）

| 维度 | 评估 |
|---|---|
| 开发成本 | **低**（本 PoC 已证明能力；Rust 只需进程托管 + 状态机） |
| 依赖管理 | 需随包分发 scrcpy（官方 win64 zip 约 11 MB，解压后约 50 MB，含 adb/SDL/ffmpeg DLL）；许可证 Apache-2.0，需保留 LICENSE |
| Windows 打包 | 可放 `resources/`，用绝对路径启动；注意与系统 adb 版本冲突（scrcpy 自带 adb，建议固定用自带） |
| 设备连接 | 无线 ADB 需配对；必须固定 serial（重复 transport 会启动失败）；断线需重连状态机 |
| 窗口管理 | 独立顶层窗口最简单（现成 scrcpy 窗口）；嵌入 Tauri 窗口需 `SetParent`，仓库无先例、风险高 |
| 进程退出/异常恢复 | 需 job object 或显式 kill + 等待；**强杀会遗留虚拟屏**，需要回收策略（重启服务或提示重启设备） |
| 截屏/录像/剪贴板 | 原生支持（`--record`、剪贴板同步、`--no-audio` 可选） |
| 结论 | **推荐作为第一实现**，限定开发者模式 |

### 方案 B：自研 Android 虚拟显示能力（App 内 MediaProjection / VirtualDisplay）

| 维度 | 评估 |
|---|---|
| 权限边界 | 普通 App 只能拿到**自己的** VirtualDisplay 内容或经用户同意的屏幕采集流；**无法**在虚拟屏上启动并控制其他应用 |
| 输入控制 | 只能通过 Accessibility/手势注入，覆盖面和可靠性低于 shell 注入；无法模拟系统级按键 |
| 采集 | MediaProjection 需要每次会话用户确认；`FLAG_SECURE`/DRM 画面为黑 |
| 结论 | **不能替代 scrcpy**；只适合「只读投屏/录制」类产品能力 |

### 方案 C：混合架构（推荐的产品形态）

- **开发者模式**：ADB + scrcpy，支持虚拟屏、指定应用、键鼠控制（本 PoC 路径）。
- **普通用户模式**：手机侧 MediaProjection 授权投屏（只读，或加无障碍手势），不依赖 ADB。
- **task_dock 统一层**：设备管理（配对/授权/撤销）、窗口管理、截图与素材、任务联动、状态与诊断。

结论：**产品路线选 C，第一期实现选 A（开发者模式）**；不建议把 B 当作「控制任意应用」的方案。

---

## 14. 对 task_dock 的推荐实现路线（分阶段）

1. **P0 能力探针（1 个窗口）**：Rust 托管 scrcpy 进程，固定 serial，单虚拟屏 + `--start-app`，独立顶层窗口；命令：`virtual_display_start/stop/status`；状态落 SQLite 设置键（不落敏感信息）。
2. **P0 生命周期**：进程句柄 + 超时 + 强制回收；记录退出码；异常退出提示「虚拟屏可能残留」；关闭时等待进程退出再更新状态。
3. **P1 设备管理**：ADB 授权检测、serial 固定、断线重连、重复 transport 清理；与现有 `mobile_sync` 设备表解耦（ADB 设备 ≠ 同步设备）。
4. **P1 输入策略**：默认 `--display-ime-policy=local`；键盘可行性与 IME 方案需人工验收后固化；提供剪贴板开关。
5. **P2 多屏与资源**：多虚拟屏上限（建议先 1，实测 2 可用）；内存/CPU 采样与降级提示；`--flex-display` 作为可选项。
6. **P2 窗口**：独立窗口优先；如要嵌入，单独立项评估 `SetParent`（当前无先例）。

明确不做：不自动开启开发者选项、不代用户安装 APK、不静默抓取手机画面、不接入 root/Shizuku 等绕过手段。

---

## 15. 关键命令与可复现步骤

工作目录：`D:\Develop\task_dock\tmp\acceptance\android-virtual-display-poc`

```bash
# 0) 环境
adb version
scrcpy --version

# 1) 设备（无线调试）
adb devices -l
adb connect <PHONE_IP>:38585
adb -s <PHONE_IP>:38585 shell getprop ro.product.model
adb -s <PHONE_IP>:38585 shell wm size
adb -s <PHONE_IP>:38585 shell wm density

# 2) 参数支持
scrcpy --help | Select-String -Pattern "new-display|start-app|flex-display|no-vd-|display-ime-policy"

# 3) 普通镜像
scrcpy -s <PHONE_IP>:38585 --no-audio --keep-active --window-title=TD-POC-MIRROR

# 4) 虚拟屏 + 指定应用
scrcpy -s <PHONE_IP>:38585 --new-display=1080x1920 --start-app=com.android.settings \
       --no-audio --keep-active --window-title=TD-POC-VD

# 5) 双虚拟屏（另开一个终端）
scrcpy -s <PHONE_IP>:38585 --new-display=1080x1920 --start-app=com.android.chrome \
       --no-audio --keep-active --window-title=TD-POC-M2

# 6) flex 缩放
scrcpy -s <PHONE_IP>:38585 --new-display=1024x768 --flex-display \
       --start-app=com.android.settings --no-audio --keep-active --window-title=TD-POC-FLEX

# 7) 结构核验（每次操作后）
adb -s <PHONE_IP>:38585 shell dumpsys activity activities | findstr topResumedActivity
adb -s <PHONE_IP>:38585 shell dumpsys display | findstr "Display "
adb -s <PHONE_IP>:38585 shell wm size -d 18

# 8) 收尾
taskkill /IM scrcpy.exe /F
adb -s <PHONE_IP>:38585 shell input keyevent KEYCODE_HOME
```

窗口取证脚本（本次使用，均在 `scripts/`）：

- `capture-window.ps1`：`PrintWindow` 抓 scrcpy 窗口 PNG（含 rect/visible 输出）。
- `device-click.ps1`：按**实时客户区**把设备坐标换算为窗口坐标并点击（letterbox 感知）。
- `send-keys.ps1`：SendInput 键盘（本次受环境限制未生效）。
- `window-input.ps1`：窗口 info/restore/foreground/resize/close。

---

## 16. 未验证项与残余风险

| 项 | 状态 | 原因 |
|---|---|---|
| scrcpy 键盘字符/中文输入 | 未验证 | 本机合成按键被环境吞掉；需人工键盘复测 |
| 剪贴板同步 | 未验证 | 未在 PoC 范围内单独执行 |
| 锁屏/解锁时虚拟屏行为 | 未验证 | 需用户解锁配合，避免设备停在锁定态 |
| 物理触控与电脑操作并行 | 未验证 | Agent 无物理触摸能力 |
| 同应用双实例 | 证据不足 | 观察到任务复用，未构造强制新任务 |
| 长时稳定性/内存泄漏 | 未验证 | 单次短时验证，设备当时内存吃紧 |
| 其他厂商（小米/OPPO/华为等） | 未验证 | 仅一台 vivo 设备 |
| 音频转发 | 未验证 | 本 PoC 全程 `--no-audio` |
| `--no-vd-destroy-content` 内容回迁 | 未验证 | 未执行 |

残余风险：虚拟屏残留（强杀）、ADB 断线、设备内存压力、厂商定制（vivo）行为差异、键盘/IME 未闭环。

---

## 17. 最终结论

- **技术可行性：部分通过。** 电脑创建并控制 Android 虚拟屏、实体屏保持独立、多虚拟屏并发、flex 缩放、关闭不影响实体屏——均已真机实测成立；键盘输入与锁屏场景未闭环。
- **当前设备兼容性：通过（限 vivo V2323A / Android 16）。** 其他机型需单独验证。
- **是否建议集成 task_dock：建议**，限定「开发者模式（ADB + scrcpy）」；普通用户默认路径暂缓。
- **是否建议开始正式开发：是**，范围限定为单设备单虚拟屏的最小闭环，键盘/IME 与锁屏行为在正式开发前补齐人工验收。
- **优先解决的问题（按影响排序）：**
  1. 键盘/IME 真实链路（决定「能否用 PC 键盘操作 App」）。
  2. 锁屏/息屏后虚拟屏与应用状态（决定后台可用性与产品承诺）。
  3. ADB 授权与安全边界（开启/撤销/审计/脱敏）。
  4. 进程与虚拟屏生命周期（强杀孤儿屏、断线重连、重复 transport）。
  5. 窗口集成方式（独立窗口 vs 嵌入）与多显示器/DPI。
  6. 资源上限与多屏降级策略。

---

## 18. 本次执行边界声明

- 未修改 task_dock 任何代码、数据库结构、移动端导航或桌面 UI。
- 未执行 root、刷机、Bootloader、安全设置修改；未安装 APK；未开启开发者选项（无线调试由用户自行开启）。
- 未打开用户私人聊天、相册、银行等敏感应用；测试中短暂出现过的个人应用内容仅存在于 `tmp/` 证据，未写入本文件。
- 设备已恢复：旋转策略 `free`、前台为用户自身应用（未停留在我方测试页面）、无 scrcpy 进程/服务端残留、无本次创建的虚拟屏残留（收尾仅剩 Display 0 与京东 App 自建的 `vv_virtual_display`，后者非本次创建）。
- 唯一环境变更：按用户授权通过 winget 安装官方 `Genymobile.scrcpy 5.0.1`（winget 自动写入用户 PATH 与命令别名）。

---

## 19. 2026-11-14 MVP 落地（最小闭环）

在 §17 建议的限定范围内实现了第一版，**结论：真机链路通过；单元测试因环境阻塞未计入**。

### 19.1 范围与入口

- 入口：桌面端「手机互传」页新增折叠区块「Android 虚拟屏（实验）」，不改导航注册表与设置页。
- 能力：ADB 设备选择、应用（包名）选择、创建虚拟屏、关闭虚拟屏、连接/会话状态轮询。
- 交互：虚拟屏与输入全部由 scrcpy 独立窗口提供；task_dock 只托管启动与退出，不实现自有画面。

### 19.2 实现位置

| 层 | 文件 | 说明 |
|---|---|---|
| Rust 命令 | `src-tauri/src/commands/virtual_display.rs` | 探测、设备/应用枚举、进程托管、WM_CLOSE 收尾 |
| 命令注册 | `src-tauri/src/commands/mod.rs`、`src-tauri/src/lib.rs` | 新增 `virtual_display` 模块与 6 个命令 |
| 依赖特性 | `src-tauri/Cargo.toml` | `windows-sys` 追加 `Win32_System_JobObjects` |
| IPC 封装 | `src/lib/bridge.ts` | `vdProbe/vdDevices/vdListApps/vdStart/vdStop/vdSessions` |
| UI | `src/components/mobile/VirtualDisplaySection.tsx`、`virtual-display.css` | 区块、轮询、创建/关闭、错误提示 |
| 页面挂载 | `src/components/mobile/MobileTransferPanel.tsx` | 在手机互传页追加区块 |
| 文案 | `src/locales/zh-CN/index.ts`、`en-US/index.ts` | `virtualDisplay.*` |

### 19.3 关键参数与生命周期

- 创建命令：`scrcpy -s <serial> --no-audio --new-display=1080x1920/384 --display-ime-policy=local --start-app=<pkg> --window-title=<...>`。
- 关闭：先向 scrcpy 全部顶层窗口发 `WM_CLOSE`，等待最多 5s 让其正常销毁虚拟屏，超时才强杀。
- 退出：子进程加入 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），task_dock 被强杀时由系统回收，避免 §16 记录的「断线后无窗口孤儿进程」。
- 工具定位：优先环境变量 `TASK_DOCK_ADB` / `TASK_DOCK_SCRCPY`，其次 `PATH`，最后常见 SDK/winget 安装路径。
- 数据：设备序列号、包名、会话均只存在运行期内存，不写 SQLite、不新增设置键、不新增迁移。

### 19.4 真机验证（2026-11-14，vivo V2323A / Android 16 / 无线 ADB / scrcpy 5.0.1）

| 项 | 结果 | 证据 |
|---|---|---|
| `cargo build -j1` | 通过（2m17s，lib 4 警告） | `tmp/acceptance/android-virtual-display-poc/evidence/manual-20261113/cargo-build-2.log` |
| IPC：探测 | 通过：adb 1.0.41、scrcpy 5.0.1、2 条 transport | 同上目录 `mvp-ipc-check.mjs` 输出 |
| IPC：应用枚举 | 通过：573 个包名 | 同上 |
| IPC：创建/关闭 | 通过：`vd_start` 返回 pid/alive，`vd_stop` 后会话 0 | 同上 |
| UI：区块与选择 | 通过：手机互传页显示工具链/设备/应用/按钮 | `mvp-ui-1-phone-page.png`、`mvp-ui-5-running.png` |
| UI：创建 | 通过：会话行显示包名、serial、PID；scrcpy 窗口渲染 Settings | `mvp-scrcpy-window.png` |
| 设备侧双屏 | 通过：VD `d35` 为 Settings，实体屏 `d0` 为用户应用 | `dumpsys activity activities` 输出 |
| UI：关闭 | 通过：会话行消失，scrcpy 进程退出，`d35` 与 display 计数 0 | `mvp-ui-6-closed.png` |
| 强杀 task_dock | 通过：Job Object 回收 scrcpy，设备侧虚拟屏 0 残留 | 进程与 `dumpsys` 计数 |

### 19.5 未验证 / 已知限制

- **单元测试**：`cargo test --lib commands::virtual_display` 生成的测试 exe 在启动时失败（`0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`），属本机工具链/环境问题；同一二进制的真机链路与 `cargo build` 正常，该两项未计为通过。
- **TypeScript 全量检查**：仍被并行 WIP 的 `src/lib/capsuleLayout.test.ts` 未使用变量阻塞；本次新增文件无类型错误。
- 应用选择以包名展示（未解析本地化名称）；系统+第三方共 573 项，靠关键字搜索。
- 无线调试的 mDNS 传输名会随端口变化，设备列表可能出现同一手机的多条 transport；默认优先直连（serial 不含空格），mDNS 兜底。
- 锁屏/息屏、实体触控并发、同应用双实例仍未按 §16 补齐；键盘/中文输入已由用户人工确认通过（本机 Windows IME 需切英文，虚拟屏使用本地 IME）。

## 20. 2026-11-14 正式开发落地（双模式与可靠性整改）

在 §19 MVP 基础上完成 P0/P1 能力，正式功能文档见
[`docs/mobile/13-android-screen-control.md`](../mobile/13-android-screen-control.md)。

### 20.1 主要变化

| 项 | MVP | 本次 |
|---|---|---|
| 模式 | 仅独立虚拟屏 | 屏幕镜像 + 独立虚拟屏 |
| 状态 | 进程存活 + alive | starting/running/stopping/stopped/error/disconnected + stage |
| 就绪 | 启动 1.5s 后进程仍活 | 解析 scrcpy stderr：New display → Starting app → Texture；25s 超时 |
| 关闭 | 持锁等待最多 5s | 标记 stopping 后立即返回，后台 WM_CLOSE/强杀 |
| 设备 | 原始 transport 列表 | 按物理身份合并 USB/直连/mDNS，同一设备选唯一 transport |
| 应用 | 全部包名 | 可启动应用优先、用户/系统、无入口原因、手动包名、名称记忆 |
| 并发 | 无上限 | 默认 1；多屏实验最多 2；同设备同模式同应用去重 |
| Job Object | 分配失败静默 | 分配失败写 warning，UI 可见 |
| 窗口 | 无 | 定位/前置、客户区截图（仅用户触发） |
| 诊断 | 无 | 设备侧 scrcpy 虚拟显示残留检测 + 显式确认后的 ADB 重连 |

### 20.2 单元测试阻塞的根因与修复

§19.5 记录的 `cargo test` 启动失败 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` 已定位：
测试 exe 没有 Tauri 主程序的 manifest，`rfd`（tauri-plugin-dialog 的 Windows 后端）静态引用
`comctl32.dll!TaskDialogIndirect`，该导出只存在于 Common-Controls v6；加载阶段直接失败。
`src-tauri/build.rs` 现只对测试目标注入 `tests.manifest`（`/MANIFEST:EMBED` +
`/MANIFESTINPUT`），不改变发布二进制。修复后的执行结果以本轮验收报告为准。

### 20.3 本轮真机状态

实现完成后本机 `adb devices` 无在线设备（无线调试断开），新增镜像模式、设备去重、应用枚举、
窗口定位、截图、多屏实验等路径**未在本轮真机复验**；不得用 §19 的虚拟屏 MVP 结论替代。
真机复验命令与待验证矩阵见新文档 §13/§14，本轮验收报告在
`tmp/acceptance/android-virtual-display-development/report.md`。


