// 导航契约：五栏顺序、深链白名单与首页新建任务信号的一次性消费。
// 组件挂载/返回键属于真机回归；这里固定状态机输入，避免信号归零逻辑被改坏。
import { describe, expect, it } from "vitest";

import { TAB_ORDER, parseWidgetRouteUri, shouldConsumeCreateSignal, shouldConsumeSignal } from "../nav";

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

describe("shouldConsumeSignal（搜索聚焦与新建共用同一契约）", () => {
  it("0 表示没有信号，不触发任何动作", () => {
    expect(shouldConsumeSignal(0, 0)).toBe(false);
  });

  it("同一信号只消费一次：页面重挂载/重渲染不会反复抢焦点", () => {
    expect(shouldConsumeSignal(7, 0)).toBe(true);
    expect(shouldConsumeSignal(7, 7)).toBe(false);
  });

  it("连续点击产生新 id 时才再次消费", () => {
    expect(shouldConsumeSignal(8, 7)).toBe(true);
  });

  it("旧实现 shouldConsumeCreateSignal 与新契约一致（兼容保留）", () => {
    expect(shouldConsumeCreateSignal(3, 2)).toBe(true);
    expect(shouldConsumeCreateSignal(3, 3)).toBe(false);
  });
});

describe("shouldConsumeCreateSignal（兼容旧调用）", () => {
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
