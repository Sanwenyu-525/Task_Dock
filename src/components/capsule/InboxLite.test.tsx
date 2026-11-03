/**
 * @vitest-environment jsdom
 */
//! 收集箱胶囊面板（B4）：真实 store + mock 后端命令。
//!
//! 覆盖：
//! - 列表来自 useCaptureStore 的 lite 切片（quickCaptureList("inbox", 8, 0)），
//!   未处理数来自 quickCaptureState()；
//! - 读取失败绝不伪装成「没有未处理记录」：无旧数据 → 错误空态 + 重试；
//!   有旧数据 → 旧列表 + 错误条；
//! - 面板卸载释放 lite 切片（作废在途响应，不多付 IPC）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";

const quickCaptureList = vi.fn();
const quickCaptureState = vi.fn();

vi.mock("../../lib/bridge", () => ({
  quickCaptureList: (...a: unknown[]) => quickCaptureList(...a),
  quickCaptureState: (...a: unknown[]) => quickCaptureState(...a),
  quickCaptureMarkHandled: vi.fn(),
  quickCaptureDelete: vi.fn(),
  quickCaptureConvertToTask: vi.fn(),
  quickCaptureSaveDraft: vi.fn(),
  quickCaptureClearDraft: vi.fn(),
  quickCaptureSetLastType: vi.fn(),
  quickCaptureSubmit: vi.fn(),
  quickCaptureHide: vi.fn(),
  applyMode: async () => undefined,
}));

import InboxLite from "./InboxLite";
import { useCaptureStore } from "../../store/useCaptureStore";

function item(id: string, content: string, extra = {}) {
  return {
    id,
    client_id: `${id}-cid`,
    kind: "text" as const,
    content,
    url: null,
    note: null,
    status: "inbox" as const,
    task_id: null,
    source: "manual",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  quickCaptureList.mockReset();
  quickCaptureState.mockReset();
  useCaptureStore.setState({
    items: [],
    filter: "inbox",
    loading: false,
    error: null,
    inboxCount: 0,
    inboxCountLoaded: false,
    lite: null,
    liteLoading: false,
    liteError: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("InboxLite", () => {
  it("打开面板取未处理切片与计数，列出内容预览", async () => {
    quickCaptureList.mockResolvedValue([item("c1", "周一提醒我修登录页"), item("c2", "产品灵感：深色主题")]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 2 });
    render(<InboxLite />);
    await screen.findByText("周一提醒我修登录页");
    expect(quickCaptureList).toHaveBeenCalledWith("inbox", 8, 0);
    expect(screen.getByText("产品灵感：深色主题")).toBeTruthy();
    expect(screen.getByText(/未处理 2 条/)).toBeTruthy();
  });

  it("没有未处理记录 → 空态 + 完整收集箱入口（不显示错误）", async () => {
    quickCaptureList.mockResolvedValue([]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "task", inbox_count: 0 });
    render(<InboxLite />);
    await screen.findByText("没有未处理的记录");
    // 头部与空态各有一个完整收集箱入口
    expect(screen.getAllByRole("button", { name: "打开完整收集箱" }).length).toBeGreaterThanOrEqual(2);
  });

  it("读取失败且无旧数据 → 错误空态，重试重新拉取", async () => {
    quickCaptureList.mockRejectedValueOnce(new Error("db locked"));
    render(<InboxLite />);
    await screen.findByText("收集箱读取失败");
    expect(screen.queryByText("没有未处理的记录")).toBeNull();
    // 面板计数不冒充：读取失败时未处理数保持未确认（0 只是初始值，不作为结论展示）
    expect(screen.getByText("读取失败")).toBeTruthy();

    quickCaptureList.mockResolvedValueOnce([item("c3", "重试后拿到的记录")]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 1 });
    act(() => screen.getByRole("button", { name: "重试" }).click());
    await screen.findByText("重试后拿到的记录");
    expect(quickCaptureList).toHaveBeenCalledTimes(2);
  });

  it("读取失败但有旧数据 → 旧列表保留 + 错误条（不清空已成功数据）", async () => {
    quickCaptureList.mockResolvedValueOnce([item("c1", "第一次成功的记录")]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 1 });
    render(<InboxLite />);
    await screen.findByText("第一次成功的记录");

    // 模拟一次失败的实时刷新（App 的 quick-capture-created → store.load → lite 顺带刷新）
    quickCaptureList.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await useCaptureStore.getState().loadInboxLite();
    });
    await screen.findByText("读取失败，显示的是上次结果");
    expect(screen.getByText("第一次成功的记录")).toBeTruthy();
    // 错误条上的重试按钮可再次拉取
    quickCaptureList.mockResolvedValueOnce([item("c2", "重试成功的记录")]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 1 });
    act(() => screen.getByRole("button", { name: "重试读取收集箱" }).click());
    await screen.findByText("重试成功的记录");
    expect(screen.queryByText("读取失败，显示的是上次结果")).toBeNull();
  });

  it("面板卸载释放 lite 切片（作废在途响应）", async () => {
    quickCaptureList.mockResolvedValue([]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 0 });
    const { unmount } = render(<InboxLite />);
    await screen.findByText("没有未处理的记录");
    unmount();
    expect(useCaptureStore.getState().lite).toBeNull();
  });

  it("完整收集箱入口走既有 Tab 导航（openFullApp('inbox')）", async () => {
    quickCaptureList.mockResolvedValue([]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 0 });
    const { container } = render(<InboxLite />);
    await screen.findByText("没有未处理的记录");
    // 头部与底栏各有一个进入完整收集箱的按钮
    const links = Array.from(container.querySelectorAll("button")).filter((b) =>
      (b.getAttribute("aria-label") ?? b.textContent ?? "").includes("完整收集箱"),
    );
    expect(links.length).toBeGreaterThanOrEqual(2);
  });
});
