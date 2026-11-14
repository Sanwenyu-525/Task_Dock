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
  {
    id: "help.quickstart.command-phrases",
    categoryId: "quickstart",
    status: "draft",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "句式命令：一句话查询或修改任务",
        summary:
          "全局搜索输入框支持一组封闭句式：单步完成 / 改期 / 调整优先级，以及本周完成、逾期、今日到期与 Agent 失败查询。写操作需要两次 Enter 确认。",
        sections: [
          { type: "heading", text: "支持的句式" },
          {
            type: "steps",
            items: [
              "完成 交周报（或「把交周报标记完成」）——把未完成任务标记完成。",
              "把交周报改到明天下午三点（或「交周报 改到 明天」）——时间写法与快速录入一致。",
              "把交周报的优先级改成高（或「交周报优先级高」）——高 / 中 / 低三档。",
              "本周完成了什么——本周完成数量、逾期与今日到期汇总，并列出本周完成的任务。",
              "逾期任务（或「有哪些逾期的」）——列出当前逾期且未完成的任务。",
              "今天要做什么——列出本地今天到期的未完成任务。",
              "哪些 Agent 失败了——列出需要介入的失败 Agent 会话，点击可定位。",
            ],
          },
          { type: "heading", text: "两段式确认" },
          {
            type: "paragraph",
            text: "写操作（完成 / 改期 / 优先级）先列出最多 5 个匹配的未完成任务。第一次按 Enter 只进入确认态并展示变化（例如「无截止时间 → 明天 09:00」），第二次按 Enter 才真正写入；Esc 先取消确认、再按一次才关闭弹窗。改期与优先级只写入目标字段，不会清空任务描述、独立提醒或重复规则。",
          },
          { type: "heading", text: "识别失败怎么办" },
          {
            type: "paragraph",
            text: "不在句式表内的说法、无法解析的时间、以及整句话恰好等于已有任务标题时，都会按普通搜索处理，不报错、不猜测意图。此时输入框下方会给出可用的句式示例，搜索行为与之前完全一致。",
          },
          {
            type: "note",
            text: "v1 只做任务域的只读查询与单步修改：不支持多步链式、批量、删除、暂存架或剪贴板写入，也没有撤销。改期或优先级可以再发一条命令改回。",
          },
        ],
      },
      "en-US": {
        title: "Command phrases: query or update tasks in one sentence",
        summary:
          "The global search box understands a closed set of phrases: one-step complete / reschedule / priority changes, plus this-week completions, overdue tasks, today's tasks and failed agents. Writes require two Enter presses.",
        sections: [
          { type: "heading", text: "Supported phrases" },
          {
            type: "steps",
            items: [
              "完成 交周报 (or 把交周报标记完成) — mark a pending task complete.",
              "把交周报改到明天下午三点 (or 交周报 改到 明天) — time expressions match quick add.",
              "把交周报的优先级改成高 (or 交周报优先级高) — high / medium / low.",
              "本周完成了什么 — this week's completion count, overdue and due-today summary, plus completed tasks.",
              "逾期任务 (or 有哪些逾期的) — tasks past their due time and still pending.",
              "今天要做什么 — pending tasks due today (local day).",
              "哪些 Agent 失败了 — failed agent sessions that need attention; click to locate.",
            ],
          },
          { type: "heading", text: "Two-step confirmation" },
          {
            type: "paragraph",
            text: "Writes (complete / reschedule / priority) first list up to five matching pending tasks. The first Enter only arms the change and shows the diff (for example \"No due date → Tomorrow 09:00\"); the second Enter performs the write. Esc cancels the armed state first and closes the dialog only on the next press. Reschedule and priority only write the target fields; description, standalone reminders and recurrence rules are preserved.",
          },
          { type: "heading", text: "When a phrase is not recognized" },
          {
            type: "paragraph",
            text: "Phrases outside the table, unparseable times, and inputs that exactly match an existing task title all fall back to normal search. No error is shown and intent is never guessed. The dialog then shows usable phrase examples and search behaves exactly as before.",
          },
          {
            type: "note",
            text: "v1 only covers task-domain read-only queries and one-step changes: no multi-step chains, batch operations, deletion, shelf or clipboard writes, and no undo. Reschedule or priority changes can be reverted with another phrase.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["句式命令", "自然语言", "完成", "改期", "优先级", "本周完成", "逾期", "Agent 失败", "全局搜索"],
      "en-US": ["command phrases", "natural language", "complete", "reschedule", "priority", "completed this week", "overdue", "failed agent", "global search"],
    },
    relatedFeatureIds: ["ux.command-phrases", "ux.command-palette", "core.global-search"],
    relatedRouteIds: ["tasks", "agents"],
  },
];
