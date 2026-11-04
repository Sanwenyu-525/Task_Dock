# 验收方法论与通道路由（Task Dock）

本文件是 Task Dock 的执行级验收方法论：**四步顺序、A–F 通道、高风险场景判定前提、证据口径、
性能规则、并行约束与交付自检**。它补充而不是复制 [AGENTS.md](../AGENTS.md) 与
[TESTING.md](TESTING.md)：

- Git/数据/架构红线、报告字段、P0–P3 与结论四态以 [AGENTS.md](../AGENTS.md) 为准；
- 测试结果与历史记录由 [TESTING.md](TESTING.md) 记录，本文不写结果；
- 证据清单的机器校验契约见
  [.agents/skills/taskdock-acceptance/references/evidence-contract.md](../.agents/skills/taskdock-acceptance/references/evidence-contract.md)。

核心立场：**能用程序化方式可靠验证的 Web 交互，不默认抢占用户鼠标**；但「不移动光标」不等于
「不改变应用状态」。每条结论只覆盖实际测到的那一层，跨层结论必须组合通道。

## 一、四步执行顺序

1. **定目标与失败判据**：先写「要证明的可观察结果」和「什么算失败」，并列出非目标。
   不写「跑一遍看看」；不把「没有报错」当目标。
2. **判断行为层**：纯逻辑/契约；浏览器 DOM 渲染；真实 WebView2 交互；Win32/DWM 几何与桌面
   合成；系统级（通知、剪贴板、前台、音效）；物理手感。
3. **选最低干扰通道**：A → B → C → D → E → F；同级优先复用本仓库已有脚本与参数，
   不新造一次性工具。
4. **必要时组合并逐项标注**：一个目标可拆成多层，结论逐条写明「通道 + 可观察结果 + 证据路径
   + 未覆盖边界」。不得用单通道结果外推到其他层。

## 二、通道定义与 Task Dock 映射

