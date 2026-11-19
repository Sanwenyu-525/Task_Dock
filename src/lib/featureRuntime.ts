//! 功能模块生命周期运行时（按需加载的唯一实现点）。
//!
//! ## 为什么需要它
//! 侧栏「隐藏」只影响渲染，页面代码仍然可能被打进首屏 bundle 并在启动时解析。
//! 本模块把「功能是否存在」「代码是否已下载」「页面实例是否挂载」「重型能力是否
//! 初始化」四个概念分开，并为每个功能维护一条可观测的生命周期：
//!
//! ```text
//! unregistered → registered → loading → loaded → activating → active
//!                    ↑            └── failed ──┘         ↓
//!                    └──────────── retry ───────────  inactive ⇄ suspended
//!                                                          ↓
//!                                              disposing → disposed
//! ```
//!
//! ## 语义边界（与 docs/ON_DEMAND_LOADING.md 一致）
//! - `registerFeature` 只登记元数据，**绝不**触发 import；
//! - `loadFeature` 只负责**代码**：同一 id 并发请求复用同一个 Promise，成功后缓存
//!   模块对象；失败不缓存，`retryFeature` 才会重新 import（React.lazy 会把失败
//!   Promise 永久缓存，因此这里不使用 lazy 作为加载器）；
//! - `activateFeature` / `deactivateFeature` 只反映**页面实例**的活跃状态；
//! - `suspendFeature` 表示窗口不可见/用户离开后的「暂停」态，页面自身的轮询仍需
//!   由页面按 `active` 自行停止（本模块不做隐式副作用）；
//! - `disposeFeature` 只释放功能级资源（`definition.dispose`），**不等于**卸载
//!   页面实例（那是 React 的事，见 `FeatureView` 的 `release` 策略）。
//!
//! ## 生产开销
//! 每次加载只在内存里更新一个记录；诊断日志只写「失败」与「慢加载」（≥1s），
//! 不逐帧、不轮询、不写库。事件环形缓冲固定 40 条，永不增长。

/** 生命周期状态（顺序即典型流转方向，接口允许跳跃但会被计数）。 */
export type FeatureState =
  | "unregistered"
  | "registered"
  | "loading"
  | "loaded"
  | "activating"
  | "active"
  | "inactive"
  | "suspended"
  | "failed"
  | "disposing"
  | "disposed";

/** 资源等级：决定默认缓存/释放策略与诊断展示顺序。 */
export type FeatureTier = "light" | "standard" | "heavy" | "daemon";

/** 页面实例策略：keep=离开后保活（默认）；release=离开即卸载实例（代码仍缓存）。 */
export type FeatureInstancePolicy = "keep" | "release";

/** 预加载策略：never=从不；hover=悬停/聚焦导航项时；idle=空闲时（每功能至多一次）。 */
export type FeaturePreloadPolicy = "never" | "hover" | "idle";

/** 动态 import 的返回形状（保证 `default` 是组件）。 */
export type FeatureModuleLoader = () => Promise<{ default: unknown }>;

export interface FeatureDefinition {
  /** 稳定 ID（`page:xxx` / `service:xxx`），不接受中文或展示名。 */
  id: string;
  /** 诊断用可读名（不作为 UI 文案；UI 文案走 i18n）。 */
  label: string;
  /** 代码入口。仅登记元数据的纯配置功能可以不提供。 */
  load?: FeatureModuleLoader;
  /** 依赖功能：加载本功能前先确保依赖已加载（失败则整体失败）。 */
  dependsOn?: readonly string[];
  tier?: FeatureTier;
  instance?: FeatureInstancePolicy;
  preload?: FeaturePreloadPolicy;
  /**
   * 功能级资源释放：只应释放本功能独占的资源（连接、Worker、监听器）。
   * 不得在这里删除用户数据或重置共享 store。
   */
  dispose?: () => void | Promise<void>;
}

