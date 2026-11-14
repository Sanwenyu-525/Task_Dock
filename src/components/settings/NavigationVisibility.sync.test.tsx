/**
 * @vitest-environment jsdom
 */
//! 导航排序 · 跨界面即时同步与写入语义（2026-11-14 二轮修复）。
//!
//! 这一组用例针对上一轮验收发现的三个 P1/P2：
//! 1. 设置列表立即变化、但侧边栏/胶囊读的是已提交配置 → 短暂不一致；
//! 2. 保存失败被 `flush()` 吞掉 → 依赖它的显隐/恢复默认继续执行；
//! 3. 键盘路径绕过写入忙状态。
//!
//! `LayoutProbe` 用的就是 `FullView` / `CapsuleRail` / 帮助页共用的
//! `useNavigationLayout()`：探针与设置列表必须始终一致，且**不等写库**。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NavigationVisibilitySection from "./NavigationVisibilitySection";
import { useNavigationLayout } from "../../lib/navigationLayout";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { defaultNavigationLayout } from "../../lib/navVisibility";
import { resetNavOrderIntents } from "../../lib/navOrderIntent";
import { resetOverlayStack } from "../../lib/overlayStack";

const bridgeMocks = vi.hoisted(() => ({ updateSettings: vi.fn() }));
const updateSettings = bridgeMocks.updateSettings;

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    updateSettings: (patch: Record<string, unknown>) => bridgeMocks.updateSettings(patch),
  };
});

/** 与侧边栏 / 胶囊共用同一个读取入口。 */
function LayoutProbe() {
  const layout = useNavigationLayout();
  return <div data-testid="probe">{layout.left.join(",")}</div>;
}

function probeIds(): string[] {
  return (screen.getByTestId("probe").textContent ?? "").split(",").filter(Boolean);
}

/** 设置列表里**可见**的入口 ID（隐藏项排在列表末尾，不属于排序结果）。 */
function listIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-nav-entry]")]
    .filter((node) => node.querySelector<HTMLInputElement>('input[role="switch"]')?.checked)
    .map((node) => node.dataset.navEntry ?? "");
}

