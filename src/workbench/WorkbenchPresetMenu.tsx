//! 工作台自绘标题栏的「视觉主题」菜单（2026-11-15）。
//!
//! 与明暗（`WorkbenchThemeMenu`）正交：明暗改 `theme`，这里改 `visual_preset`
//! （柔光玻璃 / 梦幻渐变）。写库仍走 `useSettingsStore.update`，Rust 成功后广播
//! `visual-preset-changed`：主窗口、右键菜单等同步应用；工作台自身的圆角变化由
//! `windowFrame` 观察 `data-preset` 后重算并下发 Win32 区域（`--radius-window`
//! 随预设不同），不新增第二套预设管道。菜单项在 `workbenchTitlebarItems.tsx`
//! 与「更多」收纳菜单共用（2026-11-16）。

import { DropdownMenu } from "../components/ui";
import { useLocale } from "../hooks/useLocale";
import { PRESET_ICON, usePresetMenuItems } from "./workbenchTitlebarItems";

export default function WorkbenchPresetMenu() {
  const { t } = useLocale();
  const { items, currentName } = usePresetMenuItems();
  const label = t("workbench.presetMenu", { preset: currentName });

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
          <PRESET_ICON size={15} aria-hidden="true" />
        </button>
      )}
    />
  );
}
