//! 贴边吸附纯逻辑单测：坐标计算 / 状态机 / 候选判定 / 触发条命中 /
//! 可见性与持久化校验 / 程序移动守卫。
//!
//! 坐标全部为物理像素。除 1080p@100% 外，额外覆盖 150% DPI（2880×1620）
//! 与负坐标多屏（副屏在主屏左侧 x=-1920）。

import { describe, expect, it } from "vitest";
import {
  CAPSULE_THICKNESS_CSS,
  EDGE_LABELS,
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
  SNAP_PULL_IN_GAP,
  SNAP_REVEAL_DWELL_MS,
  SNAP_REVEAL_PROTECT_MS,
  SNAP_STRIP,
  type SnapArea,
  type SnapRect,
  approachPositionFor,
  candidateHintText,
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
  dockFeedbackText,
  edgeDistance,
  hiddenPositionFor,
  isMoveSettling,
  isRectMostlyVisible,
  isRevealProtected,
  isSnapEdge,
  shouldConfirmDock,
  shouldExpireCandidate,
  shouldHideAfterLeave,
  shouldLeaveMagnetRange,
  shouldRevealByDwell,
  visibleFraction,
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
  it("反馈与提示文案覆盖四边", () => {
    for (const e of ["left", "right", "top", "bottom"] as const) {
      expect(dockFeedbackText(e)).toBe(`已吸附${EDGE_LABELS[e]}`);
      expect(candidateHintText(e)).toBe(`松开吸附${EDGE_LABELS[e]}`);
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

describe("磁吸滞回 shouldLeaveMagnetRange（进入 28 / 退出 42）", () => {
  it("退出阈值严格大于 42（42 本身仍留在磁吸范围）", () => {
    expect(shouldLeaveMagnetRange(SNAP_CANDIDATE_ENTER_DIST)).toBe(false);
    expect(shouldLeaveMagnetRange(SNAP_CANDIDATE_EXIT_DIST)).toBe(false);
    expect(shouldLeaveMagnetRange(SNAP_CANDIDATE_EXIT_DIST + 1)).toBe(true);
    expect(shouldLeaveMagnetRange(200)).toBe(true);
  });

  it("死区（28–42）内既不退出也不重新进入：candidate 判定用进入阈值", () => {
    const wa: SnapArea = { x: 0, y: 0, w: 1920, h: 1032 };
    // 35px：在滞回带内
    const inBand = rect(SNAP_CANDIDATE_ENTER_DIST + 7, 300);
    expect(detectCandidateEdge(inBand, wa)).toBeNull(); // 新进入不触发（>28）
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
