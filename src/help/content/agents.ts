//! Agent 管理类教程（2 篇，均自带 en-US）。
//! mcp-authorization：正文已按 2026-11-08 当前源码（McpAccessSection / mcp 模块）复核并更新；
//! 真实独立客户端（MCP Inspector）端到端联调已通过，编码 Agent 客户端握手差异尚未实测，
//! 且敏感契约源文件（src-tauri/src/db/mod.rs）有并行在途改动——按门禁规则保持 needs_review。

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
      "en-US": {
        title: "Onboard an agent: detection and hooks install",
        summary:
          "The Agents page detects local CLIs automatically and walks you through installing official hooks, with one-click verify or uninstall.",
        sections: [
          { type: "heading", text: "Detect and onboard" },
          {
            type: "steps",
            items: [
              "Open the \"Agents\" page: Task Dock automatically detects locally installed Claude Code / Cursor / Gemini CLI / ZCode / Codex.",
              "Click \"Onboard\" on the matching card: Task Dock writes only the official hooks events into that tool's own user-level config (such as ~/.claude/settings.json or ~/.cursor/hooks.json). It backs up before writing and rolls back on failure.",
              "After onboarding, click \"Verify\" for a link self-test; real events only appear after you start a NEW session in that tool (already-open sessions do not hot-load hooks).",
              "When you stop using it, click \"Uninstall\": only the entries Task Dock wrote are removed; your existing hooks stay untouched.",
            ],
          },
          { type: "heading", text: "Status and interventions" },
          {
            type: "paragraph",
            text: "When a running agent needs your confirmation (waiting for authorization) or input, it is aggregated under \"Needs intervention\" on the Actions page; click an entry to jump to the session and handle it. After events end, status is reported as-is; values that cannot be obtained are shown as \"Unknown\", never invented.",
          },
          { type: "heading", text: "Statistics and history" },
          {
            type: "steps",
            items: [
              "The \"Statistics\" tab on the Agents page shows run time, waiting time and failure rate for the last 7 / 30 days by source and session; real and mock data stay separated.",
              "The \"History\" page shows notifications and agent events on one timeline, filterable by source / type / time.",
            ],
          },
          {
            type: "note",
            text: "Hook trust and permission confirmations are always handled by the CLI tool itself; Task Dock only reads events and never authorizes on your behalf.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["Agent", "接入", "Hooks", "Claude Code", "Cursor", "Gemini", "ZCode", "Codex", "检测", "授权", "统计"],
      "en-US": ["agent", "onboard", "hooks", "Claude Code", "Cursor", "Gemini", "ZCode", "Codex", "detect", "verify", "statistics"],
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
    contentVersion: 4,
    reviewedForVersion: "v0.11",
    reviewedOperationContractVersions: { "agent.mcp-server": 2 },
    translations: {
      "zh-CN": {
        title: "MCP 服务器：规划数据的授权读写",
        summary: "Task Dock MCP 当前提供 18 个规划中心工具；身份、项目授权和审计摘要可在设置中管理。",
        sections: [
          {
            type: "callout",
            text: "管理界面、服务端能力，以及真实独立 MCP 客户端（MCP Inspector）的端到端联调均已通过。Claude Code / Codex CLI 等具体编码 Agent 的握手差异尚未实测；本文保持「待复核」直到这些客户端在真机验证完成。",
          },
          { type: "heading", text: "当前服务范围" },
          {
            type: "paragraph",
            text: "MCP（Model Context Protocol）通过 `taskdock.exe --mcp-server` 的 stdio 子命令接入 Task Dock 的本机 loopback bridge。当前工具只读写用户创建的规划项目、功能、步骤、进度与 Agent 会话关联；不提供任务操作、剪贴板正文读取或内置路线图修改。服务开关 `mcp_server_enabled` 默认关闭。",
          },
          { type: "heading", text: "权限范围" },
          {
            type: "steps",
            items: [
              "新建的 Agent 身份默认是 `disabled`，不能调用读写工具；撤销身份后后续请求立即失效。",
              "`readonly` 是用户显式选择的全项目只读范围；不能写入。",
              "`project_rw` 只能读取和修改已明确授权的项目；创建的新项目会自动授权给该 Agent。",
              "写入需要 `project_rw`。更新项目、功能、步骤和提交待验收时使用 `expected_revision`；并发版本过期会返回冲突。追加进度日志、关联或解除 Agent 会话是追加型动作，不要求 revision。",
            ],
          },
          { type: "heading", text: "已经开放的工具" },
          {
            type: "paragraph",
            text: "可读：列出/读取项目、功能、步骤、里程碑、进度和 Agent 会话关联。可写：创建项目或功能、更新项目/功能/步骤、追加进度日志、关联/解除 Agent 会话、将功能提交待验收。Agent 不能把功能标记为已完成，验收仍由用户判定。",
          },
          { type: "heading", text: "配置和连接检查" },
          {
            type: "steps",
            items: [
              "在设置的 Agent 接入区域启用 MCP，并查看服务是否实际运行及监听端口；开关状态不代表服务已成功启动。",
              "在 MCP 管理区创建身份并选 scope。`project_rw` 还需授予具体项目；Token 明文只在创建或轮换时返回一次，数据库只保存其哈希。",
              "按客户端生成对应配置片段，复制到 Claude Code、Codex CLI、Cursor、Trae 或 generic 客户端。不要把 Token 放进截图、日志或共享文档。",
              "连接后可在 MCP 操作历史查看分页审计摘要。界面不展示错误正文或重放载荷；本机数据库仍保留写工具的 `result_json` 以支持幂等重放，目前没有配置审计保留期限或自动清理。真实独立客户端（MCP Inspector）已完成端到端联调：工具发现、只读拒绝未授权写入、scope 变更即时生效与授权写入均验证通过；编码 Agent 客户端的握手差异尚未实测。",
            ],
          },
          {
            type: "note",
            text: "权限不足通常表示身份仍为 disabled、scope 不允许该动作，或 `project_rw` 身份缺少目标项目 grant。若提示服务不可用，先确认 Task Dock 正在运行且 MCP 已启用；MCP 未开放任务、剪贴板或其他任意数据库工具。",
          },
        ],
      },
      "en-US": {
        title: "MCP server: authorized read/write for planning data",
        summary:
          "Task Dock's MCP currently exposes 18 planning-center tools; identities, project grants and audit summaries are managed in Settings.",
        sections: [
          {
            type: "callout",
            text: "The management UI, the server-side capabilities and an end-to-end integration with a real standalone MCP client (MCP Inspector) have all passed. Handshake differences of concrete coding agents such as Claude Code / Codex CLI are not yet tested; this guide stays \"Needs review\" until those clients are verified on a real machine.",
          },
          { type: "heading", text: "Current service scope" },
          {
            type: "paragraph",
            text: "MCP (Model Context Protocol) connects to Task Dock's local loopback bridge via the stdio subcommand `taskdock.exe --mcp-server`. The tools only read and write planning projects, features, steps, progress and agent-session links that you created; no task operations, no clipboard content reads, no edits to the built-in roadmap. The service switch `mcp_server_enabled` is off by default.",
          },
          { type: "heading", text: "Permission scopes" },
          {
            type: "steps",
            items: [
              "A newly created agent identity defaults to `disabled` and cannot call read/write tools; revoking an identity invalidates further requests immediately.",
              "`readonly` is a user-chosen, whole-catalog read-only scope; it can never write.",
              "`project_rw` can only read and modify explicitly granted projects; new projects you create are granted to that agent automatically.",
              "Writes require `project_rw`. Updating projects, features and steps and submitting for acceptance use `expected_revision`; stale concurrent versions return a conflict. Appending progress logs and linking or unlinking agent sessions are append-only actions and need no revision.",
            ],
          },
          { type: "heading", text: "Tools available today" },
          {
            type: "paragraph",
            text: "Readable: list/read projects, features, steps, milestones, progress and agent-session links. Writable: create projects or features, update projects/features/steps, append progress logs, link/unlink agent sessions, submit a feature for acceptance. An agent cannot mark a feature completed; acceptance stays with you.",
          },
          { type: "heading", text: "Configuration and connection check" },
          {
            type: "steps",
            items: [
              "Enable MCP in the Agent access area of Settings and check whether the service is actually running and which port it listens on; the switch state does not prove the service started successfully.",
              "Create an identity in the MCP management area and pick a scope. `project_rw` also needs per-project grants; the token is returned in plain text only once at creation or rotation — the database stores its hash only.",
              "Generate the config snippet for your client and paste it into Claude Code, Codex CLI, Cursor, Trae or a generic client. Never put the token into screenshots, logs or shared documents.",
              "After connecting, the MCP operation history shows a paginated audit summary. The UI hides error bodies and replay payloads; the local database still keeps `result_json` of write tools for idempotent replay, and there is currently no audit retention limit or auto-cleanup. An end-to-end integration with a real standalone client (MCP Inspector) has passed: tool discovery, read-only rejection of unauthorized writes, scope changes taking effect immediately and authorized writes were all verified; coding-agent handshake differences are not yet tested.",
            ],
          },
          {
            type: "note",
            text: "Permission denied usually means the identity is still disabled, the scope does not allow the action, or a `project_rw` identity lacks the project grant. If the service is reported unavailable, first make sure Task Dock is running and MCP is enabled; MCP does not expose tasks, clipboard or arbitrary database tools.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["MCP", "授权", "Model Context Protocol", "Agent 能力", "规划中心", "readonly", "project_rw", "项目授权", "配置", "Token", "审计"],
      "en-US": ["MCP", "authorization", "Model Context Protocol", "agent capabilities", "planning center", "readonly", "project_rw", "project grant", "config", "token", "audit"],
    },
    relatedFeatureIds: ["agent.mcp-server"],
    relatedRouteIds: ["roadmap", "settings"],
  },
];
