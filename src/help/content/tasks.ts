//! 任务与提醒类教程（2 篇，verified，均自带 en-US）。

import type { HelpArticle } from "../types";

export const TASKS_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.tasks.create-reminders",
    categoryId: "tasks",
    status: "verified",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "创建任务与自然语言提醒",
        summary: "一句话建任务：自动解析时间、重复规则与提前提醒；到期可延后、可撤销。",
        sections: [
          { type: "heading", text: "用自然语言创建" },
          {
            type: "steps",
            items: [
              "按 Ctrl+K（或点击导航顶部「+」）切到任务页快速录入框。",
              "直接输入一句话，例如「明天下午三点提醒我开会」「每周一早上整理工作」「30 分钟后提醒我休息」「每月 5 日提醒我缴费」。",
              "回车创建：日期、时刻、相对时间、重复与提前提醒会自动解析并显示在任务上。",
            ],
          },
          { type: "heading", text: "重复与高级规则" },
          {
            type: "paragraph",
            text: "编辑任务时可以在重复规则中选择每天 / 每 N 日 / 每周多日 / 每 N 周 / 每月几日 / 每 N 月，以及「每月第 N 个星期X」「每月最后一个工作日」等高级规则，保存前有中文预览。完成一次重复任务后，下一期自动推进。",
          },
          { type: "heading", text: "快捷提醒与倒计时" },
          {
            type: "paragraph",
            text: "任务卡与任务详情提供 5/10/15/30 分钟、1 小时与自定义时分的快捷提醒；到期前会弹出系统通知，通知里可以「查看任务」「稍后提醒」或「完成任务」。",
          },
          { type: "heading", text: "延后与撤销" },
          {
            type: "paragraph",
            text: "延后入口在任务卡、任务详情与任务通知三处（5/10/30 分钟、1 小时或自定义）。延后成功会弹出带「撤销」的提示；若延后后任务又被修改或触发，撤销会如实提示失效，不会覆盖新状态。",
          },
          { type: "heading", text: "提醒联动场景 / 现场" },
          {
            type: "steps",
            items: [
              "打开任务上下文抽屉（任务卡上的上下文入口），找到「提醒联动」区。",
              "点「关联场景…」或「关联现场…」，从列表中选择一个目标；一个任务只关联一个，重复选择会覆盖。",
              "该任务提醒触发时，通知卡会出现「进入场景」或「恢复现场」按钮——只在你点击时才执行，绝不会自动启动。",
              "不需要时点「清除」；关联的场景或现场被删除后，通知不再显示对应按钮。",
            ],
          },
          {
            type: "note",
            text: "节假日调休按设计不接入节假日 API：「工作日」语义基于自然周，请按实际日期设置重复。",
          },
        ],
      },
      "en-US": {
        title: "Create tasks and natural-language reminders",
        summary:
          "Create a task from one sentence: time, repeat rules and lead-time reminders are parsed automatically; snooze or undo when due.",
        sections: [
          { type: "heading", text: "Create with natural language" },
          {
            type: "steps",
            items: [
              "Press Ctrl+K (or click \"+\" at the top of the navigation) to jump to the quick-add field on the Tasks page.",
              "Type one sentence, for example \"remind me about the meeting tomorrow at 3pm\", \"tidy up work every Monday morning\", \"remind me to take a break in 30 minutes\" or \"remind me to pay the bill on the 5th every month\".",
              "Press Enter to create: dates, times of day, relative times, repeats and lead-time reminders are parsed automatically and shown on the task.",
            ],
          },
          { type: "heading", text: "Repeats and advanced rules" },
          {
            type: "paragraph",
            text: "While editing a task, the repeat rule offers every day / every N days / several weekdays / every N weeks / several days per month / every N months, plus advanced rules such as \"the Nth weekday of the month\" and \"the last weekday of the month\", with a readable preview before saving. Completing a repeating task advances it to the next occurrence automatically.",
          },
          { type: "heading", text: "Quick reminders and countdown" },
          {
            type: "paragraph",
            text: "Task cards and the task detail offer quick reminders for 5/10/15/30 minutes, 1 hour and a custom time; when due, a system notification pops up where you can view the task, snooze it or complete it.",
          },
          { type: "heading", text: "Snooze and undo" },
          {
            type: "paragraph",
            text: "The snooze entry lives in three places: the task card, the task detail and the task notification (5/10/30 minutes, 1 hour or a custom time). A successful snooze shows a toast with \"Undo\"; if the task was edited or fired again after snoozing, undo honestly reports that it no longer applies instead of overwriting the newer state.",
          },
          { type: "heading", text: "Link reminders to a scene or workspace" },
          {
            type: "steps",
            items: [
              "Open the task context drawer from a task card and find the \"Reminder linkage\" section.",
              "Click \"Link a scene…\" or \"Link a workspace…\" and pick one target; a task keeps at most one link and picking again replaces it.",
              "When the task reminder fires, the notification card shows an \"Enter scene\" or \"Restore workspace\" button — it only runs when you click it, never automatically.",
              "Click \"Clear\" when you no longer need it; if the linked scene or workspace is deleted, the button disappears from the notification.",
            ],
          },
          {
            type: "note",
            text: "By design, public holidays are not integrated (no holiday API): \"weekday\" in repeat rules means natural weeks, so set repeats by actual dates.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["任务", "提醒", "自然语言", "重复", "倒计时", "延后", "撤销", "提前提醒"],
      "en-US": ["task", "reminder", "natural language", "repeat", "countdown", "snooze", "undo", "lead time"],
    },
    relatedFeatureIds: ["core.smart-reminders"],
    relatedRouteIds: ["tasks"],
  },
  {
    id: "help.tasks.stats-focus",
    categoryId: "tasks",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "任务统计与专注计时",
        summary: "任务页右上角查看完成率与趋势统计，或开启专注计时并关联当前任务。",
        sections: [
          { type: "heading", text: "任务统计" },
          {
            type: "steps",
            items: [
              "进入任务页，点击右上角「任务统计」。",
              "按日 / 周 / 月切换范围，查看待办、今日到期、逾期计数与完成率、逾期率。",
              "趋势图展示完成与逾期走向，分类效率帮助定位哪类任务最容易拖期。",
            ],
          },
          {
            type: "note",
            text: "重复任务被自动推进、跳期补偿或主动改期后，无法还原的期次会明确标注「不完整统计」，不会伪造分母。",
          },
          { type: "heading", text: "专注与休息" },
          {
            type: "steps",
            items: [
              "点击任务页右上角「专注与休息」。",
              "选择番茄钟或正计时开始；可暂停、继续、完成或取消。",
              "可在专注中关联任务：完成后历史里仍能看到任务标题（任务删除不影响历史）。",
              "会话结束自动进入休息，可延长或跳过；久坐提醒可在偏好中关闭或稍后提醒。",
            ],
          },
          {
            type: "paragraph",
            text: "专注进行中，完整模式的悬浮胶囊会显示当前阶段与剩余时间；每日专注记录与历史在专注页查看，按本地日期聚合。",
          },
          {
            type: "tip",
            text: "计时跨窗口隐藏 / 恢复保持正确；程序被强杀后重启，会话按「应用重启」自动暂停，不补记退出区间。",
          },
        ],
      },
      "en-US": {
        title: "Task analytics and focus timer",
        summary:
          "Check completion rates and trends from the Tasks page, or start a focus session linked to the current task.",
        sections: [
          { type: "heading", text: "Task analytics" },
          {
            type: "steps",
            items: [
              "Open the Tasks page and click \"Task analytics\" in the top-right corner.",
              "Switch between day / week / month ranges to see to-do, due-today and overdue counts plus completion and overdue rates.",
              "Trend charts show how completions and overdue items move; category efficiency helps locate which kind of task slips the most.",
            ],
          },
          {
            type: "note",
            text: "After repeating tasks are auto-advanced, gap-compensated or rescheduled, occurrences that cannot be reconstructed are clearly marked as \"incomplete statistics\" — the denominator is never faked.",
          },
          { type: "heading", text: "Focus and break" },
          {
            type: "steps",
            items: [
              "Click \"Focus & break\" in the top-right corner of the Tasks page.",
              "Choose a pomodoro or a count-up timer to start; pause, resume, finish or cancel at any time.",
              "You can link a task while focusing: the task title stays visible in history afterwards (deleting the task does not affect history).",
              "A break starts automatically when a session ends and can be extended or skipped; sedentary reminders can be turned off or snoozed in preferences.",
            ],
          },
          {
            type: "paragraph",
            text: "While a focus session runs, the floating capsule in full mode shows the current phase and remaining time. Daily focus records and history live on the focus page, grouped by local date.",
          },
          {
            type: "tip",
            text: "Timing stays correct across window hide/restore. After a forced kill and restart, the session is auto-paused as \"app restarted\" — the gap is never back-filled.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["任务统计", "完成率", "趋势", "专注", "番茄钟", "休息", "久坐提醒"],
      "en-US": ["task analytics", "completion rate", "trend", "focus", "pomodoro", "break", "sedentary reminder"],
    },
    relatedFeatureIds: ["tasks.stats-trends", "core.focus-timer"],
    relatedRouteIds: ["tasks"],
  },
];
