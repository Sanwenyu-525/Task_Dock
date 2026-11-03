/**
 * @vitest-environment jsdom
 */
//! 停靠坞（胶囊轨道）图标悬停提示的回归测试。
//!
//! 轨道是 Win32 区域裁剪窗口：`SetWindowRgn` 只露出可见区域，画在区域外的提示
//! 气泡不会被绘制。因此这里锁定三件事：
//! 1. 每个图标按钮都带 `data-tip`，文案取现成语义名（就是图标名）；
//! 2. 停靠坞展开态 `data-tip-placement` 一律朝**屏幕内侧（面板侧）**，四个停靠边镜像
//!    （左→right、右→left、上→bottom、下→top），四个分类与 Agent 状态球同规则；
//!    折叠态只剩 56px 翼片可画，退回沿轨道朝中心的方向（端头球向下/向右）；
//!    完整悬浮栏（未贴边停靠/自由位置）不套四边映射，保持原有「图标右侧」语义；
//! 3. 气泡矩形必须落在可见区域内：展开态落在**面板矩形**，折叠态落在**翼片多边形**；
//! 4. 气泡以图标**中心**对齐（top/bottom 比水平中心、left/right 比垂直中心），
//!    边缘收敛只发生在居中之后。

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CapsuleRail, {
  CAPSULE_TIP_COLLAPSE_OFFSET,
  CAPSULE_TIP_INWARD_OFFSET,
  capsuleTipInwardOffset,
  railTipPlacement,
} from "./CapsuleRail";
import type { RailStatus } from "../../lib/capsuleModel";
import type { SnapEdge } from "../../lib/edgeSnap";
import { computeTooltipPosition } from "../ui/TooltipLayer";
import { WING_AA_INSET, pointInPolygon, wingShape } from "../../lib/capsuleShape";
import {
  RAIL_THICKNESS_CSS,
  capsuleContainerSize,
  capsuleRegionsPhysical,
  pointInRoundedRect,
} from "../../lib/capsuleLayout";

const STATUS: RailStatus = {
  agentTone: "idle",
  agentAttention: 0,
  agentRunning: 0,
  agentsLoaded: true,
  taskBadge: null,
  pending: 0,
  overdue: 0,
  tasksLoaded: true,
  inboxBadge: null,
  inboxCount: null,
};

/** 四个停靠边：覆盖「朝内显示」的镜像规则。 */
const EDGES: SnapEdge[] = ["left", "right", "top", "bottom"];
/** 展开态应当返回的朝内方向（面板侧）。 */
const INWARD: Record<SnapEdge, string> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};

function tipsOf(edge: SnapEdge, expanded: boolean) {
  const { container } = render(
    <CapsuleRail
      edge={edge}
      status={STATUS}
      active="tasks"
      expanded={expanded}
      onSelect={() => {}}
      onCollapse={() => {}}
    />
  );
  return Array.from(container.querySelectorAll<HTMLElement>("[data-tip]")).map((el) => ({
    tip: el.dataset.tip,
    placement: el.dataset.tipPlacement,
    offset: el.dataset.tipOffset,
  }));
}

