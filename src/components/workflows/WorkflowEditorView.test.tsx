/**
 * @vitest-environment jsdom
 */
//! 工作流页面内编辑器：新建 / 编辑 / 取消保护 / 保存失败保留 / 连点防重 / 卸载后无回调。
//!
//! jsdom 只覆盖 DOM 与交互状态；锚定菜单贴合、翻转、窄窗排版由真实 WebView2 验收。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import type { WorkflowDetail } from "../../lib/bridge";

const workflowCreate = vi.fn();
const workflowReplaceSteps = vi.fn();
const workflowUpdate = vi.fn();
const workspaceList = vi.fn();
const navListTargets = vi.fn();

vi.mock("../../lib/bridge", () => ({
  WORKFLOW_STEP_TYPE_LABELS: {
    open_app: "打开应用 / 激活窗口",
    open_url: "打开网页",
    open_path: "打开文件或目录",
    create_task: "创建任务",
    enter_scene: "进入场景",
    restore_workspace: "恢复工作现场",
  },
  workflowCreate: (...a: unknown[]) => workflowCreate(...a),
  workflowReplaceSteps: (...a: unknown[]) => workflowReplaceSteps(...a),
  workflowUpdate: (...a: unknown[]) => workflowUpdate(...a),
  workspaceList: (...a: unknown[]) => workspaceList(...a),
}));

vi.mock("../../lib/navigation", () => ({
  navListTargets: (...a: unknown[]) => navListTargets(...a),
}));

import WorkflowEditorView from "./WorkflowEditorView";

function detail(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: "w1",
    name: "旧流程",
    description: "旧描述",
    enabled: true,
    steps: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as WorkflowDetail;
}

function renderEditor(
  workflow: WorkflowDetail | null,
  handlers: { onCancel?: () => void; onSaved?: (d: WorkflowDetail) => void } = {},
) {
  return render(
    <WorkflowEditorView
      workflow={workflow}
      template={null}
      onCancel={handlers.onCancel ?? (() => undefined)}
      onSaved={handlers.onSaved ?? (() => undefined)}
    />,
  );
}

beforeEach(() => {
  workflowCreate.mockReset();
  workflowReplaceSteps.mockReset();
  workflowUpdate.mockReset();
  workspaceList.mockReset();
  navListTargets.mockReset();
  workspaceList.mockResolvedValue([]);
  navListTargets.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("WorkflowEditorView", () => {
  it("新建：选择步骤类型后直接展开参数区，保存一次提交", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    workflowCreate.mockResolvedValue(detail({ id: "new", name: "早间准备", description: "" }));

    renderEditor(null, { onSaved });
    await user.type(screen.getByLabelText("名称"), "早间准备");
    expect(screen.getByRole("status").textContent).toContain("未保存");

    await user.click(screen.getByRole("combobox", { name: "添加步骤" }));
    await user.click(await screen.findByRole("option", { name: "创建任务" }));

    // 选完类型即进入该项参数配置
    expect(screen.getByLabelText("任务标题")).toBeTruthy();
    await user.type(screen.getByLabelText("任务标题"), "写周报");

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(workflowCreate).toHaveBeenCalledTimes(1));

    const payload = workflowCreate.mock.calls[0][0] as {
      name: string;
      description: string;
      steps: { step_type: string; params: { title?: string } }[];
    };
    expect(payload.name).toBe("早间准备");
    expect(payload.steps).toHaveLength(1);
    expect(payload.steps[0].step_type).toBe("create_task");
    expect(payload.steps[0].params.title).toBe("写周报");
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("编辑：先原子替换步骤，再在名称变化时更新元信息", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const existing = detail();
    workflowReplaceSteps.mockResolvedValue(existing);
    workflowUpdate.mockResolvedValue(detail({ name: "新流程" }));

    renderEditor(existing, { onSaved });

    const name = screen.getByLabelText("名称") as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "新流程");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(workflowReplaceSteps).toHaveBeenCalledWith("w1", []));
    await waitFor(() =>
      expect(workflowUpdate).toHaveBeenCalledWith("w1", { name: "新流程", description: "旧描述" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("保存失败：保留表单内容并显示错误，不回调 onSaved", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    workflowCreate.mockRejectedValue(new Error("后端拒绝"));

    renderEditor(null, { onSaved });
    await user.type(screen.getByLabelText("名称"), "保留的流程");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("后端拒绝"));
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("保留的流程");
    expect(screen.getByRole("status").textContent).toContain("未保存");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("未保存修改时返回先给页内确认，不直接离开", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    renderEditor(null, { onCancel });
    await user.click(screen.getByRole("button", { name: "返回工作流列表" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText("名称"), "改了名");
    await user.click(screen.getByRole("button", { name: "返回工作流列表" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("有未保存的修改");

    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: "返回工作流列表" }));
    await user.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("连点保存只提交一次（同步防重入）", async () => {
    const user = userEvent.setup();
    let resolve: (d: WorkflowDetail) => void = () => undefined;
    workflowCreate.mockReturnValue(
      new Promise<WorkflowDetail>((r) => {
        resolve = r;
      }),
    );

    renderEditor(null);
    await user.type(screen.getByLabelText("名称"), "慢请求");
    const save = screen.getByRole("button", { name: "保存" });
    await user.click(save);
    await user.click(save);

    expect(workflowCreate).toHaveBeenCalledTimes(1);
    resolve(detail({ id: "x", name: "慢请求" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeTruthy());
  });

  it("保存请求返回前卸载：不再回调 onSaved、不产生无效更新", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    let resolve: (d: WorkflowDetail) => void = () => undefined;
    workflowCreate.mockReturnValue(
      new Promise<WorkflowDetail>((r) => {
        resolve = r;
      }),
    );

    const view = renderEditor(null, { onSaved });
    await user.type(screen.getByLabelText("名称"), "中途离开");
    await user.click(screen.getByRole("button", { name: "保存" }));
    view.unmount();

    await act(async () => {
      resolve(detail({ id: "x", name: "中途离开" }));
      await Promise.resolve();
    });
    expect(onSaved).not.toHaveBeenCalled();
  });
});
