// traceId 契约单测（日志二期 M4 移动端部分）：桌面端下发/回传的可选 traceId
// 必须原样解析；移动端不生成、不校验语义；旧响应（无该字段）完全兼容。
import { describe, expect, it } from "vitest";

import { parsePullResult, parsePushResult, type Op } from "../protocol";

const VALID_TRACE = "abcdef0123456789";

function makeChange() {
  return {
    entity: "task",
    id: "t1",
    rev: 1,
    deleted: false,
    fields: { title: "x" },
    updated_at: 1,
  };
}

describe("parsePullResult traceId 透传", () => {
  it("响应带 traceId 时原样解析", () => {
    const result = parsePullResult({ cursor: "1", changes: [makeChange()], traceId: VALID_TRACE });
    expect(result.traceId).toBe(VALID_TRACE);
  });

  it("旧响应没有 traceId 字段：解析成功且值为 undefined（向后兼容）", () => {
    const result = parsePullResult({ cursor: "1", changes: [makeChange()] });
    expect(result.traceId).toBeUndefined();
  });

  it("traceId 不是字符串或为空串：丢弃，不报错", () => {
    expect(parsePullResult({ cursor: "1", changes: [], traceId: 12345 }).traceId).toBeUndefined();
    expect(parsePullResult({ cursor: "1", changes: [], traceId: "" }).traceId).toBeUndefined();
    expect(parsePullResult({ cursor: "1", changes: [], traceId: null }).traceId).toBeUndefined();
    // 语义不做校验：非法形态也原样透传（16-hex 由桌面端入队兜底）。
    expect(parsePullResult({ cursor: "1", changes: [], traceId: "not-hex" }).traceId).toBe("not-hex");
  });
});

describe("parsePushResult traceId 回传", () => {
  const ops: Op[] = [{ op_id: "o1", entity: "task", id: "t1", base_rev: 1, patch: { title: "x" } }];

  it("桌面端回传的 traceId 原样解析", () => {
    const result = parsePushResult({ ack: ["o1"], conflicts: [], traceId: VALID_TRACE }, ops);
    expect(result.traceId).toBe(VALID_TRACE);
  });

  it("无 traceId 时缺省；空串按缺省处理", () => {
    expect(parsePushResult({ ack: [], conflicts: [] }, ops).traceId).toBeUndefined();
    expect(parsePushResult({ ack: [], conflicts: [], traceId: "" }, ops).traceId).toBeUndefined();
  });
});
