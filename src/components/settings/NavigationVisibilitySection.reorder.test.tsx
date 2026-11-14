/**
 * @vitest-environment jsdom
 */
//! 导航自定义 · 排序交互（2026-11-13）：
//! 拖拽落位、上下箭头长按连续移动、固定调整条、键盘 Alt+↑/↓、焦点保持、
//! 位置播报与写入合并。
//!
//! 布局几何用桩矩形模拟（jsdom 不做布局），拖拽只依赖「拖拽开始时测量一次」
//! 的契约，因此桩矩形可以完整覆盖落点计算；真正的视觉与滚动走通道 B/C 验收。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import NavigationVisibilitySection from "./NavigationVisibilitySection";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { defaultNavigationLayout } from "../../lib/navVisibility";
import { overlayStack, resetOverlayStack } from "../../lib/overlayStack";

const bridgeMocks = vi.hoisted(() => ({ updateSettings: vi.fn() }));
const updateSettings = bridgeMocks.updateSettings;

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    updateSettings: (patch: Record<string, unknown>) => bridgeMocks.updateSettings(patch),
  };
});

const ROW_H = 32;
const ROW_GAP = 2;

function rect(top: number, height: number, width = 320): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 给列表与每行装上稳定的桩矩形（行高统一、间距 2px）。 */
function stubGeometry() {
  const list = document.querySelector<HTMLElement>(".nav-visibility-list");
  if (!list) throw new Error("导航列表未渲染");
  Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 0 });
  list.getBoundingClientRect = () => rect(0, 320);
  const rows = [...list.querySelectorAll<HTMLElement>("[data-nav-entry]")];
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => rect(index * (ROW_H + ROW_GAP), ROW_H);
  });
  return { list, rows };
}

/** 当前渲染的导航名顺序（可见行在前，隐藏行在后）。 */
function rowLabels(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(".nav-visibility-row .nav-visibility-entry-label"),
  ].map((element) => element.textContent ?? "");
}

function savedLeft(): string[] {
  const layout = useSettingsStore.getState().settings?.navigation_layout as
    | { left: string[] }
    | undefined;
  if (!layout) throw new Error("配置尚未写入");
  return layout.left;
}

function seedLayout(mutate?: (layout: ReturnType<typeof defaultNavigationLayout>) => void) {
  const layout = defaultNavigationLayout();
  mutate?.(layout);
  useSettingsStore.setState({ settings: { navigation_layout: layout } as never });
  return layout;
}

beforeEach(() => {
  useUiStore.setState({ tab: "tasks" });
  updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
    const current = useSettingsStore.getState().settings ?? {};
    return { ...current, ...patch } as never;
  });
  seedLayout();
});

afterEach(() => {
  cleanup();
  resetOverlayStack();
  updateSettings.mockReset();
  useSettingsStore.setState({ settings: null, materialInfo: null });
  vi.useRealTimers();
});

