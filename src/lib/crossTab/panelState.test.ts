// @vitest-environment jsdom
//! 面板状态：持久化、宽度收敛、形态判定与跨窗口同步。

import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("panelState", () => {
  it("未写入时返回默认状态", async () => {
    const mod = await import("./panelState");
    const state = mod.getPanelState();
    expect(state.visible).toBe(false);
    expect(state.width).toBe(mod.PANEL_WIDTH_DEFAULT);
    expect(state.pinned).toBe(true);
  });

  it("宽度被收敛到 240–900 并持久化", async () => {
    const mod = await import("./panelState");
    mod.setPanelWidth(120);
    expect(mod.getPanelState().width).toBe(240);
    mod.setPanelWidth(1200);
    expect(mod.getPanelState().width).toBe(900);
    expect(JSON.parse(localStorage.getItem("taskdock.transfer.panel.v1") ?? "{}").width).toBe(900);
  });

  it("固定列阈值与抽屉阈值一致", async () => {
    const mod = await import("./panelState");
    expect(mod.resolvePanelMode(1200)).toBe("dock");
    expect(mod.resolvePanelMode(1080)).toBe("dock");
    expect(mod.resolvePanelMode(1079)).toBe("drawer");
  });

  it("同窗口订阅在状态变化时收到最新值，退订后不再收到", async () => {
    const mod = await import("./panelState");
    const seen: boolean[] = [];
    const off = mod.subscribePanelState((next) => seen.push(next.visible));
    mod.setPanelVisible(true);
    mod.setPanelVisible(false);
    off();
    mod.setPanelVisible(true);
    expect(seen).toEqual([true, false]);
  });
});
