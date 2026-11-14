//! 订阅「全局收集热键 / 资源管理器发送到」的完成事件。
//!
//! 事件只带计数与稳定码，不携带正文、路径或图片；组件收到后刷新最近暂存并
//! 用既有提示体系展示结果。监听随组件卸载释放，不创建轮询。

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  SHELF_COLLECTED_EVENT,
  type ShelfCollectedEvent,
} from "../lib/bridge";
import { useShelfStore } from "../store/useShelfStore";

export function useShelfCollected(
  onResult?: (event: ShelfCollectedEvent) => void,
): void {
  const handler = useRef(onResult);
  handler.current = onResult;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      void listen<ShelfCollectedEvent>(SHELF_COLLECTED_EVENT, (event) => {
        // 后台收集可能发生在胶囊关闭期间；先强制刷新，保证下次打开不是 5s 软缓存。
        void useShelfStore.getState().loadRecent({ force: true }).catch(() => {});
        handler.current?.(event.payload);
      })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {
          // 浏览器/测试环境没有 Tauri 事件通道：静默降级，不影响页面本身。
        });
    } catch {
      // `listen` 在缺少 Tauri 内部对象时可能同步抛出；同上，不影响页面。
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
