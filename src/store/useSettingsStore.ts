//! 设置 Store：视觉预设 × 明暗 × 材质 的统一应用管道（v0.6）。
//!
//! 所有入口（设置页、标题栏菜单、托盘菜单、系统偏好变化）都收敛到这里，
//! 保证任意路径切换立即生效、无需重启：
//!
//!   settings（持久化偏好）
//!     ├─ theme          → html[data-theme]            （light | dark）
//!     ├─ visual_preset  → html[data-preset]           （frosted | dream-gradient）
//!     └─ material       → html[data-material]         （**实际生效值**，可能已降级）
//!
//! 三条硬约束：
//! 1. 界面 class 必须用 `materialInfo.resolved`（实际材质），不能用用户请求值 ——
//!    v0.5 的 bug 是 App.tsx 拿 `settings.material` 上 class，原生材质已回退 solid
//!    时界面仍在渲染半透明玻璃样式，导致文字压在桌面上。
//! 2. 每次重算都真探测原生材质（幂等）。系统「减少透明效果」关闭后必须能重新
//!    应用 Mica/Acrylic，而不是只把 CSS 半透明打开、原生效果仍处于被清除状态。
//! 3. 预设切换只改 CSS 变量与 Win32 圆角半径，不触碰任务 / Agent / 剪贴板状态。

import { create } from "zustand";
import {
  applyMode,
  applyWindowMaterial,
  applyWindowRadius,
  getSettings,
  updateSettings,
  type Settings,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import { isWindowMode, resolveWindowMode } from "../lib/windowMode";
import {
  hasNativeGlass,
  presetRadius,
  readSystemFlags,
  resolveGlassRender,
  resolveMaterial,
  resolveTheme,
  resolveVisualPreset,
  type GlassRender,
  type MaterialSetting,
  type VisualPreset,
} from "../lib/theme";

export interface MaterialInfo {
  requested: MaterialSetting;
  resolved: MaterialSetting;
  /** 玻璃是否在渲染（CSS 或原生都算）；不代表原生模糊生效 */
  applied: boolean;
  /** 原生模糊是否真正生效（mica/acrylic/blur） */
  native: boolean;
  /** 实际渲染通道：native / css / solid */
  render: GlassRender;
  /** 后端命中的效果名：mica / acrylic / blur / css / none */
  effect: string;
  osVersion: string;
  /** Win32 圆角区域是否应用成功（false 时四角可能露原生直角） */
  shapeApplied: boolean;
  /** 原生材质 IPC 失败原因：非空时 resolved 为 CSS/不透明降级，需在设置页如实说明并可重试 */
  materialError?: string | null;
}

function match(q: string): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(q).matches;
}

function currentTheme() {
  return useSettingsStore.getState().settings?.theme ?? "system";
}

function currentMaterial(): MaterialSetting {
  const m = useSettingsStore.getState().settings?.material;
  return m === "solid" ? "solid" : "glass";
}

function currentPreset(): VisualPreset {
  return resolveVisualPreset(useSettingsStore.getState().settings?.visual_preset);
}

/** 最近一次下发给 Win32 的半径，避免主题切换时重复 IPC。 */
let lastRadius = -1;

/**
 * 设置读侧收敛：模式是外壳唯一视图判据，非法值必须拦在 store 之外。
 *
 * 只改内存值、不写库（持久化纠正由写入路径负责）：后端/旧备份/历史库可能
 * 带回过 `""`、`"Full"` 或未来版本的新枚举；这些值会让 App 的三个
 * `.view-slot` 全部不是 `active`，表现为「只剩标题栏和背景」的空白窗口。
 * 归一化后非法值落到 `full`，导航与设置入口始终可达。诊断只记录一次，
 * 避免每次设置刷新都刷日志。
 */
let invalidModeReported = false;
let invalidSnapshotReported = false;

/**
 * 外部事件可写字段的版本号。
 *
 * `mode`（标题栏/托盘/胶囊跳转）、`theme`（托盘）、`snap_display_mode`（右键菜单）
 * 会由 `syncExternal` 在**设置写入响应到达之前**更新到 store。写入响应是「后端
 * 读取到的完整快照」，若它开始得比外部事件更早，快照里的这些字段就是旧值：
 * 直接整体覆盖会让界面回退到旧模式/旧主题，而窗口尺寸、吸附形态已经是新值。
 * 典型后果：窗口已按「极简」缩小，界面却仍按「完整」渲染，看起来只剩标题栏。
 *
 * 因此每个字段单独记版本：写入发起后版本变过的字段一律保留当前值，
 * 并在写完后做一次有界「终态核对」（见 `reconcileExternalConflict`）。
 *
 * 注意：同字段的连续写入由写入队列串行保证顺序（见 `enqueueWrite`），
 * 这里只处理**外部路径**（原生窗口命令 / 托盘 / 右键菜单）与在途快照的竞争。
 */
