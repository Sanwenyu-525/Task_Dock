// @vitest-environment jsdom
//! deriveAcceptanceState 全分支与优先级组合测试。
//! 覆盖：① verdict 四种取值；② featureStatus 六种取值；③ taskStatus 两种；
//! ④ 全空 → unlinked；hasSubject=false 短路；verdict 优先于 featureStatus/taskStatus；
//! not_verified 附加 evidenceInsufficient。

import { describe, expect, it } from "vitest";
import { deriveAcceptanceState } from "./acceptanceStatus";

describe("deriveAcceptanceState · ① 最新验收判定优先", () => {
  it("pass → accepted", () => {
    expect(
      deriveAcceptanceState({ hasSubject: true, latestVerdict: "pass" }),
    ).toEqual({ state: "accepted" });
  });

  it("fail → rejected", () => {
    expect(
      deriveAcceptanceState({ hasSubject: true, latestVerdict: "fail" }),
    ).toEqual({ state: "rejected" });
  });

  it("blocked → blocked", () => {
    expect(
      deriveAcceptanceState({ hasSubject: true, latestVerdict: "blocked" }),
    ).toEqual({ state: "blocked" });
  });

  it("not_verified → awaiting + evidenceInsufficient", () => {
    expect(
      deriveAcceptanceState({ hasSubject: true, latestVerdict: "not_verified" }),
    ).toEqual({ state: "awaiting", evidenceInsufficient: true });
  });

  it("verdict pass 覆盖 featureStatus=blocked 与 taskStatus=pending", () => {
    expect(
      deriveAcceptanceState({
        hasSubject: true,
        latestVerdict: "pass",
        featureStatus: "blocked",
        taskStatus: "pending",
      }),
    ).toEqual({ state: "accepted" });
  });

  it("verdict fail 覆盖 featureStatus=completed", () => {
    expect(
      deriveAcceptanceState({
        hasSubject: true,
        latestVerdict: "fail",
        featureStatus: "completed",
      }),
    ).toEqual({ state: "rejected" });
  });
});

describe("deriveAcceptanceState · ② 规划功能状态", () => {
  it.each([
    ["planned", "pending_dev"],
    ["in_progress", "in_dev"],
    ["blocked", "blocked"],
    ["paused", "blocked"],
    ["review", "awaiting"],
    ["completed", "accepted"],
  ] as const)("featureStatus=%s → %s", (featureStatus, state) => {
    expect(deriveAcceptanceState({ hasSubject: true, featureStatus })).toEqual({ state });
  });

  it("featureStatus 优先于 taskStatus", () => {
    expect(
      deriveAcceptanceState({
        hasSubject: true,
        featureStatus: "in_progress",
        taskStatus: "completed",
      }),
    ).toEqual({ state: "in_dev" });
  });

  it("featureStatus=review 不产出保留值 in_review", () => {
    const r = deriveAcceptanceState({ hasSubject: true, featureStatus: "review" });
    expect(r.state).toBe("awaiting");
  });
});

describe("deriveAcceptanceState · ③ 任务状态", () => {
  it("pending → pending_dev", () => {
    expect(
      deriveAcceptanceState({ hasSubject: true, taskStatus: "pending" }),
    ).toEqual({ state: "pending_dev" });
  });

  it("completed → awaiting（任务完成 ≠ 验收通过）", () => {
    expect(
      deriveAcceptanceState({ hasSubject: true, taskStatus: "completed" }),
    ).toEqual({ state: "awaiting" });
  });
});

describe("deriveAcceptanceState · ④ 无依据 / 无对象", () => {
  it("hasSubject=true 且全空 → unlinked", () => {
    expect(deriveAcceptanceState({ hasSubject: true })).toEqual({ state: "unlinked" });
  });

  it("hasSubject=false → unlinked（不看其余字段）", () => {
    expect(
      deriveAcceptanceState({
        hasSubject: false,
        featureStatus: "in_progress",
        taskStatus: "pending",
        latestVerdict: "pass",
      }),
    ).toEqual({ state: "unlinked" });
  });

  it("null 与缺省等价", () => {
    expect(
      deriveAcceptanceState({
        hasSubject: true,
        featureStatus: null,
        taskStatus: null,
        latestVerdict: null,
      }),
    ).toEqual({ state: "unlinked" });
  });
});
