//! 个性化类教程（3 篇，verified，均自带 en-US；widgets 篇 2026-11-08 新增）。

import type { HelpArticle } from "../types";

export const PERSONALIZE_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.personalize.themes",
    categoryId: "personalize",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "主题、材质与视觉预设",
        summary: "明暗主题、窗口材质与两套视觉预设三者正交，任意组合即时生效。",
        sections: [
          { type: "heading", text: "三个正交维度" },
          {
            type: "steps",
            items: [
              "明暗主题：浅色 / 深色，跟随系统可选；切换不重建界面，输入内容不丢。",
              "窗口材质：solid（不透明，兼容性最好）/ glass（半透明 tint + 原生 Mica/Acrylic）；系统不支持原生效果时自动降级为 solid，界面同步跟随。",
              "视觉预设：梦幻渐变 / 液态玻璃，决定选中态、卡片等视觉风格；文字可读性在任何组合下都有保障。",
            ],
          },
          { type: "heading", text: "语言" },
          {
            type: "paragraph",
            text: "「设置 → 外观与主题 → 语言」可在简体中文 / English / 跟随系统之间切换，即时生效、重启保留；语言偏好随备份迁移。部分深层页面（如 Agent 接入向导内部文案）仍在逐步翻译中。",
          },
          {
            type: "tip",
            text: "系统开启高对比度时，状态徽标会自动补边框，不单靠颜色区分状态。",
          },
          {
            type: "note",
            text: "如果开启 glass 后窗口看起来不透明，多半是系统关闭了透明效果或显卡不支持——task_dock 已如实降级为 solid，属于预期行为。",
          },
        ],
      },
      "en-US": {
        title: "Themes, materials and visual presets",
        summary:
          "Light/dark theme, window material and two visual presets are three orthogonal axes; any combination applies instantly.",
        sections: [
          { type: "heading", text: "Three orthogonal dimensions" },
          {
            type: "steps",
            items: [
              "Light / dark theme, with a follow-system option; switching never rebuilds the UI and typed input is never lost.",
              "Window material: solid (opaque, best compatibility) or glass (translucent tint + native Mica/Acrylic); when the system cannot provide the native effect it degrades to solid honestly, and the UI follows.",
              "Visual presets: Dream Gradient / Liquid Glass, defining selection states, cards and overall style; text readability is guaranteed in any combination.",
            ],
          },
          { type: "heading", text: "Language" },
          {
            type: "paragraph",
            text: "\"Settings → Appearance & theme → Language\" switches between Simplified Chinese / English / follow system, applies immediately and survives restarts; the language preference travels with backups. Some deep pages (like the inside of the agent onboarding wizard) are still being translated.",
          },
          {
            type: "tip",
            text: "When the system runs in high-contrast mode, status badges automatically gain a border so state never relies on color alone.",
          },
          {
            type: "note",
            text: "If the window still looks opaque with glass enabled, the system likely has transparency disabled or the GPU does not support it — Task Dock has degraded to solid as designed.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["主题", "深色", "浅色", "材质", "玻璃", "预设", "语言", "英文", "高对比度"],
      "en-US": ["theme", "dark", "light", "material", "glass", "preset", "language", "English", "high contrast"],
    },
    relatedFeatureIds: ["eco.i18n"],
    relatedRouteIds: ["settings"],
  },
  {
    id: "help.personalize.widgets",
    categoryId: "personalize",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "桌面微件库：工作台与桌面小窗",
        summary: "六类只读微件可加入工作台或独立显示到桌面：开关、尺寸、置顶与位置都可自定义。",
        sections: [
          { type: "heading", text: "可用微件" },
          {
            type: "paragraph",
            text: "「微件」页提供六类微件：今日任务、下一条提醒、Agent 状态、快捷操作、专注倒计时、今日效率统计。数据只读复用各模块现有选择器，不新增后台轮询；隐藏或未挂载时不刷新。",
          },
          { type: "heading", text: "添加与管理" },
          {
            type: "steps",
            items: [
              "进入「微件」页，「添加微件」里只列出尚未添加的微件，点「添加到工作台」立即出现，不跳转页面。",
              "每张微件卡可调整尺寸（窄 / 标准 / 宽）、上移 / 下移排序或停用；「恢复默认」一键还原布局。",
              "把微件「添加到桌面」后，主窗内的工作台卡片保留，同时在桌面出现独立轻量窗口。",
            ],
          },
          { type: "heading", text: "桌面窗口" },
          {
            type: "steps",
            items: [
              "桌面显示开关随时切换：只在桌面显示 / 只在工作台保留，两者互不影响。",
              "桌面窗口可拖动摆放，位置与尺寸自动保存；「置顶」让微件始终保持在最前。",
              "窗口位置异常时用「重置桌面位置」回到默认位置；关闭桌面窗口不影响工作台数据。",
            ],
          },
          {
            type: "note",
            text: "微件的启用状态、顺序、尺寸与桌面窗口配置都会随备份迁移；效率类微件在数据变化时按需刷新，失败时显示「可能已过期」并提供重试，不做后台轮询。独立桌面窗口的多显示器 / DPI 行为尚未完成真机验收。",
          },
        ],
      },
      "en-US": {
        title: "Desktop widget library: workspace cards and desktop windows",
        summary:
          "Six read-only widgets can join the workspace or live on the desktop as small windows; toggle, size, topmost and position are yours to set.",
        sections: [
          { type: "heading", text: "Available widgets" },
          {
            type: "paragraph",
            text: "The \"Widgets\" page offers six widgets: Today's tasks, Next reminder, Agent status, Quick actions, Focus countdown and Today's efficiency. Data is read-only and reuses each module's existing selectors with no extra background polling; hidden or unmounted widgets never refresh.",
          },
          { type: "heading", text: "Add and manage" },
          {
            type: "steps",
            items: [
              "Open the \"Widgets\" page; \"Add widgets\" lists only widgets not yet added. \"Add to workspace\" puts one on the board immediately without navigating away.",
              "Each widget card can change size (Narrow / Standard / Wide), move up / down or be disabled; \"Reset layout\" restores the default arrangement in one click.",
              "\"Add to desktop\" keeps the workspace card and additionally shows the widget as a standalone lightweight window on the desktop.",
            ],
          },
          { type: "heading", text: "Desktop windows" },
          {
            type: "steps",
            items: [
              "The desktop toggle switches any time: desktop-only or workspace-only, without affecting the other.",
              "Drag desktop windows to arrange them; position and size are saved automatically. \"Topmost\" keeps a widget always in front.",
              "If a window ends up somewhere odd, \"Reset desktop position\" moves it back to the default spot; closing a desktop window never affects workspace data.",
            ],
          },
          {
            type: "note",
            text: "Widget enablement, order, size and desktop window configuration all travel with backups. Efficiency widgets refresh on data changes, show \"may be outdated\" with a retry on failure, and never poll in the background. Multi-monitor / DPI behavior of standalone desktop windows has not completed native acceptance yet.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["微件", "桌面", "工作台", "置顶", "尺寸", "今日效率", "专注倒计时"],
      "en-US": ["widget", "desktop", "workspace", "topmost", "size", "efficiency", "focus countdown"],
    },
    relatedFeatureIds: ["eco.widgets"],
    relatedRouteIds: ["widgets"],
  },
  {
    id: "help.personalize.navigation",
    categoryId: "personalize",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "导航自定义：显隐与排序",
        summary: "按自己的习惯显示、隐藏或重排侧栏入口；隐藏的入口仍可从「更多」打开。",
        sections: [
          { type: "heading", text: "调整入口" },
          {
            type: "steps",
            items: [
              "进入「设置 → 自定义导航」，或右键侧栏入口。",
              "用开关控制每个入口在左侧导航的显示；隐藏后页面本身仍可从「更多」菜单打开。",
              "用上移 / 下移调整顺序；「设置」是锁定入口，固定在侧栏底部，不可隐藏或排序。",
            ],
          },
          { type: "heading", text: "规则说明" },
          {
            type: "paragraph",
            text: "配置按入口的稳定 ID 保存，改名不影响你的排序；当前页入口被隐藏时不会临时插回侧栏（其余图标位置保持稳定），选中态由「更多」按钮承担。恢复默认一键还原当前界面的全部入口与顺序。",
          },
          {
            type: "tip",
            text: "停靠胶囊的轨道图标与完整面板侧栏是两份独立配置，可分别调整。",
          },
        ],
      },
      "en-US": {
        title: "Customize navigation: show, hide and reorder",
        summary:
          "Show, hide or reorder rail entries to match your habits; hidden entries stay reachable from \"More\".",
        sections: [
          { type: "heading", text: "Adjust entries" },
          {
            type: "steps",
            items: [
              "Open \"Settings → Customize navigation\", or right-click a rail entry.",
              "Use the switches to show or hide entries; hidden pages remain reachable from the \"More\" menu.",
              "Use Move up / Move down to reorder; Settings is a pinned entry fixed at the bottom and cannot be hidden or reordered.",
            ],
          },
          { type: "heading", text: "How it works" },
          {
            type: "paragraph",
            text: "Your layout is saved by stable entry IDs, so renames never break it. A hidden current page is never temporarily re-inserted (other icons keep their places); the \"More\" button carries the selected state. \"Restore defaults\" resets the current surface in one click.",
          },
          {
            type: "tip",
            text: "The docked capsule rail and the full-panel rail are two independent configurations.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["导航", "自定义", "隐藏入口", "排序", "恢复默认", "更多"],
      "en-US": ["navigation", "customize", "hide entries", "reorder", "restore defaults"],
    },
    relatedFeatureIds: [],
    relatedRouteIds: ["settings"],
  },
];
