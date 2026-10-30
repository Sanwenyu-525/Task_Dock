/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  clipboardView: vi.fn(),
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
  // mockReset 才能清掉 once 队列：clearAllMocks 不会，否则上个用例的
  // mockResolvedValueOnce 会顶掉本用例的 mockImplementation。
  mockedListen.mockReset();
  resetClipboardRequestState();
  mockedView.mockResolvedValue(viewOf(["a"]));
  mockedListen.mockImplementation(async (cb) => {
    pushChange = () => cb({ kind: "text", created: true });
    return () => {
      pushChange = null;
    };
  });
  useClipboardStore.setState({
    view: null,
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
  // 引用计数是模块级状态，测试之间必须归零，否则监听会一直活着
  useClipboardStore.getState().setLive(false);
  useClipboardStore.getState().setLive(false);
  vi.useRealTimers();
});

describe("剪贴板实时监听", () => {
  it("高频采集事件只在防抖窗口结束后刷新一次", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setLive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedListen).toHaveBeenCalledTimes(1);

    // 连续 100 次采集（截图连拍、大文件拖拽等场景）
    for (let i = 0; i < 100; i++) pushChange?.();
    await vi.advanceTimersByTimeAsync(299);
    expect(mockedView).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(mockedView).toHaveBeenCalledTimes(1);
    expect(mockedView).toHaveBeenCalledWith(expect.objectContaining({ limit: 80, offset: 0 }));
  });

  it("页面与抽屉同时存在时只建立一个后端监听", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setLive(true);
    useClipboardStore.getState().setLive(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedListen).toHaveBeenCalledTimes(1);
  });

  it("引用计数归零后才真正取消监听", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn();
    mockedListen.mockImplementation(async () => unlisten);

    useClipboardStore.getState().setLive(true);
    useClipboardStore.getState().setLive(true);
    await vi.advanceTimersByTimeAsync(0);

    // 还有页面在用时不能反订阅
    useClipboardStore.getState().setLive(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).not.toHaveBeenCalled();

    useClipboardStore.getState().setLive(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("连续采集被合并成一次刷新", async () => {
    vi.useFakeTimers();
    useClipboardStore.getState().setLive(true);
    await vi.advanceTimersByTimeAsync(0);
    mockedView.mockClear();

    // 20 次采集，每次间隔 50ms：防抖窗口一直被推后，最终只刷新一次
    for (let i = 0; i < 20; i++) {
      pushChange?.();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(mockedView).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(301);
    expect(mockedView).toHaveBeenCalledTimes(1);
  });
});
