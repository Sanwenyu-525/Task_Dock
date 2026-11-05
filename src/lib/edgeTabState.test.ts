//! Edge Tab 相位与状态机守卫测试（第三形态：Full Panel / Capsule / Edge Tab）。

import { describe, expect, it } from "vitest";
import {
  canAutoHide,
  canTransition,
  isCapsuleMode,
  isFullDockPhase,
  isTabPhase,
  type SnapPhase,
} from "./edgeSnap";

const CAPSULE_SOURCES: SnapPhase[] = [
  "docked-visible",
  "docked-hidden",
];

describe("Edge Tab · 合法转换", () => {
  it("胶囊稳定态可收起为 Edge Tab", () => {
    for (const from of CAPSULE_SOURCES) {
      expect(canTransition(from, "docked-tab")).toBe(true);
    }
  });

  it("Edge Tab 只能恢复为胶囊或拖离，不直接进入完整面板/展开面板", () => {
    expect(canTransition("docked-tab", "docked-visible")).toBe(true);
    expect(canTransition("docked-tab", "free")).toBe(true);
    expect(canTransition("docked-tab", "docked-full")).toBe(false);
    expect(canTransition("docked-tab", "docked-revealed")).toBe(false);
    expect(canTransition("docked-tab", "docked-hidden")).toBe(false);
    expect(canTransition("docked-tab", "candidate")).toBe(false);
  });

  it("自由态只在重启恢复时可直接进入标签；拖拽候选态不能虚构标签", () => {
    expect(canTransition("free", "docked-tab")).toBe(true);
    expect(canTransition("candidate", "docked-tab")).toBe(false);
  });
});

describe("Edge Tab · 形态语义", () => {
  it("isTabPhase 只认 docked-tab", () => {
    expect(isTabPhase("docked-tab")).toBe(true);
    expect(isTabPhase("docked-visible")).toBe(false);
    expect(isTabPhase("docked-full")).toBe(false);
  });

  it("Edge Tab 仍属于胶囊布局（主界面隐藏，只渲染吸附壳）", () => {
    expect(isCapsuleMode("docked-tab")).toBe(true);
    expect(isFullDockPhase("docked-tab")).toBe(false);
  });

  it("Edge Tab 是手动形态：不参与自动隐藏/自动展开", () => {
    expect(canAutoHide("docked-tab")).toBe(false);
    expect(canAutoHide("docked-visible")).toBe(true);
  });
});
