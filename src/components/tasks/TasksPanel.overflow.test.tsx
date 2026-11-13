// @vitest-environment jsdom
//! 任务页日期分段横向滚动：溢出方向指示、激活项自动入视、滚轮映射。
//!
//! jsdom 没有布局引擎，这里用 Object.defineProperty 注入
//! scrollWidth/clientWidth/scrollLeft 与按钮 offsetLeft/offsetWidth，
//! 只验证 DOM 契约与手算滚动量；真实布局、渐变与输入管线由
//! tmp/acceptance/tasks-layout-revamp/round2/ 的 Playwright 预览度量补充。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import TasksPanel from "./TasksPanel";
import {
  computeOverflowEdges,
  computeRevealScrollLeft,
  VIEW_REVEAL_MARGIN,
} from "./useViewsOverflow";
import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import { useLocaleStore } from "../../i18n";

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    listTasks: vi.fn(async () => []),
    toggleTask: vi.fn(),
    taskStats: vi.fn(async () => ({
      pending: 0,
      overdue: 0,
      due_today: 0,
      completed_today: 0,
      next_due_at: null,
    })),
    parseQuickAdd: vi.fn(),
    createFromQuickAdd: vi.fn(),
    listTaskLinks: vi.fn(async () => []),
    clipboardTaskLinks: vi.fn(async () => []),
  };
});

vi.mock("../../lib/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/navigation")>()),
  navTaskTargets: vi.fn(async () => []),
}));

vi.mock("./analytics/TaskAnalyticsPanel", () => ({
  default: () => <div>analytics-panel</div>,
}));

interface ScrollMetrics {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}

/** 给滚动容器注入可在测试中读写的尺寸（jsdom 默认全部为 0）。 */
function mockScrollMetrics(el: HTMLElement, initial: Partial<ScrollMetrics> = {}): ScrollMetrics {
  const metrics: ScrollMetrics = {
    scrollWidth: 0,
    clientWidth: 0,
    scrollLeft: 0,
    ...initial,
  };
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    get: () => metrics.scrollWidth,
  });
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    get: () => metrics.clientWidth,
  });
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => metrics.scrollLeft,
    set: (value: number) => {
      metrics.scrollLeft = value;
    },
  });
  return metrics;
}

/** 注入按钮相对滚动容器的位置（offsetLeft/offsetWidth）。 */
function mockItemGeometry(el: HTMLElement, left: number, width: number) {
  Object.defineProperty(el, "offsetLeft", { configurable: true, get: () => left });
  Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => width });
}

function seedStore() {
  useTasksStore.setState({
    tasks: [],
    loading: false,
    error: null,
    stats: { pending: 0, overdue: 0, due_today: 0, completed_today: 0, next_due_at: null },
    filter: { view: "all", status: "all", sort: "due" },
    exitHolds: [],
  });
  useNavigationStore.setState({ linksByTask: {}, linksError: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ editor: { open: false, task: null } });
  useLocaleStore.setState({ preference: "zh-CN", locale: "zh-CN" });
  seedStore();
});

afterEach(() => {
  cleanup();
});

describe("computeOverflowEdges", () => {
  it("起点只报告右侧有隐藏内容，中点两侧都有，终点只报告左侧", () => {
    // 5 个日期视图约 210px，窄窗容器约 150px → 最大滚动量 60px
    expect(computeOverflowEdges(0, 210, 150)).toEqual({ start: false, end: true });
    expect(computeOverflowEdges(30, 210, 150)).toEqual({ start: true, end: true });
    expect(computeOverflowEdges(60, 210, 150)).toEqual({ start: true, end: false });
  });

  it("无溢出或仅 1px 取整误差时两侧都不显示指示", () => {
    expect(computeOverflowEdges(0, 150, 150)).toEqual({ start: false, end: false });
    expect(computeOverflowEdges(0, 151, 150)).toEqual({ start: false, end: false });
  });

  it("边界 1px 容差内视为已到该侧边界", () => {
    expect(computeOverflowEdges(1, 210, 150)).toEqual({ start: false, end: true });
    expect(computeOverflowEdges(59, 210, 150)).toEqual({ start: true, end: false });
    expect(computeOverflowEdges(60, 210, 150)).toEqual({ start: true, end: false });
  });
});

