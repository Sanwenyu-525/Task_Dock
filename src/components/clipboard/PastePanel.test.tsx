/**
 * @vitest-environment jsdom
 */
//! 逐项粘贴面板：只展示后端状态，不推断接收成功。
//! 覆盖目标选择、进度/逐项状态、取消、完成后不再提供取消或继续入口。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardVisibleTargets: vi.fn(),
  clipboardTargetIcon: vi.fn(),
  clipboardGroup: vi.fn(),
  clipboardPasteActive: vi.fn(),
  clipboardPasteJob: vi.fn(),
  clipboardPastePrecheck: vi.fn(),
  clipboardPasteGroup: vi.fn(),
  clipboardPasteItems: vi.fn(),
  clipboardPasteCancel: vi.fn(),
  clipboardPasteResume: vi.fn(),
  clipboardFocusTarget: vi.fn(),
  onClipboardPaste: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(),
}));
vi.mock("../../lib/bridge", () => bridge);

import PastePanel from "./PastePanel";
import type {
  ClipboardPasteEvent,
  PasteJob,
  PasteStartReport,
  PasteTarget,
} from "../../lib/bridge";
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

const COMPLETED_JOB: PasteJob = {
  id: "job-1",
  group_id: "group-1",
  target_title: "记事本",
  target_exe: "C:\\Windows\\notepad.exe",
  status: "completed",
  total: 3,
  sent: 3,
  started_at: "2026-11-04T00:00:00Z",
  ended_at: "2026-11-04T00:00:01Z",
  message: "已发送 3/3 项粘贴动作；目标应用是否接收无法自动验证（未确认 3 项）",
  remaining_items: [],
  restored: true,
};