| 通道 | 适用行为层 | Task Dock 手段（真实命令/脚本） | 能证明 | 不能证明 |
|---|---|---|---|---|
| **A 静态与自动化测试** | 纯函数、状态机、IPC 参数、SQLite 迁移、契约、类型、编译 | 仓库根 `npm test`（vitest run）、`npm run build`（`tsc --noEmit && vite build`）；`src-tauri/` 内 `cargo test`、`cargo test --lib`、`cargo fmt --check`、`cargo clippy --all-targets --all-features` | 代码层逻辑、契约、迁移、类型安全 | 真实渲染、真实 WebView2、Win32/DWM、系统剪贴板、系统通知、物理手感；`#[ignore]` 套件不计为通过 |
| **B 隔离浏览器预览** | 视觉走查、布局溢出、主题与 DPI 近似、DOM 交互回归 | `npm run build` → `node scripts/make-preview.mjs` → `node scripts/serve-preview.mjs`（默认 `http://localhost:4173/preview.html`，harness 取 `.preview/`、产物取 `dist/`）；`visual-themes.mjs`、`visual-v06.mjs`、`visual-v07.mjs`、`visual-audit.mjs`、`layout-regression.mjs` | mock IPC 下的 CSS 布局、配色、层级、溢出、窄窗、DPR 模拟 | 真实 WebView2、原生窗口、窗口区域裁剪、DWM 材质、系统通知/剪贴板/前台；不得用 `npx vite preview` 代替 `serve-preview.mjs` |
| **C CDP + 真实 WebView2** | 真实实例中的点击/悬停/填写/键盘、DOM 可见性、控制台错误、交互计时 | 真实 exe + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`（见 `scripts/acceptance/clipboard_capture_probe.py`、`mixed_paste_acceptance.py`）；`scripts/acceptance/cdp-main-window.mjs`（主窗口识别库，无独立 CLI）、`cdp-bridge.mjs`、`joint-ui-drive.mjs`、`scripts/native-cdp.mjs` | 真实 WebView2 内的输入管线交互、DOM 状态、实时错误、点击到可见的耗时 | Win32 区域裁剪、吸附手感、系统级鼠标命中、系统通知真实展示、实际音效、桌面合成透明度与融合；页面截图 ≠ 桌面合成截图 |
| **D 可访问性结构断言** | 控件树、可访问名称、`enabled/disabled`、文本与结构 | 现状：仓库内**没有常驻 UIAutomation 脚本**。结构类结论优先在 C 通道读取真实 WebView2 的 `role`、`aria-label`、`aria-disabled`、`data-tip` 或 Playwright accessibility snapshot；确需原生 UIA 时只能用临时脚本/computer-use 读树，标记 `D-临时` | 可访问性结构与控件属性 | 像素外观、hover、拖拽、实际鼠标命中；无仓库脚本复现的临时 UIA 结果不得计为可复现通过，最多「证据不足」 |
| **E Win32/DWM 原生** | 真实窗口区域、圆角、桌面合成、DWM 材质、DPI/多显示器几何、进程级资源 | `scripts/native-verify.ps1`（内部 `corner-lab.ps1` + `check-corners.py`）；`scripts/diagnose-corner.ps1`；`scripts/capture-native.ps1`；历史 `capture-native-set.ps1`（见 5.2 风险） | 独立数据目录下真实 exe 的合成像素、区域回读、DWM 属性、窗口矩形与 DPI、进程/句柄/线程/内存采样 | CSS 细节与 WebView2 内容渲染（用 B/C）；拖拽手感与系统级命中（用 F）；单个静止帧不能证明所有状态转换 |
| **F 真实物理操作 / computer-use** | 吸附手感、系统级命中、通知实际可见性、全局热键、第三方应用联动 | computer-use 物理鼠标/键盘；无专用仓库脚本 | 程序化通道无法触达的物理层 | 不能替代 A/B/C/E 已能覆盖的层；移动光标、抢前台、操作他应用前必须取得授权 |

### 2.1 硬边界（任何通道都不得越过）

- **页面截图不能证明桌面合成**：CDP/Playwright 截图只含 WebView2 表面，不含 DWM 边框、阴影、
  材质、圆角裁剪与桌面透出；只有 E 的桌面合成截图（`CopyFromScreen`）可作证。
- **`PrintWindow` 不能证明窗口背后透出**：它只抓窗口自身内容，看不到桌面或背景基线。
- **设置命令返回成功不能证明像素正确**：`GetWindowRgn` 返回非 0、`DwmSetWindowAttribute` 返回
  `S_OK`、设置写入成功，都只证明 API 调用成功；必须回读几何并审计像素。
- **Mock 不能冒充真实运行**：B 的 IPC mock、单元测试的假实现只证明代码路径。
- **`dispatchEvent()` / DOM `.click()` 不能算真实交互**：绕过输入管线与命中测试。
- **`page.evaluate` 只读不写**：可用于读状态/诊断；不得绕过交互路径改状态后宣称通过。
- **单测与预览不能替代原生窗口和系统层**：`#[ignore]` 的性能/真机套件不得计为通过。

### 2.2 输入管线与证据边界

- Playwright 的 `locator.click/hover/fill`、`mouse.move/down/up/wheel`、`keyboard.press`
  走浏览器输入管线，通常不移动系统光标，可用于 B/C。
- C 通道必须先识别主窗口：`cdp-main-window.mjs` 按 URL 分类排除 `devtools://` 与
  `context-menu.html`，再用 Tauri 窗口 `label === "main"`、`invoke` 可用、`#root` 已挂载三重
  判定；候选不唯一或超时即明确失败（历史事故：曾把右键菜单辅助窗口当主窗口）。不得取
  「第一个非 devtools 页面」。
- CDP 只连 `127.0.0.1:<port>` 回环地址，不连来路不明的 target；结束关闭 browser 连接、
  调试端口与实例进程。
- `cdp-bridge.mjs invoke` 属于准备条件或读取状态的手段，不是交互证据；交互必须另有 locator
  操作与可观察结果。

### 2.3 现有工具与通道对应

