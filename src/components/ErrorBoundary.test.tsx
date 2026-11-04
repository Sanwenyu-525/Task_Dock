/**
 * @vitest-environment jsdom
 */
//! ErrorBoundary：渲染异常显示兜底而不是白屏，用户主动重试才会重新渲染。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ErrorBoundary from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Boom({ crash }: { crash: boolean }) {
  if (crash) throw new Error("渲染炸了");
  return <div>正常内容</div>;
}

describe("ErrorBoundary", () => {
  it("捕获渲染异常，展示真实错误与重试入口", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <ErrorBoundary scope="测试窗口">
        <Boom crash />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("界面渲染失败")).toBeTruthy();
    expect(screen.getByText(/渲染炸了/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试加载" }));
    // 仍抛错则继续兜底（不会白屏），且记录重试次数
    expect(screen.getByText(/已重试 1 次/)).toBeTruthy();
  });

  it("恢复后重试可正常渲染", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let crash = true;
    function Toggle() {
      return <Boom crash={crash} />;
    }
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Toggle />
      </ErrorBoundary>,
    );
    crash = false;
    await user.click(screen.getByRole("button", { name: "重试加载" }));
    expect(screen.getByText("正常内容")).toBeTruthy();
  });
});
