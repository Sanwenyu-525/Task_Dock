/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string) => key,
  }),
}));

import OperationPreviewDialog from "./OperationPreviewDialog";
import type { OperationPreview } from "../../lib/bridge";

afterEach(cleanup);

function preview(overrides: Partial<OperationPreview> = {}): OperationPreview {
  return {
    effect: "copy",
    items: 12,
    files: 10,
    dirs: 2,
    bytes: 2048,
    conflicts: [],
    inaccessible: [],
    duplicates: [],
    warnings: [],
    complete: true,
    ...overrides,
  };
}

describe("OperationPreviewDialog", () => {
  it("展示统计、冲突与不完整提示，确认/取消回调各一次", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <OperationPreviewDialog
        request={{
          preview: preview({
            conflicts: [{ source: "C:\\a.txt", target: "D:\\a.txt", kind: "file" }],
            inaccessible: ["C:\\locked"],
            duplicates: ["C:\\dup"],
            warnings: ["统计达到上限"],
            complete: false,
          }),
          onConfirm,
          onCancel,
        }}
      />,
    );

    expect(screen.getByText("fw.opPreview.willCopy")).toBeTruthy();
    expect(screen.getByText("fw.opPreview.conflicts")).toBeTruthy();
    expect(screen.getByText("fw.opPreview.inaccessible")).toBeTruthy();
    expect(screen.getByText("fw.opPreview.duplicates")).toBeTruthy();
    expect(screen.getByText("fw.opPreview.incomplete")).toBeTruthy();
    expect(screen.getByText("统计达到上限")).toBeTruthy();

    fireEvent.click(screen.getByText("fw.opPreview.confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("common.cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("request 为空时不渲染内容", () => {
    render(<OperationPreviewDialog request={null} />);
    expect(screen.queryByText("fw.opPreview.willCopy")).toBeNull();
  });
});
