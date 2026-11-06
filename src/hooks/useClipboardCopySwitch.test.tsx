/**
 * @vitest-environment jsdom
 */
//! 「复制并切换到目标窗口」共享状态机的 A 专项测试：
//! 目标枚举节奏、防连点、统计口径、失败相位、重试只切换、条目切换与卸载作废。

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardView, CopyReport, PasteTarget } from "../lib/bridge";

const bridge = vi.hoisted(() => ({
  clipboardVisibleTargets: vi.fn(),
  clipboardPastePrecheck: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardFocusTarget: vi.fn(),
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
}));
// 注意：被 mock 的说明符必须与 hook/store 内部使用的 "../lib/bridge" 一致，
// 否则 Vitest 会加载真实 bridge（会尝试调用未注入的 Tauri internals）。
vi.mock("../lib/bridge", () => bridge);

import { useClipboardCopySwitch } from "./useClipboardCopySwitch";
import { useClipboardStore } from "../store/useClipboardStore";

const TARGET_A: PasteTarget = {
  hwnd: 101,
  pid: 1001,
  title: "记事本",
  exe_path: "C:\\Windows\\notepad.exe",
};
const TARGET_B: PasteTarget = {
  hwnd: 202,
  pid: 2002,
  title: "VS Code",
  exe_path: "C:\\Apps\\Code.exe",
};

