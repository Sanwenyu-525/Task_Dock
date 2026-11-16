//! 工作台自绘标题栏「外观工具」的菜单项构造（2026-11-16）。
//!
//! 为什么单独抽出来：顶栏窄窗要把「明暗 / 视觉主题 / 置顶」收纳进一个「更多」
//! 菜单，但外观设置只能有一条写入管道。这里把菜单项（含写库、失败提示、当前值
//! 勾选）收敛成 hook，`WorkbenchThemeMenu` / `WorkbenchPresetMenu` 与
//! `WorkbenchToolbarMore` 共用同一份，避免复制第二套 theme/preset 逻辑。
//!
//! 契约不变：写库仍走 `useSettingsStore.update`，失败仍用工作台自己的 Toast
//! 报出真实原因（不静默、不吞异常）。

import { Monitor, Moon, Palette, Sun } from "lucide-react";
import type { DropdownMenuItem } from "../components/ui";
import { useLocale } from "../hooks/useLocale";
import { PRESET_LABELS, VISUAL_PRESETS, resolveVisualPreset } from "../lib/theme";
import { errorMessage } from "../lib/errors";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";

/** 与主窗口标题栏、右键菜单同一组取值与顺序（`id` 即 `settings.theme`）。 */
export const THEME_OPTIONS = [
  { id: "light", icon: Sun, labelKey: "settings.appearance.theme.light" },
  { id: "dark", icon: Moon, labelKey: "settings.appearance.theme.dark" },
  { id: "system", icon: Monitor, labelKey: "settings.appearance.theme.system" },
] as const;

export function useThemeMenuItems(): {
  items: DropdownMenuItem[];
  currentId: string;
  currentLabel: string;
  CurrentIcon: typeof Sun;
} {
  const { t } = useLocale();
  const theme = useSettingsStore((s) => s.settings?.theme ?? "system");
  const update = useSettingsStore((s) => s.update);

  // 损坏 / 未知取值不能让菜单显示「无选中项」：落回跟随系统（与主窗口同一兜底）。
  const current = THEME_OPTIONS.find((item) => item.id === theme) ?? THEME_OPTIONS[2];

  const items: DropdownMenuItem[] = THEME_OPTIONS.map((item) => ({
    key: item.id,
    label: t(item.labelKey),
    icon: <item.icon size={14} aria-hidden="true" />,
    radio: true,
    checked: current.id === item.id,
    onSelect: () => {
      void update({ theme: item.id }).catch((error: unknown) => {
        useUiStore
          .getState()
          .showToast(t("workbench.themeFailed", { error: errorMessage(error) }), {
            kind: "error",
            code: "workbench.themeFailed",
          });
      });
    },
  }));

  return {
    items,
    currentId: current.id,
    currentLabel: t(current.labelKey),
    CurrentIcon: current.icon,
  };
}

export function usePresetMenuItems(): {
  items: DropdownMenuItem[];
  currentId: string;
  currentName: string;
} {
  const { t } = useLocale();
  const preset = resolveVisualPreset(useSettingsStore((s) => s.settings?.visual_preset));
  const update = useSettingsStore((s) => s.update);

  // 与主窗口标题栏同一组选项、同一文案与色卡（`preset-swatch swatch-*`），
  // 顺序即设置页顺序；checked 只认当前值，未知值已由 resolveVisualPreset 兜底。
  const items: DropdownMenuItem[] = VISUAL_PRESETS.map((id) => ({
    key: id,
    label: PRESET_LABELS[id].name,
    description: PRESET_LABELS[id].tagline,
    icon: <span className={`preset-swatch swatch-${id}`} aria-hidden="true" />,
    radio: true,
    checked: preset === id,
    onSelect: () => {
      void update({ visual_preset: id }).catch((error: unknown) => {
        useUiStore
          .getState()
          .showToast(t("workbench.presetFailed", { error: errorMessage(error) }), {
            kind: "error",
            code: "workbench.presetFailed",
          });
      });
    },
  }));

  return {
    items,
    currentId: preset,
    currentName: PRESET_LABELS[preset].name,
  };
}

/** 视觉主题的表意图标（与 `WorkbenchPresetMenu` 触发器一致）。 */
export const PRESET_ICON = Palette;
