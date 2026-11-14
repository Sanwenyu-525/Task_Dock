/**
 * @vitest-environment jsdom
 */
//! 排序乐观意图层（2026-11-14）：跨界面共享、序号判定、只叠加顺序不改显隐。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyNavOrderIntent,
  applyNavOrderIntents,
  clearNavOrderIntent,
  dropNavOrderIntent,
  publishNavOrderIntent,
  readNavOrderIntent,
  resetNavOrderIntents,
  subscribeNavOrderIntent,
} from "./navOrderIntent";
import { defaultNavigationLayout } from "./navVisibility";

function defaultLeft(): string[] {
  return defaultNavigationLayout().left;
}

beforeEach(() => {
  resetNavOrderIntents();
});

describe("意图存取与序号", () => {
  it("发布后立即可读，并通知订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNavOrderIntent(listener);
    const seq = publishNavOrderIntent("left", ["a", "b"]);
    expect(readNavOrderIntent("left")).toEqual({ seq, ids: ["a", "b"] });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    publishNavOrderIntent("left", ["b", "a"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("只有当前序号的清除才生效（过期响应不能撤销更新的意图）", () => {
    const first = publishNavOrderIntent("left", ["a", "b"]);
    const second = publishNavOrderIntent("left", ["b", "a"]);
    expect(second).toBeGreaterThan(first);
    // 旧序号的收尾被忽略
    expect(clearNavOrderIntent("left", first)).toBe(false);
    expect(readNavOrderIntent("left")?.ids).toEqual(["b", "a"]);
    // 当前序号可以清除
    expect(clearNavOrderIntent("left", second)).toBe(true);
    expect(readNavOrderIntent("left")).toBeNull();
  });

  it("两个界面各自独立，互不覆盖", () => {
    publishNavOrderIntent("left", ["a"]);
    expect(readNavOrderIntent("capsule")).toBeNull();
    publishNavOrderIntent("capsule", ["c"]);
    expect(readNavOrderIntent("left")?.ids).toEqual(["a"]);
    expect(dropNavOrderIntent("capsule")?.ids).toEqual(["c"]);
    expect(readNavOrderIntent("capsule")).toBeNull();
    expect(readNavOrderIntent("left")?.ids).toEqual(["a"]);
  });

  it("丢弃不存在的意图返回 null（调用方可据此避免无谓写入）", () => {
    expect(dropNavOrderIntent("left")).toBeNull();
  });
});

describe("意图应用到已提交布局", () => {
  it("只改顺序：意图里已被隐藏的入口不会复活", () => {
    const committed = defaultLeft().filter((id) => id !== "apps");
    const intent = defaultLeft();
    const next = applyNavOrderIntent(committed, intent, "left");
    expect(next).not.toContain("apps");
    expect(next).toHaveLength(committed.length);
  });

  it("提交里新出现的入口按默认顺序插回，不打断既有相对顺序", () => {
    const committed = defaultLeft();
    const intent = committed.filter((id) => id !== "agents");
    const next = applyNavOrderIntent(committed, intent, "left");
    expect(next).toContain("agents");
    // 默认顺序 2：任务(1) 之后、应用(3) 之前
    expect(next.indexOf("agents")).toBe(next.indexOf("tasks") + 1);
    // 其余相对顺序保持不变
    expect(next.filter((id) => id !== "agents")).toEqual(intent);
  });

  it("空意图等价于提交顺序（不产生假顺序）", () => {
    const committed = defaultLeft();
    expect(applyNavOrderIntent(committed, [], "left")).toEqual(committed);
  });

  it("叠加后仍收紧不变量：锁定入口固定在末尾", () => {
    const committed = defaultLeft();
    // 意图故意把锁定入口挪到最前
    const intent = ["settings", ...committed.filter((id) => id !== "settings")];
    publishNavOrderIntent("left", intent);
    const applied = applyNavOrderIntents({ ...defaultNavigationLayout(), left: committed });
    expect(applied.left[applied.left.length - 1]).toBe("settings");
    // 其它入口的相对顺序按意图排列
    expect(applied.left[0]).toBe(committed[0]);
  });

  it("叠加后仍收紧不变量：胶囊 Agent 状态球在端头", () => {
    const base = defaultNavigationLayout();
    // 意图把普通分类排到状态球前面
    const intent = base.capsule.filter((id) => id !== "agents").concat("agents");
    publishNavOrderIntent("capsule", intent);
    const applied = applyNavOrderIntents(base);
    expect(applied.capsule[0]).toBe("agents");
    expect(applied.capsule).toHaveLength(base.capsule.length);
  });

  it("没有意图时原样返回（不额外构造对象）", () => {
    const base = defaultNavigationLayout();
    expect(applyNavOrderIntents(base)).toBe(base);
  });

  it("重复叠加幂等：同一次读取不会因为已应用过而继续位移", () => {
    const base = defaultNavigationLayout();
    const moved = [...base.left];
    [moved[0], moved[1]] = [moved[1], moved[0]];
    publishNavOrderIntent("left", moved);
    const once = applyNavOrderIntents(base);
    const twice = applyNavOrderIntents(once);
    expect(twice.left).toEqual(once.left);
  });
});
