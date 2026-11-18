import { describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({ fsPreviewOperation: vi.fn() }));

import { fsPreviewOperation } from "../bridge";
import {
  PREVIEW_COPY_THRESHOLD,
  PREVIEW_MOVE_THRESHOLD,
  previewFileOperation,
  shouldPreviewTransfer,
} from "./operationPreview";

describe("shouldPreviewTransfer", () => {
  it("复制达到阈值才预演", () => {
    expect(shouldPreviewTransfer(PREVIEW_COPY_THRESHOLD - 1, "copy")).toBe(false);
    expect(shouldPreviewTransfer(PREVIEW_COPY_THRESHOLD, "copy")).toBe(true);
  });

  it("移动阈值更低", () => {
    expect(PREVIEW_MOVE_THRESHOLD).toBeLessThan(PREVIEW_COPY_THRESHOLD);
    expect(shouldPreviewTransfer(PREVIEW_MOVE_THRESHOLD - 1, "move")).toBe(false);
    expect(shouldPreviewTransfer(PREVIEW_MOVE_THRESHOLD, "move")).toBe(true);
  });
});

describe("previewFileOperation", () => {
  it("原样传递参数给 IPC", async () => {
    vi.mocked(fsPreviewOperation).mockResolvedValueOnce({
      effect: "copy",
      items: 1,
      files: 1,
      dirs: 0,
      bytes: 10,
      conflicts: [],
      inaccessible: [],
      duplicates: [],
      warnings: [],
      complete: true,
    });
    await previewFileOperation({ paths: ["C:\\a"], targetDir: "D:\\b", effect: "copy" });
    expect(fsPreviewOperation).toHaveBeenCalledWith(["C:\\a"], "D:\\b", "copy");
  });
});
