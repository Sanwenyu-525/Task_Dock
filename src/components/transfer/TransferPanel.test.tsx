// @vitest-environment jsdom
//! 工作篮面板渲染与发送前预览：验证 UI 真实走 store 与 IPC 客户端，不直接写文件。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const item = {
  id: "it-1",
  itemType: "text",
  sourceModule: "clipboard",
  sourceId: "clip-1",
  title: "测试条目",
  description: "描述",
  content: "正文内容",
  payload: {},
  sortOrder: 1,
  pinned: false,
  status: "ready",
  errorCode: "",
  errorMessage: "",
  lastTarget: "",
  createdAt: "",
  updatedAt: "",
  sentAt: null,
  expiresAt: null,
  available: true,
  unavailableReason: "",
};

const listItems = vi.fn();
const getCounts = vi.fn();
const getContext = vi.fn();
const validateTarget = vi.fn();
const previewTransfer = vi.fn();

vi.mock("../../lib/bridge", () => ({
  clipboardView: vi.fn().mockResolvedValue({ items: [], total_items: 0 }),
  fsStat: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/crossTab/transferClient", () => ({
  DEFAULT_OPTIONS: {
    conflict: "rename",
    textFormat: "txt",
    textMode: "separate",
    fileOperation: "copy",
    urlMode: "url",
  },
  listItems: (...args: unknown[]) => listItems(...args),
  getCounts: (...args: unknown[]) => getCounts(...args),
  getContext: (...args: unknown[]) => getContext(...args),
  validateTarget: (...args: unknown[]) => validateTarget(...args),
  previewTransfer: (...args: unknown[]) => previewTransfer(...args),
  executeTransfer: vi.fn(),
  getBatch: vi.fn(),
  retryBatch: vi.fn(),
  undoBatch: vi.fn(),
  addItems: vi.fn(),
  removeItems: vi.fn(),
  pinItem: vi.fn(),
  clearTemporary: vi.fn(),
  getItem: vi.fn(),
  reorderItems: vi.fn(),
  updateContext: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../lib/crossTab/eventBus", () => ({
  TRANSFER_EVENTS: { batchChanged: "b", contextChanged: "c" },
  subscribe: vi.fn(() => () => undefined),
}));
vi.mock("../../lib/filesWorkspace/folderPicker", () => ({
  pickFolder: vi.fn().mockResolvedValue({ status: "cancelled" }),
}));

import TransferPanel from "./TransferPanel";
import { useTransferStore } from "../../store/useTransferStore";

afterEach(() => cleanup());

beforeEach(() => {
  localStorage.clear();
  listItems.mockReset().mockResolvedValue({ items: [item], total: 1 });
  getCounts.mockReset().mockResolvedValue({ total: 1, ready: 1, failed: 0, pinned: 0 });
  getContext.mockReset().mockResolvedValue({ module: "files", directory: null });
  validateTarget.mockReset().mockResolvedValue({ valid: true, message: "", displayName: "tmp" });
  previewTransfer.mockReset().mockResolvedValue({
    targetModule: "files",
    targetRef: "D:\\tmp",
    targetValid: true,
    targetMessage: "",
    counts: {
      text: 1, richtext: 0, image: 0, file: 0, directory: 0, url: 0, clipboard: 0, entity: 0, unsupported: 0,
    },
    plannedFiles: 1,
    conflicts: [],
    unsupported: [],
    warnings: [],
    moveRemovesSources: 0,
    estimatedBytes: 12,
  });
  useTransferStore.setState({
    items: [item],
    total: 1,
    selection: [],
    filter: { search: "", itemTypes: [] },
    loading: false,
    error: null,
    panel: { visible: true, pinned: true, width: 320, suggestionsEnabled: true },
    panelMode: "dock",
    activeBatch: null,
    lastRemoved: null,
  });
});

describe("TransferPanel", () => {
  it("渲染条目并展示发送目标", async () => {
    render(<TransferPanel variant="dock" onClose={() => undefined} />);
    expect(await screen.findByText("测试条目")).toBeTruthy();
    expect(screen.getByText("尚未选择目标目录")).toBeTruthy();
  });

  it("没有选中项时也提供全选入口（不是只有选中后才出现）", async () => {
    render(<TransferPanel variant="dock" onClose={() => undefined} />);
    await screen.findByText("测试条目");
    expect(screen.getByLabelText("全选当前列表")).toBeTruthy();
    expect(screen.getByText("反选")).toBeTruthy();
    expect(screen.getByText("清除选择")).toBeTruthy();
  });

  it("同一窗口第二个面板实例不渲染（单实例守卫）", async () => {
    const { container } = render(
      <>
        <TransferPanel variant="dock" onClose={() => undefined} />
        <TransferPanel variant="drawer" onClose={() => undefined} />
      </>,
    );
    await screen.findByText("测试条目");
    expect(container.querySelectorAll(".tp-panel")).toHaveLength(1);
  });

  it("选择条目后发送前必须先出预览，而不是直接执行", async () => {
    localStorage.setItem("taskdock.transfer.target.v1", "D:\\tmp");
    render(<TransferPanel variant="dock" onClose={() => undefined} />);
    await screen.findByText("测试条目");
    await userEvent.click(screen.getAllByLabelText("测试条目")[0]);
    const send = screen.getByRole("button", { name: /发送到文件工作区/ }) as HTMLButtonElement;
    // 目标目录需要先通过后端校验，按钮才会启用（不是无条件可点）。
    await waitFor(() => expect(send.disabled).toBe(false));
    await userEvent.click(send);
    await waitFor(() => expect(previewTransfer).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("发送预览")).toBeTruthy();
  });
});
