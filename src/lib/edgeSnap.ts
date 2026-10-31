//! 贴边吸附纯逻辑：状态机、坐标计算、触发条命中判定、持久化校验。
//!
//! 本文件**不依赖 Tauri**（除类型外零导入），全部为可单测的纯函数。
//! 副作用（窗口移动、持久化、UI 提示）在 `src/hooks/useEdgeSnap.ts` 中执行，
//! 每一步决策都调用这里的判定函数，保证行为与单测口径一致。
//!
//! 状态机（phase）：
//!   free            未停靠
//!   candidate       拖动中进入边缘候选范围（显示「松开吸附 X 侧」提示）
//!   docked-visible  已停靠且完整可见（首次停靠显示 1.2s「已吸附」反馈）
//!   docked-hidden   已停靠并滑出屏幕，仅留 SNAP_STRIP 物理像素触发条
//!   docked-revealed 由触发条唤出（临时展开；光标离开后再次隐藏，不重复反馈）
//!
//! 坐标口径：**全部物理像素**（与 Tauri outerPosition / workArea / cursorPosition
//! 一致）。SNAP_STRIP 等常量按需求使用物理像素，高 DPI 下不做换算。

// ── 类型 ────────────────────────────────────────────────────

export type SnapEdge = "left" | "right" | "top" | "bottom";

export const SNAP_EDGES = ["left", "right", "top", "bottom"] as const;

/** 窗口/区域矩形（物理像素）。 */
export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SnapPoint = { x: number; y: number };

/** 工作区或显示器边界（物理像素）。 */
export type SnapArea = SnapRect;

/** 状态机相位。 */
export type SnapPhase =
  | "free"
  | "candidate"
  | "docked-visible"
  | "docked-hidden"
  | "docked-revealed";

// ── 常量（物理像素 / 毫秒）──────────────────────────────────

/** 拖动候选范围：窗口距工作区边缘 ≤ 该值时显示吸附提示（= 磁吸进入阈值）。 */
export const SNAP_CANDIDATE_DIST = 28; // = SNAP_CANDIDATE_ENTER_DIST（下方定义，避免 TDZ）
/** 隐藏时留在屏幕内的触发条宽度（10–12 物理像素，取 12）。 */
export const SNAP_STRIP = 12;
/** 唤出：光标距屏幕边缘的判定距离。 */
export const SNAP_REVEAL_DIST = 20;
/** 触发条区段的命中放宽量（沿边方向两端各放宽）。 */
export const SNAP_SEGMENT_MARGIN = 12;
/** 光标离开窗口多少算「离开」（超过才自动隐藏）。 */
export const SNAP_HIDE_MARGIN = 40;
/** 解除吸附时的内推距离（明确操作解除时把窗口推离边缘）。 */
export const SNAP_UNDOCK_NUDGE = 48;
/** onMoved 静默多久视为「已松开」（原生拖拽不保证 DOM mouseup）。
 *  配合 DOM 指针恢复信号使用：拖拽期间无 DOM 指针事件，恢复即松手，
 *  静默只是去抖，不单独作为松手证据。 */
export const SNAP_DRAG_SETTLE_MS = 220;
/** candidate 提示的兜底超时：松手光标未离开窗口时提示不残留。 */
export const SNAP_CANDIDATE_TIMEOUT_MS = 8000;
/** 「已吸附 X 侧」反馈时长。 */
export const SNAP_FEEDBACK_MS = 1200;
/** 轮询间隔（隐藏唤出 / 自动隐藏 / 重对齐）。 */
export const SNAP_POLL_MS = 150;
/** 程序移动记录的有效期：setPosition 触发的 onMoved 迟到也必须被忽略。 */
export const PROGRAMMATIC_MOVE_TTL_MS = 2500;
/** 程序移动目标匹配容差（物理像素）。 */
export const PROGRAMMATIC_MOVE_TOLERANCE = 3;
/** window_rect 持久化的最低可见面积占比（多屏/断连防护）。 */
export const PERSIST_VISIBLE_FRACTION = 0.6;

