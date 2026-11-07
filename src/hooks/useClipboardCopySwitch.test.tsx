/**
 * @vitest-environment jsdom
 */
//! 「复制并切换 / 粘贴到目标窗口」共享状态机的 A 专项测试：
//! 目标枚举节奏、防连点、统计口径、失败相位、重试只切换、单条粘贴任务等待、
//! 条目切换与卸载作废。

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClipboardPasteEvent,
  ClipboardView,
  CopyReport,
  PasteJob,
  PasteStartReport,
  PasteTarget,
} from "../lib/bridge";

const bridge = vi.hoisted(() => ({
  clipboardVisibleTargets: vi.fn(),
  clipboardPastePrecheck: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardFocusTarget: vi.fn(),
  clipboardPasteItems: vi.fn(),
  clipboardPasteJob: vi.fn(),
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
  onClipboardPaste: vi.fn(),
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

const PASTE_START: PasteStartReport = {
  job_id: "job-1",
  target: TARGET_A,
  total: 1,
  interval_ms: 350,
  intervals: { text_ms: 350, html_ms: 600, image_ms: 1200, files_ms: 900 },
};

function pasteJob(over: Partial<PasteJob> = {}): PasteJob {
  return {
    id: "job-1",
    group_id: "",
    target_title: "记事本",
    target_exe: "C:\\Windows\\notepad.exe",
    status: "running",
    total: 1,
    sent: 0,
    started_at: "2026-11-07T00:00:00Z",
    ended_at: null,
    message: "",
    remaining_items: ["ci1"],
    restored: false,
    ...over,
  };
}

function pasteEvent(over: Partial<ClipboardPasteEvent> = {}): ClipboardPasteEvent {
  return {
    jobId: "job-1",
    status: "completed",
    sent: 1,
    total: 1,
    pending: 0,
    ...over,
  };
}

/** 捕获 hook 注册的粘贴事件订阅，测试据此模拟后端 `clipboard-paste` 事件。 */
let pasteHandlers: Array<(event: ClipboardPasteEvent) => void> = [];

function emitPaste(event: ClipboardPasteEvent) {
  for (const handler of [...pasteHandlers]) handler(event);
}

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
  bridge.clipboardPasteItems.mockReset();
  bridge.clipboardPasteJob.mockReset();
  bridge.clipboardView.mockReset();
  bridge.clipboardStatus.mockReset();
  bridge.onClipboardChanged.mockReset();
  bridge.onClipboardPaste.mockReset();
  pasteHandlers = [];
  bridge.onClipboardPaste.mockImplementation(async (cb: (event: ClipboardPasteEvent) => void) => {
    pasteHandlers.push(cb);
    return () => {
      pasteHandlers = pasteHandlers.filter((h) => h !== cb);
    };
  });

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
  // 默认粘贴任务立即完成（快照路径）；需要事件路径的用例自行改为 running。
  bridge.clipboardPasteItems.mockResolvedValue(PASTE_START);
  bridge.clipboardPasteJob.mockResolvedValue(pasteJob({ status: "completed", sent: 1 }));

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

describe("useClipboardCopySwitch 粘贴到目标窗口", () => {
  it("只调用单条粘贴接口：不复制、不切换、不加使用次数；完成显示「已发送」", async () => {
    useClipboardStore.setState({ view: viewWithCounts({ ci1: 1 }) });
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    await act(async () => {
      await result.current.runPaste(TARGET_A);
    });

    // 后端粘贴队列负责聚焦/写入/按键/恢复：前端不得再调用复制或切换接口
    expect(bridge.clipboardPasteItems).toHaveBeenCalledWith(101, 1001, ["ci1"]);
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();
    expect(bridge.clipboardPastePrecheck).not.toHaveBeenCalled();
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();

    expect(result.current.phase).toBe("paste-sent");
    expect(result.current.feedback?.kind).toBe("paste-sent");
    expect(result.current.feedback?.title).toBe("已向「记事本」发送粘贴");
    // 粘贴不是复制：不得虚增使用次数
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(1);
    expect(result.current.busy).toBe(false);
    expect(result.current.activeHwnd).toBeNull();
  });

  it("任务结束以终态事件为准：运行中事件不结束等待，终态事件才解除忙碌", async () => {
    bridge.clipboardPasteJob.mockResolvedValue(pasteJob({ status: "running" }));
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    let run!: Promise<void>;
    await act(async () => {
      run = result.current.runPaste(TARGET_A);
    });
    await waitFor(() => expect(bridge.clipboardPasteItems).toHaveBeenCalledTimes(1));
    expect(result.current.busy).toBe(true);
    expect(result.current.phase).toBe("pasting");

    // 运行中的逐项进度事件不是终态
    await act(async () => {
      emitPaste(pasteEvent({ status: "running", sent: 0 }));
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      emitPaste(
        pasteEvent({
          status: "completed",
          sent: 1,
          message: "已发送 1/1 项粘贴动作；目标应用是否接收无法自动验证。已恢复粘贴前的剪贴板内容",
        }),
      );
      await run;
    });
    expect(result.current.phase).toBe("paste-sent");
    expect(result.current.busy).toBe(false);
    expect(result.current.feedback?.detail).toContain("无法自动验证");
    expect(result.current.feedback?.detail).toContain("已恢复粘贴前的剪贴板内容");
  });

  it("任务未结束时新的复制动作不得插队", async () => {
    bridge.clipboardPasteJob.mockResolvedValue(pasteJob({ status: "running" }));
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    let run!: Promise<void>;
    await act(async () => {
      run = result.current.runPaste(TARGET_A);
    });
    await waitFor(() => expect(bridge.clipboardPasteItems).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.run(TARGET_B);
    });
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();
    expect(bridge.clipboardPastePrecheck).not.toHaveBeenCalled();

    await act(async () => {
      emitPaste(pasteEvent({ status: "completed", sent: 1 }));
      await run;
    });
    expect(result.current.busy).toBe(false);
  });

  it("任务没能启动（例如已有其它粘贴任务）：显示失败原因，不显示成功", async () => {
    bridge.clipboardPasteItems.mockRejectedValueOnce(new Error("已有粘贴任务进行中，请先取消或等待完成"));
    const { result } = renderSwitch();
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    await act(async () => {
      await result.current.runPaste(TARGET_A);
    });

    expect(result.current.phase).toBe("paste-failed");
    expect(result.current.feedback?.kind).toBe("paste-failed");
    expect(result.current.feedback?.title).toBe("未能粘贴到「记事本」");
    expect(result.current.feedback?.detail).toContain("已有粘贴任务进行中");
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
  });

  it("任务失败/取消：保留后端说明，不显示为成功", async () => {
    for (const outcome of [
      { status: "failed", message: "第 1 项前失去焦点：前台切换被拒绝" },
      { status: "cancelled", message: "用户已取消；第 1 项按键已发出，接收情况未知" },
    ]) {
      bridge.clipboardPasteJob.mockResolvedValueOnce(
        pasteJob({ status: outcome.status, message: outcome.message, sent: 0 }),
      );
      const { result, unmount } = renderSwitch();
      await waitFor(() => expect(result.current.targets).toHaveLength(2));
      await act(async () => {
        await result.current.runPaste(TARGET_A);
      });
      expect(result.current.phase).toBe("paste-failed");
      expect(result.current.feedback?.kind).toBe("paste-failed");
      expect(result.current.feedback?.detail).toBe(outcome.message);
      unmount();
    }
  });

  it("itemId 切换后，旧条目的在途粘贴结果不得写入新条目", async () => {
    bridge.clipboardPasteJob.mockResolvedValue(pasteJob({ status: "running" }));
    const { result, rerender } = renderSwitch("A");
    await waitFor(() => expect(result.current.targets).toHaveLength(2));

    let runA!: Promise<void>;
    await act(async () => {
      runA = result.current.runPaste(TARGET_A);
    });
    await waitFor(() => expect(bridge.clipboardPasteItems).toHaveBeenCalledTimes(1));

    await act(async () => {
      rerender({ id: "B" });
    });
    expect(result.current.paste).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.activeHwnd).toBeNull();

    emitPaste(pasteEvent({ status: "completed", sent: 1 }));
    await runA;
    await act(async () => {});

    expect(result.current.paste).toBeNull();
    expect(result.current.phase).not.toBe("paste-sent");
  });

  it("等待超时仍无终态：解锁 UI 并如实标注「未确认粘贴任务结束」", async () => {
    vi.useFakeTimers();
    try {
      bridge.clipboardPasteJob.mockResolvedValue(pasteJob({ status: "running" }));
      const { result } = renderSwitch();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.targets).toHaveLength(2);

      let run!: Promise<void>;
      await act(async () => {
        run = result.current.runPaste(TARGET_A);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.busy).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await run;
      });

      expect(result.current.busy).toBe(false);
      expect(result.current.phase).toBe("paste-failed");
      expect(result.current.feedback?.title).toBe("未确认粘贴任务结束");
    } finally {
      vi.useRealTimers();
    }
  });
});
