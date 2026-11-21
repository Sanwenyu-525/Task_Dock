// @vitest-environment jsdom
//! 图片预览：只读渲染，不出现任何写操作入口。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImageRenderer from "./ImageRenderer";
import type { VisualDocument } from "../../../lib/collab";

vi.mock("../../../lib/collab", () => ({
  collabAssetRead: vi.fn(async () => ({
    id: "va_preview",
    mime: "image/png",
    sizeBytes: 5,
    base64: "iVBORw0KGgo=",
  })),
}));

import { collabAssetRead } from "../../../lib/collab";

function doc(overrides?: Partial<VisualDocument>): VisualDocument {
  return {
    id: "vd_image",
    projectId: "proj-1",
    planId: null,
    title: "Bug 截图",
    description: "",
    kind: "bug_annotation",
    authoringMode: "imported",
    schemaVersion: 1,
    sourceFormat: "json",
    sourceContent: JSON.stringify({
      assetId: "va_preview",
      width: 1280,
      height: 720,
      annotations: [
        { shape: "rect", x: 10, y: 20, w: 100, h: 40, note: "按钮错位", severity: "high" },
      ],
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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImageRenderer", () => {
  it("预览模式渲染图片与标注层，且没有导入/保存/删除入口", async () => {
    render(<ImageRenderer doc={doc()} />);

    expect(await screen.findByRole("img", { name: /标注层（1 条）/ })).toBeTruthy();
    expect(screen.getByTestId("image-renderer")).toBeTruthy();
    expect(screen.getByText(/只读预览/)).toBeTruthy();
    expect(screen.getByText("按钮错位")).toBeTruthy();

    for (const name of ["导入图片", "保存", "删除标注", "选择", "矩形"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByTestId("annotation-resize-handle")).toBeNull();
    expect(screen.queryByTestId("annotation-overlay")).toBeNull();
  });

  it("没有资产时只给只读提示，不提供导入按钮", () => {
    render(
      <ImageRenderer
        doc={doc({ sourceContent: JSON.stringify({ width: 800, height: 600, annotations: [] }) })}
      />,
    );
    expect(screen.getByTestId("image-renderer-empty")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("图片读取失败时显示明确错误且不提供修复入口", async () => {
    vi.mocked(collabAssetRead).mockRejectedValueOnce(new Error("图片文件未随备份恢复或已丢失"));
    render(<ImageRenderer doc={doc()} />);
    expect(await screen.findByText(/未随备份恢复或已丢失/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /导入图片/ })).toBeNull();
  });

  it("static_image 预览不渲染标注层", async () => {
    render(
      <ImageRenderer
        doc={doc({
          kind: "static_image",
          sourceContent: JSON.stringify({
            assetId: "va_preview",
            width: 1280,
            height: 720,
            annotations: [
              { shape: "rect", x: 10, y: 20, w: 100, h: 40, note: "不应出现", severity: "high" },
            ],
          }),
        })}
      />,
    );
    expect(await screen.findByTestId("image-renderer")).toBeTruthy();
    expect(screen.queryByTestId("annotation-renderer")).toBeNull();
    expect(screen.queryByText("不应出现")).toBeNull();
  });
});
