//! 工作台自绘标题栏的「视觉主题」菜单（2026-11-15）。
//!
//! 与明暗（`WorkbenchThemeMenu`）正交：明暗改 `theme`，这里改 `visual_preset`
//! （柔光玻璃 / 梦幻渐变）。写库仍走 `useSettingsStore.update`，Rust 成功后广播
//! `visual-preset-changed`：主窗口、右键菜单等同步应用；工作台自身的圆角变化由
//! `windowFrame` 观察 `data-preset` 后重算并下发 Win32 区域（`--radius-window`
//! 随预设不同），不新增第二套预设管道。

import { Palette } from "lucide-react";
import { DropdownMenu, type DropdownMenuItem } from "../components/ui";
import { useLocale } from "../hooks/useLocale";
import { PRESET_LABELS, VISUAL_PRESETS, resolveVisualPreset } from "../lib/theme";
import { errorMessage } from "../lib/errors";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";

export default function WorkbenchPresetMenu() {
  const { t } = useLocale();
  const preset = resolveVisualPreset(useSettingsStore((s) => s.settings?.visual_preset));
  const update = useSettingsStore((s) => s.update);

  const label = t("workbench.presetMenu", { preset: PRESET_LABELS[preset].name });

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

  return (
    <DropdownMenu
      items={items}
      menuLabel={t("settings.appearance.preset")}
      placement="bottom-end"
      trigger={({ ref, expanded, onClick, onKeyDown }) => (
        <button
          ref={ref}
          type="button"
          className="wb-icon-btn"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={expanded}
          data-tip={label}
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          <Palette size={15} aria-hidden="true" />
        </button>
      )}
    />
  );
}
