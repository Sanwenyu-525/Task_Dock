# 多语言（i18n）

状态：v0.12 基础设施已落地，主窗口、捕获窗、右键菜单、通知窗入口均初始化语言。
第一版支持 **简体中文（默认）** 与 **English**，可扩展新语言。

## 1. 设计边界

| 项 | 结论 |
|---|---|
| 方案 | 轻量自建词典（无新依赖），约 200 行运行时 |
| 类型安全 | `MessageKey = keyof typeof zhCN`，英文目录用 `Record<MessageKey, string>`，漏键直接编译失败 |
| 运行时切换 | Zustand store 订阅，`useLocale()` 触发重新渲染，无需重启 |
| 持久化 | `localStorage` 键 `taskdock.locale`，值 `zh-CN` / `en-US` / `system`；不新增数据库设置键，旧库天然兼容 |
| 兜底 | 非法/损坏偏好 → 简体中文；英文缺失键 → 简体中文 → 键名 |
| 复数 | `Intl.PluralRules`，键后缀 `_one` / `_other` |
| 插值 | `{name}`，缺失参数保留占位符以便暴露问题 |
| 缺失检测 | `getMissingKeys()` + 开发期一次性 `console.warn` |
| 日期/数字 | `Intl.DateTimeFormat` / `Intl.NumberFormat` / `Intl.RelativeTimeFormat`，不硬编码月份与星期 |
| 错误 | 只按结构化 `code` 映射，旧字符串错误原样展示，不做中文子串推断 |

**不翻译**：任务标题、笔记、项目名、自定义 Agent 名、剪贴板正文、文件名、原始日志、技术标识符。
语言状态只影响 UI 固定文案与明确可国际化的系统文案。

## 2. 目录与入口

```
src/locales/zh-CN/index.ts   中文目录（默认 + 兜底，键集合的唯一事实源）
src/locales/en-US/index.ts   英文目录（必须覆盖全部键）
src/i18n/messages.ts         查表 / 插值 / 复数 / 缺失检测
src/i18n/index.ts            语言状态、持久化、initLocale、非 React t()
src/i18n/format.ts           Intl 日期 / 数字 / 相对时间
src/i18n/errors.ts           错误码 → 本地化文案
src/i18n/LanguageSetting.tsx 设置页「语言」行（自包含）
src/hooks/useLocale.ts       React 订阅 hook
```

四个入口（主窗、捕获窗、右键菜单、通知窗）在渲染前调用 `initLocale()`，同步
`<html lang>` 并监听 `languagechange`（仅「跟随系统」时切换）。

## 3. 使用方式

React 组件：

```tsx
const { t, locale, preference, setPreference } = useLocale();
return <button>{t("common.cancel")}</button>;
```

非 React / 事件回调 / 工具函数：

```ts
import { t, getLocale } from "../i18n";
t("quickAdd.created", { title });
```

错误：

```ts
import { localizedErrorMessage } from "../i18n/errors";
showToast(localizedErrorMessage(e), { kind: "error" });
```

日期与数字：

```ts
formatLocalizedDate(iso);       // 2026年11月3日 / Nov 03, 2026
formatLocalizedDateTime(iso);
formatLocalizedNumber(1234.5);
formatLocalizedPercent(0.42);
formatLocalizedRelative(iso);
```

数据库与 IPC 时间语义不变：ISO 字符串 / UTC 存储，本地化只发生在展示层。

## 4. 新增文案

1. 在 `src/locales/zh-CN/index.ts` 按 `区域.语义` 增加键；
2. 在 `src/locales/en-US/index.ts` 补齐同名键（漏键会编译失败）；
3. 复用既有区域，不新建平行命名；
4. 含数量语义时提供 `键_one` / `键_other`，并保留基础键用于类型；
5. 用户内容一律通过参数传入，不拼进文案常量。

## 5. 新增语言

1. `src/locales/<locale>/index.ts` 导出 `Record<MessageKey, string>`；
2. `src/i18n/messages.ts` 注册到 `CATALOGS` 与 `SUPPORTED_LOCALES`；
3. `LocaleCode` / `LocalePreference` 扩展联合类型；
4. 在 `LanguageSetting` 选项与 `resolveSystemLocale` 增加映射；
5. 跑 `npm test -- src/i18n` 与 `npx tsc --noEmit`。

## 6. 设置入口

`LanguageSetting` 是自包含的「一行设置 + 说明」，由设置面板挂载：

```tsx
import LanguageSetting from "../../i18n/LanguageSetting";

// 设置页「外观与主题」Section 内
<LanguageSetting />
```

挂载位置与待迁移页面清单见 `tmp/acceptance/i18n/integration.md`。

## 7. 验收要点

- 切换后当前页面立即变化，重启保留；
- 删除/篡改 `taskdock.locale` 后仍以中文启动；
- 英文长文案在 320/400 窄窗不撑破布局；
- 深/浅主题、两套视觉预设下文案对比度正常；
- 日期、相对时间、数字随语言变化；
- 任务标题、笔记、剪贴板正文保持原文。