describe("computeRevealScrollLeft", () => {
  it("隐藏项在右侧时滚动到其完整可见（含遮罩边距）", () => {
    expect(
      computeRevealScrollLeft({
        scrollLeft: 0,
        scrollWidth: 210,
        clientWidth: 150,
        itemLeft: 168,
        itemWidth: 40,
      }),
    ).toBe(60); // 168 + 40 - 150 + 12 = 70，夹取到最大滚动量 60
  });

  it("隐藏项在左侧时回滚到其完整可见", () => {
    expect(
      computeRevealScrollLeft({
        scrollLeft: 60,
        scrollWidth: 210,
        clientWidth: 150,
        itemLeft: 2,
        itemWidth: 30,
      }),
    ).toBe(0);
  });

  it("已完整可见时保持当前滚动位置", () => {
    expect(
      computeRevealScrollLeft({
        scrollLeft: 20,
        scrollWidth: 210,
        clientWidth: 150,
        itemLeft: 50,
        itemWidth: 40,
      }),
    ).toBe(20);
  });

  it("结果夹取在 0..max，不把页面或父容器带走", () => {
    expect(
      computeRevealScrollLeft({
        scrollLeft: 0,
        scrollWidth: 210,
        clientWidth: 150,
        itemLeft: 4,
        itemWidth: 30,
      }),
    ).toBe(0);
    expect(
      computeRevealScrollLeft({
        scrollLeft: 60,
        scrollWidth: 210,
        clientWidth: 150,
        itemLeft: 160,
        itemWidth: 50,
      }),
    ).toBe(60);
    expect(
      computeRevealScrollLeft({
        scrollLeft: 0,
        scrollWidth: 150,
        clientWidth: 150,
        itemLeft: 140,
        itemWidth: 10,
      }),
    ).toBe(0);
    expect(VIEW_REVEAL_MARGIN).toBeGreaterThan(0);
  });
});

