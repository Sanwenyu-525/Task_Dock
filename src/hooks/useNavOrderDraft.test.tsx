/**
 * @vitest-environment jsdom
 */
//! 排序草稿的写入结果协议（2026-11-14 三轮修复）。
//!
//! 覆盖上一轮遗留的两个缺陷：
//! 1. `flush()` 只 `await` 在途写入、不检查结果 —— 保存失败被当成成功，
//!    随后显隐/切界面等依赖排序的写入继续执行；
//! 2. `flush()` 最多循环 4 次 —— 持续输入时会在仍有未保存意图的情况下返回成功。
//!
//! 这里直接用 hook 级探针驱动（不经 UI 门禁），因为要模拟「输入没有被封住」
//! 这种异常场景：UI 层另有 busy / 切换事务锁的回归用例。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useNavOrderDraft, type NavOrderDraft } from "./useNavOrderDraft";
import { useCommittedNavigationLayout } from "../lib/navigationLayout";
import { isEntrySortable, navEntry } from "../lib/navigationRegistry";
import { defaultNavigationLayout } from "../lib/navVisibility";
import { readNavOrderIntent, resetNavOrderIntents } from "../lib/navOrderIntent";
import { useSettingsStore } from "../store/useSettingsStore";

const bridgeMocks = vi.hoisted(() => ({ updateSettings: vi.fn() }));
const updateSettings = bridgeMocks.updateSettings;

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return {
    ...actual,
    updateSettings: (patch: Record<string, unknown>) => bridgeMocks.updateSettings(patch),
  };
});

interface ProbeRef {
  api: NavOrderDraft | null;
}

/** 与设置页相同的基准：已提交配置 + 同一份排序规则。 */
function DraftProbe({ probe }: { probe: ProbeRef }) {
  const layout = useCommittedNavigationLayout();
  const draft = useNavOrderDraft(
    "left",
    layout.left,
    (id) => {
      const entry = navEntry(id);
      return !entry || !isEntrySortable(entry, "left");
    },
    () => {},
  );
  probe.api = draft;
  return null;
}

function savedLeft(): string[] {
  const layout = useSettingsStore.getState().settings?.navigation_layout as
    | { left: string[] }
    | undefined;
  if (!layout) throw new Error("配置尚未写入");
  return layout.left;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** `flush()` 的结果收集：先挂处理器，避免测试里的拒绝变成未处理 rejection。 */
function trackFlush(api: NavOrderDraft) {
  return api.flush().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

beforeEach(() => {
  updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
    const current = useSettingsStore.getState().settings ?? {};
    return { ...current, ...patch } as never;
  });
  useSettingsStore.setState({
    settings: { navigation_layout: defaultNavigationLayout() } as never,
    materialInfo: null,
  });
});

afterEach(() => {
  cleanup();
  resetNavOrderIntents();
  updateSettings.mockReset();
  useSettingsStore.setState({ settings: null, materialInfo: null });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("P1：在途写入失败必须让 flush() reject", () => {
  it("写入已经开始后失败：flush 不能当成保存成功", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    const probe: ProbeRef = { api: null };
    render(<DraftProbe probe={probe} />);
    const original = savedLeft();

    act(() => {
      expect(probe.api!.move("clipboard", -1)).toBe(true);
    });
    const moved = readNavOrderIntent("left")!.ids;
    expect(moved).not.toEqual(original);

    // 合并窗口结束 → 写入真正开始并停在 gate 上（不是「计时器还没触发」的情况）
    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);

    // 写入在途时调用 flush：它必须等这一笔，并且检查结果
    const outcome = trackFlush(probe.api!);
    await act(async () => {
      gate.reject(new Error("disk full"));
    });
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as Error).message).toContain("disk full");

    // 已回滚：意图被清除，界面/消费者回到已提交顺序，数据库没有被写脏
    expect(readNavOrderIntent("left")).toBeNull();
    expect(savedLeft()).toEqual(original);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it("过期意图失败不回滚更新的意图，也不被当作本次成功", async () => {
    vi.useFakeTimers();
    const gates: Array<ReturnType<typeof deferred>> = [];
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    const probe: ProbeRef = { api: null };
    render(<DraftProbe probe={probe} />);
    const original = savedLeft();

    act(() => {
      probe.api!.move("clipboard", -1);
    });
    const outcome = trackFlush(probe.api!);
    await act(async () => {});
    expect(gates).toHaveLength(1);

    // 第一笔还在途时产生更新的意图 B
    act(() => {
      probe.api!.move("clipboard", -1);
    });
    const orderB = readNavOrderIntent("left")!.ids;

    // A 失败：不能清除 B，也不能让 flush 直接成功
    await act(async () => {
      gates[0].reject(new Error("disk full"));
    });
    expect(readNavOrderIntent("left")?.ids).toEqual(orderB);
    expect(savedLeft()).toEqual(original);
    // 它继续保存 B：第二笔已经开始，flush 仍然挂着
    expect(gates).toHaveLength(2);
    const early = await Promise.race([
      outcome.then(() => "done" as const),
      Promise.resolve("pending" as const),
    ]);
    expect(early).toBe("pending");

    // B 落库后 flush 才完成，最终配置 = B
    await act(async () => {
      gates[1].resolve();
    });
    const result = await outcome;
    expect(result.ok).toBe(true);
    expect(readNavOrderIntent("left")).toBeNull();
    expect(savedLeft()).toEqual(orderB);
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });
});

