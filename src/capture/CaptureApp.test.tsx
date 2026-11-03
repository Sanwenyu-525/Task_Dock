/**
 * @vitest-environment jsdom
 */
//! 快速捕获窗口：类型切换不清空、空内容禁用、提交成功/失败/防重、
//! 草稿恢复与落盘、Ctrl+Enter / Esc、IME 组合输入保护、关闭与主题落地。
//! Tauri IPC 与事件订阅全部打桩，只断言调用参数与 DOM 状态。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

interface SubmitInputLike {
  client_id: string;
  kind: string;
  content: string;
  url?: string;
  note?: string;
}

interface SubmitResultLike {
  id: string;
  kind: string;
  status: string;
  task_id: string | null;
  duplicate: boolean;
  created_at: string;
}

interface CaptureStateLike {
  draft: { kind: string; content: string; updated_at: string } | null;
  last_type: string;
  inbox_count: number;
}

function okSubmit(input: SubmitInputLike): SubmitResultLike {
  return {
    id: "capture-1",
    kind: input.kind,
    status: "converted",
    task_id: "task-1",
    duplicate: false,
    created_at: "2026-11-03T04:05:00",
  };
}

const bridge = vi.hoisted(() => {
  const summoned: Array<() => void> = [];
  const hidden: Array<() => void> = [];
  const flushDraft: Array<() => void> = [];
  return {
    summoned,
    hidden,
    flushDraft,
    getSettings: vi.fn(),
    quickCaptureState: vi.fn(),
    quickCaptureSaveDraft: vi.fn(),
    quickCaptureSetLastType: vi.fn(),
    quickCaptureSubmit: vi.fn(),
    quickCaptureHide: vi.fn(),
    onQuickCaptureSummoned: vi.fn((cb: () => void) => {
      summoned.push(cb);
      return Promise.resolve(() => undefined);
    }),
    onQuickCaptureHidden: vi.fn((cb: () => void) => {
      hidden.push(cb);
      return Promise.resolve(() => undefined);
    }),
    onCaptureFlushDraft: vi.fn((cb: () => void) => {
      flushDraft.push(cb);
      return Promise.resolve(() => undefined);
    }),
  };
});

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return { ...actual, ...bridge };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import CaptureApp from "./CaptureApp";

const DEFAULT_STATE: CaptureStateLike = { draft: null, last_type: "task", inbox_count: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderCapture() {
  const utils = render(<CaptureApp />);
  await waitFor(() => expect(bridge.quickCaptureState).toHaveBeenCalled());
  // 让 applyState 的 finally（hydrated / 聚焦）落定
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("捕获内容") as HTMLTextAreaElement;
}

function radio(name: string): HTMLElement {
  return screen.getByRole("radio", { name });
}

function checked(name: string): string | null {
  return radio(name).getAttribute("aria-checked");
}

beforeEach(() => {
  bridge.summoned.length = 0;
  bridge.hidden.length = 0;
  bridge.flushDraft.length = 0;
  vi.clearAllMocks();
  bridge.getSettings.mockResolvedValue({ theme: "dark", visual_preset: "liquid-glass" });
  bridge.quickCaptureState.mockResolvedValue({ ...DEFAULT_STATE });
  bridge.quickCaptureSaveDraft.mockResolvedValue({ saved_at: "2026-11-03T04:05:00" });
  bridge.quickCaptureSetLastType.mockResolvedValue(undefined);
  bridge.quickCaptureSubmit.mockImplementation(async (input: SubmitInputLike) => okSubmit(input));
  bridge.quickCaptureHide.mockResolvedValue(undefined);
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.preset;
});

afterEach(() => {
  cleanup();
});

describe("CaptureApp / 初始状态", () => {
  it("挂载后同步 last_type，空内容禁用保存，五个类型单选按钮齐全", async () => {
    await renderCapture();
    expect(screen.getByRole("heading", { name: "快速捕获" })).toBeTruthy();
    expect(textarea().value).toBe("");
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(checked("任务：解析时间并创建任务")).toBe("true");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/草稿已保存/)).toBeNull();
    // 首次使用默认任务：last_type 为 task 时不会额外写回
    expect(bridge.quickCaptureSetLastType).not.toHaveBeenCalled();
  });

  it("last_type 为想法时默认选中想法（首次使用仍回落到任务）", async () => {
    bridge.quickCaptureState.mockResolvedValue({
      draft: null,
      last_type: "idea",
      inbox_count: 2,
    });
    await renderCapture();
    expect(checked("想法：存入收集箱")).toBe("true");
    expect(screen.getByText("想法", { selector: ".capture-kind-tag" })).toBeTruthy();
  });

  it("主题快照落地到 data-theme / data-preset", async () => {
    await renderCapture();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(document.documentElement.dataset.preset).toBe("liquid-glass");
  });
});

