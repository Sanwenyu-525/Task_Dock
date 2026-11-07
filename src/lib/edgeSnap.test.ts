//! 贴边吸附纯逻辑单测：坐标计算 / 状态机 / 候选判定 / 触发条命中 /
//! 可见性与持久化校验 / 程序移动守卫。
//!
//! 坐标全部为物理像素。除 1080p@100% 外，额外覆盖 150% DPI（2880×1620）
//! 与负坐标多屏（副屏在主屏左侧 x=-1920）。

import { describe, expect, it } from "vitest";
import {
  CAPSULE_THICKNESS_CSS,
  EDGE_LABELS,
  GEOMETRY_ROLLBACK_TTL_MS,
  PERSIST_VISIBLE_FRACTION,
  PROGRAMMATIC_MOVE_TTL_MS,
  SNAP_CANDIDATE_DIST,
  SNAP_CANDIDATE_ENTER_DIST,
  SNAP_CANDIDATE_EXIT_DIST,
  SNAP_CANDIDATE_TIMEOUT_MS,
  SNAP_CORRIDOR_MARGIN,
  SNAP_DRAG_SETTLE_MS,
  SNAP_HIDE_LEAVE_MS,
  SNAP_MOVE_SETTLE_QUIET_MS,
  SNAP_MAGNET_MAX_LEAD,
  SNAP_MAGNET_RANGE,
  SNAP_MAGNET_REARM,
  SNAP_MAGNET_RELEASE,
  SNAP_PULL_IN_GAP,
  SNAP_UNDOCK_DRAG_PX,
  SNAP_REVEAL_DWELL_MS,
  SNAP_REVEAL_PROTECT_MS,
  SNAP_STRIP,
  type SnapArea,
  type SnapRect,
  approachPositionFor,
  canAutoHide,
  canTransition,
  capsuleRevealDistPhysical,
  capsuleStripPhysical,
  clampDockedPosition,
  createSnapMoveGuard,
  cursorInCapsuleCorridor,
  cursorNearTriggerStrip,
  cursorOverWindow,
  detectCandidateEdge,
  nearestDockEdge,
  alongDeviation,
  dockFeedbackText,
  edgeDistance,
  hiddenPositionFor,
  isMoveSettling,
  isRectMostlyVisible,
  isRevealProtected,
  isSnapEdge,
  isCapsuleMode,
  isFullDockPhase,
  shouldConfirmDock,
  shouldExpireCandidate,
  shouldHideAfterLeave,
  normalDeviation,
  rebaseAlong,
  shouldLeaveMagnetRange,
  shouldSwitchDockEdge,
  hasDockIntent,
  hasDockIntentAlongTrail,
  SNAP_DOCK_INTENT_CSS,
  shouldUndockByDrag,
  shouldRevealByDwell,
  visibleFraction,
  capsuleLengthPhysical,
  cursorNearCapsule,
  findAdjacentMonitorAcrossEdge,
  SNAP_SEAM_TOLERANCE,
  TITLEBAR_HEIGHT_CSS,
  measureTitlebarHeight,
  resetTitlebarHeightCache,
  undockAnchorTarget,
} from "./edgeSnap";

/** 主屏工作区（1920×1080，任务栏在底部时高度 1032）。 */
const WA: SnapArea = { x: 0, y: 0, w: 1920, h: 1032 };
/** 150% DPI 工作区（物理 2880×1620，任务栏 60 物理像素）。 */
const WA_150: SnapArea = { x: 0, y: 0, w: 2880, h: 1548 };
/** 负坐标副屏（在主屏左侧）。 */
const WA_NEG: SnapArea = { x: -1920, y: 0, w: 1920, h: 1032 };

const rect = (x: number, y: number, w = 400, h = 560): SnapRect => ({ x, y, w, h });

describe("候选边判定 detectCandidateEdge", () => {
  it("四条边各在候选距离内被识别", () => {
    expect(detectCandidateEdge(rect(10, 300), WA)).toBe("left");
    expect(detectCandidateEdge(rect(1920 - 400 - 20, 300), WA)).toBe("right");
    expect(detectCandidateEdge(rect(700, 8), WA)).toBe("top");
    expect(detectCandidateEdge(rect(700, 1032 - 560 - 15), WA)).toBe("bottom");
  });

  it("超过候选距离返回 null", () => {
    expect(detectCandidateEdge(rect(SNAP_CANDIDATE_DIST + 1, 300), WA)).toBeNull();
    expect(detectCandidateEdge(rect(700, SNAP_CANDIDATE_DIST + 1), WA)).toBeNull();
  });

  it("恰在边界距离上仍算候选", () => {
    expect(detectCandidateEdge(rect(SNAP_CANDIDATE_DIST, 300), WA)).toBe("left");
  });

  it("四角同时贴近两条边时取距离更小者", () => {
    // 左上角：距左 4px、距顶 20px → 左
    expect(detectCandidateEdge(rect(4, 20), WA)).toBe("left");
    // 右下角：距底 2px、距右 18px → 底
    expect(detectCandidateEdge(rect(1920 - 400 - 18, 1032 - 560 - 2), WA)).toBe("bottom");
  });

  it("窗口中心在沿边跨度外不判候选（防另一屏/工作区外误判）", () => {
    // 窗口几乎整体在任务栏下方（中心 y > 工作区底），距左再近也不是 left 候选
    const below = rect(2, 1032 - 20, 400, 560);
    expect(detectCandidateEdge(below, WA)).not.toBe("left");
  });

  it("负坐标副屏上同样成立", () => {
    expect(detectCandidateEdge(rect(-1920 + 6, 300), WA_NEG)).toBe("left");
    expect(detectCandidateEdge(rect(-1920 + 1920 - 400 - 12, 300), WA_NEG)).toBe("right");
  });

  it("edgeDistance 的符号语义：越出边为负", () => {
    expect(edgeDistance(rect(-30, 0), WA, "left")).toBe(-30);
    expect(edgeDistance(rect(0, 0), WA, "left")).toBe(0);
  });
});

describe("程序化再吸附选边 nearestDockEdge", () => {
  it("不设阈值：屏幕中央也返回最近边（候选判定在此距离会返回 null）", () => {
    // 中央窗口：距左 760、距右 760、距顶 236、距顶更近 → top
    expect(nearestDockEdge(rect(760, 236), WA)).toBe("top");
    // detectCandidateEdge 默认阈值下同一位置不是候选，语义差异就在这
    expect(detectCandidateEdge(rect(760, 236), WA)).toBeNull();
  });

  it("四边各取最近", () => {
    expect(nearestDockEdge(rect(6, 300), WA)).toBe("left");
    expect(nearestDockEdge(rect(1920 - 400 - 3, 300), WA)).toBe("right");
    expect(nearestDockEdge(rect(700, 2), WA)).toBe("top");
    expect(nearestDockEdge(rect(700, 1032 - 560 - 1), WA)).toBe("bottom");
  });

  it("四角并列/双近时取距离更小者（与候选判定同一 tie-break）", () => {
    // 距左 4 < 距顶 20 → 左
    expect(nearestDockEdge(rect(4, 20), WA)).toBe("left");
    // 距底 2 < 距右 18 → 底
    expect(nearestDockEdge(rect(1920 - 400 - 18, 1032 - 560 - 2), WA)).toBe("bottom");
  });

  it("轻微越出边仍返回该边（用户把窗口压过边缘的意图）", () => {
    expect(nearestDockEdge(rect(-SNAP_CANDIDATE_EXIT_DIST, 300), WA)).toBe("left");
  });

  it("明显越出工作区（超过负向退出保护）返回 null，不猜边", () => {
    expect(nearestDockEdge(rect(-(SNAP_CANDIDATE_EXIT_DIST + 1), 300), WA)).toBeNull();
  });

  it("负坐标副屏上同样成立", () => {
    expect(nearestDockEdge(rect(-1920 + 6, 300), WA_NEG)).toBe("left");
    expect(nearestDockEdge(rect(-1920 + 1920 - 400 - 9, 300), WA_NEG)).toBe("right");
  });
});

