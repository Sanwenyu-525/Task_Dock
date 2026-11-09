//! 文件笔记与收集箱类教程（2 篇）。
//! shelf：2026-11-08 按当前源码（ShelfWorkspace/ShelfDetail）复核——「从剪贴板添加」默认
//! 以引用方式登记原文件（copyOnAdd 默认 false，可显式切换复制副本），原「会复制出独立副本」
//! 表述已更正；转 verified 并登记 core.file-shelf 契约版本 2。

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
      "en-US": {
        title: "Inbox and quick notes",
        summary:
          "Capture first, decide later: turn inbox items into tasks or notes; notes auto-save and support pinning and search.",
        sections: [
          { type: "heading", text: "Inbox" },
          {
            type: "steps",
            items: [
              "Press Ctrl+5 or open \"Capture & Shelf\" and go to the quick-capture sub-page; the badge shows unprocessed items.",
              "By default only unprocessed items are shown: copy, turn into a task, turn into a note, mark as processed or delete.",
              "Ideas / snippets / links captured from the quick-capture window land here too.",
            ],
          },
          { type: "heading", text: "Quick notes" },
          {
            type: "steps",
            items: [
              "Inside \"Capture & Shelf\", switch to the notes sub-page and click \"New\".",
              "Notes save automatically while you type (debounced) — there is no save button.",
              "Favorited notes are pinned to the top; the search box filters by title and body.",
              "Built-in templates give you a quick start; \"Turn into note\" on an inbox item carries the content over.",
            ],
          },
          {
            type: "paragraph",
            text: "Notes can be linked to tasks and workspaces so you can revisit them in a task's context; global search covers notes as well.",
          },
          {
            type: "note",
            text: "Quick notes are intentionally lightweight: no backlinks, no rich text. For structured content, create a task and link a workspace instead.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["收集箱", "笔记", "转任务", "置顶", "模板", "自动保存", "未处理"],
      "en-US": ["inbox", "note", "turn into task", "pin", "template", "auto save", "unprocessed"],
    },
    relatedFeatureIds: ["core.quick-notes", "core.quick-capture"],
    relatedRouteIds: ["inbox"],
  },
  {
    id: "help.capture.shelf",
    categoryId: "capture",
    status: "verified",
    contentVersion: 3,
    reviewedForVersion: "v0.11",
    reviewedOperationContractVersions: { "core.file-shelf": 3 },
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
              "「从剪贴板添加」从最近的剪贴板条目中挑选：文件默认以「引用」方式登记原路径（不复制、不占磁盘），需要独立副本时在「添加 ▾」菜单底部切到「保存副本到托管目录」；文本与链接保存内容本身。之后清空剪贴板不影响已暂存内容。",
            ],
          },
          { type: "heading", text: "整理与查找" },
          {
            type: "paragraph",
            text: "支持搜索、类型筛选、分组筛选、收藏筛选与置顶排序；多选后可批量移动分组、收藏或删除（收藏、置顶与场景引用条目受保护）。图片有缩略图与灯箱预览，文本与 HTML 安全只读预览。",
          },
          { type: "heading", text: "取出与清理" },
          {
            type: "steps",
            items: [
              "按住卡片可直接拖到资源管理器或其他应用（Windows 原生拖出）；引用文件按 Windows 默认复制或移动，托管副本只复制。移动后暂存条目的原路径可能失效，可重新定位或删除；键盘与回退仍可用「复制路径」「复制文件」「打开所在文件夹」。",
              "过期清理默认关闭；开启后每 1 小时检查一次。手动「立即清理过期」会先预览候选并二次确认，确认后才删除。",
              "收藏、置顶及被场景引用的条目默认跳过，不会被过期清理；清理只删除 Task Dock 托管的副本与暂存记录，绝不删除你的原始文件。",
            ],
          },
          {
            type: "note",
            text: "暂存架与剪贴板历史的边界：剪贴板被动记录复制历史，暂存架是你主动管理的内容；两者数据互不混淆。暂存条目可关联任务，删除任务不删暂存资源。",
          },
        ],
      },
      "en-US": {
        title: "File shelf: a home for temporary files",
        summary:
          "Drag files / screenshots / links into the shelf to manage them in one place, with grouping, bulk tidying and expiry cleanup.",
        sections: [
          { type: "heading", text: "Adding items" },
          {
            type: "steps",
            items: [
              "Press Ctrl+6 or open \"Capture & Shelf → File shelf\".",
              "Four ways to add: the file picker (multi-select and folders), dragging files in, pasting a link, or saving a text snippet.",
              "\"Add from clipboard\" picks from recent clipboard entries: files are registered by reference to their original path by default (nothing is copied, no disk used); choose \"Save a managed copy\" at the bottom of the \"Add ▾\" menu when you need an independent copy. Text and links store the content itself. Clearing the clipboard afterwards never affects what is already shelved.",
            ],
          },
          { type: "heading", text: "Organize and find" },
          {
            type: "paragraph",
            text: "Search, type filters, group filters, favorites filter and pinned sorting are supported; multi-select enables bulk move-to-group, favorite or delete (favorited, pinned and scene-referenced items are protected). Images get thumbnails and a lightbox preview; text and HTML get a sanitized read-only preview.",
          },
          { type: "heading", text: "Taking out and cleanup" },
          {
            type: "steps",
            items: [
              "Press and hold a card to drag it to Explorer or another app (native Windows drag-out); reference files follow the Windows copy/move rules, while managed copies are copy-only. After a move the shelf item's original path may become invalid — relocate or delete it; \"Copy path\", \"Copy file\" and \"Reveal in folder\" remain available for keyboard and fallback.",
              "Expiry cleanup is off by default; when enabled it checks once per hour. The manual \"Clean expired now\" first previews candidates and asks for confirmation before deleting.",
              "Favorited, pinned and scene-referenced items are skipped by default; cleanup only deletes Task Dock-managed duplicates and shelf records — never your original files.",
            ],
          },
          {
            type: "note",
            text: "Shelf vs clipboard history: the clipboard passively records what you copy, the shelf is what you actively curate; the two never mix data. Shelf items can be linked to tasks, and deleting a task never deletes shelf resources.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["暂存架", "文件", "拖入", "拖出", "分组", "过期清理", "复制路径", "托管副本"],
      "en-US": ["shelf", "file", "drag in", "drag out", "group", "expiry cleanup", "copy path", "managed copy"],
    },
    relatedFeatureIds: ["core.file-shelf"],
    relatedRouteIds: ["inbox"],
  },
];
