//! 个性化类教程（2 篇，verified；navigation 篇自带 en-US）。

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
    },
    keywords: {
      "zh-CN": ["主题", "深色", "浅色", "材质", "玻璃", "预设", "语言", "英文", "高对比度"],
    },
    relatedFeatureIds: ["eco.i18n"],
    relatedRouteIds: ["settings"],
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
