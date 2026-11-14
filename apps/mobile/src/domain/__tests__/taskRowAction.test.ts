// 任务行交互契约：锁定「勾选=完成、主体=编辑、长按=动作表」，
// 防止以后再把整行轻点接回完成（那会造成误触打卡）。
import { describe, expect, it } from "vitest";

import { taskRowAction, type TaskRowHit, type TaskRowGesture } from "../taskRowAction";

describe("taskRowAction", () => {
  it("勾选区轻点只切换完成状态", () => {
    expect(taskRowAction("checkbox", "press")).toBe("toggle");
  });

  it("行主体轻点打开编辑，不切换完成（防误触回归）", () => {
    expect(taskRowAction("body", "press")).toBe("openEditor");
  });

  it("任意区域长按都打开动作表", () => {
    const hits: TaskRowHit[] = ["checkbox", "body"];
    for (const hit of hits) {
      expect(taskRowAction(hit, "longPress")).toBe("openActions");
    }
  });

  it("四种组合互不相同地覆盖了三种动作", () => {
    const combos: [TaskRowHit, TaskRowGesture][] = [
      ["checkbox", "press"],
      ["checkbox", "longPress"],
      ["body", "press"],
      ["body", "longPress"],
    ];
    const actions = combos.map(([hit, gesture]) => taskRowAction(hit, gesture));
    expect(actions).toEqual(["toggle", "openActions", "openEditor", "openActions"]);
    // 只有勾选区轻点会改完成态
    expect(actions.filter((action) => action === "toggle")).toHaveLength(1);
  });
});