function savedLayout(): { left: string[]; capsule: string[] } {
  const layout = useSettingsStore.getState().settings?.navigation_layout as
    | { left: string[]; capsule: string[] }
    | undefined;
  if (!layout) throw new Error("配置尚未写入");
  return layout;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 按下即移动一格（长按会话的第一步是同步执行的）。 */
function nudgeUp(name: string) {
  const button = screen.getByRole("button", { name: `上移 ${name}` });
  fireEvent.pointerDown(button, { pointerId: 1, button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(window, { pointerId: 1 });
}

function seedLayout(mutate?: (layout: ReturnType<typeof defaultNavigationLayout>) => void) {
  const layout = defaultNavigationLayout();
  mutate?.(layout);
  useSettingsStore.setState({ settings: { navigation_layout: layout } as never });
  return layout;
}

beforeEach(() => {
  useUiStore.setState({ tab: "tasks" });
  updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
    const current = useSettingsStore.getState().settings ?? {};
    return { ...current, ...patch } as never;
  });
  seedLayout();
});

afterEach(() => {
  cleanup();
  resetOverlayStack();
  resetNavOrderIntents();
  updateSettings.mockReset();
  useSettingsStore.setState({ settings: null, materialInfo: null });
});

describe("跨界面即时同步", () => {
  it("移动一次后所有消费者立刻同序，不需要等待数据库写入", () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const before = probeIds();
    const index = before.indexOf("clipboard");
    expect(index).toBeGreaterThan(0);

    nudgeUp("剪贴板");

    // 没有任何写入发生（合并窗口内），但侧边栏已经换了顺序。
    expect(updateSettings).not.toHaveBeenCalled();
    const after = probeIds();
    expect(after).toEqual(listIds());
    // 上移一格：正好越过原来的上一项，其余相对顺序不变。
    expect(after.indexOf("clipboard")).toBe(index - 1);
    expect(after[index]).toBe(before[index - 1]);
    expect(after).toHaveLength(before.length);
    expect(new Set(after).size).toBe(after.length);
  });

  it("连续 10 次移动：每一次设置列表与导航栏都一致，写入合并成一次", async () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const original = probeIds();
    for (let step = 0; step < 10; step += 1) {
      nudgeUp("剪贴板");
      // 每一步之后两个界面都必须一致（同一次 React 更新内完成）。
      expect(probeIds()).toEqual(listIds());
      expect(new Set(probeIds()).size).toBe(original.length);
    }
    // 10 次移动全部生效（剪贴板到达可排序段首位）
    const moved = probeIds();
    expect(moved[0]).toBe("clipboard");

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    // 合并写入：10 次移动远不止 1 次定时器窗口，写库次数必须远少于移动次数。
    expect(updateSettings.mock.calls.length).toBeLessThanOrEqual(3);
    await waitFor(() => expect(savedLayout().left).toEqual(moved));
    // 落库后界面不回退、不错序。
    expect(probeIds()).toEqual(moved);
  });

  it("过期写入返回时不把界面回退到更早的顺序", async () => {
    const first = deferred<void>();
    let calls = 0;
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) await first.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );

    nudgeUp("剪贴板");
    const orderA = probeIds();
    // 等第一次写入真正发出（合并窗口结束）
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // 第一次写入还在途中时继续移动：产生更新的意图 B
    nudgeUp("剪贴板");
    const orderB = probeIds();
    expect(orderB).not.toEqual(orderA);

    // A 落库返回：界面必须保持 B，不能被 A 的快照回退。
    first.resolve();
    await waitFor(() => expect(savedLayout().left).toEqual(orderA));
    expect(probeIds()).toEqual(orderB);

    // B 最终也会落库，界面与数据库收敛。
    await waitFor(() => expect(savedLayout().left).toEqual(orderB));
    expect(probeIds()).toEqual(orderB);
  });
});

