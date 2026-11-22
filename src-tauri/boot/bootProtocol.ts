//! 启动协议 TS 镜像（契约：tmp/acceptance/startup-experience-v1/BOOT_PROTOCOL.md §3–§4）。
//!
//! 与 `public/boot/boot-watchdog.js`（经典脚本，无构建步骤）互为镜像：
//! watchdog 安装 `window.__TASK_DOCK_BOOT__` 并维护 `#boot-splash` 状态机
//! （boot → slow → timeout / error → ready 移除）；本模块是 React 侧的
//! 类型化入口。修改状态机、阈值或信号语义必须先改协议文档并同步对方。
//!
//! 调用方与时机（协议 §3）：
//! - `bootStage("modules")`：main.tsx 模块开始执行；
//! - `bootStage("mounted")`：`createRoot().render()` 同步调用已发起；
//! - `bootStage("settings")`：设置读取落定（成功或失败）；
//! - `bootReady()`：设置落定后（成功 → 露出工作区；失败 → 露出 ShellBootState
//!   重试 UI）以及 ErrorBoundary 接管渲染时 —— 都算「React 接管」；
//! - `bootFail(info)`：仅用于 React 无法渲染的致命失败（main.tsx 同步抛错）。
//!
//! 硬约束：
//! - 全部 no-op 安全：watchdog API 缺失（watchdog 404、jsdom、非主窗入口）时
//!   不抛错、不触碰 DOM（`bootReady` 例外，见下）；
//! - `bootReady()` 双保险：API 缺失时直接移除 `#boot-splash`，防止占位永久
//!   遮挡（协议 §4；另一层保险是 index.html 内联的「死人在场」检查，B 所有）；
//! - 幂等性由 watchdog 内部保证，本模块只做安全透传，不缓存去重状态。

/** 慢启动阈值（毫秒）。必须与 watchdog 的 `SLOW_MS` 一致（契约测试锁定）。 */
export const BOOT_SLOW_MS = 4000;
/** 启动超时阈值（毫秒）。必须与 watchdog 的 `TIMEOUT_MS` 一致（契约测试锁定）。 */
export const BOOT_TIMEOUT_MS = 15000;

/** 已定义的阶段名（协议 §3）。watchdog 对未知名忽略，这里收窄类型便于调用方。 */
export type BootStageName = "modules" | "mounted" | "settings";

/** `window.__TASK_DOCK_BOOT__` 的最小结构（完整行为见 boot-watchdog.js）。 */
interface BootWatchdogApi {
  startedAt: number;
  stages: Record<string, number>;
  state: string;
  errors: unknown[];
  stage(name: string): void;
  ready(): void;
  fail(info: { stage?: string; message?: string }): void;
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
 * 致命失败信号：仅用于 React 完全无法渲染的场景（如 main.tsx 同步抛错）。
 * watchdog 进入 error 态并写一次 `UI_BOOT_FATAL`（ERROR）。ErrorBoundary 捕获
 * 渲染异常说明 React 仍活着，应调用 `bootReady()` 而不是本函数（协议 §3）。
 */
export function bootFail(info: { stage?: string; message?: string }): void {
  try {
    getBootApi()?.fail(info);
  } catch {
    // 失败信号自身绝不能再抛错。
  }
}
