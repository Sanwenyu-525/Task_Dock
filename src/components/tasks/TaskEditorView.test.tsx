/** @vitest-environment jsdom */
//! TaskEditorView（页面内任务编辑态）行为测试：
//! 新建/编辑保存、取消、保存失败保留内容、未保存返回保护、连点单次提交、卸载无回调。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskEditorView from "./TaskEditorView";
import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import type { Task, TaskInput } from "../../lib/bridge";

vi.mock("../../lib/bridge", async (original) => ({
  ...await original<typeof import("../../lib/bridge")>(),
  listTaskLinks: vi.fn(async () => []),
  clipboardTaskLinks: vi.fn(async () => []),
}));
vi.mock("../../lib/navigation", async (original) => ({
  ...await original<typeof import("../../lib/navigation")>(),
  navTaskTargets: vi.fn(async () => []),
}));

const task: Task = {
  id: "t1", title: "原任务", description: "描述", priority: 2, status: "pending",
  category: "", tags: ["标签"], due_at: "2026-10-30T02:30:37Z",
  remind_at: "2026-10-29T02:30:19Z", advance_minutes: 5,
  recurrence: { id: "rule", freq: "weekly", interval: 2, by_weekday: [1, 5],
    by_monthday: null, until: "2027-01-01T00:00:00Z", anchor: "2026-10-26" },
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  completed_at: null, linked_agents: 0,
};

const update = vi.fn(async (_id: string, _input: TaskInput) => task);
const create = vi.fn(async (_input: TaskInput) => ({ ...task, id: "t-new" }));
const onClose = vi.fn();

beforeEach(() => {
  update.mockClear();
  create.mockClear();
  onClose.mockClear();
  useTasksStore.setState({ update, create, remove: vi.fn(async () => {}), refresh: vi.fn(async () => {}) });
  useNavigationStore.setState({
    loadTaskLinks: vi.fn(async () => "ok" as const),
    // AppPicker 页内子视图只读已保存目标；测试不触发真实扫描
    targetsLoaded: true,
    targets: [],
    scan: null,
  });
  useUiStore.setState({
    openClipboard: vi.fn(),
    openContext: vi.fn(),
    showToast: vi.fn(),
    tab: "tasks",
    pendingTab: null,
  });
});
afterEach(cleanup);

it("编辑既有任务：表单加载当前值与重复规则，不提交未修改的时间/规则", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={task} onClose={onClose} />);
  expect(screen.getByLabelText("标题")).toHaveProperty("value", "原任务");
  expect(screen.getByLabelText("描述")).toHaveProperty("value", "描述");
  expect(screen.getByLabelText("标签（逗号分隔）")).toHaveProperty("value", "标签");

  const title = screen.getByLabelText("标题");
  await user.clear(title);
  await user.type(title, "新标题");
  await user.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  const input = update.mock.calls[0][1];
  expect(input.title).toBe("新标题");
  expect(input).not.toHaveProperty("due_at");
  expect(input).not.toHaveProperty("remind_at");
  expect(input).not.toHaveProperty("recurrence");
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it.each([
  ["描述", "新描述"], ["优先级", "1"], ["标签（逗号分隔）", "新标签"],
  ["提醒时间", "2026-11-01T10:30"], ["截止时间", "2026-11-02T10:30"],
])("只修改 %s 时不重写重复规则", async (label, value) => {
  render(<TaskEditorView task={task} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][1]).not.toHaveProperty("recurrence");
});

it("主动取消或修改重复规则时提交明确意图", async () => {
  render(<TaskEditorView task={task} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "不重复" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][1].recurrence).toBeNull();
  cleanup();

  update.mockClear();
  render(<TaskEditorView task={task} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "每天" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][1].recurrence).toMatchObject({ freq: "daily" });
});

it("新建任务：保存后调用 create 并关闭编辑态", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={null} onClose={onClose} />);
  expect(screen.getByText("新建任务")).toBeTruthy();
  await user.type(screen.getByLabelText("标题"), "写周报");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create.mock.calls[0][0]).toMatchObject({ title: "写周报", recurrence: null });
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("标题为空时就地报错，不发请求", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={null} onClose={onClose} />);
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("alert").textContent).toContain("标题不能为空");
  expect(create).not.toHaveBeenCalled();
});

