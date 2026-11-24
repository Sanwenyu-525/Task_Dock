//! 暂存条目右键菜单（轻量，不使用原生菜单）。
//!
//! 与 DropdownMenu 的分工：卡片「⋯」仍用通用菜单；右键菜单需要按当前多选集合
//! 执行批量动作，且落点是指针位置而不是锚点按钮。
//!
//! 定位、Portal、弹层栈、外部点击与焦点陷阱统一由 `PointerMenu` 提供：
//! 默认从指针右下展开，右/下空间不足向左/上翻转，菜单不会越出窗口。
//! 本文件只保留「暂存区特有的视觉与批量动作」。

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import PointerMenu from "../ui/PointerMenu";

export interface ShelfContextAction {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /**
   * 单选状态（暂存架「添加方式」）：传 undefined 表示普通动作；传 true/false
   * 表示单选组的一项，图标位改成勾选位（未选中的项保留占位以对齐）。
   *
   * 注意：这里仍然渲染 `role="menuitem"` 而不是 `menuitemradio`。PointerMenu
   * 的方向键导航按 `button[role="menuitem"]` 选取候选，改 role 会让单选项被跳过。
   */
  checked?: boolean;
  onSelect: () => void;
}

export default function ShelfContextMenu({
  open,
  x,
  y,
  label,
  items,
  onClose,
}: {
  open: boolean;
  x: number;
  y: number;
  label: string;
  items: ShelfContextAction[];
  onClose: () => void;
}) {
  const firstEnabled = items.findIndex((item) => !item.disabled);

  return (
    <PointerMenu
      open={open}
      x={x}
      y={y}
      label={label}
      onClose={onClose}
      className="shelf-context-menu"
      minWidth={184}
      maxWidth={260}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={`shelf-context-item${item.danger ? " is-danger" : ""}`}
          disabled={item.disabled}
          {...(index === firstEnabled ? { "data-autofocus": true } : {})}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.checked !== undefined || item.icon ? (
            <span
              className={`shelf-context-icon${item.checked !== undefined ? " is-radio" : ""}`}
              aria-hidden="true"
            >
              {item.checked === undefined ? (
                item.icon
              ) : item.checked ? (
                <Check size={13} strokeWidth={2.5} />
              ) : null}
            </span>
          ) : null}
          <span className="shelf-context-label">{item.label}</span>
        </button>
      ))}
    </PointerMenu>
  );
}
