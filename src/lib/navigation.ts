//! 统一导航桥接层：与 Rust navigation 模块的类型化 invoke 封装。
//!
//! 语义对齐后端：前端只传目标 ID 与行为偏好，不透传可执行路径/参数；
//! 所有结果如实携带 verification_level / fallback_used，UI 不得夸大成功。

import { invoke } from "@tauri-apps/api/core";

export type NavigationTargetType =
  | "application"
  | "url"
  | "file"
  | "directory"
  | "agent_session";

export interface NavigationResult {
  success: boolean;
  requested_action: string;
  actual_action: string | null;
  fallback_used: boolean;
  target_id: string;
  reason?: string;
  verification_level: string;
}

export interface NavTarget {
  id: string;
  display_name: string;
  target_type: NavigationTargetType;
  app_key: string;
  exe_path: string;
  launch_args: string;
  working_dir: string;
  app_user_model_id: string;
  url: string;
  path: string;
  agent_source_id: string;
  agent_session_id: string;
  window_title_hint: string;
  icon: string;
  category: string;
  favorite: boolean;
  hidden: boolean;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
}

export interface TargetInput {
  target_type: NavigationTargetType;
  display_name: string;
  exe_path?: string;
  launch_args?: string;
  working_dir?: string;
  app_user_model_id?: string;
  url?: string;
  path?: string;
  agent_source_id?: string;
  agent_session_id?: string;
  window_title_hint?: string;
  icon?: string;
  category?: string;
  overwrite_name?: boolean;
}

export interface TargetPatch {
  display_name?: string;
  icon?: string;
  favorite?: boolean;
  hidden?: boolean;
  window_title_hint?: string;
  category?: string;
}

/** 任务关联行（含目标明细 + 实时运行状态）。 */
export interface TaskNavLink {
  id: string;
  task_id: string;
  target_id: string;
  display_order: number;
  is_default: boolean;
  launch_behavior: string;
  created_at: string;
  target: NavTarget;
  /** not_running | process_only | has_window | always | unavailable | agent */
  running_state: string;
}

export interface DiscoveredApp {
  app_key: string;
  display_name: string;
  category: string;
  exe_path: string;
  launch_args: string;
  working_dir: string;
  app_user_model_id: string;
  window_title_hint: string;
  source: string;
}

export interface AppScanResult {
  apps: DiscoveredApp[];
  scanned_at: string;
  duration_ms: number;
  counts: Record<string, number>;
}

export interface WindowInfo {
  hwnd: number;
  pid: number;
  title: string;
  class_name: string;
  is_minimized: boolean;
  exe_path: string | null;
}

export interface NavLogRow {
  id: string;
  target_id: string;
  target_name: string;
  requested_action: string;
  actual_action: string | null;
  success: boolean;
  fallback_used: boolean;
  reason: string;
  verification_level: string;
  created_at: string;
}

export interface AgentNavCapabilities {
  source_id: string;
  can_launch: CapabilityStatus;
  can_focus_window: CapabilityStatus;
  can_open_workspace: CapabilityStatus;
  can_resume_session: CapabilityStatus;
}

export interface CapabilityStatus {
  supported: boolean;
  evidence: string;
  note: string;
}

export interface NavigateOptions {
  action?: string;
  fallback?: boolean;
  window_hwnd?: number;
}

// ── 扫描与目标 ──
export const navScanApps = (force = false) =>
  invoke<AppScanResult>("nav_scan_apps", { force });
export const navListWindows = () => invoke<WindowInfo[]>("nav_list_windows");
export const navListTargets = (includeHidden = false) =>
  invoke<NavTarget[]>("nav_list_targets", { includeHidden });
export const navSaveTarget = (input: TargetInput) =>
  invoke<NavTarget>("nav_save_target", { input });
export const navUpdateTarget = (id: string, patch: TargetPatch) =>
  invoke<void>("nav_update_target", { id, patch });
export const navDeleteTarget = (id: string) =>
  invoke<void>("nav_delete_target", { id });
/** 把真实存在的 Agent 会话登记为可信目标（后端核验会话身份，前端不自造路径）。 */
export const navSaveAgentSessionTarget = (
  sourceId: string,
  sessionId: string,
  displayName?: string,
  workingDir?: string,
) =>
  invoke<NavTarget>("nav_save_agent_session_target", {
    sourceId,
    sessionId,
    displayName: displayName ?? null,
    workingDir: workingDir ?? null,
  });
/** 记住的窗口身份（类名+标题，不含 HWND）；无记忆为 null。 */
export const navWindowMemory = (targetId: string) =>
  invoke<{ class_name: string; title: string } | null>("nav_window_memory", { targetId });
export const navForgetWindow = (targetId: string) =>
  invoke<void>("nav_forget_window", { targetId });
export const navRecentLogs = (limit = 50) =>
  invoke<NavLogRow[]>("nav_recent_logs", { limit });
export const navPruneLogs = (keep = 200) =>
  invoke<number>("nav_prune_logs", { keep });