/** 单功能运行记录（对外快照的字段集合，避免把内部 Map 暴露给 UI）。 */
export interface FeatureSnapshot {
  id: string;
  label: string;
  state: FeatureState;
  tier: FeatureTier;
  instance: FeatureInstancePolicy;
  preload: FeaturePreloadPolicy;
  /** 实际执行 import 的次数（去重后）。 */
  loadExecutions: number;
  /** 收到的加载请求数（含被并发合并的请求）。 */
  loadRequests: number;
  /** 成功加载次数（同一模块只会成功一次，重试失败后可能再次成功）。 */
  loads: number;
  failures: number;
  retries: number;
  /** 最近一次成功 import 的耗时（毫秒）。 */
  loadMs: number | null;
  lastLoadedAt: number | null;
  activations: number;
  deactivations: number;
  instanceReleases: number;
  lastActivatedAt: number | null;
  preloads: number;
  preloadFailures: number;
  lastError: string | null;
  disposedAt: number | null;
}

export interface FeatureRuntimeEvent {
  at: number;
  id: string;
  kind:
    | "register"
    | "load"
    | "load-failed"
    | "retry"
    | "activate"
    | "deactivate"
    | "suspend"
    | "resume"
    | "release"
    | "dispose"
    | "preload"
    | "preload-failed"
    | "preload-skipped";
  durationMs?: number;
  detail?: string;
}

export interface FeatureRuntimeSummary {
  total: number;
  loaded: number;
  active: number;
  suspended: number;
  failed: number;
  disposed: number;
  /** 加载请求总数与真实执行次数之差 = 并发合并掉的重复加载。 */
  loadRequests: number;
  loadExecutions: number;
  loadFailures: number;
  retries: number;
  preloads: number;
  preloadFailures: number;
  preloadSkipped: number;
  activations: number;
  instanceReleases: number;
  disposals: number;
  /** 当前仍在飞行的加载数（用于空闲预加载避让）。 */
  loading: number;
}

/** 慢加载阈值：达到即写一条 INFO 诊断（正常加载不留日志）。 */
const SLOW_LOAD_MS = 1000;
/** 预加载失败冷却：避免 hover 反复触发同一个坏模块。 */
const PRELOAD_FAILURE_COOLDOWN_MS = 30_000;
/** 事件环形缓冲上限。 */
const MAX_EVENTS = 40;

type Listener = () => void;

interface Record_ {
  definition: FeatureDefinition;
  state: FeatureState;
  loadExecutions: number;
  loadRequests: number;
  loads: number;
  failures: number;
  retries: number;
  loadMs: number | null;
  lastLoadedAt: number | null;
  activations: number;
  deactivations: number;
  instanceReleases: number;
  lastActivatedAt: number | null;
  preloads: number;
  preloadFailures: number;
  lastError: string | null;
  disposedAt: number | null;
  /** 预加载失败后的冷却截止时间。 */
  preloadCooldownUntil: number;
  /** 对外快照对象：仅在字段变化时替换，保证 useSyncExternalStore 快照稳定。 */
  snapshot: FeatureSnapshot;
}

const records = new Map<string, Record_>();
const codeCache = new Map<string, unknown>();
const inFlightLoads = new Map<string, Promise<unknown>>();
const listeners = new Set<Listener>();
const events: FeatureRuntimeEvent[] = [];

const counters = {
  loadRequests: 0,
  loadExecutions: 0,
  loadFailures: 0,
  retries: 0,
  preloads: 0,
  preloadFailures: 0,
  preloadSkipped: 0,
  activations: 0,
  instanceReleases: 0,
  disposals: 0,
};

let runtimeRevision = 0;

function now(): number {
  try {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200) || error.name;
  if (typeof error === "string") return error.slice(0, 200);
  try {
    return JSON.stringify(error).slice(0, 200);
  } catch {
    return "unknown error";
  }
}

function emit(event: FeatureRuntimeEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  runtimeRevision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 订阅方异常不能打断加载流程。
    }
  }
}

