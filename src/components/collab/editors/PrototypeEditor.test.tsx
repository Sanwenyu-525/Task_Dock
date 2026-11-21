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
  collabVisualAssetList: vi.fn(async () => []),
  collabVisualAssetImport: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

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
          style: { bg: "#111111" },
          events: { onClick: { action: "toggle", target: "c1" } },
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

  it("修改文案后撤销恢复到原内容", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });

    const text = screen.getByLabelText("文案") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "新文案" } });
    await waitFor(() => expect((screen.getByLabelText("文案") as HTMLInputElement).value).toBe("新文案"));

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect((screen.getByLabelText("文案") as HTMLInputElement).value).toBe("说明"));
  });

  it("连续输入只记一条历史（一次撤销回到原值）", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });

    const text = () => screen.getByLabelText("文案") as HTMLInputElement;
    fireEvent.change(text(), { target: { value: "说" } });
    fireEvent.change(text(), { target: { value: "说明文" } });
    fireEvent.change(text(), { target: { value: "说明文字" } });
    await waitFor(() => expect(text().value).toBe("说明文字"));

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(text().value).toBe("说明"));
    expect((screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("修改颜色后撤销恢复原样式", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });

    const bg = () => screen.getByLabelText("bg") as HTMLInputElement;
    expect(bg().value).toBe("#111111");
    fireEvent.change(bg(), { target: { value: "#ffffff" } });
    await waitFor(() => expect(bg().value).toBe("#ffffff"));

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(bg().value).toBe("#111111"));
  });

  it("删除事件后撤销恢复事件配置", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });

    fireEvent.click(screen.getByRole("combobox", { name: "onClick 动作" }));
    fireEvent.click(await screen.findByRole("option", { name: "无" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "onClick 动作" }).textContent).toContain("无"),
    );

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "onClick 动作" }).textContent).toContain("开关切换"),
    );
  });

  it("修改页面名称后撤销恢复原名", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    const input = () => screen.getByLabelText("当前页面名称") as HTMLInputElement;
    fireEvent.change(input(), { target: { value: "详情" } });
    await waitFor(() => expect(input().value).toBe("详情"));

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(input().value).toBe("首页"));
  });

  it("撤销后修改新内容会清空 redo 分支", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    const text = () => screen.getByLabelText("文案") as HTMLInputElement;

    fireEvent.change(text(), { target: { value: "第一次" } });
    await waitFor(() => expect(text().value).toBe("第一次"));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(text().value).toBe("说明"));

    fireEvent.change(text(), { target: { value: "第二次" } });
    await waitFor(() => expect(text().value).toBe("第二次"));
    expect((screen.getByRole("button", { name: "重做" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(text().value).toBe("第二次");
  });

  it("多次撤销与重做按顺序回放", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    const text = () => screen.getByLabelText("文案") as HTMLInputElement;
    const pageName = () => screen.getByLabelText("当前页面名称") as HTMLInputElement;

    fireEvent.change(text(), { target: { value: "第一步" } });
    await waitFor(() => expect(text().value).toBe("第一步"));
    fireEvent.change(pageName(), { target: { value: "改名页" } });
    await waitFor(() => expect(pageName().value).toBe("改名页"));

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(pageName().value).toBe("首页"));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(text().value).toBe("说明"));

    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    await waitFor(() => expect(text().value).toBe("第一步"));
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    await waitFor(() => expect(pageName().value).toBe("改名页"));
  });

  it("类型入口已移除，不会产生无法保存的虚假修改", async () => {
    render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    expect(screen.queryByLabelText("组件类型")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "组件类型" })).toBeNull();
  });

  it("保存后按新内容重新加载，差异为空（无虚假修改）", async () => {
    mockSaved();
    const { rerender } = render(<PrototypeEditor doc={DOC} onSaved={() => undefined} />);
    fireEvent.pointerDown(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.pointerUp(screen.getAllByTestId("proto-overlay")[0], { pointerId: 1 });
    fireEvent.change(screen.getByLabelText("文案"), { target: { value: "已保存文案" } });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabPrototypePatch).toHaveBeenCalledTimes(1));

    const ops = vi.mocked(collabPrototypePatch).mock.calls[0][2];
    expect(ops[0].op).toBe("update");
    expect(ops[0].patch).toMatchObject({ props: { text: "已保存文案" } });

    const savedContent = {
      ...CONTENT,
      pages: [
        {
          ...CONTENT.pages[0],
          components: [
            { ...CONTENT.pages[0].components[0], props: { text: "已保存文案" } },
          ],
        },
      ],
    };
    rerender(
      <PrototypeEditor
        doc={{
          ...DOC,
          revision: 2,
          version: 2,
          sourceContent: JSON.stringify(savedContent),
        }}
        onSaved={() => undefined}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("当前页面名称") as HTMLInputElement).value).toBe("首页"),
    );
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(screen.getByText("没有需要保存的修改")).toBeTruthy());
  });
});
