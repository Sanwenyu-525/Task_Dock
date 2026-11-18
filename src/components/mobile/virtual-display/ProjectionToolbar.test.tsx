/**
 * @vitest-environment jsdom
 */
//! 投屏控制栏（一体化导航栏）测试：热区、Hover 不裁切、Tooltip 翻转/不拦截、
//! 禁用原因、更多菜单去重、布局模式、Session 绑定。
//!
//! 图标方向不在断言范围（既有实现已验收，禁止修改）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  calculateTooltipPosition,
  capabilitiesForSession,
  defaultProjectionCapabilities,
  filterDuplicateProjectionActions,
  getNavigationButtonSize,
  getNavigationContainerSize,
  getProjectionToolbarActions,
  getSecondaryProjectionActions,
  ProjectionTooltipLayer,
  resolveTooltipSide,
  shouldShowMoreButton,
} from "./projection-controls";
import ProjectionToolbar from "./projection-controls/ProjectionToolbar";
import type { TooltipRect } from "./projection-controls/ProjectionTooltip";
import controlsCss from "./projection-controls/projection-controls.css?raw";

const VIEWPORT: TooltipRect = { x: 0, y: 0, width: 192, height: 900 };

afterEach(() => {
  // @testing-library 手动 cleanup：jsdom 下多个 render 的 DOM 会跨用例残留。
  document.body.innerHTML = "";
});

function session() {
  return {
    mode: "mirror" as const,
    status: "running",
    size: "1080x2400",
    package: null,
    app_label: null,
    display_id: 0,
  };
}

describe("布局尺寸规范", () => {
  it("testNavigationButtonHitArea：点击区 52 逻辑 px（物理值随 DPI 缩放）", () => {
    expect(getNavigationButtonSize(96)).toBe(52);
    expect(getNavigationButtonSize(120)).toBe(65); // 52 × 1.25
    expect(getNavigationButtonSize(192)).toBe(104); // 52 × 2
  });

  it("容器尺寸随按钮数与方向变化，不会为 0", () => {
    const vertical = getNavigationContainerSize(5, "vertical", 96);
    const horizontal = getNavigationContainerSize(5, "horizontal", 96);
    expect(vertical.width).toBe(88);
    expect(vertical.height).toBeGreaterThan(5 * 52);
    expect(horizontal.width).toBeGreaterThan(5 * 52);
    expect(horizontal.height).toBe(52 + 2 * 12);
  });
});

describe("更多菜单清理", () => {
  it("testMoreMenuRemovesDuplicateActions：一级行不含关闭 ✕ 与锁定", () => {
    const actions = filterDuplicateProjectionActions(
      getProjectionToolbarActions(defaultProjectionCapabilities()),
    );
    const ids = actions.map((action) => action.id);
    expect(ids).toContain("back");
    expect(ids).toContain("home");
    expect(ids).toContain("recents");
    expect(ids).toContain("screenshot");
    expect(ids).toContain("more");
    // 原生窗口已有关闭能力 → ✕ 不进一级行；锁定随自动隐藏一起删除。
    expect(ids).not.toContain("end");
  });

  it("次级动作只有真实能力才进菜单；结束投屏保留在菜单里", () => {
    const secondary = getSecondaryProjectionActions(defaultProjectionCapabilities());
    expect(secondary.map((action) => action.id)).toContain("end");
    const closed = getSecondaryProjectionActions({
      ...defaultProjectionCapabilities(),
      close: false,
    });
    expect(closed.map((action) => action.id)).not.toContain("end");
  });

  it("次级功能不足时不显示更多按钮", () => {
    expect(shouldShowMoreButton(defaultProjectionCapabilities())).toBe(true);
    expect(
      shouldShowMoreButton({
        ...defaultProjectionCapabilities(),
        close: false,
        screenshot: false,
      }),
    ).toBe(false);
  });
});

describe("能力推导", () => {
  it("capabilitiesForSession 与后端拒绝规则一致（虚拟屏禁用最近任务）", () => {
    expect(
      capabilitiesForSession({ status: "running", mode: "virtual", display_id: 17 }),
    ).toMatchObject({ back: true, home: true, recents: false, screenshot: true });
    expect(
      capabilitiesForSession({ status: "running", mode: "virtual", display_id: null })
        .recents,
    ).toBe(false);
    expect(
      capabilitiesForSession({ status: "running", mode: "mirror", display_id: 0 }).recents,
    ).toBe(true);
    expect(
      capabilitiesForSession({ status: "stopping", mode: "mirror", display_id: 0 }).back,
    ).toBe(false);
  });
});

