//! 文件操作结果摘要：断言「部分成功」不会被当成全部成功，且原因分类来自稳定码。

import { describe, expect, it } from "vitest";
import type { FsEntryReport, FsOpReport } from "../bridge";
import { reasonKeyForCategory, summarizeOpReport } from "./opReport";

function entry(over: Partial<FsEntryReport> = {}): FsEntryReport {
  return { source: "C:\\secret\\a.txt", target: null, status: "ok", reason: null, ...over };
}

function report(entries: FsEntryReport[], counts: Partial<FsOpReport> = {}): FsOpReport {
  return {
    operationId: "op-1",
    attempted: entries.length,
    ok: entries.filter((e) => e.status === "ok").length,
    failed: entries.filter((e) => e.status === "failed").length,
    skipped: entries.filter((e) => e.status === "skipped").length,
    partial: entries.filter((e) => e.status === "partial").length,
    entries,
    ...counts,
  };
}

describe("summarizeOpReport", () => {
  it("5 项中 3 成功 1 权限失败 1 占用失败：不是全部成功，主导原因是权限", () => {
    const summary = summarizeOpReport(
      report([
        entry(),
        entry(),
        entry(),
        entry({ status: "failed", code: "FS_OP_ACCESS_DENIED", stage: "transfer" }),
        entry({ status: "failed", code: "FS_OP_FILE_BUSY", stage: "transfer" }),
      ]),
    );

    expect(summary).toMatchObject({
      attempted: 5,
      ok: 3,
      failed: 2,
      skipped: 0,
      partial: 0,
      unsuccessful: 2,
      isPartial: true,
      dominantCode: "FS_OP_ACCESS_DENIED",
      category: "permission",
    });
  });

  it("失败与部分完成都计入 unsuccessful，partial 单独计数", () => {
    const summary = summarizeOpReport(
      report([
        entry({ status: "failed", code: "FS_OP_IO" }),
        entry({ status: "partial", code: "FS_OP_IO" }),
        entry({ status: "skipped" }),
      ]),
    );
    expect(summary.failed).toBe(1);
    expect(summary.partial).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.unsuccessful).toBe(2);
    expect(summary.category).toBe("io");
  });

  it("全部成功：unsuccessful 为 0，没有主导错误码", () => {
    const summary = summarizeOpReport(report([entry(), entry()]));
    expect(summary.unsuccessful).toBe(0);
    expect(summary.dominantCode).toBeNull();
    expect(summary.category).toBeNull();
    expect(summary.isPartial).toBe(false);
  });

  it("只剩跳过（同名策略）：不算失败，也不提示部分失败", () => {
    const summary = summarizeOpReport(report([entry({ status: "skipped" })]));
    expect(summary.unsuccessful).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.isPartial).toBe(false);
  });

  it("同数量失败码按码字典序取主导，结果稳定", () => {
    const a = summarizeOpReport(
      report([
        entry({ status: "failed", code: "FS_OP_IO" }),
        entry({ status: "failed", code: "FS_OP_ACCESS_DENIED" }),
      ]),
    );
    const b = summarizeOpReport(
      report([
        entry({ status: "failed", code: "FS_OP_ACCESS_DENIED" }),
        entry({ status: "failed", code: "FS_OP_IO" }),
      ]),
    );
    expect(a.dominantCode).toBe("FS_OP_ACCESS_DENIED");
    expect(b.dominantCode).toBe("FS_OP_ACCESS_DENIED");
  });

  it("缺失 code 归为未知，不解析中文 reason", () => {
    const summary = summarizeOpReport(
      report([entry({ status: "failed", code: null, reason: "拒绝访问。 (os error 5)" })]),
    );
    expect(summary.dominantCode).toBe("FS_OP_UNKNOWN");
    expect(summary.category).toBe("unknown");
  });

  it("摘要字符串不含路径（避免把报告打进日志/Toast）", () => {
    const summary = summarizeOpReport(
      report([entry({ status: "failed", code: "FS_OP_ACCESS_DENIED" })]),
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("C:\\");
    expect(summary.failed).toBe(1);
    expect(summary.dominantCode).toBe("FS_OP_ACCESS_DENIED");
  });

  it("全部失败：isPartial=false，失败计数如实保留", () => {
    const summary = summarizeOpReport(
      report([
        entry({ status: "failed", code: "FS_OP_ACCESS_DENIED" }),
        entry({ status: "failed", code: "FS_OP_IO" }),
      ]),
    );
    expect(summary.ok).toBe(0);
    expect(summary.failed).toBe(2);
    expect(summary.unsuccessful).toBe(2);
    expect(summary.isPartial).toBe(false);
  });

  it.each([
    ["FS_OP_SOURCE_MISSING", "not_found"],
    ["FS_OP_ACCESS_DENIED", "permission"],
    ["FS_OP_FILE_BUSY", "io"],
    ["FS_OP_IO", "io"],
    ["FS_OP_CONFLICT", "conflict"],
    ["FS_OP_VALIDATION", "validation"],
    ["FS_OP_UNSUPPORTED", "unsupported"],
    ["FS_OP_CANCELLED", "cancelled"],
    ["FS_OP_MULTI_FAILURE", "unknown"],
  ])("%s 映射分类 %s", (code, category) => {
    const summary = summarizeOpReport(report([entry({ status: "failed", code })]));
    expect(summary.category).toBe(category);
  });
});

describe("reasonKeyForCategory", () => {
  it("已知分类原样返回，未知/空回退 unknown", () => {
    expect(reasonKeyForCategory("permission")).toBe("permission");
    expect(reasonKeyForCategory("io")).toBe("io");
    expect(reasonKeyForCategory("nope")).toBe("unknown");
    expect(reasonKeyForCategory(null)).toBe("unknown");
  });
});
