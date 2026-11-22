//! 暂存架图片大图预览层（灯箱）。
//!
//! 交互对齐剪贴板 ImageLightbox（滚轮缩放 / Escape / 遮罩关闭 / modalTop 层），
//! 数据走 shelfReadImage（独立于剪贴板 Media 缓存，不侵入剪贴板模块）。
//!
//! 序列模式：传入 `images` + `onNavigate` 后支持左右方向键、前后按钮与「当前/总数」；
//! 图片顺序由调用方按当前筛选与排序给出，本组件不自行重排。加载失败可重试或跳到
//! 下一张；关闭后焦点回到打开灯箱前的控件。

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft, ChevronRight, Copy, FolderOpen, Info, Loader2, Minus, Plus, RotateCcw,
  Scan, Star, Trash2, X,
} from "lucide-react";
import { shelfReadImage, type ShelfItem } from "../../lib/bridge";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";
import "./shelf-ui.css";

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

export interface ShelfImageLightboxProps {
  item: ShelfItem;
  onClose: () => void;
  /** 当前筛选/排序下的图片序列（包含 item）；缺省为单图模式。 */
  images?: ShelfItem[];
  /** 上一张/下一张；在边界也调用，由调用方决定是否分页加载或提示。 */
  onNavigate?: (direction: -1 | 1) => void;
  onRequestDetail?: (id: string) => void;
  onFavorite?: (item: ShelfItem) => void;
  onCopyImage?: (item: ShelfItem) => void;
  onReveal?: (item: ShelfItem) => void;
  onRequestDelete?: (item: ShelfItem) => void;
  /** 分页加载中：导航按钮显示忙碌但不阻塞键盘。 */
  loadingMore?: boolean;
}

export default function ShelfImageLightbox({
  item,
  onClose,
  images,
  onNavigate,
  onRequestDetail,
  onFavorite,
  onCopyImage,
  onReveal,
  onRequestDelete,
  loadingMore = false,
}: ShelfImageLightboxProps) {
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
  /** 重新加载计数：失败后点「重试」用，避免整层重建。 */
  const [reloadKey, setReloadKey] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const movedRef = useRef(false);
  const downPointRef = useRef<{ x: number; y: number } | null>(null);
  const pressTargetRef = useRef<EventTarget | null>(null);
  /** 打开前的焦点：灯箱关闭后还原，键盘用户不会被丢到页面顶部。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const list = images && images.length > 0 ? images : [item];
  const index = Math.max(
    0,
    list.findIndex((entry) => entry.id === item.id),
  );
  const total = list.length;

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = restoreFocusRef.current;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setUrl(null);
    setNatural(null);
    setView({ s: 1, x: 0, y: 0 });
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
  }, [item.id, reloadKey]);

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
    // 拖拽平移后的补发 click 不算「点遮罩」；落点判定以 pointerdown 为准。
    // 图片双击用于缩放，因此单击图片不关闭；点舞台空白/提示文字关闭。
    if (movedRef.current) return;
    if (e.target === pressTargetRef.current && e.target !== stageRef.current) return;
    if ((e.target as Element | null)?.closest?.("img, button")) return;
    if (e.target === pressTargetRef.current || e.target === stageRef.current) {
      onClose();
    }
  };

  /** 双击在「适应窗口」与 100% 之间切换（不改变图片内容）。 */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!natural) return;
    if ((e.target as Element | null)?.closest?.("button")) return;
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const current = viewRef.current.s;
    if (current > 0.98 && current < 1.02) {
      fit();
      return;
    }
    setView(
      clampPan(
        { s: 1, x: 0, y: 0 },
        natural.w,
        natural.h,
        stage.clientWidth,
        stage.clientHeight,
      ),
    );
  };

  const stepZoom = (dir: 1 | -1) => {
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const v = viewRef.current;
    const ns = clamp(v.s * (dir > 0 ? STEP : 1 / STEP), MIN_SCALE, MAX_SCALE);
    setView(clampPan({ ...v, s: ns }, natural.w, natural.h, stage.clientWidth, stage.clientHeight));
  };

  const go = (dir: -1 | 1) => {
    onNavigate?.(dir);
  };

  return createPortal(
    <div
      ref={rootRef}
      className="shelf-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览：${item.display_name}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        if (e.key === "ArrowLeft" && onNavigate) {
          e.preventDefault();
          e.stopPropagation();
          go(-1);
          return;
        }
        if (e.key === "ArrowRight" && onNavigate) {
          e.preventDefault();
          e.stopPropagation();
          go(1);
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
        onDoubleClick={onDoubleClick}
        data-tip="滚轮缩放 · 拖动平移 · 双击适应/原始大小"
      >
        {state === "loading" && (
          <div className="shelf-lightbox-hint" aria-live="polite">
            <Loader2 size={18} className="spin" aria-hidden="true" /> 加载中…
          </div>
        )}
        {state === "error" && (
          <div className="shelf-lightbox-hint is-error" role="alert">
            <p>图片无法加载（可能已被外部删除或超过 40MB）</p>
            <div className="shelf-lightbox-hint-actions">
              <button
                type="button"
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setReloadKey((key) => key + 1);
                }}
              >
                重试
              </button>
              {onNavigate && total > 1 && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(1);
                  }}
                >
                  下一张
                </button>
              )}
            </div>
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

      {onNavigate && total > 1 && (
        <>
          <button
            type="button"
            className="shelf-lightbox-nav prev"
            aria-label="上一张"
            data-tip="上一张 (←)"
            disabled={index <= 0 && !loadingMore}
            onClick={() => go(-1)}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="shelf-lightbox-nav next"
            aria-label="下一张"
            data-tip="下一张 (→)"
            onClick={() => go(1)}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        </>
      )}

      <div className="shelf-lightbox-bar">
        <span className="shelf-lightbox-name" title={item.display_name}>
          {item.display_name}
        </span>
        {total > 1 && (
          <span className="shelf-lightbox-count" aria-live="polite">
            {loadingMore && <Loader2 size={11} className="spin" aria-hidden="true" />}
            {index + 1} / {total}
          </span>
        )}
        <div className="shelf-lightbox-actions">
          {onCopyImage && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label="复制图片文件"
              data-tip="复制图片文件（可粘贴到资源管理器）"
              onClick={() => onCopyImage(item)}
            >
              <Copy size={15} aria-hidden="true" />
            </button>
          )}
          {onFavorite && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label={item.favorite ? "取消收藏" : "收藏图片"}
              data-tip={item.favorite ? "取消收藏" : "收藏"}
              onClick={() => onFavorite(item)}
            >
              <Star size={15} aria-hidden="true" className={item.favorite ? "is-on" : undefined} />
            </button>
          )}
          {onReveal && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label="打开所在文件夹"
              data-tip="所在文件夹"
              onClick={() => onReveal(item)}
            >
              <FolderOpen size={15} aria-hidden="true" />
            </button>
          )}
          {onRequestDetail && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label="查看详情"
              data-tip="查看详情"
              onClick={() => onRequestDetail(item.id)}
            >
              <Info size={15} aria-hidden="true" />
            </button>
          )}
          <span className="shelf-lightbox-sep" aria-hidden="true" />
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
            aria-label="重置缩放"
            data-tip="重置缩放"
            onClick={() => setView({ s: 1, x: 0, y: 0 })}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          {onRequestDelete && (
            <button
              type="button"
              className="icon-btn sm danger"
              aria-label="删除图片"
              data-tip="删除（可撤销）"
              onClick={() => onRequestDelete(item)}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          )}
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
