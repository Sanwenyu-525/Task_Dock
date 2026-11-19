//! 弹层定位核心（纯函数）。
//!
//! 只处理**策略与几何**：给定锚点矩形、弹层尺寸、视口与配置，算出主方向、
//! 对齐方式、可用空间与最终坐标。不读 DOM、不依赖 React、不修改业务状态，
//! 因此可以在 node 环境直接单测。
//!
//! 分工：
//! - 锚定弹层的**实际坐标**由 `Popover` 里的 floating-ui 执行（翻转/平移/尺寸监听）；
//!   本模块负责尺寸上限、提示条的中心对齐、指针菜单与「无锚点居中退化」。
//! - 所有弹层共用同一套对齐词汇（start/center/end/auto）与边界语义
//!   （`collisionPadding` 默认 8px，不越界优先）。

export type PopupSide = "top" | "bottom" | "left" | "right";
export type PopupAlignment = "start" | "center" | "end" | "auto";
/** 解析后的对齐（auto 已落到 start/center/end）。 */
export type ResolvedAlignment = Exclude<PopupAlignment, "auto">;

export interface PopupRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopupSize {
  width: number;
  height: number;
}

export interface PopupViewport {
  width: number;
  height: number;
}

export interface PopupPositionConfig {
  side?: PopupSide;
  alignment?: PopupAlignment;
  offset?: number;
  collisionPadding?: number;
  matchAnchorWidth?: boolean;
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  allowFlip?: boolean;
  allowAlignmentFlip?: boolean;
}

export interface PopupAvailableSpace {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 按 side 取的主方向净空间（已扣 padding 与 offset）。 */
  main: number;
  /** 交叉轴可用长度（视口减两侧 padding）。 */
  cross: number;
}

export interface PopupAlignmentResolution {
  alignment: ResolvedAlignment;
  /** 交叉轴上的最终起点（水平轴为 left，垂直轴为 top）。 */
  left: number;
  shifted: boolean;
}

export interface PopupPlacementResult {
  side: PopupSide;
  alignment: ResolvedAlignment;
  left: number;
  top: number;
  availableWidth: number;
  availableHeight: number;
  /** 主方向是否发生翻转（bottom↔top / left↔right）。 */
  flipped: boolean;
  /** 最终对齐是否与请求不同（仅 auto 可能出现）。 */
  aligned: boolean;
  /** 是否因边界发生平移/夹取。 */
  shifted: boolean;
  /** 弹层内容是否大于可用空间（需要滚动或收缩）。 */
  constrained: boolean;
}

export interface PopupSizeLimits {
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
}

export interface PointerMenuPosition {
  left: number;
  top: number;
  flippedX: boolean;
  flippedY: boolean;
}

export const DEFAULT_COLLISION_PADDING = 8;
export const DEFAULT_POPUP_OFFSET = 6;
export const MIN_POPUP_HEIGHT = 72;
export const MIN_POPUP_WIDTH = 72;

const EPSILON = 0.5;

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** 把 floating-ui 的 placement 字符串拆成「主方向 + 对齐」。 */
export function parsePlacement(placement: string | undefined): {
  side: PopupSide;
  alignment: ResolvedAlignment;
} {
  const raw = (placement ?? "bottom-start").trim();
  const side: PopupSide = raw.startsWith("top")
    ? "top"
    : raw.startsWith("left")
      ? "left"
      : raw.startsWith("right")
        ? "right"
        : "bottom";
  const rest = raw.slice(side.length);
  const alignment: ResolvedAlignment = rest.startsWith("-start")
    ? "start"
    : rest.startsWith("-end")
      ? "end"
      : rest.startsWith("-center")
        ? "center"
        : "center"; // 裸 side（"bottom"）在 floating-ui 里就是居中对齐
  return { side, alignment };
}

/** 把「主方向 + 对齐」还原成 floating-ui placement。center 用裸 side。 */
export function toFloatingPlacement(
  side: PopupSide,
  alignment: ResolvedAlignment,
): string {
  return alignment === "center" ? side : `${side}-${alignment}`;
}

/** 解析调用方配置：显式 side/alignment 优先于 placement。 */
export function resolvePopupConfig(input: {
  placement?: string;
  side?: PopupSide;
  alignment?: PopupAlignment;
}): { side: PopupSide; alignment: PopupAlignment } {
  const parsed = parsePlacement(input.placement);
  return {
    side: input.side ?? parsed.side,
    alignment: input.alignment ?? parsed.alignment,
  };
}