// ── 越出轴不得遮蔽可达边（2026-11-08，capsule-redock 复核发现）──────────
//
// 真实缺陷：拖离恢复后的自由窗口底部越过工作区底缘（停靠位靠下 + 恢复尺寸
// 较高时必然发生）时，bottom 的负距离（< -EXIT）在 argmin 中永远小于其他边，
// 而总出口守卫又把它整体判为 null——用户明明把窗口拖到了左缘齐平位，
// detected 却恒为 null，永远无法重新吸附。修复语义：明显越出（超过负向
// 退出保护）的轴在选边时直接跳过，不得参与 argmin；滞回带内（-EXIT..0）
// 的轻微越出行为不变。
describe("越出轴不遮蔽可达边", () => {
  it("底部越出工作区的窗口齐平左缘：left 不被 bottom 负距离遮蔽", () => {
    // bottom 距离 = 1032 − (395+700) = −63（< −38，明显越出）
    const poking = rect(0, 395, 500, 700);
    expect(detectCandidateEdge(poking, WA)).toBe("left");
  });

  it("右缘越出工作区的窗口齐平顶缘：top 不被 right 负距离遮蔽", () => {
    // right 距离 = 1920 − (1433+550) = −63（< −38，明显越出）
    const poking = rect(1920 + 63 - 550, 0, 550, 700);
    expect(detectCandidateEdge(poking, WA)).toBe("top");
  });

  it("越出轴被跳过后其余边都不在候选距离内：候选仍返回 null（不猜边）", () => {
    // left 距离 100 > 24：候选判定 null
    expect(detectCandidateEdge(rect(100, 395, 500, 700), WA)).toBeNull();
  });

  it("nearestDockEdge 维持「明显越出 → 不猜边」契约（按钮入口语义不变）", () => {
    // 底部明显越出：按钮入口返回 null、由调用方失败收场（P3 注记：
    // 该入口对越出窗口提示重新定位，拖拽路径已修复不受此限）
    expect(nearestDockEdge(rect(0, 395, 500, 700), WA)).toBeNull();
    expect(nearestDockEdge(rect(100, 395, 500, 700), WA)).toBeNull();
  });

  it("越出轴在滞回带内（−EXIT..0）时行为不变：仍返回该边", () => {
    // bottom = 1032 − 1070 = −38：恰在退出保护边界，保留原语义
    const bandEdge = rect(0, 510, 500, 560);
    expect(nearestDockEdge(bandEdge, WA)).toBe("bottom");
  });
});

describe("停靠与隐藏坐标 clampDockedPosition / hiddenPositionFor", () => {
  it("left 停靠：贴紧左缘，沿边 y clamp 进工作区", () => {
    // y 超出底部 → 收回工作区内
    expect(clampDockedPosition(rect(10, 2000), WA, "left")).toEqual({ x: 0, y: 1032 - 560, w: 400, h: 560 });
    // y 为负 → 收回顶部
    expect(clampDockedPosition(rect(10, -80), WA, "left")).toEqual({ x: 0, y: 0, w: 400, h: 560 });
  });

  it("right / top / bottom 停靠齐平", () => {
    expect(clampDockedPosition(rect(1500, 100), WA, "right")).toMatchObject({ x: 1520, y: 100 });
    expect(clampDockedPosition(rect(700, -10), WA, "top")).toMatchObject({ y: 0, x: 700 });
    expect(clampDockedPosition(rect(700, 400), WA, "bottom")).toMatchObject({ y: 1032 - 560 });
  });

  it("窗口高于工作区时 clamp 不产生越界", () => {
    const tall = rect(10, 0, 400, 2000);
    const d = clampDockedPosition(tall, WA, "left");
    expect(d.y).toBe(0);
  });

  it("四边隐藏位置只留 SNAP_STRIP 物理像素", () => {
    expect(hiddenPositionFor(rect(0, 300), WA, "left")).toEqual({ x: -400 + SNAP_STRIP, y: 300, w: 400, h: 560 });
    expect(hiddenPositionFor(rect(1520, 300), WA, "right")).toEqual({ x: 1920 - SNAP_STRIP, y: 300, w: 400, h: 560 });
    expect(hiddenPositionFor(rect(700, 0), WA, "top")).toEqual({ x: 700, y: -560 + SNAP_STRIP, w: 400, h: 560 });
    expect(hiddenPositionFor(rect(700, 1032 - 560), WA, "bottom")).toEqual({
      x: 700,
      y: 1032 - SNAP_STRIP,
      w: 400,
      h: 560,
    });
  });

  it("150% DPI 下按物理像素计算（触发条仍为 12 物理像素）", () => {
    const r = rect(0, 600, 600, 840); // 物理尺寸（400 逻辑 × 1.5）
    const hidden = hiddenPositionFor(r, WA_150, "left");
    expect(hidden.x).toBe(-600 + 12);
    // 可见物理宽度恰为 SNAP_STRIP
    expect(hidden.x + hidden.w - WA_150.x).toBe(SNAP_STRIP);
  });

  it("负坐标副屏 left 隐藏：滑出到 -1920 左侧", () => {
    const hidden = hiddenPositionFor(rect(-1920, 300), WA_NEG, "left");
    expect(hidden.x).toBe(-1920 - 400 + SNAP_STRIP);
    expect(hidden.x + hidden.w - WA_NEG.x).toBe(SNAP_STRIP);
  });
});

describe("触发条命中 cursorNearTriggerStrip（需求 E：边缘距离 + 区段双约束）", () => {
  // 隐藏中的窗口：left 停靠，沿边跨度 y ∈ [300, 860]
  const hiddenLeft = hiddenPositionFor(rect(0, 300), WA, "left");

  it("边缘距离足够 + 区段内 → 命中", () => {
    expect(cursorNearTriggerStrip({ x: 8, y: 500 }, WA, "left", hiddenLeft)).toBe(true);
    expect(cursorNearTriggerStrip({ x: 19, y: 300 }, WA, "left", hiddenLeft)).toBe(true);
  });

  it("边缘距离够近但区段外 → 不命中（防全边误唤出）", () => {
    expect(cursorNearTriggerStrip({ x: 8, y: 100 }, WA, "left", hiddenLeft)).toBe(false);
    expect(cursorNearTriggerStrip({ x: 8, y: 1010 }, WA, "left", hiddenLeft)).toBe(false);
  });

  it("超过唤出距离 → 不命中", () => {
    expect(cursorNearTriggerStrip({ x: 40, y: 500 }, WA, "left", hiddenLeft)).toBe(false);
  });

  it("区段两端有 margin 放宽（易命中窄条）", () => {
    expect(cursorNearTriggerStrip({ x: 8, y: 300 - 12 }, WA, "left", hiddenLeft)).toBe(true);
    expect(cursorNearTriggerStrip({ x: 8, y: 860 + 12 }, WA, "left", hiddenLeft)).toBe(true);
    expect(cursorNearTriggerStrip({ x: 8, y: 300 - 13 }, WA, "left", hiddenLeft)).toBe(false);
  });

  it("bottom 停靠命中：水平区段约束", () => {
    const hiddenBottom = hiddenPositionFor(rect(700, 1032 - 560), WA, "bottom");
    expect(cursorNearTriggerStrip({ x: 800, y: 1030 }, WA, "bottom", hiddenBottom)).toBe(true);
    expect(cursorNearTriggerStrip({ x: 100, y: 1030 }, WA, "bottom", hiddenBottom)).toBe(false);
  });

  it("负坐标副屏 right 停靠命中", () => {
    const hiddenRight = hiddenPositionFor(rect(-1920 + 1920 - 400, 300), WA_NEG, "right");
    expect(cursorNearTriggerStrip({ x: -1920 + 1920 - 5, y: 500 }, WA_NEG, "right", hiddenRight)).toBe(true);
  });
});

