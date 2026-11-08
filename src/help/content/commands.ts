//! 命令面板教程（全局搜索弹窗内的命令能力层）。
//! 2026-11-08 按 commandRegistry.ts 与 GlobalSearchDialog/GlobalSearchCommands 当前源码复核：
//! 命令组仅「全部」分类展示、停用工作流不登记运行命令、设置分组与动态实体命令仅输入后出现
//! 均已补入正文；状态转 verified。

import type { HelpArticle } from "../types";

export const COMMANDS_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.quickstart.command-palette",
    categoryId: "quickstart",
    status: "verified",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "命令面板：在搜索框里直接执行操作",
        summary:
          "全局搜索（Ctrl+Shift+F）现在同时是命令面板：空查询给常用命令，输入即筛选；命令与数据结果分组展示、互不混淆。",
        sections: [
          { type: "heading", text: "打开与基本操作" },
          {
            type: "steps",
            items: [
              "按 Ctrl+Shift+F 打开全局搜索弹窗（与数据搜索是同一个入口，不新增弹窗）。",
              "不输入任何内容时，列表先给出常用命令：新建任务、创建提醒与各功能页入口。",
              "输入关键词即可筛选命令：匹配命令标题与关键词，中英文、不区分大小写；数据结果仍照常搜索。设置分组与场景 / 工作流命令也在输入后才会出现。",
              "↑/↓ 在命令与结果之间移动，Enter 执行当前选中项，Esc 关闭弹窗。",
            ],
          },
          { type: "heading", text: "命令能做什么" },
          {
            type: "paragraph",
            text: "打开任一功能页、新建任务、创建提醒（在快速录入输入「30分钟后 会议」即可）、进入指定场景、运行指定工作流、打开指定设置分组（自动切到对应分类并展开定位）。场景与工作流命令来自你的真实列表：没有场景或工作流时相应命令自动缺席，停用的工作流不会出现在运行命令里。",
          },
          { type: "heading", text: "命令与数据结果如何区分" },
          {
            type: "paragraph",
            text: "命令组固定在最前、有独立分组头与强调色图标，且只在「全部」分类下展示——选择某个具体数据分类时表示明确的数据检索意图，命令组随之隐藏。任务、剪贴板、文件等数据结果分组跟在后面，两者不会混在一起。",
          },
          {
            type: "note",
            text: "命令面板只做打开/跳转/新建草稿类动作：删除、覆盖、批量操作、停用模块不会出现在命令里。运行工作流会立即开始执行（同一时刻只有一个运行），反馈与逐步进度在工作流页查看；进入场景同理，逐项结果在场景工作区展示。",
          },
        ],
      },
      "en-US": {
      title: "Command palette: run actions right from the search box",
      summary:
        "Global search (Ctrl+Shift+F) doubles as a command palette: common commands when empty, filtered as you type. Commands and data results are shown in separate groups.",
      sections: [
        { type: "heading", text: "Open and basics" },
        {
          type: "steps",
          items: [
            "Press Ctrl+Shift+F to open the global search dialog (the same entry as data search; no second dialog).",
            "With an empty input the list starts with common commands: new task, create reminder and page entries.",
            "Type to filter commands by title and keywords (Chinese or English, case-insensitive); data results still search as usual. Settings sections and scenario / workflow commands also appear only once you type.",
            "↑/↓ move across commands and results, Enter runs the selected item, Esc closes the dialog.",
          ],
        },
        { type: "heading", text: "What commands can do" },
        {
          type: "paragraph",
          text: "Open any feature page, create a new task, create a reminder (type \"meeting in 30 minutes\" in quick add), enter a specific scenario, run a specific workflow, or jump straight to a settings section (auto-switches category and scrolls to it). Scenario and workflow commands come from your real lists: they disappear when the lists are empty, and disabled workflows never appear as run commands.",
        },
        { type: "heading", text: "How commands differ from data results" },
        {
          type: "paragraph",
          text: "The command group is pinned to the top with its own group header and accent icons, and shows only under the \"All\" category — picking a specific data category means you are clearly searching data, so commands hide. Task, clipboard and file result groups follow below, so the two never mix.",
        },
        {
          type: "note",
          text: "The palette only performs open/navigate/draft actions: delete, overwrite, batch operations and module toggles never appear as commands. Running a workflow starts it immediately (only one run at a time); progress feedback lives on the workflows page. The same applies to entering scenarios — per-item results appear in the scenario workspace.",
        },
      ],
      },
    },
    keywords: {
      "zh-CN": ["命令面板", "命令", "快捷操作", "全局搜索", "运行工作流", "进入场景", "设置定位"],
      "en-US": ["command palette", "commands", "quick actions", "global search", "run workflow", "enter scenario", "settings jump"],
    },
    relatedFeatureIds: ["core.global-search", "ux.command-palette"],
    relatedRouteIds: ["tasks", "workflows", "settings"],
  },
];
