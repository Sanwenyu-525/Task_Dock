/**
 * @vitest-environment jsdom
 */
//! 设置页「导航自定义」展开区（统一导航架构）：完整面板 / 停靠胶囊独立配置、
//! 显隐、键盘排序、锁定入口保护、保存失败反馈与状态一致。
//!
//! 折叠外壳由 `SettingsPanel` 的 `Section` 负责，这里只测展开内容本身。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NavigationVisibilitySection from "./NavigationVisibilitySection";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { defaultNavigationLayout } from "../../lib/navVisibility";
import { __resetLocaleForTests, setLocalePreference } from "../../i18n";

const bridgeMocks = vi.hoisted(() => ({ updateSettings: vi.fn() }));
const updateSettings = bridgeMocks.updateSettings;

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    updateSettings: (patch: Record<string, unknown>) => bridgeMocks.updateSettings(patch),
  };
});

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
  updateSettings.mockReset();
  useSettingsStore.setState({ settings: null, materialInfo: null });
});

describe("导航自定义区块", () => {
  it("展示当前常驻摘要，隐藏入口写入 navigation_layout；隐藏当前页时自动切到安全页", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "apps" });
    render(<NavigationVisibilitySection />);

    expect(screen.getByText(/常驻 11 \/ 11 项/)).toBeTruthy();
    const appsSwitch = screen.getByRole("switch", {
      name: "应用导航入口显示",
    }) as HTMLInputElement;
    await user.click(appsSwitch);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const patch = updateSettings.mock.calls[0][0] as {
      navigation_layout: { version: number; left: string[] };
    };
    expect(patch.navigation_layout.version).toBe(1);
    expect(patch.navigation_layout.left).not.toContain("apps");
    expect(useUiStore.getState().tab).toBe("tasks");
    // 后端返回值已写入 Store：开关与配置一致，不存在假成功
    expect(
      (useSettingsStore.getState().settings?.navigation_layout as { left: string[] }).left,
    ).not.toContain("apps");
    expect(screen.getByText(/常驻 10 \/ 11 项/)).toBeTruthy();
  });

  it("「设置」是锁定入口：开关禁用、无排序按钮并标注固定", () => {
    render(<NavigationVisibilitySection />);

    const settingsSwitch = screen.getByRole("switch", {
      name: "设置导航入口（固定）",
    }) as HTMLInputElement;
    expect(settingsSwitch.disabled).toBe(true);
    expect(settingsSwitch.checked).toBe(true);
    expect(screen.getByText("固定")).toBeTruthy();
    // 锁定入口不提供上移/下移，避免把设置从底部移走
    expect(screen.queryByRole("button", { name: "上移 设置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下移 设置" })).toBeNull();
  });

  it("完整面板与停靠胶囊独立配置，互不覆盖", async () => {
    const user = userEvent.setup();
    render(<NavigationVisibilitySection />);

    await user.click(screen.getByRole("button", { name: "停靠胶囊" }));
    const appsSwitch = screen.getByRole("switch", {
      name: "应用导航入口显示",
    }) as HTMLInputElement;
    expect(appsSwitch.checked).toBe(true); // 胶囊默认显示「应用」
    await user.click(appsSwitch);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const layout = useSettingsStore.getState().settings?.navigation_layout as {
      left: string[];
      capsule: string[];
    };
    expect(layout.capsule).not.toContain("apps");
    // 完整面板的「应用」保持原显隐，不受胶囊配置影响
    expect(layout.left).toContain("apps");
  });

  it("上移/下移按钮原生可聚焦，按配置顺序持久化", async () => {
    const user = userEvent.setup();
    render(<NavigationVisibilitySection />);

    const up = screen.getByRole("button", { name: "上移 剪贴板" });
    expect(up.hasAttribute("disabled")).toBe(false);
    up.focus();
    expect(document.activeElement).toBe(up);
    await user.click(up);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const left = (
      useSettingsStore.getState().settings?.navigation_layout as { left: string[] }
    ).left;
    const clipboardIndex = left.indexOf("clipboard");
    expect(left[clipboardIndex - 1]).toBe("widgets");
    expect(left[clipboardIndex + 1]).toBe("actions");
  });

  it("恢复默认只作用于当前界面，不动另一界面", async () => {
    const user = userEvent.setup();
    seedLayout((layout) => {
      layout.left = layout.left.filter((id) => id !== "apps");
      layout.capsule = layout.capsule.filter((id) => id !== "apps");
    });
    render(<NavigationVisibilitySection />);

    await user.click(screen.getByRole("button", { name: "恢复完整面板默认导航配置" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const layout = useSettingsStore.getState().settings?.navigation_layout as {
      left: string[];
      capsule: string[];
    };
    expect(layout.left).toContain("apps");
    expect(layout.capsule).not.toContain("apps");
  });

  it("全部胶囊入口隐藏时提示可恢复路径，不出现假成功", async () => {
    const user = userEvent.setup();
    seedLayout((layout) => {
      layout.capsule = [];
    });
    render(<NavigationVisibilitySection />);
    await user.click(screen.getByRole("button", { name: "停靠胶囊" }));

    expect(screen.getByText(/常驻 0 \/ 5 项/)).toBeTruthy();
    expect(screen.getByText(/切换为完整面板/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "恢复停靠胶囊默认导航配置" })).toBeTruthy();
  });

  it("保存失败就地提示，界面仍显示上次保存的配置", async () => {
    const user = userEvent.setup();
    render(<NavigationVisibilitySection />);

    updateSettings.mockRejectedValueOnce(new Error("disk full"));
    const appsSwitch = screen.getByRole("switch", {
      name: "应用导航入口显示",
    }) as HTMLInputElement;
    await user.click(appsSwitch);

    expect((await screen.findByRole("alert")).textContent).toContain("保存失败");
    expect(
      (useSettingsStore.getState().settings?.navigation_layout as { left: string[] }).left,
    ).toContain("apps");
  });
});

