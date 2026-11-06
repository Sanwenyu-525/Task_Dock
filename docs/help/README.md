# 帮助系统（帮助中心 / 首次引导 / ContextHelpButton）— 第一轮交付说明

> 交付轮次：Round 1（2026-11-06，Subagent B）。第二轮计划接入各功能面板，见文末。

## 1. 组成与文件地图

| 模块 | 路径 | 说明 |
|---|---|---|
| 类型 | `src/help/types.ts` | `HelpArticle` / `HelpSection`（heading/paragraph/steps/tip/note/callout）/ 状态枚举 |
| 分类 | `src/help/categories.ts` | 8 类顺序 + 分类名走全局 i18n 词典（`help.category.*`） |
| 注册中心 | `src/help/registry.ts` | 文章唯一清单、按分类/ID 查询、纯函数搜索、步骤复制文本 |
| 状态徽标 | `src/help/statusMeta.ts` | 教程状态 → 文案键 + StatusTone 统一映射 |
| 最近浏览 | `src/help/recent.ts` | localStorage（`taskdock.help.recent.v1`，上限 8 条），无常驻任务 |
| 正文内容 | `src/help/content/*.ts` | 按分类分文件的结构化 TS 内容（不用 markdown 解析器，零新依赖） |
| 校验 | `npm run help:check` | = `vitest run src/help/__tests__/registry-contract.test.ts` |
| 帮助中心 UI | `src/components/help/HelpCenterPanel.tsx`（+ `HelpArticleBody.tsx` / `HelpFeatureLink.tsx` / `help-center.css`） | 完整模式第 13 个视觉入口（`help` tab）宿主页 |
| 上下文帮助 | `src/components/help/ContextHelpButton.tsx` | 可复用 `?` 按钮 + Popover（overlayStack menu 层） |
| 首次引导 | `src/store/useOnboardingStore.ts`、`src/components/onboarding/OnboardingOverlay.tsx`（+ `onboarding.css`） | 页内卡片形态（非全屏 Modal），localStorage `taskdock.onboarding.v1` |

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
- **静态校验确认不了的「操作语义是否过时」不伪装自动通过**，一律用 `needs_review` 表达
  （当前 2 篇：`help.agents.mcp-authorization`（功能开发中）、`help.troubleshooting.agent-no-events`）。

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
   - `contentVersion ≥ 1`（结构变化递增）、`reviewedForVersion` 非空（如 `"v0.11"`）；
   - `status=verified` 必须有完整 zh-CN 正文 + 非空 `keywords["zh-CN"]`；
   - en-US 正文若提供，段落数量与类型必须与 zh-CN 平行（防漂移）；
3. 运行 `npm run help:check` —— 全部契约静态校验，失败消息指明「哪篇文章哪个字段」；
4. 若关联了 implemented 核心功能，注册中心契约保证「每个 implemented 核心功能至少一篇
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

第二轮接入建议顺序：任务页（quick-capture / smart-reminders）、剪贴板页、Agent 页、
工作流页；每个面板 1-2 个按钮即可，不在列表行内堆叠帮助按钮。

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
npm run help:check          # 注册中心契约（12 用例）
npx vitest run src/help src/components/help src/components/onboarding src/store/useOnboardingStore.test.ts
npx tsc --noEmit
```

## 7. 第二轮待办

1. 各面板接入 `ContextHelpButton`（见第 4 节顺序建议）；
2. 「设置」页加入「重新打开新手引导」入口（本轮 SettingsPanel 属其他 Agent 禁改范围，未接入；
   帮助中心已提供等价入口）；
3. 全局搜索（Ctrl+Shift+F）接入帮助分类（当前帮助中心自带搜索，未占用全局搜索）；
4. MCP 教程随功能发布复核转 verified；`agent-no-events` 篇真机复核后转 verified；
5. en-US 教程正文按需补齐（缺失时有诚实徽标，不影响使用）。
