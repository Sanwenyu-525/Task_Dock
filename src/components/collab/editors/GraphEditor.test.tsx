// @vitest-environment jsdom
//! 图表编辑器：添加/拖动/连线/撤销/保存载荷。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphEditor from "./GraphEditor";
import { collabVisualUpdate, type VisualDocument } from "../../../lib/collab";

vi.mock("../../../lib/collab", () => ({
  collabVisualUpdate: vi.fn(),
  collabAiModify: vi.fn(),
  collabVisualExport: vi.fn(),
}));

const DOC: VisualDocument = {
  id: "vd_test",
  projectId: "proj-1",
  planId: null,
  title: "登录流程",
  description: "",
  kind: "flowchart",
  authoringMode: "manual",
  schemaVersion: 1,
  sourceFormat: "json",
  sourceContent: JSON.stringify({
    nodes: [
      { id: "n1", label: "开始", kind: "start", x: 100, y: 100, config: {} },
      { id: "n2", label: "结束", kind: "end", x: 100, y: 260, config: {} },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", label: "" }],
    layout: { direction: "TB", width: 720, height: 420 },
  }),
  renderer: "graph-svg",
  previewAsset: null,
  status: "draft",
  version: 1,
  revision: 1,
  createdBy: "local-user",
  updatedBy: "local-user",
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
};

function mockSaved() {
  vi.mocked(collabVisualUpdate).mockImplementation(async (_id, revision, patch) => ({
    ...DOC,
    ...(patch as Partial<VisualDocument>),
    version: 2,
    revision: revision + 1,
  }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GraphEditor", () => {
  it("从组件面板添加节点并保存为结构化内容", async () => {
    mockSaved();
    render(<GraphEditor doc={DOC} onSaved={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "添加判断节点" }));
    expect(screen.getAllByTestId("graph-node")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabVisualUpdate).toHaveBeenCalledTimes(1));

    const patch = vi.mocked(collabVisualUpdate).mock.calls[0][2] as {
      sourceContent: string;
    };
    const saved = JSON.parse(patch.sourceContent);
    expect(saved.nodes).toHaveLength(3);
    expect(saved.nodes[2]).toMatchObject({ kind: "decision", label: "判断节点" });
    expect(saved.layout.direction).toBe("TB");
  });

  it("拖动节点后保存保留新坐标", async () => {
    mockSaved();
    render(<GraphEditor doc={DOC} onSaved={() => undefined} />);
    const nodes = screen.getAllByTestId("graph-node");

    fireEvent.pointerDown(nodes[0], { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(nodes[0], { clientX: 180, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(nodes[0], { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabVisualUpdate).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(collabVisualUpdate).mock.calls[0][2] as {
      sourceContent: string;
    };
    const saved = JSON.parse(patch.sourceContent);
    expect(saved.nodes[0]).toMatchObject({ x: 180, y: 160 });
  });

  it("选择节点后创建连接并保存边", async () => {
    mockSaved();
    render(<GraphEditor doc={DOC} onSaved={() => undefined} />);
    const nodes = screen.getAllByTestId("graph-node");

    fireEvent.pointerDown(nodes[1], { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(nodes[1], { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "创建连接" }));
    // 反向连接（n2 → n1），避免与已有 n1 → n2 重复而被去重。
    fireEvent.pointerDown(nodes[0], { clientX: 10, clientY: 10, pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabVisualUpdate).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(collabVisualUpdate).mock.calls[0][2] as {
      sourceContent: string;
    };
    const saved = JSON.parse(patch.sourceContent);
    expect(saved.edges).toHaveLength(2);
    expect(saved.edges[1]).toMatchObject({ from: "n2", to: "n1" });
  });

  it("撤销可以回退新增节点", () => {
    mockSaved();
    render(<GraphEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "添加判断节点" }));
    expect(screen.getAllByTestId("graph-node")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getAllByTestId("graph-node")).toHaveLength(2);
  });

  it("没有修改时保存按钮禁用，不产生空版本", () => {
    mockSaved();
    render(<GraphEditor doc={DOC} onSaved={() => undefined} />);
    const save = screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(collabVisualUpdate).not.toHaveBeenCalled();
  });
});