describe("胶囊轨道图标提示", () => {
  it("每个图标按钮的提示文案就是图标名（Agent 状态球 + 四个分类 + 收起）", () => {
    // 轨道四类由并行改动调整为「任务 / 收集箱 / 剪贴板 / 应用」，Agent 只在状态球。
    expect(tipsOf("right", true).map((t) => t.tip)).toEqual([
      "Agent",
      "任务",
      "收集箱",
      "剪贴板",
      "应用",
      "收起",
    ]);
  });

  it.each(EDGES)("edge=%s：展开态六个锚点一律朝屏幕内侧（面板侧）", (edge) => {
    expect(tipsOf(edge, true).map((t) => t.placement)).toEqual(Array(6).fill(INWARD[edge]));
  });

  it.each(EDGES)("edge=%s：展开态把气泡外扩到面板可见区内（按锚点边长换算）", (edge) => {
    // DOM 顺序：Agent 状态球 → 任务 / 收集箱 / 剪贴板 / 应用 → 收起
    const anchorSizes = [36, 36, 36, 36, 36, 26];
    expect(tipsOf(edge, true).map((t) => t.offset)).toEqual(
      anchorSizes.map((size) => String(capsuleTipInwardOffset(size)))
    );
    expect(CAPSULE_TIP_INWARD_OFFSET).toBe(20);
    expect(CAPSULE_TIP_COLLAPSE_OFFSET).toBe(25);
  });

  // 折叠态是**已确认的设计取舍**（见 docs/ui-themes/13-capsule-redesign.md §12.9）：
  // 可见区域只剩翼片，内侧没有像素可画，因此这里锁定「沿轨道朝中心」的现状，
  // 不是把折叠态期望成朝内。
  it("折叠态锁定现状：沿轨道朝中心（不是朝内）", () => {
    expect(tipsOf("right", false).map((t) => t.placement)).toEqual([
      "bottom",
      "top",
      "top",
      "top",
      "top",
      "top",
    ]);
    expect(tipsOf("left", false).map((t) => t.placement)).toEqual([
      "bottom",
      "top",
      "top",
      "top",
      "top",
      "top",
    ]);
    expect(tipsOf("top", false).map((t) => t.placement)).toEqual([
      "right",
      "left",
      "left",
      "left",
      "left",
      "left",
    ]);
    expect(tipsOf("bottom", false).map((t) => t.placement)).toEqual([
      "right",
      "left",
      "left",
      "left",
      "left",
      "left",
    ]);
  });

  it("折叠态不设置外扩距离（沿用 TooltipLayer 默认 6px）", () => {
    expect(tipsOf("left", false).every((t) => t.offset === undefined)).toBe(true);
  });

  it("railTipPlacement 只给出 TooltipLayer 白名单内的方向（停靠坞显式形态）", () => {
    expect(railTipPlacement("docked", "right", true)).toBe("left");
    expect(railTipPlacement("docked", "left", true)).toBe("right");
    expect(railTipPlacement("docked", "top", true)).toBe("bottom");
    expect(railTipPlacement("docked", "bottom", true)).toBe("top");
    // 折叠态：垂直向上、水平向左；端头球贴肩部，改为向下/向右
    expect(railTipPlacement("docked", "right", false, false)).toBe("top");
    expect(railTipPlacement("docked", "left", false, true)).toBe("bottom");
    expect(railTipPlacement("docked", "top", false, false)).toBe("left");
    expect(railTipPlacement("docked", "bottom", false, true)).toBe("right");
  });
});

describe("完整悬浮栏的提示方向（不套停靠四边映射）", () => {
  // 完整悬浮栏 = 未贴边停靠 / 自由位置的完整栏。方向保持原有语义「图标右侧」，
  // 与 Agent 面板一致；形态是显式输入，不能因为拿到一个 edge 就被带偏。
  it("floating 形态无论展开/折叠都是图标右侧", () => {
    expect(railTipPlacement("floating", null, false)).toBe("right");
    expect(railTipPlacement("floating", null, true)).toBe("right");
    expect(railTipPlacement("floating", null, false, true)).toBe("right");
  });

  it("floating 形态误传 edge 也不会套四边映射（防止边值串台）", () => {
    for (const edge of EDGES) {
      expect(railTipPlacement("floating", edge, true)).toBe("right");
      expect(railTipPlacement("floating", edge, false)).toBe("right");
    }
  });
});

describe("分类悬停指示块（白色翼片）", () => {
  it("四个分类按钮各有一个指示块；Agent 端头球与收起按钮没有（避免容器/端头重复触发）", () => {
    const { container } = render(
      <CapsuleRail
        edge="right"
        status={STATUS}
        active="tasks"
        expanded={false}
        onSelect={() => {}}
        onCollapse={() => {}}
      />
    );
    const tabs = container.querySelectorAll(".cap-edge-tab");
    expect(tabs.length).toBe(4);
    container.querySelectorAll(".cap-btn").forEach((btn) => {
      expect(btn.querySelectorAll(".cap-edge-tab").length).toBe(1);
    });
    expect(container.querySelector(".cap-orb .cap-edge-tab")).toBeNull();
    expect(container.querySelector(".cap-collapse .cap-edge-tab")).toBeNull();
  });
});

