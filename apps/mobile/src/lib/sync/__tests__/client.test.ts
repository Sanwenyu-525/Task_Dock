// 同步客户端测试：fetchImpl 注入、超时、退避重试、取消、加密信封链路。
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../errors";
import { deriveSyncKey, encryptEnvelope, decryptEnvelope } from "../crypto";
import { AAD_PULL, AAD_PUSH } from "../crypto";
import { createSyncClient, type FetchLike, type HttpResponseLike } from "../client";
import type { PullResult } from "../protocol";

const TOKEN = "a".repeat(64);
const PULL_PAGE: PullResult = {
  cursor: "7",
  changes: [
    { entity: "task", id: "t-1", rev: 7, deleted: false, fields: { title: "x" }, updated_at: 1 },
  ],
};

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("createSyncClient（注入 fetchImpl）", () => {
  it("pull 发送 Bearer 与游标，解密 pull 响应", async () => {
    const key = await deriveSyncKey(TOKEN);
    const envelope = encryptEnvelope(key, AAD_PULL, PULL_PAGE);
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init: { ...init } });
      return jsonResponse(200, envelope);
    };
    const client = createSyncClient({
      baseUrl: "https://192.168.1.10:47822",
      token: TOKEN,
      deviceId: "device-1",
      syncKey: key,
      fetchImpl,
    });
    const page = await client.pull("3", 100);
    expect(page.cursor).toBe("7");
    expect(page.changes[0].id).toBe("t-1");
    expect(calls[0].url).toBe("https://192.168.1.10:47822/v1/changes?since=3&limit=100");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("push 加密信封上传，响应解密回 PushResult", async () => {
    const key = await deriveSyncKey(TOKEN);
    const ops = [{ op_id: "op-1", entity: "task" as const, id: "t-1", base_rev: 1, patch: { title: "x" } }];
    let sentBody = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      sentBody = init.body ?? "";
      return jsonResponse(200, encryptEnvelope(key, AAD_PUSH, { ack: ["op-1"], conflicts: [] }));
    };
    const client = createSyncClient({
      baseUrl: "https://host",
      token: TOKEN,
      deviceId: "device-1",
      syncKey: key,
      fetchImpl,
    });
    const result = await client.push(ops);
    expect(result.ack).toEqual(["op-1"]);
    // 请求体必须是加密信封：不含明文字段。
    expect(sentBody).not.toContain('"title"');
    const decrypted = decryptEnvelope(key, AAD_PUSH, JSON.parse(sentBody));
    expect((decrypted as { ops: unknown[] }).ops).toHaveLength(1);
  });

  it("空 push 队列不发请求", async () => {
    let called = 0;
    const fetchImpl: FetchLike = async () => {
      called += 1;
      return jsonResponse(200, {});
    };
    const client = createSyncClient({ baseUrl: "https://host", token: TOKEN, fetchImpl });
    await client.push([]);
    expect(called).toBe(0);
  });

  it("401 不重试，直接抛出（错误里带状态码）", async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return jsonResponse(401, { error: "unauthorized" });
    };
    const client = createSyncClient({ baseUrl: "https://host", token: TOKEN, fetchImpl });
    const failure = await client.pull("0").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError & { cause: { status: number } }).cause).toMatchObject({ status: 401 });
    expect(attempts).toBe(1);
  });

  it("500 按退避重试后成功", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fetchImpl: FetchLike = async () => {
        attempts += 1;
        if (attempts < 3) return jsonResponse(500, {});
        return jsonResponse(200, PULL_PAGE);
      };
      const client = createSyncClient({ baseUrl: "https://host", token: TOKEN, fetchImpl });
      const pending = client.pull("0");
      // 两次重试间隔 1s + 2s：推进假时钟让 sleep 结束。
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(2_500);
      const page = await pending;
      expect(page.cursor).toBe("7");
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("请求超时映射为 network 错误（可重试，最终仍失败）", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      const client = createSyncClient({ baseUrl: "https://host", token: TOKEN, fetchImpl });
      const pending = client.pull("0");
      const assertion = expect(pending).rejects.toBeInstanceOf(AppError);
      // 超时 5s × 7 次尝试 + 全部退避 ≈ 35s+；一次推完假时钟让整个重试链结束。
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() 立即中止在途请求与退避", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fetchImpl: FetchLike = async () => {
        attempts += 1;
        return jsonResponse(500, {});
      };
      const client = createSyncClient({ baseUrl: "https://host", token: TOKEN, fetchImpl });
      const pending = client.pull("0");
      const assertion = expect(pending).rejects.toMatchObject({ kind: "network" });
      client.cancel();
      await assertion;
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("参数校验：空地址 / 空令牌抛 validation", () => {
    expect(() => createSyncClient({ baseUrl: "", token: TOKEN })).toThrow(AppError);
    expect(() => createSyncClient({ baseUrl: "https://host", token: "" })).toThrow(AppError);
  });
});
