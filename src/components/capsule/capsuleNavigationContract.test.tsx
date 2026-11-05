/**
 * @vitest-environment jsdom
 */
//! 胶囊导航契约测试（C 任务）：锁住「注册中心 ↔ 胶囊轨道 ↔ 轻量面板」的接口，
//! 以及「隐藏 / 排序后不出现空白面板或死入口」的可见行为。
//!
//! 覆盖：
//! 1. 胶囊面入口集合与注册中心一致（稳定 ID、分类身份唯一、默认可见/顺序同源）；
//! 2. 每个分类都有可渲染面板（新增分类必须同时补面板，否则编译期/运行期暴露）；
//! 3. Agent 顶部状态球是全局状态入口，不计入分类页签、不参与分类排序；
//! 4. 隐藏当前分类 / 只留状态球 / 全部隐藏时：切换或收起，不展示空面板；
//! 5. 排序与显隐经 `navigationLayout` 持久化，完整面板与胶囊两套配置互不影响。
//!
//! 面板一律用替身：本文件验证导航契约，不重复验证各 Lite 面板的业务行为
//!（那由 `CapsulePanels.test.tsx` 覆盖）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";

vi.mock("../../lib/bridge", () => ({
  createFromQuickAdd: async () => undefined,
  createTask: async () => undefined,
  deleteTask: async () => undefined,
  listTasks: async () => [],
  taskStats: async () => null,
  toggleTask: async () => undefined,
  updateTask: async () => undefined,
  agentSnapshot: async () => ({ sources: [], instances: [], sessions: [], runs: [] }),
  quickCaptureConvertToTask: async () => undefined,
  quickCaptureDelete: async () => undefined,
  quickCaptureList: async () => [],
  quickCaptureMarkHandled: async () => undefined,
  quickCaptureState: async () => ({ draft: null, last_type: "task", inbox_count: 0 }),
  getSettings: async () => null,
  updateSettings: async (patch: unknown) => patch,
  applyWindowMaterial: async () => ({ applied: false, effect: "none", os_version: "" }),
  applyWindowRadius: async () => true,
}));

vi.mock("./TasksLite", () => ({ default: () => <div>tasks-lite</div> }));
vi.mock("./InboxLite", () => ({ default: () => <div>inbox-lite</div> }));
vi.mock("./AgentsLite", () => ({ default: () => <div>agents-lite</div> }));
vi.mock("./ClipboardLite", () => ({ default: () => <div>clipboard-lite</div> }));
vi.mock("./AppsLite", () => ({ default: () => <div>apps-lite</div> }));
vi.mock("../focus/FocusCapsuleBadge", () => ({ default: () => null }));

import CapsuleDock from "./CapsuleDock";
import { CATEGORY_LABELS } from "./CapsuleRail";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useCapsuleStore } from "../../store/useCapsuleStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useCaptureStore } from "../../store/useCaptureStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import {
  NAV_ENTRIES,
  allEntryIds,
  defaultVisibleIds,
  entriesForSurface,
  navEntry,
} from "../../lib/navigationRegistry";
import {
  NAV_LAYOUT_SETTING_KEY,
  NAV_LAYOUT_VERSION,
  type NavLayoutConfig,
} from "../../lib/navVisibility";
import {
  moveNavigationEntry,
  selectNavigationLayout,
  setNavigationEntryVisible,
} from "../../lib/navigationLayout";
import type { CapsuleCategory } from "../../lib/capsuleModel";
import type { Settings } from "../../lib/bridge";

const BASE_SETTINGS = {
  theme: "dark",
  mode: "full",
  material: "solid",
  snap_enabled: true,
  snap_display_mode: "capsule",
} as unknown as Settings;

/** 构造一份合法的导航布局配置（known 为当前注册中心全量）。 */
function layout(capsule: string[], left: string[] = allEntryIds("left")): NavLayoutConfig {
  return {
    version: NAV_LAYOUT_VERSION,
    left,
    capsule,
    known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
  };
}

function useLayout(capsule: string[], left?: string[]) {
  const settings = {
    ...BASE_SETTINGS,
    [NAV_LAYOUT_SETTING_KEY]: layout(capsule, left),
  } as unknown as Settings;
  useSettingsStore.setState({ settings, materialInfo: null });
}

const reveal = vi.fn();
const collapse = vi.fn();

