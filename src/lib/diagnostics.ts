//! 前端诊断上报：有界队列 + 批量 IPC + 错误归属去重 + 操作生命周期。
//!
//! ## 设计约束（与 Rust `diagnostics` 模块对应）
//! - **不阻塞业务**：`logEvent` 是同步入队，绝不 `await`，绝不抛出；
//! - **有界**：队列 128 条，满了优先丢 DEBUG/INFO，WARN 以上尽量保留并计数；
//! - **不递归**：上报走**原始** `invoke`（不经 `invokeCommand`），失败只累加本地计数，
//!   不会再次触发错误上报，避免「日志失败 → 错误上报 → 日志失败」风暴；
//! - **不重复但不丢次数**：同一个 `AppError` 只归属一个主要诊断事件（`markLogged`/`isLogged`），
//!   IPC 失败在 `invokeCommand` 记录并由主要归属方标记；次级观察（`reportError` /
//!   `globalErrors`）在同一指纹 250ms 窗口内只抑制事件本身，被抑制次数会在下一次真正
//!   写入时通过 `metadata.suppressed_since_last` 带回，后端仍能得到真实发生次数；
//! - **隐私**：只上送语义化字段 + 白名单 metadata；正文/路径/凭证由 Rust 端再次过滤。

export type DiagLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
export type DiagStatus = "started" | "success" | "failed" | "cancelled" | "recovered";

export interface DiagnosticInput {
  level: DiagLevel;
  module: string;
  action: string;
  event: string;
  status?: DiagStatus;
  stage?: string;
  operation_id?: string;
  window_id?: string;
  component?: string;
  error_code?: string;
  error_category?: string;
  duration_ms?: number;
  retry_count?: number;
  message?: string;
  metadata?: Record<string, string | number | boolean>;
}

/** 队列上限：超过后丢弃低级别事件并计数。 */
const MAX_QUEUE = 128;
/** 单批条数（与后端 `MAX_BATCH` 对齐）。 */
const BATCH_SIZE = 20;
/** 批量发送间隔。 */
const FLUSH_INTERVAL_MS = 500;
/** 并发在途批次数（单飞，避免日志风暴时打爆 IPC）。 */
const MAX_INFLIGHT = 4;

/** 高频轮询命令：正常运行不逐次记录（详细模式也只记失败）。 */
const QUIET_COMMANDS = new Set([
  "diagnostics_status",
  "diagnostics_query",
  "widget_window_info",
  "notification_page",
  "agent_snapshot",
  "list_agent_events",
]);

let queue: DiagnosticInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = 0;
let droppedLocal = 0;
let sentLocal = 0;
let verboseMode = false;
/** 详细模式本地截止时间（`null` = 无期限，仅用于旧调用方兼容）。 */
let verboseDeadline: number | null = null;
let installed = false;

/** 可替换传输层（单元测试注入；生产使用 Tauri invoke）。 */
type Transport = (events: DiagnosticInput[]) => Promise<unknown>;
let transport: Transport | null = null;

export function setDiagnosticTransport(next: Transport | null): void {
  transport = next;
}

async function defaultTransport(events: DiagnosticInput[]): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("diagnostics_record", { events });
}

/** 当前窗口标识：按入口 HTML 推断，避免每个入口手工注册。 */
export function currentWindowId(): string {
  if (typeof location === "undefined") return "main";
  const path = location.pathname.toLowerCase();
  if (path.includes("context-menu")) return "context-menu";
  if (path.includes("notification")) return "notification";
  if (path.includes("capture")) return "capture";
  if (path.includes("widget")) return "widget";
  return "main";
}

