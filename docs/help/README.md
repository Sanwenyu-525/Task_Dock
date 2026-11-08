# 帮助系统（帮助中心 / 首次引导 / ContextHelpButton）— 交付说明

> 交付轮次：Round 2（2026-11-06）。本轮补齐主要业务页上下文入口、来源页返回和显式操作源变更提示；未完成项列在文末。

## 1. 组成与文件地图

| 模块 | 路径 | 说明 |
|---|---|---|
| 类型 | `src/help/types.ts` | `HelpArticle` / `HelpSection`（heading/paragraph/steps/tip/note/callout）/ 状态枚举 |
| 分类 | `src/help/categories.ts` | 8 类顺序 + 分类名走全局 i18n 词典（`help.category.*`） |
| 注册中心 | `src/help/registry.ts` | 文章唯一清单、按分类/ID 查询、纯函数搜索、步骤复制文本 |
| 状态徽标 | `src/help/statusMeta.ts` | 教程状态 → 文案键 + StatusTone 统一映射 |
| 最近浏览 | `src/help/recent.ts` | localStorage（`taskdock.help.recent.v1`，上限 8 条），无常驻任务 |
| 正文内容 | `src/help/content/*.ts` | 按分类分文件的结构化 TS 内容（不用 markdown 解析器，零新依赖） |
| 校验与健康度 | `npm run help:check` | 注册中心静态契约 + 教程覆盖/复核/英文缺失摘要；MCP、工作流、场景和暂存架操作源文件由 `src/help/operationContracts.ts` 显式登记 |
| 帮助中心 UI | `src/components/help/HelpCenterPanel.tsx`（+ `HelpArticleBody.tsx` / `HelpFeatureLink.tsx` / `help-center.css`） | `help` 稳定路由；默认不占左侧常驻入口 |
| 上下文帮助 | `src/components/help/ContextHelpButton.tsx` | 可复用 `?` 按钮 + Popover（overlayStack menu 层） |
| 首次引导 | `src/store/useOnboardingStore.ts`、`src/components/onboarding/OnboardingOverlay.tsx`（+ `onboarding.css`） | 页内卡片形态（非全屏 Modal），localStorage `taskdock.onboarding.v1` |
| 重开引导 | `src/components/onboarding/ReopenOnboardingButton.tsx` | 帮助中心与设置页可复用；调用现有 `reopenFromHelp()`，无新存储或 IPC |

## 2. 教程内容约定

### 2.1 正文不走全局 MessageKey 词典

教程正文量大且持续增长，走全局词典会让 `MessageKey` 类型与翻译文件键爆炸。因此：

- 正文自备 `translations: { "zh-CN": 必填, "en-US"? 可选 }`；
- en-US 缺失时 UI 明确显示「该教程暂无英文版」徽标并回退渲染中文正文，**不伪称国际化完成**；
- 界面骨架（按钮 / 分类名 / 搜索框 / 空态）走全局词典 `help.*` / `onboarding.*`（zh-CN 与 en-US 都有真实翻译）。

### 2.2 status 与功能状态是两个正交维度

- `HelpArticleStatus`：`draft`（编写中）/ `verified`（与 reviewedForVersion 界面核对一致）/
  `needs_review`（操作语义可能过时或功能仍在开发）/ `unavailable`；
- featureCatalog 的 `implemented / partial / planned / blocked` 是功能实现状态；
- **静态校验确认不了的「操作语义是否过时」不伪装自动通过**。2026-11-08 收口复核：
  原 6 篇 needs_review 已逐篇对照源码复核——`help.capture.shelf`（从剪贴板添加默认引用、
  可切换复制副本）、`help.workflows.one-click`、`help.workflows.scenes`（快照已含窗口几何，
  恢复尽力原位/收敛）、`help.workflows.planning-center`、`help.troubleshooting.agent-no-events`
  与 `help.quickstart.command-palette`（命令组仅「全部」分类展示等口径补齐）转 verified；
  `help.agents.mcp-authorization` 正文已按当前源码更新（MCP Inspector 端到端联调已通过），
  但其敏感契约源文件（`src-tauri/src/db/mod.rs`）有并行在途改动，转 verified 会升级为阻断，
  故如实保持 needs_review，待该改动合入后再转正。
  文章总量 25 篇：24 verified / 1 needs_review / 0 draft。

### 2.3 结构化 section

```ts
type HelpSection =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "steps"; items: readonly string[] }   // 有序步骤，可被「复制操作步骤」导出
  | { type: "tip"; text: string }                 // 提示（accent 底）
  | { type: "note"; text: string }                // 注意（warning 底）
  | { type: "callout"; text: string };            // 重要（danger 底，用于「功能开发中」等强提示）
```

## 3. 新增 / 修改一篇教程的流程

1. 在 `src/help/content/<分类>.ts` 中追加或修改 `HelpArticle`（内容文件按分类组织）；
2. 遵守字段契约：
   - `id`：`help.<categoryId>.<slug>`，稳定且唯一（公开契约，重命名视为破坏性变更）；
   - `relatedFeatureIds`：必须 ∈ `featureCatalog`；
   - `relatedRouteIds`：必须 ∈ `navigationRegistry` 入口 ID；
   - `contentVersion ≥ 1`（正文结构或操作语义变化递增）、`reviewedForVersion` 非空（如 `"v0.11"`）；
   - `status=verified` 必须有完整 zh-CN 正文 + 非空 `keywords["zh-CN"]`；
   - en-US 正文若提供，段落数量与类型必须与 zh-CN 平行（防漂移）；
