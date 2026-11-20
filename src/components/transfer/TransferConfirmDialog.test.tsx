// @vitest-environment jsdom
//! 发送预览一致性：参数变了必须失效，执行必须用快照参数。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const validateTarget = vi.fn();
const previewTransfer = vi.fn();
const executeTransfer = vi.fn();
const getBatch = vi.fn();

vi.mock("../../lib/crossTab/transferClient", () => ({
  DEFAULT_OPTIONS: {
    conflict: "rename",
    textFormat: "txt",
    textMode: "separate",
    fileOperation: "copy",
    urlMode: "url",
  },
  validateTarget: (...args: unknown[]) => validateTarget(...args),
  previewTransfer: (...args: unknown[]) => previewTransfer(...args),
  executeTransfer: (...args: unknown[]) => executeTransfer(...args),
  getBatch: (...args: unknown[]) => getBatch(...args),
  addItems: vi.fn(),
  removeItems: vi.fn(),
  getItem: vi.fn(),
  reorderItems: vi.fn(),
  pinItem: vi.fn(),
  clearTemporary: vi.fn(),
  listItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getCounts: vi.fn().mockResolvedValue({ total: 0, ready: 0, failed: 0, pinned: 0 }),
  updateContext: vi.fn(),
}));

import TransferConfirmDialog from "./TransferConfirmDialog";
import { useTransferStore } from "../../store/useTransferStore";

const options = {
  conflict: "rename" as const,
  textFormat: "txt" as const,
  textMode: "separate" as const,
  fileOperation: "copy" as const,
  urlMode: "url" as const,
};

const preview = {
  targetModule: "files",
  targetRef: "D:\\out",
  targetValid: true,
  targetMessage: "",
  counts: { text: 1, richtext: 0, image: 0, file: 0, directory: 0, url: 0, clipboard: 0, entity: 0, unsupported: 0 },
  plannedFiles: 1,
  conflicts: [],
  unsupported: [],
  warnings: [],
  moveRemovesSources: 0,
  estimatedBytes: 12,
};

afterEach(() => cleanup());

beforeEach(() => {
  validateTarget.mockReset().mockResolvedValue({ valid: true, message: "", displayName: "D:\\out" });
  previewTransfer.mockReset().mockResolvedValue(preview);
  executeTransfer.mockReset().mockResolvedValue({
    id: "b1",
    targetModule: "files",
    targetRef: "D:\\out",
    operation: "copy",
    status: "running",
    total: 1,
    ok: 0,
    failed: 0,
    skipped: 0,
    jobIds: [],
    entries: [],
    undoState: "available",
    undoReason: "",
    message: "",
    createdAt: "",
    updatedAt: "",
  });
  getBatch.mockReset().mockResolvedValue({
    ...preview,
    id: "b1",
    status: "completed",
    ok: 1,
    total: 1,
    targetModule: "files",
    targetRef: "D:\\out",
    operation: "copy",
    jobIds: [],
    entries: [],
    undoState: "available",
    undoReason: "",
    message: "",
    createdAt: "",
    updatedAt: "",
  });
  useTransferStore.setState({ busy: false, activeBatch: null, pending: null });
});

describe("TransferConfirmDialog", () => {
  it("打开时先校验目标再出预览", async () => {
    render(
      <TransferConfirmDialog
        open
        onClose={() => undefined}
        ids={["a"]}
        target={{ module: "files", ref: "D:\\out" }}
        options={options}
        onOptionsChange={() => undefined}
        onNotify={() => undefined}
      />,
    );
    await waitFor(() => expect(previewTransfer).toHaveBeenCalledTimes(1));
    expect(validateTarget).toHaveBeenCalled();
    expect(await screen.findByText("发送预览")).toBeTruthy();
  });

  it("目标失效时不产生预览，确认按钮不可用", async () => {
    validateTarget.mockResolvedValue({ valid: false, message: "目标目录不存在", displayName: "" });
    render(
      <TransferConfirmDialog
        open
        onClose={() => undefined}
        ids={["a"]}
        target={{ module: "files", ref: "D:\\missing" }}
        options={options}
        onOptionsChange={() => undefined}
        onNotify={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText("目标目录不存在")).toBeTruthy());
    expect(previewTransfer).not.toHaveBeenCalled();
  });

  it("确认执行时使用快照参数，而不是当前表单", async () => {
    render(
      <TransferConfirmDialog
        open
        onClose={() => undefined}
        ids={["a"]}
        target={{ module: "files", ref: "D:\\out" }}
        options={options}
        onOptionsChange={() => undefined}
        onNotify={() => undefined}
      />,
    );
    await waitFor(() => expect(previewTransfer).toHaveBeenCalledTimes(1));
    const confirm = screen.getByRole("button", { name: /确认发送/ }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    await userEvent.click(confirm);
    await waitFor(() => expect(executeTransfer).toHaveBeenCalledTimes(1));
    expect(executeTransfer.mock.calls[0][0]).toEqual(["a"]);
    expect(executeTransfer.mock.calls[0][1]).toEqual({ module: "files", ref: "D:\\out" });
    expect(executeTransfer.mock.calls[0][2]).toEqual(options);
  });
});
