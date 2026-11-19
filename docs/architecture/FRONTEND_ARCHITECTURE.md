# 前端架构（FRONTEND ARCHITECTURE）

| 项目 | 内容 |
|---|---|
| 文档状态 | 生效（Phase 1，待评审） |
| 最后更新 | 2026-11-19 |
| 适用范围 | 桌面前端 `src/`（含 workspace/workbench 窗口） |
| 上级 | [目标架构](TARGET_ARCHITECTURE.md) |
| 事实依据 | [当前架构审计](CURRENT_STATE_AUDIT.md) §2.1/§3.1/§4.1 |

---

## 1. 分层职责（前端）

| 层 | 职责 | 禁止 |
|---|---|---|
| Components | 展示与用户交互 | 不执行复杂业务流程、不直接写 SQL、不直连系统 API（窗口行为除外） |
| Hooks | React 生命周期、交互状态、UI 层逻辑 | 不承载跨页面业务编排（那是 service） |
| Services | 用例编排（复杂功能才有） | 不持有 UI 状态 |
| Store | 共享状态、缓存、状态订阅 | 不成为所有业务逻辑的集中地；不直接依赖其他业务 store（用 service 协调） |
| API/Bridge | 类型化 IPC 与通信 | 不散落在组件里直连 `invoke` |
| Domain/models | 纯业务规则与模型 | 不 import React、Tauri |
| Platform | 操作系统与 Tauri 能力适配 | 不被业务层直接 import 内部实现 |

## 2. 按需加载（强制规范，继承现有机制）

- 页面代码**只能**经 `src/lib/featureRegistry.ts` 登记（`load: () => import(...)` 静态字面量），由 `FeatureView` 首次可见时加载。导航/外壳不得静态 import 页面。
- **禁止** `React.lazy`：失败 Promise 会被永久缓存无法重试；用 `featureRuntime` 的 `loadFeature/retryFeature`。
- 页面隐藏必须停自己的轮询/订阅：`useFullViewVisible()`（工作台内认路由）/ `useWorkbenchPageActive()`。只判 `document.hidden` 不够。
- 策略：有草稿/编辑态 → `instance: "keep"`；只读工具页 → `"release"`（筛选会重置）。`preload: "idle"` 只允许 1 个（`page:tasks`），其余最多 `hover`。由 `registry.test.ts` 锁定。
- 量具：`node scripts/on-demand-audit.mjs dist`（modulepreload 闭包 + gzip）。
- 默认页 tasks 静态加载属既有例外，需在 `featureRegistry.ts` 注释中保持显式声明。

## 3. IPC 边界（前端侧）

- 唯一主出口：`src/lib/bridge.ts`。组件、store、hooks 一律经它调后端命令。
- 现有 4 条出口的收敛计划：
  - `workbench/creative/ipc.ts`：保留为"受控例外"，但必须补 `CommandContracts` 类型 + 注释说明为何不进 bridge；Phase 3 评估并入。
  - `lib/widgets/desktopBridge.ts`：窗口/微件命令，归入 `platform/tauri/`，仍经统一契约。
  - `lib/dragCursorSession.ts`、`workbench/windowFrame.ts`：逐个评估，业务命令归并 bridge，窗口几何归并 platform。
- 前端直连 Tauri API 的**合理例外**（无需封装）：窗口生命周期/几何（`getCurrentWindow`/`cursorPosition`/`currentMonitor`/`PhysicalPosition`）、应用元信息（`getVersion`）、文件 URL（`convertFileSrc`）、拖放 webview（`getCurrentWebview`）。这些是 UI 窗口行为，不强行塞进巨大适配器。
- 统一契约目标：`invokeCommand<TCommand extends keyof CommandContracts>(command, args): Promise<result>`；`subscribeEvent<T>(event, handler): Promise<Unsubscribe>`。详见 [IPC_ARCHITECTURE.md](IPC_ARCHITECTURE.md)。

## 4. 状态管理规范

- **Store 职责收敛**：`useFilesWorkspaceStore`(1480)、`useShelfStore`(1166)、`useNotesStore`(874)、`useClipboardStore`(846) 中的业务逻辑（数据获取、监听、持久化、领域规则）逐步下沉到 services，store 只留状态与简单 setter。
- **Store 间耦合治理**：`useGlobalSearchStore` 组合 4 个 store 的模式改为独立检索 service 聚合数据；`usePlanningStore`/`useActionsStore`/`useAgentOnboardingStore`/`useHotkeysStore` 的跨 store 依赖改为事件或服务注入，避免隐式耦合。
- **层次倒置修复**：`lib/errorReport.ts` 不得 import `store/useUiStore`；改为错误事件上抛，由 app 层决定如何提示。
- 组件卸载后异步任务必须处理；避免重复请求、重复订阅、过期响应覆盖新状态。

## 5. UI 与样式约束（继承 AGENTS.md §6）

- 复用 `src/components/ui/` 基元与语义 Token（`styles-themes.css` / `styles-ui.css`），不硬编码颜色/圆角/阴影，不新增平行组件。
- `html[data-preset|data-theme|data-material]` 三正交维度；组件 CSS 只引用语义变量。材质用实际生效值 `materialInfo.resolved`。
- 新弹层接入 `src/lib/overlayStack.ts`，一次按键只关一层；图标按钮有 `aria-label`，提示用 `data-tip`。
- 覆盖深/浅主题、两套视觉预设、320/400 窄窗、不同 DPI；长文本截断或换行（`-webkit-line-clamp` 必须与 `overflow:hidden` 同声明）；尊重 `prefers-reduced-motion`。
- 性能红线：轮询/订阅不重复，窗口隐藏不重复全量刷新，IPC 高频通信合并或节流。

## 6. 大型 UI 组件拆分原则（Phase 4）

以 `FilesWorkspacePanel.tsx`(2847)、`ClipboardWorkspace.tsx`(2019)、`AgentPanel.tsx`(2839)、`WorkbenchShell.tsx`(2646) 为重点。拆分时每个新文件必须明确：

- 组件负责什么、Hook 负责什么、Service 负责什么、Store 负责什么；
- 数据从哪里来、状态由谁拥有、组件卸载时释放什么；
- 不得把业务逻辑简单搬进更多 Hook 形成新职责混乱（这是"换一种方式的混乱"，不是重构）。

## 7. 测试要求

- 组件测试用 `@testing-library/react`；service/domain 用纯 vitest。
- 按需加载回归：`registry.test.ts` + `on-demand-audit.mjs`。
- 视觉/真机（不替代）：`scripts/serve-preview.mjs` 走查；窗口/通知/剪贴板/DPI/贴边必须原生验收。
