# Agent Skill 路由（Task Dock）

本文件是根 [AGENTS.md](../AGENTS.md) 第 6 节的展开，只回答「做某类开发任务时该读哪个 Skill、
边界在哪」。**项目规范优先**：`docs/ui-themes/`、`docs/mobile/`、根 `AGENTS.md` 的约束高于任何
Skill 建议；Skill 是开发工具指导，不是产品运行时能力，也不替代真机验收。

## 1. 使用机制

- **UI 变更先查 Skill。** 先查看本 Agent 已发现的 Skills 清单：公共来源
  `%USERPROFILE%/.agents/skills`，项目本地在 `.agents/skills/`。普通任务只查相关条目，不反复
  全盘扫描。
- **实际读取匹配的 `SKILL.md`**，按其真实 description、When to Apply 与适用流程执行；不得仅凭
  名称宣称已使用。不适用时说明原因并跳过；文件不完整或不可访问时报告具体问题，不能假装加载
  成功。
- **按任务组合，不要求全部加载。** 相似 Skill 选一个主 Skill，其余只补充本次检查；
  `impeccable` 的 audit / polish 等是子命令，不是独立 Skill。
- 纯后端、数据库、API 或仅文档修改：不强制前端 Skill，按内容选择。

## 2. 按任务路由

| 开发任务 | 优先读取的 Skill ID / 使用边界 |
|---|---|
| 新增页面、重新设计 UI | `frontend-design` + `ui-ux-pro-max`；设置、资源、规划等工作台页也可用 `impeccable` 作主设计 Skill |
| 现有页面视觉精修 | `impeccable`（polish / critique）；仅在适用页面加入 `design-taste-frontend` |
| 排版、间距、颜色、视觉层级 | `ui-ux-pro-max` + 适用的 Taste；产品 UI 可用 `impeccable` typeset / layout |
| Tooltip、Popover、右键菜单、悬浮层 | `impeccable`；涉及动效再加入 `emil-design-eng` / `animate` |
| 加载、切换、展开收起、过渡动画 | `animate`；审查现有动效用 `review-animations`，性能问题用 `animation-performance` |
| Agent 过程态、完成态、状态转换 UI | `impeccable` + 适用的 Emil 动效 Skill，保留既定业务状态语义 |
| React 组件开发、重构、性能优化 | `vercel-react-best-practices`，只应用当前 React/Vite/Tauri 栈适用条目 |
| Web 交互、无障碍和界面规范检查 | `web-design-guidelines`；按其要求读取当前规则来源 |
| 完整前端页面交付 | 一个主设计 Skill + React Skill + UI 审查 Skill；动态交互增加动效及状态过渡检查 |
| 验收、性能审计、整改提示词 | 项目本地 Skill 优先：`taskdock-ui-acceptance`（视觉/原生窗口专项）、`taskdock-acceptance`（功能链路与回归）、`taskdock-performance-audit`（常驻资源）、`taskdock-remediation-prompt`（仅生成提示词） |
| 浏览器操作、网页任务 | Task Dock 自身 UI 走查/验收走项目通道（`scripts/serve-preview.mjs` + Playwright、CDP 真机），不用 `ego-browser` 替代，也不因其 description 自称默认而优先选用；通用外部网页任务可用 `ego-browser`（宿主机真实执行、非沙箱，遵守根 AGENTS.md 的数据边界） |
| 移动端新增页面/视觉/动效 | 先读 `apps/mobile/AGENTS.md` 第 7 节；再按上表选 `frontend-design` / `ui-ux-pro-max` / `impeccable` / `animate`，只取适用于 Flat、touch-first 的原则 |
| 移动端 Expo/RN 能力 | `expo-native-ui`、`expo-design-system`、`expo-project-structure` 等 `expo-*` Skill，只读当前栈适用条目 |

## 3. 使用边界

- **项目规范优先于 Skill。** 视觉与交互先遵循 [docs/ui-themes/](ui-themes/)（设计规格、交互
  规范、组件 API、胶囊重设计）与根 AGENTS.md 第 4/6 节红线：语义 Token、`overlayStack.ts`
  层级、`data-tip`/`aria-label`、320/400 窄窗与 DPI 覆盖。
- `design-taste-frontend` 以当前版为准（含 dashboard/settings 等 app-screen 专门流程），v1 仅在
  需要保持旧版行为时显式使用。
- Skill 不得推翻用户要求、确认的参考图、既有交互约束或 Token 体系，不得另造设计语言；候选
  Skill 只有资源完整且适用时才可使用。
- **精修不改契约。** 视觉精修不得无故修改业务逻辑、状态语义、测试选择器或 API；贴边吸附、
  拖拽、DPI、多显示器、系统剪贴板等原生窗口行为按 [docs/ACCEPTANCE_ROUTING.md](ACCEPTANCE_ROUTING.md)
  验收，Skill 指导与浏览器预览截图不能替代原生证据。
- UI 改动至少完成一次适用的设计规范检查；动态交互增加动效/状态检查，React 行为增加工程质量
  检查。

## 4. 跨 Agent 共享