describe("光标与窗口相对位置 cursorOverWindow", () => {
  it("窗口内/外扩 margin 内算 over", () => {
    const r = rect(0, 0);
    expect(cursorOverWindow({ x: 200, y: 200 }, r)).toBe(true);
    expect(cursorOverWindow({ x: 430, y: 200 }, r)).toBe(true); // 400 + 40 margin
    expect(cursorOverWindow({ x: 441, y: 200 }, r)).toBe(false);
  });
});

describe("状态机转移表 canTransition", () => {
  it("常规路径合法", () => {
    expect(canTransition("free", "candidate")).toBe(true);
    expect(canTransition("candidate", "docked-visible")).toBe(true);
    expect(canTransition("docked-visible", "docked-hidden")).toBe(true);
    expect(canTransition("docked-hidden", "docked-revealed")).toBe(true);
    expect(canTransition("docked-revealed", "docked-hidden")).toBe(true);
  });

  it("隐藏只能经 reveal（docked-hidden → docked-visible 非法）", () => {
    expect(canTransition("docked-hidden", "docked-visible")).toBe(false);
  });

  it("candidate 不能直接跳到隐藏（必须先确认停靠）", () => {
    expect(canTransition("candidate", "docked-hidden")).toBe(false);
  });

  it("设置关闭时 docked-hidden → free 合法（安全展开清理）", () => {
    expect(canTransition("docked-hidden", "free")).toBe(true);
    expect(canTransition("docked-visible", "free")).toBe(true);
  });

  it("重启恢复 free → docked-hidden 合法", () => {
    expect(canTransition("free", "docked-hidden")).toBe(true);
  });

  it("canAutoHide 只覆盖停靠可见相位", () => {
    expect(canAutoHide("docked-visible")).toBe(true);
    expect(canAutoHide("docked-revealed")).toBe(true);
    expect(canAutoHide("docked-hidden")).toBe(false);
    expect(canAutoHide("free")).toBe(false);
    expect(canAutoHide("candidate")).toBe(false);
  });

  it("isCapsuleMode：只看停靠相位，缺边也不回退主界面（防止控件落进残留裁剪区域）", () => {
    for (const phase of ["docked-visible", "docked-hidden", "docked-revealed"] as const) {
      expect(isCapsuleMode(phase)).toBe(true);
    }
    expect(isCapsuleMode("free")).toBe(false);
    expect(isCapsuleMode("candidate")).toBe(false);
    expect(isCapsuleMode("docked-full")).toBe(false);
  });
});

describe("停靠确认时序 shouldConfirmDock / shouldExpireCandidate", () => {
  it("静默未到 / 光标仍在窗口上时不确认", () => {
    expect(shouldConfirmDock("candidate", "left", SNAP_DRAG_SETTLE_MS - 1, false)).toBe(false);
    expect(shouldConfirmDock("candidate", "left", SNAP_DRAG_SETTLE_MS, true)).toBe(false);
  });

  it("静默到达且光标已离开 → 确认停靠", () => {
    expect(shouldConfirmDock("candidate", "left", SNAP_DRAG_SETTLE_MS, false)).toBe(true);
  });

  it("free/candidate 之外不确认；edge 为空不确认", () => {
    expect(shouldConfirmDock("docked-visible", "left", 10_000, false)).toBe(false);
    expect(shouldConfirmDock("candidate", null, 10_000, false)).toBe(false);
  });

  it("candidate 提示兜底超时", () => {
    expect(shouldExpireCandidate("candidate", SNAP_CANDIDATE_TIMEOUT_MS - 1)).toBe(false);
    expect(shouldExpireCandidate("candidate", SNAP_CANDIDATE_TIMEOUT_MS)).toBe(true);
    expect(shouldExpireCandidate("free", 99_999)).toBe(false);
  });
});

describe("可见性校验（多屏 / 负坐标 / 断连 / 重复隐藏防护）", () => {
  const MONITORS: SnapArea[] = [
    { x: 0, y: 0, w: 1920, h: 1080 },
    { x: -1920, y: 0, w: 1920, h: 1080 },
  ];

  it("完全在工作区内的 rect 可见", () => {
    expect(isRectMostlyVisible(rect(100, 100), MONITORS)).toBe(true);
  });

  it("跨屏窗口（主副屏各一半）可见", () => {
    const across = rect(-200, 100, 400, 560);
    expect(visibleFraction(across, MONITORS[0])).toBeGreaterThan(0);
    expect(isRectMostlyVisible(across, MONITORS)).toBe(true);
  });

  it("负坐标副屏上的窗口可见", () => {
    expect(isRectMostlyVisible(rect(-1800, 100), MONITORS)).toBe(true);
  });

  it("滑出后的隐藏位不可见 → 引擎据此拒绝重复隐藏", () => {
    // 左侧没有其他显示器（单屏布局）时，left 滑出位真正落在屏幕外
    const hidden = hiddenPositionFor(rect(0, 300), WA, "left");
    expect(isRectMostlyVisible(hidden, [MONITORS[0]])).toBe(false);
  });

  it("显示器断连（monitors 为空）→ 保守判不可见", () => {
    expect(isRectMostlyVisible(rect(100, 100), [])).toBe(false);
  });

  it("无效 rect 判不可见", () => {
    expect(isRectMostlyVisible({ x: 0, y: 0, w: 0, h: 0 }, MONITORS)).toBe(false);
    expect(isRectMostlyVisible({ x: 0, y: 0, w: -5, h: 100 }, MONITORS)).toBe(false);
  });

  it("可见占比达到阈值才通过", () => {
    // 1920 宽的 rect 放在 x=1200：与主屏交集 720/1920 = 37.5% < 60%
    const mostly = rect(1200, 100, 1920, 560);
    expect(visibleFraction(mostly, MONITORS[0])).toBeLessThan(PERSIST_VISIBLE_FRACTION);
    expect(isRectMostlyVisible(mostly, MONITORS)).toBe(false);
  });

  it("恢复位置有效性：停靠可见位有效、屏外 restore 无效", () => {
    const docked = clampDockedPosition(rect(10, 300), WA, "left");
    expect(isRectMostlyVisible(docked, MONITORS)).toBe(true);
    expect(isRectMostlyVisible({ x: -5000, y: 300, w: 400, h: 560 }, MONITORS)).toBe(false);
  });
});

