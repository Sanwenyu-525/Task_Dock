//! edgeTabActions 的悬停会话语义（2026-11-06 · edge-tab-round2）。
//!
//! 锁定的回归点：**迟到的 show 结果不得把「已显示」标记复活**，否则下一次
//! 悬停会被去重门挡住、静默不弹（用户看到的正是「第二次悬停没有提示」）。
//! 以及：后端拒绝（返回 false）不得永久阻止后续显示。

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("./errors", () => ({ invokeCommand: (...args: unknown[]) => invokeCommand(...(args as [])) }));

import {
  hideTabHint,
  resetEdgeTabActionState,
  showTabHint,
} from "./edgeTabActions";

beforeEach(() => {
  invokeCommand.mockReset();
  invokeCommand.mockResolvedValue(true);
  resetEdgeTabActionState();
});

describe("悬停提示会话（edgeTabActions）", () => {
  it("受理后置位；同一次悬停内不重复发 show", async () => {
    await expect(showTabHint("left", "任务")).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenNthCalledWith(1, "show_tab_hint", {
      edge: "left",
      text: "任务",
    });

    await showTabHint("left", "任务");
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("已显示期间文案变化必须重新下发（状态更新不能被子句去重挡住）", async () => {
    await showTabHint("left", "Agent 运行中");
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    await expect(showTabHint("left", "Agent 等待确认")).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(invokeCommand).toHaveBeenNthCalledWith(2, "show_tab_hint", {
      edge: "left",
      text: "Agent 等待确认",
    });
  });

  it("文案变化后回到原文案也照发（以「当前显示文案」为去重基准）", async () => {
    await showTabHint("left", "A");
    await showTabHint("left", "B");
    await showTabHint("left", "A");
    expect(invokeCommand).toHaveBeenCalledTimes(3);
  });

  it("迟到的 show 结果不得复活标记：hide 之后下一次 show 必须照发", async () => {
    let resolveFirst: (v: boolean) => void = () => {};
    invokeCommand.mockImplementationOnce(
      () => new Promise<boolean>((r) => (resolveFirst = r)),
    );
    const first = showTabHint("left", "任务");

    // show 还在路上，鼠标已经离开
    await hideTabHint();
    expect(invokeCommand).toHaveBeenNthCalledWith(2, "hide_tab_hint");

    resolveFirst(true);
    await expect(first).resolves.toBe(true);

    // 第二次悬停：不允许被「复活」的标记挡住
    await showTabHint("left", "任务");
    expect(invokeCommand).toHaveBeenNthCalledWith(3, "show_tab_hint", {
      edge: "left",
      text: "任务",
    });
  });

  it("后端拒绝（false）不置位，后续悬停仍会尝试", async () => {
    invokeCommand.mockResolvedValueOnce(false);
    await expect(showTabHint("left", "任务")).resolves.toBe(false);

    await showTabHint("left", "任务");
    expect(invokeCommand).toHaveBeenCalledTimes(2);
  });

  it("hide 不带显示守卫：标记与原生可见性失步时也能兜底隐藏", async () => {
    await hideTabHint();
    expect(invokeCommand).toHaveBeenCalledWith("hide_tab_hint");
  });

  it("空文案不发请求（未加载状态不得伪装成有状态）", async () => {
    await expect(showTabHint("left", "")).resolves.toBe(false);
    expect(invokeCommand).not.toHaveBeenCalled();
  });
});