// ── 气泡落点几何：必须整个落在 Win32 区域之内 ────────────────────────────────
//
// 轨道按钮的位置不是自由排布：窗口区域只露出可见部分，落在区域外的像素不会被
// 绘制。下面用真实的几何函数（`wingShape` / `capsuleRegionsPhysical`）验证
// 「按 CSS 布局算出的按钮位置 + 按 TooltipLayer/Popover 算出的气泡矩形」落在区域内。
//
// 布局数字来自 src/styles.css：.cap-v/.cap-h 外框 400×56；.cap-orb 36 + 下间距 10；
// .cap-nav 168（4×36 + 3×8）；.cap-sep 1px + 上下各 6（共 13）；.cap-collapse 26。
// 气泡尺寸来自 src/styles-ui.css 的 .ui-tooltip（padding 5/8、1px 描边、字号 11、
// line-height 1.45）；最宽文案「剪贴板」按 3×11px 估。
const RAIL_LEN = 400;
const CAP_ITEM = 36;
const CONTENT = 36 + 10 + 168 + 13 + 26; // 253
const LEAD = { start: (RAIL_LEN - CONTENT) / 2, size: CAP_ITEM }; // 73.5 → 109.5
const CATEGORY = [0, 1, 2, 3].map((i) => ({ start: 119.5 + i * 44, size: CAP_ITEM }));
const COLLAPSE = { start: 300.5, size: 26 };
const SLOTS = [LEAD, ...CATEGORY, COLLAPSE];
const BUBBLE = { w: 3 * 11 + 8 * 2 + 2, h: Math.ceil(11 * 1.45) + 5 * 2 + 2 }; // 51 × 28
const DEFAULT_OFFSET = 6;

/** 折叠态气泡矩形：沿边方向按方向外扩，横跨方向以轨道中线居中（与 Popover 一致）。 */
function collapsedBubble(
  axis: "vertical" | "horizontal",
  slot: { start: number; size: number },
  placement: ReturnType<typeof railTipPlacement>
) {
  const along = axis === "vertical" ? BUBBLE.h : BUBBLE.w;
  const cross = axis === "vertical" ? BUBBLE.w : BUBBLE.h;
  const end = slot.start + slot.size;
  const span: [number, number] =
    placement === "bottom" || placement === "right"
      ? [end + DEFAULT_OFFSET, end + DEFAULT_OFFSET + along]
      : [slot.start - DEFAULT_OFFSET - along, slot.start - DEFAULT_OFFSET];
  const side: [number, number] = [
    RAIL_THICKNESS_CSS / 2 - cross / 2,
    RAIL_THICKNESS_CSS / 2 + cross / 2,
  ];
  return axis === "vertical" ? { xs: side, ys: span } : { xs: span, ys: side };
}

/** 矩形四角 + 中心的探测点。 */
function probePoints(rect: { xs: [number, number]; ys: [number, number] }, margin: number) {
  const x0 = rect.xs[0] + margin;
  const x1 = rect.xs[1] - margin;
  const y0 = rect.ys[0] + margin;
  const y1 = rect.ys[1] - margin;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
    { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
  ];
}

