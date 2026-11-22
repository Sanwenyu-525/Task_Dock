// 生活页请求代际：快速切换详情时，旧响应（成功/失败/finally）不得写新状态。
import { describe, expect, it } from "vitest";

import { createRequestGeneration } from "../requestGeneration";

describe("生活页请求代际", () => {
  it("只有最新一次请求可以写状态", () => {
    const generation = createRequestGeneration();
    const first = generation.next();
    const second = generation.next();
    expect(first).not.toBe(second);
    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(true);
  });

  it("旧请求晚返回（成功或失败）不覆盖新详情", async () => {
    const generation = createRequestGeneration();
    const apply = (seq: number, value: string | null) =>
      generation.isCurrent(seq) ? value : null;

    const open = async (id: string, fail: boolean) => {
      const seq = generation.next();
      try {
        const value = fail
          ? await Promise.reject(new Error("旧请求失败"))
          : await Promise.resolve(id);
        return apply(seq, value);
      } catch {
        // 旧请求失败同样必须被丢弃，不能关闭后来打开的详情。
        return apply(seq, null);
      }
    };

    const old = open("旧详情", true);
    const current = open("新详情", false);
    expect(await current).toBe("新详情");
    expect(await old).toBeNull();
  });

  it("旧请求 finally 不清掉新请求的 loading", () => {
    const generation = createRequestGeneration();
    let loading = false;
    const start = () => {
      const seq = generation.next();
      loading = true;
      return () => {
        if (generation.isCurrent(seq)) loading = false;
      };
    };
    const finishOld = start();
    start(); // 新请求还在进行
    finishOld();
    expect(loading).toBe(true);
  });

  it("不同页面/用途的代际互不干扰", () => {
    const detail = createRequestGeneration();
    const refresh = createRequestGeneration();
    const detailSeq = detail.next();
    const refreshSeq = refresh.next();
    expect(detail.isCurrent(detailSeq)).toBe(true);
    expect(refresh.isCurrent(refreshSeq)).toBe(true);
    detail.next();
    expect(detail.isCurrent(detailSeq)).toBe(false);
    expect(refresh.isCurrent(refreshSeq)).toBe(true);
  });
});