| 工具 | 通道 | 复用方式 |
|---|---|---|
| `npm test` / `npm run build` / `cargo test` / `cargo clippy` | A | 逻辑、契约、迁移、类型；`cargo` 必须在 `src-tauri/` 内执行，且 `cargo test` 需先有 `dist/` |
| `make-preview.mjs` + `serve-preview.mjs` | B | 预热 harness 后由 `visual-*.mjs` / `layout-regression.mjs` 走查 |
| `layout-regression.mjs` | B | 320/340/400/500 × DPR 100%/125%/150% × 预设 × 明暗 × 材质 × 模式的布局矩阵 |
| `cdp-main-window.mjs` | C（前置） | 由 `cdp-bridge.mjs` / `joint-ui-drive.mjs` 内部复用；失败时输出完整枚举记录 |
| `joint-ui-drive.mjs` | C | `--port <p> --out <dir> --cycles <n>` 执行真实点击/填写/导航与计时 |
| `native-cdp.mjs` | C | `CDP_PORT` 默认 9222；附加真实 WebView2 读取控制台/DOM 并截图 |
| 真实 WebView2 的 `role` / `aria-*` / accessibility snapshot | D（当前可用形式） | 结构断言；不能替代像素与几何 |
| `native-verify.ps1` + `corner-lab.ps1` + `check-corners.py` | E | 隔离实例启动、区域回读、可见帧/隐藏基线、桌面合成截图与像素审计 |
| `diagnose-corner.ps1` | E | 四种区域/DWM 组合 × solid/glass 的抓屏矩阵，用于归因 |
| `capture-native.ps1` | E（弱） | `CopyFromScreen` 抓屏；按进程名找窗口，可能命中用户实例，优先用 `native-verify.ps1` |
| `scripts/perf/sampler.ps1`、`memory-probe.mjs`、`ingest-load.mjs` | A + E | 长跑负载 + 进程树资源采样（线程/句柄/内存/CPU） |
| computer-use 物理鼠标/键盘 | F | 需授权后覆盖手感、系统级命中、通知可见性 |

## 三、通道选择决策流程

1. 先写验收目标与失败判据（含非目标）。
2. 判断行为层（见第一章第 2 步）。
3. 选最低干扰通道；能复用现有脚本就不新写。
4. 必要时组合：一个目标多层证据，逐项标注通道与未覆盖边界。
5. 结论只覆盖实测；单通道结果不得外推。

| 验收目标 | 主通道 | 补充通道 | 主要证据 | 不能证明 |
|---|---|---|---|---|
| 纯函数 / 迁移 / 契约 | A | — | 命令、工作目录、退出码、用例数 | 真实渲染与系统行为 |
| 弹窗 hover / 聚焦 | C | A（组件单测）、B（视觉走查） | hover 前后可见性与 `data-tip`、computed style、截图 | 桌面合成、Win32 裁剪与系统级命中 |
| 剪贴板图片预览 | C | A（解码/存储）、E（真实系统剪贴板写入时） | 打开详情后的 `naturalWidth`/像素采样/截图 | 第三方应用中的真实粘贴结果 |
| 胶囊四边吸附 | E | A（区域单测）、F（吸附手感） | 区域回读、区域外像素审计、桌面合成截图 | 真实拖拽手感只能由 F 覆盖 |
| 胶囊展开/收起 | E | A（`useEdgeSnap` 集成测试）、C（Esc/分类切换） | 连续 `GetWindowRgn` 采样、窗口矩形不变、桌面截图 | 页面截图不能证明透明胶囊在桌面上的实际占位 |
| 系统通知 | F | A（通知历史/命令）、D（控件结构） | 桌面实际可见截图、通知控件结构、`notification_history` | CDP 不能证明通知真实展示 |
| 长时间运行资源 | E | A（负载脚本、采样器） | 进程树 RSS/句柄/线程分位、平台期、运行条件 | 单次短采样不得表述为「无泄漏」 |
| 320px 窄窗布局 | B | A（布局与溢出单测） | 截图 + 溢出断言 | 真实 DPI 与原生窗口 |
| 全局热键唤起 | F | A（快捷键逻辑）、E（窗口几何） | 真实按键后的窗口状态与前台结果 | 程序化按键只能证明快捷键路径 |
| DPI 150% 窗口几何 | E | A（物理像素换算单测） | `GetWindowRect` + `GetDpiForWindow` + 区域包围盒 | B 的 `deviceScaleFactor` 只是浏览器模拟 |