/** 更新记录并刷新快照对象（只在值真的变化时分配新对象）。 */
function commit(rec: Record_): void {
  const next = buildSnapshot(rec);
  const prev = rec.snapshot;
  let changed = false;
  for (const key of Object.keys(next) as Array<keyof FeatureSnapshot>) {
    if (next[key] !== prev[key]) {
      changed = true;
      break;
    }
  }
  if (changed) rec.snapshot = next;
}

function buildSnapshot(rec: Record_): FeatureSnapshot {
  const def = rec.definition;
  return {
    id: def.id,
    label: def.label,
    state: rec.state,
    tier: def.tier ?? "standard",
    instance: def.instance ?? "keep",
    preload: def.preload ?? "never",
    loadExecutions: rec.loadExecutions,
    loadRequests: rec.loadRequests,
    loads: rec.loads,
    failures: rec.failures,
    retries: rec.retries,
    loadMs: rec.loadMs,
    lastLoadedAt: rec.lastLoadedAt,
    activations: rec.activations,
    deactivations: rec.deactivations,
    instanceReleases: rec.instanceReleases,
    lastActivatedAt: rec.lastActivatedAt,
    preloads: rec.preloads,
    preloadFailures: rec.preloadFailures,
    lastError: rec.lastError,
    disposedAt: rec.disposedAt,
  };
}

function transition(rec: Record_, state: FeatureState): void {
  rec.state = state;
  commit(rec);
}

/**
 * 登记功能元数据。重复登记同一 ID：
 * - loader 相同 → 幂等，不重置运行状态；
 * - loader 不同 → 抛错（重复注册会让「按 ID 加载」产生歧义，必须在开发期暴露）。
 */
export function registerFeature(definition: FeatureDefinition): void {
  if (!definition.id || !definition.id.includes(":")) {
    throw new Error(`feature id 必须形如 "page:xxx"，收到 "${definition.id}"`);
  }
  const existing = records.get(definition.id);
  if (existing) {
    if (existing.definition.load !== definition.load) {
      throw new Error(`功能 ${definition.id} 重复注册且 loader 不同（同一 ID 只能有一个代码入口）`);
    }
    return;
  }
  const rec: Record_ = {
    definition,
    state: "registered",
    loadExecutions: 0,
    loadRequests: 0,
    loads: 0,
    failures: 0,
    retries: 0,
    loadMs: null,
    lastLoadedAt: null,
    activations: 0,
    deactivations: 0,
    instanceReleases: 0,
    lastActivatedAt: null,
    preloads: 0,
    preloadFailures: 0,
    lastError: null,
    disposedAt: null,
    preloadCooldownUntil: 0,
    snapshot: {
      id: definition.id,
      label: definition.label,
      state: "registered",
      tier: definition.tier ?? "standard",
      instance: definition.instance ?? "keep",
      preload: definition.preload ?? "never",
      loadExecutions: 0,
      loadRequests: 0,
      loads: 0,
      failures: 0,
      retries: 0,
      loadMs: null,
      lastLoadedAt: null,
      activations: 0,
      deactivations: 0,
      instanceReleases: 0,
      lastActivatedAt: null,
      preloads: 0,
      preloadFailures: 0,
      lastError: null,
      disposedAt: null,
    },
  };
  records.set(definition.id, rec);
  emit({ at: Date.now(), id: definition.id, kind: "register" });
}

export function isFeatureRegistered(id: string): boolean {
  return records.has(id);
}

/** 代码是否已经加载（模块对象在缓存里）。 */
export function isFeatureLoaded(id: string): boolean {
  return codeCache.has(id);
}

/** 读取模块对象（已加载时同步返回；未加载返回 undefined，不触发加载）。 */
export function peekFeatureModule<T = unknown>(id: string): T | undefined {
  return codeCache.get(id) as T | undefined;
}

/**
 * 加载功能代码。并发调用复用同一个 Promise；已加载直接返回缓存。
 *
 * 失败不会自动重试（避免网络/磁盘故障时的重试风暴），由 `retryFeature` 显式重试；
 * 失败后再次调用 `loadFeature` 视为一次重试（记 retries）。
 */
