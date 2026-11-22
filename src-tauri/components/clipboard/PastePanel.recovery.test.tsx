/**
 * @vitest-environment jsdom
 */
//! 第三轮 3.3/3.2/3.5 收口：历史任务顺序由数据库 position 重建、uncertain 绑定历史 job/item、
//! 多任务选择、持久化失败兜底。顺序/状态语义来自构造的逐项状态行，不依赖理想化 IPC 返回。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardVisibleTargets: vi.fn(),
  clipboardTargetIcon: vi.fn(),
  clipboardGroup: vi.fn(),
  clipboardPasteActive: vi.fn(),
  clipboardPasteJob: vi.fn(),
  clipboardPasteItemStates: vi.fn(),
  clipboardPastePrecheck: vi.fn(),
  clipboardPasteGroup: vi.fn(),
  clipboardPasteItems: vi.fn(),
  clipboardPasteCancel: vi.fn(),
  clipboardPasteResume: vi.fn(),
  clipboardFocusTarget: vi.fn(),
  clipboardPasteResumableJob: vi.fn(),
  clipboardPasteResumableJobs: vi.fn(),
  clipboardPasteResolveUncertain: vi.fn(),
  onClipboardPaste: vi.fn(),
}));
vi.mock("../../lib/bridge", () => bridge);

import PastePanel from "./PastePanel";
import type {
  ClipboardPasteEvent,
  PasteItemState,
  PasteJob,
  PasteTarget,
} from "../../lib/bridge";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

const TARGETS: PasteTarget[] = [
  { hwnd: 101, pid: 1001, title: "记事本", exe_path: "C:\\Windows\\notepad.exe" },
  { hwnd: 202, pid: 2002, title: "VS Code", exe_path: "C:\\Apps\\Code.exe" },
];

function makeJob(over: Partial<PasteJob> = {}): PasteJob {
  return {
    id: "job-x",
    group_id: "group-1",
    target_title: "记事本",
    target_exe: "C:\\Windows\\notepad.exe",
    status: "paused",
    total: 3,
    sent: 1,
    started_at: "2026-11-15T08:00:00Z",
    ended_at: null,
    message: "",
    remaining_items: [],
    uncertain_items: [],
    restored: false,
    ...over,
  };
}

function makeRow(jobId: string, position: number, itemId: string, state: string): PasteItemState {
  return {
    job_id: jobId,
    position,
    item_id: itemId,
    kind: "text",
    state,
    error_message: "",
    started_at: null,
    finished_at: null,
    key_sent: false,
    confirmed: false,
    retry_safe: true,
  };
}

let pasteHandler: ((event: ClipboardPasteEvent) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  pasteHandler = null;
  bridge.clipboardVisibleTargets.mockResolvedValue(TARGETS);
  bridge.clipboardTargetIcon.mockResolvedValue(null);
  bridge.clipboardGroup.mockResolvedValue({
    id: "group-1",
    name: "测试分组",
    items: [{ id: "cur1" }, { id: "cur2" }, { id: "cur3" }],
  });
  bridge.clipboardPasteActive.mockResolvedValue(null);
  bridge.clipboardPasteItemStates.mockResolvedValue([]);
  bridge.clipboardPasteResumableJob.mockResolvedValue(null);
  bridge.clipboardPasteResumableJobs.mockResolvedValue([]);
  bridge.clipboardPasteJob.mockResolvedValue(null);
  bridge.clipboardPasteResolveUncertain.mockResolvedValue(undefined);
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
  // 恢复被删除的 plural 导出，避免影响后续用例。
  (bridge as unknown as Record<string, unknown>).clipboardPasteResumableJobs =
    vi.fn().mockResolvedValue([]);
});

async function renderPanel() {
  render(<PastePanel groupId="group-1" groupName="测试分组" onBack={vi.fn()} />);
  await screen.findByRole("radio", { name: /记事本/ });
  await waitFor(() => expect(pasteHandler).not.toBeNull());
}

function chipTexts(): string[] {
  return screen.getAllByRole("listitem").map((c) => c.textContent ?? "");
}