describe("程序移动守卫 createSnapMoveGuard（window_rect 防污染）", () => {
  it("登记后的目标坐标被识别为程序移动", () => {
    const g = createSnapMoveGuard(() => 1000);
    g.noteProgrammaticMove(-1388, 300);
    expect(g.isProgrammaticMove(-1388, 300, 1100)).toBe(true);
    // 容差内视为同一次移动
    expect(g.isProgrammaticMove(-1390, 302, 1100)).toBe(true);
  });

  it("TTL 过期后不再匹配（防误伤后续用户拖动）", () => {
    const g = createSnapMoveGuard(() => 1000);
    g.noteProgrammaticMove(0, 0);
    expect(g.isProgrammaticMove(0, 0, 1000 + PROGRAMMATIC_MOVE_TTL_MS + 1)).toBe(false);
    // 过期后记录被清空
    expect(g.isProgrammaticMove(0, 0, 1000 + PROGRAMMATIC_MOVE_TTL_MS + 2)).toBe(false);
  });

  it("容差外视为用户移动", () => {
    const g = createSnapMoveGuard(() => 1000);
    g.noteProgrammaticMove(0, 0);
    expect(g.isProgrammaticMove(50, 0, 1100)).toBe(false);
  });

  it("hidden 标志独立于移动记录（隐藏期一律不持久化）", () => {
    const g = createSnapMoveGuard();
    expect(g.isHidden()).toBe(false);
    g.setHidden(true);
    expect(g.isHidden()).toBe(true);
    g.setHidden(false);
    expect(g.isHidden()).toBe(false);
  });

  it("几何回滚在有限时间内抑制持久化，过期后自动恢复", () => {
    const g = createSnapMoveGuard(() => 1000);
    expect(g.isPersistenceSuppressed(1000)).toBe(false);
    g.noteGeometryRollback();
    expect(g.isPersistenceSuppressed(1000)).toBe(true);
    expect(g.isPersistenceSuppressed(1000 + GEOMETRY_ROLLBACK_TTL_MS - 1)).toBe(true);
    expect(g.isPersistenceSuppressed(1000 + GEOMETRY_ROLLBACK_TTL_MS)).toBe(false);
    // 隐藏态仍然优先（隐藏期间不因回滚窗口过期而恢复写入）
    g.setHidden(true);
    expect(g.isPersistenceSuppressed(1000 + GEOMETRY_ROLLBACK_TTL_MS + 10)).toBe(true);
  });

  it("多次登记只保留最近目标；reset 清空（用例间隔离）", () => {
    let t = 1000;
    const g = createSnapMoveGuard(() => t);
    g.noteProgrammaticMove(100, 100);
    t = 2000;
    g.noteProgrammaticMove(2000, 2000);
    // 旧目标已被覆盖：既不匹配旧目标，也不在新目标 TTL 内匹配旧坐标
    expect(g.isProgrammaticMove(100, 100, 2100)).toBe(false);
    expect(g.isProgrammaticMove(2000, 2000, 2100)).toBe(true);
    g.reset();
    expect(g.isProgrammaticMove(2000, 2000, 2100)).toBe(false);
  });
});

describe("文案与类型守卫", () => {
  it("反馈文案覆盖四边", () => {
    for (const e of ["left", "right", "top", "bottom"] as const) {
      expect(dockFeedbackText(e)).toBe(`已吸附${EDGE_LABELS[e]}`);
    }
  });

  it("isSnapEdge 拒绝旧持久化中的 none/垃圾值", () => {
    expect(isSnapEdge("left")).toBe(true);
    expect(isSnapEdge("none")).toBe(false);
    expect(isSnapEdge("")).toBe(false);
    expect(isSnapEdge(42)).toBe(false);
  });
});

// ══ Smart Dock Capsule（磁吸 / 防抖 / 胶囊几何）══════════════

describe("胶囊几何 capsuleStripPhysical（CSS px ↔ 物理 px 严格对应）", () => {
  it("按 DPI 缩放取整：100%→32 · 125%→40 · 150%→48 · 200%→64", () => {
    expect(capsuleStripPhysical(1)).toBe(32);
    expect(capsuleStripPhysical(1.25)).toBe(40);
    expect(capsuleStripPhysical(1.5)).toBe(48);
    expect(capsuleStripPhysical(2)).toBe(64);
    expect(capsuleStripPhysical(1.75)).toBe(56);
  });

  it("非法 DPI 回退 1（不产生 0 宽度）", () => {
    expect(capsuleStripPhysical(0)).toBe(32);
    expect(capsuleStripPhysical(-1)).toBe(32);
    expect(capsuleStripPhysical(Number.NaN)).toBe(32);
  });

  it("隐藏位与胶囊 CSS 宽度一致：可见物理宽 == strip == CSS 厚度 × scale", () => {
    for (const scale of [1, 1.25, 1.5, 2]) {
      const strip = capsuleStripPhysical(scale);
      const hidden = hiddenPositionFor(rect(0, 300), WA, "left", strip);
      // 可见物理宽度 = 隐藏位右缘 − 工作区左缘
      expect(hidden.x + hidden.w - WA.x).toBe(strip);
      expect(strip / scale).toBe(CAPSULE_THICKNESS_CSS);
    }
  });

  it("四边隐藏位都以胶囊物理宽为露出量（150% DPI）", () => {
    const strip = capsuleStripPhysical(1.5); // 48
    expect(hiddenPositionFor(rect(0, 300), WA, "left", strip).x).toBe(-400 + 48);
    expect(hiddenPositionFor(rect(1520, 300), WA, "right", strip).x).toBe(1920 - 48);
    expect(hiddenPositionFor(rect(700, 0), WA, "top", strip).y).toBe(-560 + 48);
    expect(hiddenPositionFor(rect(700, 1032 - 560), WA, "bottom", strip).y).toBe(1032 - 48);
  });

  it("唤出判定距离随 DPI 覆盖胶囊厚度 + 接近带", () => {
    expect(capsuleRevealDistPhysical(1)).toBe(32 + 16);
    expect(capsuleRevealDistPhysical(1.5)).toBe(48 + 16);
  });

  it("磁吸两段齐平的第一段位置（approachPositionFor，四边）", () => {
    const wa: SnapArea = { x: 0, y: 0, w: 1920, h: 1032 };
    const r = rect(60, 300); // 距左 60
    expect(approachPositionFor(r, wa, "left", SNAP_PULL_IN_GAP)).toMatchObject({ x: 8 });
    expect(approachPositionFor(rect(1500, 300), wa, "right", SNAP_PULL_IN_GAP)).toMatchObject({
      x: 1920 - 400 - 8,
    });
    expect(approachPositionFor(rect(700, 100), wa, "top", SNAP_PULL_IN_GAP)).toMatchObject({ y: 8 });
    expect(approachPositionFor(rect(700, 700), wa, "bottom", SNAP_PULL_IN_GAP)).toMatchObject({
      y: 1032 - 560 - 8,
    });
    // 沿边坐标保持 clamp（不因靠近改变沿边位置）
    expect(approachPositionFor(rect(60, 2000), wa, "left", SNAP_PULL_IN_GAP)).toMatchObject({
      y: 1032 - 560,
    });
  });
});

describe("磁吸滞回 shouldLeaveMagnetRange（进入 24 / 退出 38）", () => {
  it("退出阈值严格大于 38（38 本身仍留在磁吸范围）", () => {
    expect(shouldLeaveMagnetRange(SNAP_CANDIDATE_ENTER_DIST)).toBe(false);
    expect(shouldLeaveMagnetRange(SNAP_CANDIDATE_EXIT_DIST)).toBe(false);
    expect(shouldLeaveMagnetRange(SNAP_CANDIDATE_EXIT_DIST + 1)).toBe(true);
    expect(shouldLeaveMagnetRange(200)).toBe(true);
  });

  it("死区（24–38）内既不退出也不重新进入：candidate 判定用进入阈值", () => {
    const wa: SnapArea = { x: 0, y: 0, w: 1920, h: 1032 };
    // 31px：在滞回带内
    const inBand = rect(SNAP_CANDIDATE_ENTER_DIST + 7, 300);
    expect(detectCandidateEdge(inBand, wa)).toBeNull(); // 新进入不触发（>24）
    expect(shouldLeaveMagnetRange(edgeDistance(inBand, wa, "left"))).toBe(false); // 已进入者不退出
  });

  it("明显越出边缘（如已隐藏窗口）不判候选（防隐藏矩形复活候选态）", () => {
    const wa: SnapArea = { x: 0, y: 0, w: 1920, h: 1032 };
    const hiddenRect = hiddenPositionFor(rect(0, 300), wa, "left");
    expect(detectCandidateEdge(hiddenRect, wa)).toBeNull();
  });
});

