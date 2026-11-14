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
vi.mock("../help/HelpCenterPanel", () => ({ default: () => <div>help-panel</div> }));
vi.mock("../settings/SettingsPanel", () => ({ default: () => <div>settings-panel</div> }));
// 导航注册表新增的锁定系统页（资源管理/诊断中心）：本文件只验证导航显隐，
// 不加载真实面板，避免与其它任务的面板实现耦合。
vi.mock("../resource/ResourceManagementPanel", () => ({
  default: () => <div>resource-panel</div>,
}));
vi.mock("../diagnostics/DiagnosticsCenterPanel", () => ({
  default: () => <div>diagnostics-panel</div>,
}));

import FullView from "../FullView";
import NavigationVisibilitySection from "./NavigationVisibilitySection";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useActionsStore } from "../../store/useActionsStore";
import { useCaptureStore } from "../../store/useCaptureStore";
import { defaultNavigationLayout } from "../../lib/navVisibility";
import { resetNavOrderIntents } from "../../lib/navOrderIntent";
import { allEntryIds } from "../../lib/navigationRegistry";
import { registerTabGuard } from "../../lib/tabGuard";

const BASE = {
  theme: "dark",
  mode: "full",
  material: "solid",
  visual_preset: "dream-gradient",
  snap_enabled: false,
  snap_display_mode: "capsule",
  actions_enabled: true,
};
const DEFAULT_LEFT_COUNT = defaultNavigationLayout().left.length;

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
  // 排序意图是模块级共享状态：用例之间重置，避免跨用例污染已提交配置。
  resetNavOrderIntents();
  useSettingsStore.setState({ settings: null, materialInfo: null });
});

describe("导航显隐 · 主内容区始终有效", () => {
  it("隐藏任意普通入口：侧栏更新、主内容区仍在、mode 不变", async () => {
    const user = userEvent.setup();
    renderAll();
    expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT);
    expectContentAlive();
    expect(screen.getByText("tasks-panel")).toBeTruthy();

    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));
    expect(railLabels()).not.toContain("应用");
    expectContentAlive();
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
    // 「更多」成为隐藏入口的再入口
    expect(screen.getByRole("button", { name: "更多导航入口" })).toBeTruthy();

    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT));
    expectContentAlive();
    expect(screen.getByRole("button", { name: "更多导航入口" })).toBeTruthy();
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
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT));
    expectContentAlive();
    const layout = useSettingsStore.getState().settings?.navigation_layout as {
      left: string[];
      version: number;
    };
    expect(layout.version).toBe(1);
    expect(layout.left).toHaveLength(DEFAULT_LEFT_COUNT);
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
    expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT);
    expectContentAlive();
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
  });

  it("隐藏当前逻辑页对应的入口：自动切到安全页，内容区不空白", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "apps" });
    renderAll();
    expect(await screen.findByTestId("workbench-handoff-apps")).toBeTruthy();

    await user.click(switchFor("应用"));
    await waitFor(() => expect(useUiStore.getState().tab).toBe("tasks"));
    expect(screen.getByText("tasks-panel")).toBeTruthy();
    expectContentAlive();
    expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1);
  });

  it("设置页隐藏任务后保持挂载：更多可访问，恢复后侧栏回到原状", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "settings" });
    renderAll();

    const fullView = document.querySelector(".full-view");
    const tabContent = document.querySelector(".tab-content");
    expect(await screen.findByText("settings-panel")).toBeTruthy();
    expect(railLabels()[railLabels().length - 1]).toBe("设置");

    const before = useSettingsStore.getState().settings!;
    await user.click(switchFor("任务"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));
    expect(railLabels()).not.toContain("任务");
    expect(railLabels()[railLabels().length - 1]).toBe("设置");
    expect(useUiStore.getState().tab).toBe("settings");
    expect(useSettingsStore.getState().settings?.mode).toBe(before.mode);
    expect(useSettingsStore.getState().settings?.snap_display_mode).toBe(before.snap_display_mode);
    expect(document.querySelector(".full-view")).toBe(fullView);
    expect(document.querySelector(".tab-content")).toBe(tabContent);

    await user.click(screen.getByRole("button", { name: "更多导航入口" }));
    expect(await screen.findByRole("menuitemradio", { name: /任务/ })).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(switchFor("任务"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT));
    expect(railLabels()).toContain("任务");
    expect(railLabels()[railLabels().length - 1]).toBe("设置");
    expect(useUiStore.getState().tab).toBe("settings");
    expect(useSettingsStore.getState().settings?.mode).toBe(before.mode);
    expect(useSettingsStore.getState().settings?.snap_display_mode).toBe(before.snap_display_mode);
    expect(document.querySelector(".full-view")).toBe(fullView);
    expect(document.querySelector(".tab-content")).toBe(tabContent);
    expect(await screen.findByText("settings-panel")).toBeTruthy();
  });

  it("隐藏页仍可从「更多」访问，且不会临时插回侧栏", async () => {
    const user = userEvent.setup();
    renderAll();
    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));

    await user.click(screen.getByRole("button", { name: "更多导航入口" }));
    const item = await screen.findByRole("menuitemradio", { name: /应用/ });
    await user.click(item);
    expect(useUiStore.getState().tab).toBe("apps");
    expect(await screen.findByTestId("workbench-handoff-apps")).toBeTruthy();
    // 打开隐藏页不改变配置：侧栏仍是 10 项，「更多」呈当前页选中态
    expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1);
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
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 2));

    await user.click(screen.getByRole("button", { name: "恢复完整面板默认导航配置" }));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT));
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
    expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT);
    expectContentAlive();
    expect(useSettingsStore.getState().settings?.mode).toBe("full");
  });

  it("重新挂载（等价重启读取已有配置）：保留隐藏状态且主内容区正常", async () => {
    const user = userEvent.setup();
    renderAll();
    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));
    const persisted = useSettingsStore.getState().settings?.navigation_layout;
    cleanup();

    // 模拟重启：store 从后端（同一份已写入配置）重新加载
    bridge.settings = { ...BASE, navigation_layout: persisted };
    useSettingsStore.setState({ settings: bridge.settings as never });
    renderAll();
    expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1);
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
      await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));
      expectContentAlive();
      await user.click(switchFor("应用"));
      await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT));
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
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));
    const after = useSettingsStore.getState().settings!;
    expect(after.mode).toBe(before.mode);
    expect(after.theme).toBe(before.theme);
    expect(after.material).toBe(before.material);
    expect(after.snap_display_mode).toBe(before.snap_display_mode);
  });
});

