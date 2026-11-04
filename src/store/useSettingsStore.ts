//! 设置 Store：视觉预设 × 明暗 × 材质 的统一应用管道（v0.6）。
//!
//! 所有入口（设置页、标题栏菜单、托盘菜单、系统偏好变化）都收敛到这里，
//! 保证任意路径切换立即生效、无需重启：
//!
//!   settings（持久化偏好）
//!     ├─ theme          → html[data-theme]            （light | dark）
//!     ├─ visual_preset  → html[data-preset]           （含 frosted | clear 两种玻璃外观）
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
  applyWindowMaterial,
  applyWindowRadius,
  getSettings,
  updateSettings,
  type Settings,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import {
  hasNativeGlass,
  presetRadius,
  readSystemFlags,
  resolveClearForeground,
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
    // 清透模式把「玻璃材质」与「前景配色」拆成两个维度：材质始终透明，
    // 前景可强制深/浅（浅桌面用深字、深桌面用浅字）。auto 跟随 data-theme。
    root.dataset.clearFg = resolveClearForeground(
      useSettingsStore.getState().settings?.clear_foreground,
    );
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

  return {
    settings: null,
    materialInfo: null,

    load: async () => {
      const s = await getSettings();
      set({ settings: s });
      applyPresetToDom();
      applyThemeToDom();
      await applyMaterial();
    },

    update: async (patch) => {
      const s = await updateSettings(patch);
      set({ settings: s });
      if (patch.visual_preset || patch.clear_foreground) applyPresetToDom();
      if (patch.theme) applyThemeToDom();
      // 预设会改变原生层的取舍（清透 = 无原生模糊，柔光 = 恢复原生/回退），
      // 因此预设切换必须重走一次材质应用，无需重启窗口。
      if (patch.material || patch.visual_preset) await applyMaterial();
    },

    syncExternal: (patch) => {
      const s = get().settings;
      if (!s) return;
      set({ settings: { ...s, ...patch } as Settings });
      if (patch.visual_preset) {
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