describe("唤出驻留 / 展开保护期 / 连续离开确认 / 坐标静默期", () => {
  it("驻留不足不展开，达到 dwell 才展开", () => {
    expect(shouldRevealByDwell(1000, 1000 + SNAP_REVEAL_DWELL_MS - 1)).toBe(false);
    expect(shouldRevealByDwell(1000, 1000 + SNAP_REVEAL_DWELL_MS)).toBe(true);
    expect(shouldRevealByDwell(null, 5000)).toBe(false);
  });

  it("展开保护期内禁止自动隐藏，过期后恢复", () => {
    expect(isRevealProtected(1000, 1000 + SNAP_REVEAL_PROTECT_MS - 1)).toBe(true);
    expect(isRevealProtected(1000, 1000 + SNAP_REVEAL_PROTECT_MS)).toBe(false);
  });

  it("连续离开未达阈值不隐藏，达到才隐藏（一次采样离开不触发）", () => {
    expect(shouldHideAfterLeave(2000, 2000 + SNAP_HIDE_LEAVE_MS - 1)).toBe(false);
    expect(shouldHideAfterLeave(2000, 2000 + SNAP_HIDE_LEAVE_MS)).toBe(true);
    expect(shouldHideAfterLeave(null, 9000)).toBe(false);
  });

  it("程序移动后的坐标静默期内不做判定", () => {
    expect(isMoveSettling(3000, 3000 + SNAP_MOVE_SETTLE_QUIET_MS - 1)).toBe(true);
    expect(isMoveSettling(3000, 3000 + SNAP_MOVE_SETTLE_QUIET_MS)).toBe(false);
  });

  it("磁吸释放确认：光标出窗或 DOM 指针恢复（松手信号）任一即可", () => {
    // 静默到达 + 光标在窗口上 + 无 DOM 事件（仍在原生拖拽中）→ 不确认
    expect(shouldConfirmDock("candidate", "left", SNAP_DRAG_SETTLE_MS, true, false)).toBe(false);
    // 静默到达 + DOM 指针事件晚于最后一次窗口移动（拖拽已结束）→ 确认
    expect(shouldConfirmDock("candidate", "left", SNAP_DRAG_SETTLE_MS, true, true)).toBe(true);
    // 光标已出窗（传统信号）→ 确认
    expect(shouldConfirmDock("candidate", "left", SNAP_DRAG_SETTLE_MS, false, false)).toBe(true);
  });
});

describe("胶囊交互走廊 cursorInCapsuleCorridor", () => {
  const wa: SnapArea = { x: 0, y: 0, w: 1920, h: 1032 };
  // 停靠可见位（齐平）：走廊沿边区段取窗口自身
  const docked = clampDockedPosition(rect(0, 300), wa, "left");
  const strip = capsuleStripPhysical(1);

  it("法向 0..thickness+margin、区段内命中", () => {
    expect(cursorInCapsuleCorridor({ x: 16, y: 400 }, wa, "left", docked, strip)).toBe(true);
    expect(cursorInCapsuleCorridor({ x: strip + SNAP_CORRIDOR_MARGIN, y: 400 }, wa, "left", docked, strip)).toBe(true);
    expect(
      cursorInCapsuleCorridor({ x: strip + SNAP_CORRIDOR_MARGIN + 1, y: 400 }, wa, "left", docked, strip),
    ).toBe(false);
  });

  it("区段外不命中（防全边走廊误保持）", () => {
    expect(cursorInCapsuleCorridor({ x: 16, y: 100 }, wa, "left", docked, strip)).toBe(false);
    expect(cursorInCapsuleCorridor({ x: 16, y: 1000 }, wa, "left", docked, strip)).toBe(false);
  });

  it("轻微负法向（窗口边框/阴影）仍命中", () => {
    expect(cursorInCapsuleCorridor({ x: -SNAP_CORRIDOR_MARGIN + 4, y: 400 }, wa, "left", docked, strip)).toBe(true);
    expect(cursorInCapsuleCorridor({ x: -SNAP_CORRIDOR_MARGIN - 5, y: 400 }, wa, "left", docked, strip)).toBe(false);
  });

  it("顶边横向走廊", () => {
    const dockedTop = clampDockedPosition(rect(700, 0), wa, "top");
    expect(cursorInCapsuleCorridor({ x: 800, y: 20 }, wa, "top", dockedTop, strip)).toBe(true);
    expect(cursorInCapsuleCorridor({ x: 100, y: 20 }, wa, "top", dockedTop, strip)).toBe(false);
  });
});

// ══ 系统性修复专项：多屏接缝 / 胶囊区段唤出 / 释放确认 ════════

describe("多屏接缝 findAdjacentMonitorAcrossEdge", () => {
  // 主屏 + 右侧邻屏（主屏右缘 = 邻屏左缘 = 1920）
  const MAIN: SnapArea = { x: 0, y: 0, w: 1920, h: 1080 };
  const RIGHT: SnapArea = { x: 1920, y: 0, w: 1920, h: 1080 };
  // 左侧负坐标邻屏
  const LEFT: SnapArea = { x: -1920, y: 0, w: 1920, h: 1080 };
  // 上下排列
  const BELOW: SnapArea = { x: 0, y: 1080, w: 1920, h: 1080 };

  it("右缘有邻屏 → right 是内部接缝，其余边是桌面外边缘", () => {
    expect(findAdjacentMonitorAcrossEdge(MAIN, "right", [MAIN, RIGHT])).toEqual(RIGHT);
    expect(findAdjacentMonitorAcrossEdge(MAIN, "left", [MAIN, RIGHT])).toBeNull();
    expect(findAdjacentMonitorAcrossEdge(MAIN, "top", [MAIN, RIGHT])).toBeNull();
    expect(findAdjacentMonitorAcrossEdge(MAIN, "bottom", [MAIN, RIGHT])).toBeNull();
  });

  it("左侧负坐标邻屏 → left 是接缝", () => {
    expect(findAdjacentMonitorAcrossEdge(MAIN, "left", [MAIN, LEFT])).toEqual(LEFT);
  });

  it("下侧邻屏 → bottom 是接缝；上侧是外边缘", () => {
    expect(findAdjacentMonitorAcrossEdge(MAIN, "bottom", [MAIN, BELOW])).toEqual(BELOW);
    expect(findAdjacentMonitorAcrossEdge(MAIN, "top", [MAIN, BELOW])).toBeNull();
  });

  it("双屏左右 + 上下同时存在时各边独立判定", () => {
    const all = [MAIN, RIGHT, LEFT, BELOW];
    expect(findAdjacentMonitorAcrossEdge(MAIN, "left", all)).toEqual(LEFT);
    expect(findAdjacentMonitorAcrossEdge(MAIN, "right", all)).toEqual(RIGHT);
    expect(findAdjacentMonitorAcrossEdge(MAIN, "bottom", all)).toEqual(BELOW);
    expect(findAdjacentMonitorAcrossEdge(MAIN, "top", all)).toBeNull();
  });

  it("仅角点相触的斜排屏不算接缝（垂直/水平重叠不足）", () => {
    const diagonal: SnapArea = { x: 1920, y: 1080, w: 1920, h: 1080 };
    // 只在 (1920,1080) 角点相触：右缘重叠为 0，不构成接缝
    expect(findAdjacentMonitorAcrossEdge(MAIN, "right", [MAIN, diagonal])).toBeNull();
    expect(findAdjacentMonitorAcrossEdge(MAIN, "bottom", [MAIN, diagonal])).toBeNull();
  });

  it("不把自身误判为邻屏；容差内边界抖动仍识别", () => {
    expect(findAdjacentMonitorAcrossEdge(MAIN, "right", [MAIN])).toBeNull();
    const jittered: SnapArea = { x: 1920 + SNAP_SEAM_TOLERANCE - 1, y: 2, w: 1920, h: 1076 };
    expect(findAdjacentMonitorAcrossEdge(MAIN, "right", [MAIN, jittered])).toEqual(jittered);
    // 超出容差的缝隙（断开的虚拟屏）不算接缝
    const gap: SnapArea = { x: 1920 + SNAP_SEAM_TOLERANCE + 8, y: 0, w: 1920, h: 1080 };
    expect(findAdjacentMonitorAcrossEdge(MAIN, "right", [MAIN, gap])).toBeNull();
  });
});

