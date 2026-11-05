//! 图片大图预览层（灯箱）。
//!
//! - 分组内多图：`items` 给出按分组顺序的图片序列时，左右箭头 / ←→ 键在图片间切换，
//!   底部显示「2 / 5」；首尾不循环，单图不显示箭头。切换只重算适应窗口并清掉上一张的
//!   缩放/平移，不影响分组原顺序（混合分组只过滤出图片）；
//!   分组图片超过单页上限时，`items` 只含已加载部分、`total` 给出真实总数，
//!   箭头在已加载末尾会触发 `onNeedMore` 追加下一页，序号始终按真实总数显示；
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
  ChevronLeft, ChevronRight, Copy, Download, Loader2, Minus, Plus, Scan, SquareEqual, X,
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
  items,
  total,
  sequenceReady = true,
  onNeedMore,
  listLoading,
  listError,
  askConfirm,
  onClose,
}: {
  /** 打开预览的那一条（单图模式下的唯一一张） */
  item: ClipboardItem;
  /**
   * 同一分组内按真实顺序排列的图片序列（只含图片）。缺省 = 单图模式，不显示切换控件；
   * 混合分组由调用方先过滤出图片，这里不再改变顺序。
   *
   * 分组图片较多时调用方按页追加，`items` 只是已加载部分；真实总数由 `total` 给出，
   * 箭头与序号都以 `total` 为准，不能停在已加载页的末尾。
   */
  items?: ClipboardItem[];
  /** 分组图片真实总数（≥ items.length）；缺省视为 items.length。 */
  total?: number;
  /**
   * 分组真实序列是否已就绪。首屏未返回时 `items` 只是「点击的那张封面」占位，
   * 其中的索引不是正式位置；此标记为 false 时方向键只累积相对位移，
   * 等真实序列到达再换算，避免从错误序号起步。
   */
  sequenceReady?: boolean;
  /** 已加载序列不足时请求下一页（调用方追加后 items 增长）；缺省不加载。 */
  onNeedMore?: () => void;
  /** 下一页在途：序号旁显示加载态，不切换或清空当前图片。 */
  listLoading?: boolean;
  /** 分组图片列表读取失败：在工具栏内给出准确错误，不伪装成单图。 */
  listError?: string;
  /** 应用内覆盖确认通道；缺省时「目标已存在」一律按拒绝覆盖处理（绝不写盘）。 */
  askConfirm?: AskConfirm;
  onClose: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /**
   * 当前预览的条目：分组模式下在 `items` 内切换；分组里被移除的条目会按最近位置
   * 回退到相邻图片，全部移除则直接关闭预览。
   */
  const [currentId, setCurrentId] = useState(item.id);
  /** 分组内最近一次所在位置：当前图片被移除时据此落到相邻图片。 */
  const indexRef = useRef(0);
  /** 尚未加载到位、但用户已经按箭头要求切换到的目标位置。 */
  const pendingIndexRef = useRef<number | null>(null);
  /**
   * 首屏真实序列到达前累积的相对位移（只记方向与次数，不记绝对位置）。
   * 占位数组只有被点的那一张，索引 0 不代表组内第 1 张。
   */
  const pendingStepsRef = useRef(0);
  const ordered = items && items.length > 0 ? items : [item];
  const foundIndex = ordered.findIndex((i) => i.id === currentId);
  const index = foundIndex >= 0
    ? foundIndex
    : Math.min(indexRef.current, Math.max(0, ordered.length - 1));
  // 占位序列里的 0 不是正式位置，不能写回 indexRef 供删除校正使用。
  if (foundIndex >= 0 && sequenceReady) indexRef.current = index;
  const current = ordered[index] ?? item;
  /**
   * 分组真实总数：`items` 可能只是已加载的前几页（单页有上限），
   * 箭头与序号都必须按真实总数判断，不能停在已加载页末尾。
   */
  const totalCount = items !== undefined ? Math.max(ordered.length, total ?? 0) : ordered.length;
  const multi = items !== undefined && totalCount > 1;
  const { state, url, error, forId } = useLargeImage(current.id, true);
  /**
   * 切换条目后 effect 尚未执行时，state/url 仍属于上一张；按「加载中」处理，
   * 不让旧图带着新条目的元信息出现。
   */
  const viewState = forId === current.id ? state : "loading";
  // 与历史卡片、详情页共用同一套来源结构，避免放大预览又露出原始 exe 名
  const src = clipSource(current);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [isFit, setIsFit] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * 另存为的同步 in-flight 守卫：busy 是异步 state，连点时第二次 click 可能赶在
   * 重渲染禁用按钮之前进入事件处理，只有 ref 能同步拦住重复写盘。
   */
  const savingRef = useRef(false);
  /**
   * 卸载标记：保存流程跨越原生对话框与后台 IPC，用户可能中途关闭灯箱。
   * 卸载后不再更新组件内的 busy 状态（React 会忽略，但保留旧状态是无意义的）；
   * 全局 Toast 仍展示，保存结果对用户依然可见。
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 只在挂载期更新本地状态。 */
  const setBusyIfMounted = (next: boolean) => {
    if (mountedRef.current) setBusy(next);
  };
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

  /** 清掉上一张的缩放/平移并恢复「适应窗口」态。 */
  const resetPreview = useCallback(() => {
    setNatural(null);
    setView({ s: 1, x: 0, y: 0 });
    setIsFit(true);
    movedRef.current = false;
    pressTargetRef.current = null;
  }, []);

  /**
   * 按方向切换分组内图片；首尾不循环，越界一律忽略。
   *
   * - 首屏序列未就绪：只累积相对位移，等真实顺序到达后统一换算目标位置，
   *   加载期间连按多次也会逐次累加，不会都落到同一张。
   * - 已有未加载到位的目标：从 pending 目标继续累加，分页边界连按同样有效。
   */
  const goBy = useCallback(
    (delta: -1 | 1) => {
      if (!items) return;
      if (!sequenceReady) {
        pendingStepsRef.current += delta;
        onNeedMore?.();
        return;
      }
      const base = pendingIndexRef.current ?? index;
      const target = base + delta;
      if (target < 0 || target >= totalCount) return;
      const next = ordered[target];
      // 目标页尚未加载：记下目标位置并请求下一页，追加完成后自动切过去。
      if (!next) {
        pendingIndexRef.current = target;
        onNeedMore?.();
        return;
      }
      pendingIndexRef.current = null;
      if (next.id === current.id) return;
      resetPreview();
      setCurrentId(next.id);
    },
    [items, sequenceReady, ordered, index, current.id, resetPreview, totalCount, onNeedMore],
  );

  /**
   * 分组内容变化（移除/拆分/重排）时校正预览位置：
   * - 当前图片仍存在 → 保持不动；
   * - 当前图片被移出 → 按原位置就近落到相邻图片；
   * - 分组里已没有图片 → 关闭预览，不留一个指向已删除数据的灯箱。
   */
  const orderedKey = items ? items.map((i) => i.id).join("|") : "";
  useEffect(() => {
    if (!items) return;
    if (items.length === 0) {
      onClose();
      return;
    }
    if (items.some((i) => i.id === currentId)) return;
    // 当前条目已不存在：旧的待切换目标与加载期位移都不再可信。
    pendingIndexRef.current = null;
    pendingStepsRef.current = 0;
    resetPreview();
    setCurrentId(items[Math.min(indexRef.current, items.length - 1)].id);
    // 只跟随顺序键变化；onClose/resetPreview 是稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedKey]);

  /**
   * 首屏真实序列到达：把加载期间累积的相对位移换算成真实顺序下的目标位置。
   * 用 layout effect，避免先按占位索引渲染一帧再跳位。
   * 打开的图片已被删除（真实序列里找不到）时丢弃位移，交给上面的就近落位。
   */
  useLayoutEffect(() => {
    if (!items || !sequenceReady) return;
    const steps = pendingStepsRef.current;
    if (steps === 0) return;
    pendingStepsRef.current = 0;
    const base = items.findIndex((i) => i.id === currentId);
    if (base < 0) return;
    const target = clamp(base + steps, 0, totalCount - 1);
    if (target >= items.length) {
      pendingIndexRef.current = target;
      onNeedMore?.();
      return;
    }
    const next = items[target];
    if (!next || next.id === currentId) return;
    resetPreview();
    setCurrentId(next.id);
    // 只在「就绪」或真实序列变化时换算；currentId 此时仍是打开时的条目
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceReady, orderedKey]);

  /**
   * 目标页追加后补上用户先前按箭头要求的位置（见 goBy 的 pendingIndexRef）。
   * 目标还没出现在已加载前缀时继续请求下一页；请求失败/条目被删导致目标
   * 永远不出现时，pending 留在原地并在下次按键时被覆盖。
   */
  useEffect(() => {
    const pending = pendingIndexRef.current;
    if (pending === null || !items) return;
    if (pending >= totalCount) {
      pendingIndexRef.current = null;
      return;
    }
    const next = items[pending];
    if (!next) {
      if (items.length < totalCount) onNeedMore?.();
      return;
    }
    pendingIndexRef.current = null;
    if (next.id === currentId) return;
    resetPreview();
    setCurrentId(next.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedKey, totalCount, onNeedMore]);

  /**
   * ←/→ 在分组图片间切换。灯箱是最高层模态，按键在 capture 阶段消费，
   * 不穿透到底层页面；单图模式不注册（保持既有行为）。
   */
  const navRef = useRef({ multi, goBy });
  navRef.current = { multi, goBy };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const nav = navRef.current;
      if (!nav.multi) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      nav.goBy(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /**
   * 临近已加载序列末尾时提前补下一页，避免用户按到第 50 张后停下来等待；
   * 调用方负责去重与并发上限，这里只表达「还差一点」。
   */
  useEffect(() => {
    if (!items || ordered.length >= totalCount) return;
    if (index >= ordered.length - 2) onNeedMore?.();
  }, [items, index, ordered.length, totalCount, onNeedMore]);

  useOverlayLayer("modalTop", true, onClose, rootRef);
  useFocusTrap(true, rootRef);

  /** 当前可用空间（舞台内容区减去左右/上下内边距，多图模式给箭头留出空间）。 */
  const avail = useCallback(() => {
    const el = stageRef.current;
    if (!el) return { w: 0, h: 0, padX: 0, padY: 0 };
    const cs = getComputedStyle(el);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    return {
      w: Math.max(1, el.clientWidth - padX),
      h: Math.max(1, el.clientHeight - padY),
      padX: parseFloat(cs.paddingLeft) || 0,
      padY: parseFloat(cs.paddingTop) || 0,
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
      const { w, h, padX, padY } = avail();
      setView((v) => {
        const s2 = clamp(ns, MIN_SCALE, MAX_SCALE);
        const cx = px - w / 2 - padX;
        const cy = py - h / 2 - padY;
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
      // 切换箭头不参与拖拽：记录落点即可，避免把点按钮误判成「点遮罩关闭」
      if ((e.target as HTMLElement | null)?.closest?.("[data-clip-lightbox-nav]")) {
        movedRef.current = false;
        pressTargetRef.current = e.target;
        return;
      }
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
      const r = await clipboardCopyItem(current.id);
      const warn = r.warnings.length > 0 ? `；${r.warnings.join("；")}` : "";
      const partial = r.warnings.length > 0 || r.stats_recorded === false;
      // 写入成功即成功；统计失败等降级项显示「部分成功」，不报告成复制失败
      showToast(`已复制原图${partial ? "（部分成功）" : ""}（${formatBytes(r.bytes)}）${warn}`, {
        kind: partial ? "info" : "success",
      });
      // 统计没落库时不本地加次数，避免 UI 与数据库长期不一致
      if (r.stats_recorded !== false) useClipboardStore.getState().bumpItemCopy(current.id);
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
      const id8 = current.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "image";
      let chosen: string | null = null;
      try {
        chosen = await save({
          defaultPath: `task-dock-clipboard-${id8}.png`,
          filters: [{ name: "PNG 图片", extensions: ["png"] }],
        });
      } catch (e) {
        // 对话框创建/调用异常（插件不可用、宿主拒绝等）：明确报错，不查状态也不写盘。
        // 这里必须自行捕获：onSaveAs 直接挂在 onClick 上，抛出的 Promise rejection 无人处理。
        showToast(`打开保存对话框失败，未保存：${String(e)}`, { kind: "error" });
        return;
      }
      // 用户取消（原生返回 null/空）：不查状态、不写盘，也不视为错误。
      if (!chosen) return;
      const targetPath = chosen;
      // 目标状态是覆盖授权的唯一依据，必须严格校验：非数组、空数组、首元素非字符串、
      // 未知值、IPC 异常一律按 unknown 处理（fail-closed，不写盘）。
      let targetState: "ok" | "missing" | "inaccessible" | "unknown" = "unknown";
      try {
        const status = await clipboardPathStatus([targetPath]);
        if (Array.isArray(status) && typeof status[0] === "string") {
          const st: string = status[0];
          if (st === "ok" || st === "missing" || st === "inaccessible") targetState = st;
        }
      } catch {
        // 查询失败不猜测目标状态；下方统一按 unknown 提示并拒绝写盘
      }
      if (targetState === "inaccessible") {
        showToast(`目标文件无访问权限，未保存：${targetPath}`, { kind: "error" });
        return;
      }
      if (targetState !== "ok" && targetState !== "missing") {
        showToast(`无法确认目标文件状态，未保存：${targetPath}`, { kind: "error" });
        return;
      }
      /** 真正写盘：错误原样展示，绝不因「目标文件已存在」冲突改用 overwrite=true 静默重试。 */
      const write = async (overwrite: boolean) => {
        savingRef.current = true;
        setBusyIfMounted(true);
        try {
          const bytes = await clipboardSaveImage(current.id, targetPath, overwrite);
          showToast(
            overwrite
              ? `已覆盖保存（${formatBytes(bytes)}）：${targetPath}`
              : `已保存（${formatBytes(bytes)}）：${targetPath}`,
            { kind: "success" },
          );
        } catch (e) {
          showToast(`保存失败：${String(e)}`, { kind: "error" });
        } finally {
          savingRef.current = false;
          setBusyIfMounted(false);
        }
      };
      if (targetState === "missing") {
        // 即使这里判定为 missing，后端仍以 create_new 排他创建；竞态出现的目标不会被覆盖。
        await write(false);
        return;
      }
      // 目标已存在：覆盖写入必须由用户显式授权；没有确认通道时按拒绝处理，绝不静默覆盖。
      if (!askConfirm) {
        showToast(`目标文件已存在，未覆盖：${targetPath}`, { kind: "info" });
        return;
      }
      askConfirm({
        title: "覆盖已存在的文件？",
        detail: `${targetPath} 已存在，覆盖后原文件内容将被替换。`,
        confirmLabel: "覆盖",
        danger: true,
        run: () => write(true),
      });
    } finally {
      savingRef.current = false;
      setBusyIfMounted(false);
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
        className={`clip-lightbox-stage${multi ? " multi" : ""}`}
        onClick={onStageClick}
        onDoubleClick={onDoubleClick}
      >
        {viewState === "loading" && (
          <div className="clip-lightbox-status" role="status">
            <Loader2 size={18} className="spin" aria-hidden="true" /> 正在加载原图…
          </div>
        )}
        {viewState === "missing" && (
          <div className="clip-lightbox-status">图片文件缺失或已被清理，无法预览</div>
        )}
        {viewState === "error" && (
          <div className="clip-lightbox-status">图片读取失败：{error}</div>
        )}
        {viewState === "ready" && (
          <img
            ref={imgRef}
            className="clip-lightbox-img"
            src={url ?? undefined}
            alt={current.title || "剪贴板图片"}
            draggable={false}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
            }}
            onLoad={onImgLoad}
          />
        )}
        {multi && (
          <>
            <button
              type="button"
              className="clip-lightbox-nav prev"
              data-clip-lightbox-nav
              data-tip="上一张"
              aria-label="上一张"
              disabled={sequenceReady && index === 0}
              onClick={(e) => {
                e.stopPropagation();
                goBy(-1);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              className="clip-lightbox-nav next"
              data-clip-lightbox-nav
              data-tip="下一张"
              aria-label="下一张"
              disabled={sequenceReady && index >= totalCount - 1}
              onClick={(e) => {
                e.stopPropagation();
                goBy(1);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ChevronRight size={20} />
            </button>
          </>
        )}
      </div>

      <div className="clip-lightbox-bar">
        <div className="clip-lightbox-info">
          {multi && (
            <span className="clip-lightbox-counter" aria-live="polite">
              {/* 首屏序列未就绪时占位索引不是真实位置，不显示错误序号 */}
              {sequenceReady ? `${index + 1} / ${totalCount}` : `… / ${totalCount}`}
              {(listLoading || !sequenceReady) && ordered.length < totalCount && (
                <Loader2 size={11} className="spin" aria-hidden="true" />
              )}
            </span>
          )}
          {listError && (
            <span className="clip-lightbox-list-error" role="status">
              {listError}
            </span>
          )}
          {natural ? (
            <>
              <span>{natural.w}×{natural.h}</span>
              <span>PNG（存储格式）</span>
              <span>{formatBytes(current.byte_size)}</span>
              <span
                className="clip-lightbox-source"
                tabIndex={0}
                data-tip={`应用：${src.app}${src.appRaw ? `（来源进程 ${src.appRaw}）` : ""}${src.windowRaw ? ` · 窗口：${src.windowRaw}` : ""}`}
              >
                {src.window ? `${src.app} · ${src.window}` : src.app}
              </span>
            </>
          ) : (
            <span>{viewState === "loading" ? "读取图片信息…" : "无图片信息"}</span>
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
            disabled={viewState !== "ready" || busy}
            onClick={onCopy}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-tip="另存为"
            aria-label="另存为"
            disabled={viewState !== "ready" || busy}
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
