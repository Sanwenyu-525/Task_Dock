// 同步协议纯函数测试：三态补丁、响应解析、冲突分类。
import { describe, expect, it } from "vitest";

import { AppError } from "../../errors";
import {
  buildPatchPayload,
  classifyConflict,
  parsePullResult,
  parsePushResult,
  type Change,
  type Op,
} from "../protocol";

describe("buildPatchPayload（三态补丁）", () => {
  it("undefined 缺失 / null 保留 / 有值写入", () => {
    const payload = buildPatchPayload({
      keep: "值",
      clear: null,
      skip: undefined,
      count: 3,
      flag: true,
      tags: ["a", "b"],
    });
    expect(payload).toEqual({ keep: "值", clear: null, count: 3, flag: true, tags: ["a", "b"] });
  });

  it("NaN/Infinity 拒绝（JSON 化会变 null，读者会误以为清空）", () => {
    expect(() => buildPatchPayload({ bad: NaN })).toThrow(AppError);
    expect(() => buildPatchPayload({ bad: Infinity })).toThrow(AppError);
  });

  it("不受支持的类型拒绝", () => {
    expect(() => buildPatchPayload({ bad: { nested: true } })).toThrow(AppError);
    expect(() => buildPatchPayload({ bad: [1, 2] })).toThrow(AppError);
  });

  it("数组只接受字符串数组并复制一份", () => {
    const tags = ["a"];
    const payload = buildPatchPayload({ tags });
    tags.push("b");
    expect(payload.tags).toEqual(["a"]);
  });
});

const change: Change = {
  entity: "task",
  id: "t-1",
  rev: 3,
  deleted: false,
  fields: { title: "x" },
  updated_at: 1,
};

describe("parsePullResult", () => {
  it("合法响应解析", () => {
    const result = parsePullResult({ cursor: "9", changes: [change] });
    expect(result.cursor).toBe("9");
    expect(result.changes).toHaveLength(1);
  });

  it("缺 cursor/changes、字段类型错误时抛 validation", () => {
    expect(() => parsePullResult({})).toThrow(AppError);
    expect(() => parsePullResult({ cursor: 1, changes: [] })).toThrow(AppError);
    expect(() => parsePullResult({ cursor: "1", changes: [{ ...change, rev: "3" }] })).toThrow(AppError);
    expect(() => parsePullResult({ cursor: "1", changes: [{ ...change, deleted: 1 }] })).toThrow(AppError);
  });
});

const op: Op = {
  op_id: "op-1",
  entity: "task",
  id: "t-1",
  base_rev: 3,
  patch: { title: "x" },
};

describe("parsePushResult 与冲突分类", () => {
  it("ack + 显式 reason 原样保留", () => {
    const result = parsePushResult(
      { ack: ["op-1"], conflicts: [{ op_id: "op-2", reason: "revision_mismatch", server_record: change }] },
      [op],
    );
    expect(result.ack).toEqual(["op-1"]);
    expect(result.conflicts[0].reason).toBe("revision_mismatch");
  });

  it("服务端缺 reason 字段时按 op 语义归类；显式 unknown 原样保留", () => {
    // 无 reason → 客户端根据 op 与服务端记录归类。
    const classified = parsePushResult(
      { ack: [], conflicts: [{ op_id: "op-1", server_record: { ...change, deleted: true } }] },
      [op],
    );
    expect(classified.conflicts[0].reason).toBe("deleted_on_server");
    // 显式 unknown 是合法枚举值：不重猜。
    const explicit = parsePushResult(
      { ack: [], conflicts: [{ op_id: "op-1", reason: "unknown", server_record: { ...change, deleted: true } }] },
      [op],
    );
    expect(explicit.conflicts[0].reason).toBe("unknown");
  });

  it("classifyConflict：缺记录/已删/版本不齐", () => {
    expect(classifyConflict(op, null)).toBe("record_missing");
    expect(classifyConflict(op, { ...change, deleted: true })).toBe("deleted_on_server");
    expect(classifyConflict(op, { ...change, rev: 9 })).toBe("revision_mismatch");
    expect(classifyConflict(op, change)).toBe("unknown");
  });

  it("非法响应抛 validation", () => {
    expect(() => parsePushResult({}, [op])).toThrow(AppError);
    expect(() => parsePushResult({ ack: [1], conflicts: [] }, [op])).toThrow(AppError);
  });
});