describe("任务页日期分段溢出指示", () => {
  it("滚动时按方向更新 data-overflow-start/end，到边界移除对应属性", () => {
    const { container } = render(<TasksPanel />);
    const views = container.querySelector<HTMLElement>(".tasks-views")!;
    expect(views).toBeTruthy();
    // 初始未测到溢出（jsdom 尺寸为 0）：不出现任何指示
    expect(views.hasAttribute("data-overflow-start")).toBe(false);
    expect(views.hasAttribute("data-overflow-end")).toBe(false);

    const metrics = mockScrollMetrics(views, { scrollWidth: 210, clientWidth: 150 });
    fireEvent.scroll(views);
    expect(views.hasAttribute("data-overflow-start")).toBe(false);
    expect(views.getAttribute("data-overflow-end")).toBe("true");

    metrics.scrollLeft = 30;
    fireEvent.scroll(views);
    expect(views.getAttribute("data-overflow-start")).toBe("true");
    expect(views.getAttribute("data-overflow-end")).toBe("true");

    metrics.scrollLeft = 60;
    fireEvent.scroll(views);
    expect(views.getAttribute("data-overflow-start")).toBe("true");
    expect(views.hasAttribute("data-overflow-end")).toBe(false);

    // 宽度恢复（正常窗口 / 无溢出）：两个指示都完全移除
    metrics.scrollWidth = 150;
    metrics.scrollLeft = 0;
    fireEvent.scroll(views);
    expect(views.hasAttribute("data-overflow-start")).toBe(false);
    expect(views.hasAttribute("data-overflow-end")).toBe(false);
  });

  it("键盘聚焦被隐藏的日期项时自动滚动到完整可见", () => {
    const { container } = render(<TasksPanel />);
    const views = container.querySelector<HTMLElement>(".tasks-views")!;
    const metrics = mockScrollMetrics(views, { scrollWidth: 210, clientWidth: 150 });
    const overdue = container.querySelector<HTMLElement>('[data-view="overdue"]')!;
    mockItemGeometry(overdue, 168, 40);

    act(() => overdue.focus());

    expect(document.activeElement).toBe(overdue);
    expect(metrics.scrollLeft).toBe(60);
    expect(views.getAttribute("data-overflow-start")).toBe("true");
    expect(views.hasAttribute("data-overflow-end")).toBe(false);
  });

  it("鼠标按下触发的 focus 不滚动，部分可见项点击仍生效并在激活后入视", () => {
    const { container } = render(<TasksPanel />);
    const views = container.querySelector<HTMLElement>(".tasks-views")!;
    const metrics = mockScrollMetrics(views, { scrollWidth: 210, clientWidth: 150 });
    const week = container.querySelector<HTMLElement>('[data-view="week"]')!;
    // 130..170，容器只到 150：按钮部分可见
    mockItemGeometry(week, 130, 40);

    // 指针按下 → focus：不得在 mousedown/mouseup 之间滚动（否则 click 丢失）
    act(() => {
      fireEvent.pointerDown(week);
      week.focus();
    });
    expect(document.activeElement).toBe(week);
    expect(metrics.scrollLeft).toBe(0);

    // 点击仍然生效；激活后由 activeView 变化把该项带入可见区
    fireEvent.click(week);
    expect(useTasksStore.getState().filter.view).toBe("week");
    // 130 + 40 - 150 + 12 = 32
    expect(metrics.scrollLeft).toBe(32);
  });

  it("从概览卡外部下钻到逾期时，隐藏的「逾期」项自动进入可见区", () => {
    const { container } = render(<TasksPanel />);
    const views = container.querySelector<HTMLElement>(".tasks-views")!;
    const metrics = mockScrollMetrics(views, { scrollWidth: 210, clientWidth: 150 });
    // 与窄窗实际顺序/宽度同构：全部 / 今日 / 明日 / 本周 / 逾期
    mockItemGeometry(container.querySelector<HTMLElement>('[data-view="all"]')!, 2, 30);
    mockItemGeometry(container.querySelector<HTMLElement>('[data-view="today"]')!, 34, 42);
    mockItemGeometry(container.querySelector<HTMLElement>('[data-view="tomorrow"]')!, 78, 40);
    mockItemGeometry(container.querySelector<HTMLElement>('[data-view="week"]')!, 120, 42);
    mockItemGeometry(container.querySelector<HTMLElement>('[data-view="overdue"]')!, 164, 40);

    const card = container.querySelectorAll<HTMLElement>(".overview-card")[2];
    fireEvent.click(card);

    expect(useTasksStore.getState().filter.view).toBe("overdue");
    // 164 + 40 - 150 + 12 = 66 → 夹取到最大滚动量 60
    expect(metrics.scrollLeft).toBe(60);
    expect(views.getAttribute("data-overflow-start")).toBe("true");
  });

  it("语言切换导致当前项偏移后，重新把它带回可见区", () => {
    const { container } = render(<TasksPanel />);
    const views = container.querySelector<HTMLElement>(".tasks-views")!;
    const metrics = mockScrollMetrics(views, {
      scrollWidth: 300,
      clientWidth: 150,
      scrollLeft: 0,
    });
    const week = container.querySelector<HTMLElement>('[data-view="week"]')!;
    // 中文下「本周」可见
    mockItemGeometry(week, 110, 40);
    act(() => {
      useTasksStore.setState({
        filter: { view: "week", status: "all", sort: "due" },
      });
    });
    // 激活项右侧紧贴容器边缘（110 + 40 = 150）：保留与遮罩等宽的 12px 边距
    expect(metrics.scrollLeft).toBe(12);

    // 切到英文后按钮变宽、当前项右移出可见区
    mockItemGeometry(week, 160, 60);
    act(() => {
      useLocaleStore.setState({ preference: "en-US", locale: "en-US" });
    });

    // 160 + 60 - 150 + 12 = 82
    expect(metrics.scrollLeft).toBe(82);
    expect(views.getAttribute("data-overflow-start")).toBe("true");
  });
});

describe("任务页日期分段滚轮映射", () => {
  it("竖向滚轮映射为横向滚动，到边界放行默认行为", () => {
    const { container } = render(<TasksPanel />);
    const views = container.querySelector<HTMLElement>(".tasks-views")!;
    const metrics = mockScrollMetrics(views, { scrollWidth: 210, clientWidth: 150 });

    // 起点向终点：消费滚轮并阻止页面默认滚动
    expect(fireEvent.wheel(views, { deltaY: 40, cancelable: true })).toBe(false);
    expect(metrics.scrollLeft).toBe(40);

    // 到终点后不再拦截，交给默认行为
    metrics.scrollLeft = 60;
    expect(fireEvent.wheel(views, { deltaY: 40, cancelable: true })).toBe(true);
    expect(metrics.scrollLeft).toBe(60);

    // 触摸板横向手势（deltaX）
    metrics.scrollLeft = 0;
    expect(fireEvent.wheel(views, { deltaX: 30, deltaY: 0, cancelable: true })).toBe(false);
    expect(metrics.scrollLeft).toBe(30);

    // 无横向溢出时不拦截
    metrics.scrollWidth = 150;
    metrics.scrollLeft = 0;
    expect(fireEvent.wheel(views, { deltaY: 40, cancelable: true })).toBe(true);
    expect(metrics.scrollLeft).toBe(0);
  });
});