describe("PastePanel 历史任务顺序恢复（3.3）", () => {
  it("场景1：当前选择与历史任务完全相同，顺序与状态一致", async () => {
    const job = makeJob({ id: "job-same" });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 0, "cur1", "confirmed"),
      makeRow(job.id, 1, "cur2", "unverified"),
      makeRow(job.id, 2, "cur3", "pending"),
    ]);

    await renderPanel();
    await waitFor(() =>
      expect(chipTexts()).toEqual(["1已确认", "2未确认", "3待处理"]),
    );
  });

  it("场景2：当前选择与历史任务不同，历史顺序按 position 重建，不被当前选择覆盖", async () => {
    const job = makeJob({ id: "job-diff" });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    // 返回数组顺序故意打乱，position 才是唯一顺序依据；状态差异化以便从 chip 文本辨认顺序。
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 2, "h3", "pending"),
      makeRow(job.id, 0, "h1", "confirmed"),
      makeRow(job.id, 1, "h2", "unverified"),
    ]);

    await renderPanel();
    // 顺序为 h1(已确认) → h2(未确认) → h3(待处理)，而不是当前选择 cur1/cur2/cur3。
    await waitFor(() =>
      expect(chipTexts()).toEqual(["1已确认", "2未确认", "3待处理"]),
    );
  });

  it("场景3：历史任务属于另一个分组，不串数据、不进入主任务", async () => {
    bridge.clipboardPasteResumableJobs.mockResolvedValue([
      makeJob({ id: "job-other", group_id: "group-2", status: "running", target_title: "VS Code" }),
    ]);

    await renderPanel();
    // 其他分组任务只进 otherJob 警告，不进入主任务卡片。
    expect(await screen.findByText(/另一个分组正在粘贴/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "可恢复的粘贴任务" })).toBeNull();
    expect(screen.queryByText(/已发送/)).toBeNull();
    expect(bridge.clipboardPasteItemStates).not.toHaveBeenCalled();
  });

  it("场景4：分组条目集合/position 变化后，顺序仍按数据库 position 重建", async () => {
    const job = makeJob({ id: "job-edited", remaining_items: ["z"], uncertain_items: ["y"] });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 2, "z", "pending"),
      makeRow(job.id, 0, "x", "confirmed"),
      makeRow(job.id, 1, "y", "uncertain"),
    ]);

    await renderPanel();
    await waitFor(() =>
      expect(chipTexts()).toEqual(["1已确认", "2不确定", "3待处理"]),
    );
  });

  it("场景6：一个任务有 2 个 uncertain，各自按钮指向正确 item_id，处置一个不影响另一个", async () => {
    const job = makeJob({
      id: "job-two-uncertain",
      uncertain_items: ["u1", "u2"],
      remaining_items: ["u2"],
    });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    // 处置 u1 后主动拉取：u2 仍是 uncertain，u1 已被确认。
    bridge.clipboardPasteJob.mockResolvedValue(
      makeJob({ id: job.id, uncertain_items: ["u2"], remaining_items: ["u2"] }),
    );
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 0, "u1", "uncertain"),
      makeRow(job.id, 1, "u2", "uncertain"),
      makeRow(job.id, 2, "ok1", "confirmed"),
    ]);

    await renderPanel();
    const group = await screen.findByRole("group", { name: "结果不确定项处置" });
    const rows = group.querySelectorAll(".clip-paste-uncertain-row");
    expect(rows.length).toBe(2);

    // 处置 u1：jobId/itemId 都必须是历史任务与历史条目。
    rows[0].querySelectorAll("button")[0]?.click();
    await waitFor(() =>
      expect(bridge.clipboardPasteResolveUncertain).toHaveBeenCalledWith(
        job.id,
        "u1",
        "received",
      ),
    );

    // u2 的处置入口仍在，且绑定自己的 item_id。
    const groupAfter = screen.getByRole("group", { name: "结果不确定项处置" });
    expect(groupAfter.querySelectorAll(".clip-paste-uncertain-row").length).toBe(1);
    const resend = screen.getByRole("button", { name: /没收到，重发/ });
    resend.click();
    await waitFor(() =>
      expect(bridge.clipboardPasteResolveUncertain).toHaveBeenCalledWith(
        job.id,
        "u2",
        "resend",
      ),
    );
  });

  it("场景7：只有 uncertain、没有 remaining 的任务也能被找到并处置", async () => {
    const job = makeJob({
      id: "job-uncertain-only",
      remaining_items: [],
      uncertain_items: ["u1"],
    });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    bridge.clipboardPasteItemStates.mockResolvedValue([makeRow(job.id, 0, "u1", "uncertain")]);

    await renderPanel();
    const group = await screen.findByRole("group", { name: "结果不确定项处置" });
    expect(group.querySelectorAll(".clip-paste-uncertain-row").length).toBe(1);
    // 没有剩余条目时不提供「继续剩余」入口。
    expect(screen.queryByRole("button", { name: /继续剩余/ })).toBeNull();

    screen.getByRole("button", { name: /已收到/ }).click();
    await waitFor(() =>
      expect(bridge.clipboardPasteResolveUncertain).toHaveBeenCalledWith(
        job.id,
        "u1",
        "received",
      ),
    );
  });

  it("场景8：页面卸载后重新挂载，仍能处置全部 unresolved uncertain", async () => {
    const job = makeJob({ id: "job-remount", uncertain_items: ["u1", "u2"] });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 0, "u1", "uncertain"),
      makeRow(job.id, 1, "u2", "uncertain"),
    ]);

    render(<PastePanel groupId="group-1" groupName="测试分组" onBack={vi.fn()} />);
    await screen.findByRole("group", { name: "结果不确定项处置" });
    cleanup();

    // 重新挂载：effect 重新拉取历史状态，两个 uncertain 都应恢复可处置。
    render(<PastePanel groupId="group-1" groupName="测试分组" onBack={vi.fn()} />);
    const group = await screen.findByRole("group", { name: "结果不确定项处置" });
    expect(group.querySelectorAll(".clip-paste-uncertain-row").length).toBe(2);

    const received = screen.getAllByRole("button", { name: /已收到/ });
    expect(received.length).toBe(2);
    received[1].click();
    await waitFor(() =>
      expect(bridge.clipboardPasteResolveUncertain).toHaveBeenCalledWith(
        job.id,
        "u2",
        "received",
      ),
    );
  });
});

