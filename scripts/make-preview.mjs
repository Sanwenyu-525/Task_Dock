//! 生成视觉预览 harness（仅用于本地走查/截图，不进入发布包）：
//!   node scripts/make-preview.mjs
//! 读取 dist/index.html，注入 Tauri IPC mock（fixture 数据 + 事件桩），
//! 输出 dist/preview.html + dist/preview-shim.js。
//! 配合 `npx vite preview` 或任意静态服务器访问 /preview.html 使用。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const MODE = q.get("mode") || "full";
  const PRESET = q.get("preset") || "dream-gradient";
  const EMPTY = q.get("agents") === "empty";
  // 文件互传空态：?files=empty；默认返回四种状态夹具。
  const FILES_EMPTY = q.get("files") === "empty";
  // 扫描场景：ok（默认，立即返回完整结果）| cancelled | fail。
  // 只影响 harness 的 nav_scan_apps 返回，用于走查取消/错误状态，不参与发布包。
  const SCAN_MODE = q.get("scan") || "ok";
  // 用户级垃圾扫描场景：ok（默认）| empty | partial（含权限不足/部分失败）|
  // unavailable | expired（预览已过期）。只影响 resource_junk_preview/execute 夹具，
  // 用于走查扫描成功/无候选/部分失败/过期状态，不参与发布包。
  const JUNK_MODE = q.get("junk") || "ok";
  // 开发工作台：?wb=current 预置「当前任务」锚点（t1），用于走查四区域；
  // 默认空锚点，保持其他页面截图与旧行为不变。
  const WB_CURRENT = q.get("wb") === "current";
  const now = new Date();
  const iso = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();

  const settings = {
    theme: THEME, mode: MODE, material: MATERIAL, visual_preset: PRESET,
    snap_enabled: true, autostart: false, hotkey_enabled: true,
    http_enabled: true, http_port: 47821,
    http_token: "3f1c9e2a-8b4d-4f6e-a1b2-previewmock01",
    mock_enabled: true, notify_reminder: true, notify_agent: true, notify_muted: false,
    overdue_grace_hours: 24, stale_run_minutes: 15, auto_backup: true, backup_retain_days: 7,
    nav_prefer_focus: true, nav_allow_launch: true, nav_fallback: true,
    nav_remember_window: true, nav_default_browser: "", nav_workspace_max: 8,
    workbench_current_task: WB_CURRENT ? "t1" : "",
    ingest_queue_capacity: 1024, ingest_batch_size: 100, ingest_coalesce_ms: 250,
    agent_event_retention_days: 14, agent_event_max_rows: 20000, agent_event_archive: true,
    agent_inbox_max_file_bytes: 65536, agent_inbox_max_files: 500, perf_diagnostics_enabled: true,
    clipboard_enabled: true, clipboard_paused: false, clipboard_capture_images: true,
    clipboard_capture_files: true, clipboard_capture_html: true, clipboard_auto_group: true,
    clipboard_group_window_secs: 45, clipboard_retention_days: 30, clipboard_max_items: 2000,
    clipboard_max_storage_mb: 2048, clipboard_exclude_apps: "keepass.exe, 1password.exe",
    clipboard_paste_interval_ms: 350, clipboard_sensitive_filter: true,
    // 与 mobile_sync_status 夹具保持一致：服务开启且已配对，避免走查时出现
    // 「开关关闭 + 运行中 + 已配对设备」的自相矛盾状态。
    mobile_sync_enabled: true, mobile_sync_port: 47822,
  };

  // ── 导航 fixture（v0.4：任务关联目标 + 应用扫描 + 能力 + 结果）──
  const navTarget = (o) => ({
    id: o.id, display_name: o.name, target_type: o.type, app_key: o.key ?? "",
    exe_path: o.exe ?? "", launch_args: "", working_dir: "", app_user_model_id: o.aumid ?? "",
    url: o.url ?? "", path: o.path ?? "", agent_source_id: o.src ?? "", agent_session_id: o.sess ?? "",
    window_title_hint: o.hint ?? "", icon: "", category: o.cat ?? "", favorite: o.fav ?? false,
    hidden: false, last_used_at: o.used ?? null, use_count: o.uses ?? 0,
    created_at: iso(2000), updated_at: iso(100),
  });
  const navTargets = [
    navTarget({ id: "nt1", name: "Visual Studio Code", type: "application", key: "c:\\apps\\code.exe", exe: "C:\\Apps\\Code.exe", cat: "dev", fav: true, uses: 12, used: iso(30) }),
    navTarget({ id: "nt2", name: "Chrome", type: "application", key: "c:\\apps\\chrome.exe", exe: "C:\\Apps\\chrome.exe", cat: "browser", uses: 30, used: iso(5) }),
    navTarget({ id: "nt3", name: "GitHub — task_dock", type: "url", url: "https://github.com/x/task_dock", uses: 4, used: iso(60) }),
    navTarget({ id: "nt4", name: "微信", type: "application", key: "c:\\tencent\\wechat\\wechat.exe", exe: "C:\\Tencent\\WeChat\\WeChat.exe", hint: "微信", cat: "im", uses: 8, used: iso(120) }),
    navTarget({ id: "nt5", name: "日志目录", type: "directory", path: "D:\\Develop\\task_dock\\logs", uses: 2, used: iso(300) }),
  ];
  const navLinks = [
    { id: "nl1", task_id: "t1", target_id: "nt1", display_order: 0, is_default: true, launch_behavior: "default", created_at: iso(200), target: navTargets[0], running_state: "has_window" },
    { id: "nl2", task_id: "t1", target_id: "nt3", display_order: 1, is_default: false, launch_behavior: "open", created_at: iso(200), target: navTargets[2], running_state: "always" },
    { id: "nl3", task_id: "t1", target_id: "nt5", display_order: 2, is_default: false, launch_behavior: "open", created_at: iso(200), target: navTargets[4], running_state: "always" },
    { id: "nl4", task_id: "t2", target_id: "nt4", display_order: 0, is_default: true, launch_behavior: "focus_or_launch", created_at: iso(150), target: navTargets[3], running_state: "process_only" },
    { id: "nl5", task_id: "t3", target_id: "nt2", display_order: 0, is_default: true, launch_behavior: "default", created_at: iso(100), target: navTargets[1], running_state: "not_running" },
  ];
  const scanApps = [
    { app_key: "c:\\apps\\chrome.exe", display_name: "Google Chrome", category: "browser", exe_path: "C:\\Apps\\chrome.exe", launch_args: "", working_dir: "", app_user_model_id: "", window_title_hint: "", source: "startmenu" },
    { app_key: "c:\\tencent\\wechat\\wechat.exe", display_name: "微信", category: "im", exe_path: "C:\\Tencent\\WeChat\\WeChat.exe", launch_args: "", working_dir: "", app_user_model_id: "", window_title_hint: "微信", source: "startmenu" },
    { app_key: "c:\\kugou\\kugou.exe", display_name: "酷狗音乐", category: "music", exe_path: "C:\\KuGou\\KuGou.exe", launch_args: "", working_dir: "", app_user_model_id: "", window_title_hint: "酷狗", source: "startmenu" },
    { app_key: "microsoft.windowscalculator_8wekyb3d8bbwe!app", display_name: "计算器", category: "uwp", exe_path: "", launch_args: "", working_dir: "", app_user_model_id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", window_title_hint: "", source: "uwp" },
    { app_key: "c:\\apps\\code.exe", display_name: "Visual Studio Code", category: "dev", exe_path: "C:\\Apps\\Code.exe", launch_args: "", working_dir: "", app_user_model_id: "", window_title_hint: "", source: "known" },
  ];
  const navCaps = (src, launch, focus, ws, resume, evidence = "exe-found") => ({
    source_id: src,
    can_launch: { supported: launch, evidence: launch ? evidence : "not-installed", note: "" },
    can_focus_window: { supported: focus, evidence: launch ? evidence : "not-installed", note: "" },
    can_open_workspace: { supported: ws, evidence: ws ? "cli-convention" : "unsupported-interface", note: "" },
    can_resume_session: { supported: resume, evidence: resume ? "baseline-verified" : "unsupported-interface", note: resume ? "codex resume" : "无官方会话恢复接口" },
  });
  const navLogs = [
    { id: "g1", target_id: "nt1", target_name: "Visual Studio Code", requested_action: "focus_window", actual_action: "focus_window", success: true, fallback_used: false, reason: "", verification_level: "window-confirmed", created_at: iso(30) },
    { id: "g2", target_id: "nt4", target_name: "微信", requested_action: "focus_window", actual_action: null, success: false, fallback_used: false, reason: "Windows 前台锁定拒绝了切换", verification_level: "none", created_at: iso(90) },
  ];

  const PERF = Math.max(0, parseInt(q.get("perf") || "0", 10) || 0);

  // ?perf=300：性能走查夹具（300 条待办），用于 scripts/render-perf.mjs
  // 在真实 Chromium 中测量列表渲染成本；默认仍用 4 条演示任务。
  const tasks = PERF
    ? Array.from({ length: PERF }, (_, i) => ({
        id: "perf-" + i,
        title: "性能任务 " + i,
        description: i % 3 === 0 ? "包含描述的任务，用于模拟真实列表密度" : "",
        priority: i % 4,
        status: "pending",
        category: i % 2 === 0 ? "性能" : "",
        tags: i % 7 === 0 ? ["压测", "列表"] : [],
        due_at: i % 4 === 0 ? iso(-30) : null,
        remind_at: null,
        advance_minutes: 0,
        recurrence: null,
        created_at: iso(600),
        updated_at: iso(10),
        completed_at: null,
        linked_agents: 0,
      }))
    : [
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

  const taskAgentLinks = [
    { id: "tal1", task_id: "t1", source_id: "codex", session_external_id: "sess-alpha-0123456789", run_external_id: "run-a1", created_at: iso(200), available: true },
    { id: "tal2", task_id: "t2", source_id: "trae", session_external_id: "sess-gamma", run_external_id: null, created_at: iso(150), available: true },
  ];

  // ?tasks=empty：空状态走查（列表与统计为空，其他 fixture 仍完整，避免互相引用报错）
  // ?tasks=overdue：补一条真实已过期任务，使「逾期」统计与列表语义一致（默认夹具不含逾期项）
  const LIST_TASKS =
    q.get("tasks") === "empty"
      ? []
      : q.get("tasks") === "overdue"
        ? [
            { id: "t5", title: "逾期报告待复核", description: "", priority: 1, status: "pending", category: "工作", tags: [], due_at: iso(45), remind_at: null, advance_minutes: 0, recurrence: null, created_at: iso(700), updated_at: iso(40), completed_at: null, linked_agents: 0 },
            ...tasks,
          ]
        : tasks;
  if (q.get("tasks") === "empty") {
    stats.pending = 0;
    stats.overdue = 0;
    stats.due_today = 0;
  }

  // ?reminders=1：任务页「进行中的提醒」摘要走查夹具。
  // 默认不注入（返回空数组），避免改变其它走查脚本的基线截图。
  const ACTIVE_REMINDERS =
    q.get("reminders") === "1"
      ? [
          {
            reminderId: "rem1",
            taskId: "t1",
            taskTitle: "审阅 v0.3 视觉验收报告",
            remindAt: new Date(now.getTime() + 5 * 60_000 + 27_000).toISOString(),
            occurrence: new Date(now.getTime() + 5 * 60_000 + 27_000).toISOString(),
            kind: "due",
            snoozed: false,
            taskStatus: "pending",
            hasRecurrence: false,
          },
          {
            reminderId: "rem2",
            taskId: "t2",
            taskTitle: "修复监控树实例分组",
            remindAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
            occurrence: new Date(now.getTime() + 45 * 60_000).toISOString(),
            kind: "advance",
            snoozed: false,
            taskStatus: "pending",
            hasRecurrence: true,
          },
        ]
      : [];

  // 专注与休息走查夹具：focus_snapshot / focus_history 缺了会拿到 null，
  // FocusWorkspace 无法渲染（预览 harness 的历史缺口，不是产品问题）。
  const FOCUS_PREFS = {
    focus_minutes: 25,
    short_break_minutes: 5,
    long_break_minutes: 15,
    long_break_every: 4,
    auto_start_break: false,
    auto_start_next: false,
    sedentary_enabled: false,
    sedentary_interval_minutes: 60,
  };
  const FOCUS_SNAPSHOT = {
    active: {
      id: "fs1",
      kind: "focus",
      state: "focusing",
      task_id: "t1",
      task_title: "审阅 v0.3 视觉验收报告",
      task_deleted: false,
      planned_seconds: 1500,
      extension_seconds: 0,
      accumulated_ms: 8 * 60_000,
      remaining_ms: 17 * 60_000,
      started_at: iso(8),
      running_since: iso(8),
      paused_at: null,
      pause_reason: null,
      round_index: 2,
      clock_jumps: 0,
    },
    prefs: FOCUS_PREFS,
    today: { day: new Date(now.getTime()).toISOString().slice(0, 10), focus_ms: 75 * 60_000, break_ms: 15 * 60_000, completed_focus: 3 },
    rounds_since_long: 2,
    sedentary: { enabled: false, interval_minutes: 60, next_at: null },
    server_now: iso(0),
  };
  const FOCUS_HISTORY = [
    { id: "fh1", kind: "focus", state: "completed", task_id: "t1", task_title: "审阅 v0.3 视觉验收报告", task_deleted: false, planned_seconds: 1500, accumulated_ms: 25 * 60_000, started_at: iso(140), ended_at: iso(115), round_index: 3 },
    { id: "fh2", kind: "short_break", state: "completed", task_id: null, task_title: "", task_deleted: false, planned_seconds: 300, accumulated_ms: 5 * 60_000, started_at: iso(200), ended_at: iso(195), round_index: 2 },
    { id: "fh3", kind: "focus", state: "cancelled", task_id: "t2", task_title: "修复监控树实例分组", task_deleted: true, planned_seconds: 1500, accumulated_ms: 6 * 60_000, started_at: iso(300), ended_at: iso(294), round_index: 2 },
  ];

  // 任务统计（analytics）走查夹具：按请求的 range 生成同形状数据，让「统计模式
  // 占满高度 / 图表随宽度收缩」能在预览里被真实度量（默认页不打开该子视图）。
  function analyticsFixture(range) {
    const points = range === "month" ? 12 : range === "week" ? 7 : 8;
    const day = 86_400_000;
    const trend = Array.from({ length: points }, (_, i) => {
      const start = new Date(now.getTime() - (points - 1 - i) * day).toISOString();
      const completed = (i * 3) % 7;
      const overdue = (i * 2) % 4;
      return {
        key: "p" + i,
        label: "",
        start,
        end: start,
        completed,
        due: completed + overdue + 1,
        due_completed: completed,
        due_overdue: overdue,
        completion_rate: 0.774,
        overdue_rate: 0.161,
      };
    });
    return {
      range,
      range_label: "",
      range_start: trend[0].start,
      range_end: trend[trend.length - 1].end,
      generated_at: iso(0),
      summary: {
        completed: 24,
        recurring_completed: 6,
        due: 31,
        due_completed: 24,
        due_overdue: 5,
        completion_rate: 0.774,
        overdue_rate: 0.161,
      },
      trend,
      by_category: [
        { category: "工作", completed: 12, share: 0.5 },
        { category: "开发", completed: 8, share: 0.3333 },
        { category: "未分类", completed: 4, share: 0.1667 },
      ],
      by_priority: [
        { priority: 0, completed: 4, share: 0.1667 },
        { priority: 1, completed: 9, share: 0.375 },
        { priority: 2, completed: 7, share: 0.2916 },
        { priority: 3, completed: 4, share: 0.1667 },
      ],
      history_complete: true,
      definitions: {
        completed: "完成动作计数：期内完成次数（重复任务每次推进都计入）。",
        completion_rate: "完成率 = 期内完成次数 ÷ 期内到期任务数。",
        overdue_rate: "逾期率 = 期内到期且逾期未完成 ÷ 期内到期任务数。",
        trend: "趋势按本地日期分桶，完成与逾期分别计数。",
        distribution: "分布按分类与优先级统计完成占比。",
        history: "分母完整性：存在无法还原的重复任务期次时可能偏高。",
      },
    };
  }

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

  // ── 行动中心 / 工作现场 / 任务上下文 fixture（v0.5）──
  const actionItems = [
    { id: "a1", kind: "failed", priority: 0, source_id: "codex", source_name: "Codex", session_external_id: "sess-alpha", run_external_id: "run-a", task_id: "t1", task_title: tasks[0].title, title: "Codex 执行失败", message: "命令退出码 1：pnpm build", occurred_at: iso(6), count: 3, event_ids: ["e1a", "e1b", "e1c"], acked: false, authorization_inferred: false },
    { id: "a2", kind: "authorization", priority: 0, source_id: "codex", source_name: "Codex", session_external_id: "sess-alpha", run_external_id: "run-a", task_id: "t1", task_title: tasks[0].title, title: "可能需要确认权限", message: "请确认是否允许写入 D:\\\\Develop\\\\task_dock", occurred_at: iso(9), count: 1, event_ids: ["e2a"], acked: false, authorization_inferred: true },
    { id: "a3", kind: "waiting_input", priority: 1, source_id: "trae", source_name: "Trae", session_external_id: "sess-gamma", task_id: null, task_title: null, title: "等待补充需求", message: "请提供目标分支名", occurred_at: iso(40), count: 2, event_ids: ["e3a", "e3b"], acked: false, authorization_inferred: false },
    { id: "a4", kind: "reminder", priority: 1, source_id: null, source_name: "任务提醒", session_external_id: null, run_external_id: null, task_id: "t1", task_title: tasks[0].title, title: "任务到期：审阅 v0.3 视觉验收报告", message: "", occurred_at: iso(2), count: 1, event_ids: ["n1"], acked: false, authorization_inferred: false },
    { id: "a5", kind: "running", priority: 2, source_id: "codex", source_name: "Codex", session_external_id: "sess-beta", run_external_id: "run-b1", task_id: "t2", task_title: tasks[1].title, title: "正在重构数据层", message: "第 3 轮执行中", occurred_at: iso(1), count: 5, event_ids: ["e5a"], acked: false, authorization_inferred: false },
  ];
  const actionCoverage = [
    { source_id: "codex", display_name: "Codex", enabled: true, verified: true, transport_verified: true, monitored: true, last_event_at: iso(1), level: "live", explanation: "hook 传输已在近期验证，事件可实时到达。", note: "hook · baseline-verified" },
    { source_id: "trae", display_name: "Trae", enabled: true, verified: false, transport_verified: false, monitored: false, last_event_at: iso(90), level: "stale", explanation: "超过 24 小时没有新事件，无法确认监控仍然有效。", note: "hook" },
    { source_id: "zcode", display_name: "ZCode", enabled: true, verified: false, transport_verified: false, monitored: false, last_event_at: null, level: "no-events", explanation: "尚未收到任何事件，可能未安装或未接入。", note: "discovery" },
    { source_id: "mock", display_name: "Mock 模拟器", enabled: false, verified: false, transport_verified: false, monitored: false, last_event_at: null, level: "disabled", explanation: "来源已停用，不产生运行状态。", note: "mock" },
  ];
  const actionFeed = {
    items: actionItems,
    counts: { failed: 1, authorization: 1, waiting_input: 1, running: 1, completed: 0, disconnected: 0, reminder: 1 },
    coverage: actionCoverage,
    generated_at: iso(0),
    category: "intervention",
    db_total: actionItems.length,
    filtered_total: actionItems.length,
    loaded: actionItems.length,
    has_more: false,
    next_cursor: null,
    enabled: true,
    truncated: false,
    scanned_events: 42,
  };

  // ── 规划中心夹具（任务卡样式统一走查：功能列表 / 看板 / 项目 / 里程碑）──
  const planningProjects = [
    {
      id: "pp1", name: "任务卡样式统一", description: "跨页面统一卡面、圆角、阴影与字号层级",
      status: "in_progress", archived: false, target_date: "2026-11-20", sort_order: 0,
      created_at: iso(600), updated_at: iso(12),
      stats: { feature_total: 4, feature_completed: 1, feature_in_progress: 1, feature_blocked: 0, feature_planned: 1, feature_review: 1, feature_paused: 0, has_features: true, progress_percent: 25 },
    },
    {
      id: "pp2", name: "剪贴板隐私策略", description: "敏感内容识别与静默采集边界",
      status: "paused", archived: false, target_date: null, sort_order: 1,
      created_at: iso(720), updated_at: iso(30),
      stats: { feature_total: 2, feature_completed: 0, feature_in_progress: 0, feature_blocked: 1, feature_planned: 1, feature_review: 0, feature_paused: 0, has_features: true, progress_percent: 0 },
    },
    {
      id: "pp3", name: "旧版启动器维护", description: "归档项目，仅保留历史记录",
      status: "completed", archived: true, target_date: "2026-06-30", sort_order: 2,
      created_at: iso(900), updated_at: iso(120),
      stats: { feature_total: 3, feature_completed: 3, feature_in_progress: 0, feature_blocked: 0, feature_planned: 0, feature_review: 0, feature_paused: 0, has_features: true, progress_percent: 100 },
    },
  ];
  const planningMilestones = [
    {
      id: "pm1", project_id: "pp1", name: "样张冻结", description: "完成全部页面卡片视觉对齐",
      target_date: "2026-10-20", sort_order: 0, created_at: iso(500), updated_at: iso(60),
      feature_total: 3, feature_completed: 1,
    },
    {
      id: "pm2", project_id: "pp1", name: "窄窗与主题回归", description: "320/400 窄窗、深浅主题与两套预设",
      target_date: "2026-12-15", sort_order: 1, created_at: iso(480), updated_at: iso(80),
      feature_total: 1, feature_completed: 0,
    },
    {
      id: "pm3", project_id: "pp1", name: "未排期", description: "尚未关联功能的里程碑",
      target_date: null, sort_order: 2, created_at: iso(460), updated_at: iso(90),
      feature_total: 0, feature_completed: 0,
    },
  ];
  const planningSteps = (featureId, done, total) =>
    Array.from({ length: total }, (_, i) => ({
      id: featureId + "-s" + i, feature_id: featureId, title: "步骤 " + (i + 1), done: i < done,
      sort_order: i, created_at: iso(300), updated_at: iso(200), completed_at: i < done ? iso(80) : null,
    }));
  const planningFeatures = [
    {
      id: "pf1", project_id: "pp1", title: "任务列表页卡片壳抽取为 .task-card",
      description: "把圆角、卡面、阴影与内边距收敛到同一套语义 Token，其余页面复用样式壳。",
      acceptance_criteria: "任务/行动/Agent/规划页面卡片视觉一致，无旧边框与左色条残留。",
      status: "in_progress", priority: "P0", milestone_id: "pm1", milestone_name: "样张冻结",
      target_date: "2026-11-10", sort_order: 0, created_at: iso(400), updated_at: iso(15),
      completed_at: null, steps: planningSteps("pf1", 2, 4), step_total: 4, step_done: 2,
    },
    {
      id: "pf2", project_id: "pp1", title: "规划中心四视图接入统一卡片",
      description: "功能列表、看板、项目侧栏与里程碑时间轴改用同一卡片壳，保留各自信息槽位。",
      acceptance_criteria: "拖拽、展开、选中与键盘可达不退化。",
      status: "review", priority: "P1", milestone_id: "pm1", milestone_name: "样张冻结",
      target_date: "2026-11-14", sort_order: 1, created_at: iso(380), updated_at: iso(40),
      completed_at: null, steps: planningSteps("pf2", 3, 3), step_total: 3, step_done: 3,
    },
    {
      id: "pf3", project_id: "pp1", title: "行动中心与 Agent 轮次卡片对齐",
      description: "优先级与状态徽标统一为软底语义色，移除状态描边与常驻左色条。",
      acceptance_criteria: "失败/等待状态仍清晰可见，hover 与焦点态一致。",
      status: "planned", priority: "P2", milestone_id: "pm2", milestone_name: "窄窗与主题回归",
      target_date: "2026-11-18", sort_order: 2, created_at: iso(360), updated_at: iso(60),
      completed_at: null, steps: [], step_total: 0, step_done: 0,
    },
    {
      id: "pf4", project_id: "pp1", title: "深浅主题与窄窗回归",
      description: "两套视觉预设、深浅主题、320/400 窄窗下检查截断与换行。",
      acceptance_criteria: "无溢出、无遮挡，长标题按卡片规则截断。",
      status: "completed", priority: "P0", milestone_id: "pm2", milestone_name: "窄窗与主题回归",
      target_date: "2026-10-28", sort_order: 3, created_at: iso(340), updated_at: iso(100),
      completed_at: iso(100), steps: planningSteps("pf4", 2, 2), step_total: 2, step_done: 2,
    },
  ];
  const planningActivity = [
    { id: "pa1", project_id: "pp1", feature_id: "pf1", feature_title: planningFeatures[0].title, kind: "status_change", old_status: "planned", new_status: "in_progress", message: "状态从 待开始 改为 进行中", created_at: iso(15) },
    { id: "pa2", project_id: "pp1", feature_id: "pf2", feature_title: planningFeatures[1].title, kind: "step_done", old_status: null, new_status: null, message: "完成步骤：窄窗截图核对", created_at: iso(40) },
    { id: "pa3", project_id: "pp1", feature_id: "pf1", feature_title: planningFeatures[0].title, kind: "note", old_status: null, new_status: null, message: "统一壳先落在 theme 层，base 只保留布局。", created_at: iso(70) },
  ];

  const snapBase = (o) => ({
    id: o.id, task_id: o.taskId ?? null, task_title: o.taskTitle ?? null, name: o.name,
    note: o.note ?? "", source: o.source ?? "task", item_count: o.count,
    created_at: o.at, updated_at: o.at, last_restored_at: o.restored ?? null,
    restore_count: o.restoreCount ?? 0,
  });
  const snapshots = [
    snapBase({ id: "ws1", taskId: "t1", taskTitle: tasks[0].title, name: "评审现场 · 10-28 21:04", count: 3, at: iso(40), restored: iso(20), restoreCount: 1 }),
    snapBase({ id: "ws2", taskId: "t2", taskTitle: tasks[1].title, name: "微信沟通现场", count: 1, at: iso(300), source: "manual" }),
  ];
  const snapItem = (o) => ({
    id: o.id, snapshot_id: o.sid, display_order: o.order, item_kind: o.kind,
    display_name: o.name, target_id: o.target ?? null, app_key: "", exe_path: o.exe ?? "",
    launch_args: "", working_dir: "", app_user_model_id: "", url: o.url ?? "", path: o.path ?? "",
    agent_source_id: "", agent_session_id: "", window_title_hint: o.hint ?? "",
    window_class: o.cls ?? "", window_title: o.wname ?? "", restore_note: "",
    last_result: o.result ?? "", last_verification: o.verify ?? "", last_restored_at: o.at ?? null,
  });
  const snapItems = (sid) => sid === "ws1" ? [
    snapItem({ id: "wi1", sid: "ws1", order: 0, kind: "application", name: "Visual Studio Code", target: "nt1", exe: "C:\\\\Apps\\\\Code.exe", hint: "task_dock", cls: "Chrome_WidgetWin", wname: "task_dock — D:\\\\Develop", result: "restored", verify: "window-confirmed", at: iso(20) }),
    snapItem({ id: "wi2", sid: "ws1", order: 1, kind: "url", name: "GitHub — task_dock", target: "nt3", url: "https://github.com/x/task_dock", result: "restored", verify: "delegated", at: iso(20) }),
    snapItem({ id: "wi3", sid: "ws1", order: 2, kind: "directory", name: "日志目录", target: "nt5", path: "D:\\\\Develop\\\\task_dock\\\\logs", result: "skipped", verify: "none", at: iso(20) }),
  ] : [
    snapItem({ id: "wi4", sid: "ws2", order: 0, kind: "application", name: "微信", target: "nt4", exe: "C:\\\\Tencent\\\\WeChat\\\\WeChat.exe", hint: "微信", cls: "WeChatMainWndForPC", wname: "微信", result: "", verify: "" }),
  ];
  const snapshotDetail = (s) => ({ ...s, items: snapItems(s.id) });
  const clipboardSnapLinks = [
    { id: "csl1", snapshot_id: "ws1", target_type: "item", target_id: "ci1", created_at: iso(35), label: "接口返回示例", kind: "text" },
    { id: "csl2", snapshot_id: "ws1", target_type: "group", target_id: "cg1", created_at: iso(34), label: "调试截图（3 项）", kind: "image" },
  ];
  const clipboardTaskLinks = [
    { id: "cl1", task_id: "t1", target_type: "item", target_id: "ci1", created_at: iso(80), label: "接口返回示例", kind: "text" },
    { id: "cl2", task_id: "t1", target_type: "group", target_id: "cg1", created_at: iso(70), label: "调试截图（3 项）", kind: "image" },
  ];
  const clipboardStatus = {
    enabled: true, paused: false, monitoring: true, activeJob: null,
    platform: "win32", configError: null, configOrigin: "settings",
    captureAllowed: true,
    monitor: { captured: 128, ignored: 6, errors: 0, last_at: iso(1) },
  };
  // 功能运行分区走查夹具：resident / task / shared / ondemand 四类都覆盖。
  const lifecycleStatus = [
    { id: "clipboard", category: "resident", state: "running", intent: "running", controllable: true, background: ["clipboard-monitor", "clipboard-maintenance"], detail: { monitoring: true, maintenance: true, draining: false, pasteActive: false, configOrigin: "settings" }, error: null },
    { id: "shelf_cleanup", category: "resident", state: "paused", intent: "paused", controllable: true, background: [], detail: { enabled: false, running: false }, error: null },
    { id: "reminders", category: "resident", state: "running", intent: "running", controllable: true, background: ["shared-scheduler-tick"], detail: { sharedScheduler: true }, error: null },
    { id: "voice", category: "resident", state: "idle", intent: "running", controllable: true, background: [], detail: { ttsEnabled: true, soundEnabled: true }, error: null },
    { id: "actions", category: "task", state: "running", intent: "running", controllable: true, background: [], detail: { consumerGated: true }, error: null },
    { id: "workflows", category: "task", state: "idle", intent: "running", controllable: false, background: [], detail: { perRunPause: true }, error: null },
    { id: "agents", category: "shared", state: "running", intent: "running", controllable: false, background: ["agent-ingest-pipeline", "agent-adapters"], detail: { stopWouldLoseEvents: true }, error: null },
    { id: "diagnostics", category: "shared", state: "running", intent: "running", controllable: false, background: ["diagnostics-writer"], detail: { alwaysOn: true }, error: null },
    { id: "ocr", category: "ondemand", state: "idle", intent: "running", controllable: false, background: [], detail: { autoOcr: false }, error: null },
    { id: "widgets", category: "ondemand", state: "idle", intent: "running", controllable: false, background: [], detail: { perWidget: true }, error: null },
  ];
  // 资源管理中心夹具（只读预览用）：两卷 / 两轮内存目录 / 进程与清理报告。
  const resourceSnapshot = {
    sampledAt: iso(0),
    application: { knownCacheBytes: 1016.7 * 1024, knownCacheFiles: 21, status: "ready" },
    memory: { totalBytes: 16 * 1024 * 1024 * 1024, availableBytes: 3.63 * 1024 * 1024 * 1024 },
    disks: [
      { volume: "C:", kind: "fixed", totalBytes: 475.68 * 1024 * 1024 * 1024, availableBytes: 13.67 * 1024 * 1024 * 1024 },
      { volume: "D:", kind: "fixed", totalBytes: 465.76 * 1024 * 1024 * 1024, availableBytes: 21.63 * 1024 * 1024 * 1024 },
    ],
    process: { pid: 4242, name: "task-dock.exe", cpuPercent: 0, cpuWindowMs: 201, workingSetBytes: 48.1 * 1024 * 1024, privateBytes: 27.8 * 1024 * 1024, uptimeSecs: 3725, status: "normal" },
  };
  const resourceProcesses = {
    sampledAt: iso(0),
    cpuWindowMs: 201,
    supported: true,
    truncated: false,
    omittedExternal: 0,
    omittedUnknown: 1,
    processes: [
      { pid: 4242, name: "task-dock.exe", association: "self", associationBasis: "self", cpuPercent: 0, workingSetBytes: 48.1 * 1024 * 1024, privateBytes: 27.8 * 1024 * 1024, uptimeSecs: 3725, status: "normal" },
      { pid: 5000, name: "msedgewebview2.exe", association: "managed_child", associationBasis: "parent_chain", cpuPercent: 0.4, workingSetBytes: 89.3 * 1024 * 1024, privateBytes: 20.9 * 1024 * 1024, uptimeSecs: 3700, status: "normal" },
      { pid: 5001, name: "msedgewebview2.exe", association: "managed_child", associationBasis: "parent_chain", cpuPercent: 0.2, workingSetBytes: 51.2 * 1024 * 1024, privateBytes: 12.4 * 1024 * 1024, uptimeSecs: 3700, status: "normal" },
      { pid: 700, name: "node.exe", association: "external_tool", associationBasis: "name_and_path", cpuPercent: 1.3, workingSetBytes: 120.4 * 1024 * 1024, privateBytes: 40.2 * 1024 * 1024, uptimeSecs: 900, status: "normal" },
      { pid: 701, name: "cargo.exe", association: "project_dev", associationBasis: "image_path", cpuPercent: 5.4, workingSetBytes: 96.8 * 1024 * 1024, privateBytes: 18.1 * 1024 * 1024, uptimeSecs: 300, status: "normal" },
    ],
  };
  const resourceDiskUsage = {
    sampledAt: iso(0),
    totalBytes: 270 * 1024 * 1024,
    truncated: false,
    entries: [
      { id: "clipboard_images", bytes: 215.2 * 1024 * 1024, files: 10, kind: "persistent", status: "ready" },
      { id: "database", bytes: 36.3 * 1024 * 1024, files: 3, kind: "persistent", status: "ready" },
      { id: "clipboard_thumbs", bytes: 4.9 * 1024 * 1024, files: 13, kind: "persistent", status: "ready" },
      { id: "tts_cache", bytes: 829.6 * 1024, files: 12, kind: "regenerable", status: "ready" },
      { id: "shelf_thumbs", bytes: 315.5 * 1024, files: 13, kind: "persistent", status: "ready" },
      { id: "diagnostics", bytes: 12.1 * 1024, files: 1, kind: "persistent", status: "ready" },
      { id: "agent_inbox", bytes: 4.1 * 1024, files: 21, kind: "persistent", status: "ready" },
      { id: "backups", bytes: 0, files: 0, kind: "persistent", status: "missing" },
      { id: "shelf_files", bytes: 0, files: 0, kind: "persistent", status: "missing" },
      { id: "shelf_images", bytes: 0, files: 0, kind: "persistent", status: "missing" },
    ],
  };
  const resourceMemoryCatalog = {
    sampledAt: iso(0),
    totalBytes: 68400,
    sources: [
      { id: "app_icons", entries: 20, bytes: 68400, status: "available" },
      { id: "tts_memory", entries: 0, bytes: 0, status: "empty" },
    ],
  };
  const resourceCategoryPreview = (category, candidates, bytes) => ({
    category, status: "ready", candidates, estimatedBytes: bytes, protectedFiles: 0, skippedFiles: 0,
  });
  const resourcePreview = {
    previewId: "preview-mock",
    createdAt: iso(0),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    totalCandidates: 3,
    totalEstimatedBytes: 8704,
    categories: [
      resourceCategoryPreview("temporary", 0, 0),
      resourceCategoryPreview("tts", 2, 8192),
      resourceCategoryPreview("orphan_thumbnails", 1, 512),
    ],
  };
  const resourceCleanupReport = {
    jobId: "job-mock",
    startedAt: iso(0),
    finishedAt: iso(0),
    status: "success",
    totalFreedBytes: 8704,
    totalDeletedFiles: 3,
    categories: [
      { category: "tts", status: "success", estimatedBytes: 8192, freedBytes: 8192, candidates: 2, deletedFiles: 2, skippedFiles: 0, failedFiles: 0 },
      { category: "orphan_thumbnails", status: "success", estimatedBytes: 512, freedBytes: 512, candidates: 1, deletedFiles: 1, skippedFiles: 0, failedFiles: 0 },
    ],
  };
  // 用户级垃圾清理夹具（只用于走查，不落库、不触碰真实文件）：
  // 结构对齐 bridge.ts 的 ResourceJunkPreview / ResourceJunkExecutionReport。
  const junkCategory = (category, candidates, bytes, extra) => Object.assign({
    category, status: "ready", candidates, estimatedBytes: bytes, protectedFiles: 0, skippedFiles: 0,
  }, extra || {});
  const junkOk = {
    previewId: "junk-mock",
    createdAt: iso(0),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    minimumAgeHours: 24,
    categories: [
      junkCategory("recycle_bin", 3, 1258291),
      junkCategory("user_temp", 12, 34393293, { protectedFiles: 2, skippedFiles: 1 }),
      junkCategory("system_temp", 0, 0),
      junkCategory("crash_dumps", 0, 0),
    ],
  };
  const junkPartial = {
    previewId: "junk-mock",
    createdAt: iso(0),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    minimumAgeHours: 24,
    categories: [
      junkCategory("recycle_bin", 3, 1258291),
      junkCategory("user_temp", 0, 0, { status: "unavailable", errorCode: "access_denied", errorMessage: "部分路径无权限读取" }),
      junkCategory("system_temp", 7, 10485760, { status: "partial", skippedFiles: 4 }),
      junkCategory("crash_dumps", 0, 0),
    ],
  };
  const junkEmpty = {
    previewId: "junk-mock",
    createdAt: iso(0),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    minimumAgeHours: 24,
    categories: [
      junkCategory("recycle_bin", 0, 0),
      junkCategory("user_temp", 0, 0),
      junkCategory("system_temp", 0, 0),
      junkCategory("crash_dumps", 0, 0),
    ],
  };
  const junkUnavailable = {
    previewId: "junk-mock",
    createdAt: iso(0),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    minimumAgeHours: 24,
    categories: [
      junkCategory("recycle_bin", 0, 0, { status: "unavailable", errorCode: "shell_unavailable", errorMessage: "无法读取回收站" }),
      junkCategory("user_temp", 0, 0, { status: "unavailable", errorCode: "access_denied", errorMessage: "部分路径无权限读取" }),
      junkCategory("system_temp", 0, 0),
      junkCategory("crash_dumps", 0, 0),
    ],
  };
  const junkExecuteOk = {
    jobId: "junkjob-mock",
    startedAt: iso(0),
    finishedAt: iso(0),
    status: "success",
    totalFreedBytes: 35651584,
    totalDeletedFiles: 15,
    categories: [
      { category: "recycle_bin", status: "success", candidates: 3, estimatedBytes: 1258291, freedBytes: 1258291, deletedFiles: 3, skippedFiles: 0, failedFiles: 0 },
      { category: "user_temp", status: "success", candidates: 12, estimatedBytes: 34393293, freedBytes: 34393293, deletedFiles: 12, skippedFiles: 1, failedFiles: 0 },
    ],
  };
  const junkExecutePartial = {
    jobId: "junkjob-mock",
    startedAt: iso(0),
    finishedAt: iso(0),
    status: "partial",
    totalFreedBytes: 2306867,
    totalDeletedFiles: 9,
    categories: [
      { category: "recycle_bin", status: "success", candidates: 3, estimatedBytes: 1258291, freedBytes: 1258291, deletedFiles: 3, skippedFiles: 0, failedFiles: 0 },
      { category: "system_temp", status: "partial", candidates: 7, estimatedBytes: 10485760, freedBytes: 1048576, deletedFiles: 6, skippedFiles: 4, failedFiles: 1, errorCode: "locked_file", errorMessage: "部分文件被占用" },
      { category: "user_temp", status: "failed", candidates: 0, estimatedBytes: 0, freedBytes: 0, deletedFiles: 0, skippedFiles: 0, failedFiles: 0, errorCode: "access_denied", errorMessage: "部分路径无权限读取" },
    ],
  };
  const junkPreviewFor = (mode) => (mode === "empty" ? junkEmpty : mode === "partial" ? junkPartial : mode === "unavailable" ? junkUnavailable : junkOk);

  // 「导出给 Agent」面板夹具：覆盖窗口可用 / 已安装 / 未安装与超长名称。
  const agentCap = (supported, evidence, note) => ({ supported, evidence, note });
  const clipboardAgentTargets = [
    { source_id: "codex", display_name: "Codex", installed: true, window_present: true, evidence: "window-present", note: "窗口可用：可手动逐项粘贴，或导出本地包", direct_send: agentCap(false, "unsupported-interface", "当前没有经过验证的结构化发送接口，不会自动上传或发送。"), file_import: agentCap(false, "unverified", "官方文件导入接口未验证，需要在应用内手动附加导出包。"), desktop_paste: agentCap(true, "window-present", "需用户手动选择窗口并逐项触发，只代表按键动作已发送，接收情况无法确认。"), export: agentCap(true, "local-export", "本地导出始终可用，不自动上传。"), recommended: "paste" },
    { source_id: "claude", display_name: "Claude Code (Windows Experimental Preview 2026.11 — 超长名称与英文技术标识)", installed: true, window_present: false, evidence: "exe-found", note: "已安装：当前没有可交互窗口", direct_send: agentCap(false, "unsupported-interface", "没有可直接调用的结构化接口。"), file_import: agentCap(true, "verified-interface", "支持在会话中附加本地文件，需用户手动操作。"), desktop_paste: agentCap(false, "exe-found", "未检测到可交互窗口，无法手动逐项粘贴。"), export: agentCap(true, "local-export", "本地导出始终可用。"), recommended: "import" },
    { source_id: "cursor", display_name: "Cursor", installed: true, window_present: true, evidence: "window-present", note: "窗口可用：可手动逐项粘贴，或导出本地包", direct_send: agentCap(false, "unsupported-interface", "没有可直接调用的结构化接口。"), file_import: agentCap(false, "unverified", "文件导入接口未验证。"), desktop_paste: agentCap(true, "window-present", "需用户手动选择窗口并逐项触发。"), export: agentCap(true, "local-export", "本地导出始终可用。"), recommended: "paste" },
    { source_id: "trae", display_name: "Trae", installed: true, window_present: false, evidence: "exe-found", note: "已安装：当前没有可交互窗口", direct_send: agentCap(false, "unsupported-interface", "没有可直接调用的结构化接口。"), file_import: agentCap(false, "unverified", "文件导入接口未验证。"), desktop_paste: agentCap(false, "exe-found", "未检测到可交互窗口。"), export: agentCap(true, "local-export", "本地导出始终可用。"), recommended: "export" },
    { source_id: "windsurf", display_name: "Windsurf", installed: false, window_present: false, evidence: "not-installed", note: "未安装", direct_send: agentCap(false, "not-installed", "未安装，无法发送。"), file_import: agentCap(false, "not-installed", "未安装，无法导入。"), desktop_paste: agentCap(false, "not-installed", "未安装，无法桌面粘贴。"), export: agentCap(true, "local-export", "仍可导出本地文件后手动附加。"), recommended: "export" },
    { source_id: "opencode", display_name: "OpenCode", installed: true, window_present: true, evidence: "window-present", note: "窗口可用：可手动逐项粘贴，或导出本地包", direct_send: agentCap(false, "unsupported-interface", "没有可直接调用的结构化接口。"), file_import: agentCap(false, "unverified", "文件导入接口未验证。"), desktop_paste: agentCap(true, "window-present", "需用户手动选择窗口并逐项触发。"), export: agentCap(true, "local-export", "本地导出始终可用。"), recommended: "paste" },
  ];
  const clipboardExportPackage = {
    dir: "C:\\\\Users\\\\preview\\\\AppData\\\\Roaming\\\\task-dock\\\\agent-exports\\\\20261104-201500-cg1",
    markdown_path: "C:\\\\Users\\\\preview\\\\AppData\\\\Roaming\\\\task-dock\\\\agent-exports\\\\20261104-201500-cg1\\\\clipboard.md",
    manifest_path: "C:\\\\Users\\\\preview\\\\AppData\\\\Roaming\\\\task-dock\\\\agent-exports\\\\20261104-201500-cg1\\\\manifest.json",
    files: ["clipboard.md", "manifest.json", "image-01.png"],
    item_count: 3,
    summary: "已导出 3 项（图片 1 张）",
    warnings: [],
  };

  // ── 智能剪贴板夹具（v0.6 视觉走查：抽屉展开态）──
  const clipboardItems = [
    { id: "ci1", kind: "text", text: "POST /api/session/start 返回 202，已进入队列。", html: "", preview: "POST /api/session/start 返回 202…", title: "接口返回：POST /api/session/sta…", title_source: "auto", has_image: false, has_thumb: false, byte_size: 168, source_app: "Code.exe", source_title: "session.rs - task-dock", image_width: null, image_height: null, file_paths: [], favorite: true, pinned: false, copy_count: 2, created_at: iso(12), last_seen_at: iso(12), sensitive: false },
    { id: "ci2", kind: "link", text: "https://tauri.app/", html: "", preview: "https://tauri.app/", title: "tauri.app", title_source: "auto", has_image: false, has_thumb: false, byte_size: 21, source_app: "msedge.exe", source_title: "Tauri", image_width: null, image_height: null, file_paths: [], favorite: false, pinned: true, copy_count: 1, created_at: iso(26), last_seen_at: iso(26), sensitive: false },
    { id: "ci3", kind: "html", text: "", html: "<p>周报要点</p>", preview: "周报要点", title: "周报要点", title_source: "manual", has_image: false, has_thumb: false, byte_size: 92, source_app: "WINWORD.EXE", source_title: "周报.docx", image_width: null, image_height: null, file_paths: [], favorite: false, pinned: false, copy_count: 1, created_at: iso(48), last_seen_at: iso(48), sensitive: false },
    { id: "ci4", kind: "image", text: "", html: "", preview: "截图 1280×720", title: "截图 1280×720", title_source: "auto", has_image: true, has_thumb: true, byte_size: 24576, source_app: "SnippingTool.exe", source_title: "截屏", image_width: 1280, image_height: 720, file_paths: [], favorite: false, pinned: false, copy_count: 1, created_at: iso(64), last_seen_at: iso(64), sensitive: false },
    { id: "ci5", kind: "files", text: "", html: "", preview: "3 个文件", title: "README.md 等 3 个文件", title_source: "auto", has_image: false, has_thumb: false, byte_size: 0, source_app: "Explorer.exe", source_title: "资源管理器", image_width: null, image_height: null, file_paths: ["D:\\Develop\\task_dock\\README.md", "D:\\Develop\\task_dock\\docs\\ARCHITECTURE.md", "D:\\Develop\\task_dock\\package.json"], favorite: false, pinned: false, copy_count: 1, created_at: iso(90), last_seen_at: iso(90), sensitive: false },
  ];
  // 智能连续收集走查夹具：覆盖图片组 / 文本组 / 链接组 / 文件组 / 混合组 / 单项遗留组，
  // 并保留一条没有 kind_counts / cover_items 的旧分组，验证前端回退路径。
  const clipExtra = (o) => ({
    id: o.id, kind: o.kind, text: o.text ?? "", html: "", preview: o.preview,
    title: o.title ?? "", title_source: "auto", has_image: o.kind === "image",
    has_thumb: o.kind === "image", byte_size: o.bytes ?? 32,
    source_app: o.app ?? "Code.exe", source_title: o.win ?? "", image_width: o.w ?? null,
    image_height: o.h ?? null, file_paths: o.files ?? [], favorite: false, pinned: false,
    copy_count: 1, created_at: iso(o.ago ?? 5), last_seen_at: iso(o.ago ?? 5), sensitive: false,
  });
  const clipImg1 = clipExtra({ id: "ci6", kind: "image", preview: "截图 1920×1080", title: "截图 1920×1080", w: 1920, h: 1080, app: "SnippingTool.exe", win: "截屏", ago: 3 });
  const clipImg2 = clipExtra({ id: "ci7", kind: "image", preview: "截图 1366×768", title: "截图 1366×768", w: 1366, h: 768, app: "SnippingTool.exe", win: "截屏", ago: 4 });
  const clipImg3 = clipExtra({ id: "ci8", kind: "image", preview: "截图 1024×640", title: "截图 1024×640", w: 1024, h: 640, app: "SnippingTool.exe", win: "截屏", ago: 5 });
  const clipLongText1 = clipExtra({
    id: "ci9", kind: "text", app: "WINWORD.EXE", win: "会议纪要.docx", ago: 8,
    preview: "会议纪要：确认交付节奏与验收范围，下周一同步给客户；联调窗口从周三提前到周二，接口冻结时间不变；设计稿以 v07 为准，冻结后不再接受配色调整。",
    title: "会议纪要：交付节奏与验收范围",
  });
  const clipLongText2 = clipExtra({
    id: "ci10", kind: "text", app: "WINWORD.EXE", win: "会议纪要.docx", ago: 9,
    preview: "第二段：接口联调负责人张三，本周五前给出联调结论；前端回归由李四负责，覆盖 320 / 400 窄窗与深浅主题。",
    title: "",
  });
  const clipUrl1 = clipExtra({
    id: "ci11", kind: "link", app: "chrome.exe", win: "GitHub Actions - Google Chrome", ago: 12,
    preview: "https://docs.github.com/zh/actions/using-workflows/workflow-syntax-for-github-actions",
    title: "GitHub Actions 工作流语法",
  });
  const clipUrl2 = clipExtra({
    id: "ci12", kind: "link", app: "chrome.exe", win: "Figma - Google Chrome", ago: 13,
    preview: "https://www.figma.com/file/abcdef/Design-System?node-id=12%3A3456",
    title: "Design System – Figma",
  });
  const clipFiles1 = clipExtra({
    id: "ci13", kind: "files", app: "explorer.exe", win: "下载", ago: 16,
    preview: "3 个文件", title: "季度报告.docx 等 3 个文件",
    files: ["C:\\Users\\preview\\Downloads\\季度报告.docx", "C:\\Users\\preview\\Downloads\\预算.xlsx", "C:\\Users\\preview\\Downloads\\立项说明.pdf"],
  });
  const clipFiles2 = clipExtra({
    id: "ci14", kind: "files", app: "explorer.exe", win: "下载", ago: 17,
    preview: "2 个文件", title: "评审记录.md 等 2 个文件",
    files: ["C:\\Users\\preview\\Downloads\\评审记录.md", "C:\\Users\\preview\\Downloads\\截图清单.txt"],
  });
  const clipSingle = clipExtra({
    id: "ci15", kind: "text", app: "notepad.exe", win: "无标题 - 记事本", ago: 22,
    preview: "单条复制：仅一条内容，还不足以成立自动分组，作为候选等待下一条连续复制。",
    title: "单条复制候选",
  });
  // 灯箱走查夹具：7 图组验证箭头/序号，57 图组验证跨单页 50 张后的分页追加。
  const clipMany = Array.from({ length: 57 }, (_, idx) => {
    const w = 1600;
    const h = 900 - (idx % 4) * 90;
    return clipExtra({
      id: "cbig" + (idx + 1), kind: "image", preview: "截图 " + w + "×" + h, title: "截图 " + w + "×" + h,
      w, h, app: "SnippingTool.exe", win: "截屏", ago: 2,
    });
  });

  const clipGroup = (o) => ({
    id: o.id, name: o.name, mode: "auto", status: o.status ?? "closed", favorite: false,
    pinned: o.pinned ?? false, created_at: iso(o.ago), updated_at: iso(o.ago - 1),
    closed_at: iso(o.ago - 1), item_count: o.items.length,
    image_count: o.items.filter((i) => i.kind === "image").length,
    preview: o.preview ?? "", kind_counts: o.counts, cover_items: o.covers ?? [], items: o.items,
  });
  const clipCounts = (items) => ({
    image: items.filter((i) => i.kind === "image").length,
    text: items.filter((i) => i.kind === "text" || i.kind === "html").length,
    html: items.filter((i) => i.kind === "html").length,
    url: items.filter((i) => i.kind === "link" || i.kind === "url").length,
    files: items.filter((i) => i.kind === "files").length,
  });
  const clipGroups = (items, o) => clipGroup({ ...o, items, counts: clipCounts(items) });

  clipboardItems.push(clipImg1, clipImg2, clipImg3, clipLongText1, clipLongText2, clipUrl1, clipUrl2, clipFiles1, clipFiles2, clipSingle);

  const clipboardGroups = [
    clipGroups([clipImg1, clipImg2, clipImg3], { id: "cg-img", name: "连续截图 · 调试过程", ago: 3, preview: "截图 1920×1080", covers: [clipImg1, clipImg2, clipImg3], status: "collecting" }),
    clipGroups([clipImg1], { id: "cg-img1", name: "截图 · 单图", ago: 4, preview: "截图 1920×1080", covers: [clipImg1] }),
    clipGroups(clipMany.slice(0, 7), { id: "cg-img7", name: "截图 · 项目评审", ago: 2, preview: clipMany[0].preview, covers: clipMany.slice(0, 3) }),
    clipGroups(clipMany, { id: "cg-img57", name: "截图 · 长图集", ago: 1, preview: clipMany[0].preview, covers: clipMany.slice(0, 3) }),
    clipGroups([clipLongText1, clipLongText2], { id: "cg-text", name: "会议纪要摘录", ago: 8, preview: clipLongText1.preview }),
    clipGroups([clipUrl1, clipUrl2], { id: "cg-link", name: "工作流与设计稿链接", ago: 12, preview: clipUrl1.preview }),
    clipGroups([clipFiles1, clipFiles2], { id: "cg-files", name: "季度报告相关文件", ago: 16, preview: clipFiles1.title }),
    clipGroups([clipImg1, clipLongText1, clipImg2, clipUrl1], { id: "cg-mixed", name: "登录流程排查记录", ago: 3, preview: clipLongText1.preview, covers: [clipImg1, clipLongText1, clipImg2] }),
    clipGroups([clipSingle], { id: "cg-single", name: "单条复制候选", ago: 22, preview: clipSingle.preview }),
    // 旧数据：后端未补充 kind_counts / cover_items 时，前端按 item_count + image_count 回退。
    { id: "cg1", name: "调试截图（3 项）", mode: "auto", status: "closed", favorite: false, pinned: false, created_at: iso(70), updated_at: iso(60), closed_at: iso(60), item_count: 3, image_count: 1, preview: "截图 1280×720" },
  ];
  const clipboardStats = {
    items: clipboardItems.length,
    groups: clipboardGroups.length,
    images: 1,
    files: 1,
    favorites: 1,
    bytes: 24857,
    asset_bytes: 24576,
    max_items: 2000,
    max_storage_bytes: 2048 * 1024 * 1024,
    enabled: true,
    paused: false,
    auto_group: true,
  };
  const clipboardView = { items: clipboardItems, groups: clipboardGroups, stats: clipboardStats, total_items: clipboardItems.length };
  const contextAgents = [
    { link_id: "al1", source_id: "codex", source_name: "Codex", session_external_id: "sess-alpha", title: "重构认证中间件", state: "failed", last_seen_at: iso(6), origin: "user" },
    { link_id: null, source_id: "trae", source_name: "Trae", session_external_id: "sess-gamma", title: "补充需求讨论", state: "waiting", last_seen_at: iso(40), origin: "nav" },
  ];

  const discovered = [    { source_id: "codex", display_name: "Codex", transport_kind: "transport", installed: true, version: "0.42.0", install_paths: ["~/.codex"], config_homes: [], install_method: "npm", running_instances: [{ pid: 111, name: "codex", exe: null }], capabilities: [], supported_events: ["running", "waiting", "completed", "failed"], docs_url: "", limitations: [], registered: true, enabled: true, configured: true, verified: true, last_event_at: iso(2), health_state: "live" },
    { source_id: "trae", display_name: "Trae", transport_kind: "transport", installed: true, version: null, install_paths: [], config_homes: [], install_method: "", running_instances: [], capabilities: [], supported_events: ["running", "completed"], docs_url: "", limitations: ["CN 版路径不同"], registered: true, enabled: true, configured: true, verified: false, last_event_at: iso(90), health_state: "stale" },
    { source_id: "zcode", display_name: "ZCode", transport_kind: "discovery", installed: true, version: null, install_paths: [], config_homes: [], install_method: "", running_instances: [{ pid: 222, name: "zcode", exe: null }], capabilities: [], supported_events: [], docs_url: "", limitations: ["事件桥接待验证"], registered: true, enabled: true, configured: false, verified: false, last_event_at: null, health_state: "no-events" },
    { source_id: "qoder", display_name: "Qoder", transport_kind: "transport", installed: false, version: null, install_paths: [], config_homes: [], install_method: "", running_instances: [], capabilities: [], supported_events: [], docs_url: "", limitations: [], registered: true, enabled: true, configured: false, verified: false, last_event_at: null, health_state: "unregistered" },
  ];

  const backups = [
    { name: "task-dock-20261024-0300.db.bak", size: 233472, modified: iso(1500) },
    { name: "task-dock-20261023-0300.db.bak", size: 229376, modified: iso(2900) },
  ];

  // ── 手机与同步 / 文件互传（视觉走查夹具）──
  // 覆盖可下载、接收中、已接收、失败四种状态，用来核对分组头、状态胶囊与
  // 320/400 窄窗下的文件名截断。
  const mobileSyncStatus = {
    enabled: true, running: true, port: 47822, lan_ip: "192.168.5.6",
    base_url: "http://192.168.5.6:47822", server_name: "LAPTOP-RTUVXZ-G",
    instance_id: "preview-instance", fingerprint: "1A2B3C4D", error: null,
    pairing: null, paired_device: null,
    devices: [
      { id: "dev-1", name: "vivo V2323A", platform: "android", created_at: iso(600), last_seen_at: iso(3), last_ip: "192.168.5.7", revoked_at: null },
    ],
  };
  const mobileFiles = [
    { id: "mf1", direction: "to_phone", name: "季度复盘-最终版.pdf", size: 2489344, sha256: "", status: "ready", chunk_size: 196608, chunks: 13, received_chunks: 0, created_at: iso(2), updated_at: iso(2), completed_at: null },
    { id: "mf2", direction: "to_phone", name: "会议录音 2026-11-09.m4a", size: 18350080, sha256: "", status: "pending", chunk_size: 196608, chunks: 94, received_chunks: 37, created_at: iso(4), updated_at: iso(1), completed_at: null },
    { id: "mf3", direction: "to_desktop", name: "手机文件-20261109-204735.txt", size: 54, sha256: "", status: "ready", chunk_size: 196608, chunks: 1, received_chunks: 1, created_at: iso(8), updated_at: iso(8), completed_at: iso(8) },
    { id: "mf4", direction: "to_desktop", name: "IMG_20261109_2031.jpg", size: 4194304, sha256: "", status: "failed", chunk_size: 196608, chunks: 22, received_chunks: 0, created_at: iso(12), updated_at: iso(12), completed_at: null },
  ];

  let cbId = 0;
  /** 走查用：每次读取推进 10 秒，让概览短时趋势在预览里也能形成折线。 */
  let snapshotTick = 0;
  const listeners = {};

  // 统一工作台（workbench-preview.html）走查夹具：两个示例项目，仅 harness 使用。
  // 注意：本文件主体位于模板字符串内，路径反斜杠必须写四个（经字符串折叠后剩两个）。
  const WORKBENCH_PROJECTS = [
    { id: "wp1", name: "产品研发工作空间", kind: "general", status: "active", rootPath: "", rootExists: false, devProjectId: null, devProjectExists: false, devProjectName: null, note: "", itemCount: 12, taskLinkCount: 5, createdAt: iso(600), updatedAt: iso(30) },
    { id: "wp2", name: "星港回响 · AI 漫剧", kind: "ai_comic", status: "active", rootPath: "D:\\\\Projects\\\\starlight", rootExists: true, devProjectId: null, devProjectExists: false, devProjectName: null, note: "", itemCount: 28, taskLinkCount: 9, createdAt: iso(1200), updatedAt: iso(90) },
  ];

  async function invoke(cmd, args) {
    await new Promise((r) => setTimeout(r, 30));
    switch (cmd) {
      case "get_settings": return settings;
      case "update_settings": return { ...settings, ...(args?.patch || {}) };
      // ── 统一工作台外壳（workspace.html）走查：Shell 启动门 + 首页/状态栏最小数据 ──
      case "workspace_project_list": return { projects: WORKBENCH_PROJECTS };
      case "dev_project_list": return { projects: [] };
      case "workspace_project_save": return { project: WORKBENCH_PROJECTS[0] };
      case "workspace_set_active_project": return { ok: true };
      case "workbench_take_nav": return null;
      case "workbench_nav_ack": return undefined;
      case "resource_snapshot":
        return {
          sampledAt: iso(0),
          application: { knownCacheBytes: 0, knownCacheFiles: 0, status: "ready" },
          memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
          disks: [
            { volume: "D:", kind: "fixed", totalBytes: 512 * 1024 ** 3, availableBytes: 428 * 1024 ** 3 },
            { volume: "C:", kind: "fixed", totalBytes: 512 * 1024 ** 3, availableBytes: 96 * 1024 ** 3 },
          ],
          process: { supported: true, truncated: false, omittedExternal: 0, omittedUnknown: 0, processes: [] },
        };
      case "plugin:app|version": return "0.0.0";
      // ── 手机与同步 / 文件互传 ──
      case "mobile_sync_status": return mobileSyncStatus;
      case "mobile_sync_revoke_device": return true;
      case "mobile_file_list": return FILES_EMPTY ? [] : mobileFiles;
      case "mobile_file_offer": return [];
      case "mobile_file_delete": return true;
      case "mobile_file_reveal":
      case "mobile_file_open_inbox": return null;
      case "lifecycle_status": return lifecycleStatus;
      case "resource_snapshot": {
        // 真实应用由后端按真实采样时间返回；预览夹具推进时间并轻微变化，
        // 否则固定 sampledAt 会被趋势去重，永远只有「正在采样」占位。
        snapshotTick += 1;
        const firstDisk = resourceSnapshot.disks[0];
        resourceSnapshot.sampledAt = iso(snapshotTick * 10);
        resourceSnapshot.memory = {
          ...resourceSnapshot.memory,
          availableBytes: resourceSnapshot.memory.availableBytes - snapshotTick * 48 * 1024 * 1024,
        };
        resourceSnapshot.disks = [
          {
            ...firstDisk,
            availableBytes: firstDisk.availableBytes - snapshotTick * 160 * 1024 * 1024,
          },
          ...resourceSnapshot.disks.slice(1),
        ];
        return resourceSnapshot;
      }
      case "resource_process_diagnostics": return resourceProcesses;
      case "resource_disk_usage": return resourceDiskUsage;
      case "resource_memory_catalog": return resourceMemoryCatalog;
      case "resource_memory_release": return { sampledAt: iso(0), releasedBytes: 0, sources: [] };
      case "resource_cleanup_preview":
        return { ...resourcePreview, previewId: "preview-" + Date.now(), createdAt: iso(0), expiresAt: new Date(Date.now() + 300000).toISOString() };
      case "resource_cleanup_execute": return resourceCleanupReport;
      case "resource_junk_preview": {
        const requested = Array.isArray(args && args.categories) ? args.categories : [];
        const base = junkPreviewFor(JUNK_MODE);
        const categories = requested.length
          ? base.categories.filter((c) => requested.indexOf(c.category) >= 0)
          : base.categories;
        return Object.assign({}, base, {
          previewId: "junk-" + Date.now(),
          expiresAt: JUNK_MODE === "expired"
            ? new Date(Date.now() - 60000).toISOString()
            : new Date(Date.now() + 300000).toISOString(),
          categories,
          totalCandidates: categories.reduce((a, c) => a + c.candidates, 0),
          totalEstimatedBytes: categories.reduce((a, c) => a + c.estimatedBytes, 0),
        });
      }
      case "resource_junk_execute":
        return JUNK_MODE === "partial" ? junkExecutePartial : junkExecuteOk;
      case "list_tasks": {
        const f = args?.filter || {};
        const q2 = (f.search || "").trim();
        const now2 = Date.now();
        return LIST_TASKS.filter((t) => {
          if (f.status && f.status !== "all" && t.status !== f.status) return false;
          if (q2 && !((t.title || "").includes(q2) || (t.description || "").includes(q2))) return false;
          // 仅补 overdue 视图语义（与后端一致：有截止时间、早于当前、仍未完成）；
          // 其余视图保持原 harness 行为，避免影响其他走查脚本
          if (f.view === "overdue") {
            const due = t.due_at ? new Date(t.due_at).getTime() : NaN;
            return Number.isFinite(due) && due < now2 && t.status === "pending";
          }
          return true;
        });
      }
      case "task_stats": return stats;
      case "active_reminders": return ACTIVE_REMINDERS;
      case "task_analytics": return analyticsFixture(args?.range || "day");
      case "focus_snapshot": return FOCUS_SNAPSHOT;
      case "focus_history": return FOCUS_HISTORY;
      case "list_task_links": return taskAgentLinks.filter((l) => l.task_id === args?.taskId);
      case "parse_quick_add": return { title: (args?.text || "").replace(/明天|下午|三点/g, "").trim() || "新任务", due_at: iso(1440), recurrence: null, advance_minutes: null, matched: ["明天", "下午三点"], has_explicit_time: true, date_only: false };
      case "agent_snapshot": return snapshot;
      case "discovery_scan": return discovered;
      case "list_notifications": return notifications;
      // v0.7 历史页改用分页命令：shim 返回同一批 fixture 包装成页对象
      case "notification_page": return { items: notifications, has_more: false, filtered_total: notifications.length };
      case "notification_inbox_stats": return { unread: notifications.filter((n) => !n.is_read).length, total: notifications.length };
      case "list_agent_events": return { items: events, has_more: false, filtered_total: events.length };
      case "actions_feed": {
        // 按分类返回真实子集：intervention 不含 running/reminder，notification 只含提醒；
        // 工作台同时消费两个分类，不能把同一批条目重复渲染两次。
        const feedCategory = args?.filter?.category || "intervention";
        const feedKind = args?.filter?.kind;
        const inCategory =
          feedCategory === "notification"
            ? actionItems.filter((i) => i.kind === "reminder")
            : actionItems.filter((i) =>
                ["failed", "authorization", "waiting_input"].includes(i.kind),
              );
        const items = feedKind ? inCategory.filter((i) => i.kind === feedKind) : inCategory;
        return {
          ...actionFeed,
          category: feedCategory,
          items,
          db_total: items.length,
          filtered_total: items.length,
          loaded: items.length,
        };
      }
      case "planning_list_projects":
        return planningProjects.filter((p) => args?.includeArchived || !p.archived);
      case "planning_list_features":
        return planningFeatures.filter((f) => f.project_id === args?.projectId);
      case "planning_list_milestones":
        return planningMilestones.filter((m) => m.project_id === args?.projectId);
      case "planning_activity_page": {
        const items = planningActivity.filter(
          (a) => a.project_id === args?.projectId && (!args?.featureId || a.feature_id === args.featureId),
        );
        return { items, has_more: false };
      }
      case "actions_ack":
      case "actions_unack": return 1;
      case "actions_open_session": return { success: true, requested_action: "resume_session", actual_action: "resume_session", fallback_used: false, target_id: args?.sessionId ?? "", reason: null, verification_level: "window-confirmed" };
      case "workspace_list":
        return args?.taskId ? snapshots.filter((s) => s.task_id === args.taskId) : snapshots;
      case "workspace_get": {
        const s = snapshots.find((x) => x.id === args?.id);
        return s ? snapshotDetail(s) : null;
      }
      case "workspace_capture_windows": return [
        { hwnd: 111, title: "task_dock — D:\\\\Develop", class_name: "Chrome_WidgetWin", exe_path: "C:\\\\Apps\\\\Code.exe", is_minimized: false },
        { hwnd: 333, title: "微信", class_name: "WeChatMainWndForPC", exe_path: "C:\\\\Tencent\\\\WeChat\\\\WeChat.exe", is_minimized: true },
        { hwnd: 444, title: "设置", class_name: "ApplicationFrameWindow", exe_path: null, is_minimized: false },
      ];
      case "workspace_capture_task":
      case "workspace_create": {
        const box = snapshots[0];
        return { ...snapshotDetail(box), id: "ws-new", name: args?.input?.name || "新现场", item_count: 2 };
      }
      case "workspace_restore": return true;
      case "workspace_restore_cancel": return null;
      case "workspace_restore_status": return { running: false, snapshot_id: null, cancel_requested: false };
      case "workspace_delete":
      case "workspace_rename":
      case "workspace_detach_task": return null;
      // ── 收集箱 / 文件暂存（视觉走查夹具）──
      // 缺这些命令时 store 会拿到 null 并在 .filter 处抛错，整页变成「加载失败」。
      case "quick_capture_list": {
        const all = [
          { id: "cap1", client_id: "cc1", kind: "idea", content: "把历史页未读改成小圆点，保留 Agent 事件与通知类型", url: null, note: null, status: "inbox", task_id: null, source: "capture", created_at: iso(18), updated_at: iso(18) },
          { id: "cap2", client_id: "cc2", kind: "todo", content: "核对暂存架选中态与 hover 是否混淆", url: null, note: null, status: "inbox", task_id: null, source: "capture", created_at: iso(42), updated_at: iso(42) },
          { id: "cap3", client_id: "cc3", kind: "link", content: "CSS @layer 优先级说明", url: "https://developer.mozilla.org/docs/Web/CSS/@layer", note: null, status: "inbox", task_id: null, source: "capture", created_at: iso(96), updated_at: iso(96) },
          { id: "cap4", client_id: "cc4", kind: "text", content: "长文本条目：这里放一段足够长的内容，用来检查收集箱卡片在窄窗口下是否换行而不是撑破布局，同时确认已处理条目的弱化样式仍然可读。", url: null, note: null, status: "handled", task_id: null, source: "capture", created_at: iso(150), updated_at: iso(140) },
        ];
        const status = args?.status;
        const list = status === "inbox" ? all.filter((i) => i.status === "inbox") : all;
        return list.slice(args?.offset ?? 0, (args?.offset ?? 0) + (args?.limit ?? 100));
      }
      case "quick_capture_state": return { draft: null, last_type: "task", inbox_count: 3 };
      case "quick_capture_show":
      case "quick_capture_hide": return null;
      case "shelf_list": return {
        items: [
          { id: "sh1", kind: "file", display_name: "global-card-spec.md", source_kind: "picker", storage_mode: "reference", original_path: "D:\\\\Develop\\\\task_dock\\\\docs\\\\ui-themes\\\\01-design-spec.md", managed_path: null, content: null, byte_size: 18432, file_ext: "md", favorite: false, pinned: true, exists_state: "ok", group_id: "sg1", scene_id: null, note: "", expire_at: null, created_at: iso(30), updated_at: iso(20) },
          { id: "sh2", kind: "image", display_name: "history-sticky.png", source_kind: "drag", storage_mode: "managed", original_path: "C:\\\\Users\\\\demo\\\\Desktop\\\\history-sticky.png", managed_path: "images/sh2.png", content: null, byte_size: 24680, file_ext: "png", favorite: true, pinned: false, exists_state: "ok", group_id: null, scene_id: null, note: "", expire_at: null, created_at: iso(120), updated_at: iso(110) },
          { id: "sh3", kind: "link", display_name: "CSS Color Mix 说明", source_kind: "url", storage_mode: "link", original_path: null, managed_path: null, content: "https://developer.mozilla.org/docs/Web/CSS/color_value/color-mix", byte_size: 0, file_ext: null, favorite: false, pinned: false, exists_state: "ok", group_id: null, scene_id: null, note: "材质淡染参考", expire_at: null, created_at: iso(200), updated_at: iso(190) },
          { id: "sh4", kind: "folder", display_name: "旧版验收截图（已移动）", source_kind: "picker", storage_mode: "reference", original_path: "D:\\\\Archive\\\\old-shots", managed_path: null, content: null, byte_size: 0, file_ext: null, favorite: false, pinned: false, exists_state: "missing", group_id: "sg1", scene_id: null, note: "", expire_at: null, created_at: iso(300), updated_at: iso(290) },
          { id: "sh5", kind: "text", display_name: "卡片分层职责草稿", source_kind: "manual", storage_mode: "reference", original_path: null, managed_path: null, content: "基础材质 / 方案 D 变体 / 交互变体", byte_size: 0, file_ext: null, favorite: false, pinned: false, exists_state: "ok", group_id: null, scene_id: null, note: "", expire_at: null, created_at: iso(420), updated_at: iso(400) },
        ],
        total: 5,
      };
      case "shelf_stats": return { total: 5, file_count: 1, image_count: 1, folder_count: 1, link_count: 1, text_count: 1, managed_bytes: 24680, disk_bytes: 43112, quota_mb: 2048 };
      case "shelf_groups": return [
        { id: "sg1", name: "设计规范", builtin: false, sort_order: 0, item_count: 2 },
        { id: "sg2", name: "截图", builtin: false, sort_order: 1, item_count: 1 },
      ];
      case "shelf_check_exists": return (args?.ids ?? []).map((id) => ({ id, exists_state: id === "sh4" ? "missing" : "ok" }));
      case "shelf_task_links": return [];
      // 快速笔记列表：缺失时笔记页会拿到 null 并触发 ErrorBoundary。
      case "notes_list": return [
        { id: "n1", title: "全局卡片分层职责", excerpt: "基础材质 / 方案 D 变体 / 交互变体三段拆分", pinned: true, favorite: false, task_id: "t1", workspace_id: null, source_capture_id: null, revision: 3, created_at: iso(600), updated_at: iso(40), content_chars: 128 },
        { id: "n2", title: "历史页未读语义", excerpt: "紫色左边条原本被误读为优先级，改为标题行小圆点", pinned: false, favorite: true, task_id: null, workspace_id: null, source_capture_id: null, revision: 2, created_at: iso(900), updated_at: iso(120), content_chars: 96 },
        { id: "n3", title: "sticky 日期标签", excerpt: "不透明淡染底 + hairline，不用 backdrop-filter", pinned: false, favorite: false, task_id: null, workspace_id: null, source_capture_id: null, revision: 1, created_at: iso(1200), updated_at: iso(300), content_chars: 64 },
        { id: "n4", title: "长标题多行检查用笔记", excerpt: "这一段用来观察窄窗口下标题与摘要的换行与截断是否仍然稳定，不会把卡片撑破。", pinned: false, favorite: false, task_id: null, workspace_id: null, source_capture_id: null, revision: 1, created_at: iso(1500), updated_at: iso(420), content_chars: 80 },
      ];
      case "notes_get": return { id: args?.id ?? "n1", title: "全局卡片分层职责", content: "基础材质：卡面 / 圆角 / 边缘反射 / 阴影；方案 D 变体：柔和流线高光；交互变体：hover / focus / selected", pinned: true, favorite: false, task_id: "t1", workspace_id: null, source_capture_id: null, revision: 3, created_at: iso(600), updated_at: iso(40) };
      case "notes_templates": return [];
      case "clipboard_snapshot_links":
        return clipboardSnapLinks.filter((l) => l.snapshot_id === args?.snapshotId);
      // 真机 IPC 每次返回新反序列化的对象；夹具必须同样返回快照，
      // 否则删除类 mock 就地 splice 会直接改写 store 里的 view，
      // 让「离场中按原位钉住」在走查前就找不到目标行（假阴性）。
      case "clipboard_view":
        return {
          items: clipboardItems.map((i) => ({ ...i })),
          // 列表接口与真实契约一致：不返回分组明细 items，只有详情接口才带。
          groups: clipboardGroups.map(({ items: _detail, ...g }) => ({ ...g })),
          stats: { ...clipboardStats, items: clipboardItems.length, groups: clipboardGroups.length },
          total_items: clipboardItems.length,
        };
      case "clipboard_stats": return { ...clipboardStats, items: clipboardItems.length, groups: clipboardGroups.length };
      case "clipboard_item": return clipboardItems.find((i) => i.id === args?.itemId) ?? clipboardItems[0];
      // 分组详情接口必须带 items/image_count/preview（bridge.ClipboardGroup 的「仅详情接口填充」字段），
      // 缺 items 会让 ClipboardGroupDetail 遍历 group.items 时直接崩树（白屏）。
      case "clipboard_group": {
        const g = clipboardGroups.find((x) => x.id === args?.groupId) ?? clipboardGroups[0];
        const { items: detail, ...rest } = g;
        return { ...rest, items: (detail ?? []).map((i) => ({ ...i })) };
      }
      // 分组图片分页（灯箱走查）：只返回请求范围内的图片元数据，offset 在图片行内计算。
      case "clipboard_group_page": {
        const g = clipboardGroups.find((x) => x.id === args?.groupId);
        const images = (g?.items ?? []).filter((i) => (args?.imagesOnly ? i.kind === "image" : true));
        const offset = Math.max(0, args?.offset ?? 0);
        const limit = Math.min(50, Math.max(1, args?.limit ?? 50));
        return {
          groupId: args?.groupId, items: images.slice(offset, offset + limit).map((i) => ({ ...i })),
          totalCount: images.length, imageCount: g?.image_count ?? images.length,
          offset, limit, revision: "rev-" + images.length + "-" + (g?.updated_at ?? ""),
        };
      }
      // 灯箱走查占位原图（真实链路由后端返回 PNG data URL；这里只用于布局/交互走查）
      case "clipboard_image":
        return "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900'><rect width='1600' height='900' fill='%23212a36'/><rect x='80' y='80' width='1440' height='740' fill='%23dce6f5'/><text x='120' y='180' font-size='64' fill='%23212a36'>preview image</text></svg>";
      case "clipboard_thumb":
        // 走查截图缩略图用：给一张占位图（真实链路由后端按 item 返回 PNG data URL）
        return "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='76'><rect width='120' height='76' fill='%2361789a'/><rect x='8' y='8' width='104' height='60' fill='%23dce6f5'/></svg>";
      case "clipboard_link_snapshot":
        return { id: "csl-new", snapshot_id: args?.snapshotId, target_type: args?.targetType, target_id: args?.targetId, created_at: iso(0), label: "预览素材", kind: "text" };
      case "clipboard_unlink_snapshot": return null;
      case "clipboard_task_links": return clipboardTaskLinks.filter((l) => l.task_id === args?.taskId);
      case "clipboard_link_task": return { id: "cl-new", task_id: args?.taskId, target_type: args?.targetType, target_id: args?.targetId, created_at: iso(0), label: "预览素材", kind: "text" };
      case "clipboard_unlink_task": return null;
      case "clipboard_status": return clipboardStatus;
      case "clipboard_agent_targets": return clipboardAgentTargets;
      case "clipboard_export_for_agent": return clipboardExportPackage;
      case "clipboard_probe": return { ok: true, message: "预览夹具：剪贴板可用", keys: ["Ctrl+C"], checked_at: iso(0) };
      case "clipboard_visible_targets": return [];
      case "clipboard_foreground_target": return null;
      // 复制类命令统一返回 CopyReport（前端 reportCopy 读 mode/bytes/warnings/item_count）
      case "clipboard_copy_item":
      case "clipboard_copy_group_rich":
      case "clipboard_copy_group_files":
      case "clipboard_copy_items_rich":
      case "clipboard_copy_items_files":
        return { mode: "text", bytes: 168, warnings: [], sequence: 1, item_count: 1 };
      case "clipboard_copy_text": return null;
      case "clipboard_toggle_item":
        return clipboardItems.find((i) => i.id === args?.itemId) ?? clipboardItems[0];
      case "clipboard_toggle_group":
        return { ...clipboardGroups[0] };
      case "clipboard_rename_item": {
        const it = clipboardItems.find((i) => i.id === args?.itemId);
        if (it) {
          it.title = args?.title || it.preview;
          it.title_source = args?.title ? "manual" : "auto";
        }
        return it ?? null;
      }
      case "clipboard_delete_items": {
        const ids = new Set(args?.ids ?? []);
        const removed = clipboardItems.filter((i) => ids.has(i.id)).length;
        for (let k = clipboardItems.length - 1; k >= 0; k -= 1) {
          if (ids.has(clipboardItems[k].id)) clipboardItems.splice(k, 1);
        }
        return { deleted: removed, freed_bytes: removed * 20, retained_shared: 0 };
      }
      case "clipboard_delete_group": {
        const gi = clipboardGroups.findIndex((g) => g.id === args?.groupId);
        if (gi >= 0) clipboardGroups.splice(gi, 1);
        return { deleted: 0, freed_bytes: 0, retained_shared: 0 };
      }
      case "clipboard_clear_history": {
        const cleared = { items: clipboardItems.length, groups: clipboardGroups.length };
        clipboardItems.length = 0;
        clipboardGroups.length = 0;
        return { ...cleared, freed_bytes: 24576, failed_files: 0 };
      }
      case "clipboard_cleanup":
        return {
          items_deleted: 0, groups_closed: 0, images_removed: 0, thumbs_removed: 0,
          orphan_files_removed: 0, bytes_freed: 0, retried: false,
        };
      case "task_context": {
        const task = tasks.find((t) => t.id === args?.taskId) || tasks[0];
        return {
          task,
          agents: contextAgents,
          navigation: navLinks.filter((l) => l.task_id === task.id),
          clipboard: [{ id: "cl1", task_id: task.id, target_type: "group", target_id: "cg1", created_at: iso(80), label: "接口调试截图（3 项）", kind: "image" }],
          snapshots: snapshots.filter((s) => s.task_id === task.id),
          actions: actionItems.filter((a) => a.task_id === task.id),
        };
      }
      case "list_backups": return backups;
      case "nav_all_task_links": return navLinks;
      case "nav_task_targets": return navLinks.filter((l) => l.task_id === args?.task_id);
      case "nav_list_targets": return navTargets;
      case "nav_scan_apps": {
        if (SCAN_MODE === "slow") {
          // 永不返回：用于走查「扫描中」门（取消按钮/进度）而不需要真实批次事件。
          return new Promise(() => {});
        }
        if (SCAN_MODE === "batchfail") {
          // 进度事件推送失败但权威结果完整：用于走查诊断分类（不应判为 partial）。
          return {
            apps: scanApps,
            scanned_at: iso(1),
            duration_ms: 420,
            counts: { startmenu: 3, registry: 0, uwp: 1, known: 1 },
            diagnostics: { batch_event_failed: 2 },
          };
        }
        if (SCAN_MODE === "partialbatch") {
          // 真实来源超时 + 进度推送失败并存：用于走查「不完整横幅」与进度说明不矛盾。
          return {
            apps: scanApps,
            scanned_at: iso(1),
            duration_ms: 420,
            counts: { startmenu: 3, registry: 0, uwp: 0, known: 1 },
            diagnostics: { uwp_scan_timeout: 1, batch_event_failed: 2 },
          };
        }
        if (SCAN_MODE === "cancelled") {
          return {
            apps: scanApps.slice(0, 2),
            scanned_at: iso(1),
            duration_ms: 120,
            counts: { startmenu: 2 },
            diagnostics: { scan_cancelled: 1 },
            cancelled: true,
          };
        }
        if (SCAN_MODE === "fail") {
          throw new Error("开始菜单来源读取失败（预览模拟）");
        }
        return { apps: scanApps, scanned_at: iso(1), duration_ms: 420, counts: { startmenu: 3, registry: 0, uwp: 1, known: 1 } };
      }
      case "nav_cancel_scan": return true;
      case "nav_target_running_states": {
        const states = {};
        for (const id of args?.ids ?? []) {
          states[id] = id === "nt1" ? "has_window" : id === "nt4" ? "process_only" : "not_running";
        }
        return states;
      }
      // 预览环境没有真实图标提取，返回 null 让 AppIcon 显示字母回退（真实图标走真机验收）
      case "nav_app_icon": return null;
      case "nav_recent_logs": return navLogs;
      case "nav_agent_capabilities": {
        const src = args?.source_id;
        if (src === "codex") return navCaps(src, true, true, false, true, "baseline-verified");
        if (src === "trae" || src === "qoder") return navCaps(src, true, true, true, false);
        if (src === "mock") return navCaps(src, false, false, false, false, "not-installed");
        return navCaps(src ?? "?", false, false, false, false, "unsupported-interface");
      }
      case "nav_agent_action":
      case "nav_navigate": {
        const t = navTargets.find((x) => x.id === args?.target_id);
        return { success: true, requested_action: "focus_window", actual_action: "focus_window", fallback_used: false, target_id: args?.target_id ?? "", reason: null, verification_level: "window-confirmed", ...(t ? {} : {}) };
      }
      case "nav_list_windows": return [
        { hwnd: 111, pid: 222, title: "task_dock — D:\\Develop", class_name: "Chrome_WidgetWin", is_minimized: false, exe_path: "c:\\apps\\code.exe" },
        { hwnd: 222, pid: 333, title: "微信", class_name: "WeChatMainWndForPC", is_minimized: true, exe_path: "c:\\tencent\\wechat\\wechat.exe" },
      ];
      case "nav_save_target": return navTargets[0];
      case "nav_link_task": return "nl-preview";
      case "nav_prune_logs": return 0;
      case "apply_window_material": return { material: args?.material || "glass", applied: MATERIAL === "glass", effect: MATERIAL === "glass" ? "mica" : "none", os_version: "10.0.26100" };
      case "apply_window_radius": return true;
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
  // @tauri-apps/api@2.9 的 event.js 在 unlisten 时会调用这里的 unregisterListener。
  // 缺了这一段，React 卸载组件时抛 "Cannot read properties of undefined"。
  const eventHandlers = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: (event, eventId, handler) => {
      eventHandlers.set(eventId, { event, handler });
      return eventId;
    },
    unregisterListener: (event, eventId) => {
      eventHandlers.delete(eventId);
    },
  };

  // 背景模拟桌面壁纸，验证毛玻璃透出效果（仅预览用）
  // 注意：shim 在 <head> 中执行，此时 document.body 还不存在，
  // 直接 appendChild 会抛 TypeError（走查时表现为每页一条错误）。
  if (!document.getElementById("preview-desktop-bg")) {
    const bg = document.createElement("div");
    bg.id = "preview-desktop-bg";
    bg.style.cssText =
      "position:fixed;inset:0;z-index:-1;" +
      "background:linear-gradient(135deg,#0f4c81 0%,#1a936f 45%,#f3a712 100%);";
    (document.body || document.documentElement).appendChild(bg);
  }
})();
`;

writeFileSync(join(dist, "preview-shim.js"), shim);
const preview = html.replace(
  /<script type="module"/,
  '<script src="/preview-shim.js"></script>\n    <script type="module"',
);
writeFileSync(join(dist, "preview.html"), preview);

// 统一工作台预览入口：同一份 shim 注入 dist/workspace.html，供 WorkbenchShell 走查。
const wsHtml = readFileSync(join(dist, "workspace.html"), "utf8");
const wsPreview = wsHtml.replace(
  /<script type="module"/,
  '<script src="/preview-shim.js"></script>\n    <script type="module"',
);
writeFileSync(join(dist, "workbench-preview.html"), wsPreview);

// 同时落到 .preview/：vite build 会清空 dist/，并发构建时 dist 里的 harness 会
// 被抹掉，导致走查页面退化成 404/无 IPC mock。.preview/ 不参与构建，保留一份稳定副本，
// 由 scripts/serve-preview.mjs 直接提供，dist/ 里的副本仅作兼容。
mkdirSync(join(root, ".preview"), { recursive: true });
writeFileSync(join(root, ".preview", "preview-shim.js"), shim);
writeFileSync(join(root, ".preview", "preview.html"), preview);
writeFileSync(join(root, ".preview", "workbench-preview.html"), wsPreview);
console.log("preview.html + workbench-preview.html + preview-shim.js 已生成（dist/ 与 .preview/）");
