/**
 * @vitest-environment jsdom
 */
//! Alt+拖动到垃圾桶：阈值、命中、取消与卸载清理。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useShelfInternalDrag } from "./useShelfInternalDrag";

const TRASH = { left: 100, top: 100, right: 160, bottom: 160 };

function Harness({
  enabled = true,
  onDrop,
  onCancel,
  rect = TRASH,
}: {
  enabled?: boolean;
  onDrop: (ids: string[]) => void;
  onCancel?: () => void;
  rect?: typeof TRASH | null;
}) {
  const drag = useShelfInternalDrag({
    enabled,
    getTrashRect: () => rect as DOMRect | null,
    onDrop,
    onCancel,
  });
  return (
    <div>
      <button
        type="button"
        data-testid="card"
        onPointerDown={(event) => drag.start(event, ["a", "b"])}
      >
        卡片
      </button>
      <span data-testid="state">
        {drag.active ? "active" : "idle"}|
        {drag.overTrash ? "over" : "out"}|
        {drag.point ? `${drag.point.x},${drag.point.y}` : "-"}
      </span>
    </div>
  );
}

afterEach(() => cleanup());

describe("useShelfInternalDrag", () => {
  it("Alt+拖动越过阈值后松开在垃圾桶上才触发删除", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const card = screen.getByTestId("card");

    fireEvent.pointerDown(card, { button: 0, altKey: true, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 130, clientY: 130, pointerId: 1 });
    expect(screen.getByTestId("state").textContent).toContain("active|over");
    fireEvent.pointerUp(document, { clientX: 130, clientY: 130, pointerId: 1 });

    expect(onDrop).toHaveBeenCalledWith(["a", "b"]);
    expect(screen.getByTestId("state").textContent).toContain("idle|out");
  });

  it("普通拖动（未按 Alt）不启动内部手势", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const card = screen.getByTestId("card");
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10, pointerId: 2 });
    fireEvent.pointerMove(document, { clientX: 130, clientY: 130, pointerId: 2 });
    fireEvent.pointerUp(document, { clientX: 130, clientY: 130, pointerId: 2 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toContain("idle|out");
  });

  it("位移未超过阈值时松手不删除", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const card = screen.getByTestId("card");
    fireEvent.pointerDown(card, { button: 0, altKey: true, clientX: 120, clientY: 120, pointerId: 3 });
    fireEvent.pointerMove(document, { clientX: 122, clientY: 121, pointerId: 3 });
    fireEvent.pointerUp(document, { clientX: 122, clientY: 121, pointerId: 3 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("在垃圾桶外松手只取消，不触发 onDrop", () => {
    const onDrop = vi.fn();
    const onCancel = vi.fn();
    render(<Harness onDrop={onDrop} onCancel={onCancel} />);
    const card = screen.getByTestId("card");
    fireEvent.pointerDown(card, { button: 0, altKey: true, clientX: 10, clientY: 10, pointerId: 4 });
    fireEvent.pointerMove(document, { clientX: 300, clientY: 300, pointerId: 4 });
    fireEvent.pointerUp(document, { clientX: 300, clientY: 300, pointerId: 4 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("blur 取消并清除拖动态", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const card = screen.getByTestId("card");
    fireEvent.pointerDown(card, { button: 0, altKey: true, clientX: 10, clientY: 10, pointerId: 5 });
    fireEvent.pointerMove(document, { clientX: 130, clientY: 130, pointerId: 5 });
    fireEvent.blur(window);
    expect(screen.getByTestId("state").textContent).toContain("idle|out");
    fireEvent.pointerUp(document, { clientX: 130, clientY: 130, pointerId: 5 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("卸载后不再回调", () => {
    const onDrop = vi.fn();
    const view = render(<Harness onDrop={onDrop} />);
    const card = screen.getByTestId("card");
    fireEvent.pointerDown(card, { button: 0, altKey: true, clientX: 10, clientY: 10, pointerId: 6 });
    fireEvent.pointerMove(document, { clientX: 130, clientY: 130, pointerId: 6 });
    view.unmount();
    fireEvent.pointerUp(document, { clientX: 130, clientY: 130, pointerId: 6 });
    expect(onDrop).not.toHaveBeenCalled();
  });
});
