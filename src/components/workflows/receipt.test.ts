//! 场景回执解析：容错（null/非法 JSON/缺字段绝不 throw）与旧结构兼容。

import { describe, expect, it } from "vitest";
import {
  parseSceneReceipt,
  sceneItemStatusLabel,
  sceneItemStatusKind,
} from "./receipt";

const fullReceipt = {
  summary: "场景「晨间」完成 2/3 项（失败 1）",
  scene_id: "sid",
  scene_name: "晨间",
  total: 3,
  processed: 2,
  cancelled: false,
  timed_out: false,
  outcome: "partial",
  items: [
    { index: 1, kind: "app", label: "记事本", status: "ok", detail: null },
    { index: 2, kind: "folder", label: "C:\\不存在", status: "failed", detail: "目录不存在" },
  ],
};

describe("parseSceneReceipt", () => {
  it("解析完整回执：逐项 label/status/detail 与汇总", () => {
    const r = parseSceneReceipt(JSON.stringify(fullReceipt));
    expect(r).not.toBeNull();
    expect(r!.outcome).toBe("partial");
    expect(r!.summary).toContain("失败 1");
    expect(r!.scene_name).toBe("晨间");
    expect(r!.total).toBe(3);
    expect(r!.processed).toBe(2);
    expect(r!.items).toHaveLength(2);
    expect(r!.items[0]).toMatchObject({
      index: 1,
      kind: "app",
      label: "记事本",
      status: "ok",
      detail: null,
    });
    expect(r!.items[1].detail).toBe("目录不存在");
  });

  it("null / 空串 / 非法 JSON / 非对象 / 缺 items 都返回 null，绝不 throw", () => {
    for (const bad of [null, "", "   ", "not-json", "null", "42", '"str"', '{"summary":"无items"}']) {
      expect(parseSceneReceipt(bad as string | null)).toBeNull();
    }
  });

  it("兼容旧结构：无 label 回退 kind #index，detail 为空，outcome 由状态推导", () => {
    const legacy = JSON.stringify({
      summary: "场景「old」已完成 1 项",
      items: [{ index: 1, kind: "app", status: "ok" }],
    });
    const r = parseSceneReceipt(legacy)!;
    expect(r.outcome).toBe("completed");
    expect(r.items[0].label).toBe("app #1");
    expect(r.items[0].detail).toBeNull();
    expect(r.scene_name).toBeNull();
    expect(r.total).toBe(1);
  });

  it("items 内残缺条目跳过；未执行项（cancelled）不伪造", () => {
    const cancelled = JSON.stringify({
      summary: "场景「s」已取消：已处理 1/4 项，剩余 3 项未执行",
      scene_id: "sid",
      scene_name: "s",
      total: 4,
      processed: 1,
      cancelled: true,
      timed_out: false,
      outcome: "cancelled",
      items: [{ index: 1, kind: "app", label: "记事本", status: "ok", detail: null }],
    });
    const r = parseSceneReceipt(cancelled)!;
    expect(r.outcome).toBe("cancelled");
    expect(r.cancelled).toBe(true);
    // 未执行项不得出现在 items
    expect(r.items).toHaveLength(1);

    const broken = JSON.stringify({
      outcome: "completed",
      items: ["垃圾", null, { kind: "url", status: "ok" }],
    });
    const r2 = parseSceneReceipt(broken)!;
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0].label).toBe("url #3");
  });

  it("未知状态原样透出，展示函数兜底", () => {
    const r = parseSceneReceipt(
      JSON.stringify({ outcome: "completed", items: [{ index: 1, kind: "app", status: "mystery" }] }),
    )!;
    expect(r.items[0].status).toBe("mystery");
    expect(sceneItemStatusLabel("mystery")).toBe("mystery");
    expect(sceneItemStatusKind("mystery")).toBe("muted");
  });
});

describe("scene item 展示映射", () => {
  it("状态文案与语义色 kind", () => {
    expect(sceneItemStatusLabel("ok")).toBe("成功");
    expect(sceneItemStatusLabel("skipped")).toBe("已跳过");
    expect(sceneItemStatusLabel("failed")).toBe("失败");
    expect(sceneItemStatusKind("ok")).toBe("success");
    expect(sceneItemStatusKind("failed")).toBe("danger");
    expect(sceneItemStatusKind("skipped")).toBe("muted");
  });
});
