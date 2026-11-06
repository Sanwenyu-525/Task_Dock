//! 故障排查类教程（3 篇）。
//! - feature-status：verified（自带 en-US）——教用户识别「功能未开发 / 受阻 / 入口被隐藏」的正确状态；
//! - agent-no-events：needs_review——排查路径需真机复核后转 verified；
//! - backup：verified。

import type { HelpArticle } from "../types";

export const TROUBLESHOOTING_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.troubleshooting.feature-status",
    categoryId: "troubleshooting",
    status: "verified",
    contentVersion: 1,
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
              "「进入场景」工作流步骤：场景工作区未落地前该步骤会被拒绝执行，属于预期保护，不是故障。",
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
              "The \"Enter scene\" workflow step is rejected until the scenario workspace ships — that is protection, not a bug.",
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
    status: "needs_review",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "Agent 已接入但看不到事件",
        summary: "按「会话时机 → 链路自测 → 行动中心 → 历史」四步排查；本文待真机复核后转已核对。",
        sections: [
          {
            type: "callout",
            text: "本文状态为「待复核」：排查路径基于当前实现整理，个别界面细节需在真机会话中复核后更新。",
          },
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
    },
    keywords: {
      "zh-CN": ["Agent", "没有事件", "排查", "自测", "验证", "需介入", "未知", "SessionEnd"],
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
    },
    keywords: {
      "zh-CN": ["备份", "恢复", "数据", "manifest", "隔离实例", "清单", "快速备份"],
    },
    relatedFeatureIds: [],
    relatedRouteIds: ["settings"],
  },
];