// ── Smart Dock Capsule（磁吸 / 防抖 / 胶囊几何）──────────────
//
// 所有延迟集中定义（禁止散落在组件里）；阈值带滞回，防止单点采样抖动。

/** 磁吸区**进入**阈值：窗口距边缘 ≤ 该值显示吸附提示（candidate）。 */
export const SNAP_CANDIDATE_ENTER_DIST = 28;
/** 磁吸区**退出**阈值（滞回）：> 该值才退出 candidate / 解除停靠。
 *  28↔42 之间是死区，防止阈值附近来回抖动。 */
export const SNAP_CANDIDATE_EXIT_DIST = 42;
/** 唤出**驻留确认**：光标在胶囊有效区持续 ≥ 该值才自动展开（点击立即）。 */
export const SNAP_REVEAL_DWELL_MS = 180;
/** **展开保护期**：reveal 完成后该时段内禁止自动隐藏（防 reveal→hide 循环）。 */
export const SNAP_REVEAL_PROTECT_MS = 500;
/** **连续离开确认**：光标离开有效交互区持续 ≥ 该值才自动隐藏。 */
export const SNAP_HIDE_LEAVE_MS = 450;
/** 胶囊交互走廊放宽量：沿边区段两端与法向外侧各放宽（物理像素）。 */
export const SNAP_CORRIDOR_MARGIN = 24;
/** 胶囊唤出区在胶囊厚度之外的额外接近带（物理像素）。 */
export const SNAP_REVEAL_APPROACH = 16;
/** 程序移动后的**坐标静默期**：期间窗口坐标可能未刷新，不做 reveal/hide 判定。 */
export const SNAP_MOVE_SETTLE_QUIET_MS = 150;
/** 磁吸两段齐平：第一段先移到距边该值处（物理像素），随后补齐。 */
export const SNAP_PULL_IN_GAP = 8;
/** 磁吸两段齐平的第二段延时（ms；两次 setPosition，非逐帧动画）。 */
export const SNAP_PULL_IN_DELAY_MS = 70;
/** 胶囊厚度（CSS px）：隐藏窗口露出的真实宽度 = round(该值 × scaleFactor)。 */
export const CAPSULE_THICKNESS_CSS = 32;
/** 胶囊长度（CSS px）：左右停靠为高度、顶底停靠为宽度。 */
export const CAPSULE_LENGTH_CSS = 120;
/** 多屏接缝判定容差（物理像素）：邻屏边界与本屏边界的吻合范围。 */
export const SNAP_SEAM_TOLERANCE = 4;
/** 接缝停靠（允许吸附但不自动隐藏）的重检间隔：邻屏断连后恢复自动隐藏。 */
export const SNAP_SEAM_RECHECK_MS = 3000;

export const EDGE_LABELS: Record<SnapEdge, string> = {
  left: "左侧",
  right: "右侧",
  top: "顶部",
  bottom: "底部",
};

export const dockFeedbackText = (edge: SnapEdge): string => `已吸附${EDGE_LABELS[edge]}`;
export const candidateHintText = (edge: SnapEdge): string => `松开吸附${EDGE_LABELS[edge]}`;

export function isSnapEdge(v: unknown): v is SnapEdge {
  return typeof v === "string" && (SNAP_EDGES as readonly string[]).includes(v);
}

// ── 状态机转移表 ────────────────────────────────────────────

/**
 * 合法相位转移。free → docked-hidden 仅用于重启恢复（读取持久化
 * snap_state 后直接重新隐藏），运行时路径一律经 docked-visible/revealed。
 */
const LEGAL_TRANSITIONS: Record<SnapPhase, readonly SnapPhase[]> = {
  free: ["candidate", "docked-visible", "docked-hidden"],
  candidate: ["free", "docked-visible"],
  "docked-visible": ["docked-hidden", "free"],
  "docked-hidden": ["docked-revealed", "free"],
  "docked-revealed": ["docked-hidden", "docked-visible", "free"],
};

