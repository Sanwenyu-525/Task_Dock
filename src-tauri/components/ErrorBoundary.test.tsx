/**
 * @vitest-environment jsdom
 */
//! ErrorBoundary：渲染异常显示兜底而不是白屏，用户主动重试才会重新渲染。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 诊断上报是纯副作用：mock 掉以便断言"渲染异常归属一条 ui/render 事件"。
const mocks = vi.hoisted(() => ({ logEvent: vi.fn(), markLogged: vi.fn() }));
vi.mock("../lib/diagnostics", () => ({
  logEvent: mocks.logEvent,
  markLogged: mocks.markLogged,
}));

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
  it("捕获渲染异常，展示通用文案与重试入口，不泄露原始错误/堆栈", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <ErrorBoundary scope="测试窗口">
        <Boom crash />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("界面渲染失败")).toBeTruthy();
    expect(screen.queryByText(/渲染炸了/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试加载" }));
    // 仍抛错则继续兜底（不会白屏），且记录重试次数
    expect(screen.getByText(/已重试 1 次/)).toBeTruthy();
    // 原始异常只进 console 诊断通道
    expect(log).toHaveBeenCalled();
  });

  it("compact 变体只做小窗口轻量兜底，不渲染主窗口错误页", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary scope="快速捕获" variant="compact">
        <Boom crash />
      </ErrorBoundary>,
    );
    expect(screen.getByText("界面暂时不可用")).toBeTruthy();
    expect(screen.queryByText("界面渲染失败")).toBeNull();
    expect(screen.queryByText(/渲染炸了/)).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
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

  it("内容区兜底：显示模块名，切页（resetKey 变化）自动恢复且不需要重载窗口", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let crash = true;
    function Panel() {
      return crash ? <Boom crash /> : <div>设置内容</div>;
    }
    const { rerender } = render(
      <ErrorBoundary variant="compact" resetKey="settings" label="设置">
        <Panel />
      </ErrorBoundary>,
    );
    expect(screen.getByText("「设置」暂时无法显示")).toBeTruthy();
    expect(screen.getByText(/切换到其它页面/)).toBeTruthy();

    // 用户切到别的页面：resetKey 变化 → 清除错误并重新渲染子树
    crash = false;
    rerender(
      <ErrorBoundary variant="compact" resetKey="tasks" label="任务">
        <Panel />
      </ErrorBoundary>,
    );
    expect(screen.getByText("设置内容")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resetKey 不变时保留兜底，不自动重试（避免报错-重渲染循环）", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary variant="compact" resetKey="settings">
        <Boom crash />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary variant="compact" resetKey="settings">
        <Boom crash />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
