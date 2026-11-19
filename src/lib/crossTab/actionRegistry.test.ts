//! 动作注册与筛选：菜单必须按内容类型动态生成，不能把条目硬编码进页面。

import { beforeEach, describe, expect, it } from "vitest";
import {
  canExecute,
  clearActionsForTests,
  executeAction,
  registerAction,
  resolveAvailableActions,
} from "./actionRegistry";
import type { TransferContext, TransferItem } from "./types";

function item(overrides: Partial<TransferItem>): TransferItem {
  return {
    id: "i1",
    itemType: "text",
    sourceModule: "clipboard",
    sourceId: "",
    title: "t",
    description: "",
    content: "c",
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

const context: TransferContext = {
  module: "files",
  projectId: null,
  taskId: null,
  directory: "D:\\tmp",
  planningId: null,
  knowledgeId: null,
  captureId: null,
  window: "workspace",
  updatedAt: 0,
};

beforeEach(() => clearActionsForTests());

describe("actionRegistry", () => {
  it("重复注册同一 actionId 直接报错，不静默覆盖", () => {
    const action = {
      actionId: "files.send",
      title: "发送",
      supportedItemTypes: ["text"],
      sourceModules: [],
      targetModules: [],
      run: async () => ({ ok: true, message: "" }),
    };
    registerAction(action);
    expect(() => registerAction(action)).toThrow(/已注册/);
  });

  it("按条目类型筛选可用动作", () => {
    registerAction({
      actionId: "text.only",
      title: "文本",
      supportedItemTypes: ["text"],
      sourceModules: [],
      targetModules: [],
      run: async () => ({ ok: true, message: "" }),
    });
    const actions = resolveAvailableActions([item({ itemType: "text" })], context);
    expect(actions.map((entry) => entry.actionId)).toEqual(["text.only"]);
    expect(resolveAvailableActions([item({ itemType: "image" })], context)).toHaveLength(0);
  });

  it("需要目标但未提供目标时拒绝执行，并返回明确原因", async () => {
    registerAction({
      actionId: "files.send",
      title: "发送",
      supportedItemTypes: ["text"],
      sourceModules: [],
      targetModules: [],
      requiresTarget: true,
      run: async () => ({ ok: true, message: "done" }),
    });
    const result = await executeAction("files.send", {
      items: [item({})],
      context,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/目标/);
    expect(canExecute("files.send", [item({})], context)).toBe(true);
  });

  it("未注册的动作不会被调用", async () => {
    const result = await executeAction("missing", { items: [item({})], context });
    expect(result.ok).toBe(false);
  });
});
