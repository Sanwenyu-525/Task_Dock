/**
 * @vitest-environment jsdom
 */
//! 全局提示条层（TooltipLayer）：
//! - 悬停 / 聚焦带 `data-tip` 的控件时出现统一样式的提示；
//! - 提示条**不抢焦点**（关闭时不得把焦点拽回原控件）；
//! - 提示条**不消费 Escape**（瞬时提示不该挡住「Esc 隐藏窗口」）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TooltipLayer from "./TooltipLayer";
import { setWindowEscapeHandler } from "../../lib/overlayStack";

function Harness() {
  return (
    <>
      <button type="button" data-tip="复制内容" aria-label="复制">
        复制
      </button>
      <button type="button" data-tip="删除条目" aria-label="删除">
        删除
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  setWindowEscapeHandler(null);
});

describe("全局提示条层", () => {
  it("悬停带 data-tip 的控件后出现提示，内容取自 data-tip", async () => {
    render(
      <>
        <Harness />
        <TooltipLayer />
      </>,
    );
    const btn = screen.getByRole("button", { name: "复制" });
    fireEvent.mouseOver(btn);

    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());
    expect(screen.getByRole("tooltip").textContent).toBe("复制内容");
  });

  it("键盘聚焦同样会给出提示", async () => {
    render(
      <>
        <Harness />
        <TooltipLayer />
      </>,
    );
    const btn = screen.getByRole("button", { name: "删除" });
    fireEvent.focusIn(btn);

    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("删除条目"));
  });

  it("提示条关闭时不抢走焦点", async () => {
    render(
      <>
        <Harness />
        <TooltipLayer />
      </>,
    );
    const copy = screen.getByRole("button", { name: "复制" });
    const del = screen.getByRole("button", { name: "删除" });

    copy.focus();
    fireEvent.focusIn(copy);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());

    // 焦点移到下一个控件：提示条要跟着换，但焦点必须留在新控件上
    del.focus();
    fireEvent.focusOut(copy);
    fireEvent.focusIn(del);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("删除条目"));
    expect(document.activeElement).toBe(del);
  });

  it("Escape 收起提示条但不消费按键（窗口级 Escape 仍生效）", async () => {
    const hideWindow = vi.fn();
    setWindowEscapeHandler(hideWindow);
    render(
      <>
        <Harness />
        <TooltipLayer />
      </>,
    );
    const btn = screen.getByRole("button", { name: "复制" });
    fireEvent.focusIn(btn);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(hideWindow).toHaveBeenCalledTimes(1);
  });
});
