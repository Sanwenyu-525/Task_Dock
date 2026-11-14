//! 暂存架「粘贴当前剪贴板」的键盘守卫。
//!
//! 只回答一件事：这次 Ctrl+V 应该由暂存架消费，还是留给当前可编辑控件/弹层。
//! 不读取剪贴板、不触发命令，因此可以在任意 UI 测试里直接构造事件验证。
//!
//! 规则：
//! - 仅 Ctrl+V；Ctrl+Shift+V（纯文本粘贴）、Ctrl+Alt+V、Ctrl+Win+V 一律放行；
//! - 输入法组合中、`defaultPrevented`、长按 repeat 不消费；
//! - INPUT / TEXTAREA / SELECT / contenteditable 内不消费；
//! - 有菜单/对话框/模态等弹层时不消费（胶囊自身用于 Esc 的 drawer 层不算）。
//!
//! `blocksAutoHide === false` 是胶囊面板自己注册的 Escape 层，它不代表用户
//! 正在弹层里交互；把它当成「有弹层」会让胶囊里的 Ctrl+V 永远失效。

import { topOverlay } from "./overlayStack";

/** 当前焦点控件是否允许系统粘贴语义。 */
export function isEditablePasteTarget(target: EventTarget | null): boolean {
  const el =
    target instanceof Element
      ? target
      : typeof document !== "undefined"
        ? document.activeElement
        : null;
  if (!(el instanceof Element)) return false;
  const editable = el.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  );
  if (editable) return true;
  // 某些富文本编辑器把 contenteditable 放在祖先上而不是当前节点。
  return Boolean(el instanceof HTMLElement && el.isContentEditable);
}

/** 是否有会阻止暂存架粘贴的弹层。 */
export function hasBlockingPasteOverlay(): boolean {
  const top = topOverlay();
  return Boolean(top && top.blocksAutoHide !== false);
}

/**
 * 判断一次 keydown 是否应被暂存架消费。
 *
 * `busy` 由调用方传入：读取/保存未完成时不再接受第二次触发；
 * 这里不判断窗口是否可见，可见性由组件挂载/`active` 决定。
 */
export function shouldHandleShelfPaste(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "ctrlKey"
    | "shiftKey"
    | "altKey"
    | "metaKey"
    | "repeat"
    | "isComposing"
    | "keyCode"
    | "defaultPrevented"
    | "target"
  >,
  options: { busy?: boolean } = {},
): boolean {
  if (options.busy) return false;
  if (event.defaultPrevented) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.repeat) return false;
  if (event.key.toLowerCase() !== "v") return false;
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false;
  if (hasBlockingPasteOverlay()) return false;
  if (isEditablePasteTarget(event.target)) return false;
  return true;
}
