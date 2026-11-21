// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WorkspaceSplit from "./WorkspaceSplit";
import splitCss from "./workspaceSplit.css?raw";

const KEY = "taskdock.workspace.split.test-split";

function renderSplit(defaultWidth = 236) {
  return render(
    <WorkspaceSplit
      id="test-split"
      sidebar={<div>筛选</div>}
      sidebarLabel="页面筛选"
      defaultWidth={defaultWidth}
      minWidth={200}
      maxWidth={340}
    >
      <div>主工作区</div>
    </WorkspaceSplit>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("WorkspaceSplit", () => {
  it("渲染独立侧栏、可访问分隔条与主工作区", () => {
    renderSplit();
    const separator = screen.getByRole("separator");
    expect(screen.getByLabelText("页面筛选")).toBeTruthy();
    expect(screen.getByText("主工作区")).toBeTruthy();
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuemin")).toBe("200");
    expect(separator.getAttribute("aria-valuemax")).toBe("340");
    expect(separator.getAttribute("aria-valuenow")).toBe("236");
  });

  it("键盘微调、边界与 Enter 恢复默认都会持久化", () => {
    renderSplit();
    const separator = screen.getByRole("separator");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("244");
    expect(window.localStorage.getItem(KEY)).toBe("244");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator.getAttribute("aria-valuenow")).toBe("236");

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("340");

    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("200");

    fireEvent.keyDown(separator, { key: "Enter" });
    expect(separator.getAttribute("aria-valuenow")).toBe("236");
    expect(window.localStorage.getItem(KEY)).toBe("236");
  });

  it("重新挂载时恢复已保存宽度，并把越界值夹到允许区间", () => {
    window.localStorage.setItem(KEY, "500");
    const first = renderSplit();
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("340");
    first.unmount();

    window.localStorage.setItem(KEY, "100");
    renderSplit();
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("200");
  });

  it("指针拖动按外层查询容器左边界计算宽度，并在松手后清理拖拽态", () => {
    const { container } = renderSplit();
    // 2026-11-16：测量对象改为 `.workspace-split-frame`——它才是查询容器，
    // 与 grid 同宽同起点；固定 `.workspace-split` 会让命中区与自引用缺陷一起回归。
    const frame = container.querySelector(".workspace-split-frame") as HTMLElement;
    const separator = screen.getByRole("separator");
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(true);

    // 拖拽期只更新视觉宽度，不写 localStorage（避免每次 move 同步持久化）。
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 380 });
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 460 });
    expect(separator.getAttribute("aria-valuenow")).toBe("340");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    // 松手提交最终值一次。
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 460 });
    expect(window.localStorage.getItem(KEY)).toBe("340");
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);
  });

  it("pointercancel 提交当前草稿并完成清理", () => {
    const { container } = renderSplit();
    const frame = container.querySelector(".workspace-split-frame") as HTMLElement;
    const separator = screen.getByRole("separator");
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 400 });
    expect(separator.getAttribute("aria-valuenow")).toBe("300");

    fireEvent.pointerCancel(window, { pointerId: 7 });
    // 取消策略：与屏幕上的最终视觉一致，提交草稿宽度。
    expect(window.localStorage.getItem(KEY)).toBe("300");
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);
    // 会话已终止：迟到事件不再产生效果。
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 480 });
    expect(separator.getAttribute("aria-valuenow")).toBe("300");
  });

  it("window blur 终止拖拽并提交草稿", () => {
    const { container } = renderSplit();
    const frame = container.querySelector(".workspace-split-frame") as HTMLElement;
    const separator = screen.getByRole("separator");
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 420 });

    fireEvent.blur(window);
    expect(window.localStorage.getItem(KEY)).toBe("320");
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);
  });

  it("document visibilitychange(hidden) 终止拖拽，恢复可见不再残留会话", () => {
    const { container } = renderSplit();
    const frame = container.querySelector(".workspace-split-frame") as HTMLElement;
    const separator = screen.getByRole("separator");
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 412 });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(window.localStorage.getItem(KEY)).toBe("312");
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(window.localStorage.getItem(KEY)).toBe("312");
  });

  it("拖动过程中组件卸载：清理监听与拖拽态，不执行持久化", () => {
    const { container, unmount } = renderSplit();
    const frame = container.querySelector(".workspace-split-frame") as HTMLElement;
    const separator = screen.getByRole("separator");
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 430 });
    expect(separator.getAttribute("aria-valuenow")).toBe("330");

    unmount();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);

    // 卸载后迟到的 pointer 事件不得再改任何状态。
    expect(() => fireEvent.pointerUp(window, { pointerId: 7, clientX: 500 })).not.toThrow();
  });

  it("终止路径重复触发（up 之后再 blur/cancel）幂等，不抛错且只提交一次", () => {
    const { container } = renderSplit();
    const frame = container.querySelector(".workspace-split-frame") as HTMLElement;
    const separator = screen.getByRole("separator");
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 440 });

    fireEvent.pointerUp(window, { pointerId: 7, clientX: 440 });
    expect(window.localStorage.getItem(KEY)).toBe("340");

    expect(() => {
      fireEvent.blur(window);
      fireEvent.pointerCancel(window, { pointerId: 7 });
      fireEvent.pointerUp(window, { pointerId: 7, clientX: 500 });
    }).not.toThrow();
    expect(window.localStorage.getItem(KEY)).toBe("340");
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);
  });

  it("已有活跃会话时新的 pointerdown 被忽略，不同 pointerId 的事件互不影响", () => {
    const { container } = renderSplit();
    const frame = container.querySelector(".workspace-split-frame") as HTMLElement;
    const separator = screen.getByRole("separator");
    frame.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    // 第二根指针按下：不建立第二个会话。
    fireEvent.pointerDown(separator, { button: 0, pointerId: 8, clientX: 500 });
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(true);

    // 指针 8 的移动/抬起不改变指针 7 的会话状态与宽度。
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 600 });
    expect(separator.getAttribute("aria-valuenow")).toBe("236");
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 600 });
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    // 指针 7 正常结束。
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 336 });
    expect(window.localStorage.getItem(KEY)).toBe("236");
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);
  });

  it("外层查询容器是本轮修复的宿主：只有它声明 container-type（不再自引用）", () => {
    const { container } = renderSplit();
    const frame = container.querySelector(".workspace-split-frame");
    const split = container.querySelector(".workspace-split");
    expect(frame).not.toBeNull();
    expect(split!.parentElement).toBe(frame);
    // 组件级契约之外，CSS 原文由下面的样式契约测试锁定（jsdom 不解析容器查询）
  });
});

