import { describe, expect, it } from "vitest";

import {
  DESKTOP_HEIGHT_RANGE,
  DESKTOP_WIDTH_RANGE,
  desktopPresetSize,
  normalizeDesktop,
  resolveDesktopWindowSize,
  WIDGET_TYPES,
  WIDGET_SIZES,
} from "./model";
import {
  advanceSnapshotGuard,
  classifyWidgetDismissal,
  createSnapshotGuard,
  desktopWindowLabel,
  desktopWindowSize,
  isNewerRevision,
  shouldAcceptSnapshot,
  typeFromWindowLabel,
  WIDGET_EVENTS,
  type WidgetDismissedEvent,
  type WidgetSnapshotEnvelope,
} from "./desktop";
import { desktopFromWindowInfo } from "./desktopBridge";

describe("窗口 label 与类型映射", () => {
  it("desktopWindowLabel 与 typeFromWindowLabel 往返一致", () => {
    for (const type of WIDGET_TYPES) {
      expect(typeFromWindowLabel(desktopWindowLabel(type))).toBe(type);
    }
  });

  it("非微件窗口或未知类型返回 null", () => {
    expect(typeFromWindowLabel("main")).toBeNull();
    expect(typeFromWindowLabel("widget-preview")).toBeNull();
    expect(typeFromWindowLabel("widget-today-tasks-extra")).toBeNull();
    expect(typeFromWindowLabel("")).toBeNull();
  });
});