export function canTransition(from: SnapPhase, to: SnapPhase): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export const isDockedPhase = (p: SnapPhase): boolean => p.startsWith("docked-");
export const isHiddenPhase = (p: SnapPhase): boolean => p === "docked-hidden";
/** 处于可自动隐藏的相位（停靠且可见）。 */
export const canAutoHide = (p: SnapPhase): boolean =>
  p === "docked-visible" || p === "docked-revealed";

// ── 坐标计算 ────────────────────────────────────────────────

/** 窗口矩形到工作区某条边的距离（≥0 在工作区内侧；负值表示已越出该边）。 */
export function edgeDistance(rect: SnapRect, area: SnapArea, edge: SnapEdge): number {
  switch (edge) {
    case "left":
      return rect.x - area.x;
    case "right":
      return area.x + area.w - (rect.x + rect.w);
    case "top":
      return rect.y - area.y;
    case "bottom":
      return area.y + area.h - (rect.y + rect.h);
  }
}

/** 窗口中心是否落在工作区沿边跨度内（防止在另一屏/工作区外误判候选）。 */
export function centerWithinSpan(rect: SnapRect, area: SnapArea, edge: SnapEdge): boolean {
  if (edge === "left" || edge === "right") {
    const cy = rect.y + rect.h / 2;
    return cy >= area.y && cy <= area.y + area.h;
  }
  const cx = rect.x + rect.w / 2;
  return cx >= area.x && cx <= area.x + area.w;
}

/**
 * 候选边判定：与四边距离取最小且进入阈值内，同时窗口中心在沿边跨度内。
 * 四角同时贴近两条边时选距离更小者（旧实现固定 left 优先会误判右下角）。
 * 距离低于 -SNAP_CANDIDATE_EXIT_DIST（明显越出边缘，如已隐藏/另一屏窗口）
 * 不判候选——负值只允许轻微越出（用户把窗口压过边缘的意图）。
 */