function mount(phase: "docked-hidden" | "docked-revealed" = "docked-revealed") {
  useEdgeSnapStore.setState({
    phase,
    dockedEdge: "left",
    candidateEdge: null,
    reveal,
    collapse,
  });
  return render(<CapsuleDock />);
}

/** 轨道分类按钮的悬停文案（就是分类名），按渲染顺序。 */
function categoryTips(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".cap-nav .cap-btn")).map(
    (el) => el.dataset.tip ?? "",
  );
}

/** 胶囊面全部入口的 ID（注册中心默认顺序）。 */
const CAPSULE_IDS = entriesForSurface("capsule").map((entry) => entry.id);

beforeEach(() => {
  reveal.mockReset();
  collapse.mockReset();
  useCapsuleStore.setState({ active: "tasks" });
  useTasksStore.setState({ stats: null });
  useAgentsStore.setState({ snapshot: null, snapshotError: null });
  useCaptureStore.setState({ inboxCount: 0, inboxCountLoaded: false });
  useLayout(CAPSULE_IDS);
});

afterEach(() => {
  cleanup();
  useEdgeSnapStore.getState().reset();
  useSettingsStore.setState({ settings: null, materialInfo: null });
});

describe("C1 · 注册中心与胶囊入口集合一致", () => {
  it("胶囊面入口唯一，默认可见与默认顺序同源", () => {
    expect(CAPSULE_IDS).toEqual(["agents", "tasks", "inbox", "clipboard", "apps"]);
    expect(defaultVisibleIds("capsule")).toEqual(CAPSULE_IDS);
    // 注册中心里没有任何「只在胶囊出现但没被 entriesForSurface 收录」的孤儿入口
    const declared = NAV_ENTRIES.filter((entry) => entry.surfaces.includes("capsule")).map(
      (entry) => entry.id,
    );
    expect(new Set(declared)).toEqual(new Set(CAPSULE_IDS));
  });

  it("每个胶囊入口都有分类身份，且分类身份不重复（一人一个面板）", () => {
    const categories = CAPSULE_IDS.map((id) => navEntry(id)!.capsuleCategory);
    expect(categories.every(Boolean)).toBe(true);
    expect(new Set(categories).size).toBe(categories.length);
    // 逻辑 Tab 归属与分类身份一致，避免「入口叫 A、面板开 B」
    expect(navEntry("tasks")!.tabs).toEqual(["tasks"]);
    expect(navEntry("inbox")!.tabs).toEqual(["inbox"]);
    expect(navEntry("clipboard")!.tabs).toEqual(["clipboard"]);
    expect(navEntry("apps")!.tabs).toEqual(["apps"]);
    expect(navEntry("agents")!.tabs).toEqual(["agents"]);
  });

  it("每个分类都能打开对应面板（新增分类必须同时补面板映射）", () => {
    const categories = CAPSULE_IDS.map((id) => navEntry(id)!.capsuleCategory!) as CapsuleCategory[];
    for (const category of categories) {
      cleanup();
      useCapsuleStore.setState({ active: category });
      const { container } = mount();
      const panel = container.querySelector(".capsule-panel");
      expect(panel, `分类 ${category} 没有渲染面板`).toBeTruthy();
      expect(panel!.getAttribute("aria-label")).toBe(`${CATEGORY_LABELS[category]}面板`);
      // 面板不是空壳：替身面板必须有内容（禁止「有面板但无内容」的空白态）
      expect(panel!.textContent?.trim()).not.toBe("");
    }
  });
});

