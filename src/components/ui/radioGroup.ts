//! 单选组键盘契约（WAI-ARIA radiogroup）：
//! 组内只有一个 Tab 停靠点（roving tabindex），方向键在可选项之间移动焦点并选中，
//! Home/End 跳到首/末项。容器结构由调用方决定（列表行、卡片、按钮均可），
//! 这里只提供 ref + onKeyDown 与 tabIndex 计算，不另造一套视觉。

import { useCallback, useRef } from "react";

const NAV_KEYS = [
  "ArrowDown",
  "ArrowRight",
  "ArrowUp",
  "ArrowLeft",
  "Home",
  "End",
] as const;

/**
 * 计算组内单个 radio 的 tabIndex。
 * - 已选中项：0（组内唯一停靠点）
 * - 组内没有任何选中项时：第 0 项作为入口
 * - 其余：-1
 */
export function radioTabIndex(selected: boolean, hasSelection: boolean, index: number): number {
  if (selected) return 0;
  if (!hasSelection && index === 0) return 0;
  return -1;
}

export interface RovingRadioGroup<T extends HTMLElement = HTMLDivElement> {
  ref: React.RefObject<T | null>;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export function useRovingRadioGroup<T extends HTMLElement = HTMLDivElement>(
  externalRef?: React.RefObject<T | null>,
): RovingRadioGroup<T> {
  const ownRef = useRef<T>(null);
  const ref = externalRef ?? ownRef;

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!(NAV_KEYS as readonly string[]).includes(event.key)) return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;

    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = current < 0 ? 0 : current;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = current < 0 ? 0 : (current + 1) % items.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = current <= 0 ? items.length - 1 : current - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }

    event.preventDefault();
    const target = items[next];
    target?.focus();
    // 单选组语义：方向键同时移动焦点与选中态（与原生 radio 一致）。
    target?.click();
  }, []);

  return { ref, onKeyDown };
}
