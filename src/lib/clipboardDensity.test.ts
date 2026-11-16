/**
 * @vitest-environment jsdom
 */
//! 剪贴板视图密度：持久化与「只改呈现」的契约。
//!
//! 密度是纯呈现状态，必须满足：
//! - 读取失败/脏值回退舒适，不阻断页面；
//! - 写入 localStorage，重启后保持；
//! - 切换密度不推进筛选代际、不清空多选、不重新拉取数据
//!   （这三条由 Store 用例锁定，因为它们是「切换模式后筛选不丢、多选保留」的根因）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../lib/bridge", () => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(async () => ({ dispose: () => {} })),
}));

import { clipboardView } from "../lib/bridge";
import {
  CLIPBOARD_DENSITY_STORAGE_KEY,
  CLIPBOARD_DENSITY_OPTIONS,
  readClipboardDensity,
  useClipboardDensity,
  writeClipboardDensity,
} from "./clipboardDensity";
import { resetClipboardRequestState, useClipboardStore } from "../store/useClipboardStore";

const mockedView = vi.mocked(clipboardView);

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  resetClipboardRequestState();
  useClipboardStore.setState({
    view: null,
    filters: { kind: "all", search: "", favorite: false },
    density: "comfort",
    selectedItems: [],
    selectedGroups: [],
  });
});

describe("clipboardDensity 持久化", () => {
  it("默认舒适；脏值/缺失回退舒适", () => {
    expect(readClipboardDensity()).toBe("comfort");
    window.localStorage.setItem(CLIPBOARD_DENSITY_STORAGE_KEY, "大字报");
    expect(readClipboardDensity()).toBe("comfort");
    window.localStorage.setItem(CLIPBOARD_DENSITY_STORAGE_KEY, "list");
    expect(readClipboardDensity()).toBe("list");
  });

  it("三种模式都有中文标签与用途说明（按钮不靠图标单独表意）", () => {
    expect(CLIPBOARD_DENSITY_OPTIONS.map((o) => o.value)).toEqual(["comfort", "compact", "list"]);
    for (const option of CLIPBOARD_DENSITY_OPTIONS) {
      expect(option.label.trim()).not.toBe("");
      expect(option.hint.trim()).not.toBe("");
    }
  });

  it("写入后可读回", () => {
    writeClipboardDensity("compact");
    expect(window.localStorage.getItem(CLIPBOARD_DENSITY_STORAGE_KEY)).toBe("compact");
    expect(readClipboardDensity()).toBe("compact");
  });

  it("useClipboardDensity：初值来自存储，切换后立刻写回", () => {
    window.localStorage.setItem(CLIPBOARD_DENSITY_STORAGE_KEY, "list");
    const { result } = renderHook(() => useClipboardDensity());
    expect(result.current[0]).toBe("list");

    act(() => result.current[1]("comfort"));
    expect(result.current[0]).toBe("comfort");
    expect(window.localStorage.getItem(CLIPBOARD_DENSITY_STORAGE_KEY)).toBe("comfort");
  });
});

describe("ClipboardStore.setDensity 只改呈现", () => {
  it("保留筛选与多选，写入存储，且不触发任何列表请求", () => {
    useClipboardStore.setState({
      filters: { kind: "image", search: "周报", favorite: true },
      selectedItems: ["a", "b"],
      selectedGroups: ["g1"],
    });

    useClipboardStore.getState().setDensity("compact");

    const state = useClipboardStore.getState();
    expect(state.density).toBe("compact");
    expect(state.filters).toEqual({ kind: "image", search: "周报", favorite: true });
    expect(state.selectedItems).toEqual(["a", "b"]);
    expect(state.selectedGroups).toEqual(["g1"]);
    expect(window.localStorage.getItem(CLIPBOARD_DENSITY_STORAGE_KEY)).toBe("compact");
    expect(mockedView).not.toHaveBeenCalled();
  });

  it("连续切换不会累计请求或清空选中（避免切模式后浏览位置跳回顶部）", () => {
    useClipboardStore.setState({ selectedItems: ["a"] });
    for (const density of ["compact", "list", "comfort", "list"] as const) {
      useClipboardStore.getState().setDensity(density);
    }
    expect(useClipboardStore.getState().density).toBe("list");
    expect(useClipboardStore.getState().selectedItems).toEqual(["a"]);
    expect(mockedView).not.toHaveBeenCalled();
  });
});
