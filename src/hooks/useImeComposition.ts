//! IME（输入法）组合态守卫。
//!
//! 不同平台的 compositionend 与确认按键 keydown 顺序不一致：
//! - Chromium / Firefox（Windows）：确认候选的 Enter keydown 先于 compositionend，`isComposing=true`；
//! - Safari / 旧版 WebKit：compositionend 可能先于 keydown，keydown 的 `isComposing=false`，
//!   但 keyCode 为 229。
//!
//! 因此不能只靠 `isComposing` 一个属性：组合期间由 compositionstart/end 维护内部标记，
//! 判定时同时接受组件标记、`nativeEvent.isComposing` 与 `keyCode === 229`。
//! 不使用 setTimeout 延迟业务动作，也不注册全局键盘监听。

import { useCallback, useRef, type CompositionEvent, type KeyboardEvent } from "react";

export interface ImeCompositionGuard {
  onCompositionStart: (event: CompositionEvent<Element>) => void;
  onCompositionEnd: (event: CompositionEvent<Element>) => void;
  /** 当前按键是否属于输入法候选操作（Enter/Escape 等不应触发业务动作） */
  isComposing: (event: KeyboardEvent<Element>) => boolean;
  /** 当前是否仍处于组合态：供没有 KeyboardEvent 的异步回调判断（如提交响应清空输入前） */
  isComposingNow: () => boolean;
}

export default function useImeComposition(): ImeCompositionGuard {
  const composingRef = useRef(false);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  const isComposing = useCallback((event: KeyboardEvent<Element>) => {
    return composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
  }, []);

  // 异步回调里没有 KeyboardEvent 可用，直接读组件维护的组合标记。
  const isComposingNow = useCallback(() => composingRef.current, []);

  return { onCompositionStart, onCompositionEnd, isComposing, isComposingNow };
}
