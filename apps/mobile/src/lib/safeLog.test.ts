// SafeLog JS 入口单测：级别过滤、脱敏、metadata 白名单、缓冲上限、原生降级。
// 不触达真实原生模块（sink 注入替身），与 vitest 的 expo-modules-core mock 一致。
import { describe, expect, it } from "vitest";

import { createSafeLog, type SafeLogEntry, type SafeLogMetadata, type SafeLogSink } from "./safeLog";

interface Recording {
  entries: Array<{ level: string; tag: string; message: string; metadataJson: string | null }>;
  flushCalls: number;
  failWrite: boolean;
}

function recordingSink(failWrite = false): { sink: SafeLogSink; rec: Recording } {
  const rec: Recording = { entries: [], flushCalls: 0, failWrite };
  const sink: SafeLogSink = {
    write(level, tag, message, metadataJson) {
      if (rec.failWrite) throw new Error("bridge broken");
      rec.entries.push({ level, tag, message, metadataJson });
    },
    async flush() {
      rec.flushCalls += 1;
      return true;
    },
  };
  return { sink, rec };
}

function parseMetadata(entry: { metadataJson: string | null }): Record<string, unknown> | null {
  return entry.metadataJson ? (JSON.parse(entry.metadataJson) as Record<string, unknown>) : null;
}

describe("createSafeLog 级别过滤", () => {
  it("默认 info 及以上才记录：trace/debug 被丢弃", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });

    log.trace("sync", "t");
    log.debug("sync", "d");
    log.info("sync", "i");
    log.warn("sync", "w");
    log.error("sync", "e");

    expect(rec.entries.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
    expect(log.getBuffer().map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
  });

  it("setMinLevel('trace') 放开全部级别；默认阈值下 flush 仍可用", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });
    log.setMinLevel("trace");

    log.trace("sync", "t");
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0].level).toBe("trace");
  });
});

describe("createSafeLog 脱敏", () => {
  it("消息中的 token/密钥/路径被脱敏，16 位 traceId 保留", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });

    log.warn(
      "sync",
      [
        "Authorization: Bearer abcdef01",
        "token=abcdef0123456789abcdef0123456789",
        "password:hunter2",
        "key=sk-abcdef1234567890",
        "C:\\Users\\ASUS\\secret.txt",
        "file:///data/0/secret",
        "/data/user/0/dev.taskdock/files/x",
        "trace abcdef0123456789 ok",
      ].join("\n"),
    );

    const message = rec.entries[0].message;
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("C:\\");
    expect(message).not.toContain("file://");
    expect(message).not.toContain("/data/user");
    expect(message).toContain("[redacted]");
    expect(message).toContain("[path]");
    // 16 位 traceId（同步链路关联 ID）不属于密钥形态，必须保留。
    expect(message).toContain("abcdef0123456789");
    // 单行化：换行被折叠。
    expect(message).not.toContain("\n");
  });

  it("规则对照矩阵：与 Kotlin SafeLogTest 同一组输入 → 同一组期望（改一处必须同步另一处）", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });

    // 与 SafeLogTest.kt 的 `message redaction mirrors JS rule matrix` 输入/断言一一对应；
    // 修改任一正则必须双侧同步（safeLog.ts REDACT_RULES ↔ SafeLog.kt RULES）。
    const raw = [
      "Authorization: Bearer abcdef0123456789abcdef0123456789",
      "token=abcdef0123456789abcdef0123456789",
      "password:hunter2",
      "secret=topsecretvalue",
      "apikey=abcd1234efgh5678",
      "api_key=abcd1234",
      "api-key=abcd1234",
      "key=sk-abcdef1234567890",
      "https://host/path?key=querysecret&auth=authtok&sig=sigval123",
      "contact alice@example.com here",
      "C:\\Users\\ASUS\\secret.txt",
      "file:///data/0/secret",
      "/data/user/0/dev.taskdock/files/x",
      "trace abcdef0123456789 ok",
      "hex deadbeefdeadbeefdeadbeefdeadbeef done",
    ].join("\n");
    log.warn("sync", raw);

    const message = rec.entries[0].message;
    // 单行化：换行被折叠。
    expect(message).not.toContain("\n");
    // 凭据/邮箱/密钥/路径原值不得残留。
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("topsecretvalue");
    expect(message).not.toContain("abcd1234efgh5678");
    expect(message).not.toContain("querysecret");
    expect(message).not.toContain("authtok");
    expect(message).not.toContain("sigval123");
    expect(message).not.toContain("alice@example.com");
    expect(message).not.toContain("C:\\");
    expect(message).not.toContain("file://");
    expect(message).not.toContain("/data/user");
    expect(message).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
    expect(message).not.toContain("sk-abcdef1234567890");
    // 替换标记保留。
    expect(message).toContain("[redacted]");
    expect(message).toContain("[path]");
    // 16 位 traceId 不属于密钥形态，必须保留。
    expect(message).toContain("abcdef0123456789");
  });

  it("超长消息截断到 200 字符", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });
    log.info("app", "x".repeat(300));
    expect(rec.entries[0].message.length).toBeLessThanOrEqual(201);
    expect(rec.entries[0].message.endsWith("…")).toBe(true);
  });

  it("tag 稳定化：大小写与非法字符归一为 slug", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });
    log.info("Device Identity!!", "hello");
    expect(rec.entries[0].tag).toBe("device-identity");
  });
});