describe("保存失败语义", () => {
  it("写入失败：所有界面一起回滚并显示真实错误", async () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const original = probeIds();
    updateSettings.mockRejectedValueOnce(new Error("disk full"));

    nudgeUp("剪贴板");
    expect(probeIds()).not.toEqual(original);

    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    // 滚回已提交顺序，且侧边栏与设置列表一致（不是只有列表回滚）。
    expect(probeIds()).toEqual(original);
    expect(listIds()).toEqual(original);
    expect(savedLayout().left).toEqual(original);

    // 失败后仍然可用：再次移动并成功落库。
    const restoredIndex = probeIds().indexOf("clipboard");
    nudgeUp("剪贴板");
    await waitFor(() => expect(probeIds().indexOf("clipboard")).toBe(restoredIndex - 1));
    await waitFor(() =>
      expect(savedLayout().left.indexOf("clipboard")).toBe(restoredIndex - 1),
    );
  });

  it("排序没保存成功时，显隐切换不会继续执行（不静默丢排序）", async () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const original = probeIds();
    updateSettings.mockRejectedValueOnce(new Error("disk full"));

    nudgeUp("剪贴板");
    const toggle = screen.getByRole("switch", { name: "应用导航入口显示" });
    fireEvent.click(toggle);

    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    // 显隐写入没有发生：应用仍可见，顺序也回到已提交值。
    expect(probeIds()).toContain("apps");
    expect(probeIds()).toEqual(original);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    // 只有那次失败的排序写入，没有第二次（显隐）写入。
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it("在途排序写入失败：隐藏被中止、顺序回滚、随后仍可重新排序", async () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const original = probeIds();
    const gate = deferred<void>();
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });

    nudgeUp("剪贴板");
    expect(probeIds()).not.toEqual(original);
    // 等合并窗口结束、写入**真正发出**（不是「计时器还没触发」的场景）
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const toggle = screen.getByRole("switch", { name: "应用导航入口显示" });
    fireEvent.click(toggle);
    gate.reject(new Error("disk full"));

    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    // 显隐没有执行（仍然可见），排序与所有消费者一起回滚。
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(probeIds()).toEqual(original);
    expect(listIds()).toEqual(original);
    // 只发生过那一次排序写入，没有额外的显隐写入。
    expect(updateSettings).toHaveBeenCalledTimes(1);

    // 失败后仍可操作：再次排序并成功落库。
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    nudgeUp("剪贴板");
    await waitFor(() =>
      expect(probeIds().indexOf("clipboard")).toBe(original.indexOf("clipboard") - 1),
    );
    // 重新排序同样会合并落库（等写入完成再断言数据库）。
    await waitFor(() =>
      expect(savedLayout().left.indexOf("clipboard")).toBe(original.indexOf("clipboard") - 1),
    );
  });

  it("排序写入在途时恢复默认：默认顺序不会被旧写入覆盖", async () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const original = probeIds();
    const gate = deferred<void>();
    let calls = 0;
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });

    nudgeUp("剪贴板");
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // 在途写入还没回来就恢复默认：丢弃意图，默认值排在它之后写入。
    fireEvent.click(screen.getByRole("button", { name: "恢复完整面板默认导航配置" }));
    gate.resolve();

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(savedLayout().left).toEqual(original));
    expect(probeIds()).toEqual(original);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("恢复默认是整份覆盖：不等待可能失败的排序写入，最终为默认顺序", async () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const original = probeIds();
    nudgeUp("剪贴板");
    expect(probeIds()).not.toEqual(original);

    fireEvent.click(screen.getByRole("button", { name: "恢复完整面板默认导航配置" }));

    await waitFor(() => expect(savedLayout().left).toEqual(original));
    expect(probeIds()).toEqual(original);
    // 待保存的顺序被默认值取代：只为恢复默认写一次库。
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("关闭设置页时把最后一笔顺序落库", async () => {
    render(<NavigationVisibilitySection />);
    nudgeUp("剪贴板");
    const moved = listIds();
    expect(updateSettings).not.toHaveBeenCalled();

    // 合并窗口还没到就卸载：卸载路径必须把顺序落库，不能丢。
    cleanup();
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(savedLayout().left).toEqual(moved);
  });
});

