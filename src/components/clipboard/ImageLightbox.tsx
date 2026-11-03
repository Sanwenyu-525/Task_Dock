//! 图片大图预览层（灯箱）。
//!
//! - 等比适应窗口（不上采样小图），指针为中心的滚轮缩放、拖拽平移；
//! - 双击在适应窗口 ↔ 实际尺寸间切换；平移钳制保证图片不会完全拖出可视区；
//! - 关闭路径三条：遮罩空白处单击、关闭按钮、Escape。图片本体、工具栏、
//!   缩放控件上的点击一律不关闭；拖拽平移后的那一次 click 也不算「点击遮罩」；
//!   拖拽的指针捕获会把 click 的 target 重定向到舞台，所以「是否点在遮罩上」
//!   以 pointerdown 的落点判定，不看 click 的 target；
//! - 复制原图复用 `clipboard_copy_item` 受控链路（自写登记，不回流）；
//! - 另存为：系统保存对话框只负责选路径，目标已存在时由应用内 ConfirmDialog 取得
//!   显式覆盖授权，再以 overwrite 参数交给 `clipboard_save_image` 的后端执行边界。
//!   当前 rfd/IFileSaveDialog 不设置 FOS_OVERWRITEPROMPT，系统对话框成功返回路径
//!   不构成可验证的覆盖授权，因此应用内确认是唯一可靠的授权来源（fail-closed）；
//! - 注册为弹层栈 modalTop 层（z = --z-modal-top，高于抽屉与详情子视图）：
//!   Escape 只关灯箱，不会顺带把下层详情一起关掉。
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
  clipboardPathStatus,
  clipboardSaveImage,
  type ClipboardItem,
} from "../../lib/bridge";
import { clipSource, formatBytes } from "../../lib/clipboardUi";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useUiStore } from "../../store/useUiStore";
import { useFocusTrap, useOverlayLayer } from "../ui/overlay";
import { useLargeImage } from "./Media";
import type { AskConfirm } from "./types";

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
  askConfirm,
  onClose,
}: {
  item: ClipboardItem;
  /** 应用内覆盖确认通道；缺省时「目标已存在」一律按拒绝覆盖处理（绝不写盘）。 */
  askConfirm?: AskConfirm;
  onClose: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const rootRef = useRef<HTMLDivElement>(null);
  // 与历史卡片、详情页共用同一套来源结构，避免放大预览又露出原始 exe 名
  const src = clipSource(item);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const { state, url, error } = useLargeImage(item.id, true);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [isFit, setIsFit] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * 另存为的同步 in-flight 守卫：busy 是异步 state，连点时第二次 click 可能赶在
   * 重渲染禁用按钮之前进入事件处理，只有 ref 能同步拦住重复写盘。
   */
  const savingRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  /** 本次指针按下是否发生过真实位移：拖拽结束浏览器仍会补一次 click，不能当成「点遮罩关闭」。 */
  const movedRef = useRef(false);
  /**
   * 本次手势按下时的 target。
   *
   * 拖拽用了 setPointerCapture，指针捕获会把后续 click 的 target 重定向到捕获元素（舞台），
   * 于是「点在图片上」的 click 也会以舞台为 target —— 只看 e.target 会把点图片误判成点遮罩。
   * 因此以 pointerdown 的落点为准；没有 pointerdown（键盘/程序化 click）时才退回 e.target。
   */
  const pressTargetRef = useRef<EventTarget | null>(null);

  useOverlayLayer("modalTop", true, onClose, rootRef);
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
    let startX = 0;
    let startY = 0;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      startX = e.clientX;
      startY = e.clientY;
      movedRef.current = false;
      pressTargetRef.current = e.target;
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // 4px 以内视为点击抖动：不认定为拖拽，否则点遮罩关闭会被误吞
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 4) movedRef.current = true;
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

  /**
   * 点击遮罩关闭：只有「按下」与「抬起后那次 click」都落在舞台空白处才算遮罩。
   * 图片本体、加载中/缺失提示、工具栏与缩放控件都不是舞台；拖拽平移结束时浏览器补发的
   * 那一次 click 也不算（movedRef）。指针捕获会把 click 的 target 改成舞台，
   * 所以起手位置以 pointerdown 的 target 为准。
   */
  const onStageClick = (e: React.MouseEvent) => {
    if (movedRef.current) return;
    const pressTarget = pressTargetRef.current;
    pressTargetRef.current = null;
    const onBackdrop = pressTarget
      ? pressTarget === stageRef.current
      : e.target === stageRef.current;
    if (onBackdrop) onClose();
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

  /**
   * 另存为：系统对话框只负责选路径，覆盖授权属于应用层。
   * - missing  → 无覆盖写入（后端 create_new 原子排他；若目标恰在检查后出现则冲突失败，绝不覆盖）；
   * - ok       → 必须经应用内 ConfirmDialog 明确授权后才以 overwrite=true 交给后端安全替换；
   * - inaccessible / 未知 / 空 / IPC 异常 → fail-closed，绝不写盘。
   * 当前 rfd/IFileSaveDialog 不设置 FOS_OVERWRITEPROMPT，系统对话框成功返回路径不构成
   * 可验证的覆盖授权，因此应用内确认是唯一可靠的授权来源（任务书 P2 授权兜底）。
   */
  const onSaveAs = async () => {
    if (savingRef.current) return; // 连点防护：重复进入直接丢弃，不再走第二次写盘
    savingRef.current = true;
    setBusy(true);
    try {
      const id8 = item.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "image";
      const path = await save({
        defaultPath: `task-dock-clipboard-${id8}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      // 用户取消（原生返回 null/空）：不查状态、不写盘，也不视为错误。
      if (!path) return;
      // 目标状态是覆盖授权的唯一依据，必须严格校验：非数组、空数组、首元素非字符串、
      // 未知值、IPC 异常一律按 unknown 处理（fail-closed，不写盘）。
      let targetState: "ok" | "missing" | "inaccessible" | "unknown" = "unknown";
      try {
        const status = await clipboardPathStatus([path]);
        if (Array.isArray(status) && typeof status[0] === "string") {
          const st: string = status[0];
          if (st === "ok" || st === "missing" || st === "inaccessible") targetState = st;
        }
      } catch {
        // 查询失败不猜测目标状态；下方统一按 unknown 提示并拒绝写盘
      }
      if (targetState === "inaccessible") {
        showToast(`目标文件无访问权限，未保存：${path}`, { kind: "error" });
        return;
      }
      if (targetState !== "ok" && targetState !== "missing") {
        showToast(`无法确认目标文件状态，未保存：${path}`, { kind: "error" });
        return;
      }
      /** 真正写盘：错误原样展示，绝不因「目标文件已存在」冲突改用 overwrite=true 静默重试。 */
      const write = async (overwrite: boolean) => {
        savingRef.current = true;
        setBusy(true);
        try {
          const bytes = await clipboardSaveImage(item.id, path, overwrite);
          showToast(
            overwrite
              ? `已覆盖保存（${formatBytes(bytes)}）：${path}`
              : `已保存（${formatBytes(bytes)}）：${path}`,
            { kind: "success" },
          );
        } catch (e) {
          showToast(`保存失败：${String(e)}`, { kind: "error" });
        } finally {
          savingRef.current = false;
          setBusy(false);
        }
      };
      if (targetState === "missing") {
        // 即使这里判定为 missing，后端仍以 create_new 排他创建；竞态出现的目标不会被覆盖。
        await write(false);
        return;
      }
      // 目标已存在：覆盖写入必须由用户显式授权；没有确认通道时按拒绝处理，绝不静默覆盖。
      if (!askConfirm) {
        showToast(`目标文件已存在，未覆盖：${path}`, { kind: "info" });
        return;
      }
      askConfirm({
        title: "覆盖已存在的文件？",
        detail: `${path} 已存在，覆盖后原文件内容将被替换。`,
        confirmLabel: "覆盖",
        danger: true,
        run: () => write(true),
      });
    } finally {
      savingRef.current = false;
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
        onClick={onStageClick}
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
              <span
                className="clip-lightbox-source"
                tabIndex={0}
                data-tip={`应用：${src.app}${src.appRaw ? `（来源进程 ${src.appRaw}）` : ""}${src.windowRaw ? ` · 窗口：${src.windowRaw}` : ""}`}
              >
                {src.window ? `${src.app} · ${src.window}` : src.app}
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
