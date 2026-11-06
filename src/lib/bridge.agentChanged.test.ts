import { describe, expect, it } from "vitest";
import { normalizeAgentChangedPayload } from "./bridge";

describe("normalizeAgentChangedPayload", () => {
  it("正常批量事件原样规范化", () => {
    const payload = normalizeAgentChangedPayload({
      source_id: "codex",
      sources: ["codex"],
      session_id: "sess",
      run_id: "run",
      state: "running",
      states: { running: 1 },
      batch: 1,
      changed: true,
      deduplicated: false,
      late: false,
    });
    expect(payload?.source_id).toBe("codex");
    expect(payload?.sources).toEqual(["codex"]);
    expect(payload?.changed).toBe(true);
  });

  it("stale 单来源载荷保留 stale_cleanup", () => {
    const payload = normalizeAgentChangedPayload({
      source_id: "codex",
      sources: ["codex"],
      session_id: "sess",
      state: "disconnected",
      states: { disconnected: 1 },
      batch: 1,
      changed: true,
      deduplicated: false,
      late: false,
      stale_cleanup: 1,
    });
    expect(payload?.stale_cleanup).toBe(1);
    expect(payload?.states).toEqual({ disconnected: 1 });
  });

  it("缺少 sources 时用 source_id 兜底", () => {
    const payload = normalizeAgentChangedPayload({ source_id: "codex", changed: true });
    expect(payload?.sources).toEqual(["codex"]);
  });

  it("旧 stale 载荷规范为全局事件", () => {
    const payload = normalizeAgentChangedPayload({ stale_cleanup: 2 });
    expect(payload?.sources).toEqual([]);
    expect(payload?.changed).toBe(true);
    expect(payload?.stale_cleanup).toBe(2);
  });

  it("缺少可选字段仍为合法事件", () => {
    const payload = normalizeAgentChangedPayload({ source_id: "codex", sources: ["codex"] });
    expect(payload?.states).toEqual({});
    expect(payload?.session_id).toBe("");
    expect(payload?.changed).toBe(true);
  });

  it("changed=false 保持去重", () => {
    const payload = normalizeAgentChangedPayload({ sources: ["codex"], changed: false });
    expect(payload?.changed).toBe(false);
  });

  it.each([null, undefined, "codex", 123, [], {}, { sources: "codex" }, { source_id: 123 }])(
    "不合法载荷 %s 返回 null 且不抛错",
    (raw) => {
      expect(() => normalizeAgentChangedPayload(raw)).not.toThrow();
      expect(normalizeAgentChangedPayload(raw)).toBeNull();
    },
  );
});