describe("胶囊区段唤出 cursorNearCapsule（修复整条边缘误判为唤出区）", () => {
  const wa: SnapArea = { x: 0, y: 0, w: 1920, h: 1032 };
  // 隐藏中的窗口：left 停靠，窗口沿边跨度 y ∈ [100, 660]（窗口高 560）
  const hiddenLeft = hiddenPositionFor(rect(0, 100), wa, "left");
  const thickness = capsuleStripPhysical(1); // 32
  const length = capsuleLengthPhysical(1); // 120
  // 胶囊区段（居中于窗口跨度）：center = 100 + 560/2 = 380 → [320, 440]

  it("胶囊区段内 + 边缘距离内 → 命中", () => {
    expect(cursorNearCapsule({ x: 16, y: 380 }, wa, "left", hiddenLeft, { thicknessPhys: thickness, lengthPhys: length })).toBe(true);
  });

  it("窗口跨度内但胶囊区段外 → 不命中（旧实现会误命中）", () => {
    // y=200 在窗口跨度 [100,932] 内，但在胶囊区段 [456,576] 之外
    expect(cursorNearCapsule({ x: 16, y: 200 }, wa, "left", hiddenLeft, { thicknessPhys: thickness, lengthPhys: length })).toBe(false);
    expect(cursorNearCapsule({ x: 16, y: 600 }, wa, "left", hiddenLeft, { thicknessPhys: thickness, lengthPhys: length })).toBe(false);
  });

  it("区段两端 ±margin 放宽后命中；再远不命中", () => {
    const m = SNAP_CORRIDOR_MARGIN;
    expect(cursorNearCapsule({ x: 16, y: 320 - m }, wa, "left", hiddenLeft, { thicknessPhys: thickness, lengthPhys: length })).toBe(true);
    expect(cursorNearCapsule({ x: 16, y: 320 - m - 1 }, wa, "left", hiddenLeft, { thicknessPhys: thickness, lengthPhys: length })).toBe(false);
  });

  it("边缘距离超过胶囊厚度 + 接近带 → 不命中", () => {
    expect(cursorNearCapsule({ x: 32 + 16 + 1, y: 516 }, wa, "left", hiddenLeft, { thicknessPhys: thickness, lengthPhys: length })).toBe(false);
  });

  it("顶边横向胶囊区段", () => {
    const hiddenTop = hiddenPositionFor(rect(600, 0, 720, 560), wa, "top");
    // 窗口 x ∈ [600,1320]，胶囊区段 x ∈ [600+300, 1320-300] = [900, 1020]
    expect(cursorNearCapsule({ x: 960, y: 20 }, wa, "top", hiddenTop, { thicknessPhys: thickness, lengthPhys: length })).toBe(true);
    expect(cursorNearCapsule({ x: 700, y: 20 }, wa, "top", hiddenTop, { thicknessPhys: thickness, lengthPhys: length })).toBe(false);
  });

  it("capsuleLengthPhysical 按 DPI 缩放", () => {
    expect(capsuleLengthPhysical(1)).toBe(120);
    expect(capsuleLengthPhysical(1.5)).toBe(180);
    expect(capsuleLengthPhysical(2)).toBe(240);
  });
});

describe("释放确认与长时间静止拖拽（需求 6.4/12.1）", () => {
  it("长时间静止拖拽（>8s 无移动且无 DOM 事件）由兜底超时退出 candidate", () => {
    // 静默到达但光标在窗口上、无 DOM 事件 → 不确认停靠（可能仍在拖拽）
    expect(shouldConfirmDock("candidate", "left", 10_000, true, false)).toBe(false);
    // 兜底：candidate 超时退出，提示不残留
    expect(shouldExpireCandidate("candidate", 10_000)).toBe(true);
    // 一旦松手（DOM 指针恢复或光标出窗）立即确认
    expect(shouldConfirmDock("candidate", "left", 10_000, true, true)).toBe(true);
    expect(shouldConfirmDock("candidate", "left", 10_000, false, false)).toBe(true);
  });
});

// ── 拖拽磁力：法向模型与跨端契约 ──────────────────────────────
//
// 曲线本身（吸引强度 / 阻力位移）在原生 `src-tauri/src/magnetic.rs` 实现并单测；
// 这里锁定**前端真正使用的判定**：法向位移、解除阈值、沿边正交性，
// 以及两端必须一致的参数（跨端契约，改动要同时改两边）。

describe("拖拽磁力：法向位移模型", () => {
  const base = { x: 0, y: 300 };

  it("四边一致：外法向位移为正，内推为负", () => {
    const rect = { x: 12, y: 340, w: 400, h: 420 };
    expect(normalDeviation(rect, base, "left")).toBe(12);
    expect(normalDeviation(rect, base, "right")).toBe(-12);
    expect(normalDeviation(rect, base, "top")).toBe(40);
    expect(normalDeviation(rect, base, "bottom")).toBe(-40);
  });

  it("沿边位移与法向位移正交（沿边滑动不得改变法向读数）", () => {
    const rect = { x: 0, y: 300 + 137, w: 400, h: 420 };
    expect(alongDeviation(rect, base, "left")).toBe(137);
    expect(normalDeviation(rect, base, "left")).toBe(0);
    // 水平停靠：沿边是 x
    const topBase = { x: 700, y: 0 };
    const moved = { x: 700 + 90, y: 0, w: 400, h: 420 };
    expect(alongDeviation(moved, topBase, "top")).toBe(90);
    expect(normalDeviation(moved, topBase, "top")).toBe(0);
  });

  it("解除判定只看沿法向拖出的距离", () => {
    // 沿边拖 200px：不是拖离
    expect(shouldUndockByDrag({ x: 0, y: 500, w: 400, h: 420 }, base, "left")).toBe(false);
    // 法向拖 24px：恰好等于阈值不解除（严格大于才算）
    expect(shouldUndockByDrag({ x: SNAP_UNDOCK_DRAG_PX, y: 300, w: 400, h: 420 }, base, "left")).toBe(
      false,
    );
    expect(
      shouldUndockByDrag({ x: SNAP_UNDOCK_DRAG_PX + 1, y: 300, w: 400, h: 420 }, base, "left"),
    ).toBe(true);
    // 往屏幕边里推（负位移）永远不是解除
    expect(shouldUndockByDrag({ x: -30, y: 300, w: 400, h: 420 }, base, "left")).toBe(false);
  });

  it("负坐标多屏（副屏在主屏左侧）同样正确", () => {
    const leftBase = { x: -1920, y: 100 };
    const rect = { x: -1920 + 30, y: 100, w: 400, h: 420 };
    expect(normalDeviation(rect, leftBase, "left")).toBe(30);
    expect(shouldUndockByDrag(rect, leftBase, "left")).toBe(true);
    // 副屏右缘（接缝）：外法向 = 坐标减小
    const seamBase = { x: -400, y: 100 };
    expect(normalDeviation({ x: -430, y: 100, w: 400, h: 420 }, seamBase, "right")).toBe(30);
  });

  it("沿边基准更新只采纳沿边分量：法向基准必须是真实齐平位", () => {
    // 拖动中窗口被磁力拉出 12px（法向）：基准不得跟着走
    const dragged = { x: 12, y: 480, w: 400, h: 420 };
    expect(rebaseAlong(dragged, base, "left")).toEqual({ x: 0, y: 480 });
    // 水平停靠只更新 x
    expect(rebaseAlong({ x: 760, y: 8, w: 400, h: 420 }, { x: 700, y: 0 }, "top")).toEqual({
      x: 760,
      y: 0,
    });
  });
});

