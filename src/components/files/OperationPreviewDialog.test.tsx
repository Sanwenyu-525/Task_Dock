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
  it("完整预演：展示统计与冲突，确认/取消回调各一次", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <OperationPreviewDialog
        request={{
          preview: preview({
            conflicts: [{ source: "C:\\a.txt", target: "D:\\a.txt", kind: "file" }],
            duplicates: ["C:\\dup"],
          }),
          onConfirm,
          onCancel,
        }}
      />,
    );

    expect(screen.getByText("fw.opPreview.willCopy")).toBeTruthy();
    expect(screen.getByText("fw.opPreview.conflicts")).toBeTruthy();
    expect(screen.getByText("fw.opPreview.duplicates")).toBeTruthy();

    fireEvent.click(screen.getByText("fw.opPreview.confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("common.cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("不完整预演：默认禁止执行，勾选独立确认后才允许继续（安全门禁）", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <OperationPreviewDialog
        request={{
          preview: preview({
            complete: false,
            inaccessible: ["C:\\locked"],
            warnings: ["统计达到上限"],
          }),
          onConfirm,
          onCancel,
        }}
      />,
    );

    expect(screen.getByText("fw.opPreview.incomplete")).toBeTruthy();
    expect(screen.getByText("fw.opPreview.gateBody")).toBeTruthy();
    // 普通确认按钮被门禁替换；未勾选时「继续处理可访问项」不可点。
    expect(screen.queryByText("fw.opPreview.confirm")).toBeNull();
    const gateButton = screen.getByText("fw.opPreview.gateContinue").closest("button")!;
    expect(gateButton.disabled).toBe(true);
    fireEvent.click(gateButton);
    expect(onConfirm).not.toHaveBeenCalled();

    const ack = screen.getByLabelText("fw.opPreview.gateAck") as HTMLInputElement;
    expect(ack.checked).toBe(false);
    fireEvent.click(ack);
    expect(ack.checked).toBe(true);
    expect(gateButton.disabled).toBe(false);
    fireEvent.click(gateButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // 取消仍然可用且不触发确认。
    fireEvent.click(screen.getByText("common.cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("勾选状态在打开新预演时重置：不得沿用上一次的确认", () => {
    const onConfirm = vi.fn();
    const first = preview({ complete: false });
    const { rerender } = render(
      <OperationPreviewDialog request={{ preview: first, onConfirm, onCancel: vi.fn() }} />,
    );
    fireEvent.click(screen.getByLabelText("fw.opPreview.gateAck"));
    expect(
      (screen.getByLabelText("fw.opPreview.gateAck") as HTMLInputElement).checked,
    ).toBe(true);

    rerender(
      <OperationPreviewDialog
        request={{ preview: preview({ complete: false }), onConfirm, onCancel: vi.fn() }}
      />,
    );
    expect(
      (screen.getByLabelText("fw.opPreview.gateAck") as HTMLInputElement).checked,
    ).toBe(false);
    const gateButton = screen.getByText("fw.opPreview.gateContinue").closest("button")!;
    expect(gateButton.disabled).toBe(true);
    fireEvent.click(gateButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("request 为空时不渲染内容", () => {
    render(<OperationPreviewDialog request={null} />);
    expect(screen.queryByText("fw.opPreview.willCopy")).toBeNull();
  });
});
