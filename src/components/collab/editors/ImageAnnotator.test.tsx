// @vitest-environment jsdom
//! 图片标注：资产加载、矩形标注、保存载荷。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImageAnnotator from "./ImageAnnotator";
import {
  collabAssetRead,
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
});