/** 详细诊断模式（由设置页通过 `diagnostics_status` / `diagnostics_set_mode` 同步）。 */
export function setClientVerboseMode(enabled: boolean, verboseRemainingMs?: number): void {
  verboseMode = enabled;
  // 后端在 `diagnostics_set_mode` 响应里给出剩余毫秒；拿到后本地到点自动失效，
  // 不再依赖设置页轮询。旧调用方只传布尔值时保持“无期限”，行为向后兼容。
  verboseDeadline =
    enabled && typeof verboseRemainingMs === "number" && Number.isFinite(verboseRemainingMs)
      ? Date.now() + Math.max(0, verboseRemainingMs)
      : null;
  // 设置页在 `diagnostics_set_mode` 成功后调用本函数（只传布尔值）。此时再向
  // 后端同步一次，补齐“前端不知道的剩余时间”，避免设置页关闭后仍长期发 DEBUG。
  // 非 Tauri 环境（浏览器预览、单测）不发起无效 IPC。
  if (enabled && verboseRemainingMs === undefined && isTauriRuntime()) {
    void syncDiagnosticMode();
  }
}

export function isClientVerboseMode(): boolean {
  if (!verboseMode) return false;
  if (verboseDeadline !== null && Date.now() >= verboseDeadline) {
    // 本地过期：无需 IPC/轮询，立即回到正常模式。
    verboseMode = false;
    verboseDeadline = null;
    return false;
  }
  return true;
}

/** 详细模式状态（与后端 `DiagnosticsStatus` 的结构子集对齐）。 */
export interface DiagnosticModeStatus {
  mode: "normal" | "verbose";
  verboseRemainingMs?: number;
}

/** 应用后端返回的模式与剩余时长（设置页可直接调用；同步失败不影响本地状态）。 */
export function applyModeFromStatus(status: DiagnosticModeStatus): void {
  if (status.mode !== "verbose") {
    verboseMode = false;
    verboseDeadline = null;
    return;
  }
  verboseMode = true;
  verboseDeadline =
    typeof status.verboseRemainingMs === "number" && Number.isFinite(status.verboseRemainingMs)
      ? Date.now() + Math.max(0, status.verboseRemainingMs)
      : null;
}

/** 从后端同步一次详细模式；失败静默（日志系统绝不能影响 UI）。 */
export async function syncDiagnosticMode(): Promise<void> {
  try {
    const { diagnosticsStatus } = await import("./bridge");
    applyModeFromStatus(await diagnosticsStatus());
  } catch {
    // 保留本地旧状态；后端仍按自身模式执行，设置页下次打开会再次同步。
  }
}