export function loadFeature<T = unknown>(id: string): Promise<T> {
  const rec = records.get(id);
  if (!rec) {
    return Promise.reject(new Error(`功能未注册：${id}`));
  }
  const cached = codeCache.get(id);
  if (cached !== undefined) return Promise.resolve(cached as T);

  const inFlight = inFlightLoads.get(id);
  if (inFlight) {
    rec.loadRequests += 1;
    counters.loadRequests += 1;
    commit(rec);
    return inFlight as Promise<T>;
  }

  const loader = rec.definition.load;
  if (!loader) {
    // 纯元数据功能：没有代码入口，视为「已加载」。
    codeCache.set(id, EMPTY_MODULE);
    rec.loads += 1;
    rec.loadExecutions += 1;
    rec.loadRequests += 1;
    rec.lastLoadedAt = Date.now();
    rec.loadMs = 0;
    counters.loadRequests += 1;
    counters.loadExecutions += 1;
    transition(rec, "loaded");
    emit({ at: Date.now(), id, kind: "load", durationMs: 0 });
    return Promise.resolve(EMPTY_MODULE as T);
  }

  if (rec.state === "failed") {
    rec.retries += 1;
    counters.retries += 1;
  }
  counters.loadRequests += 1;
  counters.loadExecutions += 1;
  rec.loadRequests += 1;
  rec.loadExecutions += 1;
  transition(rec, "loading");

  const started = now();
  const promise = (async () => {
    // 依赖先加载：任一依赖失败都会让本功能失败（不吞异常）。
    for (const dep of rec.definition.dependsOn ?? []) {
      await loadFeature(dep);
    }
    return await loader();
  })()
    .then((module) => {
      const duration = Math.round(now() - started);
      codeCache.set(id, module);
      rec.loads += 1;
      rec.loadMs = duration;
      rec.lastLoadedAt = Date.now();
      rec.lastError = null;
      transition(rec, "loaded");
      emit({ at: Date.now(), id, kind: "load", durationMs: duration });
      if (duration >= SLOW_LOAD_MS) {
        // 慢加载是真实性能问题，值得一条持久化记录；正常加载不写日志。
        void logSlowLoad(id, rec.definition.label, duration);
      }
      return module as T;
    })
    .catch((error: unknown) => {
      rec.failures += 1;
      rec.lastError = describe(error);
      counters.loadFailures += 1;
      transition(rec, "failed");
      emit({ at: Date.now(), id, kind: "load-failed", detail: rec.lastError });
      void logLoadFailure(id, rec.definition.label, rec.lastError);
      throw error;
    })
    .finally(() => {
      inFlightLoads.delete(id);
    });

  inFlightLoads.set(id, promise);
  return promise as Promise<T>;
}

const EMPTY_MODULE = Object.freeze({});

/** 显式重试失败的加载。非失败态调用是幂等的（直接返回加载结果）。 */
export function retryFeature<T = unknown>(id: string): Promise<T> {
  const rec = records.get(id);
  if (!rec) return Promise.reject(new Error(`功能未注册：${id}`));
  if (rec.state !== "failed") return loadFeature<T>(id);
  rec.lastError = null;
  emit({ at: Date.now(), id, kind: "retry" });
  return loadFeature<T>(id);
}

/**
 * 预加载：只在策略允许且当前没有其他加载在飞行时执行。
 *
 * 返回值用于诊断：`started` / `skipped` / `failed`。失败不抛出（预加载是优化手段，
 * 绝不能影响正常导航），但会记录次数；相同模块在冷却期内不会被反复重试。
 */
/**
 * 预加载：触发原因必须与注册策略**严格一致**（hover↔hover、idle↔idle、never=禁止）。
 *
 * 为什么不允许降级：`idle` 策略表示「只在真正空闲时预取」（如默认页），
 * 鼠标划过导航项并不等于用户要进入它；若允许 hover 触发 idle，启动后随手划过
 * 侧栏就会把默认页模块拉进来，等于绕过了策略。
 *
 * 其余约束：已加载直接 `loaded`；有其它加载在飞时让路；失败进入冷却（不重试风暴）；
 * 预加载只下载代码，不挂载页面、不初始化业务服务、失败不影响导航。
 */
