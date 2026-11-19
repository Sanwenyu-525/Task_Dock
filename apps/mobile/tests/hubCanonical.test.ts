// 契约 §1/§5：canonical JSON 必须与云端逐字节一致。
// 固定向量直接来自 docs/personal-hub/P3-SHARED-CONTRACT.md §5，并由云端 node:crypto
// 实现验证过；任何键序/空白/转义差异都会在这里失败，而不是等真机配对时才暴露。
import { describe, expect, it } from "vitest";

import { canonicalStringify, signablePayload } from "../src/lib/hub/canonical";

describe("canonicalStringify", () => {
  it("匹配契约 §5 的固定向量", () => {
    const input = { b: 1, a: "x", nested: { z: true, y: [3, 2, 1] } };
    expect(canonicalStringify(input)).toBe(
      '{"a":"x","b":1,"nested":{"y":[3,2,1],"z":true}}',
    );
  });

  it("对象键按字典序、数组保序", () => {
    expect(canonicalStringify([{ b: 2, a: 1 }, 3])).toBe('[{"a":1,"b":2},3]');
    expect(canonicalStringify({ z: [2, 1], a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"z":[2,1]}',
    );
  });

  it("剔除对象里的 undefined，保留 null", () => {
    expect(canonicalStringify({ b: undefined, a: 1, c: null })).toBe('{"a":1,"c":null}');
    // 数组里的 undefined 与 JSON.stringify 一致，序列化为 null。
    expect(canonicalStringify([undefined, 1])).toBe("[null,1]");
  });

  it("与云端对同一 body 生成完全相同的 UTF-8 字节", () => {
    const value = { deviceId: "a", identityFingerprint: "b", nested: { y: [1, 2] } };
    const bytes = Buffer.from(canonicalStringify(value), "utf8");
    expect(bytes.toString("hex")).toBe(
      Buffer.from(
        '{"deviceId":"a","identityFingerprint":"b","nested":{"y":[1,2]}}',
        "utf8",
      ).toString("hex"),
    );
  });

  it("signablePayload 只剔除签名，其余字段保持 canonical", () => {
    expect(
      signablePayload({
        signature: "ignored",
        timestamp: "2026-11-19T04:05:06.000Z",
        nonce: "n",
        deviceId: "d",
      }),
    ).toBe('{"deviceId":"d","nonce":"n","timestamp":"2026-11-19T04:05:06.000Z"}');
  });
});