// ── 任务关联 ──
export const navLinkTask = (
  taskId: string,
  targetId: string,
  isDefault = false,
  launchBehavior = "default",
) =>
  invoke<string>("nav_link_task", {
    taskId,
    targetId,
    isDefault,
    launchBehavior,
  });
export const navUnlinkTask = (linkId: string) =>
  invoke<void>("nav_unlink_task", { linkId });
export const navUpdateTaskLink = (
  linkId: string,
  patch: { displayOrder?: number; isDefault?: boolean; launchBehavior?: string },
) =>
  invoke<void>("nav_update_task_link", {
    linkId,
    displayOrder: patch.displayOrder,
    isDefault: patch.isDefault,
    launchBehavior: patch.launchBehavior,
  });
export const navTaskTargets = (taskId: string) =>
  invoke<TaskNavLink[]>("nav_task_targets", { taskId });
export const navAllTaskLinks = () => invoke<TaskNavLink[]>("nav_all_task_links");

// ── 跳转 ──
export const navNavigate = (targetId: string, options?: NavigateOptions) =>
  invoke<NavigationResult>("nav_navigate", { targetId, options: options ?? null });

// ── Agent 导航 ──
export const navAgentCapabilities = (sourceId: string) =>
  invoke<AgentNavCapabilities>("nav_agent_capabilities", { sourceId });
export const navAgentAction = (sourceId: string, action: "open_app" | "focus_window") =>
  invoke<NavigationResult>("nav_agent_action", { sourceId, action });
export const navAgentOpenWorkspace = (sourceId: string, dir: string) =>
  invoke<NavigationResult>("nav_agent_open_workspace", { sourceId, dir });

// ── 展示辅助（纯函数，可测试）──

export const TARGET_TYPE_LABELS: Record<NavigationTargetType, string> = {
  application: "应用",
  url: "网址",
  file: "文件",
  directory: "目录",
  agent_session: "Agent 会话",
};

export const CATEGORY_LABELS: Record<string, string> = {
  browser: "浏览器",
  im: "通讯",
  music: "音乐",
  dev: "开发",
  file: "文件管理",
  uwp: "应用商店",
  other: "其他",
};

/** 目标/应用的首字母头像色（无真实图标时的稳定视觉身份）。 */
export function avatarHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) % 360;
  }
  return h;
}

/** 运行状态 → 徽标语义（不可用/运行中/未运行）。 */
export function stateBadge(state: string): { label: string; tone: "ok" | "idle" | "bad" } {
  switch (state) {
    case "has_window":
      return { label: "窗口已打开", tone: "ok" };
    case "process_only":
      return { label: "后台运行", tone: "idle" };
    case "always":
      return { label: "可用", tone: "ok" };
    case "agent":
      return { label: "Agent", tone: "idle" };
    case "unavailable":
      return { label: "已失效", tone: "bad" };
    default:
      return { label: "未运行", tone: "idle" };
  }
}

/** 验证级别 → 用户可读说明（如实反馈，不夸大）。 */
export function verificationLabel(level: string): string {
  switch (level) {
    case "window-confirmed":
      return "已确认窗口";
    case "window-visible":
      // 窗口出现了，但没能置前：不等于"已确认"，也不该说"失败"
      return "窗口已出现（未置前）";
    case "process-spawned":
      return "进程已启动";
    case "launch-requested":
      return "已请求启动";
    case "delegated":
      return "已交系统处理";
    case "requested-unverified":
      return "已请求，未核实";
    default:
      return "未执行";
  }
}

/** 结果 → Toast 文案（含降级与验证级别提示）。 */
export function resultMessage(r: NavigationResult, name: string): string {
  if (!r.success) {
    return `「${name}」跳转失败：${r.reason ?? "未知原因"}`;
  }
  const v = verificationLabel(r.verification_level);
  if (r.fallback_used) {
    return `「${name}」${v}${r.reason ? `（${r.reason}）` : ""}`;
  }
  return `「${name}」${v}`;
}

/** 目标菜单条目（索引必须与 DOM 顺序一致，键盘导航才不错位）。 */
export interface TargetMenuItem {
  key: string;
  kind: "workspace" | "target";
  link?: TaskNavLink;
}

/**
 * 构建目标菜单条目列表。
 *
 * 工作区入口（若有）永远排在第 0 位，普通目标依次后移。
 * 旧实现的键盘索引只指向 links，导致工作区入口既拿不到焦点也无法用 Enter 触发。
 */
export function buildTargetMenuItems(
  links: TaskNavLink[],
  hasWorkspace: boolean,
): TargetMenuItem[] {
  const items: TargetMenuItem[] = [];
  if (hasWorkspace) items.push({ key: "__workspace__", kind: "workspace" });
  for (const l of links) items.push({ key: l.id, kind: "target", link: l });
  return items;
}

/** 方向键移动（循环），越界自动回绕；空列表返回 0。 */
export function moveMenuIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((current + delta) % length + length) % length;
}