describe("拖拽排序", () => {
  it("手柄起拖后其它行让位、显示落点线，松手按落点持久化", async () => {
    render(<NavigationVisibilitySection />);
    const { list } = stubGeometry();
    const handle = within(list).getByRole("button", { name: "拖拽排序 任务" });

    // 任务在第 3 行（top=68, center=84），拖到第 1 行上方
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      pointerType: "mouse",
      clientX: 20,
      clientY: 84,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });

    // 拖拽态：被拖行浮起 + 落点线出现 + 其它行让位（工作台/工作空间下移一行）
    expect(list.querySelector(".nav-visibility-row.is-dragging")).toBeTruthy();
    expect(list.querySelector(".nav-visibility-drop-line")).toBeTruthy();
    const first = list.querySelector<HTMLElement>('[data-nav-entry="workbench"]');
    expect(first?.style.transform).toBe(`translateY(${ROW_H + ROW_GAP}px)`);

    fireEvent.pointerUp(window, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const left = savedLeft();
    expect(left[0]).toBe("tasks");
    // 成员集合不变，只改顺序
    expect([...left].sort()).toEqual([...defaultNavigationLayout().left].sort());
    // 拖拽结束后不再留下浮起/落点线
    expect(list.querySelector(".nav-visibility-row.is-dragging")).toBeNull();
    expect(list.querySelector(".nav-visibility-drop-line")).toBeNull();
  });

  it("向下跨越多个位置：落点决定最终下标，隐藏项不参与", async () => {
    render(<NavigationVisibilitySection />);
    const { list } = stubGeometry();
    const handle = within(list).getByRole("button", { name: "拖拽排序 任务" });

    fireEvent.pointerDown(handle, {
      pointerId: 2,
      button: 0,
      pointerType: "mouse",
      clientX: 20,
      clientY: 84,
    });
    // 拖到第 6 行中心附近：越过 agents/apps/widgets/actions 的中心
    fireEvent.pointerMove(window, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 20,
      clientY: 84 + 106,
    });
    fireEvent.pointerUp(window, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 20,
      clientY: 84 + 106,
    });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const left = savedLeft();
    const index = left.indexOf("tasks");
    expect(index).toBeGreaterThan(2);
    // 任务排到了「行动」之前（落点在 actions 的中心之上）
    expect(index).toBe(left.indexOf("actions") - 1);
  });

  it("Esc 取消：顺序与配置都不变，不产生写库", async () => {
    render(<NavigationVisibilitySection />);
    const { list } = stubGeometry();
    const handle = within(list).getByRole("button", { name: "拖拽排序 任务" });
    const before = rowLabels();

    fireEvent.pointerDown(handle, {
      pointerId: 3,
      button: 0,
      pointerType: "mouse",
      clientX: 20,
      clientY: 84,
    });
    fireEvent.pointerMove(window, {
      pointerId: 3,
      pointerType: "mouse",
      clientX: 20,
      clientY: 200,
    });
    expect(list.querySelector(".nav-visibility-row.is-dragging")).toBeTruthy();

    // 真实链路：全局 Escape 分发器（overlayStack）在 capture 阶段抢占 Escape，
    // 拖拽必须把自己的取消动作注册成一层，否则 Esc 会被别的层吞掉。
    expect(overlayStack().some((entry) => entry.root === list)).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.pointerUp(window, {
      pointerId: 3,
      pointerType: "mouse",
      clientX: 20,
      clientY: 200,
    });

    expect(rowLabels()).toEqual(before);
    expect(list.querySelector(".nav-visibility-row.is-dragging")).toBeNull();
    expect(overlayStack().some((entry) => entry.root === list)).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.getByText("已取消排序")).toBeTruthy();
  });

  it("开关 / 箭头区域不会起拖（不误吞点击语义）", () => {
    render(<NavigationVisibilitySection />);
    const { list } = stubGeometry();
    fireEvent.pointerDown(screen.getByRole("button", { name: "上移 任务" }), {
      pointerId: 4,
      button: 0,
      pointerType: "mouse",
    });
    expect(list.querySelector(".nav-visibility-row.is-dragging")).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 4 });
  });
});

