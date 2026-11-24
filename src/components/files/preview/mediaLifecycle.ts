//! 媒体元素生命周期：停止播放与丢弃已缓冲资源。
//!
//! 职责边界：
//! - **媒体元素**：`pause()` 停止输出，清空 `src` 并 `load()` 让浏览器终止后续 Range 请求；
//! - **token tracker**：释放 Rust 端访问凭证（`fs_release_preview_url`）。
//! 两者都必须做：仅卸载 DOM 或仅释放 token 都不能保证后台没有仍在播放的音频/视频。

import { useEffect, type RefObject } from "react";

/**
 * 停止一个媒体元素并丢弃其资源。
 *
 * jsdom 与部分测试环境没有实现 `pause` / `load`，这里吞掉环境异常；
 * 真正的播放错误由媒体组件自己的 `onError` 处理，不在清理路径里重复报错。
 */
export function stopMediaElement(el: HTMLMediaElement | null | undefined): void {
  if (!el) return;
  try {
    el.pause();
  } catch {
    /* 环境未实现 */
  }
  const hadSource = el.hasAttribute("src") || Boolean(el.currentSrc);
  try {
    el.removeAttribute("src");
  } catch {
    /* 环境未实现 */
  }
  if (hadSource) {
    try {
      el.load();
    } catch {
      /* 环境未实现 */
    }
  }
}

/**
 * 组件卸载时停止其挂载的媒体元素。
 *
 * 在 effect 建立时**捕获当时的元素**，而不是卸载时再读 ref：
 * 媒体 URL 变化时元素会被替换，晚读 ref 会拿到新元素而漏掉旧元素。
 *
 * StrictMode 会「挂载 → 立刻销毁 → 再挂载」同一元素；若在销毁回调里立即清源，
 * 第二次挂载的 DOM 节点会变成没有 `src` 的空元素。因此把停止动作推迟到微任务，
 * 只在元素确实已离开文档（真实卸载或 URL 切换）时执行。
 */
export function useStopMediaOnUnmount(ref: RefObject<HTMLMediaElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    return () => {
      queueMicrotask(() => {
        if (el && !el.isConnected) stopMediaElement(el);
      });
    };
  }, [ref]);
}