## 四、Task Dock 高风险场景判定前提

以下场景的证据标准高于通用版；不满足前提时结论最多「证据不足」，不得降级为通过。

### 4.1 窗口透明合成与 DWM 材质

- **前提**：真实 exe（release/custom-protocol 构建，不能用 `cargo build --release` 代替
  `npm run tauri build` 的产物语义）、独立数据目录、受控纯色置顶背景、可见帧与隐藏窗口后的
  同区域基线各一张。
- **必须**：背景基线先被证明为受控纯色（`check-corners.py` 会先校验，缺基线或背景不受控即
  `UNVERIFIED`）；可见帧用桌面合成抓屏（`CopyFromScreen`），不是 `PrintWindow`。
- **材质**：Mica/Acrylic 是 DWM 系统背景，**不会被 `SetWindowRgn` 裁剪**；角部可能残留系统
  背景，必须检查区域外像素是否存在系统材质痕迹。`TASK_DOCK_GLASS_BACKEND` 可固定后端做对照。
- **固定条件**：显示器布局、DPI、Windows 版本、`preset/theme/material`、窗口矩形；每次改条件
  重新采集，不跨条件复用旧图。
- **硬约束**：「设置材质成功」不等于像素正确；CSS `backdrop-filter` 的计算值不等于合成结果。
- **边界**：E 不证明 CSS 配色与 WebView2 内容细节（由 B/C 补）；B/C 不证明桌面合成与材质。

### 4.2 `SetWindowRgn` 裁剪与圆角

- **前提**：必须同时有 `GetWindowRgn` 回读、`PtInRegion` 采样点、`GetRgnBox`，以及独立的
  背景基线像素审计。
- **必须**：四角区域外像素等于背景；无深色楔形/黑色描边连通块；无 1px 描边外溢与外部阴影；
  实测圆角半径与区域/DWM 读数一致。
- **禁止的伪证**：同一张截图内「窗口角块 vs 窗外块」自比（历史错误：恒等于 0.0 的假通过）；
  仅 `GetWindowRgn` 非 0；仅 `DwmGetWindowAttribute` 返回成功。
- **状态转换必测**：启动阶段 `schedule_reapply`（150/500/1200/2500 ms 多次重算）、拖拽缩放
  （`-ResizeTo <WxH> -ResizeJitter`）、最小化/还原（`-MinimizeCycle`）；每个状态单独采样，
  不得用静止帧代表全过程。
- **资源所有权**：`SetWindowRgn` 成功后 region 归系统所有，不得再 `DeleteObject`；失败时由
  调用方释放，否则泄漏 GDI。长跑场景需检查 GDI 对象趋势；仓库采样器未覆盖 GDI，须标注
  「未覆盖」或另用外部工具补证。
- **归因开关**：`TASK_DOCK_WINDOW_REGION=0`、`TASK_DOCK_WINDOW_DWM_CORNER=0|dontround` 只用于
  隔离变量定位，不能改产品默认行为。

### 4.3 停靠胶囊展开/收起

- **前提**：胶囊区域不是固定矩形，必须按「边 × 折叠/展开 × DPI」分别采集；每次展开、收起、
  切换分类、解除吸附、启动恢复都是独立场景。
- **必须**：
  - 启动后 250 ms 连续采样 `GetWindowRgn`，任何一次都不得出现「包围盒 = 整窗」；存在停靠记录
    时，监控区域写入成功后首帧也不得整窗闪现。
  - 折叠态四边区域、展开态区域、解除后整窗（v0.7 历史记录：折叠左 `0,75,70,450`、右
    `430,75,500,450`、上 `62,0,437,70`、下 `62,535,437,605`，展开左 `0,0,500,525`，解除
    `500×700`；以当次代码重新测量为准，不直接引用旧值）。
  - 区域外像素审计：黑色背景截图，区域外每隔 2 px 采样，必须与背景一致且无近白像素
    （既有做法见 `tmp/acceptance/docked-window-hidden/` 的任务内 `audit.py`）。
  - 展开/收起不得改变窗口外框几何（`useEdgeSnap.integration.test.tsx` 断言；E 侧回读矩形
    佐证）；Esc 只收面板、切换分类不重复展开由 C 验证。