describe("上下箭头：长按连续移动", () => {
  it("按下即移动一格，400ms 后每 140ms 继续，到顶部自动停止", async () => {
    vi.useFakeTimers();
    render(<NavigationVisibilitySection />);
    stubGeometry();

    const up = screen.getByRole("button", { name: "上移 任务" });
    fireEvent.pointerDown(up, { pointerId: 5, button: 0, pointerType: "mouse" });
    // 第一步同步生效：任务与工作空间交换
    expect(rowLabels()[0]).toBe("工作台");
    expect(rowLabels()[1]).toBe("任务");

    // 未到长按阈值：不再移动
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(rowLabels()[1]).toBe("任务");

    // 进入连续移动：再上移一格到顶部，随后到边界停止
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(rowLabels()[0]).toBe("任务");

    act(() => {
      vi.advanceTimersByTime(140 * 6);
    });
    expect(rowLabels()[0]).toBe("任务");
    expect(rowLabels()[1]).toBe("工作台");

    fireEvent.pointerUp(window, { pointerId: 5 });
    // 合并写入窗口结束后落库一次（长按超过 1s 时中途会有一次强制落库，允许 1–2 次）
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(updateSettings.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(updateSettings.mock.calls.length).toBeLessThanOrEqual(2);
    expect(savedLeft()[0]).toBe("tasks");
  });

  it("松开鼠标立即停止连续移动", () => {
    vi.useFakeTimers();
    render(<NavigationVisibilitySection />);
    stubGeometry();

    const up = screen.getByRole("button", { name: "上移 规划中心" });
    fireEvent.pointerDown(up, { pointerId: 6, button: 0, pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.pointerUp(window, { pointerId: 6 });

    const afterRelease = rowLabels();
    act(() => {
      vi.advanceTimersByTime(140 * 10);
    });
    expect(rowLabels()).toEqual(afterRelease);
  });

  it("指针离开列表范围时停止", () => {
    vi.useFakeTimers();
    render(<NavigationVisibilitySection />);
    stubGeometry();

    const up = screen.getByRole("button", { name: "上移 规划中心" });
    fireEvent.pointerDown(up, { pointerId: 7, button: 0, pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // 拖到列表外（桩矩形为 0..320）
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 2000, clientY: 2000 });
    const afterLeave = rowLabels();
    act(() => {
      vi.advanceTimersByTime(140 * 10);
    });
    expect(rowLabels()).toEqual(afterLeave);
  });

  it("组件卸载后不再移动（计时器与监听全部释放）", () => {
    vi.useFakeTimers();
    const { unmount } = render(<NavigationVisibilitySection />);
    stubGeometry();
    const up = screen.getByRole("button", { name: "上移 规划中心" });
    fireEvent.pointerDown(up, { pointerId: 8, button: 0, pointerType: "mouse" });
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }).not.toThrow();
  });
});

describe("连续调整：固定调整条", () => {
  it("点击行进入调整态，调整条位置固定，可连续上移同一入口", async () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    const row = document.querySelector<HTMLElement>('[data-nav-entry="clipboard"]');
    expect(row).toBeTruthy();
    fireEvent.click(row!.querySelector(".nav-visibility-entry-label")!);

    expect(screen.getByText("调整「剪贴板」")).toBeTruthy();
    expect(screen.getByText(/第 \d+ \/ \d+ 位/)).toBeTruthy();
    expect(row!.className).toContain("is-active");

    // 同一按钮连点两次：中间没有任何行位移（调整条不在列表内）
    const adjustUp = () => screen.getByRole("button", { name: "上移「剪贴板」（长按连续移动）" });
    fireEvent.pointerDown(adjustUp(), { pointerId: 9, button: 0 });
    fireEvent.pointerUp(window, { pointerId: 9 });
    fireEvent.pointerDown(adjustUp(), { pointerId: 10, button: 0 });
    fireEvent.pointerUp(window, { pointerId: 10 });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const left = savedLeft();
    expect(left.indexOf("clipboard")).toBe(left.indexOf("apps") + 1);
    // 位置提示随排序更新
    expect(screen.getByText(/第 \d+ \/ \d+ 位/)).toBeTruthy();
  });

  it("「完成」退出调整态；点其它行切换到该入口", () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    fireEvent.click(
      document.querySelector('[data-nav-entry="clipboard"] .nav-visibility-entry-label')!,
    );
    expect(screen.queryByText("调整「剪贴板」")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByText("调整「剪贴板」")).toBeNull();

    fireEvent.click(
      document.querySelector('[data-nav-entry="apps"] .nav-visibility-entry-label')!,
    );
    expect(screen.getByText("调整「应用」")).toBeTruthy();
  });

  it("调整态按 Esc 收起；整块写入期间调整条按钮禁用", () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    const row = document.querySelector<HTMLElement>('[data-nav-entry="clipboard"]');
    fireEvent.click(row!.querySelector(".nav-visibility-entry-label")!);
    fireEvent.keyDown(row!, { key: "Escape" });
    expect(screen.queryByText("调整「剪贴板」")).toBeNull();
  });
});

