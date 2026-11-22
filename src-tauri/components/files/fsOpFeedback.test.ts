//! 统一操作反馈层回归钉：
//! - 全部成功才走成功提示；部分成功/全部失败都落到警告提示且返回 false；
//! - 文案变量只带计数与分类原因键，不带完整路径；
//! - 与 `opReport` 共用同一套稳定码分类。

import { describe, expect, it, vi } from "vitest";

import type { FsEntryReport, FsOpReport } from "../../lib/bridge";
import { describeOpSummary, showFsOpOutcome } from "./fsOpFeedback";
import { summarizeOpReport } from "../../lib/filesWorkspace/opReport";

function entry(over: Partial<FsEntryReport> = {}): FsEntryReport {
  return {
    source: "C:\\secret\\folder\\item.txt",
    target: null,
    status: "ok",
    reason: null,
    code: null,
    stage: null,
    ...over,
  };
}

function makeReport(entries: FsEntryReport[]): FsOpReport {
  return {
    operationId: "op-feedback-1",
    attempted: entries.length,
    ok: entries.filter((e) => e.status === "ok").length,
    failed: entries.filter((e) => e.status === "failed").length,
    skipped: entries.filter((e) => e.status === "skipped").length,
    partial: entries.filter((e) => e.status === "partial").length,
    entries,
  };
}

function harness() {
  const toasts: Array<{ message: string; kind: string | undefined }> = [];
  const t = vi.fn((key: string, vars?: Record<string, string | number>) =>
    `${key}|${vars ? JSON.stringify(vars) : ""}`,
  );
  const showToast = vi.fn((message: string, options?: { kind?: string }) => {
    toasts.push({ message, kind: options?.kind });
  });
  return { toasts, t, showToast };
}

describe("showFsOpOutcome", () => {
  it("全部成功：success 提示并返回 true", () => {
    const { toasts, t, showToast } = harness();
    const report = makeReport([entry(), entry(), entry()]);
    const ok = showFsOpOutcome({ effect: "copy", report, t, showToast });
    expect(ok).toBe(true);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].message).toContain("fw.report.copyOk");
  });

  it("3 成功 + 2 失败：warning 提示并返回 false，变量带齐计数与原因", () => {
    const { toasts, t, showToast } = harness();
    const report = makeReport([
      entry(),
      entry(),
      entry(),
      entry({ status: "failed", code: "FS_OP_ACCESS_DENIED", stage: "transfer" }),
      entry({ status: "failed", code: "FS_OP_FILE_BUSY", stage: "transfer" }),
    ]);
    const ok = showFsOpOutcome({ effect: "copy", report, t, showToast });
    expect(ok).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("warning");
    expect(toasts[0].message).toContain("fw.report.partialCopy");
    expect(toasts[0].message).toContain('"ok":3');
    expect(toasts[0].message).toContain('"failed":2');
    expect(toasts[0].message).toContain('"partial":0');
    expect(toasts[0].message).toContain("fw.reason.permission");
  });

  it("全部失败：返回 false，仍给警告而非成功提示", () => {
    const { toasts, t, showToast } = harness();
    const report = makeReport([
      entry({ status: "failed", code: "FS_OP_IO", stage: "transfer" }),
      entry({ status: "failed", code: "FS_OP_IO", stage: "transfer" }),
    ]);
    const ok = showFsOpOutcome({ effect: "deleteRecycle", report, t, showToast });
    expect(ok).toBe(false);
    expect(toasts[0].kind).toBe("warning");
    expect(toasts[0].message).toContain("fw.report.partialDelete");
  });

  it("反馈文案与摘要都不携带完整源路径", () => {
    const { toasts, t, showToast } = harness();
    const report = makeReport([
      entry({ status: "failed", code: "FS_OP_CONFLICT" }),
    ]);
    showFsOpOutcome({ effect: "move", report, t, showToast });
    const message = toasts[0].message;
    expect(message).not.toContain("C:\\");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("item.txt");
    const summaryText = describeOpSummary(summarizeOpReport(report));
    expect(summaryText).not.toContain("C:\\");
    expect(summaryText).not.toContain("secret");
  });
});
