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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

const quickCaptureList = vi.fn();
const quickCaptureState = vi.fn();
const markHandled = vi.fn();
const convertToTask = vi.fn();
const dropTargets = vi.fn();

vi.mock("../../lib/bridge", () => ({
  quickCaptureList: (...a: unknown[]) => quickCaptureList(...a),
  quickCaptureState: (...a: unknown[]) => quickCaptureState(...a),
  quickCaptureMarkHandled: (...a: unknown[]) => markHandled(...a),
  quickCaptureDelete: vi.fn(),
  quickCaptureConvertToTask: (...a: unknown[]) => convertToTask(...a),
  quickCaptureSaveDraft: vi.fn(),
  quickCaptureClearDraft: vi.fn(),
  quickCaptureSetLastType: vi.fn(),
  quickCaptureSubmit: vi.fn(),
  quickCaptureHide: vi.fn(),
  applyMode: async () => undefined,
  // 文件子页（默认不挂载，仍补齐导出，避免 mock 缺导出报错）
  shelfDropTargets: (...a: unknown[]) => dropTargets(...a),
  shelfDropTargetCreate: vi.fn(),
  shelfDropTargetUpdate: vi.fn(),
  shelfDropTargetDelete: vi.fn(),
  shelfDropTargetMove: vi.fn(),
  shelfDropTargetOpen: vi.fn(),
  shelfDropToDirectory: vi.fn(),
  // 最近暂存
  shelfList: vi.fn(async () => ({ items: [], total: 0 })),
  shelfCheckExists: vi.fn(async () => []),
  shelfOpenItem: vi.fn(async () => undefined),
  shelfCopyFiles: vi.fn(async () => 1),
  shelfCopyPaths: vi.fn(async () => 1),
  shelfAddPaths: vi.fn(async () => ({ added: [], failed: [] })),
  SHELF_KIND_LABELS: {
    file: "文件",
    image: "图片",
    folder: "文件夹",
    link: "链接",
    text: "文本",
  },
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
  localStorage.clear();
  quickCaptureList.mockReset();
  quickCaptureState.mockReset();
  markHandled.mockReset();
  convertToTask.mockReset();
  dropTargets.mockReset();
  dropTargets.mockResolvedValue([]);
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

  it("快捷转为任务：调用既有命令并立即移出未处理列表", async () => {
    quickCaptureList.mockResolvedValue([item("c1", "周一提醒我修登录页")]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 1 });
    convertToTask.mockResolvedValue(item("c1", "周一提醒我修登录页", { status: "converted", task_id: "t1" }));
    render(<InboxLite />);
    await screen.findByText("周一提醒我修登录页");

    fireEvent.click(screen.getByRole("button", { name: "将「周一提醒我修登录页」转为任务" }));
    await waitFor(() => expect(convertToTask).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("周一提醒我修登录页")).toBeNull());
    expect(screen.getByText("已转为任务")).toBeTruthy();
  });

  it("标记已处理失败：记录保留并给出可重试提示", async () => {
    quickCaptureList.mockResolvedValue([item("c2", "产品灵感：深色主题")]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 1 });
    markHandled.mockRejectedValue(new Error("db locked"));
    render(<InboxLite />);
    await screen.findByText("产品灵感：深色主题");

    fireEvent.click(screen.getByRole("button", { name: "标记「产品灵感：深色主题」已处理" }));
    await screen.findByText("标记失败，请重试");
    expect(markHandled).toHaveBeenCalledWith("c2");
    expect(screen.getByText("产品灵感：深色主题")).toBeTruthy();
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

  it("切到「文件」：保留快速收集列表，投递子页读取目标配置", async () => {
    quickCaptureList.mockResolvedValue([item("c1", "未处理的一条")]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 1 });
    render(<InboxLite />);
    await screen.findByText("未处理的一条");

    fireEvent.click(screen.getByRole("tab", { name: "文件" }));
    await screen.findByText("还没有文件投递目标");
    expect(dropTargets).toHaveBeenCalledTimes(1);
    // 切换是卸载而不是叠加：快速收集的列表不再渲染
    expect(screen.queryByText("未处理的一条")).toBeNull();
    expect(screen.getByText(/拖文件到卡片即可投递|把文件拖到目标卡片/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "快速收集" }));
    await screen.findByText("未处理的一条");
  });

  it("记住上次使用的子页（localStorage），下次打开直达文件子页", async () => {
    quickCaptureList.mockResolvedValue([]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 0 });
    const first = render(<InboxLite />);
    await screen.findByText("没有未处理的记录");
    fireEvent.click(screen.getByRole("tab", { name: "文件" }));
    await screen.findByText("还没有文件投递目标");
    expect(localStorage.getItem("taskdock.capsule.inbox.sub.v1")).toBe("drop");
    first.unmount();

    render(<InboxLite />);
    // 重新打开直接落在文件子页
    await screen.findByText("还没有文件投递目标");
    expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
  });

  it("读取 localStorage 失败时回落到快速收集（不因偏好存储异常白屏）", async () => {
    const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    quickCaptureList.mockResolvedValue([]);
    quickCaptureState.mockResolvedValue({ draft: null, last_type: "text", inbox_count: 0 });
    render(<InboxLite />);
    await screen.findByText("没有未处理的记录");
    expect(screen.getByRole("tab", { name: "快速收集" }).getAttribute("aria-selected")).toBe("true");
    spy.mockRestore();
  });
});