/** 取样式表里精确匹配某个选择器的规则体。 */
function ruleBody(selector: string): string {
  const src = splitCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(m, `workspaceSplit.css 缺少规则：${selector}`).not.toBeNull();
  return m![1];
}

describe("workspaceSplit.css 容器查询契约", () => {
  it("查询宿主只有 .workspace-split-frame；.workspace-split 自身不声明 container-type", () => {
    const frame = ruleBody(".workspace-split-frame");
    expect(frame).toMatch(/container-type:\s*inline-size/);
    expect(frame).toMatch(/container-name:\s*workspace-split/);

    // 自引用缺陷的根因：容器不能响应自己的尺寸
    const split = ruleBody(".workspace-split");
    expect(split).not.toMatch(/container-type/);
    expect(split).toMatch(/display:\s*grid/);
  });

  it("窄容器（<560px）改为上下分区，并真正移除分隔条占位与命中区", () => {
    expect(splitCss).toContain("@container workspace-split (max-width: 559px)");
    const block = splitCss.slice(splitCss.indexOf("@container workspace-split (max-width: 559px)"));
    expect(block).toMatch(/\.workspace-split:not\(\.is-single\)\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(block).toMatch(/grid-template-rows:\s*minmax\(0,\s*42%\)\s+minmax\(0,\s*1fr\)/);
    // 轨道已经封顶，侧栏不能再写 max-height:42%（会二次压缩到轨道的 42%，裁掉筛选项）。
    expect(block).not.toMatch(/max-height:\s*42%/);
    expect(block).toMatch(/\.workspace-split__sidebar\s*\{[\s\S]*?max-height:\s*none/);
    expect(block).toMatch(/\.workspace-split__resizer\s*\{[\s\S]*?display:\s*none/);
  });

  it("中等宽度（560–879px）侧栏最多 38%，主区至少 62%", () => {
    expect(splitCss).toContain("@container workspace-split (min-width: 560px) and (max-width: 879px)");
    const block = splitCss.slice(splitCss.indexOf("@container workspace-split (min-width: 560px)"));
    expect(block).toMatch(/min\(var\(--workspace-split-sidebar\),\s*38%\)\s*8px\s*minmax\(0,\s*1fr\)/);
  });

  it("侧栏宽度变量仍由组件写入，窄窗降级不写回记忆值（CSS 侧不覆盖变量）", () => {
    // 三个断点只改 grid-template-* / max-height / display，
    // 不出现 `--workspace-split-sidebar:` 的重新赋值 → 窗口恢复即复原。
    const containerBlocks = splitCss.match(/@container workspace-split[\s\S]*?\n\}/g) ?? [];
    expect(containerBlocks.length).toBeGreaterThan(0);
    for (const block of containerBlocks) {
      expect(block).not.toMatch(/--workspace-split-sidebar\s*:/);
    }
  });
});
