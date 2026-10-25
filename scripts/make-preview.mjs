//! 生成视觉预览 harness（仅用于本地走查/截图，不进入发布包）：
//!   node scripts/make-preview.mjs
//! 读取 dist/index.html，注入 Tauri IPC mock（fixture 数据 + 事件桩），
//! 输出 dist/preview.html + dist/preview-shim.js。
//! 配合 `npx vite preview` 或任意静态服务器访问 /preview.html 使用。

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");

// URL 参数控制场景：?theme=light|dark|system &material=solid|glass&agents=empty
const shim = `
(function () {
  const q = new URLSearchParams(location.search);
  const THEME = q.get("theme") || "system";
  const MATERIAL = q.get("material") || "glass";
  const EMPTY = q.get("agents") === "empty";
  const now = new Date();
  const iso = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();

  const settings = {
    theme: THEME, mode: "full", material: MATERIAL,
    snap_enabled: true, autostart: false, hotkey_enabled: true,
    http_enabled: true, http_port: 47821,
    http_token: "3f1c9e2a-8b4d-4f6e-a1b2-previewmock01",
    mock_enabled: true, notify_reminder: true, notify_agent: true, notify_muted: false,
    overdue_grace_hours: 24, stale_run_minutes: 15, auto_backup: true, backup_retain_days: 7,
  };

  const tasks = [
    { id: "t1", title: "审阅 v0.3 视觉验收报告", description: "", priority: 0, status: "pending", category: "工作", tags: ["ui"], due_at: iso(-30), remind_at: null, advance_minutes: 0, recurrence: null, created_at: iso(600), updated_at: iso(10), completed_at: null, linked_agents: 0 },
    { id: "t2", title: "修复监控树实例分组", description: "", priority: 1, status: "pending", category: "开发", tags: [], due_at: iso(180), remind_at: null, advance_minutes: 15, recurrence: null, created_at: iso(500), updated_at: iso(60), completed_at: null, linked_agents: 2 },
    { id: "t3", title: "每周同步进度", description: "", priority: 2, status: "pending", category: "", tags: ["例会"], due_at: iso(2880), remind_at: null, advance_minutes: 0, recurrence: { id: "r1", freq: "weekly", interval: 1, by_weekday: [1], by_monthday: null, until: null, anchor: "2026-10-19" }, created_at: iso(4000), updated_at: iso(300), completed_at: null, linked_agents: 0 },
    { id: "t4", title: "整理依赖清单", description: "", priority: 3, status: "completed", category: "", tags: [], due_at: iso(-600), remind_at: null, advance_minutes: 0, recurrence: null, created_at: iso(3000), updated_at: iso(120), completed_at: iso(120), linked_agents: 0 },
  ];

  const sources = [
    { id: "codex", display_name: "Codex", kind: "transport", enabled: true, verified: true, homepage: "", note: "", config: null, created_at: iso(9000), updated_at: iso(5) },
    { id: "trae", display_name: "Trae", kind: "transport", enabled: true, verified: true, homepage: "", note: "", config: null, created_at: iso(9000), updated_at: iso(20) },
    { id: "mock", display_name: "Mock 模拟器", kind: "mock", enabled: true, verified: false, homepage: "", note: "", config: null, created_at: iso(9000), updated_at: iso(30) },
  ];
  const instances = [
    { id: "inst-1", source_id: "codex", instance_key: "proc-111", display_name: "", exe_path: "", first_seen_at: iso(300), last_seen_at: iso(2) },
    { id: "inst-2", source_id: "codex", instance_key: "proc-222", display_name: "", exe_path: "", first_seen_at: iso(200), last_seen_at: iso(6) },
  ];
  const sessions = EMPTY ? [] : [
    { id: "s1", source_id: "codex", external_id: "sess-alpha-0123456789", title: "重构登录模块", status: "waiting", first_seen_at: iso(300), last_seen_at: iso(2), last_run_id: "run1", instance_id: "inst-1" },
    { id: "s2", source_id: "codex", external_id: "sess-beta", title: "修复构建报错", status: "running", first_seen_at: iso(200), last_seen_at: iso(6), last_run_id: "run3", instance_id: "inst-2" },
    { id: "s3", source_id: "trae", external_id: "sess-gamma", title: "", status: "idle", first_seen_at: iso(400), last_seen_at: iso(90), last_run_id: null, instance_id: null },
    { id: "s4", source_id: "mock", external_id: "mock-sess", title: "模拟：数据迁移", status: "idle", first_seen_at: iso(100), last_seen_at: iso(30), last_run_id: null, instance_id: null },
  ];
  const runs = EMPTY ? [] : [
    { id: "run1", session_id: "s1", source_id: "codex", external_run_id: "run-a1", task_title: "重构登录模块", status: "waiting", started_at: iso(60), updated_at: iso(2), ended_at: null, pending_items: ["确认迁移脚本", "更新文档"], instance_id: "inst-1" },
    { id: "run2", session_id: "s1", source_id: "codex", external_run_id: "run-a0", task_title: "重构登录模块", status: "completed", started_at: iso(120), updated_at: iso(60), ended_at: iso(60), pending_items: [], instance_id: "inst-1" },
    { id: "run3", session_id: "s2", source_id: "codex", external_run_id: "run-b1", task_title: "修复构建报错", status: "running", started_at: iso(40), updated_at: iso(1), ended_at: null, pending_items: [], instance_id: "inst-2" },
    { id: "run4", session_id: "s3", source_id: "trae", external_run_id: null, task_title: "接口联调", status: "failed", started_at: iso(400), updated_at: iso(90), ended_at: iso(90), pending_items: [], instance_id: null },
    { id: "run5", session_id: "s4", source_id: "mock", external_run_id: "mock-run", task_title: "模拟：数据迁移", status: "disconnected", started_at: iso(100), updated_at: iso(30), ended_at: null, pending_items: [], instance_id: null },
  ];
  const snapshot = { sources, instances, sessions, runs };

  const stats = { pending: 3, overdue: 1, due_today: 2, completed_today: 1, next_due_at: iso(-30) };

  const notifications = [
    { id: "n1", kind: "agent_waiting", title: "Codex 等待处理", body: "重构登录模块 · 等待人工确认", ref_type: "agent_run", ref_id: "run1", occurrence: "x1", is_read: false, created_at: iso(2) },
    { id: "n2", kind: "reminder", title: "审阅 v0.3 视觉验收报告", body: "今天 到期", ref_type: "task", ref_id: "t1", occurrence: "x2", is_read: false, created_at: iso(30) },
    { id: "n3", kind: "agent_failed", title: "Trae 执行失败", body: "接口联调 · 退出码非零", ref_type: "agent_run", ref_id: "run4", occurrence: "x3", is_read: true, created_at: iso(90) },
    { id: "n4", kind: "agent_disconnected", title: "Agent 连接中断", body: "超过 15 分钟无心跳", ref_type: "agent_run", ref_id: "run5", occurrence: "x4", is_read: true, created_at: iso(1440) },
  ];
  const events = [
    { id: "e1", source_id: "codex", session_external_id: "sess-alpha", run_external_id: "run-a1", event_type: "status", state: "waiting", message: "等待确认", received_at: iso(2), occurred_at: iso(2), transport: "hook", evidence_type: "observed" },
    { id: "e2", source_id: "codex", session_external_id: "sess-beta", run_external_id: "run-b1", event_type: "status", state: "running", message: null, received_at: iso(1), transport: "hook", evidence_type: "observed" },
    { id: "e3", source_id: "trae", session_external_id: "sess-gamma", run_external_id: null, event_type: "status", state: "disconnected", message: null, received_at: iso(90), transport: "hook", evidence_type: "observed" },
    { id: "e4", source_id: "trae", session_external_id: "sess-gamma", run_external_id: null, event_type: "status", state: "disconnected", message: null, received_at: iso(95), transport: "hook", evidence_type: "observed" },
    { id: "e5", source_id: "mock", session_external_id: "mock-sess", run_external_id: "mock-run", event_type: "status", state: "completed", message: "模拟完成", received_at: iso(30), transport: "mock", evidence_type: "manual" },
  ];

  const discovered = [
    { source_id: "codex", display_name: "Codex", transport_kind: "transport", installed: true, version: "0.42.0", install_paths: ["~/.codex"], config_homes: [], install_method: "npm", running_instances: [{ pid: 111, name: "codex", exe: null }], capabilities: [], supported_events: ["running", "waiting", "completed", "failed"], docs_url: "", limitations: [], registered: true, enabled: true, configured: true, verified: true, last_event_at: iso(2), health_state: "live" },
    { source_id: "trae", display_name: "Trae", transport_kind: "transport", installed: true, version: null, install_paths: [], config_homes: [], install_method: "", running_instances: [], capabilities: [], supported_events: ["running", "completed"], docs_url: "", limitations: ["CN 版路径不同"], registered: true, enabled: true, configured: true, verified: false, last_event_at: iso(90), health_state: "stale" },
    { source_id: "zcode", display_name: "ZCode", transport_kind: "discovery", installed: true, version: null, install_paths: [], config_homes: [], install_method: "", running_instances: [{ pid: 222, name: "zcode", exe: null }], capabilities: [], supported_events: [], docs_url: "", limitations: ["事件桥接待验证"], registered: true, enabled: true, configured: false, verified: false, last_event_at: null, health_state: "no-events" },
    { source_id: "qoder", display_name: "Qoder", transport_kind: "transport", installed: false, version: null, install_paths: [], config_homes: [], install_method: "", running_instances: [], capabilities: [], supported_events: [], docs_url: "", limitations: [], registered: true, enabled: true, configured: false, verified: false, last_event_at: null, health_state: "unregistered" },
  ];

  const backups = [
    { name: "task-dock-20261024-0300.db.bak", size: 233472, modified: iso(1500) },
    { name: "task-dock-20261023-0300.db.bak", size: 229376, modified: iso(2900) },
  ];

  let cbId = 0;
  const listeners = {};

  async function invoke(cmd, args) {
    await new Promise((r) => setTimeout(r, 30));
    switch (cmd) {
      case "get_settings": return settings;
      case "update_settings": return { ...settings, ...(args?.patch || {}) };
      case "list_tasks": return tasks.filter((t) => (args?.filter?.status === "all" ? true : t.status === (args?.filter?.status || "pending")));
      case "task_stats": return stats;
      case "parse_quick_add": return { title: (args?.text || "").replace(/明天|下午|三点/g, "").trim() || "新任务", due_at: iso(1440), recurrence: null, advance_minutes: null, matched: ["明天", "下午三点"], has_explicit_time: true, date_only: false };
      case "agent_snapshot": return snapshot;
      case "discovery_scan": return discovered;
      case "list_notifications": return notifications;
      case "list_agent_events": return events;
      case "list_backups": return backups;
      case "apply_window_material": return { material: args?.material || "glass", applied: MATERIAL === "glass", effect: MATERIAL === "glass" ? "mica" : "none", os_version: "10.0.26100" };
      case "get_agent_inbox_dir": return "C:\\\\Users\\\\dev\\\\AppData\\\\Roaming\\\\com.taskdock.desktop\\\\agent-inbox";
      case "plugin:event|listen": {
        const id = ++cbId;
        listeners[id] = args;
        return id;
      }
      case "plugin:event|unlisten": return null;
      default:
        if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:event|")) return null;
        console.info("[preview-shim] invoke:", cmd, args);
        return null;
    }
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb) => ++cbId + 1000,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" }, currentWebviewLabel: "main" },
    plugins: {},
  };
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: "win32", version: "10.0.26100", arch: "x86_64" };

  // 背景模拟桌面壁纸，验证毛玻璃透出效果（仅预览用）
  if (!document.getElementById("preview-desktop-bg")) {
    const bg = document.createElement("div");
    bg.id = "preview-desktop-bg";
    bg.style.cssText =
      "position:fixed;inset:0;z-index:-1;" +
      "background:linear-gradient(135deg,#0f4c81 0%,#1a936f 45%,#f3a712 100%);";
    document.body.appendChild(bg);
  }
})();
`;

writeFileSync(join(dist, "preview-shim.js"), shim);
const preview = html.replace(
  /<script type="module"/,
  '<script src="/preview-shim.js"></script>\n    <script type="module"',
);
writeFileSync(join(dist, "preview.html"), preview);
console.log("preview.html + preview-shim.js 已生成（dist/）");
