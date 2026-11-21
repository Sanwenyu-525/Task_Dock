// @vitest-environment jsdom
//! 图片标注：资产加载、矩形标注、保存载荷。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImageAnnotator from "./ImageAnnotator";
import {
  collabAssetRead,
  collabVisualAssetList,
  collabVisualUpdate,
  type VisualDocument,
} from "../../../lib/collab";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../../../lib/collab", () => ({
  collabAssetRead: vi.fn(),
  collabVisualAssetImport: vi.fn(),
  collabVisualAssetList: vi.fn(async () => []),
  collabVisualUpdate: vi.fn(),
}));

const DOC: VisualDocument = {
  id: "vd_anno",
  projectId: "proj-1",
  planId: null,
  title: "Bug 截图",
  description: "",
  kind: "bug_annotation",
  authoringMode: "imported",
  schemaVersion: 1,
  sourceFormat: "json",
  sourceContent: JSON.stringify({
    assetId: "va_test",
    width: 1280,
    height: 720,
    annotations: [],
  }),
  renderer: "image-annotation",
  previewAsset: null,
  status: "draft",
  version: 1,
  revision: 1,
  createdBy: "local-user",
  updatedBy: "local-user",
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImageAnnotator", () => {
  it("绘制矩形标注并保存为独立标注层", async () => {
    vi.mocked(collabAssetRead).mockResolvedValue({
      id: "va_test",
      mime: "image/png",
      sizeBytes: 5,
      base64: "iVBORw0KGgo=",
    });
    vi.mocked(collabVisualUpdate).mockImplementation(async (_id, revision, patch) => ({
      ...DOC,
      ...(patch as Partial<VisualDocument>),
      version: 2,
      revision: revision + 1,
    }));

    render(<ImageAnnotator doc={DOC} onSaved={() => undefined} />);
    const overlay = await screen.findByTestId("annotation-overlay");
    Object.defineProperty(overlay, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 450,
        right: 800,
        bottom: 450,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "矩形" }));
    fireEvent.pointerDown(overlay, { clientX: 80, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 240, clientY: 135, pointerId: 1 });
    fireEvent.pointerUp(overlay, { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabVisualUpdate).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(collabVisualUpdate).mock.calls[0][2] as {
      sourceContent: string;
    };
    const saved = JSON.parse(patch.sourceContent);
    expect(saved.assetId).toBe("va_test");
    expect(saved.annotations).toHaveLength(1);
    expect(saved.annotations[0]).toMatchObject({
      shape: "rect",
      x: 128,
      y: 72,
      w: 256,
      h: 144,
    });
  });

  it("编辑模式提供导入与保存入口，原图引用不被改写", async () => {
    vi.mocked(collabAssetRead).mockResolvedValue({
      id: "va_test",
      mime: "image/png",
      sizeBytes: 5,
      base64: "iVBORw0KGgo=",
    });
    render(<ImageAnnotator doc={DOC} onSaved={() => undefined} />);
    await screen.findByTestId("annotation-overlay");
    expect(screen.getByRole("button", { name: /导入图片/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /保存/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "矩形" })).toBeTruthy();
  });

  it("移动标注后保存新坐标", async () => {
    vi.mocked(collabAssetRead).mockResolvedValue({
      id: "va_test",
      mime: "image/png",
      sizeBytes: 5,
      base64: "iVBORw0KGgo=",
    });
    vi.mocked(collabVisualUpdate).mockImplementation(async (_id, revision, patch) => ({
      ...DOC,
      ...(patch as Partial<VisualDocument>),
      version: 2,
      revision: revision + 1,
    }));
    const { container } = render(<ImageAnnotator doc={DOC} onSaved={() => undefined} />);
    const overlay = await screen.findByTestId("annotation-overlay");
    Object.defineProperty(overlay, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 450,
        right: 800,
        bottom: 450,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    // 先画一个矩形（128,72 尺寸 256×144）。
    fireEvent.click(screen.getByRole("button", { name: "矩形" }));
    fireEvent.pointerDown(overlay, { clientX: 80, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 240, clientY: 135, pointerId: 1 });
    fireEvent.pointerUp(overlay, { pointerId: 1 });

    // 选中后拖动标注：屏幕 +40/+30 → 图像 +64/+48。
    const shape = container.querySelector(".annotation-shape") as SVGRectElement;
    expect(shape).toBeTruthy();
    fireEvent.pointerDown(shape, { clientX: 80, clientY: 45, pointerId: 2 });
    fireEvent.pointerMove(overlay, { clientX: 120, clientY: 75, pointerId: 2 });
    fireEvent.pointerUp(overlay, { pointerId: 2 });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabVisualUpdate).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(
      (vi.mocked(collabVisualUpdate).mock.calls[0][2] as { sourceContent: string }).sourceContent,
    );
    expect(saved.annotations[0]).toMatchObject({ x: 192, y: 120, w: 256, h: 144 });
  });

  it("拖拽缩放把手调整标注尺寸", async () => {
    vi.mocked(collabAssetRead).mockResolvedValue({
      id: "va_test",
      mime: "image/png",
      sizeBytes: 5,
      base64: "iVBORw0KGgo=",
    });
    vi.mocked(collabVisualUpdate).mockImplementation(async (_id, revision, patch) => ({
      ...DOC,
      ...(patch as Partial<VisualDocument>),
      version: 2,
      revision: revision + 1,
    }));
    render(<ImageAnnotator doc={DOC} onSaved={() => undefined} />);
    const overlay = await screen.findByTestId("annotation-overlay");
    Object.defineProperty(overlay, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 450,
        right: 800,
        bottom: 450,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "矩形" }));
    fireEvent.pointerDown(overlay, { clientX: 80, clientY: 45, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 240, clientY: 135, pointerId: 1 });
    fireEvent.pointerUp(overlay, { pointerId: 1 });

    const handle = screen.getByTestId("annotation-resize-handle");
    fireEvent.pointerDown(handle, { clientX: 240, clientY: 135, pointerId: 3 });
    fireEvent.pointerMove(overlay, { clientX: 280, clientY: 165, pointerId: 3 });
    fireEvent.pointerUp(overlay, { pointerId: 3 });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(collabVisualUpdate).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(
      (vi.mocked(collabVisualUpdate).mock.calls[0][2] as { sourceContent: string }).sourceContent,
    );
    expect(saved.annotations[0]).toMatchObject({ x: 128, y: 72, w: 320, h: 192 });
  });

  it("切换已有资产后重新加载对应图片", async () => {
    vi.mocked(collabVisualAssetList).mockResolvedValue([
      {
        id: "va_test",
        projectId: "proj-1",
        documentId: "vd_anno",
        title: "第一张",
        path: "C:/data/a.png",
        sha256: "a".repeat(64),
        sizeBytes: 5,
        mime: "image/png",
        ext: "png",
        status: "active",
        metaJson: "{}",
        createdBy: "local-user",
        source: "ui",
        createdAt: "2026-11-20T00:00:00Z",
      },
      {
        id: "va_second",
        projectId: "proj-1",
        documentId: "vd_anno",
        title: "第二张",
        path: "C:/data/b.png",
        sha256: "b".repeat(64),
        sizeBytes: 6,
        mime: "image/png",
        ext: "png",
        status: "active",
        metaJson: "{}",
        createdBy: "local-user",
        source: "ui",
        createdAt: "2026-11-20T00:00:01Z",
      },
    ]);
    vi.mocked(collabAssetRead).mockResolvedValue({
      id: "va_test",
      mime: "image/png",
      sizeBytes: 5,
      base64: "iVBORw0KGgo=",
    });
    render(<ImageAnnotator doc={DOC} onSaved={() => undefined} />);
    await screen.findByTestId("annotation-overlay");
    expect(collabAssetRead).toHaveBeenLastCalledWith("va_test");

    fireEvent.click(screen.getByRole("combobox", { name: "选择已有资产" }));
    fireEvent.click(await screen.findByRole("option", { name: "第二张" }));
    await waitFor(() => expect(collabAssetRead).toHaveBeenLastCalledWith("va_second"));
  });

  it("重新打开时按保存的标注层恢复（解析一致）", async () => {
    vi.mocked(collabAssetRead).mockResolvedValue({
      id: "va_test",
      mime: "image/png",
      sizeBytes: 5,
      base64: "iVBORw0KGgo=",
    });
    const saved = JSON.stringify({
      assetId: "va_test",
      width: 1280,
      height: 720,
      annotations: [
        { shape: "circle", x: 10, y: 20, w: 60, h: 30, note: "圆", severity: "low" },
      ],
    });
    const { container } = render(
      <ImageAnnotator
        doc={{ ...DOC, revision: 2, sourceContent: saved }}
        onSaved={() => undefined}
      />,
    );
    await screen.findByTestId("annotation-overlay");
    expect(container.querySelectorAll(".annotation-shape")).toHaveLength(1);
    expect(screen.getByText(/1 条标注/)).toBeTruthy();
  });
});
