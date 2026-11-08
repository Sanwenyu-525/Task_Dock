//! 故障排查类教程（4 篇，均 verified 且自带 en-US；notification-aggregation 2026-11-08 新增）。
//! - feature-status：教用户识别「功能未开发 / 受阻 / 入口被隐藏」的正确状态；
//! - agent-no-events：2026-11-08 按 AgentPanel/ActionCenterPanel/managed.rs 当前源码复核后转 verified；
//! - backup：备份与恢复口径；
//! - notification-aggregation：只写已交付能力（双额度限流/合并摘要/静音/历史持久化）。

import type { HelpArticle } from "../types";

export const TROUBLESHOOTING_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.troubleshooting.feature-status",
    categoryId: "troubleshooting",
    status: "verified",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "为什么某个功能找不到或不可用",
        summary: "区分四种情况：入口被隐藏、部分实现、待开发、受阻——各有的正确处理方式。",
        sections: [
          { type: "heading", text: "先检查入口是否被隐藏" },
          {
            type: "steps",
            items: [
              "打开侧栏底部的「更多」菜单：被隐藏的入口会列在这里，当前页会以选中态标出。",
              "想恢复常驻：进入「设置 → 自定义导航」打开对应开关。",
            ],
          },
          { type: "heading", text: "再看功能的实现状态" },
          {
            type: "paragraph",
            text: "「规划中心」页列出全部功能与状态：已实现（可用）、部分实现（已有能力 + 剩余缺口都会写明）、待开发（仅登记规划，不代表可以提前使用）、受阻（等外部接口或平台条件）。帮助中心的文章徽标与规划中心口径一致。",
          },
          { type: "heading", text: "常见误区" },
          {
            type: "steps",
            items: [
              "「进入场景」工作流步骤：需要先在「工作流 → 场景工作区」创建场景；场景不存在或会形成场景/工作流循环时保存会被拒绝，这是引用校验，不是故障。",
              "系统级拖出暂存文件：WebView2/OLE 通道未实现前请用「复制路径 / 复制文件 / 所在文件夹」替代。",
              "节假日调休：按设计不接节假日 API，重复规则的「工作日」基于自然周。",
            ],
          },
          {
            type: "tip",
            text: "对于待开发 / 受阻功能，帮助中心的相关功能区域会显示状态徽标而不是死链接；点击已实现功能才会跳转对应页面。",
          },
        ],
      },
      "en-US": {
        title: "Why a feature is missing or unavailable",
        summary:
          "Tell four cases apart: hidden entry, partial, planned, blocked — each has the right next step.",
        sections: [
          { type: "heading", text: "First check whether the entry is hidden" },
          {
            type: "steps",
            items: [
              "Open the \"More\" menu at the bottom of the rail: hidden entries are listed there, with the current page checked.",
              "To pin it back: open \"Settings → Customize navigation\" and flip the switch.",
            ],
          },
          { type: "heading", text: "Then check the feature status" },
          {
            type: "paragraph",
            text: "The Roadmap page lists every feature and its status: implemented (usable), partial (existing abilities and remaining gaps are both spelled out), planned (registered only — not usable ahead of delivery) and blocked (waiting on external APIs or platform conditions). Help-center badges use the same scale.",
          },
          { type: "heading", text: "Common misunderstandings" },
          {
            type: "steps",
            items: [
              "The \"Enter scene\" workflow step needs a scene created under Workflows → Scenarios first; saving is rejected when the scene is missing or would form a scene/workflow cycle — that is reference validation, not a bug.",
              "System-level drag-out of shelf files: until the OLE channel exists, use \"Copy path / Copy file / Reveal in folder\".",
              "Public holidays: by design no holiday API is used; \"weekday\" in repeat rules means natural weeks.",
            ],
          },
          {
            type: "tip",
            text: "For planned / blocked features the help center shows a status badge instead of a dead link; clicking works only for implemented ones.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["找不到", "不可用", "隐藏", "待开发", "受阻", "部分实现", "规划中心", "状态"],
      "en-US": ["missing", "unavailable", "hidden", "planned", "blocked", "partial", "roadmap", "status"],
    },
    relatedFeatureIds: ["eco.plugins", "eco.sync", "core.scenario-workspace", "core.file-shelf"],
    relatedRouteIds: ["roadmap", "settings"],
  },
  {
    id: "help.troubleshooting.agent-no-events",
    categoryId: "troubleshooting",
    status: "verified",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "Agent 已接入但看不到事件",
        summary: "按「会话时机 → 链路自测 → 行动中心 → 历史」四步排查。",
        sections: [
          { type: "heading", text: "第一步：会话时机" },
          {
            type: "paragraph",
            text: "Hooks 在会话启动时加载：安装后必须**新开**一个 Agent 会话，已经打开的会话不会热加载 hooks，因此不会产生事件。",
          },
          { type: "heading", text: "第二步：链路自测" },
          {
            type: "steps",
            items: [
              "在 Agent 页对应卡片点「验证」，task_dock 会做一次 nonce 入库自测。",
              "自测失败时按卡片提示检查：CLI 是否在 PATH、配置文件是否被其他工具占用。",
            ],
          },
          { type: "heading", text: "第三步：看对地方" },
          {
            type: "steps",
            items: [
              "「行动」页「需介入」：等待授权 / 等待输入 / 失败聚合在这里。",
              "「历史」页：全部事件时间轴，确认事件是否到达但被过滤器隐藏。",
              "Agent 面板会话列表：确认会话与来源匹配；真实与模拟来源在统计中是隔离的。",
            ],
          },
          { type: "heading", text: "第四步：状态语义" },
          {
            type: "paragraph",
            text: "事件结束后状态如实显示；拿不到退出码等信息时显示「未知」而不是猜测。Gemini CLI 的 SessionEnd 是 best-effort，未触发时由进程旁路兜底。",
          },
          {
            type: "note",
            text: "卸载重装 hooks 不会清掉历史事件；「显示已确认」可以回看被你确认过的需介入事项。",
          },
        ],
      },
      "en-US": {
        title: "Agent onboarded but no events show up",
        summary: "Troubleshoot in four steps: session timing → link self-test → action center → history.",
        sections: [
          { type: "heading", text: "Step 1: session timing" },
          {
            type: "paragraph",
            text: "Hooks load when a session starts: after installing you must start a NEW agent session; already-open sessions do not hot-load hooks and therefore produce no events.",
          },
          { type: "heading", text: "Step 2: link self-test" },
          {
            type: "steps",
            items: [
              "Click \"Verify\" on the matching card on the Agents page; Task Dock runs a nonce-based database self-test.",
              "If the self-test fails, follow the card's hints: is the CLI on PATH, and is the config file held by another tool?",
            ],
          },
          { type: "heading", text: "Step 3: look in the right place" },
          {
            type: "steps",
            items: [
              "The Actions page, \"Needs intervention\": waiting for authorization / waiting for input / failures aggregate here.",
              "The History page: the full event timeline — check whether events arrived but are hidden by a filter.",
              "The agent panel's session list: confirm the session and source match; real and mock sources stay separated in statistics.",
            ],
          },
          { type: "heading", text: "Step 4: status semantics" },
          {
            type: "paragraph",
            text: "After events end, status is reported as-is; when details like exit codes cannot be obtained it shows \"Unknown\" instead of guessing. Gemini CLI's SessionEnd is best-effort; when it does not fire, a process-side fallback covers it.",
          },
          {
            type: "note",
            text: "Uninstalling and reinstalling hooks never clears past events; \"Show confirmed\" revisits intervention items you already confirmed.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["Agent", "没有事件", "排查", "自测", "验证", "需介入", "未知", "SessionEnd"],
      "en-US": ["agent", "no events", "troubleshooting", "self-test", "verify", "needs intervention", "unknown", "SessionEnd"],
    },
    relatedFeatureIds: ["core.agent-action-center", "agent.execution-timeline"],
    relatedRouteIds: ["agents", "actions", "history"],
  },
  {
    id: "help.troubleshooting.backup",
    categoryId: "troubleshooting",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "备份与恢复：数据在哪些环节受保护",
        summary: "每日自动备份 + 手动下载；恢复覆盖前有确认，剪贴板正文与密钥永不入备份日志。",
        sections: [
          { type: "heading", text: "备份里有什么" },
          {
            type: "paragraph",
            text: "完整备份覆盖任务、剪贴板索引、暂存架（托管副本全量打包）、笔记、工作流、专注统计、导航与语言偏好等；快速备份只覆盖核心业务表。剪贴板正文与图片不进入可提交日志，凭据类数据不落备份清单。",
          },
          { type: "heading", text: "手动备份与恢复" },
          {
            type: "steps",
            items: [
              "「设置 → 数据」中可立即创建备份并下载到任意位置。",
              "恢复前界面会列出将覆盖的表与版本；确认后才执行。",
              "恢复旧备份缺某张表时按空表处理，不会中断；快捷键配置恢复时逐项重新校验，冲突的键降级或禁用并明确警告，不伪装成功。",
            ],
          },
          {
            type: "note",
            text: "备份 manifest 带版本号：旧版本 task_dock 恢复新备份时会在结构不识别处明确报错，而不是静默丢数据。升级前建议先做一次手动备份。",
          },
          {
            type: "tip",
            text: "每日自动备份默认开启；数据目录可用「设置 → 数据」中的隔离实例入口另行指定（TASK_DOCK_DATA_DIR），适合多开测试。",
          },
        ],
      },
      "en-US": {
        title: "Backup and restore: where your data is protected",
        summary:
          "Daily automatic backups plus manual download; restores confirm before overwriting, and clipboard content or secrets never enter backup logs.",
        sections: [
          { type: "heading", text: "What a backup contains" },
          {
            type: "paragraph",
            text: "A full backup covers tasks, clipboard index, the shelf (managed copies packaged in full), notes, workflows, focus statistics, navigation and language preferences and more; a quick backup covers core business tables only. Clipboard content and images never enter submittable logs, and credential-like data stays out of the backup manifest.",
          },
          { type: "heading", text: "Manual backup and restore" },
          {
            type: "steps",
            items: [
              "In \"Settings → Data & backup\" you can create a backup immediately and download it anywhere.",
              "Before a restore, the UI lists the tables and versions that will be overwritten; nothing happens until you confirm.",
              "Restoring an older backup that lacks a table treats it as empty instead of aborting; hotkey configs are re-validated item by item, with conflicting keys degraded or disabled and clearly warned — success is never faked.",
            ],
          },
          {
            type: "note",
            text: "The backup manifest carries a version: an older Task Dock restoring a newer backup fails loudly at unknown structures instead of silently dropping data. Make a manual backup before upgrading.",
          },
          {
            type: "tip",
            text: "Daily automatic backup is on by default; the data directory can be redirected for isolated instances via the entry in \"Settings → Data & backup\" (TASK_DOCK_DATA_DIR), handy for multi-instance testing.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["备份", "恢复", "数据", "manifest", "隔离实例", "清单", "快速备份"],
      "en-US": ["backup", "restore", "data", "manifest", "isolated instance", "quick backup"],
    },
    relatedFeatureIds: [],
    relatedRouteIds: ["settings"],
  },
  {
    id: "help.troubleshooting.notification-aggregation",
    categoryId: "troubleshooting",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "通知去哪了：合并、限流与静音",
        summary: "通知没有逐条弹出不是丢失：关键通知有保底额度，普通通知合并为摘要，历史始终全量记录。",
        sections: [
          { type: "heading", text: "通知的分类与额度" },
          {
            type: "paragraph",
            text: "通知分两类：等待授权 / 失败 / 断连是**关键通知**，拥有独立的保底弹窗额度，不会被普通通知挤占；执行中 / 完成 / 任务提醒是**可合并通知**，走自己的独立额度。两类额度都有上界，不会无限弹窗。",
          },
          { type: "heading", text: "为什么会看到摘要而不是逐条通知" },
          {
            type: "steps",
            items: [
              "同一批出现多条可合并通知（如连续完成任务）时，合并为一条摘要弹出。",
              "被限流抑制的通知在限流窗口结束时汇总为一条「窗口尾摘要」，每个窗口最多一条摘要。",
              "被合并或抑制的通知并没有丢：全部进入通知历史。",
            ],
          },
          { type: "heading", text: "在哪里查看与调整" },
          {
            type: "steps",
            items: [
              "「历史」页（Ctrl+8）：通知与 Agent 事件统一时间轴；点击通知标记已读，可全部已读或清空（清空需二次确认，Agent 事件流水保留）。",
              "「设置 → 通知」：任务提醒与 Agent 状态分类开关、全部静音（仍记录到收件箱）、限流窗口与独立弹窗上限。",
              "「行动」页：需介入事项始终优先呈现，不会被合并或静音吞掉。",
            ],
          },
          {
            type: "note",
            text: "全部静音只影响弹窗，不影响记录：静音期间的通知仍完整进入历史。关键通知（等待 / 失败 / 断连）即使在普通通知刷满额度后仍可及时弹出。",
          },
        ],
      },
      "en-US": {
        title: "Where did my notifications go: merging, rate limits and mute",
        summary:
          "Notifications not popping one by one is not data loss: critical notifications keep a reserved quota, ordinary ones merge into summaries, and history always records everything.",
        sections: [
          { type: "heading", text: "Notification classes and quotas" },
          {
            type: "paragraph",
            text: "Notifications come in two classes: waiting-for-authorization / failure / disconnect are critical notifications with their own reserved popup quota that ordinary notifications can never crowd out; running / completion / task reminders are mergeable notifications with their own separate quota. Both quotas are bounded — popups can never flood.",
          },
          { type: "heading", text: "Why you see a summary instead of separate popups" },
          {
            type: "steps",
            items: [
              "When several mergeable notifications appear in one batch (like tasks completing back to back), they merge into one summary popup.",
              "Notifications suppressed by rate limiting are aggregated into one end-of-window summary when the window closes; at most one summary per window.",
              "Merged or suppressed notifications are never lost: they all land in the notification history.",
            ],
          },
          { type: "heading", text: "Where to look and tune" },
          {
            type: "steps",
            items: [
              "The \"History\" page (Ctrl+8): one timeline for notifications and agent events; click a notification to mark it read, mark all read, or clear (clearing asks twice, and agent event records are kept).",
              "\"Settings → Notifications\": category switches for task reminders and agent status, mute everything (still recorded in the inbox), rate-limit window and max separate popups.",
              "The \"Actions\" page: items needing intervention always surface first and are never swallowed by merging or muting.",
            ],
          },
          {
            type: "note",
            text: "Mute everything only affects popups, not recording: notifications during a mute still reach history in full. Critical notifications (waiting / failure / disconnect) still pop up promptly even after the ordinary quota is exhausted.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["通知", "合并", "限流", "静音", "摘要", "历史", "已读"],
      "en-US": ["notification", "merge", "rate limit", "mute", "summary", "history", "read"],
    },
    relatedFeatureIds: ["core.notification-aggregation"],
    relatedRouteIds: ["history", "settings"],
  },
];
