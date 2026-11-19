//! 启动协议 TS 镜像（契约：docs/boot/README.md §3–§4）。
//!
//! 与 `public/boot/boot-watchdog.js`（经典脚本，无构建步骤）互为镜像：
//! watchdog 安装 `window.__TASK_DOCK_BOOT__` 并维护 `#boot-splash` 状态机
//! （boot → slow → timeout / error → ready 移除）；本模块是 React 侧的
//! 类型化入口。修改状态机、阈值或信号语义必须先改协议文档并同步对方。
//!
//! 调用方与时机（协议 §3，2026-11-19 启动诊断升级后细化）：
//! - `bootStage("bootstrap-start")`：极轻量入口 bootstrap.ts 开始执行（由
//!   bootstrap 直接访问 window API 记录，不经本模块）；
//! - `bootStage("main-import-start"/"main-import-resolved"/"main-import-failed")`：
//!   main.tsx 动态导入生命周期（同样由 bootstrap 记录）；
//! - `bootStage("modules")`：main.tsx 模块主体开始执行（注意：不再是「整个模块图
//!   开始加载」——加载阶段已由上面的 import 阶段覆盖）；
//! - `bootStage("init:<fn>:start"/"init:<fn>:end")`：同步初始化函数开始/结束，
//!   watchdog 自动相减得到耗时写入 `state.timings`；
//! - `bootStage("react-root")`：createRoot() 调用发起；
//! - `bootStage("mounted")`：createRoot().render() 同步调用已发起；
//! - `bootStage("settings")`：设置读取落定（成功或失败）；
//! - `bootStage("ready")`：bootReady() 时由 watchdog 自动记录；
//! - `bootReady()`：设置落定后（成功 → 露出工作区；失败 → 露出 ShellBootState
//!   重试 UI）以及 ErrorBoundary 接管渲染时 —— 都算「React 接管」；
//! - `bootFail(info)`：仅用于 React 无法渲染的致命失败（main.tsx 同步抛错、
//!   bootstrap 动态导入失败）。
//!
//! 时间基准（硬约束）：所有时间点与耗时都由 watchdog 用同一条
//! `performance.now() - startedAt` 时间轴生成；TS 侧永不自行产生时间戳，
//! 更不混用 `Date.now()` 与 `performance.now()` 后相减。

/** 慢启动阈值（毫秒）。必须与 watchdog 的 `SLOW_MS` 一致（契约测试锁定）。 */
export const BOOT_SLOW_MS = 4000;
/** 启动超时阈值（毫秒）。必须与 watchdog 的 `TIMEOUT_MS` 一致（契约测试锁定）。 */
export const BOOT_TIMEOUT_MS = 15000;

/**
 * 已定义的阶段名（协议 §3）。watchdog 对未知名只记时间点，这里收窄便于调用方。
 * `init:<fn>:start|end` 由 watchdog 配对成耗时；`bootstrap-*` / `main-import-*`
 * 由 bootstrap.ts 直接调用 window API 记录（不经本模块）。
 */
export type BootStageName =
  | "bootstrap-start"
  | "main-import-start"
  | "main-import-resolved"
  | "main-import-failed"
  | "modules"
  | "react-root"
  | "mounted"
  | "settings"
  | "ready"
  | `init:${string}:${"start" | "end"}`;

/** 动态导入状态（watchdog 侧状态机；bootstrap 显式推进）。 */
export type BootImportState =
  | "not-requested"
  | "requested"
  | "pending"
  | "resolved"
  | "rejected";

/** 致命失败信息：name/stack 可选，watchdog 负责截断与过滤敏感路径。 */
export interface BootFailInfo {
  stage?: string;
  message?: string;
  name?: string;
  stack?: string;
}

/** `window.__TASK_DOCK_BOOT__` 的最小结构（完整行为见 boot-watchdog.js）。 */
interface BootWatchdogApi {
  startedAt: number;
  stages: Record<string, number>;
  /** 同步初始化函数耗时（watchdog 用单一时间轴相减得到）。旧版 watchdog 可能缺失。 */
  timings?: Record<string, number>;
  /** 动态导入状态。旧版 watchdog 可能缺失。 */
  mainImport?: string;
  /** 资源/请求采样。旧版 watchdog 可能缺失。 */
  resources?: unknown[];
  csp?: unknown[];
  state: string;
  errors: unknown[];
  stage(name: string): void;
  /** 记录一段同步耗时（毫秒）。旧版 watchdog 可能缺失。 */
  timing?(name: string, ms: number): void;
  importState?(next: BootImportState): void;
  ready(): void;
  fail(info: BootFailInfo): void;
  copyDiagnostics(): Promise<boolean>;
}

/**
 * 读取 watchdog API。任何异常（含 `window` 未定义的 node 环境）都返回 null，
 * 调用方按 no-op 处理。
 */
function getBootApi(): BootWatchdogApi | null {
  try {
    if (typeof window === "undefined") return null;
    const api = (window as unknown as Record<string, unknown>).__TASK_DOCK_BOOT__;
    if (!api || typeof api !== "object") return null;
    return api as BootWatchdogApi;
  } catch {
    return null;
  }
}

/**
 * 阶段信号：记录模块/挂载/设置落定的时间点（watchdog 内存，不写诊断）。
 * 无 watchdog API 时安全 no-op。
 */
export function bootStage(name: BootStageName): void {
  try {
    getBootApi()?.stage(name);
  } catch {
    // 启动信号绝不能影响业务初始化。
  }
}

/**
 * 同步初始化函数耗时：由调用方在同一条 `performance.now()` 时间轴上测出 start/end
 * 差值后写入 watchdog 的 `timings`（协议 §3）。无 API / 旧版 watchdog 时安全 no-op。
 * 注意：耗时数字是「两个 performance.now() 之差」，不掺入 Date.now()。
 */
export function bootTiming(name: string, ms: number): void {
  try {
    getBootApi()?.timing?.(name, ms);
  } catch {
    // 耗时信号绝不能影响业务初始化。
  }
}

/**
 * 就绪信号：React 已接管渲染（设置落定或 ErrorBoundary 接管）。
 *
 * - watchdog 在场：幂等地淡出并移除占位、清空计时器、按需写终态诊断；
 * - watchdog 缺失（404 / jsdom）：直接移除 `#boot-splash`（双保险，协议 §4），
 *   防止占位永久遮挡工作区。直接移除而非淡出：此时没有看门狗在管理过渡，
 *   确定性移除优先于动画。
 */
export function bootReady(): void {
  try {
    const api = getBootApi();
    if (api) {
      api.ready();
      return;
    }
    if (typeof document !== "undefined") {
      document.getElementById("boot-splash")?.remove();
    }
  } catch {
    // 占位移除失败不能影响业务渲染。
  }
}

/**
 * 致命失败信号：仅用于 React 完全无法渲染的场景（如 main.tsx 同步抛错、
 * bootstrap 动态导入失败）。watchdog 进入 error 态并写一次 `UI_BOOT_FATAL`
 * （ERROR）。ErrorBoundary 捕获渲染异常说明 React 仍活着，应调用 `bootReady()`
 * 而不是本函数（协议 §3）。
 */
export function bootFail(info: BootFailInfo): void {
  try {
    getBootApi()?.fail(info);
  } catch {
    // 失败信号自身绝不能再抛错。
  }
}
