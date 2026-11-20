//! 工作台顶栏的「更多工具」收纳菜单（2026-11-16）。
//!
//! 存在的理由：顶栏同时承载品牌、项目选择器、搜索、创建、收集/右栏开关、
//! 外观工具组与窗口按钮。窗口降到 `<900 DIP`（CSS `@media (max-width: 899px)`，
//! 对应 `WINDOW_TIERS.narrow = 900`）时，固定宽度控件会把搜索与项目选择器挤到
//! 重叠。这里把**低优先级**的外观工具（明暗 / 视觉主题 / 置顶）收进一个
//! 「更多」菜单：
//! - 功能不消失、写入管道与既有行为不变（共用 `workbenchTitlebarItems` / `useWorkbenchPin`）；
//! - 宽窗口恢复内联显示（纯 CSS 档位，不做 JS 宽度轮询）；
//! - 菜单项与内联按钮是同一份逻辑，不存在第二套 theme/preset/pin；
//! - 更低的 cramped 档（<780）与图标轨兜底带（≤560，`ULTRA_NARROW_WIDTH`）
//!   仍由本菜单作为外观工具的唯一入口，不另起第二套收纳。

import { MoreHorizontal, Pin } from "lucide-react";
import { DropdownMenu, type DropdownMenuItem } from "../components/ui";
import { useLocale } from "../hooks/useLocale";
import { useThemeMenuItems, usePresetMenuItems } from "./workbenchTitlebarItems";
import { useWorkbenchPin } from "./useWorkbenchPin";

export default function WorkbenchToolbarMore() {
  const { t } = useLocale();
  const theme = useThemeMenuItems();
  const preset = usePresetMenuItems();
  const pin = useWorkbenchPin();

  const items: DropdownMenuItem[] = [
    ...theme.items,
    { key: "sep-appearance", separator: true },
    ...preset.items,
    { key: "sep-pin", separator: true },
    {
      key: "pin",
      label: pin.label,
      // 与内联按钮同一图标语义：未置顶空心、置顶实心，不用带斜线的 PinOff。
      icon: (
        <Pin
          size={14}
          aria-hidden="true"
          fill={pin.pinned ? "currentColor" : "none"}
        />
      ),
      onSelect: () => {
        void pin.toggle();
      },
    },
  ];

  return (
    <DropdownMenu
      items={items}
      menuLabel={t("workbench.toolbarMoreAria")}
      placement="bottom-end"
      trigger={({ ref, expanded, onClick, onKeyDown }) => (
        <button
          ref={ref}
          type="button"
          className="wb-icon-btn wb-toolbar-more"
          aria-label={t("workbench.toolbarMore")}
          aria-haspopup="menu"
          aria-expanded={expanded}
          data-tip={t("workbench.toolbarMore")}
          data-tauri-drag-region="false"
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      )}
    />
  );
}