describe("PastePanel 多任务选择（3.2）", () => {
  it("场景5：多个历史任务存在时可明确选择，各自顺序独立、不串条目", async () => {
    const jobA = makeJob({ id: "job-a", target_title: "记事本" });
    const jobB = makeJob({ id: "job-b", target_title: "VS Code" });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([jobA, jobB]);
    // 只有选中后才查询对应任务的逐项状态。
    bridge.clipboardPasteItemStates.mockImplementation((jobId: string) => {
      if (jobId === jobA.id) {
        return Promise.resolve([
          makeRow(jobA.id, 0, "a1", "confirmed"),
          makeRow(jobA.id, 1, "a2", "pending"),
        ]);
      }
      return Promise.resolve([
        makeRow(jobB.id, 0, "b1", "uncertain"),
        makeRow(jobB.id, 1, "b2", "pending"),
        makeRow(jobB.id, 2, "b3", "confirmed"),
      ]);
    });

    await renderPanel();
    const selector = await screen.findByRole("group", { name: "可恢复的粘贴任务" });
    const rows = selector.querySelectorAll(".clip-paste-uncertain-row");
    expect(rows.length).toBe(2);

    // 选择第二个任务：载入 job-b 的顺序，不混入 job-a 的条目。
    const pickButtons = screen.getAllByRole("button", { name: /继续 \/ 查看/ });
    expect(pickButtons.length).toBe(2);
    pickButtons[1].click();

    await waitFor(() =>
      expect(bridge.clipboardPasteItemStates).toHaveBeenCalledWith(jobB.id),
    );
    // job-b 顺序：b1(不确定) → b2(待处理) → b3(已确认)，不混入 job-a 条目。
    await waitFor(() =>
      expect(chipTexts()).toEqual(["1不确定", "2待处理", "3已确认"]),
    );
  });

  it("桥接 plural 导出缺失时退回单任务路径：界面不崩、不伪造多任务列表", async () => {
    const bridgeAny = bridge as unknown as Record<string, unknown>;
    // 模拟 plural 导出尚未落地：特性检测拿到 undefined，走现有单任务回退路径。
    bridgeAny.clipboardPasteResumableJobs = undefined;
    const job = makeJob({ id: "job-fallback" });
    bridge.clipboardPasteResumableJob.mockResolvedValue(job);
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 0, "fb1", "pending"),
    ]);

    render(<PastePanel groupId="group-1" groupName="测试分组" onBack={vi.fn()} />);
    await waitFor(() => expect(bridge.clipboardPasteResumableJob).toHaveBeenCalled());
    expect(bridgeAny.clipboardPasteResumableJobs).toBeUndefined();
    expect(screen.queryByRole("group", { name: "可恢复的粘贴任务" })).toBeNull();
    await waitFor(() => expect(chipTexts()).toEqual(["1待处理"]));
  });
});

describe("PastePanel 持久化失败兜底（3.5）", () => {
  it("finish_persist_failed：不显示已完成，保留条目与 uncertain 列表", async () => {
    const job = makeJob({
      id: "job-persist-failed",
      status: "finish_persist_failed",
      uncertain_items: ["u1"],
    });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 0, "u1", "uncertain"),
      makeRow(job.id, 1, "ok1", "confirmed"),
    ]);

    await renderPanel();
    const persistNotes = await screen.findAllByText(/收尾状态写入失败/);
    expect(persistNotes.length).toBeGreaterThan(0);
    expect(screen.queryByText("已完成")).toBeNull();
    // 条目与 uncertain 处置入口保留。
    expect(screen.getAllByRole("listitem").length).toBe(2);
    expect(screen.getByRole("group", { name: "结果不确定项处置" })).toBeTruthy();

    // 运行期收到持久化失败事件：同样不得清空既有状态。
    pasteHandler?.({
      jobId: job.id,
      status: "finish_persist_failed",
      sent: 1,
      total: 2,
      pending: 0,
      uncertain: 1,
      reasonCode: "PASTE_JOB_FINISH_PERSIST_FAILED",
    });
    await waitFor(() => expect(screen.queryByText("已完成")).toBeNull());
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });

  it("未知状态值有兜底显示，不白屏也不冒充成功", async () => {
    const job = makeJob({ id: "job-unknown", status: "brand_new_status" });
    bridge.clipboardPasteResumableJobs.mockResolvedValue([job]);
    bridge.clipboardPasteItemStates.mockResolvedValue([
      makeRow(job.id, 0, "x1", "pending"),
    ]);

    await renderPanel();
    await waitFor(() => expect(screen.getByText("brand_new_status")).toBeTruthy());
    expect(screen.queryByText("已完成")).toBeNull();
  });
});