function isTauriRuntime(): boolean {
  try {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

/** 本地队列统计（设置页展示；后端计数器不包含这些本地丢弃）。 */
export interface ClientDiagnosticsStats {
  queued: number;
  sent: number;
  dropped: number;
  verbose: boolean;
}

export function clientDiagnosticsStats(): ClientDiagnosticsStats {
  return { queued: queue.length, sent: sentLocal, dropped: droppedLocal, verbose: isClientVerboseMode() };
}

/** 已由某个诊断事件归属的错误（避免多层处理器重复记录同一个失败）。 */
const loggedErrors = new WeakSet<object>();

/** 标记错误已被记录（`invokeCommand` 调用）。 */
export function markLogged(error: object): void {
  try {
    loggedErrors.add(error);
  } catch {
    // 非对象/不可扩展：忽略，退化为可能出现一次重复记录。
  }
}

/** 该错误是否已经有归属事件。 */
export function isLogged(error: object): boolean {
  try {
    return loggedErrors.has(error);
  } catch {
    return false;
  }
}

// ── 跨层重复上报抑制 ────────────────────────────────────────
//
// 同一次失败可能被多层观察：`invokeCommand`（IPC 失败）→ `reportError`（用户提示）
// → `globalErrors`（未处理 Promise）。实例级 `markLogged` 覆盖大部分链路，但错误
// 被上层重新包装/跨层转换后会变成新实例，只靠 WeakSet 会漏。
// 这里再加一层**有界指纹窗口**：同一 `错误码 + 文案` 在 250ms 内只抑制“次级观察”。
// 主要归属（IPC 失败）始终记录；被抑制的次数不会丢，会随下一次真正写入的事件
// 以 `metadata.suppressed_since_last` 带回。
const REPORT_DEDUPE_MS = 250;
const MAX_REPORT_FINGERPRINTS = 64;
/** 指纹状态保留时长：超过后视为一次新的失败，不再累计旧的抑制次数。 */
const REPORT_STATE_TTL_MS = 60_000;

interface ReportFingerprintState {
  /** 最后一次真正写入诊断事件的时间。 */
  lastEmittedAt: number;
  /** 自上次写入以来被抑制的发生次数。 */
  suppressed: number;
}

const recentReports = new Map<string, ReportFingerprintState>();

function reportKey(code: string | undefined, message: string | undefined): string {
  return `${code ?? "-"}|${(message ?? "").slice(0, 120)}`;
}

function pruneReports(now: number): void {
  for (const [key, entry] of recentReports) {
    if (now - entry.lastEmittedAt > REPORT_STATE_TTL_MS) recentReports.delete(key);
  }
}

/** 插入后收敛到上限：新插入的指纹时间最新，不会被淘汰，抑制计数不会误删。 */
function boundReports(): void {
  if (recentReports.size <= MAX_REPORT_FINGERPRINTS) return;
  const overflow = recentReports.size - MAX_REPORT_FINGERPRINTS;
  const oldest = [...recentReports.entries()]
    .sort((a, b) => a[1].lastEmittedAt - b[1].lastEmittedAt)
    .slice(0, overflow);
  for (const [key] of oldest) recentReports.delete(key);
}

export interface ReportReservation {
  /** true = 本次应真正写入一条诊断事件。 */
  emit: boolean;
  /** 上一次实际写入以来被抑制的同类次数（仅 `emit=true` 时有意义）。 */
  suppressed: number;
}

/**
 * 为一次“次级观察”预占上报位置。
 *
 * - 同一指纹在 `REPORT_DEDUPE_MS` 内已被实际写入过 → `emit=false`，只累加抑制计数；
 * - 否则允许写入，并把此前被抑制的次数一起返回（>0 时调用方写入
 *   `metadata.suppressed_since_last`，后端据此累计真实发生次数）。
 */
export function reserveReport(
  code: string | undefined,
  message: string | undefined,
): ReportReservation {
  try {
    const now = Date.now();
    pruneReports(now);
    const key = reportKey(code, message);
    const entry = recentReports.get(key);
    if (entry && now - entry.lastEmittedAt <= REPORT_DEDUPE_MS) {
      entry.suppressed += 1;
      return { emit: false, suppressed: 0 };
    }
    const suppressed = entry?.suppressed ?? 0;
    recentReports.set(key, { lastEmittedAt: now, suppressed: 0 });
    boundReports();
    return { emit: true, suppressed };
  } catch {
    // 去重状态异常时宁可多写一条，也不能吞掉真实失败。
    return { emit: true, suppressed: 0 };
  }
}

/**
 * 主要归属（IPC 失败）：无论窗口内是否重复都必须记录，并重置去重窗口。
 * 返回此前被次级观察抑制的次数，供本次事件携带。
 */
function recordPrimaryReport(code: string | undefined, message: string | undefined): number {
  try {
    const now = Date.now();
    pruneReports(now);
    const key = reportKey(code, message);
    const suppressed = recentReports.get(key)?.suppressed ?? 0;
    recentReports.set(key, { lastEmittedAt: now, suppressed: 0 });
    boundReports();
    return suppressed;
  } catch {
    return 0;
  }
}

function schedule(): void {
  if (timer !== null || inflight >= MAX_INFLIGHT) return;
  timer = setTimeout(() => {
    timer = null;
    void flushDiagnostics();
  }, FLUSH_INTERVAL_MS);
  // Node 测试环境下别让定时器把进程吊住。
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

/** 立即发送一批（最多 BATCH_SIZE 条）。失败静默计数，绝不上抛。 */
export async function flushDiagnostics(): Promise<void> {
  if (inflight >= MAX_INFLIGHT) return;
  if (queue.length === 0) return;
  const batch = queue.splice(0, BATCH_SIZE);
  const send = transport ?? defaultTransport;
  inflight += 1;
  try {
    await send(batch);
    sentLocal += batch.length;
  } catch {
    // 日志系统自身失败：只计数，不影响业务，也不触发二次错误上报。
    droppedLocal += batch.length;
  } finally {
    inflight -= 1;
    if (queue.length > 0) schedule();
  }
}

/** 同步入队；任何情况下都不抛出。 */
export function logEvent(input: DiagnosticInput): void {
  try {
    const level = input.level;
    if ((level === "DEBUG" || level === "TRACE") && !isClientVerboseMode()) {
      // 后端在正常模式也会丢弃；这里提前省掉 IPC。
      return;
    }
    if (!input.module || !input.action) return;
    const event: DiagnosticInput = {
      ...input,
      event: input.event || input.status || "log",
      window_id: input.window_id ?? currentWindowId(),
    };
    if (queue.length >= MAX_QUEUE) {
      // 优先丢最早的 DEBUG/INFO；没有则丢本条（可能是重复的高频 WARN）。
      const index = queue.findIndex((item) => item.level === "DEBUG" || item.level === "INFO");
      if (index >= 0 && level !== "CRITICAL") {
        queue.splice(index, 1);
        droppedLocal += 1;
      } else if (level === "WARN" || level === "ERROR" || level === "CRITICAL") {
        // 保留高优先级：丢掉最旧的一条非 CRITICAL。
        const fallback = queue.findIndex((item) => item.level !== "CRITICAL");
        if (fallback >= 0) {
          queue.splice(fallback, 1);
          droppedLocal += 1;
        } else {
          droppedLocal += 1;
          return;
        }
      } else {
        droppedLocal += 1;
        return;
      }
    }
    queue.push(event);
    schedule();
  } catch {
    // 诊断上报自身绝不能影响业务。
  }
}

// ── 命令 → 模块映射（IPC 失败自动归类，不需要每个调用点埋点）────────────

const EXACT_MODULES: Record<string, string> = {
  get_settings: "settings",
  update_settings: "settings",
  save_window_rect: "settings",
  get_window_rect: "settings",
  global_search: "search",
  performance_diagnostics: "settings",
  resource_snapshot: "settings",
  resource_cleanup_preview: "settings",
  resource_cleanup_execute: "settings",
  backup_now: "backup",
  list_backups: "backup",
  restore_backup: "backup",
  export_data: "backup",
  import_data: "backup",
  quit_app: "system",
  set_autostart: "settings",
};

/** 由命令名推导稳定模块标识（未知命令归入 `ipc`）。 */
export function moduleForCommand(command: string): string {
  const exact = EXACT_MODULES[command];
  if (exact) return exact;
  if (command.startsWith("clipboard_")) return "clipboard";
  if (command.startsWith("ocr_") || command.includes("_ocr")) return "ocr";
  if (command.startsWith("shelf_") || command.startsWith("inbox_")) return "file";
  if (command.startsWith("workflow_")) return "workflow";
  if (command.startsWith("tts_") || command.startsWith("audio_") || command.startsWith("voice_")) {
    return "voice";
  }
  if (command.startsWith("backup_") || command.startsWith("restore_") || command.includes("backup")) {
    return "backup";
  }
  if (command.includes("widget")) return "widget";
  if (command.startsWith("nav_") || command.includes("navigation")) return "navigation";
  if (command.startsWith("agent") || command.startsWith("list_agent") || command.includes("_agent")) {
    return "agent";
  }
  if (
    command.startsWith("task") ||
    command.startsWith("list_tasks") ||
    command.startsWith("create_task") ||
    command.startsWith("fetch_task") ||
    command.startsWith("snooze") ||
    command.includes("_task")
  ) {
    return "task";
  }
  if (command.startsWith("note")) return "notes";
  if (command.startsWith("focus")) return "focus";
  if (command.startsWith("planning_") || command.startsWith("project")) return "planning";
  if (command.startsWith("mcp_")) return "mcp";
  if (command.startsWith("search")) return "search";
  if (command.startsWith("action")) return "actions";
  if (command.startsWith("workspace")) return "workspace";
  if (command.startsWith("scenario")) return "scenario";
  if (command.startsWith("capture")) return "capture";
  if (command.startsWith("context_menu")) return "context-menu";
  if (command.startsWith("notification")) return "agent";
  return "ipc";
}

/** 高频轮询命令判定（成功不记 DEBUG）。 */
export function isQuietCommand(command: string): boolean {
  return QUIET_COMMANDS.has(command);
}

// ── 操作生命周期 ────────────────────────────────────────────

export interface OperationOptions {
  window?: string;
  component?: string;
  /** 不记录 `started` 事件（用于极高频、只关心失败的路径）。 */
  quietStart?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface OperationExtras {
  message?: string;
  metadata?: Record<string, string | number | boolean>;
  retryCount?: number;
}

export interface DiagnosticOperation {
  readonly id: string;
  readonly elapsedMs: number;
  /** 记录阶段推进（失败时据此定位卡在哪一步）。 */
  stage(name: string, metadata?: Record<string, string | number | boolean>): void;
  success(extras?: OperationExtras): void;
  fail(error: unknown, extras?: OperationExtras): void;
  cancel(message?: string): void;
  recovered(message?: string): void;
}

/** 错误对象的最小结构（避免与 `errors.ts` 相互依赖）。 */
interface ErrorShape {
  code?: unknown;
  category?: unknown;
  message?: unknown;
}

function operationId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // 回退到时间戳 + 随机数
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 开始一次可追踪操作：`started` → `stage` × N → `success|failed|cancelled|recovered`。
 *
 * `duration_ms` 用 `performance.now()`（单调时钟）计算，不受系统时间调整影响。
 */
export function startOperation(
  module: string,
  action: string,
  options: OperationOptions = {},
): DiagnosticOperation {
  const id = operationId();
  const windowId = options.window ?? currentWindowId();
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const base: DiagnosticInput = {
    level: "INFO",
    module,
    action,
    event: "started",
    status: "started",
    operation_id: id,
    window_id: windowId,
    component: options.component,
    metadata: options.metadata,
  };
  if (!options.quietStart) logEvent(base);

  let finished = false;
  /** 最后一个真实阶段（普通模式下 stage 事件会被丢弃，失败终态仍要带上它）。 */
  let lastStage: string | null = null;

  const elapsed = () => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    return Math.max(0, Math.round(now - startedAt));
  };

  const finish = (
    event: DiagnosticInput,
    status: DiagStatus,
    level: DiagLevel,
    extras?: OperationExtras,
  ) => {
    if (finished) return;
    finished = true;
    logEvent({
      ...event,
      // 终态事件名必须与 status 一致；base 里的 event 是 started，不能沿用。
      event: status,
      // 失败必须回答“卡在哪一步”：普通模式下 stage 事件被过滤，这里补到终态上。
      ...(status === "failed" && lastStage !== null ? { stage: lastStage } : {}),
      level,
      status,
      operation_id: id,
      window_id: windowId,
      component: options.component,
      duration_ms: elapsed(),
      retry_count: extras?.retryCount,
      message: extras?.message,
      metadata: { ...options.metadata, ...extras?.metadata },
    });
  };

  return {
    id,
    get elapsedMs() {
      return elapsed();
    },
    stage(name, metadata) {
      // 同一阶段的连续重复不产生重复事件；终态之后不再接受阶段推进。
      if (finished || name === lastStage) return;
      lastStage = name;
      logEvent({
        ...base,
        level: "DEBUG",
        event: "stage",
        status: undefined,
        stage: name,
        metadata: { ...options.metadata, ...metadata },
      });
    },
    success(extras) {
      finish({ ...base, level: "INFO", module, action }, "success", "INFO", extras);
    },
    fail(raw, extras) {
      const shape = (typeof raw === "object" && raw !== null ? raw : {}) as ErrorShape;
      const code = typeof shape.code === "string" ? shape.code : undefined;
      const category = typeof shape.category === "string" ? shape.category : undefined;
      const message =
        extras?.message ??
        (typeof shape.message === "string" ? shape.message : "操作失败");
      const level: DiagLevel =
        code === "DATA_INTEGRITY_ERROR"
          ? "CRITICAL"
          : category === "validation" || code === "VALIDATION_ERROR"
            ? "WARN"
            : "ERROR";
      finish(
        { ...base, level, module, action, error_code: code, error_category: category },
        "failed",
        level,
        { ...extras, message },
      );
    },
    cancel(message) {
      finish({ ...base, level: "INFO", module, action }, "cancelled", "INFO", { message });
    },
    recovered(message) {
      finish({ ...base, level: "INFO", module, action }, "recovered", "INFO", { message });
    },
  };
}

// ── IPC 失败归属 ────────────────────────────────────────────

/**
 * 记录一次 IPC 调用失败（由 `invokeCommand` 调用）。
 *
 * 返回该事件是否真的写入队列（被过滤时不写）；调用方随后 `markLogged(err)`。
 */
export function logIpcFailure(
  command: string,
  error: {
    code?: string;
    category?: string;
    severity?: "warning" | "error" | "critical";
    message?: string;
  },
  durationMs?: number,
  operation?: string,
): boolean {
  try {
    const module = moduleForCommand(command);
    const level: DiagLevel =
      error.severity === "critical" || error.code === "DATA_INTEGRITY_ERROR"
        ? "CRITICAL"
        : error.severity === "warning"
          ? "WARN"
          : "ERROR";
    const metadata: Record<string, string | number | boolean> = {
      command,
      stage: "ipc",
    };
    // 用户视角的操作名（如「创建任务」）便于在日志里直接定位入口。
    if (operation) metadata.operation = operation;
    // 主要归属（IPC 失败）永远记录：它是真实发生次数。顺带把此前被次级观察
    // 抑制的次数带回，避免 250ms 窗口吞掉真实重复。
    const suppressed = recordPrimaryReport(error.code, error.message);
    if (suppressed > 0) metadata.suppressed_since_last = suppressed;
    logEvent({
      level,
      module,
      action: command,
      event: "failed",
      status: "failed",
      error_code: error.code,
      error_category: error.category,
      duration_ms: durationMs,
      message: error.message,
      metadata,
    });
    return true;
  } catch {
    return false;
  }
}

/** 记录一次 IPC 成功（仅详细模式，且跳过高频轮询命令）。 */
export function logIpcSuccess(command: string, durationMs?: number): void {
  try {
    if (!isClientVerboseMode() || isQuietCommand(command)) return;
    logEvent({
      level: "DEBUG",
      module: moduleForCommand(command),
      action: command,
      event: "ipc_ok",
      status: "success",
      duration_ms: durationMs,
      metadata: { command, stage: "ipc" },
    });
  } catch {
    // ignore
  }
}

/** 在窗口关闭前尽量刷出队列（best-effort；进程被强杀时最多丢 500ms）。 */
export function installDiagnosticsFlushHooks(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // 安装即与后端同步一次详细模式：前端启动时若后端已处于 verbose（例如上一个
  // 窗口开启后未到期），不会漏掉 DEBUG；失败静默，不影响 UI。
  void syncDiagnosticMode();
  window.addEventListener("pagehide", () => {
    void flushDiagnostics();
  });
  window.addEventListener("beforeunload", () => {
    void flushDiagnostics();
  });
}
