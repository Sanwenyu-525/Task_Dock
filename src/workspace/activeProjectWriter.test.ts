//! P0-B 活跃项目写入队列测试（2026-11-13）。
//!
//! 覆盖：A→B、A→B→A、A 慢于 B、失败不阻塞后续、被取代的失败不再扰民、
//! 空选择清除、队列空闲语义。这些是纯队列行为，真实 DB 写入由 Rust 测试保证。

import { describe, expect, it } from "vitest";

import { createActiveProjectWriter } from "./activeProjectWriter";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("activeProjectWriter", () => {
  it("A→B：串行落库，最后一次选择最终生效", async () => {
    const calls: Array<string | null> = [];
    const gates: Deferred[] = [];
    const writer = createActiveProjectWriter((value) => {
      calls.push(value);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    });

    writer.write("A");
    writer.write("B");
    // 第一次写入在途；B 已合并排队，不会并发发出。
    expect(calls).toEqual(["A"]);
    gates[0].resolve();
    await Promise.resolve();
    expect(calls).toEqual(["A", "B"]);
    gates[1].resolve();
    await writer.idle();
    expect(calls[calls.length - 1]).toBe("B");
  });

  it("A→B→A：排队合并后只写 A、最后一次是 A", async () => {
    const calls: Array<string | null> = [];
    const gate = deferred();
    let first = true;
    const writer = createActiveProjectWriter((value) => {
      calls.push(value);
      if (first) {
        first = false;
        return gate.promise;
      }
      return Promise.resolve();
    });

    writer.write("A");
    writer.write("B");
    writer.write("A");
    gate.resolve();
    await writer.idle();
    expect(calls).toEqual(["A", "A"]);
    expect(calls[calls.length - 1]).toBe("A");
  });

  it("A 的写入失败不会阻塞 B，且被取代的失败不报告", async () => {
    const errors: Array<{ message: string; superseded: boolean }> = [];
    const first = deferred();
    const calls: Array<string | null> = [];
    const writer = createActiveProjectWriter(
      (value) => {
        calls.push(value);
        return value === "A" ? first.promise : Promise.resolve();
      },
      (e, superseded) => errors.push({ message: String(e), superseded }),
    );

    writer.write("A");
    writer.write("B");
    first.reject(new Error("A 写入失败"));
    await writer.idle();
    expect(calls).toEqual(["A", "B"]);
    // A 失败时已有 B 排队：属于被取代的失败，不打扰用户。
    expect(errors).toEqual([{ message: "Error: A 写入失败", superseded: true }]);
  });

  it("最后一次写入失败要报告（没有被更新选择取代）", async () => {
    const errors: Array<boolean> = [];
    const writer = createActiveProjectWriter(
      () => Promise.reject(new Error("磁盘写入失败")),
      (_e, superseded) => errors.push(superseded),
    );
    writer.write("B");
    await writer.idle();
    expect(errors).toEqual([false]);
  });

  it("null 是合法目标（清除活跃项目），不会被当成空操作", async () => {
    const calls: Array<string | null> = [];
    const writer = createActiveProjectWriter(async (value) => {
      calls.push(value);
    });
    writer.write("A");
    writer.write(null);
    await writer.idle();
    expect(calls).toEqual(["A", null]);
  });

  it("空闲时 idle 立即完成", async () => {
    const writer = createActiveProjectWriter(async () => {});
    await expect(writer.idle()).resolves.toBeUndefined();
    expect(writer.latest()).toBeUndefined();
  });

  it("同一时刻最多一个 IPC 写入", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const writer = createActiveProjectWriter(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
    });
    writer.write("A");
    writer.write("B");
    writer.write("C");
    await writer.idle();
    expect(maxConcurrent).toBe(1);
  });
});