describe("CaptureApp / 类型切换与建议", () => {
  it("切换类型不清空内容，并立即保存草稿 + 记住 last_type", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "整理需求" } });
    fireEvent.click(radio("想法：存入收集箱"));
    expect(textarea().value).toBe("整理需求");
    expect(checked("想法：存入收集箱")).toBe("true");
    expect(bridge.quickCaptureSetLastType).toHaveBeenCalledWith("idea");
    await waitFor(() =>
      expect(bridge.quickCaptureSaveDraft).toHaveBeenCalledWith("idea", "整理需求"),
    );
  });

  it("方向键在单选组内循环切换，Home/End 跳到首尾", async () => {
    await renderCapture();
    const group = screen.getByRole("radiogroup", { name: "捕获类型" });
    radio("任务：解析时间并创建任务").focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(checked("想法：存入收集箱")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(checked("任务：解析时间并创建任务")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(checked("链接：保存链接与备注")).toBe("true");
    fireEvent.keyDown(group, { key: "Home" });
    expect(checked("任务：解析时间并创建任务")).toBe("true");
    fireEvent.keyDown(group, { key: "End" });
    expect(checked("链接：保存链接与备注")).toBe("true");
  });

  it("自动识别只显示建议按钮，绝不静默改类型；点击才切换", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "https://example.com/x" } });
    expect(checked("任务：解析时间并创建任务")).toBe("true");
    const suggest = screen.getByRole("button", { name: "建议：链接" });
    expect(bridge.quickCaptureSetLastType).not.toHaveBeenCalled();
    fireEvent.click(suggest);
    expect(checked("链接：保存链接与备注")).toBe("true");
    expect(textarea().value).toBe("https://example.com/x");
    expect(screen.queryByRole("button", { name: "建议：链接" })).toBeNull();
  });

  it("时间词给出「建议：任务」按钮，但不会自动切换", async () => {
    await renderCapture();
    fireEvent.click(radio("想法：存入收集箱"));
    fireEvent.change(textarea(), { target: { value: "明天 10 点交周报" } });
    expect(checked("想法：存入收集箱")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "建议：任务" }));
    expect(checked("任务：解析时间并创建任务")).toBe("true");
  });
});

describe("CaptureApp / 草稿", () => {
  it("输入后防抖保存，只展示后端确认的 saved_at", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "写周报" } });
    // 后端未确认前只能显示「待保存…」，不能预支「已保存」
    expect(screen.getByText("待保存…")).toBeTruthy();
    expect(bridge.quickCaptureSaveDraft).not.toHaveBeenCalled();
    await waitFor(
      () => expect(bridge.quickCaptureSaveDraft).toHaveBeenCalledWith("task", "写周报"),
      { timeout: 2000 },
    );
    await waitFor(() => expect(screen.getByText("草稿已保存 04:05")).toBeTruthy());
  });

  it("保存失败显示可重试按钮，点击重试成功后恢复已保存状态", async () => {
    bridge.quickCaptureSaveDraft.mockRejectedValueOnce(new Error("db locked"));
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "草稿内容" } });
    const retry = await screen.findByRole("button", { name: "保存失败，点击重试" });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("草稿已保存 04:05")).toBeTruthy());
    expect(bridge.quickCaptureSaveDraft).toHaveBeenCalledTimes(2);
  });

  it("窗口失焦立即 flush 草稿", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "临时内容" } });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() =>
      expect(bridge.quickCaptureSaveDraft).toHaveBeenCalledWith("task", "临时内容"),
    );
  });

  it("capture-flush-draft 事件立即 flush 草稿", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "退出前内容" } });
    await act(async () => {
      bridge.flushDraft.forEach((cb) => cb());
    });
    await waitFor(() =>
      expect(bridge.quickCaptureSaveDraft).toHaveBeenCalledWith("task", "退出前内容"),
    );
  });

  it("唤起时调用 quick_capture_state 恢复草稿并提示「已恢复草稿」", async () => {
    await renderCapture();
    bridge.quickCaptureState.mockResolvedValue({
      draft: { kind: "todo", content: "买牛奶\n周末", updated_at: "2026-11-03T04:00:00Z" },
      last_type: "task",
      inbox_count: 1,
    });
    await act(async () => {
      bridge.summoned.forEach((cb) => cb());
    });
    await waitFor(() => expect(textarea().value).toBe("买牛奶\n周末"));
    expect(checked("待办：创建无提醒任务")).toBe("true");
    expect(screen.getByText("已恢复草稿")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(textarea()));
  });

  it("内容接近上限才显示字数，3600 字以内不打扰", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "a".repeat(3600) } });
    expect(screen.queryByText("3600 / 4000")).toBeNull();
    fireEvent.change(textarea(), { target: { value: "a".repeat(3601) } });
    expect(screen.getByText("3601 / 4000")).toBeTruthy();
  });
});

