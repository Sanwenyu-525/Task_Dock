import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActionsForTests, executeAction, getAction } from "../actionRegistry";
import { installTaskActions, uninstallTaskActions, CREATE_TASK_ACTION_ID } from "./tasks";
import type { TransferContext, TransferItem } from "../types";

const createTask = vi.fn();
const createEntityLink = vi.fn();

vi.mock("../../bridge", () => ({ createTask: (...args: unknown[]) => createTask(...args) }));
vi.mock("../transferClient", () => ({
  createEntityLink: (...args: unknown[]) => createEntityLink(...args),
}));

const context: TransferContext = {
  module: "clipboard",
  projectId: null,
  taskId: null,
  directory: null,
  planningId: null,
  knowledgeId: null,
  captureId: null,
  window: "main",
  updatedAt: 0,
};

function item(overrides: Partial<TransferItem>): TransferItem {
  return {
    id: "i1",
    itemType: "text",
    sourceModule: "clipboard",
    sourceId: "c1",
    title: "标题",
    description: "",
    content: "正文",
    payload: {},
    sortOrder: 0,
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
    ...overrides,
  };
}

describe("tasks module action", () => {
  beforeEach(() => {
    clearActionsForTests();
    installTaskActions();
    createTask.mockReset();
    createEntityLink.mockReset();
  });
  afterEach(() => uninstallTaskActions());

  it("registers one action that accepts text items", () => {
    const action = getAction(CREATE_TASK_ACTION_ID);
    expect(action?.supportedItemTypes).toContain("text");
    expect(action?.requiresTarget).toBe(false);
  });

  it("creates a task from text and links real files", async () => {
    createTask.mockResolvedValue({ id: "task-1" });
    createEntityLink.mockResolvedValue({});
    const result = await executeAction(CREATE_TASK_ACTION_ID, {
      items: [
        item({ id: "a", content: "第一行\n第二行" }),
        item({ id: "b", itemType: "file", title: "a.txt", content: "", payload: { path: "C:\\tmp\\a.txt" } }),
      ],
      context,
    });
    expect(result.ok).toBe(true);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "第一行", category: "工作篮" }),
    );
    expect(createEntityLink).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "task", targetType: "file", relation: "attachment" }),
    );
  });

  it("reports a real failure instead of pretending success", async () => {
    createTask.mockRejectedValue(new Error("数据库锁定"));
    const result = await executeAction(CREATE_TASK_ACTION_ID, {
      items: [item({})],
      context,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("数据库锁定");
  });
});
