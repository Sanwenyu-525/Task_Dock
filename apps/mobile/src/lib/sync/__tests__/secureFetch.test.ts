// secureFetch 注入链路测试：https 强制、pin 透传、取消映射、响应适配、TOFU 读取。
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../errors";
import {
  createLazyPinnedFetch,
  createSecureFetch,
  lastObservedServerFingerprint,
  type SecureHttpNative,
} from "../secureFetch";

function fakeNative(overrides: Partial<SecureHttpNative> = {}): SecureHttpNative & {
  requests: Array<Record<string, unknown>>;
} {
  const requests: Array<Record<string, unknown>> = [];
  return {
    requests,
    request: vi.fn(async (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
      timeoutMs: number;
      pin: string | null;
      requestId: number;
    }) => {
      requests.push({ ...options });
      return { status: 200, body: JSON.stringify({ ok: true }), observedFingerprint: null };
    }),
    cancel: vi.fn(),
    lastServerFingerprint: null,
    ...overrides,
  };
}

describe("createSecureFetch", () => {
  it("把原生结果适配成 HttpResponseLike（ok/status/json）", async () => {
    const native = fakeNative();
    const fetchImpl = createSecureFetch({ pin: "a".repeat(64) }, native);
    const response = await fetchImpl("https://192.168.1.10:47822/v1/ping", { method: "GET" });
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("4xx/5xx 映射为 ok=false，body 原样可读", async () => {
    const native = fakeNative({
      request: async () => ({ status: 401, body: '{"error":"unauthorized"}', observedFingerprint: null }),
    });
    const response = await createSecureFetch({}, native)("https://host/v1/ping", {});
    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("拒绝 http:// URL（v1 遗留连接在客户端即被拦截，不再触网）", async () => {
    const native = fakeNative();
    const fetchImpl = createSecureFetch({}, native);
    await expect(fetchImpl("http://192.168.1.10:47822/v1/ping", {})).rejects.toMatchObject({
      kind: "validation",
    });
    expect(native.request).not.toHaveBeenCalled();
  });

  it("pin 原样传给原生层；空 pin 传 null", async () => {
    const pinned = fakeNative();
    await createSecureFetch({ pin: "A".repeat(64) }, pinned)("https://host/x", {});
    expect((pinned.requests[0] as { pin: string }).pin).toBe("a".repeat(64));

    const unpinned = fakeNative();
    await createSecureFetch({}, unpinned)("https://host/x", {});
    expect((unpinned.requests[0] as { pin: string | null }).pin).toBeNull();
  });

  it("非法 pin 在工厂即抛 validation（不触网）", () => {
    const native = fakeNative();
    expect(() => createSecureFetch({ pin: "短" }, native)).toThrow(AppError);
    expect(native.request).not.toHaveBeenCalled();
  });

  it("已 abort 的 signal 不发请求", async () => {
    const native = fakeNative();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createSecureFetch({}, native)("https://host/x", { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(native.request).not.toHaveBeenCalled();
  });

  it("signal 取消会调用原生 cancel(requestId)", async () => {
    const native = fakeNative({
      request: (_options) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("cancelled")), 50);
        }),
    });
    const controller = new AbortController();
    const pending = createSecureFetch({}, native)("https://host/x", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "network" });
    expect(native.cancel).toHaveBeenCalled();
  });

  it("请求头只透传字符串值", async () => {
    const native = fakeNative();
    await createSecureFetch({}, native)("https://host/x", {
      method: "POST",
      headers: { Authorization: "Bearer abc", "Content-Type": "application/json" },
      body: "{}",
    });
    const sent = native.requests[0] as { headers: Record<string, string>; body: string };
    expect(sent.headers).toEqual({ Authorization: "Bearer abc", "Content-Type": "application/json" });
    expect(sent.body).toBe("{}");
  });
});

describe("createLazyPinnedFetch", () => {
  it("首次请求解析 pin 并缓存（loadPin 只调用一次）", async () => {
    const native = fakeNative();
    const loadPin = vi.fn(async () => "b".repeat(64));
    const fetchImpl = createLazyPinnedFetch(loadPin, native);
    await fetchImpl("https://host/a", {});
    await fetchImpl("https://host/b", {});
    expect(loadPin).toHaveBeenCalledTimes(1);
    expect((native.requests[0] as { pin: string }).pin).toBe("b".repeat(64));
    expect((native.requests[1] as { pin: string }).pin).toBe("b".repeat(64));
  });

  it("loadPin 失败时缓存失效：下次请求会重试解析", async () => {
    const native = fakeNative();
    let attempts = 0;
    const loadPin = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("db closed");
      return "c".repeat(64);
    });
    const fetchImpl = createLazyPinnedFetch(loadPin, native);
    await expect(fetchImpl("https://host/a", {})).rejects.toBeInstanceOf(AppError);
    await expect(fetchImpl("https://host/a", {})).resolves.toMatchObject({ status: 200 });
    expect(attempts).toBe(2);
  });
});

describe("lastObservedServerFingerprint", () => {
  it("读取原生层观察到的指纹（TOFU 落库用）", () => {
    const native = fakeNative({ lastServerFingerprint: "d".repeat(64) });
    expect(lastObservedServerFingerprint(native)).toBe("d".repeat(64));
  });

  it("无原生模块时返回 null 而不是抛错", () => {
    expect(lastObservedServerFingerprint(null)).toBeNull();
  });
});