describe("拖拽磁力：跨端契约常量", () => {
  it("与 src-tauri/src/magnetic.rs 的 MAGNET_* 同值", () => {
    // Rust 侧 `magnet_contract_matches_frontend` 断言同一组数字
    // 2026-11-02：吸引范围 56 → 50（用户反馈介入过早，收窄几个像素）
    expect(SNAP_MAGNET_RANGE).toBe(50);
    expect(SNAP_MAGNET_MAX_LEAD).toBe(16);
    expect(SNAP_MAGNET_RELEASE).toBe(32);
    expect(SNAP_MAGNET_REARM).toBe(96);
  });

  it("参数落在需求给定的手感区间内", () => {
    expect(SNAP_MAGNET_RANGE).toBeGreaterThanOrEqual(48);
    expect(SNAP_MAGNET_RANGE).toBeLessThanOrEqual(64);
    expect(SNAP_MAGNET_MAX_LEAD).toBeGreaterThanOrEqual(12);
    expect(SNAP_MAGNET_MAX_LEAD).toBeLessThanOrEqual(20);
    expect(SNAP_MAGNET_RELEASE).toBeGreaterThanOrEqual(28);
    expect(SNAP_MAGNET_RELEASE).toBeLessThanOrEqual(40);
    // 提交阈值必须小于释放阈值：否则会出现"已放手但仍判定未脱离"的空档
    expect(SNAP_UNDOCK_DRAG_PX).toBeLessThan(SNAP_MAGNET_RELEASE);
    // 重新武装距离必须大于吸引范围（否则脱离后立刻被吸回）
    expect(SNAP_MAGNET_REARM).toBeGreaterThan(SNAP_MAGNET_RANGE);
  });
});

// ── 拖离解除的鼠标锚定（与 Rust `magnetic::undock_anchor_rect` 同口径）──

describe("拖离解除锚定 undockAnchorTarget（标题栏中心 = 光标）", () => {
  const TB = 41; // 物理像素（100% DPI）

  it("光标在屏幕中部：窗口宽度中点对准光标 x；y 受任务栏钳制时取最小位移", () => {
    // 光标 y=500 处标题栏居中会让窗口下缘压进任务栏（480+560 > 1032），
    // 因此 y 钳到 472——光标仍在标题栏带（472..513）内
    const t = undockAnchorTarget({ x: 960, y: 500 }, { w: 400, h: 560 }, TB, WA);
    expect(t).toEqual({ x: 760, y: 472, w: 400, h: 560 });
    expect(500 >= t.y && 500 <= t.y + TB).toBe(true);
    // 光标更高时不受钳制：标题栏严格居中
    const free = undockAnchorTarget({ x: 960, y: 400 }, { w: 400, h: 560 }, TB, WA);
    expect(free.y).toBe(380);
    expect(400 >= free.y && 400 <= free.y + TB).toBe(true);
  });

  it("左缘：窗口不越出工作区，光标仍在窗口内", () => {
    const t = undockAnchorTarget({ x: 5, y: 500 }, { w: 400, h: 560 }, TB, WA);
    expect(t.x).toBe(0);
    expect(5 >= t.x && 5 <= t.x + t.w).toBe(true);
  });

  it("右缘：窗口右缘齐工作区，光标保持窗内", () => {
    const t = undockAnchorTarget({ x: 1915, y: 500 }, { w: 400, h: 560 }, TB, WA);
    expect(t.x + t.w).toBe(1920);
    expect(1915 >= t.x && 1915 <= t.x + t.w).toBe(true);
  });

  it("顶缘：窗口完整可见优先，光标不落窗外", () => {
    const t = undockAnchorTarget({ x: 900, y: 3 }, { w: 400, h: 560 }, TB, WA);
    expect(t.y).toBe(0);
    expect(3 >= t.y && 3 <= t.y + t.h).toBe(true);
  });

  it("底缘：窗口比剩余空间高时取最小位移（下缘齐工作区），光标保持窗内", () => {
    const t = undockAnchorTarget({ x: 900, y: 1030 }, { w: 400, h: 560 }, TB, WA);
    expect(t.y + t.h).toBe(1032);
    expect(1030 >= t.y && 1030 <= t.y + t.h).toBe(true);
  });

  it("负坐标多屏（副屏在主屏左侧）：几何正确", () => {
    const wa: SnapArea = { x: -1920, y: 0, w: 1920, h: 1032 };
    const t = undockAnchorTarget({ x: -1000, y: 400 }, { w: 400, h: 560 }, TB, wa);
    expect(t).toEqual({ x: -1200, y: 380, w: 400, h: 560 });
    const clamped = undockAnchorTarget({ x: -1915, y: 400 }, { w: 400, h: 560 }, TB, wa);
    expect(clamped.x).toBe(-1920);
    expect(-1915 >= clamped.x && -1915 <= clamped.x + clamped.w).toBe(true);
  });

  it("125% / 150% / 200% DPI：标题栏中心对准光标（±1px 取整误差）", () => {
    for (const scale of [1.25, 1.5, 2.0]) {
      const w = Math.round(400 * scale);
      const h = Math.round(560 * scale);
      const tb = Math.round(41 * scale);
      const wa: SnapArea = { x: 0, y: 0, w: Math.round(1920 * scale), h: Math.round(1032 * scale) };
      const cx = Math.round(960 * scale);
      // 光标取偏上位置，避免窗口下缘压进任务栏触发钳制（居中不受干扰）
      const cy = Math.round(400 * scale);
      const t = undockAnchorTarget({ x: cx, y: cy }, { w, h }, tb, wa);
      expect(Math.abs(t.x + Math.round(w / 2) - cx)).toBeLessThanOrEqual(1);
      expect(Math.abs(t.y + Math.round(tb / 2) - cy)).toBeLessThanOrEqual(1);
      // 光标在标题栏带内
      expect(cy >= t.y && cy <= t.y + tb).toBe(true);
    }
  });

  it("光标在任务栏上（工作区外）：按钳进工作区的参考光标摆放，窗口完整落在工作区", () => {
    const t = undockAnchorTarget({ x: 900, y: 1062 }, { w: 400, h: 560 }, TB, WA);
    expect(t.y + t.h).toBeLessThanOrEqual(1032);
  });

  it("不变量：工作区内任意光标都在结果窗口内且窗口完整可见；区外光标只要求完整可见", () => {
    for (const ox of [-1920, 0, 2560]) {
      for (const oy of [-400, 0, 800]) {
        const wa: SnapArea = { x: ox, y: oy, w: 1920, h: 1032 };
        // 工作区内（含边缘）：光标必须落在窗口内
        for (const cx of [ox, ox + 1, ox + 960, ox + 1919]) {
          for (const cy of [oy, oy + 1, oy + 500, oy + 1031]) {
            const t = undockAnchorTarget({ x: cx, y: cy }, { w: 400, h: 560 }, TB, wa);
            expect(cx >= t.x && cx <= t.x + t.w).toBe(true);
            expect(cy >= t.y && cy <= t.y + t.h).toBe(true);
            expect(t.x).toBeGreaterThanOrEqual(wa.x);
            expect(t.y).toBeGreaterThanOrEqual(wa.y);
            expect(t.x + t.w).toBeLessThanOrEqual(wa.x + wa.w);
            expect(t.y + t.h).toBeLessThanOrEqual(wa.y + wa.h);
          }
        }
        // 工作区外（任务栏/屏外）：几何上不可能既完整可见又含光标，
        // 只断言窗口完整可见
        for (const cx of [ox - 50, ox + 2000]) {
          const t = undockAnchorTarget({ x: cx, y: oy + 500 }, { w: 400, h: 560 }, TB, wa);
          expect(t.x).toBeGreaterThanOrEqual(wa.x);
          expect(t.x + t.w).toBeLessThanOrEqual(wa.x + wa.w);
          expect(t.y).toBeGreaterThanOrEqual(wa.y);
          expect(t.y + t.h).toBeLessThanOrEqual(wa.y + wa.h);
        }
      }
    }
  });

  it("窗口大于工作区：收敛到工作区尺寸，钳制区间恒合法", () => {
    const t = undockAnchorTarget({ x: 960, y: 500 }, { w: 4000, h: 3000 }, TB, WA);
    expect(t).toEqual({ x: 0, y: 0, w: 1920, h: 1032 });
  });

  it("非法标题栏高度（0 / NaN）按 0 处理，不产生 NaN 坐标", () => {
    expect(undockAnchorTarget({ x: 960, y: 400 }, { w: 400, h: 560 }, 0, WA).y).toBe(400);
    expect(undockAnchorTarget({ x: 960, y: 400 }, { w: 400, h: 560 }, Number.NaN, WA).y).toBe(400);
  });
});

