// @vitest-environment jsdom
//! 面板状态：持久化、宽度收敛、形态判定（宿主 + 固定 + 容器宽度）与跨窗口同步。

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

  it("取消固定后即使容器够宽也只能是抽屉", async () => {
    const mod = await import("./panelState");
    expect(
      mod.resolvePanelMode({ host: "workbench", pinned: false, availableWidth: 1600 }),
    ).toBe("drawer");
  });

  it("主窗口永远是抽屉（没有工作台内容容器）", async () => {
    const mod = await import("./panelState");
    expect(mod.resolvePanelMode({ host: "main", pinned: true, availableWidth: 2000 })).toBe("drawer");
    expect(mod.resolvePanelMode({ host: "main", pinned: false, availableWidth: 2000 })).toBe("drawer");
  });

  it("工作台 + 固定 + 宽度不足时退回抽屉", async () => {
    const mod = await import("./panelState");
    expect(
      mod.resolvePanelMode({ host: "workbench", pinned: true, availableWidth: 900 }),
    ).toBe("drawer");
    expect(
      mod.resolvePanelMode({ host: "workbench", pinned: true, availableWidth: 1080 }),
    ).toBe("dock");
  });

  it("形态是运行时值：不写入 localStorage，只通知订阅者", async () => {
    const mod = await import("./panelState");
    const seen: string[] = [];
    const off = mod.subscribePanelMode((mode) => seen.push(mode));
    mod.setPanelMode("dock");
    mod.setPanelMode("dock");
    mod.setPanelMode("drawer");
    off();
    mod.setPanelMode("dock");
    expect(seen).toEqual(["dock", "drawer"]);
    const stored = JSON.parse(localStorage.getItem("taskdock.transfer.panel.v1") ?? "{}");
    expect(stored.mode).toBeUndefined();
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
