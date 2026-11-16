import { describe, expect, it } from "vitest";

import { toastTransition } from "../toastLifecycle";

describe("toastTransition", () => {
  it("首条或新 id 入场，旧动画不能继续控制新消息", () => {
    expect(toastTransition(null, { id: 1, rev: 0 })).toBe("enter");
    expect(toastTransition({ id: 1, rev: 3 }, { id: 2, rev: 0 })).toBe("enter");
  });

  it("同一条消息重复触发只重置计时，不重播入场动画", () => {
    expect(toastTransition({ id: 3, rev: 0 }, { id: 3, rev: 1 })).toBe("refresh");
  });

  it("id 与 rev 都相同是空迁移，不产生额外动画", () => {
    expect(toastTransition({ id: 3, rev: 1 }, { id: 3, rev: 1 })).toBe("idle");
  });
});
