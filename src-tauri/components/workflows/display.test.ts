//! 步骤参数摘要纯函数：enter_scene 文案（已集成场景工作区，不再是「未集成」占位）。

import { describe, expect, it } from "vitest";
import { stepParamsSummary } from "./display";

describe("stepParamsSummary / enter_scene", () => {
  it("有 scene_id 时显示场景标识", () => {
    expect(
      stepParamsSummary({ step_type: "enter_scene", params: { scene_id: "abc-1" } }),
    ).toBe("场景 abc-1");
  });

  it("无 scene_id 时提示待选择", () => {
    expect(stepParamsSummary({ step_type: "enter_scene", params: {} })).toBe("（待选择场景）");
    expect(
      stepParamsSummary({ step_type: "enter_scene", params: { scene_id: "" } }),
    ).toBe("（待选择场景）");
  });
});
