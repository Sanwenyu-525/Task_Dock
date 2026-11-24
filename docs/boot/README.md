# 启动体验（Boot Experience）— 状态机与事件协议 V1

> 2026-11-12 落地 V1。任务级验收记录见 `tmp/acceptance/startup-experience-v1/`（不入库）；
> 本文是长期契约，修改任何一方实现前先改本文并同步对方文件。

## 1. 目标与组成

正常启动尽可能不显示启动占位；慢启动显示工作区骨架屏；超时提供「继续等待 / 重新加载 /
复制诊断」；致命失败提供错误恢复界面。由三部分组成：

| 部分 | 文件 | 职责 |
|---|---|---|
| 看门狗（经典脚本） | `public/boot/boot-watchdog.js` | 状态机、计时器、错误捕获、诊断直写、恢复按钮接线（先于模块脚本执行）；资源/CSP/入口脚本采样与动态导入状态机（2026-11-19 补） |
| TS 镜像 | `src/boot/bootProtocol.ts` | React 侧类型化入口 `bootStage/bootTiming/importState/bootReady/bootFail`（API 缺失 no-op 安全） |
| 主窗占位界面 | `index.html` | 主题提示读取器、四态 DOM/CSS、死人在场保险、role 翻转 |
| 工作台占位界面 | `workspace.html` | 同一份看门狗的第二个宿主：主题提示、四态 DOM/CSS、死人在场保险、role 翻转（2026-11-17 补） |
| 工作台启动隔离 | `src/workspace/bootstrap.ts` | 极轻量入口（零业务静态依赖），记录 bootstrap/main-import 阶段，动态 `import("./main")` 并捕获 rejection（2026-11-19 补） |

### 1.1 工作台窗口（2026-11-17）

工作台窗口（`workspace` label）由 Rust 隐藏创建，前端 8s 内未就绪会被强制显示
（`project_workspace_window.rs` 的 `STARTUP_REVEAL_TIMEOUT`）。此前 `workspace.html`
只有一个 `#root`，React 挂载前窗口是纯白，主线程被阻塞时用户只能看到标题栏的
「(未响应)」，没有任何启动/超时提示。现按同一协议补齐：

- 静态占位在模块脚本之前渲染「正在恢复工作台…」，4s 转「加载稍久」，15s 显示恢复卡
  （继续等待 / 重新加载 / 复制诊断信息）；诊断记录同 §6。
- 就绪判据：`WorkspaceApp` 在设置落定（`settings !== null || loadError !== null`）后
  调用 `bootStage("settings")` + `bootReady()`；失败时外壳的 `wb-boot` 错误卡接管渲染。
- 看门狗、20s 死人在场保险与 role 翻转规则与主窗口一致；工作台入口的 `main.tsx`
  补 `bootStage("modules")` / `bootStage("mounted")` / 同步抛错 `bootFail`。
- **启动隔离（2026-11-19）**：入口链改为 `boot-watchdog.js → bootstrap.ts → 动态
  import("./main")`。此前直接加载 `main.tsx`，整个静态图（163 文件 / 455 import 边）
  下载解析完成前没有任何阶段信号，诊断只能显示「模块脚本尚未执行」。bootstrap
  不静态导入 React/外壳/页面，入口一执行即记录 `bootstrap-start`、`main-import-start`，
  resolve/fail 记 `main-import-resolved`/`main-import-failed`；失败调用 `fail()` 写
  `UI_BOOT_FATAL`。生产构建中入口 chunk 仅 ~1.7KB，main 保持独立动态 chunk。
- 阶段细化：`main.tsx` 对 `setWindowHostRole`/`installFeatureRegistry`/
  `installNativeDragBridge`/`initLocale`/`initWorkbenchWindowFrame` 分别记
  `init:<fn>:start`/`:end` 与耗时（`state.timings`），另记 `react-root`。所有时间取自
  watchdog 的单一 `performance.now()` 时间轴，不混用 `Date.now()`。


## 2. 状态机（`#boot-splash[data-state]`）

