//! 工作台自绘标题栏的「明暗主题」菜单（2026-11-15）。
//!
//! 背景：workspace 窗口 `decorations(false)`，顶栏就是它的标题栏。此前顶栏只有
//! 品牌 / 工作空间 / 搜索 / 创建 / 右栏与窗口按钮，切明暗必须绕到
//! 「设置 → 外观与主题」；主窗口标题栏却有一键入口。这里把**同一套**
//! 浅色 / 深色 / 跟随系统菜单下沉到工作台顶栏，图标跟随当前设置。
//!
//! 不造第二套主题管道：写库仍走 `useSettingsStore.update`（Rust 侧更新成功后
//! 广播 `theme-changed`，主窗口、右键菜单与胶囊同步应用）；写入失败不静默，
//! 用工作台自己的 Toast 报出真实原因。菜单项的构造与「更多」收纳菜单共用
//! `workbenchTitlebarItems.tsx`（2026-11-16）。

import { DropdownMenu } from "../components/ui";
import { useLocale } from "../hooks/useLocale";
import { useThemeMenuItems } from "./workbenchTitlebarItems";

export default function WorkbenchThemeMenu() {
  const { t } = useLocale();
  const { items, currentLabel, CurrentIcon } = useThemeMenuItems();
  const label = t("workbench.themeMenu", { theme: currentLabel });

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
