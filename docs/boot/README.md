# 启动体验（Boot Experience）— 状态机与事件协议 V1

> 2026-11-12 落地 V1。任务级验收记录见 `tmp/acceptance/startup-experience-v1/`（不入库）；
> 本文是长期契约，修改任何一方实现前先改本文并同步对方文件。

## 1. 目标与组成

正常启动尽可能不显示启动占位；慢启动显示工作区骨架屏；超时提供「继续等待 / 重新加载 /
复制诊断」；致命失败提供错误恢复界面。由三部分组成：

| 部分 | 文件 | 职责 |
|---|---|---|
| 看门狗（经典脚本） | `public/boot/boot-watchdog.js` | 状态机、计时器、错误捕获、诊断直写、恢复按钮接线（先于模块脚本执行） |
| TS 镜像 | `src/boot/bootProtocol.ts` | React 侧类型化入口 `bootStage/bootReady/bootFail`（API 缺失 no-op 安全） |
| 占位界面 | `index.html` | 主题提示读取器、四态 DOM/CSS、死人在场保险、role 翻转 |

## 2. 状态机（`#boot-splash[data-state]`）

| 状态 | 进入条件 | 界面 |
|---|---|---|
| `boot` | 0ms | logo + spinner + 状态行 |
| `slow` | ≥4s 未 ready | 工作区骨架屏（导航位 + 列表占位，无假内容/百分比） |
| `timeout` | ≥15s 未 ready | 恢复卡：继续等待（主）/ 重新加载 / 复制诊断信息 + 数据安全说明；骨架屏垫底 |
| `error` | 入口 script/link 资源加载失败（modules 阶段前）或显式 `fail()` | 恢复卡：原因 + 重新加载 / 复制诊断信息；骨架屏隐藏 |
| 移除 | `ready()` | 160ms 淡出后 DOM 移除 |

规则：阈值 `SLOW_MS=4000` / `TIMEOUT_MS=15000`（watchdog 与 bootProtocol.ts 跨文件由
`src/test/bootSplash.test.ts` 锁一致）；「继续等待」回 `slow` 且不再重设 15s 计时器；
重新加载只由用户点击触发（`location.reload()`），**禁止任何自动刷新/重试循环**；
计时器全局仅一对，ready/error 清空。

## 3. 就绪语义（不看出错修正）

- **「`#root` 有子元素」不是就绪**（设置加载门 ShellBootState 期间工作区未就绪，V0 缺陷）。
- 阶段信号（只记时间不写诊断）：`modules`（main.tsx 开始执行）→ `mounted`（render 发起）
  → `settings`（设置读取落定）。
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
React 侧既有诊断（ErrorBoundary/globalErrors）不变。复制诊断内容只含耗时/阶段/错误摘要/UA。

## 7. 已知边界

- 预 React 占位文案为 zh-CN（无 i18n 管道，已知限制）。
- Edge/WebView2 在 `prefers-reduced-motion: reduce` 下平台级钳制动画时长（实测 0.01ms），
  spinner 实际静止；CSS 的 3s 减速仅对不钳制的引擎生效。
- 真机（custom-protocol）路径、真实 `diagnostics_record` 落库需按验收路由 C/E 通道人工验证。
