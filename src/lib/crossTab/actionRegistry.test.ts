//! 动作注册与筛选：菜单必须按内容类型动态生成，不能把条目硬编码进页面。
//!
//! 重点：`resolveAvailableActions` / `canExecute` / `executeAction` 必须使用
//! **同一套**可用性规则——菜单里能点的动作，执行时必须真的能执行。

import { beforeEach, describe, expect, it } from "vitest";
import {
  canExecute,
  clearActionsForTests,
  evaluateAction,
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

const baseAction = {
  actionId: "files.send",
  title: "发送",
  supportedItemTypes: ["text"],
  sourceModules: [],
  targetModules: [],
  run: async () => ({ ok: true, message: "" }),
};

beforeEach(() => clearActionsForTests());

describe("actionRegistry", () => {
  it("重复注册同一 actionId 直接报错，不静默覆盖", () => {
    registerAction(baseAction);
    expect(() => registerAction(baseAction)).toThrow(/已注册/);
  });

  it("按条目类型筛选可用动作", () => {
    registerAction({ ...baseAction, actionId: "text.only" });
    const actions = resolveAvailableActions([item({ itemType: "text" })], context);
    expect(actions.map((entry) => entry.actionId)).toEqual(["text.only"]);
    expect(resolveAvailableActions([item({ itemType: "image" })], context)).toHaveLength(0);
  });

  it("requiresTarget 在菜单与执行两处都生效（不能显示假可用菜单）", async () => {
    registerAction({ ...baseAction, requiresTarget: true });
    const withoutTarget = [item({})];
    // 三个入口必须一致：不可用。
    expect(canExecute("files.send", withoutTarget, context)).toBe(false);
    expect(resolveAvailableActions(withoutTarget, context)).toHaveLength(0);
    const result = await executeAction("files.send", { items: withoutTarget, context });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/目标/);
    // 给出目标后三处同时变为可用。
    const target = { module: "files", ref: "D:\\tmp" };
    expect(canExecute("files.send", withoutTarget, context, target)).toBe(true);
    expect(resolveAvailableActions(withoutTarget, context, target)).toHaveLength(1);
    const ok = await executeAction("files.send", { items: withoutTarget, context, target });
    expect(ok.ok).toBe(true);
  });

  it("targetModules 不匹配当前目标时不可用", () => {
    registerAction({ ...baseAction, requiresTarget: true, targetModules: ["projects"] });
    const items = [item({})];
    expect(canExecute("files.send", items, context, { module: "files", ref: "D:\\tmp" })).toBe(false);
    expect(canExecute("files.send", items, context, { module: "projects", ref: "p1" })).toBe(true);
  });

  it("sourceModules 限制来源；混合选择必须全部满足", () => {
    registerAction({ ...baseAction, sourceModules: ["clipboard"] });
    expect(canExecute("files.send", [item({ sourceModule: "files" })], context)).toBe(false);
    expect(
      canExecute("files.send", [item({ id: "a" }), item({ id: "b", sourceModule: "files" })], context),
    ).toBe(false);
    expect(canExecute("files.send", [item({ sourceModule: "clipboard" })], context)).toBe(true);
  });

  it("需要确认的动作未确认时不执行", async () => {
    registerAction({ ...baseAction, confirmationRequired: true });
    const items = [item({})];
    const rejected = await executeAction("files.send", { items, context });
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toMatch(/确认/);
    const confirmed = await executeAction("files.send", { items, context }, { confirmed: true });
    expect(confirmed.ok).toBe(true);
  });

  it("evaluateAction 对空选择与未注册动作给出明确原因", () => {
    expect(evaluateAction(undefined, [item({})], context).available).toBe(false);
    registerAction(baseAction);
    const empty = evaluateAction(baseAction, [], context);
    expect(empty.available).toBe(false);
    expect(empty.reason).toMatch(/选择/);
  });

  it("未注册的动作不会被调用", async () => {
    const result = await executeAction("missing", { items: [item({})], context });
    expect(result.ok).toBe(false);
  });
});
