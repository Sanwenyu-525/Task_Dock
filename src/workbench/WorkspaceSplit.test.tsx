// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WorkspaceSplit from "./WorkspaceSplit";

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

  it("指针拖动按根容器左边界计算宽度，并在松手后清理拖拽态", () => {
    const { container } = renderSplit();
    const root = container.querySelector(".workspace-split") as HTMLElement;
    const separator = screen.getByRole("separator");
    root.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 800, height: 600, right: 900, bottom: 600, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 336 });
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(true);

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 380 });
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
    expect(window.localStorage.getItem(KEY)).toBe("280");

    fireEvent.pointerUp(window, { pointerId: 7, clientX: 380 });
    expect(document.body.classList.contains("workspace-split-resizing")).toBe(false);
  });
});