- **硬约束**：CDP 页面截图只覆盖 WebView2 视口，透明胶囊在桌面上的实际占位只能由 E 证明。
- **边界**：真实吸附手感、边缘磁吸与拖拽解除手势只能由 F；系统阴影、多显示器、混合 DPI、
  Windows 10 若未覆盖必须逐项写明。

### 4.4 DPI 与多显示器几何

- **统一物理像素口径**：`GetWindowRect`、`GetRgnBox`、`GetDpiForWindow`、
  `Screen.FromHandle().Bounds` 全部按物理像素记录。前端保存 `outerPosition()/outerSize()`
  是物理像素，`restore_window()` 必须使用 `PhysicalSize`；历史上按逻辑像素还原导致 125% DPI
  每次启动放大 25%。
- **前提**：不得假定固定分辨率（如 2560×1440）；`native-verify.ps1` 默认按
  `Screen.PrimaryScreen.WorkingArea` 定位并留阴影边距。
- **多显示器必测**（在范围内时）：负坐标、每显示器不同 DPI、工作区（任务栏）而非全屏边界、
  跨屏移动/唤回、各边吸附；显示器移除后的恢复若不在本次范围，必须明确列为非目标。
- **禁止的伪证**：B 的 `deviceScaleFactor` 100/125/150 只模拟 CSS 布局，不能证明原生 DPI
  换算、窗口区域物理像素或多显示器工作区。
- **记录项**：显示器布局、主屏 DPI、目标屏 DPI、窗口物理矩形、区域包围盒、测试时的缩放设置。

### 4.5 WebView2 与原生层差异

- **坐标系**：CDP 视口坐标 ≠ 屏幕桌面坐标；WebView2 有自己的缩放与 `devicePixelRatio`；
  页面截图不含窗口圆角、阴影、材质与桌面背景。
- **属性不可跨层读取**：窗口区域、DWM 圆角偏好、Mica/Acrylic 状态只能在 E 回读；CDP 读不到。
- **像素不可跨层推断**：CSS `opacity`、`backdrop-filter`、`transition` 的 computed style 只证明
  CSS 值，最终合成像素必须由 E 证明。
- **交互**：真实点击/键盘用 locator；`dispatchEvent`/`.click()` 不算；`invoke` 只作准备或读取。
- **实例与目标**：主窗口 label 固定 `main`；排除 `context-menu.html`；隔离数据目录可用
  `TASK_DOCK_DATA_DIR`，WebView2 缓存可用 `WEBVIEW2_USER_DATA_FOLDER` 隔离。
- **可访问性**：WebView2 的 UIA 树本质是 DOM 可访问性 + 原生外壳；D 只证明结构，不证明像素、
  几何与命中。

### 4.6 长驻进程资源（句柄/线程/内存）

- **采样对象**：Task Dock 主进程 + WebView2 子进程树；只看主进程 RSS 会漏掉 WebView2 增长。
  `scripts/perf/sampler.ps1` 按进程树输出 `ws_mb`、`private_mb`、`threads`、`handles`、
  `cpu_pct` 与真实采样间隔；线程/句柄是比内存更灵敏的泄漏先行指标。
- **前提**：至少覆盖空闲基线、负载阶段、隐藏/恢复、通知、剪贴板（在范围内）等多个阶段；
  记录采样间隔、总时长、样本数、机器是否空闲、数据目录是否隔离、二进制 sha256 与构建模式
  （可用 `scripts/perf/source-fingerprint.sh`、`module-fingerprint.py`）。
- **结论措辞**：单次短采样不得宣称「无泄漏」；只能写「在 X 条件下未观察到泄漏型增长」，
  并给出平台期或斜率、p50/p95 等分位与样本数。
