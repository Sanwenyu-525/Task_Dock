//! 文件笔记与收集箱类教程（2 篇，verified）。

import type { HelpArticle } from "../types";

export const CAPTURE_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.capture.inbox-notes",
    categoryId: "capture",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "收集箱与快速笔记",
        summary: "随手内容先进收集箱，再转成任务或笔记；笔记自动保存、可置顶搜索。",
        sections: [
          { type: "heading", text: "收集箱" },
          {
            type: "steps",
            items: [
              "Ctrl+5 或侧栏「收集与暂存」进入快速收集子页；徽标显示未处理数量。",
              "默认只看未处理条目：可复制、转为任务、转为笔记、标记已处理或删除。",
              "想法 / 文字 / 链接来自快速捕获窗口时也会落到这里。",
            ],
          },
          { type: "heading", text: "快速笔记" },
          {
            type: "steps",
            items: [
              "在「收集与暂存」内切换到笔记子页，点「新建」。",
              "输入时自动保存（防抖），无需手动保存按钮。",
              "收藏的笔记置顶展示；搜索框按标题与正文过滤。",
              "可用内置常用模板快速起步；收集箱条目「转为笔记」直接带内容过去。",
            ],
          },
          {
            type: "paragraph",
            text: "笔记可关联任务与工作现场，方便在任务上下文里回看；全局搜索同样覆盖笔记分类。",
          },
          {
            type: "note",
            text: "快速笔记刻意保持轻量：不做双向链接与富文本，需要结构化内容时建议建任务并关联现场。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["收集箱", "笔记", "转任务", "置顶", "模板", "自动保存", "未处理"],
    },
    relatedFeatureIds: ["core.quick-notes", "core.quick-capture"],
    relatedRouteIds: ["inbox"],
  },
  {
    id: "help.capture.shelf",
    categoryId: "capture",
    status: "needs_review",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "文件暂存架：临时文件的收纳区",
        summary: "把文件 / 截图 / 链接拖进暂存架集中管理，支持分组、批量整理与过期清理。",
        sections: [
          { type: "heading", text: "添加条目" },
          {
            type: "steps",
            items: [
              "Ctrl+6 或「收集与暂存 → 文件暂存」进入暂存架。",
              "四种添加方式：文件选择器（可多选与选文件夹）、直接拖入文件、粘贴链接、保存文本片段。",
              "「从剪贴板添加」会复制出独立副本：之后清空剪贴板不影响暂存内容。",
            ],
          },
          { type: "heading", text: "整理与查找" },
          {
            type: "paragraph",
            text: "支持搜索、类型筛选、分组筛选、收藏筛选与置顶排序；多选后可批量移动分组、收藏或删除（收藏与置顶受保护）。图片有缩略图与灯箱预览，文本与 HTML 安全只读预览。",
          },
          { type: "heading", text: "取出与清理" },
          {
            type: "steps",
            items: [
              "系统级拖出资源管理器尚未支持；替代操作：「复制路径」「复制文件」「打开所在文件夹」。",
              "过期清理默认关闭；开启后可先预览候选条目再执行，收藏与置顶永不被自动清理，绝不删除你的原始文件。",
            ],
          },
          {
            type: "note",
            text: "暂存架与剪贴板历史的边界：剪贴板被动记录复制历史，暂存架是你主动管理的内容；两者数据互不混淆。暂存条目可关联任务，删除任务不删暂存资源。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["暂存架", "文件", "拖入", "分组", "过期清理", "复制路径", "托管副本"],
    },
    relatedFeatureIds: ["core.file-shelf"],
    relatedRouteIds: ["inbox"],
  },
];