describe("轨道提示气泡落在 Win32 可见区域内", () => {
  it.each(EDGES)("edge=%s：折叠态 6 个图标的气泡都在翼片多边形内（含 2px 余量）", (edge) => {
    const axis = edge === "left" || edge === "right" ? "vertical" : "horizontal";
    const { box, outline } = wingShape(edge, 1, WING_AA_INSET);
    expect([box.w, box.h].sort((a, b) => a - b)).toEqual([RAIL_THICKNESS_CSS, RAIL_LEN]);

    const outside: string[] = [];
    SLOTS.forEach((slot, i) => {
      const placement = railTipPlacement("docked", edge, false, i === 0);
      const rect = collapsedBubble(axis, slot, placement);
      for (const p of probePoints(rect, 2)) {
        if (!pointInPolygon(p, outline)) outside.push(`slot${i}/${placement}@${p.x},${p.y}`);
      }
    });
    expect(outside).toEqual([]);
  });

  it.each(EDGES)("edge=%s：展开态 6 个图标的气泡都在面板可见矩形内", (edge) => {
    const size = capsuleContainerSize(edge);
    const regions = capsuleRegionsPhysical(size.w, size.h, edge, true, 1);
    const panel = regions.panel;
    expect(panel).not.toBeNull();
    if (!panel) return;

    const vertical = edge === "left" || edge === "right";
    const center = vertical
      ? regions.rail.x + RAIL_THICKNESS_CSS / 2
      : regions.rail.y + RAIL_THICKNESS_CSS / 2;
    const outside: string[] = [];

    SLOTS.forEach((slot, i) => {
      const placement = railTipPlacement("docked", edge, true, i === 0);
      expect(placement).toBe(INWARD[edge]);
      // 沿边坐标：气泡在另一条轴上以图标中心居中（Popover 的对应轴对齐语义）
      const alongStart = (vertical ? regions.rail.y : regions.rail.x) + slot.start;
      const alongCenter = alongStart + slot.size / 2;
      // 横跨坐标：从图标靠内侧的边再外扩该锚点自己的朝内距离
      // （36px 图标 20、26px 收起按钮 25；都保证气泡起点落在面板可见矩形内）
      const inward = capsuleTipInwardOffset(slot.size);
      const near = center + slot.size / 2 + inward;
      const far = near + (vertical ? BUBBLE.w : BUBBLE.h);
      let rect: { xs: [number, number]; ys: [number, number] };
      if (vertical) {
        const xs: [number, number] =
          edge === "left"
            ? [near, far]
            : [center - slot.size / 2 - inward - BUBBLE.w, center - slot.size / 2 - inward];
        rect = { xs, ys: [alongCenter - BUBBLE.h / 2, alongCenter + BUBBLE.h / 2] };
      } else {
        const ys: [number, number] =
          edge === "top"
            ? [near, far]
            : [center - slot.size / 2 - inward - BUBBLE.h, center - slot.size / 2 - inward];
        rect = { xs: [alongCenter - BUBBLE.w / 2, alongCenter + BUBBLE.w / 2], ys };
      }
      for (const p of probePoints(rect, 0)) {
        if (!pointInRoundedRect(p.x, p.y, panel, regions.panelRadius, 0)) {
          outside.push(`slot${i}/${placement}@${p.x},${p.y}`);
        }
      }
    });
    expect(outside).toEqual([]);
  });
});

