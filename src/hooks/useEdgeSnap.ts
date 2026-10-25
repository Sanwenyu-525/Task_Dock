//! 贴边吸附与自动隐藏。
//!
//! 行为（参考 followG/todo-tauri 的 MIT 实现思路，按本项目架构重写）：
//! - 拖动到距屏幕边缘 SNAP_DIST 内、且光标离开窗口后，窗口滑出屏幕仅留 STRIP 像素；
//! - 隐藏状态下，光标再次靠近该边缘即滑入；
//! - 光标离开窗口 + MARGIN 后再次滑出（若仍贴边）；
//! - 位置/吸附状态持久化，重启后恢复。

import { useEffect, useRef } from "react";
import { getCurrentWindow, cursorPosition, currentMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getSnapState, saveSnapState, saveWindowRect } from "../lib/bridge";

const SNAP_DIST = 28; // 触发吸附的距离（物理像素）
const STRIP = 6; // 隐藏时留在屏幕内的像素
const MARGIN = 40; // 光标离开窗口的判定边距
const POLL_MS = 220;

type Edge = "left" | "right" | "top" | "bottom" | "none";

function inRect(p: { x: number; y: number }, x: number, y: number, w: number, h: number, m = 0): boolean {
  return p.x >= x - m && p.x <= x + w + m && p.y >= y - m && p.y <= y + h + m;
}

export function useEdgeSnap(enabled: boolean) {
  const stateRef = useRef({ hidden: false, edge: "none" as Edge, restore: null as { x: number; y: number } | null });

  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let cancelled = false;

    async function nearEdge(): Promise<Edge> {
      const [pos, size, monitor] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        currentMonitor(),
      ]);
      if (!monitor) return "none";
      const wa = monitor.workArea;
      const w = size.width;
      const h = size.height;
      if (pos.x - wa.position.x <= SNAP_DIST) return "left";
      if (wa.position.x + wa.size.width - (pos.x + w) <= SNAP_DIST) return "right";
      if (pos.y - wa.position.y <= SNAP_DIST) return "top";
      if (wa.position.y + wa.size.height - (pos.y + h) <= SNAP_DIST) return "bottom";
      return "none";
    }

    async function applyHidden(edge: Edge) {
      const [pos, size, monitor] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        currentMonitor(),
      ]);
      if (!monitor) return;
      const wa = monitor.workArea;
      const w = size.width;
      const h = size.height;
      stateRef.current.restore = { x: pos.x, y: pos.y };
      stateRef.current.edge = edge;
      stateRef.current.hidden = true;
      let nx = pos.x;
      let ny = pos.y;
      if (edge === "left") nx = wa.position.x - w + STRIP;
      if (edge === "right") nx = wa.position.x + wa.size.width - STRIP;
      if (edge === "top") ny = wa.position.y - h + STRIP;
      if (edge === "bottom") ny = wa.position.y + wa.size.height - STRIP;
      await win.setPosition(new PhysicalPosition(nx, ny));
      await saveSnapState(edge, true);
    }

    async function applyShow() {
      const r = stateRef.current.restore;
      if (!r) return;
      stateRef.current.hidden = false;
      await win.setPosition(new PhysicalPosition(r.x, r.y));
      await saveSnapState("none", false);
    }

    async function tick() {
      if (cancelled) return;
      try {
        const st = stateRef.current;
        const cursor = await cursorPosition();
        const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
        const overWindow = inRect(cursor, pos.x, pos.y, size.width, size.height, 8);

        if (!st.hidden) {
          const edge = await nearEdge();
          if (edge !== "none" && !overWindow) {
            await applyHidden(edge);
          } else if (edge === "none") {
            st.edge = "none";
          }
          return;
        }

        // 隐藏中：光标靠近吸附边缘 → 滑入
        const monitor = await currentMonitor();
        if (!monitor) return;
        const wa = monitor.workArea;
        const near =
          (st.edge === "left" && cursor.x - wa.position.x <= 16) ||
          (st.edge === "right" && wa.position.x + wa.size.width - cursor.x <= 16) ||
          (st.edge === "top" && cursor.y - wa.position.y <= 16) ||
          (st.edge === "bottom" && wa.position.y + wa.size.height - cursor.y <= 16);
        if (near) {
          await applyShow();
          return;
        }
        // 滑入后光标离开 → 再次滑出
        const stillNear = await nearEdge();
        if (stillNear === st.edge && !inRect(cursor, pos.x, pos.y, size.width, size.height, MARGIN)) {
          await applyHidden(st.edge);
        }
      } catch {
        // 忽略单次轮询失败
      }
    }

    // 恢复上次的隐藏状态
    (async () => {
      const saved = await getSnapState();
      if (!cancelled && saved?.hidden && saved.edge && saved.edge !== "none") {
        stateRef.current.edge = saved.edge as Edge;
        await applyHidden(saved.edge as Edge);
      }
    })();

    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);
}

/** 窗口位置/大小持久化（防抖）。 */
export function useWindowPersistence() {
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    const save = async () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
          await saveWindowRect({ x: pos.x, y: pos.y, w: size.width, h: size.height });
        } catch {
          // 忽略
        }
      }, 600);
    };
    const unlisten: (() => void)[] = [];
    win.onMoved(save).then((u) => unlisten.push(u));
    win.onResized(save).then((u) => unlisten.push(u));
    return () => {
      window.clearTimeout(timer);
      unlisten.forEach((u) => u());
    };
  }, []);
}