export function preloadFeature(
  id: string,
  reason: "hover" | "idle" = "hover",
): "started" | "skipped" | "failed" | "loaded" {
  const rec = records.get(id);
  if (!rec) return "skipped";
  // 已加载 = 本次预加载无事可做：直接返回 loaded（不触发任何加载，也不受原因限制）。
  if (codeCache.has(id)) return "loaded";
  const policy = rec.definition.preload ?? "never";
  if (policy === "never" || policy !== reason) {
    counters.preloadSkipped += 1;
    emit({
      at: Date.now(),
      id,
      kind: "preload-skipped",
      detail: policy === "never" ? "policy" : "policy-mismatch",
    });
    return "skipped";
  }
  if (Date.now() < rec.preloadCooldownUntil) {
    counters.preloadSkipped += 1;
    emit({ at: Date.now(), id, kind: "preload-skipped", detail: "cooldown" });
    return "skipped";
  }
  // 已有加载在飞行：预加载让路，避免和用户真正需要的页面抢带宽/主线程。
  if (inFlightLoads.size > 0) {
    counters.preloadSkipped += 1;
    emit({ at: Date.now(), id, kind: "preload-skipped", detail: "busy" });
    return "skipped";
  }
  rec.preloads += 1;
  counters.preloads += 1;
  commit(rec);
  emit({ at: Date.now(), id, kind: "preload", detail: reason });
  void loadFeature(id).catch(() => {
    rec.preloadFailures += 1;
    counters.preloadFailures += 1;
    rec.preloadCooldownUntil = Date.now() + PRELOAD_FAILURE_COOLDOWN_MS;
    commit(rec);
    emit({ at: Date.now(), id, kind: "preload-failed" });
  });
  return "started";
}

/** 标记功能进入活跃态（页面已挂载且可见）。未加载时先加载。 */
export async function activateFeature(id: string): Promise<void> {
  const rec = records.get(id);
  if (!rec) throw new Error(`功能未注册：${id}`);
  if (rec.state === "active") return;
  if (!codeCache.has(id)) {
    transition(rec, "activating");
    await loadFeature(id);
  }
  rec.activations += 1;
  rec.lastActivatedAt = Date.now();
  counters.activations += 1;
  transition(rec, "active");
  emit({ at: Date.now(), id, kind: "activate" });
}

/** 标记功能离开可见态（页面仍可能保活）。重复调用幂等。 */
export function deactivateFeature(id: string): void {
  const rec = records.get(id);
  if (!rec) return;
  if (rec.state !== "active" && rec.state !== "suspended") return;
  rec.deactivations += 1;
  transition(rec, "inactive");
  emit({ at: Date.now(), id, kind: "deactivate" });
}

/**
 * 暂停：窗口不可见/用户长时间离开时使用。只改状态并通知订阅方，
 * **不替代**页面自己的轮询停止逻辑（页面必须按 `active` 自行清理）。
 */
export function suspendFeature(id: string): void {
  const rec = records.get(id);
  if (!rec || rec.state !== "active") return;
  transition(rec, "suspended");
  emit({ at: Date.now(), id, kind: "suspend" });
}

/** 从暂停态恢复为活跃态。 */
export function resumeFeature(id: string): void {
  const rec = records.get(id);
  if (!rec || rec.state !== "suspended") return;
  transition(rec, "active");
  emit({ at: Date.now(), id, kind: "resume" });
}

/** 页面实例被卸载（`release` 策略下离开页面）。只计数，不释放代码缓存。 */
export function noteFeatureInstanceReleased(id: string): void {
  const rec = records.get(id);
  if (!rec) return;
  rec.instanceReleases += 1;
  counters.instanceReleases += 1;
  commit(rec);
  emit({ at: Date.now(), id, kind: "release" });
}