// ── 气泡定位数学：以图标中心对齐 + 居中后再收敛 ──────────────────────────────
//
// 用户反馈气泡明显偏右：根因是定位按锚点左上角 + 固定距离，没做「中心换算」。
// 这里直接对 `computeTooltipPosition` 断言：top/bottom 比水平中心、left/right 比
// 垂直中心，偏差 ≤1px；offset 只调主方向距离；边缘收敛发生在居中之后。
describe("提示条以图标中心对齐（computeTooltipPosition）", () => {
  const VIEWPORT = { width: 1280, height: 800 };
  const TIP = { left: 0, top: 0, width: BUBBLE.w, height: BUBBLE.h };
  const ICON_SIZE = CAP_ITEM;
  // 四边各取贴边的图标位置，避免都在视口中央时互相掩盖
  const DOCK_ANCHOR: Record<SnapEdge, { left: number; top: number }> = {
    top: { left: 620, top: 0 },
    bottom: { left: 620, top: VIEWPORT.height - ICON_SIZE },
    left: { left: 0, top: 400 },
    right: { left: VIEWPORT.width - ICON_SIZE, top: 400 },
  };
  const DOCK_PLACEMENT: Record<SnapEdge, "top" | "bottom" | "left" | "right"> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  };

  function place(
    anchor: { left: number; top: number },
    placement: "top" | "bottom" | "left" | "right",
    offset: number,
  ) {
    return computeTooltipPosition(
      { left: anchor.left, top: anchor.top, width: ICON_SIZE, height: ICON_SIZE },
      TIP,
      placement,
      offset,
      VIEWPORT,
    );
  }

  it.each(EDGES)("停靠 %s 展开态：方向按四边映射，气泡中心与图标中心偏差 ≤1px", (edge) => {
    expect(railTipPlacement("docked", edge, true)).toBe(DOCK_PLACEMENT[edge]);
    const anchor = DOCK_ANCHOR[edge];
    const offset = capsuleTipInwardOffset(ICON_SIZE); // 36px 图标 → 20
    const pos = place(anchor, DOCK_PLACEMENT[edge], offset);
    expect(pos).not.toBeNull();
    if (!pos) return;

    const anchorCenterX = anchor.left + ICON_SIZE / 2;
    const anchorCenterY = anchor.top + ICON_SIZE / 2;
    const tipCenterX = pos.left + TIP.width / 2;
    const tipCenterY = pos.top + TIP.height / 2;
    if (DOCK_PLACEMENT[edge] === "top" || DOCK_PLACEMENT[edge] === "bottom") {
      expect(Math.abs(tipCenterX - anchorCenterX)).toBeLessThanOrEqual(1);
      // offset 只调主方向间距：气泡与锚点之间恰好 offset
      const gap =
        DOCK_PLACEMENT[edge] === "bottom"
          ? pos.top - (anchor.top + ICON_SIZE)
          : anchor.top - (pos.top + TIP.height);
      expect(gap).toBe(offset);
    } else {
      expect(Math.abs(tipCenterY - anchorCenterY)).toBeLessThanOrEqual(1);
      const gap =
        DOCK_PLACEMENT[edge] === "right"
          ? pos.left - (anchor.left + ICON_SIZE)
          : anchor.left - (pos.left + TIP.width);
      expect(gap).toBe(offset);
    }
  });

  it("完整悬浮栏：方向保持 right，气泡垂直中心与图标中心偏差 ≤1px", () => {
    // 完整悬浮栏锚点是主窗口左导航项（不是胶囊图标），用 40×40 验证不依赖胶囊尺寸
    const anchor = { left: 24, top: 500 };
    const pos = computeTooltipPosition(
      { left: anchor.left, top: anchor.top, width: 40, height: 40 },
      TIP,
      "right",
      6,
      VIEWPORT,
    );
    expect(railTipPlacement("floating", null, false)).toBe("right");
    expect(pos).not.toBeNull();
    if (!pos) return;
    expect(Math.abs(pos.top + TIP.height / 2 - (anchor.top + 20))).toBeLessThanOrEqual(1);
    expect(pos.left - (anchor.left + 40)).toBe(6);
  });

  it("offset 只调距离，不参与居中（0/6/20/64 垂直中心不变）", () => {
    const anchor = { left: 300, top: 400 };
    const centers = [0, 6, 20, 64].map((offset) => {
      const pos = place(anchor, "right", offset);
      expect(pos).not.toBeNull();
      return (pos as { left: number; top: number }).top + TIP.height / 2;
    });
    for (const center of centers) {
      expect(Math.abs(center - (anchor.top + ICON_SIZE / 2))).toBeLessThanOrEqual(1);
    }
  });

  it("贴近屏幕边缘：先居中后 clamp，气泡不出界且不压住图标", () => {
    // 左边缘：居中后 left 为负，clamp 到留白（允许相对图标轻微不对称）
    const anchor = { left: 0, top: 400 };
    const pos = place(anchor, "top", 6);
    expect(pos).not.toBeNull();
    if (!pos) return;
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + TIP.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
    expect(pos.top + TIP.height).toBeLessThanOrEqual(anchor.top);
    // 右边缘：主方向放不下时返回 null，交给 flip 兜底，而不是 clamp 进图标
    expect(place({ left: VIEWPORT.width - ICON_SIZE, top: 400 }, "right", 6)).toBeNull();
  });

  it("锚点/气泡尺寸为 0 或非有限值时安全回退（null，不产生 NaN 或跳跃）", () => {
    const ok = { left: 100, top: 100, width: ICON_SIZE, height: ICON_SIZE };
    expect(
      computeTooltipPosition({ ...ok, width: 0 }, TIP, "top", 6, VIEWPORT),
    ).toBeNull();
    expect(
      computeTooltipPosition({ ...ok, height: 0 }, TIP, "top", 6, VIEWPORT),
    ).toBeNull();
    expect(
      computeTooltipPosition({ ...ok, left: Number.NaN }, TIP, "top", 6, VIEWPORT),
    ).toBeNull();
    // 气泡尺寸为 0（首帧未测出宽度）
    expect(
      computeTooltipPosition(ok, { left: 0, top: 0, width: 0, height: TIP.height }, "top", 6, VIEWPORT),
    ).toBeNull();
    // 视口尺寸非有限值
    expect(
      computeTooltipPosition(ok, TIP, "top", 6, { width: Number.POSITIVE_INFINITY, height: 800 }),
    ).toBeNull();
  });
});