describe("键盘与忙状态", () => {
  it("排他写入期间 Alt+方向键不改变顺序，写入完成后恢复", async () => {
    const gate = deferred<void>();
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );

    // 隐藏「应用」：进入排他写入（在途）
    fireEvent.click(screen.getByRole("switch", { name: "应用导航入口显示" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const during = probeIds();

    const up = screen.getByRole("button", { name: "上移 剪贴板" });
    up.focus();
    fireEvent.keyDown(up, { key: "ArrowUp", altKey: true });
    // 键盘路径不经过 DOM 禁用态：必须与按钮一样被拒绝。
    expect(probeIds()).toEqual(during);

    gate.resolve();
    await waitFor(() => expect(probeIds()).not.toContain("apps"));

    const after = probeIds();
    fireEvent.keyDown(screen.getByRole("button", { name: "上移 剪贴板" }), {
      key: "ArrowUp",
      altKey: true,
    });
    expect(probeIds()).not.toEqual(after);
    expect(indexOf(probeIds(), "clipboard")).toBeLessThan(indexOf(after, "clipboard"));
  });
});

describe("界面切换事务", () => {
  it("切换前停会话、封住排序输入，成功落库后才切换", async () => {
    const gate = deferred<void>();
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );

    // 先进入调整态：切换后固定调整条不能残留。
    fireEvent.click(
      document.querySelector('[data-nav-entry="clipboard"] .nav-visibility-entry-label')!,
    );
    expect(screen.queryByText("调整「剪贴板」")).toBeTruthy();
    nudgeUp("剪贴板");
    const moved = probeIds();

    const capsuleTab = screen.getByRole("button", { name: "停靠胶囊" }) as HTMLButtonElement;
    const leftTab = screen.getByRole("button", { name: "完整面板" }) as HTMLButtonElement;
    fireEvent.click(capsuleTab);

    // 事务已开始：调整条收起，两个界面按钮都禁用（第二个切换请求无从发起）。
    expect(screen.queryByText("调整「剪贴板」")).toBeNull();
    expect(capsuleTab.disabled).toBe(true);
    expect(leftTab.disabled).toBe(true);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    // 事务期间，鼠标/长按/键盘排序都不能产生新意图。
    const up = screen.getByRole("button", { name: "上移 剪贴板" });
    fireEvent.pointerDown(up, { pointerId: 21, button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(window, { pointerId: 21 });
    fireEvent.keyDown(up, { key: "ArrowUp", altKey: true });
    expect(probeIds()).toEqual(moved);
    // 连点另一个界面也不会覆盖本次切换目标。
    fireEvent.click(leftTab);
    expect(capsuleTab.getAttribute("aria-pressed")).toBe("false");

    gate.resolve();
    await waitFor(() => expect(capsuleTab.getAttribute("aria-pressed")).toBe("true"));
    expect(leftTab.getAttribute("aria-pressed")).toBe("false");
    expect(savedLayout().left).toEqual(moved);
  });

  it("切换时保存失败：留在原界面、显示真实错误，重试可以成功", async () => {
    const gate = deferred<void>();
    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      await gate.promise;
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const original = probeIds();
    nudgeUp("剪贴板");

    const capsuleTab = screen.getByRole("button", { name: "停靠胶囊" }) as HTMLButtonElement;
    fireEvent.click(capsuleTab);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    gate.reject(new Error("disk full"));

    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    // 没有切换：仍在完整面板，顺序回滚到已提交值。
    expect(capsuleTab.getAttribute("aria-pressed")).toBe("false");
    expect(probeIds()).toEqual(original);
    // 事务锁已释放，可以重试。
    await waitFor(() => expect(capsuleTab.disabled).toBe(false));

    updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      const current = useSettingsStore.getState().settings ?? {};
      return { ...current, ...patch } as never;
    });
    fireEvent.click(capsuleTab);
    await waitFor(() => expect(capsuleTab.getAttribute("aria-pressed")).toBe("true"));
    // 重试成功后错误提示随之清除。
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("界面隔离", () => {
  it("完整面板与胶囊各自的顺序互不覆盖", async () => {
    render(
      <>
        <NavigationVisibilitySection />
        <LayoutProbe />
      </>,
    );
    const leftOriginal = probeIds();
    nudgeUp("剪贴板");
    const leftMoved = probeIds();
    expect(leftMoved).not.toEqual(leftOriginal);

    // 切到胶囊：先把完整面板的顺序落库，再操作胶囊
    fireEvent.click(screen.getByRole("button", { name: "停靠胶囊" }));
    await waitFor(() => expect(savedLayout().left).toEqual(leftMoved));
    const capsuleOriginal = savedLayout().capsule;

    const downButton = document.querySelector<HTMLButtonElement>(
      '.nav-visibility-list button[data-nav-action="down"]:not([disabled])',
    );
    expect(downButton).toBeTruthy();
    const capsuleId = downButton!.closest<HTMLElement>("[data-nav-entry]")!.dataset.navEntry!;
    fireEvent.pointerDown(downButton!, { pointerId: 2, button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(window, { pointerId: 2 });

    // 切回完整面板会 flush 胶囊顺序
    fireEvent.click(screen.getByRole("button", { name: "完整面板" }));
    await waitFor(() => {
      const saved = savedLayout();
      expect(saved.capsule).not.toEqual(capsuleOriginal);
      // 胶囊的写入没有把完整面板的顺序带回旧值
      expect(saved.left).toEqual(leftMoved);
    });
    expect(savedLayout().capsule.indexOf(capsuleId)).toBe(
      capsuleOriginal.indexOf(capsuleId) + 1,
    );
  });
});

function indexOf(ids: readonly string[], id: string): number {
  return ids.indexOf(id);
}
