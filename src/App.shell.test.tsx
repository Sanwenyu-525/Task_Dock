/**
 * @vitest-environment jsdom
 */
//! 主窗口外壳的「有效视图」回归测试。
//!
//! 用户可见故障：设置 → 导航自定义 显隐入口后，窗口只剩标题栏与背景，
//! 左侧导航和右侧页面同时消失。外壳 DOM 上对应的唯一状态是：
//! **三个 `.view-slot` 同时不是 `active`**（`mode` 不是合法枚举时必然发生）。
//!
//! 本文件锁住两层防线：
//! 1. `useSettingsStore` 在 load / update / syncExternal 三个入口把后端返回的
//!    非法 `mode` 收敛为 `full`（根因层：设置边界）；
//! 2. `App` 渲染前再归一化一次（外壳层：任何绕过 store 的路径也不能失活）。
//!
//! 导航配置写入只命中 `navigation_layout`：更新后 `mode/theme/material` 不得变化，
//! 当前视图槽必须保持挂载。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  settings: null as unknown,
  /** 非空时 getSettings 抛错（模拟启动读取失败） */
  settingsError: null as unknown,
  updateSettings: vi.fn(),
}));

const BASE = {
  theme: "dark",
  mode: "full",
  material: "solid",
  visual_preset: "dream-gradient",
  snap_enabled: false,
  snap_display_mode: "capsule",
  actions_enabled: true,
  navigation_layout: null,
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: async () => undefined,
    outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: 400, height: 560 }),
  }),
}));

// 只替换设置读写与事件订阅；其余桥接函数保持原样（本测试不会触发）。
vi.mock("./lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/bridge")>();
  return {
    ...actual,
    getSettings: async () => {
      if (bridge.settingsError) throw bridge.settingsError;
      return bridge.settings;
    },
    updateSettings: (patch: Record<string, unknown>) => bridge.updateSettings(patch),
    applyWindowMaterial: async () => ({ applied: false, effect: "none", os_version: "" }),
    applyWindowRadius: async () => true,
    notifyUiReady: async () => true,
    onAgentChanged: async () => () => undefined,
    onAppReady: async () => () => undefined,
    onFocusQuickAdd: async () => () => undefined,
    onModeChanged: async () => () => undefined,
    onNotification: async () => () => undefined,
    onNotificationNavigate: async () => () => undefined,
    onQuickCaptureCreated: async () => () => undefined,
    onReminderFired: async () => () => undefined,
    onReminderSnoozed: async () => () => undefined,
    onSnapFormChanged: async () => () => undefined,
    onThemeChanged: async () => () => undefined,
    undoSnooze: async () => [0, 0],
  };
});

vi.mock("./hooks/useEdgeSnap", () => ({
  useEdgeSnap: () => undefined,
  useWindowPersistence: () => undefined,
}));
vi.mock("./store/useHotkeysStore", () => ({ useHotkeysRuntime: () => undefined }));
// 外壳测试不覆盖音频通知；避免其订阅在无 Tauri IPC 的 jsdom 中产生未捕获 rejection。
vi.mock("./lib/audioNotification", () => ({ useAudioNotifications: () => undefined }));

vi.mock("./store/useTasksStore", () => {
  const state = { stats: null, refresh: () => undefined };
  const useTasksStore = (sel: (s: typeof state) => unknown) => sel(state);
  (useTasksStore as unknown as { getState: () => typeof state }).getState = () => state;
  return { useTasksStore };
});
vi.mock("./store/useAgentsStore", () => {
  const state = { snapshot: null, load: () => undefined };
  const useAgentsStore = (sel: (s: typeof state) => unknown) => sel(state);
  (useAgentsStore as unknown as { getState: () => typeof state }).getState = () => state;
  return { useAgentsStore, scheduleAgentRefresh: () => undefined };
});
vi.mock("./store/useNavigationStore", () => {
  const state = { loadTaskLinks: () => undefined, loadTargets: () => undefined };
  const useNavigationStore = (sel: (s: typeof state) => unknown) => sel(state);
  return { useNavigationStore };
});

vi.mock("./components/TitleBar", () => ({ default: () => <div data-testid="titlebar" /> }));
vi.mock("./components/MinimalView", () => ({ default: () => <div className="minimal-view" /> }));
vi.mock("./components/CompactView", () => ({ default: () => <div className="compact-view" /> }));
vi.mock("./components/FullView", () => ({
  default: () => (
    <div className="full-view">
      <nav className="rail" aria-label="主导航" />
      <div className="tab-content">content</div>
    </div>
  ),
}));
vi.mock("./components/navigation/WorkspaceLauncher", () => ({ default: () => null }));
vi.mock("./components/clipboard/ClipboardDrawer", () => ({ default: () => null }));
vi.mock("./components/context/TaskContextDrawer", () => ({ default: () => null }));
vi.mock("./components/Toast", () => ({ default: () => null }));
vi.mock("./components/ui/TooltipLayer", () => ({ default: () => null }));
vi.mock("./components/SnapOverlay", () => ({ default: () => null }));
vi.mock("./components/capsule/TasksLite", () => ({ default: () => null }));
vi.mock("./components/capsule/AgentsLite", () => ({ default: () => null }));
vi.mock("./components/capsule/ClipboardLite", () => ({ default: () => null }));
vi.mock("./components/capsule/AppsLite", () => ({ default: () => null }));

import App from "./App";
import { useSettingsStore } from "./store/useSettingsStore";
import { useEdgeSnapStore } from "./store/useEdgeSnapStore";

function activeSlots(): Element[] {
  return [...document.querySelectorAll(".view-slot.active")];
}

