//! 「复制并切换到目标窗口」事务的 A 专项单测：顺序、失败分层与统一文案。

import { describe, expect, it, vi } from "vitest";
import type { CopyReport, PasteTarget } from "./bridge";
import {
  copyAndSwitchItem,
  copyPartialDetail,
  describeCopySwitchResult,
  focusTargetOnly,
  isPartialCopy,
  type CopySwitchDeps,
  type CopySwitchResult,
} from "./clipboardCopySwitch";

const TARGET: PasteTarget = {
  hwnd: 101,
  pid: 1001,
  title: "记事本",
  exe_path: "C:\\Windows\\notepad.exe",
};

function reportOf(overrides: Partial<CopyReport> = {}): CopyReport {
  return {
    mode: "text",
    bytes: 12,
    warnings: [],
    sequence: 1,
    item_count: 1,
    stats_recorded: true,
    ...overrides,
  };
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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 记录调用顺序并允许按需替换返回值的依赖。 */
function depsOf(overrides: Partial<CopySwitchDeps> = {}) {
  const calls: string[] = [];
  const deps: CopySwitchDeps = {
    precheck: vi.fn(async (hwnd: number, pid: number) => {
      calls.push(`precheck:${hwnd}:${pid}`);
      return TARGET;
    }),
    copy: vi.fn(async (itemId: string) => {
      calls.push(`copy:${itemId}`);
      return reportOf();
    }),
    focus: vi.fn(async (hwnd: number, pid: number) => {
      calls.push(`focus:${hwnd}:${pid}`);
      return TARGET;
    }),
    ...overrides,
  };
  return { calls, deps };
}

describe("copyAndSwitchItem", () => {
  it("严格按 precheck → copy → focus 顺序执行，并传递 HWND/PID 与条目 id", async () => {
    const pre = deferred<PasteTarget>();
    const copied = deferred<CopyReport>();
    const { calls, deps } = depsOf({
      precheck: vi.fn((hwnd: number, pid: number) => {
        calls.push(`precheck:${hwnd}:${pid}`);
        return pre.promise;
      }),
      copy: vi.fn((itemId: string) => {
        calls.push(`copy:${itemId}`);
        return copied.promise;
      }),
      focus: vi.fn(async (hwnd: number, pid: number) => {
        calls.push(`focus:${hwnd}:${pid}`);
        return TARGET;
      }),
    });

    const run = copyAndSwitchItem("ci1", { hwnd: 101, pid: 1001 }, deps);
    // precheck 在调用栈内立即发起，此时不得复制或切换
    expect(calls).toEqual(["precheck:101:1001"]);
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.focus).not.toHaveBeenCalled();

    pre.resolve(TARGET);
    await flush();
    expect(calls).toEqual(["precheck:101:1001", "copy:ci1"]);
    expect(deps.focus).not.toHaveBeenCalled();

    copied.resolve(reportOf());
    const result = await run;
    expect(calls).toEqual(["precheck:101:1001", "copy:ci1", "focus:101:1001"]);
    expect(result).toMatchObject({
      copied: true,
      partial: false,
      failure: null,
      precheckTarget: TARGET,
      focusTarget: TARGET,
    });
    expect(result.report?.item_count).toBe(1);
  });

  it("precheck 失败：不复制、不切换，failure.stage=precheck", async () => {
    const error = new Error("目标窗口已失效");
    const { deps } = depsOf({
      precheck: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await copyAndSwitchItem("ci1", { hwnd: 101, pid: 1001 }, deps);

    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.focus).not.toHaveBeenCalled();
    expect(result).toEqual({
      copied: false,
      partial: false,
      report: null,
      precheckTarget: null,
      focusTarget: null,
      failure: { stage: "precheck", error },
    });
  });

  it("复制失败：不切换，failure.stage=copy，保留 precheck 结果", async () => {
    const error = new Error("剪贴板写入失败");
    const { deps } = depsOf({
      copy: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await copyAndSwitchItem("ci1", { hwnd: 101, pid: 1001 }, deps);

    expect(deps.precheck).toHaveBeenCalledWith(101, 1001);
    expect(deps.focus).not.toHaveBeenCalled();
    expect(result.copied).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.report).toBeNull();
    expect(result.precheckTarget).toEqual(TARGET);
    expect(result.failure).toEqual({ stage: "copy", error });
  });

  it("复制成功但切换失败：copied=true、failure.stage=focus，保留 report", async () => {
    const error = new Error("前台切换被拒绝");
    const report = reportOf({ warnings: ["目标窗口最小化"] });
    const { deps } = depsOf({
      copy: vi.fn(async () => report),
      focus: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await copyAndSwitchItem("ci1", { hwnd: 101, pid: 1001 }, deps);

    expect(result.copied).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.report).toBe(report);
    expect(result.focusTarget).toBeNull();
    expect(result.failure).toEqual({ stage: "focus", error });
  });

  it("部分成功（stats_recorded=false / warnings）仍算 copied，且继续切换", async () => {
    for (const report of [
      reportOf({ stats_recorded: false }),
      reportOf({ warnings: ["文件列表未全部写入"] }),
    ]) {
      const { deps } = depsOf({ copy: vi.fn(async () => report) });

      const result = await copyAndSwitchItem("ci1", { hwnd: 101, pid: 1001 }, deps);

      expect(isPartialCopy(report)).toBe(true);
      expect(result.copied).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.failure).toBeNull();
      expect(deps.focus).toHaveBeenCalledWith(101, 1001);
    }
  });
});

describe("focusTargetOnly", () => {
  it("只切换窗口：不 precheck、不复制", async () => {
    const { deps } = depsOf();

    const result = await focusTargetOnly({ hwnd: 101, pid: 1001 }, deps);

    expect(deps.precheck).not.toHaveBeenCalled();
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.focus).toHaveBeenCalledWith(101, 1001);
    expect(result).toEqual({ ok: true, target: TARGET, error: null });
  });

  it("切换失败时返回 ok=false 与原因，不抛异常", async () => {
    const error = new Error("目标不在前台");
    const { deps } = depsOf({
      focus: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await focusTargetOnly({ hwnd: 101, pid: 1001 }, deps);

    expect(result).toEqual({ ok: false, target: null, error });
    expect(deps.copy).not.toHaveBeenCalled();
  });
});

describe("describeCopySwitchResult / partial 文案", () => {
  const base: CopySwitchResult = {
    copied: true,
    partial: false,
    report: reportOf(),
    precheckTarget: TARGET,
    focusTarget: TARGET,
    failure: null,
  };

  it("完全成功", () => {
    const feedback = describeCopySwitchResult(base, { targetTitle: "记事本" });
    expect(feedback).toEqual({
      kind: "success",
      title: "已复制并切换到「记事本」",
      detail: null,
    });
  });

  it("部分成功保留具体原因，不显示为失败", () => {
    const feedback = describeCopySwitchResult(
      { ...base, partial: true, report: reportOf({ stats_recorded: false }) },
      { targetTitle: "记事本" },
    );
    expect(feedback.kind).toBe("partial");
    expect(feedback.title).toBe("已复制并切换到「记事本」");
    expect(feedback.detail).toContain("部分成功");
    expect(feedback.detail).toContain("使用次数未记录");
    expect(copyPartialDetail(reportOf({ stats_recorded: false }))).toBe("使用次数未记录");
  });

  it("precheck 失败归入 copy-failed（未复制）", () => {
    const feedback = describeCopySwitchResult(
      {
        ...base,
        copied: false,
        partial: false,
        report: null,
        focusTarget: null,
        failure: { stage: "precheck", error: new Error("窗口句柄已复用") },
      },
      { targetTitle: "记事本", errorText: () => "窗口句柄已复用" },
    );
    expect(feedback).toEqual({
      kind: "copy-failed",
      title: "目标窗口已失效，未复制内容",
      detail: "窗口句柄已复用",
    });
  });

  it("复制失败归入 copy-failed（未切换）", () => {
    const feedback = describeCopySwitchResult(
      {
        ...base,
        copied: false,
        partial: false,
        report: null,
        focusTarget: null,
        failure: { stage: "copy", error: new Error("剪贴板被占用") },
      },
      { targetTitle: "记事本", errorText: () => "剪贴板被占用" },
    );
    expect(feedback).toEqual({
      kind: "copy-failed",
      title: "复制失败，未切换窗口",
      detail: "剪贴板被占用",
    });
  });

  it("切换失败必须是「内容已复制，但未能切换窗口」", () => {
    const feedback = describeCopySwitchResult(
      { ...base, focusTarget: null, failure: { stage: "focus", error: new Error("前台被拒绝") } },
      { targetTitle: "记事本", errorText: () => "前台被拒绝" },
    );
    expect(feedback).toEqual({
      kind: "focus-failed",
      title: "内容已复制，但未能切换窗口",
      detail: "前台被拒绝",
    });
  });
});
