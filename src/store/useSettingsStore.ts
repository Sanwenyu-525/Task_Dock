//! 设置 Store：主题（light/dark/system）× 材质（solid/glass）统一应用管道。
//!
//! 所有入口（设置页、标题栏菜单、托盘菜单、系统主题变化）都收敛到
//! applyThemeToDom / applyMaterial，保证任意路径切换立即生效、无需重启。
//! 毛玻璃仅在原生 Mica/Acrylic 真正应用成功且系统无高对比度/减少透明时启用，
//! 否则自动回退 solid，并在 materialInfo 中记录降级原因（供设置页展示）。

import { create } from "zustand";
import { applyWindowMaterial, getSettings, updateSettings, type Settings } from "../lib/bridge";
import { readSystemFlags, resolveMaterial, resolveTheme, type MaterialSetting } from "../lib/theme";

export interface MaterialInfo {
  requested: MaterialSetting;
  resolved: MaterialSetting;
  applied: boolean;
  effect: string;
  osVersion: string;
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

export const useSettingsStore = create<{
  settings: Settings | null;
  /** 材质实际状态（含降级信息） */
  materialInfo: MaterialInfo | null;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  /** 托盘/事件路径：后端已持久化，前端只同步并应用 */
  syncExternal: (patch: { theme?: string; mode?: string }) => void;
  /** 系统主题/对比度/透明偏好变化时重算 DOM（不写后端） */
  reapplyFromSystem: () => void;
}>((set, get) => {
  function applyThemeToDom() {
    const flags = readSystemFlags(match, null);
    document.documentElement.dataset.theme = resolveTheme(currentTheme(), flags);
  }

  async function applyMaterial(probeNative: boolean): Promise<void> {
    const requested = currentMaterial();
    let applied = requested === "glass";
    let effect = "none";
    let osVersion = "";

    if (requested === "glass" && probeNative) {
      // glass 需要真实探测（Rust 端幂等，重复调用安全）
      try {
        const r = await applyWindowMaterial(requested);
        applied = r.applied;
        effect = r.effect;
        osVersion = r.os_version;
      } catch {
        applied = false;
      }
    }

    const flags = readSystemFlags(match, requested === "glass" ? (probeNative ? applied : null) : null);
    const resolved = resolveMaterial(requested, flags);

    if (resolved === "solid") {
      // 显式 solid 或回退：确保原生效果已清除（幂等）
      try {
        await applyWindowMaterial("solid");
      } catch {
        // 清除失败不影响 CSS 侧（不透明表面已完全遮挡）
      }
    }

    document.documentElement.dataset.material = resolved;
    set({
      materialInfo: {
        requested,
        resolved,
        applied: requested === "glass" && resolved === "glass",
        effect: requested === "glass" ? effect : "none",
        osVersion,
      },
    });
  }

  return {
    settings: null,
    materialInfo: null,

    load: async () => {
      const s = await getSettings();
      set({ settings: s });
      applyThemeToDom();
      await applyMaterial(true);
    },

    update: async (patch) => {
      const s = await updateSettings(patch);
      set({ settings: s });
      if (patch.theme) applyThemeToDom();
      if (patch.material) await applyMaterial(true);
    },

    syncExternal: (patch) => {
      const s = get().settings;
      if (!s) return;
      set({ settings: { ...s, ...patch } as Settings });
      if (patch.theme) applyThemeToDom();
    },

    reapplyFromSystem: () => {
      applyThemeToDom();
      void applyMaterial(false);
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
}
