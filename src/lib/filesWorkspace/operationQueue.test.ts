//! 文件操作队列：真实状态收敛、上限、部分失败与“不可取消”契约。

import { describe, expect, it } from "vitest";
import {
  QUEUE_CANCEL_SUPPORTED,
  finishQueueOperation,
  getQueueEntries,
  startQueueOperation,
  withFileOperationSlot,
} from "./operationQueue";

describe("operationQueue", () => {
  it("running 阶段不伪造完成数，结束后写入真实报告", () => {
    startQueueOperation({ id: "op-1", effect: "copy", total: 10 });
    let entry = getQueueEntries().find((item) => item.id === "op-1");
    expect(entry?.status).toBe("running");
    expect(entry?.ok).toBe(0);
    finishQueueOperation("op-1", { ok: 6, failed: 2, skipped: 1, partial: 1 });
    entry = getQueueEntries().find((item) => item.id === "op-1");
    expect(entry).toMatchObject({ status: "done", ok: 6, failed: 2, skipped: 1, partial: 1 });
  });

  it("异常结束标记 failed 并保留错误", () => {
    startQueueOperation({ id: "op-2", effect: "move", total: 3 });
    finishQueueOperation("op-2", null, "权限不足");
    expect(getQueueEntries().find((item) => item.id === "op-2")).toMatchObject({
      status: "failed",
      error: "权限不足",
    });
  });

  it("最多保留 8 条", () => {
    for (let index = 0; index < 12; index += 1) {
      startQueueOperation({ id: `limit-${index}`, effect: "copy", total: 1 });
      finishQueueOperation(`limit-${index}`, { ok: 1, failed: 0, skipped: 0, partial: 0 });
    }
    expect(getQueueEntries().length).toBeLessThanOrEqual(8);
  });

  it("后端无安全取消通道，UI 不得伪装取消", () => {
    expect(QUEUE_CANCEL_SUPPORTED).toBe(false);
  });

  it("真实文件 IPC 并发上限为 1，后来的操作排队而不是同时占磁盘", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const run = async (wait: Promise<void>) =>
      withFileOperationSlot(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await wait;
        active -= 1;
      });
    const first = run(firstGate);
    const second = run(Promise.resolve());
    await Promise.resolve();
    expect(active).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });
});
