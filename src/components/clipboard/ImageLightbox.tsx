//! 图片大图预览层（灯箱）。
//!
//! - 等比适应窗口（不上采样小图），指针为中心的滚轮缩放、拖拽平移；
//! - 双击在适应窗口 ↔ 实际尺寸间切换；平移钳制保证图片不会完全拖出可视区；
//! - 复制原图复用 `clipboard_copy_item` 受控链路（自写登记，不回流）；
//! - 另存为走系统保存对话框（覆盖确认由对话框完成）+ `clipboard_save_image`；
//! - 注册为弹层栈 modal 层：Escape 只关灯箱，不会穿透到抽屉/主窗口。
//!
//! 性能：原图 data URL 由 Media 的共享缓存提供（去重 IPC、LRU 上限 2 条），
//! 关闭灯箱只卸载组件状态，缓存条目由 LRU 策略回收。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Copy, Download, Loader2, Minus, Plus, Scan, SquareEqual, X,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  clipboardCopyItem,
  clipboardSaveImage,
  type ClipboardItem,
} from "../../lib/bridge";
import { formatBytes, sourceLabel } from "../../lib/clipboardUi";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useUiStore } from "../../store/useUiStore";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";
import { useLargeImage } from "./Media";

/** 绝对缩放边界：下限允许缩到很小看全貌，上限 16 倍足够看清细节。 */
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
/** 适应窗口计算时四周预留的呼吸空隙（px）。 */
const STAGE_PAD = 24;
/** 单档缩放步进（工具栏按钮）。 */
const STEP = 1.25;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface View {
  /** 缩放倍率（1 = 实际尺寸） */
  s: number;
  /** 相对舞台中心的平移（transform-origin: center） */
  x: number;
  y: number;
}

/**
 * 平移钳制：图片任一维度大于可用空间时，平移限制在「边缘不超过舞台边缘」；
 * 小于可用空间时居中（拖不出空隙）。保证图片永远不会被完全拖出可视区域。
 */
