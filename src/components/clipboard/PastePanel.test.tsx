/**
 * @vitest-environment jsdom
 */
//! 逐项粘贴面板：只展示后端状态，不推断接收成功。
//! 覆盖目标选择、进度/逐项状态、取消、完成后不再提供取消或继续入口。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardVisibleTargets: vi.fn(),
  clipboardPasteActive: vi.fn(),
  clipboardPasteJob: vi.fn(),
  clipboardPastePrecheck: vi.fn(),
  clipboardPasteGroup: vi.fn(),
  clipboardPasteCancel: vi.fn(),
  clipboardPasteResume: vi.fn(),
  onClipboardPaste: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(),
}));
vi.mock("../../lib/bridge", () => bridge);

import PastePanel from "./PastePanel";
import type { ClipboardPasteEvent, PasteStartReport, PasteTarget } from "../../lib/bridge";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

const TARGETS: PasteTarget[] = [
  { hwnd: 101, pid: 1001, title: "记事本", exe_path: "C:\\Windows\\notepad.exe" },
  { hwnd: 202, pid: 2002, title: "VS Code", exe_path: "C:\\Apps\\Code.exe" },
];

const START: PasteStartReport = {
  job_id: "job-1",
  target: TARGETS[0],
  total: 3,
  interval_ms: 350,
  intervals: { text_ms: 350, html_ms: 600, image_ms: 1200, files_ms: 900 },
};

let pasteHandler: ((event: ClipboardPasteEvent) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  pasteHandler = null;
  bridge.clipboardVisibleTargets.mockResolvedValue(TARGETS);
  bridge.clipboardPasteActive.mockResolvedValue(null);
  bridge.clipboardPastePrecheck.mockResolvedValue(TARGETS[0]);
  bridge.clipboardPasteGroup.mockResolvedValue(START);
  bridge.clipboardPasteCancel.mockResolvedValue(undefined);
  bridge.onClipboardPaste.mockImplementation((cb: (event: ClipboardPasteEvent) => void) => {
    pasteHandler = cb;
    return Promise.resolve(() => {
      pasteHandler = null;
    });
  });
  useSettingsStore.setState({
    settings: {
      clipboard_paste_interval_ms: 350,
      clipboard_paste_interval_html_ms: 600,
      clipboard_paste_interval_image_ms: 1200,
      clipboard_paste_interval_files_ms: 900,
    } as never,
  });
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: null });
});

async function renderPanel() {
  render(<PastePanel groupId="group-1" groupName="测试分组" onBack={vi.fn()} />);
  await screen.findByText("记事本");
  await waitFor(() => expect(pasteHandler).not.toBeNull());
}

describe("PastePanel", () => {
  it("展示分类间隔；开始后显示逐项状态与剩余数量", async () => {
    await renderPanel();
    expect(
      screen.getByText(/文字 350 ms \/ 富文本 600 ms \/ 图片 1200 ms \/ 文件 900 ms/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));
    await waitFor(() => expect(bridge.clipboardPasteGroup).toHaveBeenCalledWith("group-1", 101));
    expect(await screen.findByText(/已发送 0\/3 项/)).toBeTruthy();

    pasteHandler?.({
      jobId: "job-1",
      status: "running",
      sent: 1,
      total: 3,
      pending: 2,
      itemState: "settling",
      message: "第 1 项按键已发送，等待目标处理",
    });

    expect(await screen.findByText(/当前：等待目标处理/)).toBeTruthy();
    expect(screen.getByText(/剩余 2 项/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  });

  it("取消只发送取消请求，不把未确认当作失败", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));
    await waitFor(() => expect(bridge.clipboardPasteGroup).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /取消粘贴/ }));
    await waitFor(() => expect(bridge.clipboardPasteCancel).toHaveBeenCalledWith("job-1"));

    pasteHandler?.({
      jobId: "job-1",
      status: "cancelled",
      sent: 1,
      total: 3,
      pending: 2,
      itemState: "unverified",
      message: "已取消；已发送项接收情况未知",
    });

    expect(await screen.findByText(/未确认（无接收信号）/)).toBeTruthy();
    expect(screen.getByText("已取消")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /取消粘贴/ })).toBeNull();
    expect(screen.getByRole("button", { name: /继续剩余 2 项/ })).toBeTruthy();
  });

  it("完成后显示如实结论，不再提供取消或继续入口", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));
    await waitFor(() => expect(bridge.clipboardPasteGroup).toHaveBeenCalled());

    pasteHandler?.({
      jobId: "job-1",
      status: "completed",
      sent: 3,
      total: 3,
      pending: 0,
      confirmed: 0,
      unverified: 3,
      message: "已发送 3/3 项粘贴动作；目标应用是否接收无法自动验证（未确认 3 项）",
    });

    expect(await screen.findByText("已完成")).toBeTruthy();
    expect(screen.getByText(/已发送 3\/3 项粘贴动作/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /取消粘贴/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /继续剩余/ })).toBeNull();
  });
});