| 状态 | 进入条件 | 界面 |
|---|---|---|
| `boot` | 0ms | logo + spinner + 状态行 |
| `slow` | ≥4s 未 ready | 工作区骨架屏（导航位 + 列表占位，无假内容/百分比） |
| `timeout` | ≥15s 未 ready | 恢复卡：继续等待（主）/ 重新加载 / 复制诊断信息 + 数据安全说明；骨架屏垫底 |
| `error` | 入口 script/link 资源加载失败（modules 阶段前）或显式 `fail()` | 恢复卡：原因 + 重新加载 / 复制诊断信息；骨架屏隐藏 |
| 移除 | `ready()` | 160ms 淡出后 DOM 移除 |

规则：阈值 `SLOW_MS=4000` / `TIMEOUT_MS=15000`（watchdog 与 bootProtocol.ts 跨文件由
`src/test/bootSplash.test.ts` 锁一致）；「继续等待」保持 `timeout` 恢复卡，更新等待说明，
保留「重新加载 / 复制诊断」入口，且不再重设 15s 计时器（2026-11-19 修复：回到 `slow`
会隐藏恢复卡，导致提示中的恢复操作无法访问）；
重新加载只由用户点击触发（`location.reload()`），**禁止任何自动刷新/重试循环**；
计时器全局仅一对，ready/error 清空。

## 3. 就绪语义（不看出错修正）

- **「`#root` 有子元素」不是就绪**（设置加载门 ShellBootState 期间工作区未就绪，V0 缺陷）。
- 阶段信号（只记时间不写诊断，首见为准）：`bootstrap-start` → `main-import-start` →
  `main-import-resolved`/`main-import-failed` → `modules`（main.tsx 模块主体开始执行，
  不再是「加载开始」）→ `init:<fn>:start`/`:end` → `react-root` → `mounted`（render 发起）
  → `settings`（设置读取落定）→ `ready`（bootReady）。`modules` 语义已收窄，加载阶段的
  细分由 bootstrap 阶段 + watchdog 资源采样覆盖。
- 动态导入状态机 `state.mainImport`：`not-requested → requested → pending →
  resolved/rejected`，禁止回退。区分「请求在途（pending）」与「从未请求」。
- `ready()`：设置落定（成功 → 工作区；失败 → ShellBootState 重试 UI）或 ErrorBoundary
  接管渲染时由 React 侧调用；幂等。
- `fail()`：仅 React 无法渲染的致命失败（main.tsx 同步抛错、入口资源加载失败）。

## 4. 双保险防「占位永久遮挡」

1. `bootReady()` 在 watchdog API 缺失时直接移除 `#boot-splash`；
2. index.html 内联「死人在场」检查：20s 后无 `window.__TASK_DOCK_BOOT__` → 强制移除。

## 5. 主题提示镜像（防主题闪烁）

- localStorage 键 `taskdock.boot-theme`：`{"theme":"light|dark","preset":"frosted|dream-gradient"}`
  （解析后值，绝不存 `system`），由 `useSettingsStore` 的 `applyThemeToDom`/`applyPresetToDom`
  落 DOM 时写入（try/catch 全包）。
- index.html `<head>` 读取器（先于占位样式）白名单校验后设 `documentElement.dataset`；
  首次运行（无镜像）按系统偏好，属预期。

## 6. 诊断记录（各至多一次）

| 记录 | 时机 | 级别/错误码 |
|---|---|---|
| `boot_timeout` | 15s 未 ready 立即写（保「模块根本没执行」可见性） | WARN `UI_BOOT_TIMEOUT` |
| `boot_slow` | ready 终态且耗时 ≥4s 或有捕获错误 | WARN `UI_BOOT_SLOW` / ERROR `UI_BOOT_ERROR` |
| `boot_fatal` | 显式 fail() 或入口资源加载失败 | ERROR `UI_BOOT_FATAL` |

watchdog 经 `__TAURI_INTERNALS__.invoke("diagnostics_record")` 直写，不经 React 管道；
React 侧既有诊断（ErrorBoundary/globalErrors）不变。

### 6.1 诊断采样（2026-11-19）

为定位「模块脚本尚未执行」，watchdog 额外采集（全部限量、限长、同源过滤、去 query，
不记录任务正文/文件路径/凭证，字段容错）：

