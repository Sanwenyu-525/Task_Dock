/**
 * @vitest-environment jsdom
 */
//! 工作流运行页内视图：返回列表不等于取消、后台运行状态保留、不可重复启动。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { WorkflowDetail, WorkflowRunDetail } from "../../lib/bridge";
import { useWorkflowsStore } from "../../store/useWorkflowsStore";
import WorkflowRunView from "./WorkflowRunView";

const workflow: WorkflowDetail = {
  id: "w1",
  name: "早间准备",
  description: "",
  enabled: true,
  sort_order: 0,
  step_count: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_run_at: null,
  steps: [
    {
      id: "s1",
      workflow_id: "w1",
      step_type: "open_url",
      params: {},
      display_order: 0,
      enabled: true,
      on_error: "stop",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "s2",
      workflow_id: "w1",
      step_type: "create_task",
      params: { title: "写周报" },
      display_order: 1,
      enabled: true,
      on_error: "stop",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
};

function detail(overrides: Partial<WorkflowRunDetail> = {}): WorkflowRunDetail {
  return {
    id: "r1",
    workflow_id: "w1",
    workflow_name: "早间准备",
    status: "running",
    current_step_index: 1,
    total_steps: 2,
    completed_steps: 1,
    started_at: "2026-11-01T00:00:00Z",
    finished_at: null,
    error: null,
    steps: [
      {
        id: "rs1",
        run_id: "r1",
        step_id: "s1",
        step_type: "open_url",
        display_order: 0,
        status: "succeeded",
        detail: "已打开",
        result: null,
        started_at: "2026-11-01T00:00:00Z",
        finished_at: "2026-11-01T00:00:01Z",
        operation_id: "op1",
      },
      {
        id: "rs2",
        run_id: "r1",
        step_id: "s2",
        step_type: "create_task",
        display_order: 1,
        status: "running",
        detail: "创建中",
        result: null,
        started_at: "2026-11-01T00:00:01Z",
        finished_at: null,
        operation_id: "op2",
      },
    ],
    ...overrides,
  };
}

const pauseWorkflow = vi.fn(async () => {});
const resumeWorkflow = vi.fn(async () => {});
const cancelWorkflow = vi.fn(async () => {});
const runWorkflow = vi.fn(async () => detail({ id: "r2", completed_steps: 0, status: "running" }));

beforeEach(() => {
  pauseWorkflow.mockClear();
  resumeWorkflow.mockClear();
  cancelWorkflow.mockClear();
  runWorkflow.mockClear();
  useWorkflowsStore.setState({
    activeRun: null,
    activeRunDetail: null,
    runWorkflow,
    pauseWorkflow,
    resumeWorkflow,
    cancelWorkflow,
  });
});

afterEach(cleanup);

describe("WorkflowRunView", () => {
  it("运行中返回列表只离开视图，不取消后台执行", () => {
    const onBack = vi.fn();
    useWorkflowsStore.setState({
      activeRun: { run_id: "r1", workflow_id: "w1", paused: false, cancel_requested: false },
      activeRunDetail: detail(),
    });
    const view = render(
      <WorkflowRunView workflow={workflow} runId="r1" onStarted={() => {}} onBack={onBack} />,
    );

    expect(screen.getByText("返回列表后仍在后台执行")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回工作流列表" }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(cancelWorkflow).not.toHaveBeenCalled();

    // 卸载视图同样不触发取消；store 仍保留活动运行
    view.unmount();
    expect(cancelWorkflow).not.toHaveBeenCalled();
    expect(useWorkflowsStore.getState().activeRun?.run_id).toBe("r1");
  });

  it("暂停 / 继续 / 取消都走真实运行控制，不重复调用", () => {
    useWorkflowsStore.setState({
      activeRun: { run_id: "r1", workflow_id: "w1", paused: true, cancel_requested: false },
      activeRunDetail: detail(),
    });
    render(<WorkflowRunView workflow={workflow} runId="r1" onStarted={() => {}} onBack={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /继续/ }));
    expect(resumeWorkflow).toHaveBeenCalledTimes(1);
    expect(resumeWorkflow).toHaveBeenCalledWith("w1");

    fireEvent.click(screen.getByRole("button", { name: /取消运行/ }));
    expect(cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(cancelWorkflow).toHaveBeenCalledWith("w1");
  });

  it("已有其他工作流在执行时禁止重复启动", () => {
    useWorkflowsStore.setState({
      activeRun: { run_id: "r-other", workflow_id: "w2", paused: false, cancel_requested: false },
      activeRunDetail: detail({ id: "r-other", workflow_id: "w2" }),
    });
    render(<WorkflowRunView workflow={workflow} runId={null} onStarted={() => {}} onBack={() => {}} />);

    expect(screen.getByRole("alert").textContent).toContain("同一时刻只能运行一个工作流");
    const start = screen.getByRole("button", { name: /运行/ }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("连点运行只启动一次，启动后由 store 展示进度", async () => {
    const onStarted = vi.fn();
    render(<WorkflowRunView workflow={workflow} runId={null} onStarted={onStarted} onBack={() => {}} />);

    const start = screen.getByRole("button", { name: /运行/ });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(runWorkflow).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith("r2"));
  });

  it("运行失败时给出明确错误与状态", () => {
    useWorkflowsStore.setState({
      activeRun: null,
      activeRunDetail: detail({
        status: "failed",
        finished_at: "2026-11-01T00:00:03Z",
        error: "步骤 2 创建任务失败：标题为空",
      }),
    });
    render(<WorkflowRunView workflow={workflow} runId="r1" onStarted={() => {}} onBack={() => {}} />);

    expect(screen.getByRole("alert").textContent).toContain("步骤 2 创建任务失败");
    expect(screen.getByText("运行已结束；详情保留在「历史」中。")).toBeTruthy();
  });

  it("场景步骤展示逐项回执（label/状态/原因），失败步骤也保留明细", () => {
    const receipt = {
      summary: "场景「晨间」完成 2/3 项（失败 1）",
      scene_id: "sc1",
      scene_name: "晨间",
      total: 3,
      processed: 2,
      cancelled: false,
      timed_out: false,
      outcome: "partial",
      items: [
        { index: 1, kind: "app", label: "记事本", status: "ok", detail: null },
        { index: 2, kind: "folder", label: "C:\\不存在", status: "failed", detail: "目录不存在" },
      ],
    };
    const base = detail();
    useWorkflowsStore.setState({
      activeRun: null,
      activeRunDetail: detail({
        status: "failed",
        finished_at: "2026-11-01T00:00:03Z",
        steps: [
          ...base.steps,
          {
            id: "rs3",
            run_id: "r1",
            step_id: "s3",
            step_type: "enter_scene",
            display_order: 2,
            status: "failed",
            detail: receipt.summary,
            result: JSON.stringify(receipt),
            started_at: "2026-11-01T00:00:02Z",
            finished_at: "2026-11-01T00:00:03Z",
            operation_id: "op3",
          },
        ],
      }),
    });
    render(<WorkflowRunView workflow={workflow} runId="r1" onStarted={() => {}} onBack={() => {}} />);

    const list = screen.getByRole("list", { name: "场景条目逐项结果" });
    expect(list.textContent).toContain("记事本");
    expect(list.textContent).toContain("C:\\不存在");
    expect(list.textContent).toContain("目录不存在");
    expect(list.textContent).toContain("成功");
    expect(list.textContent).toContain("失败");
    // 步骤行仍显示汇总文案
    expect(screen.getAllByText(receipt.summary).length).toBeGreaterThan(0);
  });

  it("场景步骤旧记录（result 非法或无 items）退回 detail 文案，不崩溃", () => {
    useWorkflowsStore.setState({
      activeRun: null,
      activeRunDetail: detail({
        status: "completed",
        finished_at: "2026-11-01T00:00:03Z",
        steps: [
          {
            id: "rs3",
            run_id: "r1",
            step_id: "s3",
            step_type: "enter_scene",
            display_order: 2,
            status: "succeeded",
            detail: "场景「old」已完成 1 项",
            result: "not-json",
            started_at: "2026-11-01T00:00:02Z",
            finished_at: "2026-11-01T00:00:03Z",
            operation_id: "op3",
          },
        ],
      }),
    });
    render(<WorkflowRunView workflow={workflow} runId="r1" onStarted={() => {}} onBack={() => {}} />);

    expect(screen.getByText("场景「old」已完成 1 项")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "场景条目逐项结果" })).toBeNull();
  });
});
