/**
 * @vitest-environment jsdom
 */
//! 导航显隐 ↔ 主界面联动（集成层）：真实 `FullView` + 真实「导航自定义」状态，
//! 只把页面面板与桥接替换为替身。
//!
//! 锁住用户故障的可见契约：显隐任意入口、快速连续切换、切换完整/胶囊配置、
//! 隐藏当前页、从「更多」打开隐藏页、恢复默认、写入失败、重新挂载后读取配置，
//! **主内容区（`.full-view` / `.tab-content`）始终存在**，且
//! `settings.mode/theme/material` 不被导航配置写入影响。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const bridge = vi.hoisted(() => ({
  settings: null as unknown,
  updateSettings: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    getSettings: async () => bridge.settings,
    updateSettings: (patch: Record<string, unknown>) => bridge.updateSettings(patch),
    applyWindowMaterial: async () => ({ applied: false, effect: "none", os_version: "" }),
    applyWindowRadius: async () => true,
  };
});

vi.mock("../tasks/TasksPanel", () => ({ default: () => <div>tasks-panel</div> }));
vi.mock("../agents/AgentPanel", () => ({ default: () => <div>agents-panel</div> }));
vi.mock("../apps/AppsPanel", () => ({ default: () => <div>apps-panel</div> }));
vi.mock("../widgets/WidgetsPanel", () => ({ default: () => <div>widgets-panel</div> }));
vi.mock("../actions/ActionCenterPanel", () => ({ default: () => <div>actions-panel</div> }));
vi.mock("../clipboard/ClipboardPanel", () => ({ default: () => <div>clipboard-panel</div> }));
vi.mock("../collection/CollectionPanel", () => ({ default: () => <div>collection-panel</div> }));
vi.mock("../workflows/WorkflowsPanel", () => ({ default: () => <div>workflows-panel</div> }));
vi.mock("../history/HistoryPanel", () => ({ default: () => <div>history-panel</div> }));
vi.mock("../roadmap/PlanningCenterPanel", () => ({ default: () => <div>roadmap-panel</div> }));
vi.mock("../settings/SettingsPanel", () => ({ default: () => <div>settings-panel</div> }));

import FullView from "../FullView";
import NavigationVisibilitySection from "./NavigationVisibilitySection";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useActionsStore } from "../../store/useActionsStore";
import { useCaptureStore } from "../../store/useCaptureStore";
import { defaultNavigationLayout } from "../../lib/navVisibility";

const BASE = {
  theme: "dark",
  mode: "full",
  material: "solid",
  visual_preset: "dream-gradient",
  snap_enabled: false,
  snap_display_mode: "capsule",
  actions_enabled: true,
};

/** 后端真实行为：返回完整 Settings（写入的键覆盖，其余保持原值）。 */
function installBackend() {
  bridge.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
    const current = (bridge.settings ?? {}) as Record<string, unknown>;
    const next = { ...current, ...patch };
    bridge.settings = next;
    return next;
  });
}

function renderAll() {
  return render(
    <>
      <FullView />
      <NavigationVisibilitySection />
    </>,
  );
}

/** 主内容区必须仍存在且可继续操作（外壳层会额外断言 view-slot，见 App.shell.test）。 */
function expectContentAlive() {
  expect(document.querySelector(".full-view")).toBeTruthy();
  expect(document.querySelector(".tab-content")).toBeTruthy();
  expect(document.querySelector(".tab-content")?.textContent ?? "").not.toBe("");
}

/** 常驻入口标签（不含「更多」再入口所在的 .rail-more 容器）。 */
function railLabels(): string[] {
  // 中间滚动列表 + 固定底部（设置）；「更多」触发按钮不在底部区域直接子级，
  // 用 `> .rail-item` 排除，保持既有「仅入口」口径。
  return [
    ...document.querySelectorAll(
      ".rail-items .rail-item .rail-label, .rail-foot > .rail-item .rail-label",
    ),
  ].map(
    (el) => el.textContent ?? "",
  );
}