describe("快照 revision", () => {
  it("只接受严格递增的 revision", () => {
    expect(isNewerRevision(0, 1)).toBe(true);
    expect(isNewerRevision(1, 2)).toBe(true);
    expect(isNewerRevision(1, 1)).toBe(false);
    expect(isNewerRevision(2, 1)).toBe(false);
  });

  it("非法 revision 被忽略，避免损坏快照覆盖有效数据", () => {
    expect(isNewerRevision(0, Number.NaN)).toBe(false);
    expect(isNewerRevision(0, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("事件名保持唯一，避免多窗口串线", () => {
    const names = Object.values(WIDGET_EVENTS);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("快照接收守卫（会话 / 代际 / revision）", () => {
  const envelope = (overrides: Partial<WidgetSnapshotEnvelope> = {}): WidgetSnapshotEnvelope => ({
    widgetType: "quick-actions",
    revision: 1,
    epoch: "epoch-a",
    generation: 4,
    snapshot: { widgetType: "quick-actions", updatedAt: "2026-11-05T00:00:00.000Z" },
    ...overrides,
  });

  it("同一会话内只接受递增 revision，重复快照不重复更新", () => {
    const guard = { ...createSnapshotGuard(), epoch: "epoch-a", revision: 2, generation: 4 };
    expect(shouldAcceptSnapshot(guard, envelope({ revision: 3 }), 4)).toBe(true);
    expect(shouldAcceptSnapshot(guard, envelope({ revision: 2 }), 4)).toBe(false);
    expect(shouldAcceptSnapshot(guard, envelope({ revision: 1 }), 4)).toBe(false);
  });

  it("主窗会话切换（重载）后接受新 revision 计数并重置水位", () => {
    const guard = { ...createSnapshotGuard(), epoch: "epoch-a", revision: 9, generation: 4 };
    expect(shouldAcceptSnapshot(guard, envelope({ epoch: "epoch-b", revision: 1 }), 4)).toBe(true);
    expect(advanceSnapshotGuard(envelope({ epoch: "epoch-b", revision: 1 }))).toEqual({
      epoch: "epoch-b",
      revision: 1,
      generation: 4,
    });
  });

  it("旧窗口代际事件被忽略，不覆盖新实例快照", () => {
    const guard = createSnapshotGuard();
    expect(shouldAcceptSnapshot(guard, envelope({ generation: 3 }), 4)).toBe(false);
    expect(shouldAcceptSnapshot(guard, envelope({ generation: 4 }), 4)).toBe(true);
    // 已接受过某代际后，旧代际迟到仍应丢弃。
    const advanced = advanceSnapshotGuard(envelope({ generation: 4 }));
    expect(shouldAcceptSnapshot(advanced, envelope({ generation: 3, revision: 9 }), 4)).toBe(false);
  });

  it("窗口代际未知时先接受，代际回报后按已知值过滤", () => {
    const guard = createSnapshotGuard();
    expect(shouldAcceptSnapshot(guard, envelope({ generation: 5 }), null)).toBe(true);
    expect(shouldAcceptSnapshot(guard, envelope({ generation: 5, revision: 2 }), 5)).toBe(true);
    expect(shouldAcceptSnapshot(guard, envelope({ generation: 6, revision: 3 }), 5)).toBe(false);
  });
});

describe("桌面窗口尺寸", () => {
  it("每个类型的 sm/md/lg 预设均为递增且落在合法区间", () => {
    for (const type of WIDGET_TYPES) {
      let previousWidth = 0;
      for (const size of WIDGET_SIZES) {
        const preset = desktopPresetSize(type, size);
        expect(preset.width).toBeGreaterThanOrEqual(DESKTOP_WIDTH_RANGE.min);
        expect(preset.width).toBeLessThanOrEqual(DESKTOP_WIDTH_RANGE.max);
        expect(preset.height).toBeGreaterThanOrEqual(DESKTOP_HEIGHT_RANGE.min);
        expect(preset.height).toBeLessThanOrEqual(DESKTOP_HEIGHT_RANGE.max);
        expect(preset.width).toBeGreaterThan(previousWidth);
        previousWidth = preset.width;
      }
    }
  });

  it("无用户尺寸时使用 size 预设", () => {
    const size = resolveDesktopWindowSize("today-tasks", "lg", undefined);
    expect(size).toEqual(desktopPresetSize("today-tasks", "lg"));
    expect(desktopWindowSize("today-tasks", "lg")).toEqual(size);
  });

  it("用户尺寸优先，越界值收敛到上下限", () => {
    expect(resolveDesktopWindowSize("focus-timer", "sm", { visible: true, topmost: false, width: 1000, height: 900 })).toEqual({
      width: DESKTOP_WIDTH_RANGE.max,
      height: DESKTOP_HEIGHT_RANGE.max,
    });
    expect(resolveDesktopWindowSize("focus-timer", "sm", { visible: true, topmost: false, width: 10, height: 10 })).toEqual({
      width: DESKTOP_WIDTH_RANGE.min,
      height: DESKTOP_HEIGHT_RANGE.min,
    });
  });

  it("非法/缺失尺寸回落预设，小数取整", () => {
    const preset = desktopPresetSize("agent-status", "md");
    expect(
      resolveDesktopWindowSize("agent-status", "md", {
        visible: true,
        topmost: false,
        width: Number.NaN,
        height: Number.POSITIVE_INFINITY,
      }),
    ).toEqual(preset);
    expect(
      resolveDesktopWindowSize("agent-status", "md", {
        visible: true,
        topmost: false,
        width: 333.6,
      }),
    ).toMatchObject({ width: 334, height: preset.height });
  });
});

describe("窗口几何回写", () => {
  const previous = { visible: true, topmost: false, nx: 0.2, ny: 0.3 };

  it("程序 set_size / DPI 换算不写入自定义尺寸", () => {
    const next = desktopFromWindowInfo(
      {
        widgetType: "agent-status",
        generation: 7,
        width: 420,
        height: 260,
        nx: 0.4,
        ny: 0.5,
        monitor: "DISPLAY1",
        topmost: false,
        scale: 1.5,
      },
      previous,
      false,
    );
    expect(next).toMatchObject({ nx: 0.4, ny: 0.5, monitor: "DISPLAY1", topmost: false });
    // 自定义尺寸保持缺失，后续切 sm/md/lg 才会立即生效。
    expect(next.width).toBeUndefined();
    expect(next.height).toBeUndefined();
  });

  it("用户手动缩放才保存自定义宽高", () => {
    const next = desktopFromWindowInfo(
      {
        widgetType: "agent-status",
        generation: 8,
        width: 420.4,
        height: 259.6,
        nx: 0.4,
        ny: 0.5,
        monitor: null,
        topmost: true,
        scale: 1,
      },
      previous,
      true,
    );
    expect(next.width).toBe(420);
    expect(next.height).toBe(260);
    expect(next.topmost).toBe(true);
  });
});

describe("关闭事件竞态分类", () => {
  const event = (generation: number, reason: WidgetDismissedEvent["reason"], closedAt = 1000) => ({
    widgetType: "agent-status" as const,
    generation,
    reason,
    closedAt,
  });

  it("旧窗口销毁晚于新窗口创建时忽略，不影响新意图", () => {
    expect(
      classifyWidgetDismissal(event(3, "user-close", 900), {
        currentGeneration: 4,
        pendingOpen: false,
        lastOpenIntentAt: 0,
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("新窗口事件先于 show 返回时延后对账，不提前改状态", () => {
    expect(
      classifyWidgetDismissal(event(5, "destroyed"), {
        currentGeneration: 4,
        pendingOpen: true,
        lastOpenIntentAt: 0,
      }),
    ).toEqual({ kind: "defer" });
  });

  it("关闭后立即重开：关闭时间早于最新开启意图时保留显示意图", () => {
    expect(
      classifyWidgetDismissal(event(4, "user-close", 1000), {
        currentGeneration: 4,
        pendingOpen: false,
        lastOpenIntentAt: 1001,
      }),
    ).toEqual({ kind: "reopen" });
  });

  it("创建在途时普通关闭不覆盖新意图", () => {
    expect(
      classifyWidgetDismissal(event(4, "user-close", 1000), {
        currentGeneration: 4,
        pendingOpen: true,
        lastOpenIntentAt: 0,
      }),
    ).toEqual({ kind: "pending" });
  });

  it("管理页关闭只对账运行态；用户关窗与异常销毁分开处理", () => {
    const base = { currentGeneration: 4, pendingOpen: false, lastOpenIntentAt: 0 };
    expect(classifyWidgetDismissal(event(4, "management-hide"), base)).toEqual({
      kind: "management-hide",
    });
    expect(classifyWidgetDismissal(event(4, "user-close"), base)).toEqual({
      kind: "user-close",
    });
    expect(classifyWidgetDismissal(event(4, "destroyed"), base)).toEqual({
      kind: "destroyed",
    });
  });

  it("应用退出不写配置，即使代际匹配", () => {
    expect(
      classifyWidgetDismissal(event(4, "app-exit"), {
        currentGeneration: 4,
        pendingOpen: true,
        lastOpenIntentAt: 2000,
      }),
    ).toEqual({ kind: "ignore" });
  });
});

describe("normalizeDesktop", () => {
  it("旧布局缺失 desktop 时回落到安全默认（不显示/不置顶/无锚点）", () => {
    expect(normalizeDesktop(undefined)).toEqual({ visible: false, topmost: false });
    expect(normalizeDesktop(null)).toEqual({ visible: false, topmost: false });
    expect(normalizeDesktop("broken")).toEqual({ visible: false, topmost: false });
    expect(normalizeDesktop([])).toEqual({ visible: false, topmost: false });
  });

  it("只接受布尔 true，字符串/数字不会被当成显示开关", () => {
    expect(normalizeDesktop({ visible: "true", topmost: 1 })).toEqual({
      visible: false,
      topmost: false,
    });
    expect(normalizeDesktop({ visible: true, topmost: true })).toEqual({
      visible: true,
      topmost: true,
    });
  });

  it("归一化锚点限制在 0..1，非数值直接丢弃", () => {
    expect(normalizeDesktop({ nx: 2, ny: -1 }).nx).toBe(1);
    expect(normalizeDesktop({ nx: 2, ny: -1 }).ny).toBe(0);
    expect(normalizeDesktop({ nx: Number.NaN }).nx).toBeUndefined();
    expect(normalizeDesktop({ ny: "0.5" }).ny).toBeUndefined();
  });

  it("损坏的尺寸被收敛或丢弃", () => {
    const desktop = normalizeDesktop({ width: 900, height: 5 });
    expect(desktop.width).toBe(DESKTOP_WIDTH_RANGE.max);
    expect(desktop.height).toBe(DESKTOP_HEIGHT_RANGE.min);

    const invalid = normalizeDesktop({ width: Number.NaN, height: "big" });
    expect(invalid.width).toBeUndefined();
    expect(invalid.height).toBeUndefined();
  });

  it("显示器名称去空白并截断，空串视为缺失", () => {
    expect(normalizeDesktop({ monitor: "  DISPLAY1  " }).monitor).toBe("DISPLAY1");
    expect(normalizeDesktop({ monitor: "   " }).monitor).toBeUndefined();
    expect(normalizeDesktop({ monitor: 42 }).monitor).toBeUndefined();
    expect(normalizeDesktop({ monitor: "x".repeat(200) }).monitor).toHaveLength(96);
  });
});