// ── 隐藏当前入口后的恢复语义（2026-11-06 统一实现）─────────────────────
// 恢复由「导航配置变更」驱动（FullView 唯一实现）：只在当前页所属入口
// 由可见变为隐藏时切一次安全页。主动打开隐藏页不会被重定向；
// 未保存草稿/保存中仍走 setTab 门禁，绝不静默丢弃编辑内容。
describe("隐藏当前入口 · 安全恢复与草稿门禁", () => {
  it("有未保存草稿：不强制切页（pending），确认后才切换", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "apps" });
    const dispose = registerTabGuard({
      id: "test-dirty-editor",
      label: () => "测试编辑器",
      isDirty: () => true,
      isBusy: () => false,
      discard: () => undefined,
    });
    try {
      renderAll();
      await user.click(switchFor("应用"));
      await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));

      // 配置已落库，但页面没有被强制切走（草稿安全）
      expect(useUiStore.getState().tab).toBe("apps");
      await waitFor(() => expect(useUiStore.getState().pendingTab?.tab).toBe("tasks"));
      expect(await screen.findByTestId("workbench-handoff-apps")).toBeTruthy();
      expectContentAlive();

      act(() => useUiStore.getState().confirmPendingTab());
      expect(useUiStore.getState().tab).toBe("tasks");
      expect(screen.getByText("tasks-panel")).toBeTruthy();
      expectContentAlive();
    } finally {
      dispose();
      act(() => useUiStore.getState().cancelPendingTab());
    }
  });

  it("有未保存草稿且用户取消：留在原页，草稿内容不被丢弃", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "apps" });
    const dispose = registerTabGuard({
      id: "test-dirty-editor",
      label: () => "测试编辑器",
      isDirty: () => true,
      isBusy: () => false,
      discard: () => undefined,
    });
    try {
      renderAll();
      await user.click(switchFor("应用"));
      await waitFor(() => expect(useUiStore.getState().pendingTab?.tab).toBe("tasks"));

      act(() => useUiStore.getState().cancelPendingTab());
      expect(useUiStore.getState().tab).toBe("apps");
      expect(await screen.findByTestId("workbench-handoff-apps")).toBeTruthy();
      // 入口已隐藏但页面仍可编辑/保存：不制造无法退出的死路，设置入口仍可达
      expect(railLabels()[railLabels().length - 1]).toBe("设置");
      expectContentAlive();
    } finally {
      dispose();
    }
  });

  it("正在保存：拒绝切换并就地提示，不丢页面也不丢配置", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "apps", toasts: [], toast: null });
    const dispose = registerTabGuard({
      id: "test-busy-editor",
      label: () => "测试编辑器",
      isDirty: () => true,
      isBusy: () => true,
      discard: () => undefined,
    });
    try {
      renderAll();
      await user.click(switchFor("应用"));
      await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));

      expect(useUiStore.getState().tab).toBe("apps");
      const toasts = useUiStore.getState().toasts;
      expect(toasts.some((t) => t.kind === "warning" && t.code === "tab-guard-busy")).toBe(true);
      expect(await screen.findByTestId("workbench-handoff-apps")).toBeTruthy();
      expectContentAlive();
    } finally {
      dispose();
      act(() => useUiStore.setState({ toasts: [], toast: null }));
    }
  });

  it("安全页落在合并入口：保留暂存架子页，不重置回快速收集", async () => {
    const user = userEvent.setup();
    // 任务可见在前、合并入口在后：隐藏当前页（任务）后安全页落在合并入口上
    useSettingsStore.setState({
      settings: {
        ...BASE,
        navigation_layout: {
          version: 1,
          left: ["tasks", "collection", "settings"],
          capsule: [],
          known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
        },
      } as never,
    });
    // 用户上次停在暂存架子页，随后切到了任务页
    useUiStore.setState({ tab: "tasks", collectionSub: "shelf" });
    renderAll();
    expect(await screen.findByText("tasks-panel")).toBeTruthy();

    await user.click(switchFor("任务"));
    await waitFor(() => expect(useUiStore.getState().tab).toBe("shelf"));
    expect(useUiStore.getState().collectionSub).toBe("shelf");
    expectContentAlive();
  });

  it("快速笔记子页：切页恢复后仍停留在笔记子页", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      settings: {
        ...BASE,
        navigation_layout: {
          version: 1,
          left: ["tasks", "collection", "settings"],
          capsule: [],
          known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
        },
      } as never,
    });
    // 笔记子页没有独立逻辑 Tab，由 inbox 承载
    useUiStore.setState({ tab: "tasks", collectionSub: "notes" });
    renderAll();
    expect(await screen.findByText("tasks-panel")).toBeTruthy();

    await user.click(switchFor("任务"));
    await waitFor(() => expect(useUiStore.getState().tab).toBe("inbox"));
    expect(useUiStore.getState().collectionSub).toBe("notes");
    expectContentAlive();
  });

  it("隐藏唯一的普通入口：切到仍可见入口的页面（设置始终可达，不产生空白）", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      settings: {
        ...BASE,
        navigation_layout: {
          version: 1,
          left: ["collection", "settings"],
          capsule: [],
          known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
        },
      } as never,
    });
    useUiStore.setState({ tab: "shelf", collectionSub: "shelf" });
    renderAll();
    expect(await screen.findByText("collection-panel")).toBeTruthy();

    await user.click(switchFor("收集与暂存"));
    // 不再停在刚被隐藏的页面；普通入口全部隐藏时回退到锁定设置页
    await waitFor(() => expect(useUiStore.getState().tab).not.toBe("shelf"));
    expect(useUiStore.getState().tab).toBe("settings");
    expect(document.querySelector(".tab-content")?.textContent ?? "").not.toBe("");
    // 设置入口是锁定入口：隐藏全部普通入口后仍在侧栏底部
    expect(railLabels()[railLabels().length - 1]).toBe("设置");
    expectContentAlive();
  });

  it("主动打开本来就隐藏的页面：后续隐藏其它入口不会把当前页重定向走", async () => {
    const user = userEvent.setup();
    renderAll();
    await user.click(switchFor("应用"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 1));

    // 从「更多」进入隐藏的「应用」页
    await user.click(screen.getByRole("button", { name: "更多导航入口" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /应用/ }));
    expect(useUiStore.getState().tab).toBe("apps");

    // 再隐藏另一个入口：当前页没有「可见 → 隐藏」迁移，不应被重定向
    await user.click(switchFor("微件"));
    await waitFor(() => expect(railLabels()).toHaveLength(DEFAULT_LEFT_COUNT - 2));
    expect(useUiStore.getState().tab).toBe("apps");
    expect(await screen.findByTestId("workbench-handoff-apps")).toBeTruthy();
    expectContentAlive();
  });
});