export function detectCandidateEdge(
  rect: SnapRect,
  area: SnapArea,
  dist: number = SNAP_CANDIDATE_ENTER_DIST,
): SnapEdge | null {
  let best: SnapEdge | null = null;
  let bestDist = Infinity;
  for (const edge of SNAP_EDGES) {
    if (!centerWithinSpan(rect, area, edge)) continue;
    const d = edgeDistance(rect, area, edge);
    if (d < bestDist) {
      bestDist = d;
      best = edge;
    }
  }
  return best !== null && bestDist <= dist && bestDist >= -SNAP_CANDIDATE_EXIT_DIST
    ? best
    : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 停靠齐平位置：贴紧 edge，沿边方向 clamp 进工作区（不压任务栏、不越出屏幕）。 */
export function clampDockedPosition(rect: SnapRect, area: SnapArea, edge: SnapEdge): SnapRect {
  const r = { ...rect };
  switch (edge) {
    case "left":
      r.x = area.x;
      r.y = clamp(r.y, area.y, Math.max(area.y, area.y + area.h - r.h));
      break;
    case "right":
      r.x = area.x + area.w - r.w;
      r.y = clamp(r.y, area.y, Math.max(area.y, area.y + area.h - r.h));
      break;
    case "top":
      r.y = area.y;
      r.x = clamp(r.x, area.x, Math.max(area.x, area.x + area.w - r.w));
      break;
    case "bottom":
      r.y = area.y + area.h - r.h;
      r.x = clamp(r.x, area.x, Math.max(area.x, area.x + area.w - r.w));
      break;
  }
  return r;
}

/** 隐藏位置：以 rect 为基准向 edge 滑出，仅留 strip 物理像素在屏幕内。 */
export function hiddenPositionFor(
  rect: SnapRect,
  area: SnapArea,
  edge: SnapEdge,
  strip: number = SNAP_STRIP,
): SnapRect {
  const r = { ...rect };
  switch (edge) {
    case "left":
      r.x = area.x - rect.w + strip;
      break;
    case "right":
      r.x = area.x + area.w - strip;
      break;
    case "top":
      r.y = area.y - rect.h + strip;
      break;
    case "bottom":
      r.y = area.y + area.h - strip;
      break;
  }
  return r;
}

// ── Smart Dock Capsule 几何 ─────────────────────────────────

/**
 * 胶囊真实可见的物理宽度：CSS 尺寸 × DPI 缩放（四舍五入）。
 * 隐藏坐标必须用同一个值，否则胶囊内容会被窗口边界裁切。
 * 100%→32 · 125%→40 · 150%→48 · 200%→64。
 */
export function capsuleStripPhysical(scaleFactor: number): number {
  const s = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return Math.max(12, Math.round(CAPSULE_THICKNESS_CSS * s));
}

/** 胶囊唤出判定距离（物理）：胶囊厚度 + 接近带，随 DPI 缩放。 */
export function capsuleRevealDistPhysical(scaleFactor: number): number {
  return capsuleStripPhysical(scaleFactor) + SNAP_REVEAL_APPROACH;
}

/** 胶囊长度（物理）＝ round(120 × scale)；沿边方向命中区段据此计算。 */
export function capsuleLengthPhysical(scaleFactor: number): number {
  const s = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return Math.max(12, Math.round(CAPSULE_LENGTH_CSS * s));
}

/** 磁吸两段齐平的第一段位置：把窗口移到距 edge 恰好 gap 物理像素处（沿边 clamp 同齐平位）。 */
export function approachPositionFor(
  rect: SnapRect,
  area: SnapArea,
  edge: SnapEdge,
  gap: number,
): SnapRect {
  const docked = clampDockedPosition(rect, area, edge);
  const r = { ...docked };
  const g = Math.max(0, gap);
  switch (edge) {
    case "left":
      r.x = area.x + g;
      break;
    case "right":
      r.x = area.x + area.w - r.w - g;
      break;
    case "top":
      r.y = area.y + g;
      break;
    case "bottom":
      r.y = area.y + area.h - r.h - g;
      break;
  }
  return r;
}

/**
 * 胶囊交互走廊：以「隐藏后窗口」的沿边区段为基准，
 * 法向 0（屏边）到 thickness + margin、沿边 ± margin 的带状区域。
 * 展开状态下（窗口齐平）沿边区段一致，可直接用当前 rect 计算。
 */
export function cursorInCapsuleCorridor(
  cursor: SnapPoint,
  area: SnapArea,
  edge: SnapEdge,
  windowRect: SnapRect,
  thickness: number,
  margin: number = SNAP_CORRIDOR_MARGIN,
): boolean {
  const d = cursorEdgeDistance(cursor, area, edge);
  if (d < -margin || d > thickness + margin) return false;
  const spanStart = edge === "left" || edge === "right" ? windowRect.y : windowRect.x;
  const spanEnd =
    edge === "left" || edge === "right" ? windowRect.y + windowRect.h : windowRect.x + windowRect.w;
  return edge === "left" || edge === "right"
    ? cursor.y >= spanStart - margin && cursor.y <= spanEnd + margin
    : cursor.x >= spanStart - margin && cursor.x <= spanEnd + margin;
}

// ── 多屏接缝（内部边 vs 桌面外边缘）────────────────────────

function boundsEqual(a: SnapArea, b: SnapArea, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance &&
    Math.abs(a.h - b.h) <= tolerance
  );
}

/**
 * 判断停靠显示器的某条边是否为**内部接缝**（边缘外侧紧贴另一台显示器）。
 * 返回相邻显示器 bounds；桌面外边缘返回 null。
 * 用于安全降级：接缝处允许停靠（齐平贴边），但**不得自动隐藏**——
 * 把窗口滑出 A 会整体进入邻屏 B（并未隐藏），还会造成跨屏切片与丢失唤出入口。
 */