function oppositeSide(side: PopupSide): PopupSide {
  return side === "bottom" ? "top" : side === "top" ? "bottom" : side === "right" ? "left" : "right";
}

/**
 * 触发器四边可用空间。
 *
 * `offset` 是弹层与锚点之间的间距，必须从主方向空间里扣掉：否则「刚好放得下」
 * 的弹层会贴着锚点溢出。`padding` 是窗口边缘留白，四边都要扣。
 */
export function calculatePopupAvailableSpace(input: {
  anchor: PopupRect;
  viewport: PopupViewport;
  side: PopupSide;
  offset?: number;
  padding?: number;
}): PopupAvailableSpace {
  const offset = finite(input.offset ?? DEFAULT_POPUP_OFFSET, DEFAULT_POPUP_OFFSET);
  const padding = finite(input.padding ?? DEFAULT_COLLISION_PADDING, DEFAULT_COLLISION_PADDING);
  const { anchor, viewport } = input;
  const top = anchor.top - padding - offset;
  const bottom = viewport.height - (anchor.top + anchor.height) - padding - offset;
  const left = anchor.left - padding - offset;
  const right = viewport.width - (anchor.left + anchor.width) - padding - offset;
  const main =
    input.side === "bottom" ? bottom : input.side === "top" ? top : input.side === "right" ? right : left;
  const cross =
    input.side === "top" || input.side === "bottom"
      ? viewport.width - padding * 2
      : viewport.height - padding * 2;
  return {
    top: Math.max(0, top),
    bottom: Math.max(0, bottom),
    left: Math.max(0, left),
    right: Math.max(0, right),
    main: Math.max(0, main),
    cross: Math.max(0, cross),
  };
}

function fitsInViewport(left: number, size: number, viewportSize: number, padding: number): boolean {
  return left >= padding - EPSILON && left + size <= viewportSize - padding + EPSILON;
}

function overflowAmount(left: number, size: number, viewportSize: number, padding: number): number {
  return Math.max(0, padding - left) + Math.max(0, left + size - (viewportSize - padding));
}

/**
 * 交叉轴对齐。
 *
 * `auto` 的判定顺序：start 能完整放下 → end 能完整放下 → center 能完整放下 →
 * 选择「夹取量最小」的一侧。不能按「窗口左半/右半」粗判：弹层宽度和触发器宽度
 * 都会影响结果。
 */
export function resolvePopupAlignment(input: {
  anchorLeft: number;
  anchorWidth: number;
  popupWidth: number;
  viewportWidth: number;
  alignment: PopupAlignment;
  padding?: number;
}): PopupAlignmentResolution {
  const padding = finite(input.padding ?? DEFAULT_COLLISION_PADDING, DEFAULT_COLLISION_PADDING);
  const width = Math.max(0, finite(input.popupWidth));
  const anchorLeft = finite(input.anchorLeft);
  const anchorWidth = Math.max(0, finite(input.anchorWidth));
  const viewportWidth = Math.max(0, finite(input.viewportWidth));
  const maxLeft = Math.max(padding, viewportWidth - width - padding);
  const candidates: Array<{ alignment: ResolvedAlignment; left: number }> = [
    { alignment: "start", left: anchorLeft },
    { alignment: "end", left: anchorLeft + anchorWidth - width },
    { alignment: "center", left: anchorLeft + anchorWidth / 2 - width / 2 },
  ];

  const requested = input.alignment;
  if (requested !== "auto") {
    const target = candidates.find((c) => c.alignment === requested) ?? candidates[0];
    const left = clamp(target.left, padding, maxLeft);
    return {
      alignment: target.alignment,
      left,
      shifted: Math.abs(left - target.left) > EPSILON,
    };
  }

  if (width <= 0) {
    // 尺寸未知：start 是安全的默认，等实测后由 flip 再收敛。
    return { alignment: "start", left: clamp(anchorLeft, padding, maxLeft), shifted: false };
  }

  const fitting = candidates.find((c) => fitsInViewport(c.left, width, viewportWidth, padding));
  if (fitting) return { alignment: fitting.alignment, left: fitting.left, shifted: false };

  // 都放不下：选夹取量最小的对齐，再夹进可用区间。
  let best = candidates[0];
  let bestOverflow = overflowAmount(best.left, width, viewportWidth, padding);
  for (const candidate of candidates.slice(1)) {
    const overflow = overflowAmount(candidate.left, width, viewportWidth, padding);
    if (overflow < bestOverflow - EPSILON) {
      best = candidate;
      bestOverflow = overflow;
    }
  }
  const left = clamp(best.left, padding, maxLeft);
  return { alignment: best.alignment, left, shifted: Math.abs(left - best.left) > EPSILON };
}