- **退出与异常**：取消、超时、强杀、退出后进程树必须回收（`quit-under-load.py`、
  `window-lifetime.py`、`fault-injection.py`）；残留进程/句柄记 FAIL 或 `ENVIRONMENT BLOCKED`。
- **未覆盖项**：GDI 对象数、内核句柄类型分布、长时间休眠/唤醒未由仓库脚本覆盖时必须标注。

## 五、低干扰、隔离与零污染

### 5.1 隔离实例

- 数据隔离用 `TASK_DOCK_DATA_DIR`，指向 `tmp/acceptance/<task-name>/...`。设置后应用标识按
  数据目录路径哈希派生为 `{identifier}.iso.{hash}`（`src-tauri/src/lib.rs` 的
  `instance_identifier_for`），单实例互斥锁与通知 AUMID 随之区分；同一目录的两个实例仍互斥。
- WebView2 缓存用 `WEBVIEW2_USER_DATA_FOLDER` 指向任务目录，避免污染用户缓存。
- 构建隔离需用**绝对路径** `CARGO_TARGET_DIR`，并按 `node scripts/build-guard.mjs register`
  登记归属；任务结束用 `cleanup --dir <路径> --execute` 回收，默认 dry-run。
- 不碰正式安装实例与用户数据库；发现其他 `task-dock` 进程只记录 PID，不结束。

### 5.2 会改动系统状态的既有脚本（必须在证据中声明）

| 脚本/操作 | 状态改动 | 约束 |
|---|---|---|
| `corner-lab.ps1` | `SetCursorPos(2,2)` 移开鼠标、`SetForegroundWindow` 抢前台、置顶背景与窗口层级调整 | 属于会改变光标/焦点/窗口层级；同一时间只允许一个会话运行；证据中注明 |
| `capture-native-set.ps1` | `Stop-Process -Force` **结束所有** `task-dock` 进程 | 并行会话期间**禁止使用**；仅在独占时间窗且获授权时使用 |
| 剪贴板验收脚本 | 写入并尝试恢复系统剪贴板 | 记录原值与恢复结果；恢复失败必须写明 |
| `native-verify.ps1` / `corner-lab.ps1` | 启动并结束本次自己创建的实例 | 只结束本脚本启动的进程；不按镜像名批量结束 |

### 5.3 零污染证明清单

- 验收前后各执行一次 `git status`；除本次预期文件外无新增/修改。
- 数据、日志、截图、临时脚本全部在 `tmp/acceptance|debug|experiments/<task-name>/`；
  仓库根与 `docs/` 不新增零散验收文件。
- 隔离数据目录与 WebView2 缓存可整体删除；登记的 `target-*` 按 build-guard 回收。
- 结束时检查：无残留 `task-dock` 进程、无占用调试端口、无遗留 CDP 连接。
- 系统剪贴板恢复原值；未改全局 DPI/缩放、通知权限、系统主题与材质设置。
- 用户前台窗口与光标位置按可行性恢复；未恢复的项写入报告。

### 5.4 并行会话约束（Task Dock 特有）

- 本仓库可能多会话共享同一工作树：所有未提交/未跟踪改动默认属于其他任务，**不还原、不删除、
  不覆盖**。开始与交付前各查一次 `git status`。
- 禁止 `git reset --hard`、`git checkout -- <path>`、`git restore <path>`、`git clean`、裸
  `git stash`；需要暂存只用 `git stash push -u -m <唯一标签>`。
- 不清理他人 `tmp/` 产物、构建缓存、截图与验收报告；发现应清理项只列路径与建议命令。
- **物理操作同一时间只允许一个会话**：真实鼠标/键盘、抢前台、`corner-lab.ps1`、
  `capture-native-set.ps1` 不得与其他会话并发执行。
- CDP 端口先探测空闲再使用；不结束非本会话启动的调试进程与实例。
- 不自动 `git commit`/`push`/打标签/改分支。

## 六、证据六要素与记录格式

### 6.1 六要素（每条可复核结论必含）