type ExternalField = "mode" | "theme" | "visual_preset" | "snap_display_mode";
const EXTERNAL_FIELDS: readonly ExternalField[] = [
  "mode",
  "theme",
  "visual_preset",
  "snap_display_mode",
];
const externalFieldSeq: Record<ExternalField, number> = {
  mode: 0,
  theme: 0,
  visual_preset: 0,
  snap_display_mode: 0,
};

function bumpExternalFields(patch: Record<string, unknown>): void {
  for (const key of EXTERNAL_FIELDS) {
    if (patch[key] !== undefined) externalFieldSeq[key] += 1;
  }
}

function snapshotExternalFields(): Record<ExternalField, number> {
  return { ...externalFieldSeq };
}

/**
 * 设置快照收敛（load / update / syncExternal 共用）。
 *
 * - 缺失或 `undefined` 的键沿用上一份值：残缺响应不得清空无关设置；
 * - 非法 `mode`：优先保留上一份合法值，没有才回退 `full` —— 一次异常响应不能
 *   顺带改变用户正在使用的显示模式；
 * - `staleFields`：写入发起后**被外部事件改写过**的字段，一律保留当前值。
 *   即使本次补丁显式包含该字段也一样——外部事件（apply_mode / 托盘 / 右键菜单）
 *   发生在请求之后，是更新的意图（见上面版本号说明）。
 */
function normalizeLoadedSettings(
  s: Settings,
  prev: Settings | null = null,
  staleFields: readonly ExternalField[] = [],
): Settings {
  if (!s || typeof s !== "object") {
    if (!invalidSnapshotReported) {
      invalidSnapshotReported = true;
      console.warn("[settings] 设置快照不是对象，已保留当前设置");
    }
    if (prev) return prev;
    // 没有任何可用旧值：交给调用方，由外壳层的 mode 归一化兜底。
    return s;
  }

  let next: Settings = s;
  if (prev) {
    const merged: Record<string, unknown> = { ...prev };
    for (const [key, value] of Object.entries(s)) {
      if (value !== undefined) merged[key] = value;
    }
    next = merged as unknown as Settings;
  }

  if (!isWindowMode(next.mode)) {
    const fallback = isWindowMode(prev?.mode) ? prev!.mode : resolveWindowMode(next.mode);
    if (!invalidModeReported) {
      invalidModeReported = true;
      console.warn("[settings] 非法显示模式已回退", { mode: next.mode, fallback });
    }
    next = { ...next, mode: fallback };
  }

  for (const key of staleFields) {
    if (prev && prev[key] !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = prev[key];
    }
  }
  return next;
}