describe("C1 · Agent 状态球是全局入口，不是分类页签", () => {
  it("状态球与分类按钮分属两个分组，状态球不在 .cap-nav 里", () => {
    const { container } = mount();
    expect(container.querySelector(".cap-orb")).toBeTruthy();
    expect(container.querySelector(".cap-nav .cap-orb")).toBeNull();
    expect(container.querySelectorAll(".cap-nav .cap-btn").length).toBe(4);
    // 分类里没有「Agent」按钮：Agent 只经状态球直达
    expect(categoryTips(container)).toEqual(["任务", "收集箱", "剪贴板", "应用"]);
    expect(categoryTips(container)).not.toContain(CATEGORY_LABELS.agents);
  });

  it("状态球选中态由 active=agents 表达，分类按钮不参与", () => {
    useCapsuleStore.setState({ active: "agents" });
    const { container } = mount();
    expect(container.querySelector(".cap-orb")!.getAttribute("aria-pressed")).toBe("true");
    for (const btn of container.querySelectorAll(".cap-nav .cap-btn")) {
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("状态球位置固定在轨道端头，不随胶囊排序移动（排序只作用于分类按钮）", () => {
    // 把 Agent 排到最后：状态球仍在端头，分类按钮按用户顺序排列
    useLayout(["tasks", "inbox", "clipboard", "apps", "agents"]);
    const { container } = mount();
    expect(container.querySelector(".cap-orb")).toBeTruthy();
    expect(categoryTips(container)).toEqual(["任务", "收集箱", "剪贴板", "应用"]);
    // 状态球是轨道内的第一个控件，分类组紧随其后
    const rail = container.querySelector(".capsule-rail")!;
    const orb = rail.querySelector(".cap-orb")!;
    const nav = rail.querySelector(".cap-nav")!;
    expect(orb.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("隐藏状态球只影响图标：入口集合里仍保留 agents，选中 agent 面板不受影响", () => {
    useCapsuleStore.setState({ active: "agents" });
    useLayout(["tasks", "inbox", "clipboard", "apps"]);
    const { container } = mount();
    expect(container.querySelector(".cap-orb")).toBeNull();
    expect(container.querySelectorAll(".cap-nav .cap-btn").length).toBe(4);
    // 状态球隐藏后 active=agents 属于「不可见分类」：静默切到仍可见的第一个分类
    expect(useCapsuleStore.getState().active).toBe("tasks");
    expect(container.querySelector(".capsule-panel")!.getAttribute("aria-label")).toBe(
      "任务面板",
    );
  });
});

describe("C1 · 隐藏 / 排序后不出现空白面板与死入口", () => {
  it("隐藏非当前分类：当前面板保持，不闪烁、不重开", () => {
    useCapsuleStore.setState({ active: "tasks" });
    useLayout(["agents", "tasks", "inbox"]);
    const { container } = mount();
    expect(categoryTips(container)).toEqual(["任务", "收集箱"]);
    expect(container.querySelector(".capsule-panel")!.getAttribute("aria-label")).toBe(
      "任务面板",
    );
    expect(useCapsuleStore.getState().active).toBe("tasks");
  });

  it("隐藏当前分类：静默切到仍可见的第一个分类（优先状态球），面板不空白", async () => {
    useCapsuleStore.setState({ active: "clipboard" });
    useLayout(["agents", "tasks", "apps"]);
    const { container } = mount();
    await waitFor(() => expect(useCapsuleStore.getState().active).toBe("agents"));
    expect(container.querySelector(".capsule-panel")!.getAttribute("aria-label")).toBe(
      "Agent面板",
    );
  });

  it("状态球也隐藏时，切到第一个可见分类按钮而不是停在隐藏分类", async () => {
    useCapsuleStore.setState({ active: "clipboard" });
    useLayout(["tasks", "apps"]);
    const { container } = mount();
    await waitFor(() => expect(useCapsuleStore.getState().active).toBe("tasks"));
    expect(container.querySelector(".capsule-panel")!.getAttribute("aria-label")).toBe(
      "任务面板",
    );
  });

  it("只留状态球：仍可停在 Agent 面板，不因分类全隐藏而判空白", async () => {
    useCapsuleStore.setState({ active: "apps" });
    useLayout(["agents"]);
    const { container } = mount();
    await waitFor(() => expect(useCapsuleStore.getState().active).toBe("agents"));
    expect(container.querySelectorAll(".cap-nav .cap-btn").length).toBe(0);
    expect(container.querySelector(".capsule-panel")!.getAttribute("aria-label")).toBe(
      "Agent面板",
    );
  });

  it("全部隐藏：请求收起面板，轨道仍保留「切换为完整面板」作为恢复路径（不死锁）", () => {
    const formSwitch = vi.fn();
    useEdgeSnapStore.setState({ formSwitch });
    useLayout([]);
    const { container } = mount();
    expect(container.querySelector(".cap-orb")).toBeNull();
    expect(container.querySelectorAll(".cap-nav .cap-btn").length).toBe(0);
    // 展开态下没有可用入口 → 收起，而不是显示一个没有入口的面板
    expect(collapse).toHaveBeenCalled();
    // 轨道本身仍是可用控件：形态切换按钮不依赖导航配置
    const form = container.querySelector(".cap-form") as HTMLButtonElement | null;
    expect(form).toBeTruthy();
    act(() => form!.click());
    expect(formSwitch).toHaveBeenCalledWith("full");
  });

  it("折叠态与展开态都不渲染空面板容器（面板只在有分类时可挂载）", () => {
    useLayout([]);
    const { container: open } = mount("docked-revealed");
    // 即使分类全隐藏，面板内容也来自 active（非空），不存在「只有边框没有内容」的 section
    const section = open.querySelector(".capsule-panel");
    expect(section?.textContent?.trim()).not.toBe("");
    cleanup();
    const { container: closed } = mount("docked-hidden");
    expect(closed.querySelector(".capsule-panel")).toBeNull();
  });
});

describe("C1 · 排序与显隐持久化，两套配置互不影响", () => {
  function installWritableSettings() {
    const writes: Record<string, unknown>[] = [];
    const initial = {
      ...BASE_SETTINGS,
      [NAV_LAYOUT_SETTING_KEY]: layout([...CAPSULE_IDS]),
    } as unknown as Settings;
    useSettingsStore.setState({
      settings: initial,
      materialInfo: null,
      update: async (patch) => {
        writes.push(patch as Record<string, unknown>);
        const current = useSettingsStore.getState().settings as unknown as Record<string, unknown>;
        useSettingsStore.setState({ settings: { ...current, ...patch } as unknown as Settings });
      },
    });
    return writes;
  }

  it("隐藏胶囊入口写入 SQLite 设置，左侧配置原样保留", async () => {
    const writes = installWritableSettings();
    await setNavigationEntryVisible("capsule", "apps", false);

    const stored = useSettingsStore.getState().settings![NAV_LAYOUT_SETTING_KEY] as NavLayoutConfig;
    expect(stored.capsule).not.toContain("apps");
    expect(stored.capsule).toEqual(["agents", "tasks", "inbox", "clipboard"]);
    // 完整面板一栏完全未被触碰
    expect(stored.left).toEqual(layout([...CAPSULE_IDS]).left);
    expect(stored.version).toBe(NAV_LAYOUT_VERSION);
    // known 同步为当前注册中心全量，避免下次启动把「刚隐藏的新入口」按默认恢复
    expect(stored.known.capsule).toEqual(allEntryIds("capsule"));
    expect(writes).toHaveLength(1);
    expect(writes[0][NAV_LAYOUT_SETTING_KEY]).toEqual(stored);
  });

  it("胶囊排序持久化：数组顺序即渲染顺序，且不影响左侧顺序", async () => {
    installWritableSettings();
    await moveNavigationEntry("capsule", "inbox", -1);

    const stored = useSettingsStore.getState().settings![NAV_LAYOUT_SETTING_KEY] as NavLayoutConfig;
    expect(stored.capsule).toEqual(["agents", "inbox", "tasks", "clipboard", "apps"]);
    expect(stored.left).toEqual(layout([...CAPSULE_IDS]).left);

    // 重新挂载（等价重启后从后端读回）：顺序仍是用户配置，而非默认顺序
    useSettingsStore.setState({
      settings: {
        ...BASE_SETTINGS,
        [NAV_LAYOUT_SETTING_KEY]: stored,
      } as unknown as Settings,
    });
    cleanup();
    const { container } = mount();
    expect(categoryTips(container)).toEqual(["收集箱", "任务", "剪贴板", "应用"]);
  });

  it("隐藏完整面板入口不影响胶囊入口集合", async () => {
    installWritableSettings();
    await setNavigationEntryVisible("left", "apps", false);

    const stored = useSettingsStore.getState().settings![NAV_LAYOUT_SETTING_KEY] as NavLayoutConfig;
    expect(stored.left).not.toContain("apps");
    expect(stored.capsule).toEqual([...CAPSULE_IDS]);

    // 胶囊轨道仍渲染「应用」分类
    const { container } = mount();
    expect(categoryTips(container)).toContain("应用");
  });

  it("读回的布局经 selectNavigationLayout 归一化后与写入值一致（版本/ID 不漂移）", async () => {
    installWritableSettings();
    await moveNavigationEntry("capsule", "tasks", -1);
    const stored = useSettingsStore.getState().settings![NAV_LAYOUT_SETTING_KEY];
    const selected = selectNavigationLayout(useSettingsStore.getState().settings);
    expect(selected.capsule).toEqual((stored as NavLayoutConfig).capsule);
    expect(selected.left).toEqual((stored as NavLayoutConfig).left);
  });
});