describe("CaptureApp / 提交", () => {
  it("Ctrl+Enter 提交成功：创建任务、清空内容、约 500ms 后隐藏窗口", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "写周报" } });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(bridge.quickCaptureSubmit).toHaveBeenCalledTimes(1));
    const input = bridge.quickCaptureSubmit.mock.calls[0][0] as SubmitInputLike;
    expect(input.kind).toBe("task");
    expect(input.content).toBe("写周报");
    expect(typeof input.client_id).toBe("string");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("已保存 · 任务已创建"),
    );
    expect(textarea().value).toBe("");
    await waitFor(() => expect(bridge.quickCaptureHide).toHaveBeenCalledWith("success"), {
      timeout: 2000,
    });
  });

  it("提交失败保留内容与同一个 client_id，重试成功后重置", async () => {
    bridge.quickCaptureSubmit.mockRejectedValueOnce(new Error("网络错误"));
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "写周报" } });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("保存失败：网络错误"),
    );
    expect(textarea().value).toBe("写周报");
    expect(bridge.quickCaptureHide).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(bridge.quickCaptureSubmit).toHaveBeenCalledTimes(2));
    const first = bridge.quickCaptureSubmit.mock.calls[0][0] as SubmitInputLike;
    const second = bridge.quickCaptureSubmit.mock.calls[1][0] as SubmitInputLike;
    expect(second.client_id).toBe(first.client_id);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("已保存 · 任务已创建"),
    );
  });

  it("提交进行中再次触发不会重复提交", async () => {
    const pending = deferred<SubmitResultLike>();
    bridge.quickCaptureSubmit.mockReturnValueOnce(pending.promise);
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "只提交一次" } });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(bridge.quickCaptureSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "保存中…" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(bridge.quickCaptureSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({
        id: "capture-1",
        kind: "task",
        status: "converted",
        task_id: "task-1",
        duplicate: false,
        created_at: "2026-11-03T04:05:00",
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("已保存 · 任务已创建"),
    );
  });

  it("空内容按 Ctrl+Enter 拒绝提交并给出错误提示", async () => {
    await renderCapture();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(bridge.quickCaptureSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("内容不能为空");
  });

  it("链接类型提交时拆分 url 与备注", async () => {
    await renderCapture();
    fireEvent.click(radio("链接：保存链接与备注"));
    fireEvent.change(textarea(), {
      target: { value: "看这个 https://example.com/x 很有用" },
    });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(bridge.quickCaptureSubmit).toHaveBeenCalledTimes(1));
    const input = bridge.quickCaptureSubmit.mock.calls[0][0] as SubmitInputLike;
    expect(input.kind).toBe("link");
    expect(input.url).toBe("https://example.com/x");
    expect(input.note).toBe("看这个 很有用");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("已保存 · 已加入收集箱"),
    );
  });

  it("待办类型成功文案为任务已创建", async () => {
    await renderCapture();
    fireEvent.click(radio("待办：创建无提醒任务"));
    fireEvent.change(textarea(), { target: { value: "拿快递" } });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("已保存 · 任务已创建"),
    );
  });
});

describe("CaptureApp / 键盘与关闭", () => {
  it("Esc 关闭窗口并 flush 草稿", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "临时想法" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(bridge.quickCaptureHide).toHaveBeenCalledWith("user");
    await waitFor(() =>
      expect(bridge.quickCaptureSaveDraft).toHaveBeenCalledWith("task", "临时想法"),
    );
  });

  it("关闭按钮走 bridge 的 quickCaptureHide，不直接碰 Tauri window API", async () => {
    await renderCapture();
    fireEvent.click(screen.getByRole("button", { name: "关闭快速捕获" }));
    expect(bridge.quickCaptureHide).toHaveBeenCalledWith("user");
  });

  it("IME 组合输入中 Ctrl+Enter / Esc 全部让给输入法", async () => {
    await renderCapture();
    const input = textarea();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "明天" } });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(bridge.quickCaptureSubmit).not.toHaveBeenCalled();
    expect(bridge.quickCaptureHide).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(bridge.quickCaptureHide).toHaveBeenCalledWith("user"));
  });

  it("KeyboardEvent.isComposing 为真时同样不提交", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "明天" } });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, isComposing: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.quickCaptureSubmit).not.toHaveBeenCalled();
  });

  it("隐藏事件触发时 flush 草稿（供后端隐藏窗口时兜底）", async () => {
    await renderCapture();
    fireEvent.change(textarea(), { target: { value: "隐藏前内容" } });
    await act(async () => {
      bridge.hidden.forEach((cb) => cb());
    });
    await waitFor(() =>
      expect(bridge.quickCaptureSaveDraft).toHaveBeenCalledWith("task", "隐藏前内容"),
    );
  });
});