/**
 * 释放功能级资源（连接/Worker/监听器）。代码缓存与已加载模块保留：
 * 再次进入页面不需要重新下载，但必须重新执行 `instance` 的初始化。
 */
export async function disposeFeature(id: string): Promise<void> {
  const rec = records.get(id);
  if (!rec) return;
  if (rec.state === "disposing" || rec.state === "disposed") return;
  transition(rec, "disposing");
  try {
    await rec.definition.dispose?.();
  } finally {
    rec.disposedAt = Date.now();
    counters.disposals += 1;
    transition(rec, "disposed");
    emit({ at: Date.now(), id, kind: "dispose" });
  }
}

/** 当前功能快照（未注册返回 null）。 */
export function getFeatureSnapshot(id: string): FeatureSnapshot | null {
  return records.get(id)?.snapshot ?? null;
}

/** 全部功能快照（按 ID 稳定排序，便于诊断展示与对比）。 */
export function listFeatureSnapshots(): FeatureSnapshot[] {
  return [...records.values()]
    .map((rec) => rec.snapshot)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** 汇总指标：用于诊断中心与验收脚本。 */
export function getFeatureRuntimeSummary(): FeatureRuntimeSummary {
  const all = [...records.values()];
  return {
    total: all.length,
    loaded: codeCache.size,
    active: all.filter((rec) => rec.state === "active").length,
    suspended: all.filter((rec) => rec.state === "suspended").length,
    failed: all.filter((rec) => rec.state === "failed").length,
    disposed: all.filter((rec) => rec.state === "disposed").length,
    loadRequests: counters.loadRequests,
    loadExecutions: counters.loadExecutions,
    loadFailures: counters.loadFailures,
    retries: counters.retries,
    preloads: counters.preloads,
    preloadFailures: counters.preloadFailures,
    preloadSkipped: counters.preloadSkipped,
    activations: counters.activations,
    instanceReleases: counters.instanceReleases,
    disposals: counters.disposals,
    loading: inFlightLoads.size,
  };
}

/** 最近事件（最多 40 条，供诊断定位异常初始化）。 */
export function listFeatureEvents(): readonly FeatureRuntimeEvent[] {
  return events;
}

/** 订阅任意变化（React 侧 `useSyncExternalStore` 的唯一入口）。 */
export function subscribeFeatureRuntime(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 变更版本号：`useSyncExternalStore` 的快照可以是它（内容由选择器读取）。 */
export function getFeatureRuntimeRevision(): number {
  return runtimeRevision;
}

/**
 * 仅测试使用：清空注册与缓存。
 * 生产代码不得调用（会丢失已加载模块并让监控数据归零）。
 */
export function __resetFeatureRuntimeForTests(): void {
  records.clear();
  codeCache.clear();
  inFlightLoads.clear();
  listeners.clear();
  events.length = 0;
  runtimeRevision = 0;
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) {
    counters[key] = 0;
  }
}

// ── 诊断接入（延迟 import，避免 runtime 依赖 bridge 形成循环）──────────

async function logLoadFailure(id: string, label: string, message: string): Promise<void> {
  try {
    const { logEvent } = await import("./diagnostics");
    logEvent({
      level: "WARN",
      module: "feature",
      action: "load",
      event: "failed",
      status: "failed",
      error_code: "FEATURE_LOAD_FAILED",
      error_category: "ipc",
      message: `${label} 代码加载失败：${message}`,
      metadata: { feature: id },
    });
  } catch {
    // 诊断失败不影响功能。
  }
}

async function logSlowLoad(id: string, label: string, durationMs: number): Promise<void> {
  try {
    const { logEvent } = await import("./diagnostics");
    logEvent({
      level: "INFO",
      module: "feature",
      action: "load",
      event: "slow",
      status: "success",
      duration_ms: durationMs,
      message: `${label} 代码加载较慢`,
      metadata: { feature: id },
    });
  } catch {
    // 同上。
  }
}