export function findAdjacentMonitorAcrossEdge(
  area: SnapArea,
  edge: SnapEdge,
  monitors: readonly SnapArea[],
  tolerance: number = SNAP_SEAM_TOLERANCE,
): SnapArea | null {
  for (const m of monitors) {
    if (boundsEqual(m, area, tolerance)) continue; // 自己
    // 垂直/水平方向必须有实际重叠（> 容差），排除仅角点相触的斜排屏
    if (edge === "left" || edge === "right") {
      const overlap =
        Math.min(area.y + area.h, m.y + m.h) - Math.max(area.y, m.y);
      if (overlap <= tolerance) continue;
      if (edge === "left" && Math.abs(m.x + m.w - area.x) <= tolerance) return m;
      if (edge === "right" && Math.abs(m.x - (area.x + area.w)) <= tolerance) return m;
    } else {
      const overlap = Math.min(area.x + area.w, m.x + m.w) - Math.max(area.x, m.x);
      if (overlap <= tolerance) continue;
      if (edge === "top" && Math.abs(m.y + m.h - area.y) <= tolerance) return m;
      if (edge === "bottom" && Math.abs(m.y - (area.y + area.h)) <= tolerance) return m;
    }
  }
  return null;
}

// ── 胶囊区段（唤出命中以胶囊为准，不再按整窗跨度）──────────

/** 胶囊沿边区段：居中于窗口沿边跨度，长度 min(lengthPhys, 窗口跨度)。 */
export function capsuleSpanFor(
  windowRect: SnapRect,
  edge: SnapEdge,
  lengthPhys: number,
): { start: number; end: number } {
  const spanStart = edge === "left" || edge === "right" ? windowRect.y : windowRect.x;
  const spanLen = edge === "left" || edge === "right" ? windowRect.h : windowRect.w;
  const center = spanStart + spanLen / 2;
  const half = Math.max(0, Math.min(lengthPhys / 2, spanLen / 2));
  return { start: center - half, end: center + half };
}

/**
 * 胶囊唤出命中（v2）：边缘距离 0..thickness+approach **且** 沿边坐标落在
 * **胶囊区段**（居中、± margin）内——修复旧实现按整窗跨度判定、把整条
 * 屏幕边缘都当成唤出区的问题。
 */
export function cursorNearCapsule(
  cursor: SnapPoint,
  area: SnapArea,
  edge: SnapEdge,
  windowRect: SnapRect,
  opts: { thicknessPhys: number; lengthPhys: number; margin?: number; approach?: number },
): boolean {
  const d = cursorEdgeDistance(cursor, area, edge);
  if (d < 0 || d > opts.thicknessPhys + (opts.approach ?? SNAP_REVEAL_APPROACH)) return false;
  const span = capsuleSpanFor(windowRect, edge, opts.lengthPhys);
  const margin = opts.margin ?? SNAP_CORRIDOR_MARGIN;
  return edge === "left" || edge === "right"
    ? cursor.y >= span.start - margin && cursor.y <= span.end + margin
    : cursor.x >= span.start - margin && cursor.x <= span.end + margin;
}

// ── 光标判定 ────────────────────────────────────────────────

/** 光标是否在窗口矩形（外扩 margin）内。 */
export function cursorOverWindow(
  cursor: SnapPoint,
  rect: SnapRect,
  margin: number = SNAP_HIDE_MARGIN,
): boolean {
  return (
    cursor.x >= rect.x - margin &&
    cursor.x <= rect.x + rect.w + margin &&
    cursor.y >= rect.y - margin &&
    cursor.y <= rect.y + rect.h + margin
  );
}

/** 光标到工作区某条边的法向距离（负值 = 在屏幕外方向）。 */
export function cursorEdgeDistance(cursor: SnapPoint, area: SnapArea, edge: SnapEdge): number {
  switch (edge) {
    case "left":
      return cursor.x - area.x;
    case "right":
      return area.x + area.w - cursor.x;
    case "top":
      return cursor.y - area.y;
    case "bottom":
      return area.y + area.h - cursor.y;
  }
}