describe("标题栏高度量取 measureTitlebarHeight", () => {
  it("无 DOM（node 环境）：回退设计常量 41（styles-themes 层 padding 9+6 + 内容 26）", () => {
    resetTitlebarHeightCache();
    expect(measureTitlebarHeight()).toBe(TITLEBAR_HEIGHT_CSS);
    expect(TITLEBAR_HEIGHT_CSS).toBe(41);
  });
});

describe("完整面板停靠态 docked-full（v1.0 形态切换）", () => {
  it("任意可停靠来源都能切到 docked-full（含重启恢复与已停靠原地切换）", () => {
    for (const from of ["free", "candidate", "docked-visible", "docked-hidden", "docked-revealed"] as const) {
      expect(canTransition(from, "docked-full")).toBe(true);
    }
  });

  it("docked-full 可原地切回胶囊（hidden/visible）或拖离恢复 free", () => {
    expect(canTransition("docked-full", "docked-hidden")).toBe(true);
    expect(canTransition("docked-full", "docked-visible")).toBe(true);
    expect(canTransition("docked-full", "free")).toBe(true);
  });

  it("docked-full 不回退到 candidate / 重复进入 docked-full", () => {
    expect(canTransition("docked-full", "candidate")).toBe(false);
    expect(canTransition("docked-full", "docked-full")).toBe(false);
  });

  it("完整面板不参与自动收缩：canAutoHide 不覆盖 docked-full", () => {
    expect(canAutoHide("docked-full")).toBe(false);
  });

  it("完整面板不进入胶囊模式（主界面保持完整可见、不挂载 CapsuleDock）", () => {
    expect(isCapsuleMode("docked-full")).toBe(false);
  });

  it("isFullDockPhase 只认 docked-full", () => {
    expect(isFullDockPhase("docked-full")).toBe(true);
    for (const p of ["free", "candidate", "docked-visible", "docked-hidden", "docked-revealed"] as const) {
      expect(isFullDockPhase(p)).toBe(false);
    }
  });
});

describe("沿边拖动的吸附意图与跨边守卫", () => {
  it("磁力领先范围内的平行拖动不算吸附意图", () => {
    // 起点距边 40、平行拖动（法向净位移 0）：仅“进入吸附区”不得吸附。
    expect(hasDockIntent(0)).toBe(false);
    expect(hasDockIntent(-20)).toBe(false);
    // 磁力领先上限本身（16）不足以构成意图，必须超过它再加余量。
    expect(hasDockIntent(SNAP_MAGNET_MAX_LEAD)).toBe(false);
    expect(hasDockIntent(SNAP_DOCK_INTENT_CSS)).toBe(true);
    expect(hasDockIntent(SNAP_DOCK_INTENT_CSS + 1)).toBe(true);
  });

  it("意图阈值随 DPI 缩放（物理像素）", () => {
    expect(hasDockIntent(SNAP_DOCK_INTENT_CSS * 1.5, 1.5)).toBe(true);
    expect(hasDockIntent(SNAP_DOCK_INTENT_CSS * 1.4, 1.5)).toBe(false);
    // 非法缩放回退 1，不放大阈值。
    expect(hasDockIntent(SNAP_DOCK_INTENT_CSS, 0)).toBe(true);
    expect(hasDockIntent(SNAP_DOCK_INTENT_CSS, Number.NaN)).toBe(true);
  });

  it("轨迹判定用按下时的真实起点：首个观测点已是合并后的大位移仍算意图", () => {
    // 按下时 (300,300)，首拍已到贴边 (20,300)：净接近 280，不能因起点丢失而漏判。
    expect(hasDockIntentAlongTrail(rect(300, 300), [rect(20, 300)], WA, "left")).toBe(true);
    // 按下时已在贴边位，平行拖动法向净位移 0：不算意图。
    expect(hasDockIntentAlongTrail(rect(20, 300), [rect(20, 900)], WA, "left")).toBe(false);
  });

  it("最近轨迹明显在远离该边时不算意图（磁力回弹 / 平行擦边）", () => {
    // 净位移足够，但最后一拍相对上一拍远离左缘 40（超过容差 6）。
    expect(
      hasDockIntentAlongTrail(rect(300, 300), [rect(20, 300), rect(60, 300)], WA, "left"),
    ).toBe(false);
    // 抖动 5px 在容差内，仍算意图。
    expect(
      hasDockIntentAlongTrail(rect(300, 300), [rect(20, 300), rect(25, 300)], WA, "left"),
    ).toBe(true);
  });

  it("轨迹判定四边一致", () => {
    expect(hasDockIntentAlongTrail(rect(1620, 300), [rect(1900, 300)], WA, "right")).toBe(true);
    expect(hasDockIntentAlongTrail(rect(700, 300), [rect(700, 0)], WA, "top")).toBe(true);
    expect(hasDockIntentAlongTrail(rect(700, 200), [rect(700, 472)], WA, "bottom")).toBe(true);
  });

  it("四边：仍齐平在当前边时禁止跨边切换", () => {
    expect(shouldSwitchDockEdge(rect(0, 300), WA, "left")).toBe(false);
    expect(shouldSwitchDockEdge(rect(1520, 300), WA, "right")).toBe(false);
    expect(shouldSwitchDockEdge(rect(700, 0), WA, "top")).toBe(false);
    expect(shouldSwitchDockEdge(rect(700, 472), WA, "bottom")).toBe(false);
  });

  it("四边：真正离开当前边磁吸区后允许跨边切换", () => {
    expect(shouldSwitchDockEdge(rect(120, 300), WA, "left")).toBe(true);
    expect(shouldSwitchDockEdge(rect(1400, 300), WA, "right")).toBe(true);
    expect(shouldSwitchDockEdge(rect(700, 120), WA, "top")).toBe(true);
    expect(shouldSwitchDockEdge(rect(700, 352), WA, "bottom")).toBe(true);
  });

  it("角落处的距离平手不会把沿边拖动判成换边", () => {
    // 左缘面板被沿边拖到贴着上缘：top 距离也是 0，但当前边仍齐平。
    const corner = rect(0, 0);
    const detected = detectCandidateEdge(corner, WA);
    // 候选边按固定顺序选择；守卫必须阻止「other !== edge」的跨边切换。
    expect(detected === "left" || detected === "top").toBe(true);
    expect(shouldSwitchDockEdge(corner, WA, "left")).toBe(false);
    expect(shouldSwitchDockEdge(corner, WA, "top")).toBe(false);
  });
});