/** 外壳必须始终「恰好一个有效视图槽」，且完整模式槽内有 `.full-view`。 */
function expectShellAlive() {
  expect(document.querySelectorAll(".dock-body")).toHaveLength(1);
  const slots = activeSlots();
  expect(slots).toHaveLength(1);
  expect(slots[0].querySelector(".full-view"), "完整模式视图必须仍挂载").toBeTruthy();
}

beforeEach(() => {
  bridge.settings = { ...BASE };
  bridge.settingsError = null;
  bridge.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
    ...(bridge.settings as Record<string, unknown>),
    ...patch,
  }));
  useSettingsStore.setState({ settings: null, materialInfo: null });
  useEdgeSnapStore.getState().reset();
});

afterEach(() => {
  cleanup();
  bridge.updateSettings.mockReset();
  bridge.settingsError = null;
  useSettingsStore.setState({ settings: null, materialInfo: null });
  useEdgeSnapStore.getState().reset();
});

describe("App 外壳 · 主内容区不得整体消失", () => {
  it("正常加载后存在唯一 active 视图槽与 .full-view", async () => {
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load();
    });
    expectShellAlive();
  });

  it("store 中的 mode 非法（损坏库/旧备份）时仍保持完整视图，不出现空白外壳", async () => {
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load();
    });
    // 绕过 store 归一化直接写非法值：外壳层必须兜住（不再依赖任何单一防线）
    act(() => {
      useSettingsStore.setState({
        settings: { ...(bridge.settings as object), mode: "Full" } as never,
      });
    });
    expectShellAlive();
  });

  it("后端返回非法 mode（load 路径）时 store 收敛为 full，外壳保持完整", async () => {
    bridge.settings = { ...BASE, mode: "" };
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load();
    });
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
    expectShellAlive();
  });

  it("更新导航配置：只改 navigation_layout，mode/theme/material 不变且视图不卸载", async () => {
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load();
    });
    const before = useSettingsStore.getState().settings!;
    await act(async () => {
      await useSettingsStore.getState().update({
        navigation_layout: {
          version: 1,
          left: ["tasks", "settings"],
          capsule: ["tasks"],
          known: { left: [], capsule: [] },
        },
      });
    });
    const after = useSettingsStore.getState().settings!;
    expect(after.mode).toBe(before.mode);
    expect(after.theme).toBe(before.theme);
    expect(after.material).toBe(before.material);
    expectShellAlive();
  });

  it("后端在导航写入的响应里带回非法 mode 时，store 收敛且外壳保持完整", async () => {
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load();
    });
    bridge.updateSettings.mockResolvedValueOnce({
      ...(bridge.settings as object),
      mode: "complete",
      navigation_layout: { version: 1, left: ["settings"], capsule: [] },
    });
    await act(async () => {
      await useSettingsStore.getState().update({
        navigation_layout: { version: 1, left: ["settings"], capsule: [] },
      });
    });
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
    expectShellAlive();
  });

  it("设置写入失败时保留旧配置，主内容区仍可操作（不清空界面）", async () => {
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load();
    });
    bridge.updateSettings.mockRejectedValueOnce(new Error("数据库被占用"));
    await act(async () => {
      await expect(
        useSettingsStore.getState().update({ navigation_layout: { version: 1 } }),
      ).rejects.toThrow();
    });
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
    expectShellAlive();
  });
});

// ── 设置加载门（2026-11-06 P2 修复）──────────────────────────────────
// 设置未加载完成前，`mode` 与 `navigation_layout` 只有默认值。旧实现先按默认值
// 渲染完整面板与默认导航，设置到达后再跳到真实模式/排序（启动闪烁）。
// 现在的契约：设置未就绪只渲染中性占位，就绪后按真实配置挂载；读取失败必须
// 给出可操作的重试入口，不能变成永久空白。
describe("App 外壳 · 设置加载门", () => {
  it("设置未就绪：只渲染中性占位，不渲染默认导航/默认模式内容", () => {
    render(<App />);
    expect(document.querySelector(".shell-boot")).toBeTruthy();
    expect(document.querySelector(".full-view")).toBeNull();
    expect(document.querySelector(".compact-view")).toBeNull();
    // 外壳结构仍在，且恰好一个视图槽处于 active（不是空白窗口）
    expect(document.querySelector(".dock-body")).toBeTruthy();
    expect(activeSlots()).toHaveLength(1);
  });

  it("真实模式是极简/紧凑时：加载门不把 FullView 误挂载到隐藏槽", async () => {
    bridge.settings = { ...BASE, mode: "compact" };
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load();
    });
    expect(document.querySelector(".compact-view")).toBeTruthy();
    // 占位不算一次视图激活：完整模式从未激活，FullView 不应挂载
    expect(document.querySelector(".full-view")).toBeNull();
    expect(document.querySelector(".shell-boot")).toBeNull();
    expect(activeSlots()).toHaveLength(1);
  });

  it("读取失败：显示原因与重试入口；重试成功后进入正常界面", async () => {
    bridge.settingsError = new Error("数据库被占用");
    render(<App />);
    await act(async () => {
      await useSettingsStore.getState().load().catch(() => undefined);
    });
    const alert = document.querySelector(".shell-boot");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent ?? "").toContain("设置读取失败");
    expect(useSettingsStore.getState().loadError).toContain("数据库被占用");

    // 重试：错误消失、真实配置生效
    bridge.settingsError = null;
    await act(async () => {
      screen.getByRole("button", { name: "重试" }).click();
    });
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
    expect(document.querySelector(".shell-boot")).toBeNull();
    expectShellAlive();
  });
});
