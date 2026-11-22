/**
 * @vitest-environment jsdom
 */
//! 全局提示条层（TooltipLayer）：
//! - 悬停 / **键盘（Tab）聚焦**带 `data-tip` 的控件时出现统一样式的提示；
//! - 鼠标点击后的聚焦、窗口重新激活补发的 focusin 不算键盘聚焦，不得弹提示
//!   （回归：点标题栏空白拖拽区会弹出「最小化」）；
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

  it("键盘（Tab）聚焦同样会给出提示", async () => {
    render(
      <>
        <Harness />
        <TooltipLayer />
      </>,
    );
    const btn = screen.getByRole("button", { name: "删除" });
    // 真实键盘路径：先 Tab（记录键盘意图）再移动焦点
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focusIn(btn);

    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("删除条目"));
  });

  it("点击标题栏空白拖拽区不弹按钮提示（窗口激活补发的 focusin 不算键盘聚焦）", async () => {
    render(
      <>
        <div data-testid="titlebar" data-tauri-drag-region>
          <span>Task Dock</span>
          <button type="button" data-tip="最小化" aria-label="最小化">
            —
          </button>
        </div>
        <TooltipLayer />
      </>,
    );
    const bar = screen.getByTestId("titlebar");
    const min = screen.getByRole("button", { name: "最小化" });

    // 上一次鼠标点击让最小化按钮持有焦点（指针模态）
    fireEvent.pointerDown(min);
    min.focus();
    fireEvent.focusIn(min);

    // 点空白拖拽区：drag.js 会 preventDefault + startDragging，焦点不离开按钮
    fireEvent.pointerDown(bar);
    fireEvent.mouseDown(bar);
    fireEvent.click(bar);
    // 原生 startDragging 激活窗口后，Chromium 对上次聚焦元素补发 focusin
    fireEvent.focusIn(min);

    // 同时越过 350ms 悬停延迟，确认没有任何路径把提示弹出来
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("tooltip")).toBeNull();
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

    // 键盘 Tab 切到第一个控件
    fireEvent.keyDown(window, { key: "Tab" });
    copy.focus();
    fireEvent.focusIn(copy);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());

    // 再 Tab 到下一个控件：提示条要跟着换，但焦点必须留在新控件上
    fireEvent.keyDown(window, { key: "Tab" });
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
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focusIn(btn);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(hideWindow).toHaveBeenCalledTimes(1);
  });

  it("页面滚动立即收起提示，不跟随锚点残留", async () => {
    render(
      <>
        <Harness />
        <TooltipLayer />
      </>,
    );
    const btn = screen.getByRole("button", { name: "复制" });
    fireEvent.mouseOver(btn);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());

    fireEvent.scroll(document);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("任意按下（切页 / 刷新 / 点击）立即收起提示", async () => {
    render(
      <>
        <Harness />
        <TooltipLayer />
      </>,
    );
    const btn = screen.getByRole("button", { name: "复制" });
    fireEvent.mouseOver(btn);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeTruthy());

    fireEvent.pointerDown(btn);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});

// 2026-11-07：纯图标按钮可以只有 aria-label，提示文案由提示层回退取用。
// 边界必须锁死：显式 data-tip 优先、有可见文字不弹、原生 title 不重复弹、
// 自带提示机制的控件可以整棵子树退出。
describe("纯图标按钮的 aria-label 回退", () => {
  const Icon = () => <span aria-hidden="true" />;

  it("没有 data-tip 的纯图标按钮用 aria-label 作提示", async () => {
    render(
      <>
        <button type="button" aria-label="刷新列表">
          <Icon />
        </button>
        <TooltipLayer />
      </>,
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "刷新列表" }));
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("刷新列表"));
  });

  it("显式 data-tip 优先于 aria-label", async () => {
    render(
      <>
        <button type="button" aria-label="刷新列表" data-tip="刷新">
          <Icon />
        </button>
        <TooltipLayer />
      </>,
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "刷新列表" }));
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("刷新"));
  });

  it("有可见文字的按钮不回退（同名提示只是噪声）", async () => {
    render(
      <>
        <button type="button" aria-label="搜索">
          搜索
        </button>
        <TooltipLayer />
      </>,
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "搜索" }));
    // 越过 350ms 悬停延迟，确认没有弹提示
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("存在原生 title 时不回退，避免浏览器与提示层各弹一条", async () => {
    render(
      <>
        <button type="button" aria-label="最小化" title="最小化">
          <Icon />
        </button>
        <TooltipLayer />
      </>,
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "最小化" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("data-tip-skip 子树退出回退（自带独立提示窗口的控件）", async () => {
    render(
      <>
        <button type="button" aria-label="极简标签" data-tip-skip="1">
          <Icon />
        </button>
        <TooltipLayer />
      </>,
    );
    fireEvent.mouseOver(screen.getByRole("button", { name: "极简标签" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