/**
 * 唤出命中判定（需求 E）：必须**同时**满足
 * 1. 光标距该屏幕边缘 0 ≤ d ≤ revealDist（贴边但不越过到另一屏）；
 * 2. 光标沿边坐标落在窗口触发条区段内（± margin）——在边缘其他位置悬停不唤出。
 * span 由隐藏窗口 rect 的沿边跨度给出（left/right → y..y+h；top/bottom → x..x+w）。
 */
export function cursorNearTriggerStrip(
  cursor: SnapPoint,
  area: SnapArea,
  edge: SnapEdge,
  windowRect: SnapRect,
  opts: { revealDist?: number; segmentMargin?: number } = {},
): boolean {
  const revealDist = opts.revealDist ?? SNAP_REVEAL_DIST;
  const margin = opts.segmentMargin ?? SNAP_SEGMENT_MARGIN;
  const d = cursorEdgeDistance(cursor, area, edge);
  if (d < 0 || d > revealDist) return false;
  const spanStart = edge === "left" || edge === "right" ? windowRect.y : windowRect.x;
  const spanEnd =
    edge === "left" || edge === "right" ? windowRect.y + windowRect.h : windowRect.x + windowRect.w;
  // 负坐标多屏下光标坐标可以为负：只需 edge 距离与区段两条约束，不做非负假设
  return edge === "left" || edge === "right"
    ? cursor.y >= spanStart - margin && cursor.y <= spanEnd + margin
    : cursor.x >= spanStart - margin && cursor.x <= spanEnd + margin;
}

/**
 * 停靠确认条件（磁吸释放判定）：
 * - candidate 相位 + 拖动已静默 settle；
 * - 且「光标已离开窗口」**或**「静默期后收到过 DOM 指针事件」。
 * 原生标题栏拖拽期间 WebView2 收不到任何 DOM 指针事件；一旦松手恢复
 * 事件流，domPointerAfterMove 即为 true——这是比「光标出窗」更可靠的
 * 松手信号（不要求用户松手后把鼠标移开）。
 */
export function shouldConfirmDock(
  phase: SnapPhase,
  edge: SnapEdge | null,
  sinceLastMoveMs: number,
  cursorInsideWindow: boolean,
  domPointerAfterMove: boolean = false,
): boolean {
  return (
    phase === "candidate" &&
    edge !== null &&
    sinceLastMoveMs >= SNAP_DRAG_SETTLE_MS &&
    (!cursorInsideWindow || domPointerAfterMove)
  );
}

/** candidate 提示兜底超时（松手后光标一直留在窗口上时提示不永久残留）。 */
export function shouldExpireCandidate(phase: SnapPhase, sinceLastMoveMs: number): boolean {
  return phase === "candidate" && sinceLastMoveMs >= SNAP_CANDIDATE_TIMEOUT_MS;
}

// ── 磁吸滞回与防抖判定（时间积分，禁止单点采样直接触发）─────

/** 磁吸滞回退出判定：candidate 退出 / 停靠解除统一用 > EXIT_DIST。 */
export function shouldLeaveMagnetRange(distance: number): boolean {
  return distance > SNAP_CANDIDATE_EXIT_DIST;
}

/** 唤出驻留确认：光标在唤出区持续 ≥ dwell 才展开（dwellSince 为首次进入时刻）。 */
export function shouldRevealByDwell(dwellSinceMs: number | null, now: number): boolean {
  return dwellSinceMs !== null && now - dwellSinceMs >= SNAP_REVEAL_DWELL_MS;
}

/** 展开保护期：保护期内禁止自动隐藏（防 reveal→hide 循环抖动）。 */
export function isRevealProtected(revealedAtMs: number, now: number): boolean {
  return now - revealedAtMs < SNAP_REVEAL_PROTECT_MS;
}