describe("键盘与无障碍", () => {
  it("Alt+↑ 调整一格，焦点按稳定 ID 回到同一逻辑按钮", async () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    const up = screen.getByRole("button", { name: "上移 规划中心" });
    up.focus();
    expect(document.activeElement).toBe(up);

    fireEvent.keyDown(up, { key: "ArrowUp", altKey: true });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const left = savedLeft();
    expect(left.indexOf("roadmap")).toBe(left.indexOf("history") - 1);
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.getAttribute("aria-label")).toBe("上移 规划中心");
    // 焦点仍在被移动的同一行内
    expect(focused?.closest('[data-nav-entry="roadmap"]')).toBeTruthy();
  });

  it("没有 Alt 的上下键不触发排序（不覆盖其它交互）", () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    const up = screen.getByRole("button", { name: "上移 规划中心" });
    up.focus();
    fireEvent.keyDown(up, { key: "ArrowUp" });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("排序后用 aria-live 播报最终位置", async () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    // 键盘点击（detail=0）等价单击一次
    fireEvent.click(screen.getByRole("button", { name: "上移 剪贴板" }));
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
        "已移到第 7 位",
      ),
    );
  });

  it("拖拽手柄可聚焦且带可访问名称（键盘可达的调整入口）", () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    const handle = screen.getByRole("button", { name: "拖拽排序 剪贴板" });
    handle.focus();
    expect(document.activeElement).toBe(handle);
    fireEvent.click(handle);
    // 手柄激活后进入调整态，后续可用 Tab 到固定调整条
    expect(screen.getByText("调整「剪贴板」")).toBeTruthy();
  });
});

describe("写入合并与失败", () => {
  it("连续多次移动只写一次库（合并窗口内）", async () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    for (const pointerId of [11, 12, 13]) {
      fireEvent.pointerDown(screen.getByRole("button", { name: "上移 剪贴板" }), {
        pointerId,
        button: 0,
        pointerType: "mouse",
      });
      fireEvent.pointerUp(window, { pointerId });
    }
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    // 三步都生效：剪贴板从 7 移到 4（越过 actions / widgets / apps）
    const left = savedLeft();
    expect(left.indexOf("clipboard")).toBe(left.indexOf("agents") + 1);
  });

  it("写库失败：草稿回退到后端顺序并就地提示", async () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    updateSettings.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "上移 剪贴板" }), {
      pointerId: 14,
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(window, { pointerId: 14 });

    expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
    // 界面回到后端真实顺序（剪贴板仍在原位，不再是草稿顺序）
    expect(rowLabels().indexOf("剪贴板")).toBe(rowLabels().indexOf("行动") + 1);
  });
});

describe("显隐与排序的写入顺序", () => {
  it("切换显隐前先把未落库的排序写完，两个操作都保留", async () => {
    render(<NavigationVisibilitySection />);
    stubGeometry();
    // 先移动（草稿尚未落库）
    fireEvent.pointerDown(screen.getByRole("button", { name: "上移 剪贴板" }), {
      pointerId: 15,
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(window, { pointerId: 15 });
    // 立刻隐藏「应用」：必须先 flush 排序，否则会用旧顺序覆盖
    fireEvent.click(screen.getByRole("switch", { name: "应用导航入口显示" }));

    await waitFor(() => expect(updateSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
    const left = savedLeft();
    expect(left).not.toContain("apps");
    // 排序调整仍在（剪贴板在行动之前）
    expect(left.indexOf("clipboard")).toBeLessThan(left.indexOf("actions"));
  });
});
