import { describe, expect, it } from "vitest";
import { summarizeWorkspace, type ItemState } from "./workspace";

const ok = (): ItemState => ({ phase: "done", success: true });
const bad = (): ItemState => ({ phase: "done", success: false });
const skip = (): ItemState => ({ phase: "skipped" });
const run = (): ItemState => ({ phase: "running" });
const wait = (): ItemState => ({ phase: "pending" });

describe("summarizeWorkspace", () => {
  it("全部成功时才算全部成功", () => {
    const s = summarizeWorkspace([ok(), ok(), ok()], 3, false);
    expect(s).toMatchObject({ ok: 3, failed: 0, skipped: 0, tone: "ok" });
    expect(s.text).toBe("全部成功（3/3）");
  });

  it("取消掉的目标不得被算成成功（回归：旧实现显示 2/3 全成功）", () => {
    const s = summarizeWorkspace([ok(), ok(), skip()], 3, false);
    expect(s.ok).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.tone).toBe("warn");
    expect(s.text).toContain("部分成功");
    expect(s.text).toContain("1 已取消");
    expect(s.text).not.toContain("全部成功");
  });

  it("部分成功：成功与失败都要报出来", () => {
    const s = summarizeWorkspace([ok(), bad(), bad()], 3, false);
    expect(s).toMatchObject({ ok: 1, failed: 2, tone: "warn" });
    expect(s.text).toBe("部分成功：1 成功 · 2 失败");
  });

  it("全部失败", () => {
    const s = summarizeWorkspace([bad(), bad()], 2, false);
    expect(s).toMatchObject({ ok: 0, failed: 2, tone: "bad" });
    expect(s.text).toBe("全部失败（2 个目标）");
  });

  it("全部失败且部分取消", () => {
    const s = summarizeWorkspace([bad(), skip()], 2, false);
    expect(s.tone).toBe("bad");
    expect(s.text).toBe("全部失败：1 个失败 · 1 个已取消");
  });

  it("一个都没跑就被取消：不得报成功", () => {
    const s = summarizeWorkspace([skip(), skip()], 2, false);
    expect(s).toMatchObject({ ok: 0, failed: 0, skipped: 2, tone: "warn" });
    expect(s.text).toBe("已取消（2 个目标未执行）");
  });

  it("运行中不给结论", () => {
    const s = summarizeWorkspace([ok(), run(), wait()], 3, true);
    expect(s.text).toBeNull();
    expect(s.tone).toBeNull();
  });

  it("尚未产生终态不给结论", () => {
    const s = summarizeWorkspace([wait(), wait()], 2, false);
    expect(s.text).toBeNull();
  });

  it("目标数为 0 不给结论", () => {
    expect(summarizeWorkspace([], 0, false).text).toBeNull();
  });

  it("pending 数量按未开始计算，不把排队中的算进结果", () => {
    const s = summarizeWorkspace([ok(), wait()], 2, true);
    expect(s.pending).toBe(1);
    expect(s.ok).toBe(1);
  });

  it("不变量：ok + failed + skipped + pending === total", () => {
    const cases: ItemState[][] = [
      [ok(), ok()],
      [ok(), bad(), skip()],
      [bad(), bad()],
      [skip(), skip()],
      [ok(), run(), wait()],
      [],
    ];
    for (const states of cases) {
      const s = summarizeWorkspace(states, states.length, false);
      expect(s.ok + s.failed + s.skipped + s.pending).toBe(s.total);
    }
  });
});
