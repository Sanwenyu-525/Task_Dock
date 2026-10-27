/**
 * @vitest-environment jsdom
 */
//! QuickAdd 真实 DOM 交互测试：自然语言文本 + Enter 两段式提交（解析 → 确认创建）、
//! Escape 取消预览、创建进行中禁用重复提交、创建失败错误可见且输入不丢失。
//!
//! bridge mock：parseQuickAdd / createFromQuickAdd 替换为 vi.fn；
//! store 用真实实例，quickCreate 通过 setState 注入 mock 以断言 store 调用。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore } from "../../store/useUiStore";
import QuickAdd from "./QuickAdd";
import { parseQuickAdd, type ParsedInput, type RecurrenceRuleInput, type Task } from "../../lib/bridge";

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    parseQuickAdd: vi.fn(),
    createFromQuickAdd: vi.fn(),
  };
});

function parseFix(title: string): ParsedInput {
  return {
    title,
    due_at: "2026-10-29T07:00:00.000Z",
    recurrence: null,
    advance_minutes: null,
    matched: [],
    has_explicit_time: true,
    date_only: false,
  };
}

function taskFix(p: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    description: "",
    priority: 1,
    status: "pending",
    category: "",
    tags: [],
    due_at: null,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: "2026-10-27T00:00:00Z",
    updated_at: "2026-10-27T00:00:00Z",
    completed_at: null,
    linked_agents: 0,
    ...p,
  };
}

function ToastProbe() {
  const toast = useUiStore((s) => s.toast);
  return (
    <div data-testid="toast" data-kind={toast?.kind ?? ""}>
      {toast?.message ?? ""}
    </div>
  );
}

function renderQuickAdd() {
  render(
    <>
      <QuickAdd />
      <ToastProbe />
    </>,
  );
  return screen.getByPlaceholderText(/快速添加/) as HTMLInputElement;
}

/** 注入 quickCreate mock（签名与 store 一致，避免 strictFunctionTypes 报错）。 */
function mockQuickCreate(impl: (
  text: string,
  dueAt: string | null,
  recurrence: RecurrenceRuleInput | null,
  advanceMinutes: number | null,
) => Promise<Task>) {
  const mock = vi.fn(impl);
  useTasksStore.setState({ quickCreate: mock });
  return mock;
}

beforeEach(() => {
  vi.clearAllMocks();
  useTasksStore.setState({ quickCreate: vi.fn(async () => taskFix({ id: "t", title: "x" })) });
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  cleanup();
});

describe("QuickAdd", () => {
  it("输入自然语言 + Enter：先解析出预览，再 Enter 创建（store/bridge 被正确调用）", async () => {
    const user = userEvent.setup();
    vi.mocked(parseQuickAdd).mockResolvedValue(parseFix("开会"));
    const quickCreateMock = mockQuickCreate(async () => taskFix({ id: "t-new", title: "开会" }));
    const input = renderQuickAdd();

    // 第一段：Enter → 解析
    await user.type(input, "明天下午三点开会{enter}");
    expect(vi.mocked(parseQuickAdd)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(parseQuickAdd)).toHaveBeenCalledWith("明天下午三点开会");
    expect(await screen.findByText("开会")).toBeTruthy(); // 预览标题出现

    // 第二段：Enter → 创建
    await user.type(input, "{enter}");
    await waitFor(() => expect(quickCreateMock).toHaveBeenCalledTimes(1));
    expect(quickCreateMock).toHaveBeenCalledWith("开会", expect.any(String), null, null);
    await waitFor(() => expect(input.value).toBe("")); // 创建成功后输入清空
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("已创建");
    expect(toast.dataset.kind).toBe("success");
  });

  it("Escape 关闭：预览消失、可重新编辑", async () => {
    const user = userEvent.setup();
    vi.mocked(parseQuickAdd).mockResolvedValue(parseFix("开会"));
    const input = renderQuickAdd();

    await user.type(input, "明天开会{enter}");
    expect(await screen.findByText("开会")).toBeTruthy();

    await user.type(input, "{escape}");
    await waitFor(() => expect(screen.queryByText("开会")).toBeNull());
    expect(input.disabled).toBe(false); // 回到可编辑状态
  });

  it("创建进行中禁用重复提交：挂起期间连按 Enter 只创建一次", async () => {
    const user = userEvent.setup();
    vi.mocked(parseQuickAdd).mockResolvedValue(parseFix("写周报"));
    let resolveCreate!: (t: Task) => void;
    const quickCreateMock = mockQuickCreate(
      () => new Promise<Task>((res) => { resolveCreate = res; }),
    );
    const input = renderQuickAdd();

    await user.type(input, "写周报{enter}");
    await screen.findByText("写周报"); // 预览出现
    await user.type(input, "{enter}"); // 开始创建（挂起中）

    expect(quickCreateMock).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(true); // 输入框禁用
    const createBtn = screen.getByRole("button", { name: "创建中…" }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    // 禁用态下再按 Enter：即使事件到达组件，guard 也必须拦住
    fireEvent.keyDown(input, { key: "Enter" });
    expect(quickCreateMock).toHaveBeenCalledTimes(1);

    resolveCreate(taskFix({ id: "t-new", title: "写周报" }));
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(input.value).toBe("");
  });

  it("创建失败：错误 toast 可见且输入不丢失", async () => {
    const user = userEvent.setup();
    vi.mocked(parseQuickAdd).mockResolvedValue(parseFix("失败任务"));
    mockQuickCreate(async () => {
      throw new Error("数据库被锁");
    });
    const input = renderQuickAdd();

    await user.type(input, "失败任务{enter}");
    await screen.findByText("失败任务");
    await user.type(input, "{enter}");

    await waitFor(() => {
      const toast = screen.getByTestId("toast");
      expect(toast.textContent).toContain("创建失败");
      expect(toast.textContent).toContain("数据库被锁");
      expect(toast.dataset.kind).toBe("error");
    });
    expect(input.value).toBe("失败任务"); // 输入不丢失，可直接重试
    expect(screen.getByText("失败任务")).toBeTruthy(); // 预览保留
  });
});
