//! 弹层基础设施：注册到全局 Escape 栈 + 焦点陷阱 + 焦点恢复。

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { registerOverlay, type OverlayEntry, type OverlayKind } from "../../lib/overlayStack";

/**
 * 把当前组件注册为弹层栈的一层。
 *
 * Escape 只会命中栈顶（最高优先级、同类中最内层的那层），因此嵌套弹层天然按
 * 确认框 → 子弹层 → 菜单 → 抽屉 的顺序逐层关闭。
 *
 * rootRef 可选：提供后按 DOM 嵌套深度判断「谁更内层」。React 的 effect 是子先于父
 * 执行的，只看注册顺序会让外层反超内层。
 */
export function useOverlayLayer(
  kind: OverlayKind,
  active: boolean,
  onEscape: () => void,
  rootRef?: RefObject<HTMLElement | null>,
) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const entry: OverlayEntry = {
      kind,
      onEscape: () => cb.current(),
      get root() {
        return rootRef?.current ?? null;
      },
    };
    return registerOverlay(entry);
  }, [active, kind, rootRef]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * 把 Tab 焦点圈在 root 内。返回卸载函数。
 * 打开时聚焦 initial（缺省第一个可聚焦元素），关闭时把焦点还给 restoreTo。
 */
export function useFocusTrap(
  active: boolean,
  root: RefObject<HTMLElement | null>,
  opts?: { initial?: RefObject<HTMLElement | null>; restoreTo?: RefObject<HTMLElement | null> },
) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const el = opts?.initial?.current ?? root.current;
    // rAF：等弹层内容完成布局后再移动焦点，避免落在未渲染的节点上
    const raf = requestAnimationFrame(() => {
      if (!root.current) return;
      const target = opts?.initial?.current ?? root.current.querySelector<HTMLElement>("[data-autofocus]") ?? el;
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const back = opts?.restoreTo?.current ?? restoreRef.current;
      if (back?.isConnected) back.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const rootEl = root.current;
      if (!rootEl) return;
      const items = focusableWithin(rootEl);
      if (items.length === 0) {
        e.preventDefault();
        rootEl.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active2 = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active2 === first || !active2 || !rootEl.contains(active2)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active2 === last || !active2 || !rootEl.contains(active2)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, root]);
}

/** 打开时记住当前焦点，关闭时归还（用于菜单/弹层这类非模态层）。 */
export function useFocusRestore(active: boolean) {
  const restoreRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const target = restoreRef.current;
      restoreRef.current = null;
      if (target?.isConnected) target.focus();
    };
  }, [active]);
}

/** 滚动容器内把子元素滚到可见位置（jsdom 下无副作用）。 */
export function scrollIntoViewIfNeeded(container: HTMLElement | null, item: HTMLElement | null | undefined) {
  if (!container || !item) return;
  const cTop = container.scrollTop;
  const cBottom = cTop + container.clientHeight;
  const iTop = item.offsetTop;
  const iBottom = iTop + item.offsetHeight;
  if (iTop < cTop) container.scrollTop = iTop;
  else if (iBottom > cBottom) container.scrollTop = Math.max(0, iBottom - container.clientHeight);
}
