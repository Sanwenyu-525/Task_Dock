//! 设置 Store：视觉预设 × 明暗 × 材质 的统一应用管道（v0.6）。
//!
//! 所有入口（设置页、标题栏菜单、托盘菜单、系统偏好变化）都收敛到这里，
//! 保证任意路径切换立即生效、无需重启：
//!
//!   settings（持久化偏好）
//!     ├─ theme          → html[data-theme]            （light | dark）
//!     ├─ visual_preset  → html[data-preset]           （dream-gradient | liquid-glass）
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
import {
  hasNativeGlass,
  presetRadius,
  readSystemFlags,
  resolveMaterial,
  resolveTheme,
  resolveVisualPreset,
  type MaterialSetting,
  type VisualPreset,
} from "../lib/theme";

export interface MaterialInfo {
  requested: MaterialSetting;
  resolved: MaterialSetting;
  applied: boolean;
  /** 原生效果名：mica / acrylic / none */
  effect: string;
  osVersion: string;
  /** Win32 圆角区域是否应用成功（false 时四角可能露原生直角） */
  shapeApplied: boolean;
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
  syncExternal: (patch: { theme?: string; mode?: string; visual_preset?: string }) => void;
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

  async function applyMaterial(): Promise<void> {
    const requested = currentMaterial();
    let nativeApplied: boolean | null;
    let effect = "none";
    let osVersion = "";

    // 每次都真探测：请求 glass 时应用 Mica/Acrylic，请求 solid 时清除。
    // Rust 端幂等；系统偏好变化是低频操作，这点 IPC 成本换来状态绝对一致。
    if (requested === "glass") {
      try {
        const r = await applyWindowMaterial("glass");
        nativeApplied = r.applied;
        effect = r.effect;
        osVersion = r.os_version;
      } catch {
        nativeApplied = false;
      }
    } else {
      try {
        await applyWindowMaterial("solid");
      } catch {
        // 清除失败不影响 CSS 侧（不透明表面已完全遮挡）
      }
      nativeApplied = null;
    }

    const flags = readSystemFlags(match, nativeApplied);
    const resolved = resolveMaterial(requested, flags);

    // 降级原因：高对比度 / 减少透明 / 原生不支持，三种都要清除原生效果
    if (requested === "glass" && resolved === "solid") {
      try {
        await applyWindowMaterial("solid");
      } catch {
        // 同上
      }
    }

    const root = document.documentElement;
    root.dataset.material = resolved;
    root.dataset.nativeGlass = hasNativeGlass(resolved, nativeApplied) ? "true" : "false";

    const shapeApplied = get().materialInfo?.shapeApplied ?? false;
    set({
      materialInfo: {
        requested,
        resolved,
        applied: hasNativeGlass(resolved, nativeApplied),
        effect: requested === "glass" ? effect : "none",
        osVersion,
        shapeApplied,
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
      if (patch.visual_preset) applyPresetToDom();
      if (patch.theme) applyThemeToDom();
      if (patch.material) await applyMaterial();
    },

    syncExternal: (patch) => {
      const s = get().settings;
      if (!s) return;
      set({ settings: { ...s, ...patch } as Settings });
      if (patch.visual_preset) applyPresetToDom();
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