- **资源请求**：`performance.getEntriesByType("resource")` 快照 + `PerformanceObserver`
  增量；每条形如 `resourceName/initiatorType/startTime/duration/responseStatus/
  transferSize/decodedBodySize`。`responseStatus` 等字段在运行时不支持时为 null。
  `pendingExpected()` 列出首屏关键资源（`@vite/client`/`bootstrap.ts`/`main.tsx`）中
  尚未出现在采样里的项——表示「请求在途/未见完成」，不能当成没请求。
- **CSP**：监听 `securitypolicyviolation`，记 `blockedURI/violatedDirective/
  effectiveDirective/sourceFile/lineNumber`。**只记录不放宽 CSP**，`devCsp` 的修改必须
  有实际拦截证据。
- **入口脚本事件**：捕获阶段的 `load`/`error`，区分入口资源加载成功与失败。
- **富错误**：动态导入失败记录错误 name/message/stack，stack 去 query、绝对路径压成
  basename、限 6 行 800 字符后随 `UI_BOOT_FATAL` 上报。
- `boot_timeout` 的 metadata 附 `mainImport`/资源计数/失败数/pending 关键资源/CSP 数/
  阶段摘要，`boot_fatal` 附 errorName/错误栈，便于诊断中心离线分析。

### 6.2 复制诊断格式（固定）

```
Task Dock 启动诊断
状态: / 总耗时: / 页面 URL: / 页面标题: / WebView UA: / document.readyState:
Bootstrap: / Main import: / Main module: / React root: / React mounted:
Settings settled: / Workbench ready:
初始化函数耗时: / 资源请求总数: / Pending 请求: / 失败请求: / CSP 拦截:
捕获错误: / 最近资源请求:
```

资源、错误、栈均限长，避免诊断内容过大。

## 7. 已知边界

- 预 React 占位文案为 zh-CN（无 i18n 管道，已知限制）。
- Edge/WebView2 在 `prefers-reduced-motion: reduce` 下平台级钳制动画时长（实测 0.01ms）；
  CSS 层同样显式停用 spinner 旋转、骨架屏流光与恢复卡位移（见 §9.4），不依赖引擎钳制。
- 真机（custom-protocol）路径、真实 `diagnostics_record` 落库需按验收路由 C/E 通道人工验证。

## 8. Dev 冷启动依赖加载（2026-11-19）

排查时观察到 bootstrap 已执行，但 main 动态导入长时间处于 pending，无模块错误/CSP 拦截。
当前安装的 Vite 7 在裸导入解析中等待 `scanProcessing`，
因此仅设置 `holdUntilCrawlEnd: false` 仍无法绕过多页面业务图的依赖扫描。