it("保存失败：保留表单内容并显示错误", async () => {
  update.mockRejectedValueOnce(new Error("数据库已锁定"));
  const user = userEvent.setup();
  render(<TaskEditorView task={task} onClose={onClose} />);
  const title = screen.getByLabelText("标题");
  await user.clear(title);
  await user.type(title, "改了一半");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("数据库已锁定"));
  expect(screen.getByLabelText("标题")).toHaveProperty("value", "改了一半");
  expect(onClose).not.toHaveBeenCalled();
});

it("连点保存只提交一次", async () => {
  let resolveUpdate: (t: Task) => void = () => {};
  update.mockImplementationOnce(
    () => new Promise<Task>((resolve) => {
      resolveUpdate = resolve;
    }),
  );
  render(<TaskEditorView task={task} onClose={onClose} />);
  const save = screen.getByRole("button", { name: "保存" });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(update).toHaveBeenCalledOnce();
  resolveUpdate(task);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("未修改时取消直接返回列表", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={task} onClose={onClose} />);
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("有未保存修改时返回先出页内确认条，放弃修改才返回", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={task} onClose={onClose} />);
  const title = screen.getByLabelText("标题");
  await user.clear(title);
  await user.type(title, "改了标题");
  expect(screen.getByText("未保存")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("有未保存的修改");

  await user.click(screen.getByRole("button", { name: "放弃修改" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("跨主 Tab 切换：只记录待决导航，编辑器不卸载、草稿保留", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={task} onClose={onClose} />);
  const title = screen.getByLabelText("标题");
  await user.clear(title);
  await user.type(title, "还没保存的标题");

  // 侧栏 / 更多菜单 / 快捷键 / 通知跳转都最终调用 setTab
  useUiStore.getState().setTab("apps");

  expect(useUiStore.getState().tab).toBe("tasks");
  expect(useUiStore.getState().pendingTab).toMatchObject({
    tab: "apps",
    guardId: "task-editor",
  });
  expect(screen.getByLabelText("标题")).toHaveProperty("value", "还没保存的标题");
  expect(onClose).not.toHaveBeenCalled();

  // 「继续编辑」：撤销待决导航
  useUiStore.getState().cancelPendingTab();
  expect(useUiStore.getState().pendingTab).toBeNull();
  expect(screen.getByLabelText("标题")).toHaveProperty("value", "还没保存的标题");
});

it("明确放弃修改后才完成跨 Tab 导航", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={task} onClose={onClose} />);
  const title = screen.getByLabelText("标题");
  await user.clear(title);
  await user.type(title, "要放弃的草稿");

  useUiStore.getState().setTab("apps");
  useUiStore.getState().confirmPendingTab();

  expect(useUiStore.getState().tab).toBe("apps");
  expect(onClose).toHaveBeenCalledOnce();
});

it("保存进行中切换主 Tab 被明确拒绝，不产生错误态", async () => {
  let resolveUpdate: (t: Task) => void = () => {};
  update.mockImplementationOnce(
    () => new Promise<Task>((resolve) => {
      resolveUpdate = resolve;
    }),
  );
  render(<TaskEditorView task={task} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  useUiStore.getState().setTab("apps");
  expect(useUiStore.getState().tab).toBe("tasks");
  expect(useUiStore.getState().pendingTab).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  resolveUpdate(task);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("关联目标选择器以页内子视图打开，返回后保留原有输入", async () => {
  const user = userEvent.setup();
  render(<TaskEditorView task={task} onClose={onClose} />);
  const title = screen.getByLabelText("标题");
  await user.clear(title);
  await user.type(title, "选择目标前的草稿");

  await user.click(screen.getByRole("button", { name: /添加目标/ }));
  expect(screen.getByRole("region", { name: "添加应用" })).toBeTruthy();
  expect(screen.queryByLabelText("标题")).toBeNull();
  // 页内模式不再叠加全局遮罩
  expect(document.querySelector(".modal-backdrop")).toBeNull();

  await user.click(screen.getByRole("button", { name: "返回应用列表" }));
  expect(screen.getByLabelText("标题")).toHaveProperty("value", "选择目标前的草稿");
  expect(screen.getByText("未保存")).toBeTruthy();
});

it("卸载后到达的保存响应不再回调", async () => {
  let resolveUpdate: (t: Task) => void = () => {};
  update.mockImplementationOnce(
    () => new Promise<Task>((resolve) => {
      resolveUpdate = resolve;
    }),
  );
  const view = render(<TaskEditorView task={task} onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  view.unmount();
  resolveUpdate(task);
  await new Promise((r) => setTimeout(r, 0));
  expect(onClose).not.toHaveBeenCalled();
});