function popupMainSize(side: PopupSide, popup: PopupSize): number {
  return side === "top" || side === "bottom" ? Math.max(0, popup.height) : Math.max(0, popup.width);
}

function popupCrossSize(side: PopupSide, popup: PopupSize): number {
  return side === "top" || side === "bottom" ? Math.max(0, popup.width) : Math.max(0, popup.height);
}

/**
 * 主方向 + 对齐的完整决策。
 *
 * `popup` 尺寸未知时传 0：不做翻转（没有尺寸就无法判断放不放得下），
 * 只按首选 side 输出锚定坐标；实测后由 `Popover` 的 flip 重算。
 */
export function resolvePopupPlacement(input: {
  anchor: PopupRect;
  popup: PopupSize;
  viewport: PopupViewport;
  config?: PopupPositionConfig;
}): PopupPlacementResult {
  const config = input.config ?? {};
  const offset = finite(config.offset ?? DEFAULT_POPUP_OFFSET, DEFAULT_POPUP_OFFSET);
  const padding = finite(
    config.collisionPadding ?? DEFAULT_COLLISION_PADDING,
    DEFAULT_COLLISION_PADDING,
  );
  const requestedAlignment = config.alignment ?? "start";
  let side = config.side ?? "bottom";
  const space = calculatePopupAvailableSpace({
    anchor: input.anchor,
    viewport: input.viewport,
    side,
    offset,
    padding,
  });
  const mainSize = popupMainSize(side, input.popup);
  let flipped = false;

  if (config.allowFlip !== false && mainSize > 0) {
    const opposite = oppositeSide(side);
    const oppositeSpace = calculatePopupAvailableSpace({
      anchor: input.anchor,
      viewport: input.viewport,
      side: opposite,
      offset,
      padding,
    });
    if (mainSize > space.main + EPSILON && oppositeSpace.main > space.main + EPSILON) {
      side = opposite;
      flipped = true;
    }
  }

  const effectiveSpace = calculatePopupAvailableSpace({
    anchor: input.anchor,
    viewport: input.viewport,
    side,
    offset,
    padding,
  });

  // 主方向坐标（弹层尺寸未知时按锚点边缘，实测后会校正）。
  let top: number;
  let left: number;
  if (side === "bottom") {
    top = input.anchor.top + input.anchor.height + offset;
    left = input.anchor.left;
  } else if (side === "top") {
    top = input.anchor.top - offset - input.popup.height;
    left = input.anchor.left;
  } else if (side === "right") {
    left = input.anchor.left + input.anchor.width + offset;
    top = input.anchor.top;
  } else {
    left = input.anchor.left - offset - input.popup.width;
    top = input.anchor.top;
  }

  // 交叉轴对齐：水平轴用 left，垂直轴复用同一套 start/center/end 计算。
  let alignment: ResolvedAlignment;
  let shifted: boolean;
  if (side === "top" || side === "bottom") {
    const resolved = resolvePopupAlignment({
      anchorLeft: input.anchor.left,
      anchorWidth: input.anchor.width,
      popupWidth: input.popup.width,
      viewportWidth: input.viewport.width,
      alignment: requestedAlignment,
      padding,
    });
    alignment = resolved.alignment;
    left = resolved.left;
    shifted = resolved.shifted;
  } else {
    const resolved = resolvePopupAlignment({
      anchorLeft: input.anchor.top,
      anchorWidth: input.anchor.height,
      popupWidth: input.popup.height,
      viewportWidth: input.viewport.height,
      alignment: requestedAlignment,
      padding,
    });
    alignment = resolved.alignment;
    top = resolved.left;
    shifted = resolved.shifted;
  }

  const maxLeft = Math.max(padding, input.viewport.width - input.popup.width - padding);
  const maxTop = Math.max(padding, input.viewport.height - input.popup.height - padding);
  const clampedLeft = input.popup.width > 0 ? clamp(left, padding, maxLeft) : left;
  const clampedTop = input.popup.height > 0 ? clamp(top, padding, maxTop) : top;
  const mainClamped =
    Math.abs(clampedLeft - left) > EPSILON || Math.abs(clampedTop - top) > EPSILON;
  left = clampedLeft;
  top = clampedTop;

  const availableWidth =
    side === "top" || side === "bottom"
      ? Math.max(0, input.viewport.width - padding * 2)
      : effectiveSpace.main;
  const availableHeight =
    side === "top" || side === "bottom"
      ? effectiveSpace.main
      : Math.max(0, input.viewport.height - padding * 2);
  const crossSize = popupCrossSize(side, input.popup);
  const constrained =
    (side === "top" || side === "bottom"
      ? input.popup.height > availableHeight + EPSILON
      : input.popup.width > availableWidth + EPSILON) ||
    crossSize > (side === "top" || side === "bottom" ? availableWidth : availableHeight) + EPSILON;

  return {
    side,
    alignment,
    left: Math.round(left),
    top: Math.round(top),
    availableWidth: Math.floor(availableWidth),
    availableHeight: Math.floor(availableHeight),
    flipped,
    aligned: requestedAlignment !== "auto" && alignment !== requestedAlignment,
    shifted: shifted || mainClamped,
    constrained,
  };
}