`vite.config.ts` 改为 `optimizeDeps.noDiscovery: true`，显式预构建 React（包括 DOM 与 JSX
运行时）、Lucide、Floating UI 与 Zustand。Tauri API/插件及 PDF.js 是 ESM，按真实访问加载；
不为首屏主动下载 PDF。新增 CommonJS 依赖时必须检查并更新 `optimizeDeps.include`，否则浏览器
无法直接执行。参见 [Vite 依赖预构建说明](https://vite.dev/guide/dep-pre-bundling) 与
[配置契约](https://github.com/vitejs/vite/blob/v7.1.0/docs/config/dep-optimization-options.md)。

预热仅保留零业务静态依赖的 `workspace/bootstrap.ts`；不同时预热全部窗口与业务图。
桌面 watcher 忽略移动端目录、`tmp/`、`dist`/`dist-*` 与 `.preview*` 产物，防止大量缓存扫描
争抢文件读取，以及 Android 生成 `problems-report.html` 时触发桌面整页重载。
这些配置不改变生产构建、页面注册或后台服务生命周期。修改配置后需确认 Vite 实际完成重启；
再次执行 `npm run tauri dev` 只唤醒已有实例时，不能当作重新编译或冷启动验证。

如果 React 已就绪但原生进程仍无响应，还需核查窗口层。2026-11-20 已确认并修复阴影
同步持锁重入导致的主线程自锁，影响启动揭示、最小化恢复与热重载；调用栈、修复和真实
Debug 复测见 [原生阴影死锁记录](../development/2026-11-20-startup-shadow-deadlock.md)。

## 9. 启动占位布局契约（2026-11-24）

两个宿主（`index.html` 主窗口 / `workspace.html` 工作台窗口）共用同一份布局样式块，
夹在 `boot-splash-shared:begin` … `boot-splash-shared:end` 两行注释之间，由
`src/test/bootSplash.test.ts` 逐字比对锁一致。共享块之外只允许各文件保留自己的 Token 区与
业务文案（主窗「正在启动…」/工作台「正在恢复工作台…」），不得再出现「一个窗口修了、
另一个没修」的漂移。

### 9.1 安全居中与纵向溢出

- `#boot-splash` 用 `position: fixed; inset: 0`（不依赖 `100vh/100dvh`，规避 WebView2 在
  Windows DPI 缩放下的动态视口口径差异）+ `justify-content: flex-start`。
- 居中交给内层 `.boot-stack { margin-block: auto }`：内容矮时自动居中；内容高于视口时
  `auto` 收敛为 0，自动变成**贴顶 + 可滚动**，不再把顶部 Logo/标题裁掉。`padding-block: 6px`
  保证焦点环不被滚动容器裁切。
- 滚动：`overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  scroll-padding-block: 10px`；父级留白 `padding: clamp(10px, 3vmin, 24px)`。
- 恢复卡 `#boot-recovery { width: 100%; max-width: 420px }`：父级负责左右安全留白，
  卡片不再用 `calc(100% - 48px)` 重复扣减同一份间距（原先窄窗下二次扣减，卡片宽度被吃成一条）。
- `#boot-skeleton` 固定在视口垫底（`position: fixed`），不随恢复卡滚动；`error` 态隐藏。

### 9.2 短高度四档（按内容可见性分段，不按「删操作」分段）

| 档位 | 处置 |
|---|---|
| ≤430px | 压缩 logo/字号/卡片内距，按钮 `min-height: 30px` |
| ≤260px | 隐藏纯装饰徽标与数据安全说明；`.boot-card-actions { order: 1 }` 让三个操作紧跟标题；详情限高 44px |
| ≤200px | 外边距 8px；`.boot-intro` 转横向紧凑一行；骨架屏只留关键行；详情限高 34px |
| ≤150px | 按钮 `min-height: 24px`，字号 11/标题 12，详情限高 26px |

264×112（窗口点击区下限）实测：卡片 248×94、三个恢复按钮同屏可见、外层 6px 纵向滚动可及、
Tab 序列包含可滚动详情区与全部按钮。**任何档位都不得隐藏核心操作**（继续等待 / 重新加载 /
复制诊断信息）。`error` 态只留「重新加载 / 复制诊断信息」属既有状态机语义（fatal 时继续等待
无意义），不是为省空间的折衷。

### 9.3 长内容与焦点

- `.boot-card-detail` 保留完整错误文本：`max-height: 88px` + `overflow-y: auto` +
  `overflow-wrap: anywhere`，删除 `-webkit-line-clamp`（长路径/长堆栈必须能读全、能选中复制）。
- 可滚动区域会进入 Tab 序列，故补 `:focus-visible` 描边，避免 Chromium 默认黑框。
- 按钮允许换行（`white-space: normal`）、`min-height` 保命中区、`max-width: 100%`。

### 9.4 骨架屏与动态效果

- `slow` 态骨架屏是**中性布局占位**：无假任务数据、无伪造百分比，只留结构块。主窗与工作台
  语义一致（工作台此前缺失，本次补齐），颜色走各自的 `--boot-sk-*` Token（浅/深两套），
  不借用业务 Token。极小窗口可简化骨架屏（≤200px 只留首屏关键行）。
- `prefers-reduced-motion: reduce`：spinner 与骨架屏流光 `animation: none`（流光的静态底透出）、
  恢复卡 `boot-rise` 位移取消（用同特异性后置选择器压 `timeout`/`error`），状态切换只留
  颜色/边框的静态反馈。§7 里「3s 减速旋转」的描述已作废。

验收脚本：`tmp/acceptance/boot-home-responsive/boot-splash-shots.mjs`（2 宿主 × 6 尺寸
（264×112 / 280×140 / 340×280 / 400×380 / 400×560 / 960×600）× 4 状态 × 明暗 = 96 组合，
截图与诊断 JSON 同目录 `shots/`）。