describe("Tooltip 定位（任务六）", () => {
  // 真实几何：导航列贴右缘，按钮左缘 ≈ 192-88+18 = 122；气泡 100×30。
  const button: TooltipRect = { x: 122, y: 400, width: 52, height: 52 };

  it("testTooltipFlipsAtWindowBoundary：列贴右缘时向左溢出到余量区", () => {
    expect(resolveTooltipSide(button, { width: 100, height: 30 }, VIEWPORT, "left")).toBe(
      "left",
    );
  });

  it("窗口最左侧的触发器翻转到右侧", () => {
    const leftButton: TooltipRect = { x: 8, y: 400, width: 52, height: 52 };
    expect(resolveTooltipSide(leftButton, { width: 100, height: 30 }, VIEWPORT, "left")).toBe(
      "right",
    );
  });

  it("顶部触发器向上放不下时翻转向下", () => {
    const topButton: TooltipRect = { x: 156, y: 10, width: 52, height: 52 };
    const wideViewport: TooltipRect = { x: 0, y: 0, width: 900, height: 900 };
    expect(resolveTooltipSide(topButton, { width: 100, height: 30 }, wideViewport, "top")).toBe(
      "bottom",
    );
  });

  it("calculateTooltipPosition 钳制进视口，不横向溢出", () => {
    const narrow: TooltipRect = { x: 0, y: 0, width: 120, height: 900 };
    const pos = calculateTooltipPosition(
      { x: 80, y: 400, width: 52, height: 52 },
      { width: 100, height: 30 },
      narrow,
      "left",
    );
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.x + 100).toBeLessThanOrEqual(120);
  });

  it("气泡永不覆盖触发按钮本身", () => {
    const pos = calculateTooltipPosition(
      button,
      { width: 100, height: 30 },
      VIEWPORT,
      resolveTooltipSide(button, { width: 100, height: 30 }, VIEWPORT, "left"),
    );
    const bubble = { x: pos.x, y: pos.y, width: 100, height: 30 };
    const overlaps =
      bubble.x < button.x + button.width &&
      bubble.x + bubble.width > button.x &&
      bubble.y < button.y + button.height &&
      bubble.y + bubble.height > button.y;
    expect(overlaps).toBe(false);
  });

  it("testTooltipDoesNotInterceptClick：气泡 pointer-events: none（源级断言）", () => {
    // jsdom 不解析外部 CSS，直接断言样式源中的关键规则，防回归。
    expect(controlsCss).toMatch(/\.projection-tooltip\s*\{[^}]*pointer-events:\s*none/);
  });
});

function ToolbarHarness({
  capabilities,
  onNavigate,
}: {
  capabilities: ReturnType<typeof capabilitiesForSession>;
  onNavigate?: (action: "back" | "home" | "recents") => void;
}) {
  return (
    <ProjectionTooltipLayer viewportWidth={200} viewportHeight={900} layoutMode="side">
      <ProjectionToolbar
        sessionId="toolbar-test-session"
        session={session()}
        capabilities={capabilities}
        layoutMode="side"
        moreOpen={false}
        moreMenu={<div data-testid="more-menu">menu</div>}
        onNavigate={(action) => onNavigate?.(action)}
        onScreenshot={() => undefined}
        onToggleMore={() => undefined}
      />
    </ProjectionTooltipLayer>
  );
}

describe("导航栏交互", () => {
  it("testDisabledRecentsShowsReason：禁用 + aria-label 带禁用原因，且不触发 onNavigate", () => {
    const onNavigate = vi.fn();
    const capabilities = { ...defaultProjectionCapabilities(), recents: false };
    render(<ToolbarHarness capabilities={capabilities} onNavigate={onNavigate} />);
    const recents = screen.getByRole("button", { name: /最近任务|默认显示器/ });
    expect(recents.hasAttribute("disabled")).toBe(true);
    expect(recents.getAttribute("aria-label")).toContain("实体屏");
    fireEvent.click(recents);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("可用的返回按钮点击触发 onNavigate，按钮使用统一类名（Hover/Focus 状态由 CSS 承载）", () => {
    const onNavigate = vi.fn();
    render(
      <ToolbarHarness capabilities={defaultProjectionCapabilities()} onNavigate={onNavigate} />,
    );
    const back = screen.getByRole("button", { name: "返回" });
    expect(back.className).toContain("projection-control-button");
    fireEvent.click(back);
    expect(onNavigate).toHaveBeenCalledWith("back");
  });

  it("testProjectionSessionBinding：容器携带 data-session，模式类随布局切换", () => {
    render(
      <ProjectionTooltipLayer viewportWidth={200} viewportHeight={900} layoutMode="side">
        <ProjectionToolbar
          sessionId="session-isolated"
          session={session()}
          capabilities={defaultProjectionCapabilities()}
          layoutMode="bottom"
          moreOpen={false}
          moreMenu={null}
          onNavigate={() => undefined}
          onScreenshot={() => undefined}
          onToggleMore={() => undefined}
        />
      </ProjectionTooltipLayer>,
    );
    const toolbar = document.querySelector('[data-session="session-isolated"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.className).toContain("mode-bottom");
  });
});