/**
 * 尺寸约束：不越界优先于「至少和触发器一样宽」。
 *
 * 极窄窗口下 `minWidth` 可能大于可用宽度；CSS 的 min-width 会压过 max-width
 * 导致弹层溢出，所以这里直接把 min 收到 max。
 */
export function constrainPopupSize(input: {
  anchorWidth?: number;
  availableWidth: number;
  availableHeight: number;
  config?: PopupPositionConfig;
}): PopupSizeLimits {
  const config = input.config ?? {};
  const availableWidth = Math.max(0, finite(input.availableWidth));
  const availableHeight = Math.max(0, finite(input.availableHeight));
  const configuredMaxWidth =
    config.maxWidth !== undefined && Number.isFinite(config.maxWidth)
      ? config.maxWidth
      : availableWidth;
  const maxWidth = Math.floor(Math.max(0, Math.min(configuredMaxWidth, availableWidth)));
  const requestedMin = Math.max(
    0,
    finite(config.minWidth ?? 0),
    config.matchAnchorWidth ? Math.max(0, finite(input.anchorWidth ?? 0)) : 0,
  );
  const minWidth = Math.floor(Math.min(requestedMin, maxWidth));
  const configuredMaxHeight =
    config.maxHeight !== undefined && Number.isFinite(config.maxHeight)
      ? config.maxHeight
      : availableHeight;
  const maxHeight = Math.floor(Math.max(0, Math.min(configuredMaxHeight, availableHeight)));
  return { minWidth, maxWidth, maxHeight };
}

/**
 * 鼠标指针右键菜单：默认从指针右下展开，右/下空间不足向左/上翻转，
 * 最后四边夹取。菜单尺寸未知（0）时只夹取指针坐标，不做翻转。
 */
export function resolvePointerMenuPosition(
  pointer: { x: number; y: number },
  menu: PopupSize,
  viewport: PopupViewport,
  padding = DEFAULT_COLLISION_PADDING,
): PointerMenuPosition {
  const p = Math.max(0, finite(padding, DEFAULT_COLLISION_PADDING));
  const x = finite(pointer.x);
  const y = finite(pointer.y);
  const width = Math.max(0, finite(menu.width));
  const height = Math.max(0, finite(menu.height));
  const maxLeft = Math.max(p, viewport.width - width - p);
  const maxTop = Math.max(p, viewport.height - height - p);

  let left = x;
  let top = y;
  let flippedX = false;
  let flippedY = false;
  if (width > 0 && x + width > viewport.width - p + EPSILON) {
    left = x - width;
    flippedX = true;
  }
  if (height > 0 && y + height > viewport.height - p + EPSILON) {
    top = y - height;
    flippedY = true;
  }
  return {
    left: Math.round(clamp(left, p, maxLeft)),
    top: Math.round(clamp(top, p, maxTop)),
    flippedX,
    flippedY,
  };
}

/** 无锚点/锚点不可见时的视口居中（不用于普通锚定弹层）。 */
export function centerPopupInViewport(
  size: PopupSize,
  viewport: PopupViewport,
  padding = DEFAULT_COLLISION_PADDING,
): { left: number; top: number } {
  const p = Math.max(0, finite(padding, DEFAULT_COLLISION_PADDING));
  const width = Math.max(0, finite(size.width));
  const height = Math.max(0, finite(size.height));
  const maxLeft = Math.max(p, viewport.width - width - p);
  const maxTop = Math.max(p, viewport.height - height - p);
  return {
    left: Math.round(clamp((viewport.width - width) / 2, p, maxLeft)),
    top: Math.round(clamp((viewport.height - height) / 2, p, maxTop)),
  };
}