describe("createSafeLog metadata 白名单", () => {
  it("只保留基本值字段：字符串截断、非有限数归 null、对象/数组丢弃、键数与键长受限", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });

    const longKey = "k".repeat(64);
    const keyA = "a".repeat(40);
    // 故意传入非白名单值（undefined/nested/list）：运行时必须丢弃它们，类型上用断言绕过。
    const messy = {
      [longKey]: "v",
      [keyA]: "value",
      kind: "image",
      bytes: 2048,
      durationMs: Number.POSITIVE_INFINITY,
      ok: true,
      empty: null,
      skipped: undefined,
      nested: { inner: "no" },
      list: ["no"],
      path: "C:\\Users\\ASUS\\a.jpg",
      a1: "1",
      a2: "2",
      a3: "3",
      a4: "4",
      a5: "5",
      a6: "6",
    } as unknown as SafeLogMetadata;
    log.warn("sync", "结果", messy);

    const metadata = parseMetadata(rec.entries[0]);
    expect(metadata).not.toBeNull();
    // 键数上限 8（先到先得，其余丢弃）。
    expect(Object.keys(metadata as Record<string, unknown>)).toHaveLength(8);
    // 键长截断到 32。
    expect((metadata as Record<string, unknown>)[keyA.slice(0, 32)]).toBe("value");
    expect((metadata as Record<string, unknown>)[longKey]).toBeUndefined();
    expect(metadata?.kind).toBe("image");
    expect(metadata?.bytes).toBe(2048);
    expect(metadata?.durationMs).toBeNull();
    expect(metadata?.ok).toBe(true);
    expect(metadata?.empty).toBeNull();
    expect(metadata?.nested).toBeUndefined();
    expect(metadata?.list).toBeUndefined();
    // 字符串值走脱敏：路径变 [path]。
    expect(metadata?.path).toBe("[path]");
  });

  it("键名本身是凭据类别时，值一律脱敏", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });
    log.warn("sync", "结果", {
      password: "P@ssw0rd",
      token: "abc123",
      api_key: "raw-api-key",
      key: 123456,
      authorization: "Bearer secret",
      note: "password:hunter2",
    } as unknown as SafeLogMetadata);

    const metadata = parseMetadata(rec.entries[0]);
    expect(metadata?.password).toBe("[redacted]");
    expect(metadata?.token).toBe("[redacted]");
    expect(metadata?.api_key).toBe("[redacted]");
    expect(metadata?.key).toBe("[redacted]");
    expect(metadata?.authorization).toBe("[redacted]");
    expect(metadata?.note).toBe("[redacted]");
  });

  it("空 metadata / 全丢弃时 sink 收到 null", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });
    log.info("sync", "只有不可记录字段", { nested: { a: 1 } } as unknown as SafeLogMetadata);
    expect(rec.entries[0].metadataJson).toBeNull();
  });
});

describe("createSafeLog 缓冲与降级", () => {
  it("内存缓冲按上限滚动：只保留最新 500 条", () => {
    const log = createSafeLog({ sink: null, now: () => 1000, bufferLimit: 500 });
    for (let index = 0; index < 505; index += 1) {
      log.info("sync", `msg-${index}`);
    }
    const buffer = log.getBuffer();
    expect(buffer).toHaveLength(500);
    expect(buffer[0].message).toBe("msg-5");
    expect(buffer[499].message).toBe("msg-504");
  });

  it("sink 为 null（原生不可用）时静默降级：不抛错、缓冲仍写入", async () => {
    const log = createSafeLog({ sink: null, now: () => 1000 });
    expect(() => log.error("app", "boom")).not.toThrow();
    expect(log.getBuffer()).toHaveLength(1);
    await expect(log.flush()).resolves.toBe(true);
  });

  it("sink.write 抛错时静默降级：业务不受影响", () => {
    const { sink } = recordingSink(true);
    const log = createSafeLog({ sink, now: () => 1000 });
    expect(() => log.error("app", "boom", { code: 1 })).not.toThrow();
    expect(log.getBuffer()).toHaveLength(1);
  });

  it("flush 转发原生并永不 reject：失败返回 false", async () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 1000 });
    await expect(log.flush()).resolves.toBe(true);
    expect(rec.flushCalls).toBe(1);

    const failing = createSafeLog({
      sink: { write: () => undefined, flush: () => Promise.reject(new Error("io")) },
    });
    await expect(failing.flush()).resolves.toBe(false);
  });

  it("时间与 metadataJson 契约：now 注入生效、metadata 可被 JSON 反解", () => {
    const { sink, rec } = recordingSink();
    const log = createSafeLog({ sink, now: () => 12345 });
    const entries = log.getBuffer();
    log.info("sync", "链路", { traceId: "abcdef0123456789" });
    expect((entries[0] as SafeLogEntry).t).toBe(12345);
    expect(parseMetadata(rec.entries[0])).toEqual({ traceId: "abcdef0123456789" });
  });
});