- Codex、ZCode 等不同工具的全局 Skill 目录可能不同，不得假设沿用自己的目录；以公共来源与
  项目本地 `.agents/skills/` 为准。文件可读、自动发现、实际调用分开记录。
- 不同步、不覆盖他人 Skill 目录；确需同步先 dry-run，同名异版先比较并备份，不静默覆盖。

## 5. 维护

新增或替换 Skill 时只改本文件的路由表，并在提交说明中写明适用任务与边界；根 `AGENTS.md`
不维护具体 Skill 清单。路由变化涉及项目规范时，先改 `docs/ui-themes/` 或 `apps/mobile/AGENTS.md`，
再同步本文件。

## 6. 前端指南按需检索（modern-web-guidance / chrome-extensions）

两个技能装在**用户级** `C:\Users\ASUS\.agents\skills\`，不提交进仓库；换机器缺失时退化为
`npx -y modern-web-guidance@latest search "<query>"`。上游 `description` 要求「所有 HTML/CSS 任务
MANDATORY 先查」并输出 `### Modern Web Guidance` 披露段，**本项目不采纳**：只在下列信号命中时检索，
单个任务检索 1–2 次为限，不写披露段（除非任务明确要求）。

| 任务信号（命中才检索） | `search` 查询示例 | 典型 guide id |
|---|---|---|
| dialog / modal / popover / tooltip / 抽屉、轻关闭、Esc 或点击遮罩关闭、焦点陷阱、滚动穿透、`inert` | `light dismiss dialog` | `dialog`、`light-dismiss-a-dialog` |
| 容器查询、`subgrid`、anchor positioning、320/400 窄窗、流式字号、`text-wrap` 平衡、安全区 | `container query card` | `css-layout`、`responsive-design` |
| view transitions、scroll-driven animation、入场/退场、视差、scroll snap、`prefers-reduced-motion` | `animate dialog top layer` | `motion`、`animate-to-from-top-layer` |
| 校验时机、`:user-invalid`、autofill、自定义 `<select>`、switch、range、自动伸缩输入框、IME 回车提交 | `validation after interaction` | `validate-input-after-interaction` |
| 深/浅主题、`light-dark()`、`color-mix()`、`oklch`、滚动条配色、`prefers-contrast`、强制色彩 | `dark mode scrollbar` | `dark-mode`、`color` |
| LCP / INP / CLS、`content-visibility`、`fetchpriority`、`scheduler.yield`、长任务拆分、预取预渲染 | `identify inp causes` | `identify-inp-causes` |
| aria 状态、屏幕阅读器、`focus-visible`、键盘可达、生成内容替代文本、OS 文字缩放 | `accessible error announcement` | `accessibility`、`accessible-error-announcement` |
| Trusted Types、HTML 消毒、SRI、passkey、客户端加密、Permissions Policy、本地网络访问 | `sanitize untrusted html` | `trusted-types`、`sanitize-untrusted-html` |
| Temporal、时区、DST、`Intl.DurationFormat`、非公历 | `timezone dst event` | `js`、`coordinate-global-events` |
| 自定义元素、Shadow DOM、声明式 Shadow DOM、表单关联元素、跨 shadow 样式 | `shadow dom slots` | `web-components`、`shadow-dom` |
| 浏览器内置 AI（Translator / Summarizer / LanguageModel / LanguageDetector） | `on device summarizer` | `summarizer`、`prompt-api` |
| Manifest V3、扩展 service worker、content script、消息传递、side panel、declarativeNetRequest、omnibox、userScripts、商店上架 | 无需 `search` | `chrome-extensions` 技能的 `references/extensions/*.md`、`references/webstore/*.md` |

- **调用方式**（离线本地 CLI，不依赖 npx 联网）：`$env:DISABLE_TELEMETRY="1"` 后执行
  `node <技能目录>\modern-web.mjs search "<2–5 词英文动作+组件名>"`，命中后
  `retrieve "<id>"`（可逗号传多个）。查询词不带框架名（React/Vue/Tailwind）与业务名词；
  一次说多个能力就拆多次 `search`；结果为空或弱相关时换同义词重试一次即放弃，不硬凑。
- `chrome-extensions` **无 CLI**，按需 `Read` 其 `references/extensions/<topic>.md`（约 2–9 KB/篇），
  不要把 20 篇一次性读进上下文。
- **优先级**：根 AGENTS.md §6 的语义 Token / `overlayStack` / `data-tip` / 320·400 窄窗约束与
  `ui-themes/` 高于指南文本；指南只提供实现方式与兼容数据，不得据此推翻已确认 Token、另造
  组件层或绕过统一弹层栈。
- 本项目前端跑在 Tauri/WebView2：指南中**非 Baseline Widely available** 的特性必须按其 fallback
  要求实现，fallback 控制在 ≤50 行且不新增依赖；否则改用插件内的等价基线方案。
- 上述信号之外（后端 SQL/ORM/API 路由、CI·Docker、Python/Go、Vite·tsconfig·ESLint、纯改名与文案、
  纯 Rust/Tauri 后端侧、真机验收项）**不加载这两个技能**；真机与视觉验收仍按根 AGENTS.md §5.3 执行。
