// 采集配额纯函数：数量 / 单件 / 合计上限的边界。
// 这些数字直接决定「用户选了 10 张只会进 9 张」「50MB 边界到底算不算超限」。
import { describe, expect, it } from "vitest";

import {
  MAX_CAPTURE_ITEM_BYTES,
  MAX_CAPTURE_ITEMS,
  MAX_CAPTURE_TOTAL_BYTES,
  describeQuotaRejection,
  planCaptureBatch,
  stashTotalBytes,
} from "../limits";

const MB = 1024 * 1024;

describe("planCaptureBatch 数量上限", () => {
  it("当前 0 项一次选 10 项：只接收 9 项，第 10 项以数量原因拒绝", () => {
    const plan = planCaptureBatch({
      itemCount: 0,
      usedBytes: 0,
      candidates: Array.from({ length: 10 }, (_, i) => ({ size: MB, name: `p${i}.jpg` })),
    });
    expect(plan.accepted.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]).toMatchObject({ index: 9, reason: "count" });
  });

  it("当前 7 项一次选 5 项：只接收 2 项，最终不会超过 9", () => {
    const plan = planCaptureBatch({
      itemCount: 7,
      usedBytes: 0,
      candidates: Array.from({ length: 5 }, () => ({ size: MB })),
    });
    expect(plan.accepted).toHaveLength(MAX_CAPTURE_ITEMS - 7);
    expect(plan.rejected).toHaveLength(3);
    expect(plan.rejected.every((entry) => entry.reason === "count")).toBe(true);
  });

  it("已有 8 项连续快速导入：第三批全部被数量原因拒绝（不会靠旧 state 漏算）", () => {
    const first = planCaptureBatch({ itemCount: 8, usedBytes: 0, candidates: [{ size: 1 }] });
    expect(first.accepted).toHaveLength(1);
    const second = planCaptureBatch({ itemCount: 9, usedBytes: 0, candidates: [{ size: 1 }] });
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected[0].reason).toBe("count");
  });
});

describe("planCaptureBatch 大小上限", () => {
  it("49MB 接收，50MB 边界接收，51MB 拒绝", () => {
    const base = { itemCount: 0, usedBytes: 0 };
    expect(planCaptureBatch({ ...base, candidates: [{ size: 49 * MB }] }).accepted).toHaveLength(1);
    expect(
      planCaptureBatch({ ...base, candidates: [{ size: MAX_CAPTURE_ITEM_BYTES }] }).accepted,
    ).toHaveLength(1);
    const over = planCaptureBatch({ ...base, candidates: [{ size: 51 * MB }] });
    expect(over.accepted).toHaveLength(0);
    expect(over.rejected[0].reason).toBe("item_size");
  });

  it("声明大小未知的文件不按 0 静默通过整批：仍受数量约束，真实字节交给存储层", () => {
    const plan = planCaptureBatch({
      itemCount: 0,
      usedBytes: 0,
      candidates: [{ size: null }, { size: undefined }],
    });
    expect(plan.accepted).toHaveLength(2);
    expect(plan.acceptedBytes).toBe(0);
  });

  it("合计超过 200MB 时拒绝后续项，但已接受的项不受影响", () => {
    const plan = planCaptureBatch({
      itemCount: 3,
      usedBytes: 150 * MB,
      candidates: [{ size: 50 * MB }, { size: 1 * MB }],
    });
    expect(plan.accepted.map((entry) => entry.index)).toEqual([0]);
    expect(plan.rejected[0]).toMatchObject({ index: 1, reason: "total_size" });
    expect(plan.acceptedBytes).toBe(MAX_CAPTURE_TOTAL_BYTES);
  });

  it("混合成功、失败、超限：逐项给出原因，顺序稳定", () => {
    const plan = planCaptureBatch({
      itemCount: 6,
      usedBytes: 190 * MB,
      candidates: [
        { size: 1 * MB, name: "ok.jpg" },
        { size: 60 * MB, name: "big.pdf" },
        { size: 20 * MB, name: "total.jpg" },
        { size: 1 * MB, name: "second-ok.jpg" },
      ],
    });
    // 0 与 3 都在名额与额度内（190+1+1=192 ≤ 200）；1 单件超限；2 合计超限
    expect(plan.accepted.map((entry) => entry.index)).toEqual([0, 3]);
    expect(plan.rejected.map((entry) => [entry.index, entry.reason])).toEqual([
      [1, "item_size"],
      [2, "total_size"],
    ]);
  });

  it("数量上限优先于大小判定：满额后每个候选只报数量原因", () => {
    const plan = planCaptureBatch({
      itemCount: 9,
      usedBytes: 0,
      candidates: [{ size: 60 * MB }, { size: 1 * MB }],
    });
    expect(plan.rejected.map((entry) => entry.reason)).toEqual(["count", "count"]);
  });
});

describe("配额说明与合计", () => {
  it("每种拒绝原因都有可读文案", () => {
    expect(describeQuotaRejection("count")).toContain("9");
    expect(describeQuotaRejection("item_size")).toContain("50MB");
    expect(describeQuotaRejection("total_size")).toContain("200MB");
  });

  it("stashTotalBytes 忽略非法 size，避免 NaN 污染合计判定", () => {
    expect(stashTotalBytes([{ size: 1024 }, { size: Number.NaN }, { size: -5 }])).toBe(1024);
  });
});