/** 连续离开确认：离开有效交互区持续 ≥ leave 阈值才隐藏。 */
export function shouldHideAfterLeave(leftSinceMs: number | null, now: number): boolean {
  return leftSinceMs !== null && now - leftSinceMs >= SNAP_HIDE_LEAVE_MS;
}

/** 程序移动后的坐标静默期：setPosition 跨进程异步，期间坐标可能未刷新。 */
export function isMoveSettling(lastEngineMoveAtMs: number, now: number): boolean {
  return now - lastEngineMoveAtMs < SNAP_MOVE_SETTLE_QUIET_MS;
}

// ── 可见性校验（多屏 / 负坐标 / 断连）───────────────────────

export function intersectionArea(a: SnapRect, b: SnapRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** rect 与显示器边界的可见面积占比（0~1；rect 无效时为 0）。 */
export function visibleFraction(rect: SnapRect, monitorBounds: SnapArea): number {
  const area = rect.w * rect.h;
  if (area <= 0) return 0;
  return intersectionArea(rect, monitorBounds) / area;
}

/**
 * rect 是否「大部分可见」：与所有显示器交集的**总面积** ≥ fraction × rect 面积。
 * 按总面积而非单屏判定：跨屏窗口（单屏占比 50%）同样是用户的有效位置。
 * monitors 为空（断连/获取失败）时返回 false——宁可放弃持久化，
 * 也不把可能屏外的坐标写进 window_rect。
 */
export function isRectMostlyVisible(
  rect: SnapRect,
  monitors: readonly SnapArea[],
  fraction: number = PERSIST_VISIBLE_FRACTION,
): boolean {
  if (rect.w <= 0 || rect.h <= 0) return false;
  if (!monitors || monitors.length === 0) return false;
  const area = rect.w * rect.h;
  let visible = 0;
  for (const m of monitors) visible += intersectionArea(rect, m);
  return visible / area >= fraction;
}

// ── 程序移动守卫（window_rect 防污染）──────────────────────

export interface ProgrammaticMoveRecord {
  x: number;
  y: number;
  at: number;
}

/**
 * 区分「用户拖动」与「程序 setPosition」：引擎每次程序移动前登记目标，
 * 持久化钩子遇到与目标吻合（±tolerance）且未过期的 onMoved 直接忽略。
 * TTL 过期后（含 setPosition 失败、系统 intervening move）自动失效，
 * 兜底交给 isRectMostlyVisible 可见性校验。
 */
export function createSnapMoveGuard(now: () => number = () => Date.now()) {
  let last: ProgrammaticMoveRecord | null = null;
  let hidden = false;
  return {
    /** 引擎即将执行 setPosition 前调用。 */
    noteProgrammaticMove(x: number, y: number): void {
      last = { x, y, at: now() };
    },
    /** onMoved/持久化路径调用：命中最近一次程序移动目标则应跳过保存。 */
    isProgrammaticMove(x: number, y: number, at: number = now()): boolean {
      if (!last) return false;
      if (at - last.at > PROGRAMMATIC_MOVE_TTL_MS) {
        last = null;
        return false;
      }
      return (
        Math.abs(x - last.x) <= PROGRAMMATIC_MOVE_TOLERANCE &&
        Math.abs(y - last.y) <= PROGRAMMATIC_MOVE_TOLERANCE
      );
    },
    /** 当前是否处于隐藏态（隐藏期一律不持久化 window_rect）。 */
    isHidden(): boolean {
      return hidden;
    },
    setHidden(v: boolean): void {
      hidden = v;
    },
    /** 测试辅助：清空记录。 */
    reset(): void {
      last = null;
      hidden = false;
    },
  };
}

export type SnapMoveGuard = ReturnType<typeof createSnapMoveGuard>;

/** 引擎与持久化钩子共享的单例（同一次 setPosition 的双方通过它对齐）。 */
export const snapMoveGuard = createSnapMoveGuard();
