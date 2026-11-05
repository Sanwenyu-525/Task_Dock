//! 暂存架图片大图预览层（灯箱）。
//!
//! 交互对齐剪贴板 ImageLightbox（滚轮缩放 / Escape / 遮罩关闭 / modalTop 层），
//! 但数据走 shelfReadImage（独立于剪贴板 Media 缓存，不侵入剪贴板模块）。

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Minus, Plus, Scan, X } from "lucide-react";
import { shelfReadImage, type ShelfItem } from "../../lib/bridge";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const STEP = 1.25;
const STAGE_PAD = 24;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface View {
  s: number;
  x: number;
  y: number;
}

function clampPan(v: View, nw: number, nh: number, availW: number, availH: number): View {
  const maxX = Math.max(0, (nw * v.s - availW) / 2);
  const maxY = Math.max(0, (nh * v.s - availH) / 2);
  return { ...v, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
}

export default function ShelfImageLightbox({
  item,
  onClose,
}: {
  item: ShelfItem;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  useOverlayLayer("modalTop", true, onClose, rootRef);
  useFocusTrap(true, rootRef);

  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  /** 平移手势进行中：只影响光标（grabbing），不参与平移计算。 */
  const [panning, setPanning] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const movedRef = useRef(false);
  const downPointRef = useRef<{ x: number; y: number } | null>(null);
  const pressTargetRef = useRef<EventTarget | null>(null);

  useEffect(() => {
    let alive = true;
    setState("loading");
    shelfReadImage(item.id, true)
      .then((u) => {
        if (!alive) return;
        if (u) {
          setUrl(u);
          setState("ok");
        } else {
          setState("error");
        }
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [item.id]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const img = stage?.querySelector("img");
    if (!stage || !img || !natural) return;
    const availW = stage.clientWidth - STAGE_PAD * 2;
    const availH = stage.clientHeight - STAGE_PAD * 2;
    const s = Math.min(availW / natural.w, availH / natural.h, 1);
    setView({ s: Math.max(s, MIN_SCALE), x: 0, y: 0 });
  }, [natural]);

  useEffect(() => {
    if (state === "ok" && natural) fit();
  }, [state, natural, fit]);

  // 平移期间的光标会话：舞台内松手由自身 pointerup 收尾，指针在窗口外松开
  // 或窗口失焦/隐藏时由这里的全局监听兜底；平移结束即摘掉全部监听。
  useEffect(() => {
    if (!panning) return;
    const end = () => setPanning(false);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", end);
    return () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", end);
    };
  }, [panning]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? STEP : 1 / STEP;
    const ns = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
    if (ns === v.s) return;
    const rect = stage.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const k = ns / v.s;
    let next: View = {
      s: ns,
      x: cx - (cx - v.x) * k,
      y: cy - (cy - v.y) * k,
    };
    next = clampPan(next, natural.w, natural.h, stage.clientWidth, stage.clientHeight);
    setView(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    pressTargetRef.current = e.target;
    movedRef.current = false;
    if (e.button !== 0) return;
    setPanning(true);
    downPointRef.current = { x: e.clientX, y: e.clientY };
    // 图片在舞台内：按下图片同样要捕获指针，否则放大后图片铺满视口时无法平移。
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons !== 1 || !natural) return;
    // 4px 以内视为点击抖动，不记为拖拽，避免点图片关闭被误吞（对齐剪贴板灯箱）
    const down = downPointRef.current;
    if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) {
      movedRef.current = true;
    }
    const stage = stageRef.current;
    if (!stage) return;
    setView((v) => {
      const next = { ...v, x: v.x + e.movementX, y: v.y + e.movementY };
      return clampPan(next, natural.w, natural.h, stage.clientWidth, stage.clientHeight);
    });
  };

  const onStageClick = (e: React.MouseEvent) => {
    // 拖拽平移后的补发 click 不算「点遮罩」；落点判定以 pointerdown 为准
    if (movedRef.current) return;
    if (e.target === pressTargetRef.current || e.target === stageRef.current) {
      onClose();
    }
  };

  const stepZoom = (dir: 1 | -1) => {
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const v = viewRef.current;
    const ns = clamp(v.s * (dir > 0 ? STEP : 1 / STEP), MIN_SCALE, MAX_SCALE);
    setView(clampPan({ ...v, s: ns }, natural.w, natural.h, stage.clientWidth, stage.clientHeight));
  };

  return createPortal(
    <div
      ref={rootRef}
      className="shelf-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览：${item.display_name}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={stageRef}
        className={`shelf-lightbox-stage${panning ? " is-dragging" : ""}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setPanning(false)}
        onPointerCancel={() => setPanning(false)}
        onClick={onStageClick}
      >
        {state === "loading" && (
          <div className="shelf-lightbox-hint" aria-live="polite">
            <Loader2 size={18} className="spin" aria-hidden="true" /> 加载中…
          </div>
        )}
        {state === "error" && (
          <div className="shelf-lightbox-hint">
            图片无法加载（可能已被外部删除或超过 40MB）
          </div>
        )}
        {state === "ok" && url && (
          <img
            src={url}
            alt={item.display_name}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            }}
          />
        )}
      </div>
      <div className="shelf-lightbox-bar">
        <span className="shelf-lightbox-name" title={item.display_name}>
          {item.display_name}
        </span>
        <div className="shelf-lightbox-actions">
          <button
            type="button"
            className="icon-btn sm"
            aria-label="缩小"
            data-tip="缩小"
            onClick={() => stepZoom(-1)}
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <span className="shelf-lightbox-zoom">{Math.round(view.s * 100)}%</span>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="放大"
            data-tip="放大"
            onClick={() => stepZoom(1)}
          >
            <Plus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="适应窗口"
            data-tip="适应窗口"
            onClick={fit}
          >
            <Scan size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            aria-label="关闭预览"
            data-tip="关闭 (Esc)"
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
