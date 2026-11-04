/**
 * @vitest-environment jsdom
 */
//! 剪贴板实时链路测试：事件 → 全局唯一监听 → 去抖 → 分入口刷新。
//!
//! 重点覆盖验收要求：
//! - 订阅失败不得被静默吞掉（空作用域会被销毁并退避重试，不叠加监听）；
//! - Lite 活跃时事件必须刷新 `lite`，包括首次读取失败（`lite === null`）的情况；
//! - 完整页未打开时，事件不得触发 80 条完整列表查询；
//! - 快速展开/收起后迟到的 unlisten 必须释放，不留幽灵监听。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
}));

import { clipboardView, onClipboardChanged } from "../lib/bridge";
import type { ClipboardView } from "../lib/bridge";
import { resetClipboardRequestState, useClipboardStore } from "./useClipboardStore";

const mockedView = vi.mocked(clipboardView);
const mockedListen = vi.mocked(onClipboardChanged);

function viewOf(ids: string[]): ClipboardView {
  return {
    items: ids.map((id) => ({ id })),
    groups: [],
    stats: {},
    total_items: ids.length,
  } as unknown as ClipboardView;
}

/** 模拟后端推送采集事件。 */
let pushChange: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockedListen.mockReset();
  resetClipboardRequestState();
  pushChange = null;
  mockedView.mockResolvedValue(viewOf(["a"]));
  mockedListen.mockImplementation(async (cb) => {
    pushChange = () => cb({ kind: "text", created: true });
    return () => {
      pushChange = null;
    };
  });
  useClipboardStore.setState({
    view: null,
    lite: null,
    liteStatus: "loading",
    liteError: null,
    liteActive: false,
    filters: { kind: "all", search: "", favorite: false },
    section: "items",
    searchText: "",
    loading: false,
    loadingMore: false,
    error: null,
    selectedItems: [],
    selectedGroups: [],
  });
});

afterEach(() => {
  // 监听引用计数是模块级状态：每个用例结束必须归零，否则监听会跨用例存活
  resetClipboardRequestState();
  vi.useRealTimers();
});

describe("剪贴板实时监听", () => {
  it("完整页高频采集事件只在防抖窗口结束后刷新一次", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setFullLive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedListen).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 100; i++) pushChange?.();
    await vi.advanceTimersByTimeAsync(299);
    expect(mockedView).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(mockedView).toHaveBeenCalledTimes(1);
    expect(mockedView).toHaveBeenCalledWith(expect.objectContaining({ limit: 80, offset: 0 }));
  });

  it("完整页与 Lite 同时存在时只建立一个后端监听", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setFullLive(true);
    useClipboardStore.getState().setLiteLive(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedListen).toHaveBeenCalledTimes(1);
  });

  it("Lite 活跃时事件自动刷新轻量列表（不手动刷新）", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setLiteLive(true);
    await vi.advanceTimersByTimeAsync(0);
    mockedView.mockClear();

    pushChange?.();
    await vi.advanceTimersByTimeAsync(301);

    expect(mockedView).toHaveBeenCalledTimes(1);
    expect(mockedView).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(useClipboardStore.getState().lite?.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("Lite 首次读取失败后事件仍能带出错误态并刷新成功的记录", async () => {
    vi.useFakeTimers();
    useClipboardStore.setState({ lite: null, liteStatus: "error", liteError: "读取失败" });
    useClipboardStore.getState().setLiteLive(true);
    await vi.advanceTimersByTimeAsync(0);

    mockedView.mockClear();
    pushChange?.();
    await vi.advanceTimersByTimeAsync(301);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedView).toHaveBeenCalledTimes(1);
    expect(useClipboardStore.getState().liteStatus).toBe("ready");
  });

  it("完整页未打开时，Lite 事件不查询 80 条完整列表", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setLiteLive(true);
    await vi.advanceTimersByTimeAsync(0);
    mockedView.mockClear();

    pushChange?.();
    await vi.advanceTimersByTimeAsync(301);

    expect(mockedView).toHaveBeenCalledTimes(1);
    expect(mockedView).not.toHaveBeenCalledWith(expect.objectContaining({ limit: 80 }));
  });

  it("完整页与 Lite 同时活跃时各自刷新所需数据", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setFullLive(true);
    useClipboardStore.getState().setLiteLive(true);
    await vi.advanceTimersByTimeAsync(0);
    mockedView.mockClear();

    pushChange?.();
    await vi.advanceTimersByTimeAsync(301);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedView).toHaveBeenCalledWith(expect.objectContaining({ limit: 80 }));
    expect(mockedView).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("订阅失败后销毁空作用域并重试，恢复后事件仍能刷新", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    mockedListen.mockImplementation(async (cb) => {
      attempt += 1;
      if (attempt === 1) throw new Error("listen 失败");
      pushChange = () => cb({ kind: "text", created: true });
      return () => {
        pushChange = null;
      };
    });

    useClipboardStore.getState().setLiteLive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedListen).toHaveBeenCalledTimes(1);
    expect(pushChange).toBeNull();

    // 退避 1s 后重新订阅：不得因为 liveScope 非空而永远短路
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockedListen).toHaveBeenCalledTimes(2);

    mockedView.mockClear();
    pushChange?.();
    await vi.advanceTimersByTimeAsync(301);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedView).toHaveBeenCalledTimes(1);
  });

  it("收起后取消监听；迟到的监听在作用域关闭时立即反订阅", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn();
    let resolveListen: (fn: () => void) => void = () => {};
    mockedListen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = (fn) => resolve(fn);
        }),
    );

    useClipboardStore.getState().setLiteLive(true);
    useClipboardStore.getState().releaseLite();
    expect(useClipboardStore.getState().liteActive).toBe(false);

    // 监听在面板关闭后才兑现：必须立刻反订阅，不能留下幽灵监听
    resolveListen(unlisten);
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(1);

    // 重新打开会重新建立监听
    useClipboardStore.getState().setLiteLive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedListen).toHaveBeenCalledTimes(2);
  });
});
