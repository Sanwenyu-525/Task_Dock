/**
 * @vitest-environment jsdom
 */
//! 剪贴板 Lite 面板的四类数据状态（loading/ready/empty/error）与监听状态派生。
//!
//! B1 验收点：
//! - 失败绝不置空数组伪装「暂无记录」：无旧数据 → 错误空态；有旧数据 → 旧数据
//!   原样保留 + liteError，均可重试；
//! - 成功但确实无记录才叫 empty；
//! - 监听状态与列表错误分开：clipboardStatus() 失败是 unknown，绝不默认「监听中」；
//! - liteSeq 防乱序：迟到的旧响应不得覆盖新状态。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
}));

import { clipboardStatus, clipboardView, type ClipboardStatus, type ClipboardView } from "../lib/bridge";
import { clipboardMonitorState, useClipboardStore } from "./useClipboardStore";

const mockedView = vi.mocked(clipboardView);
const mockedStatus = vi.mocked(clipboardStatus);

function viewOf(ids: string[]): ClipboardView {
  return {
    items: ids.map((id) => ({ id })),
    groups: [],
    stats: {},
    total_items: ids.length,
  } as unknown as ClipboardView;
}

function statusOf(patch: Partial<ClipboardStatus>): ClipboardStatus {
  return {
    enabled: true,
    paused: false,
    monitoring: false,
    activeJob: null,
    platform: "windows",
    configError: null,
    configOrigin: null,
    captureAllowed: true,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedView.mockReset();
  mockedStatus.mockReset();
  useClipboardStore.setState({
    lite: null,
    liteLoading: false,
    liteStatus: "loading",
    liteError: null,
    monitor: "checking",
  });
});

describe("loadLite 数据状态机", () => {
  it("成功且有数据 → ready", async () => {
    mockedView.mockResolvedValue(viewOf(["a", "b"]));
    await useClipboardStore.getState().loadLite();
    const s = useClipboardStore.getState();
    expect(s.liteStatus).toBe("ready");
    expect(s.liteError).toBeNull();
    expect(s.lite?.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("成功但确实无记录 → empty（不冒充错误，也不冒充有数据）", async () => {
    mockedView.mockResolvedValue(viewOf([]));
    await useClipboardStore.getState().loadLite();
    expect(useClipboardStore.getState().liteStatus).toBe("empty");
    expect(useClipboardStore.getState().lite?.items).toEqual([]);
  });

  it("失败且无旧数据 → lite 保持 null + error（不置空数组伪装暂无记录）", async () => {
    mockedView.mockRejectedValue(new Error("db locked"));
    await useClipboardStore.getState().loadLite();
    const s = useClipboardStore.getState();
    expect(s.lite).toBeNull();
    expect(s.liteStatus).toBe("error");
    expect(s.liteError).toContain("db locked");
  });

  it("失败但有旧数据 → 旧数据原样保留 + error（异步失败不清除已成功数据）", async () => {
    mockedView.mockResolvedValue(viewOf(["keep-1"]));
    await useClipboardStore.getState().loadLite();
    mockedView.mockRejectedValue(new Error("boom"));
    await useClipboardStore.getState().loadLite();
    const s = useClipboardStore.getState();
    expect(s.liteStatus).toBe("error");
    expect(s.lite?.items.map((i) => i.id)).toEqual(["keep-1"]);
    expect(s.liteError).toContain("boom");
  });

  it("失败后重试成功 → 错误清除回到 ready", async () => {
    mockedView.mockRejectedValueOnce(new Error("boom"));
    mockedView.mockResolvedValue(viewOf(["ok"]));
    await useClipboardStore.getState().loadLite();
    await useClipboardStore.getState().loadLite();
    const s = useClipboardStore.getState();
    expect(s.liteStatus).toBe("ready");
    expect(s.liteError).toBeNull();
    expect(s.lite?.items.map((i) => i.id)).toEqual(["ok"]);
  });

  it("releaseLite 释放视图并把状态复位（下次打开重新确认，不携带旧结论）", async () => {
    mockedView.mockResolvedValue(viewOf(["a"]));
    mockedStatus.mockResolvedValue(statusOf({ monitoring: true }));
    await useClipboardStore.getState().loadLite();
    await useClipboardStore.getState().loadMonitor();
    useClipboardStore.getState().releaseLite();
    const s = useClipboardStore.getState();
    expect(s.lite).toBeNull();
    expect(s.liteStatus).toBe("loading");
    expect(s.liteError).toBeNull();
    expect(s.monitor).toBe("checking");
  });

  it("乱序：卸载后迟到的失败响应不得污染新会话", async () => {
    let rejectFirst!: (e: unknown) => void;
    mockedView.mockImplementationOnce(
      () => new Promise<ClipboardView>((_, reject) => (rejectFirst = reject)),
    );
    const first = useClipboardStore.getState().loadLite();
    useClipboardStore.getState().releaseLite(); // 面板关闭：liteSeq 推进
    rejectFirst(new Error("late failure"));
    await first;
    const s = useClipboardStore.getState();
    expect(s.lite).toBeNull();
    expect(s.liteStatus).not.toBe("error");
  });
});

describe("loadMonitor 监听状态", () => {
  it("clipboardStatus 成功 → 按 configError > disabled > paused > monitoring 派生", async () => {
    mockedStatus.mockResolvedValue(statusOf({ monitoring: true }));
    await useClipboardStore.getState().loadMonitor();
    expect(useClipboardStore.getState().monitor).toBe("ok");

    mockedStatus.mockResolvedValue(statusOf({ monitoring: true, configError: { kind: "json", keys: [], message: "x" } }));
    await useClipboardStore.getState().loadMonitor();
    expect(useClipboardStore.getState().monitor).toBe("configError");

    mockedStatus.mockResolvedValue(statusOf({ enabled: false }));
    await useClipboardStore.getState().loadMonitor();
    expect(useClipboardStore.getState().monitor).toBe("disabled");

    mockedStatus.mockResolvedValue(statusOf({ paused: true, monitoring: true }));
    await useClipboardStore.getState().loadMonitor();
    expect(useClipboardStore.getState().monitor).toBe("paused");
  });

  it("clipboardStatus 调用失败 → unknown（绝不默认「监听中」）", async () => {
    mockedStatus.mockRejectedValue(new Error("invoke failed"));
    await useClipboardStore.getState().loadMonitor();
    expect(useClipboardStore.getState().monitor).toBe("unknown");
  });
});

describe("clipboardMonitorState 派生纯函数（六态映射）", () => {
  it("调用失败/无数据 → unknown", () => {
    expect(clipboardMonitorState(null, true)).toBe("unknown");
    expect(clipboardMonitorState(statusOf({ monitoring: true }), true)).toBe("unknown");
    expect(clipboardMonitorState(null, false)).toBe("unknown");
  });

  it("configError 优先（配置异常时 monitoring 不可信）", () => {
    expect(
      clipboardMonitorState(statusOf({ monitoring: true, configError: { kind: "json", keys: [], message: "x" } }), false),
    ).toBe("configError");
  });

  it("enabled=false → disabled；paused=true → paused", () => {
    expect(clipboardMonitorState(statusOf({ enabled: false }), false)).toBe("disabled");
    expect(clipboardMonitorState(statusOf({ paused: true }), false)).toBe("paused");
  });

  it("enabled 且未暂停：monitoring=true → ok，否则 → notRunning（监听线程未运行）", () => {
    expect(clipboardMonitorState(statusOf({ monitoring: true }), false)).toBe("ok");
    expect(clipboardMonitorState(statusOf({ monitoring: false }), false)).toBe("notRunning");
  });
});