const switchFor = (label: string) =>
  screen.getByRole("switch", { name: `${label}导航入口显示` });

beforeEach(() => {
  installBackend();
  bridge.settings = { ...BASE, navigation_layout: defaultNavigationLayout() };
  useSettingsStore.setState({ settings: bridge.settings as never, materialInfo: null });
  useUiStore.setState({ tab: "tasks", collectionSub: "inbox" });
  useTasksStore.setState({
    stats: { pending: 0, overdue: 0, due_today: 0, completed_today: 0, next_due_at: null } as never,
  });
  useActionsStore.setState({
    feed: {
      enabled: true,
      generated_at: "2026-11-04T00:00:00Z",
      counts: { total: 0, intervention: 0, running: 0, reminder: 0 },
      items: [],
    } as never,
  });
  useCaptureStore.setState({ items: [], filter: "inbox", loading: false, error: null, inboxCount: 0 });
});

afterEach(() => {
  cleanup();
  bridge.updateSettings.mockReset();
  useSettingsStore.setState({ settings: null, materialInfo: null });
});

describe("导航显隐 · 主内容区始终有效", () => {
  it("隐藏任意普通入口：侧栏更新、主内容区仍在、mode 不变", async () => {
    const user = userEvent.setup();
    renderAll();
    expect(railLabels()).toHaveLength(11);
    expectContentAlive();
    expect(screen.getByText("tasks-panel")).toBeTruthy();

    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(10));
    expect(railLabels()).not.toContain("应用");
    expectContentAlive();
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
    // 「更多」成为隐藏入口的再入口
    expect(screen.getByRole("button", { name: "更多导航入口" })).toBeTruthy();

    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(11));
    expectContentAlive();
    expect(screen.queryByRole("button", { name: "更多导航入口" })).toBeNull();
  });

  it("快速连续切换多个入口：最后一次配置生效，界面不丢（含 20 次往返）", async () => {
    renderAll();
    const names = ["应用", "微件", "行动", "剪贴板", "工作流", "历史", "规划中心"];
    // 仍走真实 React 事件与串行写入链，但用 fireEvent + 一次确定性冲刷代替 userEvent：
    // 指针事件模拟在并发跑全量套件时会把 5s 用例预算耗光，超时后未落地的写入还会
    // 污染后续用例的导航配置（表现为「侧栏少一项」）。两次点击之间仍等一次写入落地，
    // 与真实用户「快速连续点击」的渲染节奏一致。
    const flushWrite = async () => {
      await act(async () => {
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
    };
    for (const name of names) {
      for (let i = 0; i < 2; i += 1) {
        fireEvent.click(switchFor(name));
        await flushWrite();
      }
    }
    await waitFor(() => expect(railLabels()).toHaveLength(11));
    expectContentAlive();
    const layout = useSettingsStore.getState().settings?.navigation_layout as {
      left: string[];
      version: number;
    };
    expect(layout.version).toBe(1);
    expect(layout.left).toHaveLength(11);
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
    expect(useSettingsStore.getState().settings?.theme).toBe("dark");
    expect(useSettingsStore.getState().settings?.material).toBe("solid");
  });

  it("完整面板与胶囊配置互相独立，切换配置不影响主内容区", async () => {
    const user = userEvent.setup();
    renderAll();

    await user.click(screen.getByRole("button", { name: "停靠胶囊" }));
    await user.click(switchFor("应用"));
    await waitFor(() => {
      const layout = useSettingsStore.getState().settings?.navigation_layout as {
        left: string[];
        capsule: string[];
      };
      expect(layout.capsule).not.toContain("apps");
      expect(layout.left).toContain("apps");
    });
    // 胶囊配置变化不改变完整面板侧栏
    expect(railLabels()).toHaveLength(11);
    expectContentAlive();
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
  });

  it("隐藏当前逻辑页对应的入口：自动切到安全页，内容区不空白", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "apps" });
    renderAll();
    expect(await screen.findByText("apps-panel")).toBeTruthy();

    await user.click(switchFor("应用"));
    await waitFor(() => expect(useUiStore.getState().tab).toBe("tasks"));
    expect(screen.getByText("tasks-panel")).toBeTruthy();
    expectContentAlive();
    expect(railLabels()).toHaveLength(10);
  });

  it("隐藏页仍可从「更多」访问，且不会临时插回侧栏", async () => {
    const user = userEvent.setup();
    renderAll();
    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(10));

    await user.click(screen.getByRole("button", { name: "更多导航入口" }));
    const item = await screen.findByRole("menuitemradio", { name: /应用/ });
    await user.click(item);
    expect(useUiStore.getState().tab).toBe("apps");
    expect(await screen.findByText("apps-panel")).toBeTruthy();
    // 打开隐藏页不改变配置：侧栏仍是 10 项，「更多」呈当前页选中态
    expect(railLabels()).toHaveLength(10);
    expect(
      screen.getByRole("button", { name: "更多导航入口" }).getAttribute("aria-current"),
    ).toBe("page");
    expectContentAlive();
  });

  it("恢复默认配置：侧栏恢复全部入口，不触发空白", async () => {
    const user = userEvent.setup();
    renderAll();
    await user.click(switchFor("应用"));
    await user.click(switchFor("微件"));
    await waitFor(() => expect(railLabels()).toHaveLength(9));

    await user.click(screen.getByRole("button", { name: "恢复完整面板默认导航配置" }));
    await waitFor(() => expect(railLabels()).toHaveLength(11));
    expectContentAlive();
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
  });

  it("SQLite 写入失败：就地提示、保留原配置、主内容区仍可操作", async () => {
    const user = userEvent.setup();
    renderAll();
    bridge.updateSettings.mockRejectedValueOnce(new Error("数据库被占用"));

    await user.click(switchFor("应用"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("保存失败");
    // 配置未被修改：开关仍为显示，侧栏 11 项
    expect((switchFor("应用") as HTMLInputElement).checked).toBe(true);
    expect(railLabels()).toHaveLength(11);
    expectContentAlive();
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
  });

  it("重新挂载（等价重启读取已有配置）：保留隐藏状态且主内容区正常", async () => {
    const user = userEvent.setup();
    renderAll();
    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(10));
    const persisted = useSettingsStore.getState().settings?.navigation_layout;
    cleanup();

    // 模拟重启：store 从后端（同一份已写入配置）重新加载
    bridge.settings = { ...BASE, navigation_layout: persisted };
    useSettingsStore.setState({ settings: bridge.settings as never });
    renderAll();
    expect(railLabels()).toHaveLength(10);
    expect(railLabels()).not.toContain("应用");
    expectContentAlive();
  });

  it("深色 / 浅色主题下反复显隐均不出现空白或裁剪", async () => {
    const user = userEvent.setup();
    for (const theme of ["dark", "light"] as const) {
      document.documentElement.dataset.theme = theme;
      useSettingsStore.setState({
        settings: { ...BASE, theme, navigation_layout: defaultNavigationLayout() } as never,
      });
      renderAll();
      await user.click(switchFor("应用"));
      await waitFor(() => expect(railLabels()).toHaveLength(10));
      expectContentAlive();
      await user.click(switchFor("应用"));
      await waitFor(() => expect(railLabels()).toHaveLength(11));
      expectContentAlive();
      cleanup();
    }
    delete document.documentElement.dataset.theme;
  });

  it("导航写入不影响主题 / 材质 / 模式等无关设置（后端完整回包）", async () => {
    const user = userEvent.setup();
    renderAll();
    const before = useSettingsStore.getState().settings!;
    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(10));
    const after = useSettingsStore.getState().settings!;
    expect(after.mode).toBe(before.mode);
    expect(after.theme).toBe(before.theme);
    expect(after.material).toBe(before.material);
    expect(after.snap_display_mode).toBe(before.snap_display_mode);
  });
});
