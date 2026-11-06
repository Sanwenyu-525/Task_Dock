//! 快速入门类教程（4 篇，均 verified 且自带 en-US 翻译）。
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
];
