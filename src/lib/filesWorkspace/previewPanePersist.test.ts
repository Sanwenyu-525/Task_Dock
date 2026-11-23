import { describe, expect, it } from "vitest";
import {
  PREVIEW_PANE_DEFAULT_WIDTH,
  PREVIEW_PANE_MAX_WIDTH,
  PREVIEW_PANE_MIN_WIDTH,
  normalizePersisted,
  normalizePreviewPane,
} from "./persist";

describe("normalizePreviewPane", () => {
  it("缺失 / 非对象 → undefined（读取侧回默认关闭）", () => {
    expect(normalizePreviewPane(undefined)).toBeUndefined();
    expect(normalizePreviewPane(null)).toBeUndefined();
    expect(normalizePreviewPane("x")).toBeUndefined();
    expect(normalizePreviewPane([])).toBeUndefined();
  });

  it("宽度钳制到 280-520，非整数四舍五入", () => {
    expect(normalizePreviewPane({ open: true, width: 999 })).toEqual({
      open: true,
      width: PREVIEW_PANE_MAX_WIDTH,
    });
    expect(normalizePreviewPane({ open: true, width: 10 })).toEqual({
      open: true,
      width: PREVIEW_PANE_MIN_WIDTH,
    });
    expect(normalizePreviewPane({ open: false, width: 360.6 })).toEqual({ open: false, width: 361 });
  });

  it("损坏字段逐项回退，不因一个坏字段整体失效", () => {
    expect(normalizePreviewPane({ open: "yes", width: "wide" })).toEqual({
      open: false,
      width: PREVIEW_PANE_DEFAULT_WIDTH,
    });
    expect(normalizePreviewPane({})).toEqual({ open: false, width: PREVIEW_PANE_DEFAULT_WIDTH });
  });
});

describe("normalizePersisted 保留 previewPane", () => {
  it("旧数据（无该字段）仍可正常归一化", () => {
    const normalized = normalizePersisted({
      version: 1,
      states: {
        global: {
          tree: { type: "pane", paneId: "pane-1" },
          panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: "D:\\a" }], activeTabId: "t1" }],
          activePaneId: "pane-1",
        },
      },
      templates: [],
      recentTemplates: [],
    });
    expect(normalized.states.global?.previewPane).toBeUndefined();
  });

  it("携带预览面板状态时原样归一化", () => {
    const normalized = normalizePersisted({
      version: 1,
      states: {
        global: {
          tree: { type: "pane", paneId: "pane-1" },
          panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: "D:\\a" }], activeTabId: "t1" }],
          activePaneId: "pane-1",
          previewPane: { open: true, width: 420 },
        },
      },
      templates: [],
      recentTemplates: [],
    });
    expect(normalized.states.global?.previewPane).toEqual({ open: true, width: 420 });
  });
});
