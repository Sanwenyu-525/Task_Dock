//! 加入结果分类：全成功 / 部分成功 / 全失败必须有不同呈现，rejected 不能被吞掉。

import { describe, expect, it } from "vitest";
import { classifyAdd, rejectionLines, summarizeAdd } from "./addResult";
import type { TransferAddResult } from "./types";

const rejected = [{ title: "missing.txt", code: "TRANSFER_SOURCE_MISSING", message: "文件不存在" }];

function result(partial: Partial<TransferAddResult>): TransferAddResult {
  return { added: 0, duplicates: 0, rejected: [], items: [], ...partial };
}

describe("addResult", () => {
  it("全部成功", () => {
    expect(classifyAdd(result({ added: 3 }))).toBe("success");
  });

  it("部分成功：有新增也有拒绝", () => {
    expect(classifyAdd(result({ added: 2, rejected }))).toBe("partial");
    expect(classifyAdd(result({ added: 2, duplicates: 1 }))).toBe("partial");
  });

  it("全部失败：一条都没加进去", () => {
    expect(classifyAdd(result({ rejected }))).toBe("failed");
    expect(classifyAdd(result({}))).toBe("failed");
  });

  it("汇总保留完整 rejected 列表", () => {
    const summary = summarizeAdd(result({ added: 1, duplicates: 2, rejected }));
    expect(summary.outcome).toBe("partial");
    expect(summary.rejected).toHaveLength(1);
    expect(summary.empty).toBe(false);
  });

  it("失败原因列表最多 5 条并标注剩余数量", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      title: `f${i}`,
      code: "x",
      message: "拒绝",
    }));
    const lines = rejectionLines(many);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain("等 7 项");
  });
});
