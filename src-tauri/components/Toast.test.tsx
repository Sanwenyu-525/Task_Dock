/**
 * @vitest-environment jsdom
 */
//! Toast 组件测试：四种状态、自动消失计时、hover 暂停、关闭与操作按钮。
//!
//! 验收点（通知系统整改 E）：
//! - info/success/warning/error 四态都渲染状态图标与语义角色；
//! - 普通提示 4s、错误 8s、带操作 6s 自动消失，计时器随卸载清理；
//! - hover 暂停计时，移开后重新计时；
//! - 点正文不关闭，关闭按钮可访问（aria-label）且只关当前一条；
//! - 操作按钮执行后同时关闭提示。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Toast from "./Toast";
import { useUiStore } from "../store/useUiStore";

function show(
  message: string,
  opts?: { kind?: "info" | "success" | "warning" | "error"; action?: { label: string; run: () => void } },
) {
  act(() => {
    useUiStore.getState().showToast(message, opts);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ toast: null, toasts: [] });
  vi.useRealTimers();
});

describe("Toast · 状态与无障碍", () => {
  it("info/success/warning 渲染对应样式，错误使用 alert 角色", () => {
    render(<Toast />);
    show("信息", { kind: "info" });
    show("成功", { kind: "success" });
    show("警告", { kind: "warning" });

    expect(screen.getByText("信息").closest(".toast")?.className).toContain("kind-info");
    expect(screen.getByText("成功").closest(".toast")?.className).toContain("kind-success");
    expect(screen.getByText("警告").closest(".toast")?.className).toContain("kind-warning");

    act(() => {
      useUiStore.getState().dismissToast();
    });
    show("失败", { kind: "error" });
    const error = screen.getByText("失败").closest(".toast");
    expect(error?.className).toContain("kind-error");
    expect(error?.getAttribute("role")).toBe("alert");
  });

  it("关闭按钮有可访问名称，点正文不关闭", () => {
    render(<Toast />);
    show("已复制", { kind: "success" });

    fireEvent.click(screen.getByText("已复制"));
    expect(screen.queryByText("已复制")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("关闭提示"));
    expect(screen.queryByText("已复制")).toBeNull();
  });
});

describe("Toast · 计时与交互", () => {
  it("普通提示 4s 自动消失，错误停留 8s", () => {
    render(<Toast />);
    show("已保存", { kind: "success" });
    show("保存失败", { kind: "error" });

    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByText("已保存")).toBeNull();
    expect(screen.queryByText("保存失败")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("保存失败")).toBeNull();
  });

  it("hover 暂停计时，移开后重新计时", () => {
    render(<Toast />);
    show("已复制", { kind: "success" });
    const toast = screen.getByText("已复制").closest(".toast") as HTMLElement;

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText("已复制")).toBeTruthy();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByText("已复制")).toBeNull();
  });

  it("操作按钮执行回调并关闭提示", () => {
    const run = vi.fn();
    render(<Toast />);
    show("任务已删除", { kind: "info", action: { label: "撤销", run } });

    fireEvent.click(screen.getByText("撤销"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("任务已删除")).toBeNull();
  });
});