function clampPan(v: View, nw: number, nh: number, availW: number, availH: number): View {
  const maxX = Math.max(0, (nw * v.s - availW) / 2);
  const maxY = Math.max(0, (nh * v.s - availH) / 2);
  return { ...v, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
}

export default function ImageLightbox({
  item,
  onClose,
}: {
  item: ClipboardItem;
  onClose: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const { state, url, error } = useLargeImage(item.id, true);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [isFit, setIsFit] = useState(true);
  const [busy, setBusy] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  useOverlayLayer("modal", true, onClose, rootRef);
  useFocusTrap(true, rootRef);

  /** 当前可用空间（舞台内容区减去呼吸空隙）。 */
  const avail = useCallback(() => {
    const el = stageRef.current;
    if (!el) return { w: 0, h: 0 };
    return {
      w: Math.max(1, el.clientWidth - STAGE_PAD * 2),
      h: Math.max(1, el.clientHeight - STAGE_PAD * 2),
    };
  }, []);

  const fitScale = useCallback(
    (nw: number, nh: number) => {
      const { w, h } = avail();
      if (nw <= 0 || nh <= 0) return 1;
      // 不上采样：小图按实际尺寸展示，大图缩到完整可见
      return Math.min(w / nw, h / nh, 1);
    },
    [avail],
  );

  /** 以舞台坐标 p 为不动点缩放到 ns。 */
  const zoomAt = useCallback(
    (px: number, py: number, ns: number, nw: number, nh: number) => {
      const { w, h } = avail();
      setView((v) => {
        const s2 = clamp(ns, MIN_SCALE, MAX_SCALE);
        const cx = px - w / 2 - STAGE_PAD;
        const cy = py - h / 2 - STAGE_PAD;
        const k = s2 / v.s;
        return clampPan({ s: s2, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }, nw, nh, w, h);
      });
      setIsFit(false);
    },
    [avail],
  );

  const fitAll = useCallback(
    (nw: number, nh: number) => {
      const s = fitScale(nw, nh);
      setView({ s, x: 0, y: 0 });
      setIsFit(true);
    },
    [fitScale],
  );

  // 图片解码完成：记录原始尺寸并进入适应窗口
  const onImgLoad = () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    setNatural(size);
    fitAll(size.w, size.h);
  };

  // 舞台尺寸变化：适应态重算适应比例；缩放态钳制平移防止图片跑丢
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !natural) return;
    const ro = new ResizeObserver(() => {
      if (isFit) {
        fitAll(natural.w, natural.h);
      } else {
        const { w, h } = avail();
        setView((v) => clampPan(v, natural.w, natural.h, w, h));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural, isFit, fitAll, avail]);

  // 滚轮缩放：React 根节点对 wheel 是 passive 监听，preventDefault 必须自己挂原生事件
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !natural) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (dy === 0) return;
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-dy * 0.0015);
      const v = viewRef.current;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, v.s * factor, natural.w, natural.h);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [natural, zoomAt]);

  // 拖拽平移：Pointer Events + capture，兼容触摸板/触摸屏
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !natural) return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const { w, h } = avail();
      setView((v) => clampPan({ ...v, x: v.x + dx, y: v.y + dy }, natural.w, natural.h, w, h));
      setIsFit(false);
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove("dragging");
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [natural, avail]);

  const zoomStep = (dir: 1 | -1) => {
    if (!natural) return;
    const el = stageRef.current;
    const rect = el?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0;
    const cy = rect ? rect.height / 2 : 0;
    zoomAt(cx, cy, view.s * (dir > 0 ? STEP : 1 / STEP), natural.w, natural.h);
  };

  const toggleActual = (px: number, py: number) => {
    if (!natural) return;
    if (isFit) {
      zoomAt(px, py, 1, natural.w, natural.h);
    } else {
      fitAll(natural.w, natural.h);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    toggleActual(e.clientX - rect.left, e.clientY - rect.top);
  };

  /** 「实际尺寸」按钮：总是切到 100%（fit↔1 的往复切换由双击承担）。 */
  const setActualCenter = () => {
    if (!natural) return;
    const el = stageRef.current;
    const rect = el?.getBoundingClientRect();
    zoomAt(rect ? rect.width / 2 : 0, rect ? rect.height / 2 : 0, 1, natural.w, natural.h);
  };

  const onCopy = async () => {
    setBusy(true);
    try {
      const r = await clipboardCopyItem(item.id);
      const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
      showToast(`已复制原图（${formatBytes(r.bytes)}）${warn}`, {
        kind: r.warnings.length > 0 ? "info" : "success",
      });
      useClipboardStore.getState().bumpItemCopy(item.id);
    } catch (e) {
      showToast(`复制失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const onSaveAs = async () => {
    setBusy(true);
    try {
      const id8 = item.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "image";
      const path = await save({
        defaultPath: `task-dock-clipboard-${id8}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) return; // 用户取消，不视为错误
      const bytes = await clipboardSaveImage(item.id, path);
      showToast(`已保存（${formatBytes(bytes)}）：${path}`, { kind: "success" });
    } catch (e) {
      showToast(`保存失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={rootRef}
      className="clip-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片大图预览"
      tabIndex={-1}
    >
      <div
        ref={stageRef}
        className="clip-lightbox-stage"
        onDoubleClick={onDoubleClick}
      >
        {state === "loading" && (
          <div className="clip-lightbox-status" role="status">
            <Loader2 size={18} className="spin" aria-hidden="true" /> 正在加载原图…
          </div>
        )}
        {state === "missing" && (
          <div className="clip-lightbox-status">图片文件缺失或已被清理，无法预览</div>
        )}
        {state === "error" && (
          <div className="clip-lightbox-status">图片读取失败：{error}</div>
        )}
        {state === "ready" && (
          <img
            ref={imgRef}
            className="clip-lightbox-img"
            src={url ?? undefined}
            alt={item.title || "剪贴板图片"}
            draggable={false}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            }}
            onLoad={onImgLoad}
          />
        )}
      </div>

      <div className="clip-lightbox-bar">
        <div className="clip-lightbox-info">
          {natural ? (
            <>
              <span>{natural.w}×{natural.h}</span>
              <span>PNG（存储格式）</span>
              <span>{formatBytes(item.byte_size)}</span>
              <span className="clip-lightbox-source" title={item.source_title || item.source_app}>
                {sourceLabel(item.source_app, item.source_title)}
              </span>
            </>
          ) : (
            <span>{state === "loading" ? "读取图片信息…" : "无图片信息"}</span>
          )}
        </div>
        <div className="clip-lightbox-tools">
          <span className="clip-lightbox-zoom" aria-live="polite">
            {Math.round(view.s * 100)}%
          </span>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="缩小"
            aria-label="缩小"
            disabled={!natural || busy}
            onClick={() => zoomStep(-1)}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="放大"
            aria-label="放大"
            disabled={!natural || busy}
            onClick={() => zoomStep(1)}
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="适应窗口"
            aria-label="适应窗口"
            disabled={!natural || busy || isFit}
            onClick={() => natural && fitAll(natural.w, natural.h)}
          >
            <Scan size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="实际尺寸"
            aria-label="实际尺寸"
            disabled={!natural || busy || (!isFit && view.s === 1)}
            onClick={setActualCenter}
          >
            <SquareEqual size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="复制原图"
            aria-label="复制原图"
            disabled={state !== "ready" || busy}
            onClick={onCopy}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="另存为"
            aria-label="另存为"
            disabled={state !== "ready" || busy}
            onClick={onSaveAs}
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="关闭"
            aria-label="关闭预览"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
