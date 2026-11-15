//! 工作台自绘标题栏的「明暗主题」菜单（2026-11-15）。
//!
//! 背景：workspace 窗口 `decorations(false)`，顶栏就是它的标题栏。此前顶栏只有
//! 品牌 / 工作空间 / 搜索 / 创建 / 右栏与窗口按钮，切明暗必须绕到
//! 「设置 → 外观与主题」；主窗口标题栏却有一键入口。这里把**同一套**
//! 浅色 / 深色 / 跟随系统菜单下沉到工作台顶栏，图标跟随当前设置。
//!
//! 不造第二套主题管道：写库仍走 `useSettingsStore.update`（Rust 侧更新成功后
//! 广播 `theme-changed`，主窗口、右键菜单与胶囊同步应用）；写入失败不静默，
//! 用工作台自己的 Toast 报出真实原因。

import { Monitor, Moon, Sun } from "lucide-react";
import { DropdownMenu, type DropdownMenuItem } from "../components/ui";
import { useLocale } from "../hooks/useLocale";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";
import { errorMessage } from "../lib/errors";

/** 与主窗口标题栏、右键菜单同一组取值与顺序（`id` 即 `settings.theme`）。 */
const THEMES = [
  { id: "light", icon: Sun, labelKey: "settings.appearance.theme.light" },
  { id: "dark", icon: Moon, labelKey: "settings.appearance.theme.dark" },
  { id: "system", icon: Monitor, labelKey: "settings.appearance.theme.system" },
] as const;

export default function WorkbenchThemeMenu() {
  const { t } = useLocale();
  const theme = useSettingsStore((s) => s.settings?.theme ?? "system");
  const update = useSettingsStore((s) => s.update);

  // 损坏 / 未知取值不能让菜单显示「无选中项」：落回跟随系统（与主窗口同一兜底）。
  const current = THEMES.find((item) => item.id === theme) ?? THEMES[2];
  const CurrentIcon = current.icon;
  const label = t("workbench.themeMenu", { theme: t(current.labelKey) });

  const items: DropdownMenuItem[] = THEMES.map((item) => ({
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

  return (
    <DropdownMenu
      items={items}
      menuLabel={t("settings.appearance.color")}
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
          <CurrentIcon size={15} aria-hidden="true" />
        </button>
      )}
    />
  );
}
