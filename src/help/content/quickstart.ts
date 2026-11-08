//! 快速入门类教程（6 篇，均 verified 且自带 en-US 翻译；help-center / onboarding 2026-11-08 新增）。
//!
//! 内容口径与当前实现一致（详见各文 reviewedForVersion）；引用的入口名与快捷键
//! 以 useUiStore.TAB_ORDER / navigationRegistry 为准。

import type { HelpArticle } from "../types";

export const QUICKSTART_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.quickstart.panel",
    categoryId: "quickstart",
    status: "verified",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "完整面板导览：导航、新建任务与徽标",
        summary:
          "认识完整模式左侧导航的 12 个入口、顶部新建任务按钮与徽标数字的含义。",
        sections: [
          {
            type: "paragraph",
            text: "完整面板是 task_dock 的主工作区：左侧是垂直导航栏，右侧是当前页面内容。窗口可以贴边吸附成胶囊，也可以恢复为完整面板自由摆放。",
          },
          { type: "heading", text: "左侧导航" },
          {
            type: "steps",
            items: [
              "高频页从上到下：任务、Agent、应用、微件、行动、剪贴板、收集与暂存。",
              "规划页居中：工作流、历史、规划中心。",
              "系统页在底部：帮助与设置；「设置」固定在侧栏最底部，不可被隐藏或排序。",
            ],
          },
          { type: "heading", text: "新建任务" },
          {
            type: "paragraph",
            text: "导航顶部的「+」按钮随时新建任务（快捷键 Ctrl+K），点击后自动切到任务页并聚焦快速录入框。",
          },
          { type: "heading", text: "徽标数字" },
          {
            type: "paragraph",
            text: "任务图标显示待办数量，Agent 图标显示需介入事项，行动图标显示待处理提醒与事件，「收集与暂存」只统计未处理的收集条目。关闭行动中心后，行动相关徽标会同步归零。",
          },
          {
            type: "tip",
            text: "右键点击导航上的入口或进入「设置 → 自定义导航」，可以调整每个入口的显示与顺序；隐藏的入口仍可从「更多」菜单打开。",
          },
        ],
      },
      "en-US": {
        title: "Full panel tour: navigation, new task and badges",
        summary:
          "Get to know the 12 entries in the full-mode left navigation, the New task button and what the badge numbers mean.",
        sections: [
          {
            type: "paragraph",
            text: "The full panel is the main Task Dock workspace: a vertical navigation rail on the left and the current page on the right. The window can snap to a screen edge as a capsule or be restored as a free-floating full panel.",
          },
          { type: "heading", text: "Left navigation" },
          {
            type: "steps",
            items: [
              "Everyday pages, top to bottom: Tasks, Agents, Apps, Widgets, Actions, Clipboard, Capture & Shelf.",
              "Planning pages in the middle: Workflows, History, Roadmap.",
              "System pages at the bottom: Help and Settings; Settings is pinned to the bottom of the rail and cannot be hidden or reordered.",
            ],
          },
          { type: "heading", text: "New task" },
          {
            type: "paragraph",
            text: "The \"+\" button at the top of the rail creates a task any time (Ctrl+K); it switches to the Tasks page and focuses the quick-add field.",
          },
          { type: "heading", text: "Badge numbers" },
          {
            type: "paragraph",
            text: "Tasks shows the pending count, Agents shows items needing intervention, Actions shows pending reminders and events, and Capture & Shelf counts unprocessed captures only. Turning off the Action Center zeroes the Actions badges.",
          },
          {
            type: "tip",
            text: "Open \"Settings → Customize navigation\" to show, hide or reorder entries; hidden entries remain reachable from the \"More\" menu.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["完整面板", "导航", "侧栏", "新建任务", "徽标", "入口"],
      "en-US": ["full panel", "navigation", "sidebar", "new task", "badge", "rail"],
    },
    relatedFeatureIds: ["core.global-search", "ux.custom-hotkeys"],
    relatedRouteIds: ["tasks", "agents", "actions", "clipboard", "settings"],
  },
  {
    id: "help.quickstart.capsule",
    categoryId: "quickstart",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "胶囊与贴边吸附：收纳与恢复",
        summary: "把窗口贴到屏幕边缘自动收纳成胶囊，拖离即可恢复完整面板；两种形态可切换。",
        sections: [
          {
            type: "paragraph",
            text: "贴边吸附默认开启。把主窗口拖到屏幕上/下/左/右边缘，窗口会自动停靠并按所选形态收纳。",
          },
          { type: "heading", text: "两种停靠形态" },
          {
            type: "steps",
            items: [
              "胶囊形态：停靠后只保留一条分类轨道与悬浮胶囊，节省屏幕空间。",
              "完整面板形态：停靠后保留完整面板，贴边对齐，适合固定在屏幕一角。",
              "切换形态：右键点击窗口标题栏或胶囊，选择「显示形态」；也可在设置中修改默认形态。",
            ],
          },
          { type: "heading", text: "恢复完整面板" },
          {
            type: "paragraph",
            text: "把胶囊从边缘拖离（按住胶囊或轨道拖动），窗口会恢复为自由位置的完整面板。拖离时窗口会锚定到光标位置，方便一步到位。",
          },
          {
            type: "note",
            text: "停靠位置跨重启保留。若恢复后窗口出现在显示器之外，task_dock 会把它收敛回可见区域，不会丢在屏幕外。",
          },
          {
            type: "tip",
            text: "不想吸附时，可在「设置 → 窗口」关闭贴边吸附；关闭后窗口始终自由摆放。",
          },
        ],
      },
      "en-US": {
        title: "Capsule and edge snapping: dock and restore",
        summary:
          "Snap the window to a screen edge to collapse it into a capsule; drag it away to restore the full panel.",
        sections: [
          {
            type: "paragraph",
            text: "Edge snapping is on by default. Drag the main window to the top/bottom/left/right edge of a screen and it docks into the shape you selected.",
          },
          { type: "heading", text: "Two docked shapes" },
          {
            type: "steps",
            items: [
              "Capsule shape: after docking only a category rail and the floating capsule remain, saving screen space.",
              "Full panel shape: the full panel stays visible and aligned to the edge — good for a fixed corner.",
              "Switch shapes: right-click the title bar or the capsule and choose the display shape, or change the default in Settings.",
            ],
          },
          { type: "heading", text: "Restore the full panel" },
          {
            type: "paragraph",
            text: "Drag the capsule away from the edge; the window returns to a free-floating full panel anchored to your cursor.",
          },
          {
            type: "note",
            text: "The docked position survives restarts. If a restored window would land off-screen, Task Dock pulls it back into a visible area.",
          },
          {
            type: "tip",
            text: "To disable snapping entirely, turn it off in Settings → Window; the window then stays free-floating.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["胶囊", "贴边", "吸附", "停靠", "收纳", "拖离", "轨道"],
      "en-US": ["capsule", "edge snap", "docking", "collapse", "restore", "rail"],
    },
    relatedFeatureIds: ["core.scenario-workspace"],
    relatedRouteIds: ["settings"],
  },
  {
    id: "help.quickstart.capture",
    categoryId: "quickstart",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "全局快速捕获：随手记不打断",
        summary: "任意界面按 Ctrl+Shift+Space 唤起独立捕获窗口，提交后主界面不展开。",
        sections: [
          {
            type: "paragraph",
            text: "快速捕获是一个独立的轻量窗口，用于在处理其他事情时随手记内容，不打断当前工作，也不会展开主界面。",
          },
          { type: "heading", text: "唤起与提交" },
          {
            type: "steps",
            items: [
              "任意界面按 Ctrl+Shift+Space（或托盘/右键菜单的「快速捕获」）唤起捕获窗口。",
              "选择类型：快速任务、简单待办、想法、文字片段或临时链接。",
              "输入内容；快速任务支持自然语言时间（如「明天下午三点」「每周一早上」）。",
              "回车提交：任务/待办直接建任务，想法、文字与链接进入收集箱。",
            ],
          },
          { type: "heading", text: "草稿与幂等" },
          {
            type: "paragraph",
            text: "输入内容会自动保存为草稿，程序异常退出后再次打开可恢复；提交在网络或程序重试时不会重复创建同一条任务。",
          },
          {
            type: "note",
            text: "再按一次 Ctrl+Shift+Space 会隐藏已聚焦的捕获窗口；提交成功后窗口自动收起，唤起前的前台窗口会尽量恢复焦点。",
          },
          {
            type: "tip",
            text: "在完整模式内想快速记一条，也可以用任务页顶部的快速录入框——它是同一能力的页面内子集。",
          },
        ],
      },
      "en-US": {
        title: "Global quick capture: jot without interrupting",
        summary:
          "Press Ctrl+Shift+Space anywhere to open the standalone capture window; the main window stays hidden.",
        sections: [
          {
            type: "paragraph",
            text: "Quick capture is a small standalone window for jotting things down while working in other apps — it never expands the main window.",
          },
          { type: "heading", text: "Open and submit" },
          {
            type: "steps",
            items: [
              "Press Ctrl+Shift+Space anywhere (or use the tray / right-click menu \"Quick capture\").",
              "Pick a type: quick task, simple to-do, idea, text snippet or link.",
              "Type your content; quick tasks accept natural-language times (like \"tomorrow 3pm\" or \"every Monday\").",
              "Press Enter to submit: tasks and to-dos become tasks; ideas, snippets and links go to the inbox.",
            ],
          },
          { type: "heading", text: "Drafts and idempotency" },
          {
            type: "paragraph",
            text: "Drafts save automatically and survive a crash; retries never create the same task twice.",
          },
          {
            type: "note",
            text: "Pressing Ctrl+Shift+Space again hides the focused capture window; after submitting, the window tucks away and the previously focused app regains focus when possible.",
          },
          {
            type: "tip",
            text: "Inside the full panel, the quick-add field at the top of the Tasks page is the in-page subset of the same ability.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["快速捕获", "Ctrl+Shift+Space", "捕获窗口", "草稿", "收集箱", "想法"],
      "en-US": ["quick capture", "hotkey", "draft", "inbox", "idea", "capture window"],
    },
    relatedFeatureIds: ["core.quick-capture"],
    relatedRouteIds: ["inbox", "tasks"],
  },
  {
    id: "help.quickstart.hotkeys",
    categoryId: "quickstart",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "常用快捷键速查",
        summary: "Ctrl+1…9/0 切换页面，Ctrl+K 新建任务，Ctrl+Shift+F 全局搜索；支持自定义。",
        sections: [
          { type: "heading", text: "页面切换" },
          {
            type: "steps",
            items: [
              "Ctrl+1 任务，Ctrl+2 Agent，Ctrl+3 行动，Ctrl+4 剪贴板。",
              "Ctrl+5 快速收集（收集箱），Ctrl+6 文件暂存。",
              "Ctrl+7 工作流，Ctrl+8 历史，Ctrl+9 规划中心，Ctrl+0 设置。",
            ],
          },
          { type: "heading", text: "全局操作" },
          {
            type: "paragraph",
            text: "Ctrl+K 新建任务；Ctrl+Shift+Space 快速捕获；Ctrl+Shift+F 全局搜索任务、剪贴板、应用、Agent 会话等八类内容。",
          },
          { type: "heading", text: "自定义快捷键" },
          {
            type: "steps",
            items: [
              "进入「设置 → 窗口与快捷键 → 快捷键」。",
              "点击要修改的动作，按下新组合键完成录制；录制时会即时提示冲突或系统占用。",
              "无修饰键的组合（如单个字母）会被拒绝；改键立即生效并跨重启保留。",
            ],
          },
          {
            type: "note",
            text: "应用、微件与帮助这三个视觉入口不占用 Ctrl+数字，已有快捷键语义不会因新增入口漂移。",
          },
        ],
      },
      "en-US": {
        title: "Handy keyboard shortcuts",
        summary:
          "Ctrl+1…9/0 switch pages, Ctrl+K creates a task, Ctrl+Shift+F opens global search; all customizable.",
        sections: [
          { type: "heading", text: "Switching pages" },
          {
            type: "steps",
            items: [
              "Ctrl+1 Tasks, Ctrl+2 Agents, Ctrl+3 Actions, Ctrl+4 Clipboard.",
              "Ctrl+5 Inbox (quick capture), Ctrl+6 File shelf.",
              "Ctrl+7 Workflows, Ctrl+8 History, Ctrl+9 Roadmap, Ctrl+0 Settings.",
            ],
          },
          { type: "heading", text: "Global actions" },
          {
            type: "paragraph",
            text: "Ctrl+K new task; Ctrl+Shift+Space quick capture; Ctrl+Shift+F searches tasks, clipboard, apps, agent sessions and more from one place.",
          },
          { type: "heading", text: "Custom shortcuts" },
          {
            type: "steps",
            items: [
              "Open \"Settings → Window & hotkeys → Shortcuts\".",
              "Click an action and press the new combination; conflicts and system usage are flagged while recording.",
              "Modifier-less combos (a single letter) are rejected; changes apply immediately and survive restarts.",
            ],
          },
          {
            type: "note",
            text: "Apps, Widgets and Help are visual-only entries and never take Ctrl+number shortcuts, so existing semantics never shift.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["快捷键", "Ctrl+K", "Ctrl+Shift+F", "自定义快捷键", "录制", "冲突"],
      "en-US": ["shortcuts", "hotkeys", "Ctrl+K", "Ctrl+Shift+F", "record", "conflict"],
    },
    relatedFeatureIds: ["ux.custom-hotkeys", "core.global-search"],
    relatedRouteIds: ["settings", "tasks"],
  },
  {
    id: "help.quickstart.help-center",
    categoryId: "quickstart",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "帮助与教程中心：找到你要的答案",
        summary: "搜索、分类浏览与上下文帮助按钮三种入口；每篇教程带状态徽标，如实标注覆盖范围。",
        sections: [
          { type: "heading", text: "打开帮助中心" },
          {
            type: "steps",
            items: [
              "左侧导航点「帮助」；也可以从设置页「帮助与教程」或业务页面里的「?」按钮打开。",
              "顶部搜索框按标题、关键词与正文匹配（中英文均可）；分类标签用于按主题浏览。",
              "从业务页「?」弹层进入时会带上来源页，帮助中心提供「返回来源页面」。",
            ],
          },
          { type: "heading", text: "读懂教程状态" },
          {
            type: "paragraph",
            text: "每篇教程显示状态徽标：已核对（与当前版本界面核对一致）、待复核（操作语义可能随版本演进）、草稿、暂不可用。文章头还显示适用版本与英文翻译状态——缺少英文版时明确显示「该教程暂无英文版」并回退中文，不伪称翻译完成。",
          },
          { type: "heading", text: "实用功能" },
          {
            type: "steps",
            items: [
              "「复制操作步骤」把当前文章的步骤导出为纯文本，方便贴给协作者。",
              "「相关功能」区域展示关联功能的当前实现状态，只有已实现功能可以点击跳转，待开发 / 受阻功能显示状态徽标而非死链接。",
              "「重新打开新手引导」随时回看三步入门引导。",
              "最近浏览记录保存在本机（上限 8 条），可一键清空。",
            ],
          },
          {
            type: "tip",
            text: "教程内容随功能演进持续校对；`npm run help:check` 在每次开发中检查引用有效性与覆盖缺口，失效引用会直接报错。",
          },
        ],
      },
      "en-US": {
        title: "Help center: find the answer you need",
        summary:
          "Three ways in — search, category browsing and the \"?\" context button; every guide carries a status badge that states its coverage honestly.",
        sections: [
          { type: "heading", text: "Opening the help center" },
          {
            type: "steps",
            items: [
              "Click \"Help\" in the left navigation; you can also enter from \"Settings → Help and tutorials\" or the \"?\" button inside a feature page.",
              "The search box matches titles, keywords and body text (Chinese or English); category chips browse by topic.",
              "Entering from a page's \"?\" popover carries the source page, and the help center offers \"Return to source page\".",
            ],
          },
          { type: "heading", text: "Reading guide status" },
          {
            type: "paragraph",
            text: "Each guide shows a status badge: Verified (checked against the current UI), Needs review (operations may shift as versions evolve), Draft and Unavailable. The header also shows the applicable version and translation state — when an English version is missing it says so plainly and falls back to Chinese instead of pretending the translation exists.",
          },
          { type: "heading", text: "Handy features" },
          {
            type: "steps",
            items: [
              "\"Copy steps\" exports the guide's steps as plain text to share with collaborators.",
              "The \"Related features\" area shows each linked feature's real implementation status; only implemented features are clickable, while planned / blocked ones show a status badge instead of a dead link.",
              "\"Reopen the getting-started tour\" replays the three-step introduction any time.",
              "Recently viewed guides are stored locally (up to 8) and can be cleared in one click.",
            ],
          },
          {
            type: "tip",
            text: "Guide content is continuously re-checked as features evolve; `npm run help:check` validates references and coverage during development and fails loudly on broken references.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["帮助", "教程", "搜索", "状态徽标", "复制步骤", "相关功能"],
      "en-US": ["help", "guide", "tutorial", "search", "status badge", "copy steps", "related features"],
    },
    relatedFeatureIds: ["ux.help-center"],
    relatedRouteIds: ["help", "settings"],
  },
  {
    id: "help.quickstart.onboarding",
    categoryId: "quickstart",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "首次使用引导：三步入门",
        summary: "首次启动自动出现的三步页内引导，可跳过可返回；升级不重播，随时可从帮助中心重开。",
        sections: [
          { type: "heading", text: "引导长什么样" },
          {
            type: "paragraph",
            text: "引导是右下角的页内卡片（不是全屏弹窗），不抢占焦点，不创建任何业务数据——每一步的按钮只做页面跳转。仅完整模式显示；停靠或胶囊形态下不会出现。",
          },
          { type: "heading", text: "三步内容" },
          {
            type: "steps",
            items: [
              "第一步「认识 task_dock」：了解主界面结构。",
              "第二步「完成第一个任务」：一键跳到任务页快速录入（「去创建任务」）。",
              "第三步「按需启用功能」：打开设置选择要启用的模块（「打开设置」）。",
            ],
          },
          { type: "heading", text: "跳过、返回与重开" },
          {
            type: "steps",
            items: [
              "「上一步 / 下一步」自由流转；「跳过引导」立即结束，之后不再自动弹出。",
              "按 Escape 等价于跳过；一次按键只处理引导这一层，不会误关其他弹层。",
              "想再看一遍：帮助中心或「设置 → 帮助与教程」的「重新打开新手引导」。",
            ],
          },
          {
            type: "note",
            text: "引导升级后不会自动重播打扰老用户：新版本只会在帮助中心显示「有新内容」红点，由你决定是否重看。",
          },
        ],
      },
      "en-US": {
        title: "Getting-started tour: three steps in",
        summary:
          "A three-step in-page tour appears on first launch; skip or move freely, upgrades never replay it, and you can reopen it from the help center.",
        sections: [
          { type: "heading", text: "What the tour looks like" },
          {
            type: "paragraph",
            text: "The tour is an in-page card at the bottom-right (not a full-screen modal); it never steals focus and never creates business data — every step's button only navigates. It shows in full mode only and never appears while docked as a capsule.",
          },
          { type: "heading", text: "The three steps" },
          {
            type: "steps",
            items: [
              "Step 1, \"Meet Task Dock\": a quick look at the main layout.",
              "Step 2, \"Create your first task\": one click to the Tasks page quick-add (\"Create a task\").",
              "Step 3, \"Turn on what you need\": open Settings and pick the modules you want (\"Open settings\").",
            ],
          },
          { type: "heading", text: "Skip, go back and reopen" },
          {
            type: "steps",
            items: [
              "\"Back / Next\" moves freely; \"Skip tour\" ends it immediately and it will not auto-appear again.",
              "Escape is equivalent to skipping; one keypress handles only the tour layer, never closing other popovers by mistake.",
              "To watch it again: \"Reopen the getting-started tour\" in the help center or in \"Settings → Help and tutorials\".",
            ],
          },
          {
            type: "note",
            text: "After an upgrade the tour never auto-replays at existing users: a new version only lights up a \"new content\" dot in the help center, and replaying stays your call.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["引导", "新手", "首次启动", "跳过", "重新打开引导", "三步"],
      "en-US": ["onboarding", "getting started", "first launch", "skip", "reopen tour", "three steps"],
    },
    relatedFeatureIds: ["ux.onboarding"],
    relatedRouteIds: ["help", "settings"],
  },
];