let pasteHandler: ((event: ClipboardPasteEvent) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  pasteHandler = null;
  bridge.clipboardVisibleTargets.mockResolvedValue(TARGETS);
  // 图标属于增强信息：测试里统一返回 null，验证回退不阻塞选择/跳转。
  bridge.clipboardTargetIcon.mockResolvedValue(null);
  bridge.clipboardGroup.mockResolvedValue({
    id: "group-1",
    name: "测试分组",
    items: [{ id: "g1" }, { id: "g2" }, { id: "g3" }],
  });
  bridge.clipboardPasteActive.mockResolvedValue(null);
  bridge.clipboardPastePrecheck.mockResolvedValue(TARGETS[0]);
  bridge.clipboardPasteGroup.mockResolvedValue(START);
  bridge.clipboardPasteItems.mockResolvedValue(START);
  bridge.clipboardPasteCancel.mockResolvedValue(undefined);
  bridge.clipboardPasteJob.mockResolvedValue(null);
  bridge.clipboardFocusTarget.mockResolvedValue(TARGETS[0]);
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

/** 点击卡片只选中；启动前必须先显式选择目标（不自动选第一个窗口）。 */
function selectNotepad() {
  fireEvent.click(screen.getByRole("radio", { name: /记事本/ }));
}

describe("PastePanel", () => {
  it("默认只保留一句说明；展开后才显示间隔等技术细节，开始后显示逐项状态", async () => {
    await renderPanel();
    expect(screen.getByText("点击卡片选择目标，右侧箭头仅跳转，不执行粘贴。")).toBeTruthy();
    // 默认折叠：技术细节不占据首屏
    expect(screen.queryByText(/富文本 600 ms/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /操作说明/ }));
    expect(
      await screen.findByText(/文字 350 ms \/ 富文本 600 ms \/ 图片 1200 ms \/ 文件 900 ms/),
    ).toBeTruthy();

    selectNotepad();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));
    await waitFor(() =>
      expect(bridge.clipboardPasteGroup).toHaveBeenCalledWith("group-1", 101, 1001),
    );
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
    selectNotepad();
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
    selectNotepad();
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

  it("任意多选逐项粘贴：按所选顺序调用批量命令，不依赖永久分组", async () => {
    render(<PastePanel itemIds={["ci2", "ci0", "ci1"]} onBack={vi.fn()} />);
    await screen.findByText("记事本");
    expect(await screen.findByText(/所选 3 项/)).toBeTruthy();

    selectNotepad();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));

    await waitFor(() =>
      expect(bridge.clipboardPasteItems).toHaveBeenCalledWith(101, 1001, ["ci2", "ci0", "ci1"]),
    );
    expect(bridge.clipboardPasteGroup).not.toHaveBeenCalled();
    expect(await screen.findByText(/已发送 0\/3 项/)).toBeTruthy();
  });

  it("逐项状态 chip 按固定顺序累计更新，事件乱序不重排、其他任务不影响", async () => {
    await renderPanel();
    selectNotepad();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));
    await waitFor(() => expect(bridge.clipboardPasteGroup).toHaveBeenCalled());

    // 初始全部待处理，顺序为组内条目顺序
    expect(screen.getAllByRole("listitem").map((c) => c.textContent)).toEqual([
      "1待处理",
      "2待处理",
      "3待处理",
    ]);

    const ev = (itemId: string, itemState: string, jobId = "job-1") =>
      pasteHandler?.({
        jobId,
        status: "running",
        sent: 1,
        total: 3,
        pending: 2,
        itemId,
        itemState,
      });

    ev("g2", "failed");
    ev("g1", "unverified");
    // 其他任务的事件不得影响本任务的状态
    ev("g3", "failed", "job-other");

    await waitFor(() => expect(screen.getAllByRole("listitem")[1].textContent).toBe("2失败"));
    expect(screen.getAllByRole("listitem").map((c) => c.textContent)).toEqual([
      "1未确认",
      "2失败",
      "3待处理",
    ]);

    ev("g3", "input_sent");
    await waitFor(() => expect(screen.getAllByRole("listitem")[2].textContent).toBe("3已发送"));
    expect(screen.getAllByRole("listitem").map((c) => c.textContent)).toEqual([
      "1未确认",
      "2失败",
      "3已发送",
    ]);
  });

  it("多选模式的逐项 chip 遵循传入顺序", async () => {
    render(<PastePanel itemIds={["ci2", "ci0", "ci1"]} onBack={vi.fn()} />);
    await screen.findByText("记事本");
    selectNotepad();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));
    expect(await screen.findByText(/已发送 0\/3 项/)).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((c) => c.textContent)).toEqual([
      "1待处理",
      "2待处理",
      "3待处理",
    ]);
  });

  it("不自动选第一个窗口：未选中时开始按钮禁用，点卡片只选中、不跳转不粘贴", async () => {
    await renderPanel();
    expect(bridge.clipboardPasteGroup).not.toHaveBeenCalled();
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /记事本/ }).getAttribute("aria-checked")).toBe("false");
    expect(
      (screen.getByRole("button", { name: /开始逐项粘贴/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("请先选择目标窗口")).toBeTruthy();

    selectNotepad();
    expect(screen.queryByText("请先选择目标窗口")).toBeNull();
    expect(screen.getByRole("radio", { name: /记事本/ }).getAttribute("aria-checked")).toBe("true");
    expect(bridge.clipboardPasteGroup).not.toHaveBeenCalled();
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /开始逐项粘贴/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("跳转按钮只选中并调用聚焦命令，不触发粘贴", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "跳转到该窗口：VS Code" }));

    await waitFor(() => expect(bridge.clipboardFocusTarget).toHaveBeenCalledWith(202, 2002));
    expect(bridge.clipboardPasteGroup).not.toHaveBeenCalled();
    expect(bridge.clipboardPasteItems).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /VS Code/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("跳转失败只提示，不启动粘贴、不改变执行状态", async () => {
    await renderPanel();
    bridge.clipboardFocusTarget.mockRejectedValue(
      "目标窗口已关闭或句柄被其他窗口复用，请刷新窗口列表后重新选择",
    );
    fireEvent.click(screen.getByRole("button", { name: "跳转到该窗口：记事本" }));

    await waitFor(() => expect(bridge.clipboardFocusTarget).toHaveBeenCalledWith(101, 1001));
    expect(bridge.clipboardPasteGroup).not.toHaveBeenCalled();
    expect(screen.queryByText(/已发送/)).toBeNull();
  });

  it("启动竞态：任务秒完成时以主动拉取为准，不停留在进行中", async () => {
    await renderPanel();
    bridge.clipboardPasteJob.mockResolvedValue(COMPLETED_JOB);
    selectNotepad();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));

    expect(await screen.findByText("已完成")).toBeTruthy();
    expect(screen.getByText(/已发送 3\/3 项粘贴动作/)).toBeTruthy();
  });

  it("旧任务事件不得覆盖当前任务", async () => {
    await renderPanel();
    selectNotepad();
    fireEvent.click(screen.getByRole("button", { name: /开始逐项粘贴/ }));
    await waitFor(() => expect(bridge.clipboardPasteGroup).toHaveBeenCalled());

    pasteHandler?.({
      jobId: "job-old",
      status: "failed",
      sent: 0,
      total: 1,
      pending: 1,
      message: "旧任务失败",
    });

    expect(screen.queryByText("已停止")).toBeNull();
    expect(await screen.findByText("进行中")).toBeTruthy();
  });

  it("刷新后目标消失则清空选择并要求重选", async () => {
    await renderPanel();
    selectNotepad();
    bridge.clipboardVisibleTargets.mockResolvedValue([TARGETS[1]]);
    fireEvent.click(screen.getByRole("button", { name: /刷新/ }));

    await waitFor(() => expect(screen.queryByText("记事本")).toBeNull());
    expect(screen.getByRole("radio", { name: /VS Code/ }).getAttribute("aria-checked")).toBe("false");
    expect(
      (screen.getByRole("button", { name: /开始逐项粘贴/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