// 英文模式：设置页导航自定义区块的标题、摘要、开关可访问名与提示全部翻译，
// 隐藏/排序仍由稳定 ID 驱动，界面布局只依赖文案长度（允许换行/截断）。
describe("导航自定义区块 · 英文", () => {
  afterEach(() => {
    __resetLocaleForTests();
  });

  it("英文界面展示完整面板/胶囊入口、摘要与操作 aria-label", async () => {
    const user = userEvent.setup();
    setLocalePreference("en-US");
    render(<NavigationVisibilitySection />);

    expect(screen.getByText("11 of 11 pinned")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Full panel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Docked capsule" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show Tasks navigation entry" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Settings navigation entry (pinned)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Tasks up" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Restore default Full panel navigation" }),
    ).toBeTruthy();

    // 隐藏入口仍写入稳定 ID，不受英文文案影响
    await user.click(screen.getByRole("switch", { name: "Show Apps navigation entry" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0][0].navigation_layout.left).not.toContain("apps");
  });
});

// ── 排序按钮与固定入口（2026-11-05）────────────────────────────────
describe("排序按钮可见性与边界", () => {
  it("胶囊界面的 Agent 状态球固定：不提供上移/下移，并标注固定位置", async () => {
    const user = userEvent.setup();
    render(<NavigationVisibilitySection />);
    await user.click(screen.getByRole("button", { name: "停靠胶囊" }));

    expect(screen.queryByRole("button", { name: "上移 Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下移 Agent" })).toBeNull();
    // Agent 仍可隐藏（隐藏不停止监控）
    const agentSwitch = screen.getByRole("switch", { name: /Agent/ });
    expect((agentSwitch as HTMLInputElement).disabled).toBe(false);
    // 固定位置标注（与「固定」锁定标注区分）
    expect(screen.getAllByText("固定位置").length).toBeGreaterThan(0);
  });

  it("左侧末位普通入口的「下移」禁用（不能越过固定的设置）", async () => {
    seedLayout((layout) => {
      // 把设置从可见数组里删掉：归一化会补回并收敛到末尾
      layout.left = layout.left.filter((id) => id !== "settings");
    });
    render(<NavigationVisibilitySection />);

    // 规划中心是最后一位普通入口，其下移按钮禁用（后面只有固定的设置）
    const down = screen.getByRole("button", { name: "下移 规划中心" }) as HTMLButtonElement;
    expect(down.disabled).toBe(true);
    // 倒数第二位仍可下移
    const upDown = screen.getByRole("button", { name: "下移 历史" }) as HTMLButtonElement;
    expect(upDown.disabled).toBe(false);
  });

  it("排序操作立即持久化：配置数组顺序改变，且隐藏状态不变", async () => {
    const user = userEvent.setup();
    render(<NavigationVisibilitySection />);
    const up = screen.getByRole("button", { name: "上移 Agent" });
    await user.click(up);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const patch = updateSettings.mock.calls[0][0] as {
      navigation_layout: { left: string[] };
    };
    const left = patch.navigation_layout.left;
    expect(left.indexOf("agents")).toBe(left.indexOf("tasks") - 1);
    // 成员集合不变（显隐不受排序影响）
    expect([...left].sort()).toEqual([...defaultNavigationLayout().left].sort());
    expect(left[left.length - 1]).toBe("settings");
  });
});