1. **命令**：完整可复制命令（含参数与脚本路径）。
2. **工作目录**：仓库根 / `src-tauri/` / 其他；`cargo` 必须在 `src-tauri/` 内。
3. **退出码**：真实退出码；`check-corners.py` 的 0=PASS、1=FAIL、2=UNVERIFIED 需写清语义。
4. **时间**：执行开始/结束时间与时区。
5. **证据路径**：必须真实存在；相对仓库路径，位于 `tmp/acceptance/<task>/` 或长期证据目录。
6. **样本条件**：二进制 sha256、构建模式、Windows 版本、DPI/显示器、`preset/theme/material`、
   数据目录隔离方式；性能另加采样间隔、时长、样本数、机器空闲状态、背景负载。

### 6.2 单条结论写法

`目标 / 通道 / 实际操作 / 可观察结果 / 证据位置 / 未覆盖边界`。示例：

- `Tooltip hover：C / Playwright CDP / PASS（hover 后提示可见，截图 tooltip-20261103.png）/ 未覆盖：桌面合成`
- `胶囊右缘吸附：E / native-verify.ps1 / PASS（区域回读 + 区域外 0 越界）/ 未覆盖：真实拖拽手感`
- `系统通知：F + D / 桌面截图 + UIA / ENVIRONMENT BLOCKED（锁屏）/ 未覆盖：通知实际展示`
- `150% DPI 窗口恢复：E / 未执行（当前会话无 150% 显示器）/ 证据不足 / 未覆盖：多显示器负坐标`

### 6.3 轻量化与脱敏

- 不粘贴整段 DOM/HTML；记录 targetId、URL、窗口 label、计数、耗时、退出码、截图路径即可。
- 截图标注通道：B（harness）、C（WebView2 页面）、E（桌面合成）、F（物理操作），不得混标。
- 不写入剪贴板正文/图片、用户个人路径、密钥；截图裁掉个人内容；证据只保留可复核元数据。

### 6.4 证据清单校验

可按需生成 `tmp/acceptance/<task-name>/evidence.json` 并运行：

```bash
python .agents/skills/taskdock-acceptance/scripts/validate_evidence.py --repo . \
  --manifest tmp/acceptance/<task-name>/evidence.json
```

该校验只验证字段与引用路径存在性，**不证明结论真实**；`NOT_RUN` 不属于通过项。

## 七、性能验收规则

- `#[ignore]` 的性能/真机套件（`ingest_perf`、`actions_perf`、`clipboard_perf`、
  `real_backup_restore` 等）必须单独执行，不得计入普通测试通过数，也不得用历史数字代替。
- 结论必须附可复核条件：二进制 sha256、构建模式（debug/release）、工具链版本、数据目录隔离、
  负载脚本与参数、采样间隔/时长/样本数、机器是否空闲、p50/p95 等分位、证据文件。
- 必须包含空闲基线与负载阶段对照；只看单点峰值或单次短采样不能下结论。
- 强杀/取消/超时/退出后的进程树与数据一致性必须检查；残留资源按 FAIL 或
  `ENVIRONMENT BLOCKED` 处理。
- 措辞只能用「在 X 条件下未观察到泄漏型增长」，不得写「无泄漏」「应该不会泄漏」。

## 八、分级与结论

| 级别 | 定义（Task Dock 语境） | 典型示例 |
|---|---|---|
| **P0** | 数据丢失/泄漏、安全泄露、崩溃、核心流程不可用 | 用户数据库被覆盖、剪贴板正文入日志、主窗口无法启动、Agent 管线丢事件 |
| **P1** | 主要功能错误或严重仓库/数据风险且无合理绕行 | 停靠后窗口不可见、恢复窗口几何错位、备份 manifest 不兼容、共享工作树被破坏 |
| **P2** | 边界错误、次要缺陷、文档与实现不一致 | 某 DPI 下圆角残留、窄窗溢出、设置键文档过期 |
| **P3** | 体验、格式、低风险改进 | 提示文案、间距、非关键动画 |

