// @vitest-environment jsdom
//! 原型编辑器：添加组件、页面新增/改名、拖动、批量 Patch 保存。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrototypeEditor from "./PrototypeEditor";
import { collabPrototypePatch, type VisualDocument } from "../../../lib/collab";

vi.mock("../../../lib/collab", () => ({
  collabPrototypePatch: vi.fn(),
  collabPrototypeValidate: vi.fn(),
  collabAiModify: vi.fn(),
  collabVisualUpdate: vi.fn(),
  collabVisualExport: vi.fn(),
}));

const CONTENT = {
  schemaVersion: 1,
  viewport: { width: 400, height: 640 },
  pages: [
    {
      id: "page-1",
      name: "首页",
      components: [
        {
          id: "c1",
          type: "text",
          x: 16,
          y: 24,
          w: 300,
          h: 40,
          props: { text: "说明" },
          style: {},
          events: {},
        },
      ],
    },
  ],
  state: {},
};

const DOC: VisualDocument = {
  id: "vd_proto",
  projectId: "proj-1",
  planId: null,
  title: "确认原型",
  description: "",
  kind: "prototype",
  authoringMode: "manual",
  schemaVersion: 1,
  sourceFormat: "json",
  sourceContent: JSON.stringify(CONTENT),
  renderer: "prototype-react",
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
  vi.mocked(collabPrototypePatch).mockImplementation(async (_id, revision) => ({
    ...DOC,
    version: 2,
    revision: revision + 1,
  }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PrototypeEditor", () => {
  it("添加组件后保存为一次批量 Patch", async () => {
    mockSaved();
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "添加 Button" }));
    expect(screen.getAllByTestId("proto-overlay")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabPrototypePatch).toHaveBeenCalledTimes(1));
    const ops = vi.mocked(collabPrototypePatch).mock.calls[0][2];
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("add");
    expect(ops[0].pageId).toBe("page-1");
    expect((ops[0].component as { type: string }).type).toBe("button");
  });

  it("新增页面与改名进入同一批页面操作", async () => {
    mockSaved();
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);

    // 先改已有页面名（page_rename），再新增页面（page_add），验证同一批操作。
    fireEvent.click(screen.getByRole("tab", { name: /首页/ }));
    fireEvent.change(screen.getByLabelText("当前页面名称"), { target: { value: "详情" } });
    fireEvent.click(screen.getByRole("button", { name: "新增页面" }));

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabPrototypePatch).toHaveBeenCalledTimes(1));
    const ops = vi.mocked(collabPrototypePatch).mock.calls[0][2];
    expect(ops.some((op) => op.op === "page_add")).toBe(true);
    expect(ops.some((op) => op.op === "page_rename" && op.name === "详情")).toBe(true);
  });

  it("拖动组件后保存 update 操作与旧内容保持不变的部分", async () => {
    mockSaved();
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    const overlays = screen.getAllByTestId("proto-overlay");

    fireEvent.pointerDown(overlays[0], { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(overlays[0], { clientX: 60, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(overlays[0], { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabPrototypePatch).toHaveBeenCalledTimes(1));
    const ops = vi.mocked(collabPrototypePatch).mock.calls[0][2];
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("update");
    expect(ops[0].patch).toMatchObject({ x: 56, y: 54 });
  });
});