const REPORT: CopyReport = {
  mode: "text",
  bytes: 12,
  warnings: [],
  sequence: 1,
  item_count: 1,
  stats_recorded: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function viewWithCounts(counts: Record<string, number>): ClipboardView {
  return {
    items: Object.entries(counts).map(([id, copy_count]) => ({ id, copy_count })),
    groups: [],
    stats: {},
    total_items: Object.keys(counts).length,
  } as unknown as ClipboardView;
}

function renderSwitch(itemId = "ci1") {
  return renderHook(({ id }: { id: string }) => useClipboardCopySwitch(id), {
    initialProps: { id: itemId },
  });
}

beforeEach(() => {
  bridge.clipboardVisibleTargets.mockReset();
  bridge.clipboardPastePrecheck.mockReset();
  bridge.clipboardCopyItem.mockReset();
  bridge.clipboardFocusTarget.mockReset();
  bridge.clipboardView.mockReset();
  bridge.clipboardStatus.mockReset();
  bridge.onClipboardChanged.mockReset();

  bridge.clipboardVisibleTargets.mockResolvedValue([TARGET_A, TARGET_B]);
  bridge.clipboardPastePrecheck.mockImplementation(
    async (hwnd: number, expectedPid?: number) => {
      const hit = [TARGET_A, TARGET_B].find((t) => t.hwnd === hwnd);
      if (!hit || (expectedPid !== undefined && hit.pid !== expectedPid)) {
        throw { code: "NOT_FOUND", message: "目标窗口不存在" };
      }
      return hit;
    },
  );
  bridge.clipboardCopyItem.mockResolvedValue(REPORT);
  bridge.clipboardFocusTarget.mockImplementation(async (hwnd: number) => {
    const hit = [TARGET_A, TARGET_B].find((t) => t.hwnd === hwnd);
    if (!hit) throw { code: "NOT_FOUND", message: "目标窗口不存在" };
    return hit;
  });

  useClipboardStore.setState({
    view: null,
    lite: null,
    liteLoading: false,
    liteStatus: "loading",
    liteError: null,
    liteActive: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("useClipboardCopySwitch 目标枚举", () => {
  it("挂载只枚举一次；手动 refresh 再枚举；失败保留旧列表，重试成功清错", async () => {
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));
    expect(bridge.clipboardVisibleTargets).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("ready");

    await act(async () => {
      await result.current.refresh();
    });
    expect(bridge.clipboardVisibleTargets).toHaveBeenCalledTimes(2);

    bridge.clipboardVisibleTargets.mockRejectedValueOnce(new Error("枚举失败"));
    await act(async () => {
      await result.current.refresh();
    });
    // 失败不能伪装成「没有可见窗口」：旧列表保留并标记错误
    expect(result.current.targets).toEqual([TARGET_A, TARGET_B]);
    expect(result.current.targetsError).toBeTruthy();
    expect(result.current.phase).toBe("targets-error");

    bridge.clipboardVisibleTargets.mockResolvedValueOnce([TARGET_B]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.targets).toEqual([TARGET_B]);
    expect(result.current.targetsError).toBeNull();
    expect(result.current.phase).toBe("ready");
  });

  it("两次 refresh 乱序返回时，旧响应不覆盖新列表", async () => {
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    const first = deferred<PasteTarget[]>();
    const second = deferred<PasteTarget[]>();
    bridge.clipboardVisibleTargets
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let p1!: Promise<void>;
    let p2!: Promise<void>;
    await act(async () => {
      p1 = result.current.refresh();
      p2 = result.current.refresh();
    });

    await act(async () => {
      second.resolve([TARGET_B]);
      await p2;
    });
    expect(result.current.targets).toEqual([TARGET_B]);

    await act(async () => {
      first.resolve([TARGET_A]);
      await p1;
    });
    // 较新的请求已提交，较早的迟到响应必须被丢弃
    expect(result.current.targets).toEqual([TARGET_B]);
    expect(result.current.loadingTargets).toBe(false);
  });
});

describe("useClipboardCopySwitch 复制与切换", () => {
  it("run 在途时重复调用只执行一次", async () => {
    const copied = deferred<CopyReport>();
    bridge.clipboardCopyItem.mockReturnValueOnce(copied.promise);
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.run(TARGET_A);
      void result.current.run(TARGET_A);
    });
    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1));
    expect(result.current.busy).toBe(true);
    expect(result.current.phase).toBe("busy");

    await act(async () => {
      copied.resolve(REPORT);
      await first;
    });
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardPastePrecheck).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardFocusTarget).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("completed");
  });

  it("复制成功且统计已落库才本地 +1；stats_recorded=false 不累加", async () => {
    useClipboardStore.setState({ view: viewWithCounts({ ci1: 1 }) });
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    await act(async () => {
      await result.current.run(TARGET_A);
    });
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(2);
    expect(result.current.phase).toBe("completed");

    // 统计未落库：剪贴板写入仍成功（partial），但不得在本地虚增次数
    useClipboardStore.setState({ view: viewWithCounts({ ci1: 1 }) });
    bridge.clipboardCopyItem.mockResolvedValueOnce({ ...REPORT, stats_recorded: false });
    await act(async () => {
      await result.current.run(TARGET_A);
    });
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(1);
    expect(result.current.phase).toBe("partial");
    expect(result.current.result?.copied).toBe(true);
  });

  it("copy 失败：无 focus、phase=copy-failed", async () => {
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    bridge.clipboardCopyItem.mockRejectedValueOnce(new Error("剪贴板写入失败"));
    await act(async () => {
      await result.current.run(TARGET_A);
    });
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("copy-failed");
    expect(result.current.result?.copied).toBe(false);
    expect(result.current.itemMissing).toBe(false);
  });

  it("focus 失败：copied=true；retryFocus 后 copy 次数仍为 1、phase=completed", async () => {
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    // 复制成功、切换失败：必须保留「已复制」语义
    bridge.clipboardFocusTarget.mockRejectedValueOnce(new Error("前台切换失败"));
    await act(async () => {
      await result.current.run(TARGET_A);
    });
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("focus-failed");
    expect(result.current.result?.copied).toBe(true);
    expect(result.current.result?.report).toEqual(REPORT);
    expect(result.current.feedback?.title).toBe("内容已复制，但未能切换窗口");

    // 重试切换期间独占：新的 run 不得插队触发第二次复制
    const retried = deferred<PasteTarget>();
    bridge.clipboardFocusTarget.mockReturnValueOnce(retried.promise);
    let retry!: Promise<void>;
    await act(async () => {
      retry = result.current.retryFocus();
      void result.current.run(TARGET_B);
    });
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardPastePrecheck).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("retrying-focus");

    await act(async () => {
      retried.resolve(TARGET_A);
      await retry;
    });
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
    // 首次 run 的切换失败一次 + retryFocus 一次
    expect(bridge.clipboardFocusTarget).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("completed");
    expect(result.current.result?.failure).toBeNull();
    expect(result.current.retrying).toBe(false);
  });

  it("precheck 阶段 NOT_FOUND 属于目标窗口失效，不算条目缺失", async () => {
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    bridge.clipboardPastePrecheck.mockRejectedValueOnce({ code: "NOT_FOUND", message: "窗口不存在" });
    await act(async () => {
      await result.current.run(TARGET_A);
    });
    expect(result.current.itemMissing).toBe(false);
    expect(result.current.result?.failure?.stage).toBe("precheck");
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();
  });

  it("copy NOT_FOUND 置 itemMissing；之后的 run 不再尝试复制", async () => {
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    bridge.clipboardCopyItem.mockRejectedValueOnce({ code: "NOT_FOUND", message: "条目不存在" });
    await act(async () => {
      await result.current.run(TARGET_A);
    });
    expect(result.current.itemMissing).toBe(true);
    expect(result.current.phase).toBe("copy-failed");
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);

    // 条目已不存在：再次点击目标不得重复调用 copy/precheck（同步 ref 守卫）
    await act(async () => {
      await result.current.run(TARGET_B);
    });
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
  });

  it("卸载后在途结果不写状态，也不本地累加计数", async () => {
    useClipboardStore.setState({ view: viewWithCounts({ ci1: 1 }) });
    const copied = deferred<CopyReport>();
    bridge.clipboardCopyItem.mockReturnValueOnce(copied.promise);
    const { result, unmount } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    let run!: Promise<void>;
    await act(async () => {
      run = result.current.run(TARGET_A);
    });
    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1));

    unmount();
    copied.resolve(REPORT);
    await run;

    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(1);
  });

  it("itemId 切换后，旧条目的在途结果不得写入新条目", async () => {
    useClipboardStore.setState({ view: viewWithCounts({ A: 1, B: 1 }) });
    const copied = deferred<CopyReport>();
    bridge.clipboardCopyItem.mockReturnValueOnce(copied.promise);
    const { result, rerender } = renderSwitch("A");
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    let runA!: Promise<void>;
    await act(async () => {
      runA = result.current.run(TARGET_A);
    });
    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender({ id: "B" });
    });
    expect(result.current.result).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.activeHwnd).toBeNull();

    copied.resolve(REPORT);
    await runA;
    await act(async () => {});

    // 旧条目的成功结果与计数都不得串到新条目
    expect(result.current.result).toBeNull();
    expect(result.current.phase).not.toBe("completed");
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(1);

    // 新条目自己的操作照常工作
    await act(async () => {
      await result.current.run(TARGET_B);
    });
    expect(result.current.result?.copied).toBe(true);
    expect(result.current.phase).toBe("completed");
    expect(useClipboardStore.getState().view?.items[1].copy_count).toBe(2);
  });
});
