//! Agent 管理类教程（2 篇）。
//! 注意：help.agents.mcp-authorization 描述的 MCP 授权功能在本文撰写时仍在开发中
//! （另一任务并行实现），故 status=needs_review，正文只描述设计目标并明确标注
//! 「功能开发中」，不描述不存在的 UI。

import type { HelpArticle } from "../types";

export const AGENTS_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.agents.hooks-onboarding",
    categoryId: "agents",
    status: "verified",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "接入 Agent：检测与 Hooks 安装",
        summary: "Agent 页自动检测本机 CLI，按卡片引导安装官方 Hooks，一键验证或卸载。",
        sections: [
          { type: "heading", text: "检测与接入" },
          {
            type: "steps",
            items: [
              "进入「Agent」页，task_dock 会自动检测本机已安装的 Claude Code / Cursor / Gemini CLI / ZCode / Codex。",
              "点击对应卡片上的「接入」：task_dock 只向该工具自己的用户级配置（如 ~/.claude/settings.json、~/.cursor/hooks.json）写入官方 Hooks 事件，写入前自动备份，失败会回滚。",
              "接入完成后点击「验证」做链路自测；真实事件要在该工具**新开会话**后才会产生（已打开的会话不会热加载 hooks）。",
              "不再使用时点「卸载」，只移除 task_dock 写入的条目，用户已有 hooks 原样保留。",
            ],
          },
          { type: "heading", text: "查看状态与授权" },
          {
            type: "paragraph",
            text: "Agent 运行中需要你确认（等待授权）或输入时，会聚合到「行动」页的「需介入」分类；点击条目可跳转对应会话处理。事件结束后状态如实显示，无法获取的显示「未知」，不会虚构。",
          },
          { type: "heading", text: "统计与历史" },
          {
            type: "steps",
            items: [
              "Agent 页「统计」标签：按来源与会话查看近 7 / 30 天的执行时长、等待时长与失败率，真实与模拟数据隔离。",
              "「历史」页：通知与 Agent 事件统一时间轴，可按来源 / 类型 / 时间过滤。",
            ],
          },
          {
            type: "note",
            text: "Hook 的信任与权限确认始终由 CLI 工具自身完成；task_dock 只读取事件，不代替你授权。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["Agent", "接入", "Hooks", "Claude Code", "Cursor", "Gemini", "ZCode", "Codex", "检测", "授权", "统计"],
    },
    relatedFeatureIds: [
      "core.agent-action-center",
      "agent.claude-code-adapter",
      "agent.cursor-adapter",
      "agent.gemini-cli",
      "agent.zcode-integration",
      "agent.work-time-stats",
    ],
    relatedRouteIds: ["agents", "actions", "history"],
  },
  {
    id: "help.agents.mcp-authorization",
    categoryId: "agents",
    status: "needs_review",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "MCP 服务器授权（功能开发中）",
        summary:
          "通过 MCP 授权管理让 Agent 在受控范围内调用 task_dock 能力；该功能正在开发中，本文随功能落地复核更新。",
        sections: [
          {
            type: "callout",
            text: "功能开发中：MCP 授权管理尚未随当前版本发布，下文描述的是设计目标，实际界面与步骤以功能发布后的版本为准。发布后本文会重新核对并转为「已核对」。",
          },
          { type: "heading", text: "设计目标" },
          {
            type: "paragraph",
            text: "MCP（Model Context Protocol）授权管理的目标是：让受支持的 Agent 通过 MCP 有限地调用 task_dock 的查询与操作能力（如查询任务、读取剪贴板元数据），而不是暴露完整数据库。",
          },
          { type: "heading", text: "计划中的边界" },
          {
            type: "steps",
            items: [
              "授权开关默认关闭；开启前列出将暴露的能力清单，由你逐项确认。",
              "授权可随时撤销；撤销后 Agent 侧调用立即失败并给出可读错误。",
              "所有经 MCP 的调用走现有事件管线与审计记录，不绕过行动中心。",
            ],
          },
          {
            type: "note",
            text: "在功能发布前，任何声称「已授权 MCP」的第三方教程均不适用于当前版本。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["MCP", "授权", "开发中", "Model Context Protocol", "Agent 能力"],
    },
    relatedFeatureIds: [],
    relatedRouteIds: ["agents"],
  },
];
