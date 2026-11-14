// 导航契约：五栏顺序、深链白名单与首页新建任务信号的一次性消费。
// 组件挂载/返回键属于真机回归；这里固定状态机输入，避免信号归零逻辑被改坏。
import { describe, expect, it } from "vitest";

import { TAB_ORDER, parseWidgetRouteUri, shouldConsumeCreateSignal } from "../nav";

describe("TAB_ORDER", () => {
  it("五栏顺序固定为 首页/任务/工作区/工具/我的", () => {
    expect(TAB_ORDER).toEqual(["home", "tasks", "workspace", "tools", "profile"]);
  });
});

describe("parseWidgetRouteUri", () => {
  it("只放行任务与收集箱；收集箱由 Shell 切到工具栏后再 push", () => {
    expect(parseWidgetRouteUri("taskdock://route/tasks")).toBe("tasks");
    expect(parseWidgetRouteUri("taskdock://route/inbox?from=widget")).toBe("inbox");
    expect(parseWidgetRouteUri("taskdock://route/workspace")).toBeNull();
    expect(parseWidgetRouteUri("https://example.com/route/inbox")).toBeNull();
    expect(parseWidgetRouteUri(null)).toBeNull();
  });
});

describe("shouldConsumeCreateSignal", () => {
  it("0 表示空闲，不打开弹层", () => {
    expect(shouldConsumeCreateSignal(0, 0)).toBe(false);
  });

  it("首次收到非零信号消费一次，同一信号在刷新/重挂载时不再消费", () => {
    expect(shouldConsumeCreateSignal(1, 0)).toBe(true);
    expect(shouldConsumeCreateSignal(1, 1)).toBe(false);
  });

  it("连续点击产生新 id 时才再次消费", () => {
    expect(shouldConsumeCreateSignal(2, 1)).toBe(true);
    expect(shouldConsumeCreateSignal(2, 2)).toBe(false);
  });
});