- 结论只能用 **通过 / 部分通过 / 不通过 / 证据不足**。
- `ENVIRONMENT BLOCKED` 单列阻塞项，不并入通过，也不折算为失败代码缺陷。
- 通过率分母不含 `NOT_RUN` 与 `BLOCKED`；未执行项必须逐条列出。
- 无证据的问题最多标「待确认」，不得凭推测定级。

## 九、验收产物管理

- 任务级产物统一放 `tmp/acceptance/<task-name>/`（短横线英文，一任务一目录）；调试/实验分别用
  `tmp/debug/<task-name>/`、`tmp/experiments/<task-name>/`；`tmp/` 已被 `.gitignore` 忽略。
- 任务报告写 `tmp/acceptance/<task-name>/report.md`，字段按 [AGENTS.md](../AGENTS.md) 第 10 章。
- 长期证据归档到 `docs/screenshots/`、`docs/performance/results/`、`docs/clipboard/evidence/`，
  并更新对应索引；新增文件带日期，不覆盖历史验收资料。
- 推翻历史结论时保留旧文件，新增带日期的更正记录。
- 不把用户数据库、剪贴板正文/图片、密钥、个人路径写入可提交文件。

## 十、交付前自检清单

- [ ] 任务范围与非目标已写明，未超范围改动。
- [ ] 开工前与交付前各执行一次 `git status`，只含本次预期改动。
- [ ] 每条结论都有「通道 + 操作 + 可观察结果 + 证据路径 + 未覆盖边界」。
- [ ] 六要素齐全（命令、工作目录、退出码、时间、证据路径、样本条件）。
- [ ] `PASS/FAIL/BLOCKED/NOT_RUN` 与四态结论一致；`BLOCKED` 未计入通过。
- [ ] 未执行项明确写「未执行」，没有用历史输出或推测替代。
- [ ] 截图按 B/C/E/F 正确标注；原生结论附独立背景基线与采集条件。
- [ ] 性能结论附采样条件、样本数与分位，措辞未夸大为「无泄漏」。
- [ ] 隔离数据目录、WebView2 缓存、登记构建目录已清理或给出回收命令。
- [ ] 无残留进程/端口/CDP 连接；剪贴板与前台状态已恢复或已记录。
- [ ] 报告字段齐全、P0–P3 有证据、结论为四态之一。
- [ ] 未提交、未推送、未执行破坏性 Git 操作；无敏感数据进入可提交文件。

## 十一、禁止事项

- 伪造测试结果、真机验证、性能数据或截图；用「应该/理论上」替代证据。
- 用 Mock、预览截图、CDP 页面截图冒充真实运行或桌面合成。
- 用 `GetWindowRgn`/设置命令成功冒充像素正确；用 `PrintWindow` 冒充窗口背后透出。
- 用 `dispatchEvent()`/DOM `.click()` 冒充真实交互；用 `page.evaluate` 改状态后宣称通过。
- 在共享实例或用户数据上做破坏性验收；结束非本会话启动的进程。
- 清理他人 `tmp/`、构建缓存、证据；执行 `git reset --hard`、`git clean`、`git checkout --`、
  `git restore`、裸 `git stash`。
- 自动 `git commit`/`push`/打标签；把剪贴板正文、密码、令牌、个人路径写入证据。
- 改全局 DPI/缩放、通知权限、系统主题与材质设置来「凑」通过。
- 把 `UNVERIFIED`、`NOT_RUN`、`#[ignore]` 结果计为通过。

## 十二、环境阻塞与回退

- 锁屏、前台锁拒绝、权限不足、磁盘写满、exe 被并行实例占用（如 `os error 5`）、调试端口被占、
  无目标 DPI/显示器，记 `ENVIRONMENT BLOCKED`，不标记通过，也不臆断为代码缺陷。
- 回退顺序：C 调试端口不可用 → B/A 并写明缺口；E 无法启动真实实例 → 只保留 A 并写「未验证」；
  D 无稳定脚本 → 用 C 的结构断言并写明「原生 UIA 未覆盖」；F 未获授权 → 不执行，不把其他
  通道结果冒充物理层。
- 同条件复跑结果一并保留；推翻历史结论时保留旧记录并新增带日期的更正。