describe("P2：flush() 只在收敛后 resolve", () => {
  it("每轮保存期间都产生新意图：超过旧的 4 轮上限也不会提前成功", async () => {
    vi.useFakeTimers();
    const gates: Array<() => void> = [];
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      const gate = deferred();
      gates.push(gate.resolve);
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    const probe: ProbeRef = { api: null };
    render(<DraftProbe probe={probe} />);

    act(() => {
      probe.api!.move("clipboard", -1);
    });
    const outcome = trackFlush(probe.api!);
    await act(async () => {});

    let lastOrder = readNavOrderIntent("left")!.ids;
    // 6 轮：每笔写入在途时再移动一次，制造「始终还有更新意图」
    for (let round = 0; round < 6; round += 1) {
      expect(gates).toHaveLength(round + 1);
      act(() => {
        probe.api!.move("clipboard", -1);
      });
      lastOrder = readNavOrderIntent("left")!.ids;
      await act(async () => gates[round]());
    }
    // 第 7 笔（最新意图）在途：flush 仍必须挂着
    expect(gates).toHaveLength(7);
    const early = await Promise.race([
      outcome.then(() => "done" as const),
      Promise.resolve("pending" as const),
    ]);
    expect(early).toBe("pending");

    await act(async () => gates[6]());
    const result = await outcome;
    expect(result.ok).toBe(true);
    // 收敛：没有残留意图，数据库是最新顺序
    expect(readNavOrderIntent("left")).toBeNull();
    expect(savedLeft()).toEqual(lastOrder);
    expect(updateSettings).toHaveBeenCalledTimes(7);
  });
});

describe("卸载路径", () => {
  it("在途写入收尾后不再重复提交同一份意图", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    const probe: ProbeRef = { api: null };
    const { unmount } = render(<DraftProbe probe={probe} />);

    act(() => {
      probe.api!.move("clipboard", -1);
    });
    const moved = readNavOrderIntent("left")!.ids;
    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      gate.resolve();
    });
    await act(async () => {});

    // 只写过一次（在途那一笔），没有为同一份意图再发一次
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(readNavOrderIntent("left")).toBeNull();
    expect(savedLeft()).toEqual(moved);
  });

  it("关闭设置页时在途写入失败：回滚并留下可追踪记录", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = deferred();
    updateSettings.mockImplementation(async () => {
      await gate.promise;
      throw new Error("disk full");
    });
    const probe: ProbeRef = { api: null };
    const original = savedLeft();
    const { unmount } = render(<DraftProbe probe={probe} />);

    act(() => {
      probe.api!.move("clipboard", -1);
    });
    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    unmount();
    await act(async () => {
      gate.reject(new Error("disk full"));
    });
    await act(async () => {});

    expect(readNavOrderIntent("left")).toBeNull();
    expect(savedLeft()).toEqual(original);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[nav-order]"),
      expect.stringContaining("disk full"),
    );
  });

  it("卸载时还没落库的草稿会被提交", async () => {
    vi.useFakeTimers();
    const probe: ProbeRef = { api: null };
    const { unmount } = render(<DraftProbe probe={probe} />);

    act(() => {
      probe.api!.move("clipboard", -1);
    });
    const moved = readNavOrderIntent("left")!.ids;
    // 合并窗口还没到就卸载
    unmount();
    await act(async () => {});

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(savedLeft()).toEqual(moved);
    expect(readNavOrderIntent("left")).toBeNull();
  });
});
