/**
 * 创建请求幂等键测试。
 *
 * 契约：同一份草案重试复用同一个 `clientRequestId`；参数变化换新 ID；成功后清空。
 */

import { describe, expect, it } from "vitest";
import {
  clearRequestIdState,
  createRequestId,
  emptyRequestIdState,
  requestSignature,
  resolveRequestId,
} from "./requestId";

describe("请求幂等键", () => {
  it("同一参数签名复用同一个请求 ID", () => {
    const first = resolveRequestId(emptyRequestIdState(), "sig-a", createRequestId);
    const second = resolveRequestId(first.state, "sig-a", createRequestId);
    expect(second.id).toBe(first.id);
  });

  it("参数签名变化时生成新的请求 ID", () => {
    const first = resolveRequestId(emptyRequestIdState(), "sig-a", createRequestId);
    const second = resolveRequestId(first.state, "sig-b", createRequestId);
    expect(second.id).not.toBe(first.id);
  });

  it("创建成功后清空请求 ID，下一次创建必然是新请求", () => {
    const first = resolveRequestId(emptyRequestIdState(), "sig-a", createRequestId);
    const cleared = clearRequestIdState();
    expect(cleared.id).toBe("");
    const next = resolveRequestId(cleared, "sig-a", createRequestId);
    expect(next.id).not.toBe(first.id);
  });

  it("参数签名忽略 clientRequestId 自身，但区分其他字段", () => {
    const base = { name: "项目", kind: "novel", phases: [{ name: "阶段" }] };
    expect(requestSignature({ ...base, clientRequestId: "r1" })).toBe(
      requestSignature({ ...base, clientRequestId: "r2" }),
    );
    expect(requestSignature(base)).not.toBe(requestSignature({ ...base, name: "另一个项目" }));
  });

  it("对象字段顺序不影响签名", () => {
    expect(requestSignature({ a: 1, b: 2 })).toBe(requestSignature({ b: 2, a: 1 }));
  });
});