export const useSettingsStore = create<{
  settings: Settings | null;
  /** 材质实际状态（含降级信息） */
  materialInfo: MaterialInfo | null;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  /** 托盘/事件路径：后端已持久化，前端只同步并应用 */
  syncExternal: (patch: {
    theme?: string;
    mode?: string;
    visual_preset?: string;
    snap_display_mode?: "capsule" | "full";
  }) => void;
  /** 系统主题/对比度/透明偏好变化时重算 DOM（不写后端） */
  reapplyFromSystem: () => void;
}>((set, get) => {
  function applyThemeToDom() {
    const flags = readSystemFlags(match, null);
    document.documentElement.dataset.theme = resolveTheme(currentTheme(), flags);
  }

  /** 预设：只改 CSS 变量域 + Win32 圆角，不影响任何业务状态。 */
  function applyPresetToDom(): VisualPreset {
    const preset = currentPreset();
    const root = document.documentElement;
    root.dataset.preset = preset;
    // clear_foreground 已废弃（清透预设下线）：不再读取，也不写 data-clear-fg。
    const radius = presetRadius(preset);
    if (radius !== lastRadius) {
      lastRadius = radius;
      // 半径下发失败不影响 CSS 圆角，只记录在 materialInfo.shapeApplied
      void applyWindowRadius(radius)
        .then((ok) => {
          const info = get().materialInfo;
          if (info && info.shapeApplied !== ok) set({ materialInfo: { ...info, shapeApplied: ok } });
        })
        .catch(() => {});
    }
    return preset;
  }

  /**
   * 材质应用序号：原生探测是异步 IPC，期间用户可能又切了材质/主题。
   * 返回时若序号已过期就丢弃结果，避免旧响应覆盖更新后的 DOM 状态。
   */
  let materialEpoch = 0;

  /**
   * 材质 IPC 串行链。Rust 侧不识别请求序号：并发的 `apply_window_material`
   * 可能乱序落到主线程，导致「界面已是新预设、窗口却挂着旧材质」。
   * 序号只能忽略过期响应，不能撤销已经执行的窗口改动，因此这里让请求排队，
   * 后发请求一定在后执行；排队期间又有更新时跳过中间态，只落最后一次设置。
   */
  let materialChain: Promise<void> = Promise.resolve();

  function applyMaterial(): Promise<void> {
    const epoch = ++materialEpoch;
    const run = async () => {
      if (epoch !== materialEpoch) return; // 已有更新的请求在队列里，跳过本次
      await applyMaterialNow(epoch);
    };
    materialChain = materialChain.then(run, run);
    return materialChain;
  }

  async function applyMaterialNow(epoch: number): Promise<void> {
    const requested = currentMaterial();
    let glassApplied: boolean | null = null;
    let effect = "none";
    let osVersion = "";
    let materialError: string | null = null;

    // 每次都真探测：请求 glass 时应用 Mica/Acrylic/CSS，请求 solid 时清除。
    // Rust 端幂等；系统偏好变化是低频操作，这点 IPC 成本换来状态绝对一致。
    if (requested === "glass") {
      try {
        // 预设一并下发：清透玻璃必须强制 CSS 通道（禁止原生模糊把桌面糊掉）。
        const r = await applyWindowMaterial("glass", currentPreset());
        if (epoch !== materialEpoch) return;
        // applied 表示「玻璃渲染已生效」（CSS 半透明也算），不是原生模糊。
        // 原生与否由 effect 决定，绝不能把 applied 直接当 native 用。
        glassApplied = r.applied;
        effect = r.effect;
        osVersion = r.os_version;
      } catch (e) {
        if (epoch !== materialEpoch) return;
        // 原生材质调用失败：如实记录原因，界面按实际渲染通道展示降级状态
        materialError = errorMessage(e);
        glassApplied = false;
      }
    } else {
      try {
        // 与 glass 路径保持同一签名：预设一并下发（solid 端会忽略，但便于日志/诊断对齐）。
        await applyWindowMaterial("solid", currentPreset());
      } catch {
        // 清除失败不影响 CSS 侧（不透明表面已完全遮挡）
      }
      if (epoch !== materialEpoch) return;
      glassApplied = null;
    }

    const flags = readSystemFlags(match, glassApplied);
    const resolved = resolveMaterial(requested, flags);

    // 降级原因：高对比度 / 减少透明 / 玻璃渲染失败，三种都要清除原生效果
    if (requested === "glass" && resolved === "solid") {
      try {
        await applyWindowMaterial("solid", currentPreset());
      } catch {
        // 同上
      }
      if (epoch !== materialEpoch) return;
    }

    const render = resolveGlassRender(
      resolved,
      effect,
      requested === "glass" ? glassApplied : null,
    );
    const root = document.documentElement;
    root.dataset.material = resolved;
    // 三态显式落到 DOM：CSS 据此选择「原生模糊 / CSS 可读性兜底 / 不透明」参数集。
    root.dataset.glassRender = render;
    root.dataset.nativeGlass = hasNativeGlass(resolved, render) ? "true" : "false";

    const shapeApplied = get().materialInfo?.shapeApplied ?? false;
    set({
      materialInfo: {
        requested,
        resolved,
        applied: resolved === "glass",
        native: render === "native",
        render,
        effect: requested === "glass" ? effect : "none",
        osVersion,
        shapeApplied,
        materialError,
      },
    });
  }

  /**
   * ── 设置写入队列：串行 + 合并 ────────────────────────────────────────
   *
   * 规则（可证明的并发契约）：
   * 1. **任意时刻最多一个写入在途**。期间到达的请求合并为一个待发补丁：同键后值覆盖
   *    前值、不同键累加。于是
   *    - 不同字段的独立更新都会落地，互不吞掉（每个响应都会被应用）；
   *    - 同字段连续写入按用户操作顺序到达后端（最后操作优先，且是**持久化**顺序，
   *      不只是前端看起来正确）；
   *    - 突发变更最多产生「1 在途 + 1 待发」两次 IPC，不会形成无界队列；
   *    - 我方请求的响应不可能乱序（只存在一个在途请求）。
   * 2. 响应**逐字段**裁决：快照缺失/`undefined` 的键保留现值；请求发起后被外部事件
   *    （apply_mode / 托盘 / 右键菜单）改写的字段保留外部值（即使本次补丁包含该字段）。
   * 3. 发生裁决丢弃时，在队列尾部做一次**有界终态核对**：重读数据库，必要时
   *    重新下发外部值（`mode` 走 `apply_mode`，同时修正窗口尺寸），保证
   *    UI、数据库、原生窗口三者一致，而不是只让 Zustand 看起来正确。
   * 4. 失败只影响该批次：已成功批次的字段不回滚、不重放；失败后按数据库真值
   *    对齐一次（防止后端部分写入造成分叉），错误照常回传给调用方提示。
   */
  interface WriteWaiter {
    resolve: () => void;
    reject: (e: unknown) => void;
  }
  let pendingPatch: Partial<Settings> | null = null;
  let pendingWaiters: WriteWaiter[] = [];
  let draining = false;
  let reconciling = false;

  function enqueueWrite(patch: Partial<Settings>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (pendingPatch) {
        // 合并待发批次：同键由后一次操作覆盖（用户最后一次操作优先）。
        pendingPatch = { ...pendingPatch, ...patch };
        pendingWaiters.push({ resolve, reject });
      } else {
        pendingPatch = { ...patch };
        pendingWaiters = [{ resolve, reject }];
      }
      void drainWrites();
    });
  }

  async function drainWrites(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (pendingPatch) {
        const patch = pendingPatch;
        const waiters = pendingWaiters;
        pendingPatch = null;
        pendingWaiters = [];
        let staleFields: ExternalField[] = [];
        try {
          staleFields = await writeBatch(patch);
          for (const w of waiters) w.resolve();
        } catch (e) {
          for (const w of waiters) w.reject(e);
        }
        if (staleFields.length > 0) await reconcileExternalConflict(staleFields);
      }
    } finally {
      draining = false;
    }
  }

  /**
   * 执行一个批次；返回被外部事件压制的字段（非空表示需要终态核对）。
   * 响应逐字段应用，副作用按实际写入的字段触发（不会因为别的请求被丢弃而漏执行）。
   */
  async function writeBatch(patch: Partial<Settings>): Promise<ExternalField[]> {
    // 写侧兼容：历史调用方可能仍传 liquid-glass / clear，先归一为 frosted 再入库。
    const next: Partial<Settings> = patch.visual_preset
      ? { ...patch, visual_preset: resolveVisualPreset(patch.visual_preset) }
      : patch;
    const startedFields = snapshotExternalFields();
    let snapshot: Settings;
    try {
      snapshot = await updateSettings(next);
    } catch (e) {
      // 失败：正常情况后端「先整体校验再写入」，不会留下半套设置；为覆盖极端
      // 部分写入（磁盘/事务异常），按数据库真值对齐一次后再把错误交给调用方。
      // 其他成功批次的字段在库里，仍会保留；不重放旧请求、不重置设置。
      await alignWithDatabase(startedFields);
      throw e;
    }
    const stale = EXTERNAL_FIELDS.filter(
      (key) => externalFieldSeq[key] !== startedFields[key],
    );
    // 更新响应是「后端设置的完整快照」：任何无关字段（含 mode）都不能
    // 因为一次语音/导航/主题写入而让外壳进入无有效视图的状态；写入发起后
    // 被 apply_mode / 托盘事件改写的字段保留当前值，不用旧快照回退。
    set({ settings: normalizeLoadedSettings(snapshot, get().settings, stale) });
    // 副作用失败不能让「已成功写库」变成调用方看到的失败：单独兜住并记录诊断。
    try {
      if (next.visual_preset) applyPresetToDom();
      if (patch.theme) applyThemeToDom();
      // 预设切换后重放一次材质/圆角应用，保证窗口状态与最新设置一致；
      // 原生后端已不再按预设名分支，这里保留重放以覆盖并行修改。
      if (patch.material || next.visual_preset) await applyMaterial();
    } catch (e) {
      console.warn("[settings] 设置已保存，但界面副作用执行失败", e);
    }
    return stale;
  }

  /** 失败后对齐数据库真值（尽力而为；失败保持现值并记录诊断）。 */
  async function alignWithDatabase(
    startedFields: Record<ExternalField, number>,
  ): Promise<void> {
    try {
      const truth = await getSettings();
      if (!truth || typeof truth !== "object") return;
      const stale = EXTERNAL_FIELDS.filter(
        (key) => externalFieldSeq[key] !== startedFields[key],
      );
      set({ settings: normalizeLoadedSettings(truth, get().settings, stale) });
      applyPresetToDom();
      applyThemeToDom();
    } catch (e) {
      console.warn("[settings] 写入失败后对齐数据库失败，保留当前设置", e);
    }
  }

  /**
   * 外部事件冲突的终态核对（每批最多一次，且不并发）。
   *
   * 冲突意味着：写入发起后，另一个路径（apply_mode / 托盘 / 右键菜单）也改了字段。
   * 界面已保留外部值；但后端写入顺序未知——如果我们的旧写入晚到，数据库会落后于
   * 界面。这里重读数据库并**重新下发界面值**（`mode` 走 `apply_mode`，同时调整窗口
   * 尺寸），使 UI / 数据库 / 原生窗口收敛到较新的外部意图。
   */
  async function reconcileExternalConflict(staleFields: readonly ExternalField[]): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      const ui = get().settings;
      if (!ui) return;
      const db = await getSettings();
      if (!db || typeof db !== "object") return;
      if (staleFields.includes("mode") && isWindowMode(ui.mode) && db.mode !== ui.mode) {
        // apply_mode 同时写库、调整窗口尺寸并广播 mode-changed（幂等）。
        await applyMode(ui.mode);
      }
      // 只修复「本次确实被外部事件压制过」的字段：不碰与竞争无关的设置，
      // 也不拿较旧的界面值覆盖数据库里可能更新的值。
      const repair: Partial<Settings> = {};
      for (const key of ["theme", "visual_preset", "snap_display_mode"] as const) {
        if (staleFields.includes(key) && db[key] !== ui[key]) {
          (repair as Record<string, unknown>)[key] = ui[key];
        }
      }
      if (Object.keys(repair).length === 0) return;
      const startedFields = snapshotExternalFields();
      const fresh = await updateSettings(repair);
      const stale = EXTERNAL_FIELDS.filter(
        (key) => externalFieldSeq[key] !== startedFields[key],
      );
      set({ settings: normalizeLoadedSettings(fresh, get().settings, stale) });
      if (repair.visual_preset) applyPresetToDom();
      if (repair.theme) applyThemeToDom();
      if (repair.visual_preset) await applyMaterial();
    } catch (e) {
      // 核对失败不重置设置：界面保留较新的外部值，下次事件/写入会再次对齐。
      console.warn("[settings] 外部写入冲突核对失败，保留界面值", e);
    } finally {
      reconciling = false;
    }
  }

  return {
    settings: null,
    materialInfo: null,

    load: async () => {
      const s = await getSettings();
      set({ settings: normalizeLoadedSettings(s) });
      applyPresetToDom();
      applyThemeToDom();
      await applyMaterial();
    },

    update: (patch) => enqueueWrite(patch),

    syncExternal: (patch) => {
      const s = get().settings;
      if (!s) return;
      const preset = patch.visual_preset
        ? resolveVisualPreset(patch.visual_preset)
        : undefined;
      // 外部事件是这些字段的最新事实源：记版本，阻止在途的设置响应把它们回退。
      bumpExternalFields(patch as Record<string, unknown>);
      set({
        settings: normalizeLoadedSettings(
          {
            ...s,
            ...patch,
            ...(preset ? { visual_preset: preset } : {}),
          } as Settings,
          s,
        ),
      });
      if (preset) {
        applyPresetToDom();
        void applyMaterial();
      }
      if (patch.theme) applyThemeToDom();
    },

    reapplyFromSystem: () => {
      applyThemeToDom();
      // 必须重新探测原生材质：透明度偏好恢复后要真正重新应用 Mica/Acrylic
      void applyMaterial();
    },
  };
});

// ── 系统偏好监听：主题跟随 / 高对比度 / 减少透明 → 立即重算 ──
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = (q: string, cb: () => void) => {
    window.matchMedia(q).addEventListener("change", cb);
  };
  const reapply = () => useSettingsStore.getState().reapplyFromSystem();
  mq("(prefers-color-scheme: dark)", reapply);
  mq("(prefers-contrast: more)", reapply);
  mq("(prefers-reduced-transparency: more)", reapply);
  // 减少动态不改变配色/材质，但玻璃动效需要据此收敛（由 CSS 媒体查询处理，
  // 这里只在根节点标记，便于脚本化验收判断）
  mq("(prefers-reduced-motion: reduce)", () => {
    document.documentElement.dataset.reducedMotion = match("(prefers-reduced-motion: reduce)")
      ? "true"
      : "false";
  });
}