3. 若改动 `operationContracts.ts` 登记的操作/权限实现，递增对应契约 `version`，把受影响文章改为 `needs_review`；人工复核正文后更新 `reviewedOperationContractVersions` 和文章状态；
4. 运行 `npm run help:check` —— 静态契约校验 + 健康度摘要；无效引用和敏感契约冲突会阻断，普通契约冲突、待复核和缺英文版会明确提示；
5. 若关联了 implemented 核心功能，注册中心契约保证「每个 implemented 核心功能至少一篇
   非 unavailable 教程」，删除教程前先确认不破坏该约束。

## 4. ContextHelpButton 用法（第二轮接入指南）

```tsx
import ContextHelpButton from "../help/ContextHelpButton";

// 放在面板标题行右侧（不遮挡操作按钮；小尺寸锚定弹层，非模态）
<ContextHelpButton articleId="help.quickstart.capture" />
// 可选：placement（floating-ui Placement，默认 "bottom-end"）、className（外边距微调）
```

行为约定：

- 文章 ID 未注册时**不渲染**（避免死按钮）；`npm run help:check` 保证 ID 有效；
- 弹层接入 `overlayStack`（`layer="menu"`）：一次 Escape 只关本层，外部点击/滚动关闭；
- 弹层内容：标题 + 摘要 + 状态徽标（en-US 下补「暂无英文版」徽标）+「查看完整教程」；
- 「查看完整教程」执行 `setTab("help")` + `requestHelpArticle(articleId)`（一次性意图，
  帮助中心消费后清除；token 自增防重复消费）。

当前已接入：任务页主筛选栏（`help.tasks.create-reminders`）、剪贴板标题操作区（仅页面形态，
`help.clipboard.history`）、Agent 分区工具栏（`help.agents.hooks-onboarding`）、工作流编辑器
（`help.workflows.one-click`）、规划中心数据源切换区（`help.workflows.planning-center`）、暂存架标题区
（`help.capture.shelf`）、场景工作区标题区（`help.workflows.scenes`）、设置中的 MCP 服务开关
（`help.agents.mcp-authorization`）和数据备份开关（`help.troubleshooting.backup`）。

帮助中心可从设置页「帮助与教程」或业务页面的上下文帮助打开。上下文按钮与设置入口会记录来源页，
帮助中心提供「返回来源页面」；离开帮助路由时自动清除旧来源。帮助文章内「返回教程列表」会保留原搜索查询。
左侧导航中的 `help` 路由仍保留，
但新配置默认隐藏以减少常驻入口；已有导航配置会按稳定 ID 保留用户明确设置的显隐和顺序。

## 5. 首次引导语义

- 步骤：认识 task_dock → 完成第一个任务 → 按需启用功能（最多 3 步）；
- 形态：右下角页内卡片（`--z-modal` 层，非全屏 Modal，不抢占焦点）；
- 自动展示：首次使用（无记录）或「未完成且未跳过」；明确跳过后不再自动打扰；
- 升级不重播：`version` 记录 seenVersion 语义；新版本只置 `hasNewContent` 标志，
  由帮助中心「重新打开新手引导」按钮（带红点）呈现，绝不自动重播；
- Escape 经 `overlayStack`（sublayer 层）等价跳过；Tab 顺序为自然 DOM 顺序；
- **不创建任何业务数据**：第 2/3 步按钮只做页面跳转，无示例任务写入；
- 仅完整模式 + 设置已加载 + 非停靠/胶囊期显示（组件自判，App.tsx 只挂载一次）。

## 6. 校验命令

```bash
npm run help:check          # 注册中心契约与教程健康度检查
npx vitest run src/help src/components/help src/components/onboarding src/store/useOnboardingStore.test.ts
npx tsc --noEmit
```

MCP 教程当前描述设置中的管理 UI 和规划中心 18 个读写工具：`disabled` / `readonly` /
`project_rw` 权限、项目授权、一次性 token、客户端配置片段与分页审计摘要；明确不支持任务/剪贴板工具。
审计 UI 隐去 `detail`、`request_id` 和 `result_json`，但本地数据库仍保存成功写入结果用于幂等重放，且当前无保留期限或自动清理策略。`help:check` 只检查登记过的 MCP 身份、审计、bridge、命令、配置、
协议、工具与数据库源文件，也登记工作流、场景及暂存架操作文件；变更检查只对这些明确登记的文件运行，并同时包含未跟踪的新源文件。若敏感文章仍为 `verified` 时其源文件变化，会得到阻断级健康问题。静态检查不等于
真实 MCP 客户端、桌面运行状态或系统级交互已通过验收。真实独立客户端（MCP Inspector）端到端联调已于
2026-11-08 通过；教程保持 `needs_review` 的当前原因是：Claude Code / Codex CLI 等编码 Agent 的
握手差异尚未实测，且敏感契约源文件仍有并行在途改动（此时转 verified 会被门禁阻断）。

## 7. 后续待办

1. `help.agents.mcp-authorization`：正文已按 2026-11-08 源码复核（MCP Inspector 端到端联调通过）；
   待敏感契约源文件（`src-tauri/src/db/mod.rs` 等并行在途改动）合入且工作树干净后转 verified，
   并同步登记 `agent.mcp-server` 契约版本；
2. 场景几何恢复会话落地后，若新增用户可见 UI（恢复选项、逐项几何结果展示），补
   `help.workflows.scenes` 教程增量并复核 `core.scenario-workspace` 契约版本；
3. 工作流 / 场景 / 暂存架三篇 verified 教程在 `src/lib/bridge.ts` 在途改动合入后按
   help:check 提示复核一次（当前提示为在途文件变化的常规 warning）；
4. 浅色/深色、玻璃预设和 320/400px 窄窗对帮助中心与引导仍需 WebView2 真机验收（通道 C/E）。
