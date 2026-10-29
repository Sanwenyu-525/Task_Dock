/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TaskEditor from "./TaskEditor";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import type { Task, TaskInput } from "../../lib/bridge";

vi.mock("../../lib/bridge", async (original) => ({
  ...await original<typeof import("../../lib/bridge")>(),
  listTaskLinks: vi.fn(async () => []),
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

beforeEach(() => {
  update.mockClear();
  useUiStore.setState({ editor: { open: true, task } });
  useTasksStore.setState({ update });
  useNavigationStore.setState({ loadTaskLinks: vi.fn(async () => {}) });
});
afterEach(cleanup);

it("只修改标题时不提交重复规则或未修改的时间", async () => {
  const user = userEvent.setup();
  render(<TaskEditor />);
  const title = screen.getByLabelText("标题");
  await user.clear(title);
  await user.type(title, "新标题");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  const input = update.mock.calls[0][1];
  expect(input).not.toHaveProperty("recurrence");
  expect(input).not.toHaveProperty("due_at");
  expect(input).not.toHaveProperty("remind_at");
});

it.each([
  ["描述", "新描述"], ["优先级", "1"], ["标签（逗号分隔）", "新标签"],
  ["提醒时间", "2026-11-01T10:30"], ["截止时间", "2026-11-02T10:30"],
])("只修改 %s 时不重写重复规则", async (label, value) => {
  render(<TaskEditor />);
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][1]).not.toHaveProperty("recurrence");
});

it("主动取消或修改重复规则时提交明确意图", async () => {
  render(<TaskEditor />);
  fireEvent.click(screen.getByRole("button", { name: "不重复" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][1].recurrence).toBeNull();
  cleanup();
  update.mockClear();
  useUiStore.setState({ editor: { open: true, task } });
  render(<TaskEditor />);
  fireEvent.click(screen.getByRole("button", { name: "每天" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][1].recurrence).toMatchObject({ freq: "daily" });
});
