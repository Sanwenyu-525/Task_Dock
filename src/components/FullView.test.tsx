/**
 * @vitest-environment jsdom
 */
//! 完整模式左侧导航（v0.8：收集箱+暂存架合并为「收集与暂存」单一视觉入口）：
//! - 注册的 12 个视觉入口中，新配置默认显示 11 个（帮助默认隐藏）；
//! - 逻辑 Tab 仍是 10 个（Ctrl+5=快速收集、Ctrl+6=文件暂存），视觉合并不改快捷键；
//! - v0.10 新增「应用」入口（Agent 之后、行动之前），不占 Ctrl+数字；
//! - v0.11 注册「帮助」入口（规划中心之后、设置之前），旧配置可见，新配置默认隐藏；
//! - 徽标直接复用任务统计 / 行动中心 / 收集箱未处理计数，不新造计数；
//! - 顶部入口切到任务页并聚焦快速添加；
//! - 「收集箱」位于剪贴板之后、历史之前；「规划中心」位于历史之后、设置之前。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 面板本身有独立测试，这里只验证导航结构，避免加载全部业务依赖
vi.mock("./tasks/TasksPanel", () => ({ default: () => <div>tasks-panel</div> }));
vi.mock("./agents/AgentPanel", () => ({ default: () => <div>agents-panel</div> }));
vi.mock("./apps/AppsPanel", () => ({ default: () => <div>apps-panel</div> }));
vi.mock("./widgets/WidgetsPanel", () => ({ default: () => <div>widgets-panel</div> }));
vi.mock("./actions/ActionCenterPanel", () => ({ default: () => <div>actions-panel</div> }));
vi.mock("./clipboard/ClipboardPanel", () => ({ default: () => <div>clipboard-panel</div> }));
vi.mock("./inbox/CaptureInboxPanel", () => ({ default: () => <div>inbox-panel</div> }));
vi.mock("./collection/CollectionPanel", () => ({ default: () => <div>collection-panel</div> }));
vi.mock("./workflows/WorkflowsPanel", () => ({ default: () => <div>workflows-panel</div> }));
vi.mock("./history/HistoryPanel", () => ({ default: () => <div>history-panel</div> }));
vi.mock("./roadmap/PlanningCenterPanel", () => ({ default: () => <div>roadmap-panel</div> }));
vi.mock("./help/HelpCenterPanel", () => ({ default: () => <div>help-panel</div> }));
vi.mock("./settings/SettingsPanel", () => ({ default: () => <div>settings-panel</div> }));

import FullView from "./FullView";
import { useUiStore } from "../store/useUiStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { allEntryIds } from "../lib/navigationRegistry";
import { __resetLocaleForTests, setLocalePreference } from "../i18n";

/** 写入一份指定左侧可见入口的导航配置（known 覆盖当前全部入口，确保其余为「用户隐藏」）。 */
function seedLeftLayout(left: string[]) {
  useSettingsStore.setState({
    settings: {
      ...(useSettingsStore.getState().settings ?? {}),
      navigation_layout: {
        version: 1,
        left,
        capsule: [],
        known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
      },
    } as never,
  });
}

function seedCounts() {
  useUiStore.setState({ tab: "tasks", quickAddToken: 0 });
  useTasksStore.setState({
    stats: { pending: 3, overdue: 1, due_today: 2, completed_today: 0, next_due_at: null },
  });
  useActionsStore.setState({
    feed: {
      enabled: true,
      generated_at: "2026-10-30T00:00:00Z",
      counts: { total: 2, intervention: 1, running: 1, reminder: 0 },
      items: [],
    } as never,
  });
  useCaptureStore.setState({ items: [], filter: "inbox", loading: false, error: null, inboxCount: 2 });
}

beforeEach(seedCounts);
afterEach(cleanup);

describe("完整模式左侧导航", () => {
  /** 导航项的可访问名是「标签（徽标数）」，用正则匹配标签部分。 */
  const navItem = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

  it("默认渲染十一个导航入口并隐藏帮助，保留顶部新建按钮（收集箱+暂存架合并）", () => {
    render(<FullView />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav).toBeTruthy();
    for (const label of ["任务", "Agent", "应用", "微件", "行动", "剪贴板", "收集与暂存", "工作流", "历史", "规划中心", "设置"]) {
      expect(navItem(label)).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /^帮助/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^暂存架/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^收集箱/ })).toBeNull();
    expect(screen.getByRole("button", { name: "新建任务" })).toBeTruthy();
    expect(nav.firstElementChild?.className).toBe("rail-head");
    expect(nav.lastElementChild?.className).toBe("rail-foot");
    // 设置固定在底部区域，不在中间滚动列表里
    expect(document.querySelector(".rail-items .rail-item-fixed")).toBeNull();
    // 默认任务页
    expect(screen.getByText("tasks-panel")).toBeTruthy();
  });

  it("应用入口位于 Agent 与行动之间，点击后进入应用中心", async () => {
    const user = userEvent.setup();
    render(<FullView />);
    const items = [
      ...document.querySelectorAll(".rail-items .rail-item, .rail-foot > .rail-item"),
    ];
    // aria-label 可能追加徽标说明（如「收集与暂存（2 条待处理收集）」），只比较入口名
    expect(items.map((el) => el.getAttribute("aria-label")?.split("（")[0])).toEqual([
      "任务",
      "Agent",
      "应用",
      "微件",
      "行动",
      "剪贴板",
      "收集与暂存",
      "工作流",
      "历史",
      "规划中心",
      "设置",
    ]);

    await user.click(navItem("应用"));
    expect(await screen.findByText("apps-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("apps");
    expect(navItem("应用").getAttribute("aria-current")).toBe("page");

    await user.click(navItem("微件"));
    expect(await screen.findByText("widgets-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("widgets");
    expect(navItem("微件").getAttribute("aria-current")).toBe("page");
  });

  it("点击导航切换面板，并保留 aria-current 语义", async () => {
    const user = userEvent.setup();
    render(<FullView />);

    await user.click(navItem("历史"));
    expect(await screen.findByText("history-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("history");
    expect(navItem("历史").getAttribute("aria-current")).toBe("page");
    expect(navItem("任务").getAttribute("aria-current")).toBeNull();

    await user.click(navItem("设置"));
    expect(await screen.findByText("settings-panel")).toBeTruthy();
  });

  it("剪贴板是第 4 个入口，点击后进入剪贴板页面", async () => {
    const user = userEvent.setup();
    render(<FullView />);

    await user.click(navItem("剪贴板"));
    expect(screen.getByText("clipboard-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(navItem("剪贴板").getAttribute("aria-current")).toBe("page");
  });

  it("收集与暂存是第 5 个视觉入口：点击默认进入快速收集子页", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ collectionSub: "inbox" });
    render(<FullView />);

    await user.click(navItem("收集与暂存"));
    expect(screen.getByText("collection-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("inbox");
    expect(navItem("收集与暂存").getAttribute("aria-current")).toBe("page");
  });

  it("inbox 与 shelf 两个逻辑 Tab 都激活同一视觉入口；点击合并入口回到上次子页", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "shelf", collectionSub: "shelf" });
    render(<FullView />);

    expect(screen.getByText("collection-panel")).toBeTruthy();
    expect(navItem("收集与暂存").getAttribute("aria-current")).toBe("page");

    // 点击合并入口打开「上一次的子页」（collectionSub=shelf → tab 回 shelf）
    await user.click(navItem("收集与暂存"));
    expect(useUiStore.getState().tab).toBe("shelf");
  });

  it("规划中心位于历史之后、设置之前，点击后渲染规划面板（Tab 身份仍为 roadmap）", async () => {
    const user = userEvent.setup();
    render(<FullView />);

    await user.click(navItem("规划中心"));
    expect(await screen.findByText("roadmap-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("roadmap");
    expect(navItem("规划中心").getAttribute("aria-current")).toBe("page");
    expect(navItem("历史").getAttribute("aria-current")).toBeNull();
  });

  it("帮助入口位于规划中心之后、设置之前，点击后渲染帮助中心（不占 Ctrl+数字）", async () => {
    const user = userEvent.setup();
    // 旧用户的显式可见设置保持有效。
    seedLeftLayout(allEntryIds("left"));
    render(<FullView />);

    await user.click(navItem("帮助"));
    expect(await screen.findByText("help-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("help");
    expect(navItem("帮助").getAttribute("aria-current")).toBe("page");
    expect(navItem("规划中心").getAttribute("aria-current")).toBeNull();
  });

  it("徽标复用任务统计、行动中心计数与收集箱未处理数", () => {
    render(<FullView />);
    // 任务 3、Agent 需介入 1、行动总数 2、收集箱未处理 2
    const badges = [...document.querySelectorAll(".rail-badge")].map((b) => b.textContent);
    expect(badges).toContain("3");
    expect(badges).toContain("1");
    expect(badges).toContain("2");
    // 顺序跟随视觉入口：任务、Agent、行动、收集与暂存（徽标=待处理收集，不含暂存条目）
    expect(badges).toEqual(["3", "1", "2", "2"]);
  });

  it("顶部新建任务入口：切回任务页并触发聚焦信号", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "settings" });
    render(<FullView />);

    const before = useUiStore.getState().quickAddToken;
    await user.click(screen.getByRole("button", { name: "新建任务" }));
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().quickAddToken).toBe(before + 1);
  });

  it("行动中心关闭时不显示行动徽标（与行动中心口径一致）", () => {
    useActionsStore.setState({
      feed: {
        enabled: false,
        generated_at: "2026-10-30T00:00:00Z",
        counts: { total: 9, intervention: 9, running: 0, reminder: 0 },
        items: [],
      } as never,
    });
    render(<FullView />);
    const badges = [...document.querySelectorAll(".rail-badge")].map((b) => b.textContent);
    // 行动中心关闭：intervention 与 attention 都归零，只剩任务徽标与收集箱未处理徽标
    expect(badges).toEqual(["3", "2"]);
  });
});

// 导航显隐与排序（统一导航架构）：隐藏入口从侧栏移除，但仍可从「更多」重新打开；
// 当前页即使被隐藏也不插回侧栏，选中态由「更多」承担，避免布局跳动。
describe("导航显隐", () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: null });
    sessionStorage.clear();
  });

  it("隐藏入口从侧栏移除，可从「更多」重新打开且不插回侧栏", async () => {
    const user = userEvent.setup();
    seedLeftLayout(allEntryIds("left").filter((id) => id !== "apps"));
    render(<FullView />);

    // 侧栏不再有「应用」入口，但出现「更多」再入口
    expect(screen.queryByRole("button", { name: "应用" })).toBeNull();
    const more = screen.getByRole("button", { name: "更多导航入口" });
    await user.click(more);
    // 当前页未打开时菜单项不勾选
    expect(screen.getByRole("menuitemradio", { name: "应用" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await user.click(screen.getByRole("menuitemradio", { name: "应用" }));

    // 隐藏只影响侧栏：页面照常渲染，但**图标绝不临时插回**，其余图标位置不动
    expect(useUiStore.getState().tab).toBe("apps");
    expect(await screen.findByText("apps-panel")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "应用" })).toBeNull();
    // 选中态改由「更多」承担：按钮标记为当前页，菜单内该项处于勾选状态
    expect(more.getAttribute("aria-current")).toBe("page");
  });

  it("当前页被隐藏时「更多」保持持久选中态，菜单项显示当前状态", async () => {
    const user = userEvent.setup();
    seedLeftLayout(allEntryIds("left").filter((id) => id !== "apps"));
    useUiStore.setState({ tab: "apps" });
    render(<FullView />);

    const more = screen.getByRole("button", { name: "更多导航入口" });
    expect(more.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: "应用" })).toBeNull();

    await user.click(more);
    expect(
      screen.getByRole("menuitemradio", { name: "应用" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("按配置顺序渲染；「设置」锁定入口即使缺失也补回底部", () => {
    // 把剪贴板排到最前，并从配置中删掉「设置」模拟旧数据/损坏数据。
    const ids = allEntryIds("left").filter((id) => id !== "settings" && id !== "clipboard");
    seedLeftLayout(["clipboard", ...ids]);
    render(<FullView />);

    const labels = [...document.querySelectorAll(".rail-items .rail-label")].map(
      (node) => node.textContent,
    );
    expect(labels[0]).toBe("剪贴板");
    // 锁定入口不可隐藏：归一化后自动补回，并渲染在固定底部区域（不在滚动列表）
    const settingsButton = screen.getByRole("button", { name: "设置" });
    expect(settingsButton).toBeTruthy();
    expect(settingsButton.closest(".rail-foot")).toBeTruthy();
    expect(labels).not.toContain("设置");
    // 底部区域：设置是最后一个条目
    const footLabels = [...document.querySelectorAll(".rail-foot > .rail-item .rail-label")].map(
      (node) => node.textContent,
    );
    expect(footLabels).toEqual(["设置"]);
    // 未隐藏项不会出现在「更多」
    expect(screen.queryByRole("button", { name: "更多导航入口" })).toBeNull();
  });

  it("「更多」底部「自定义导航」跳设置页并请求展开导航分区", async () => {
    const user = userEvent.setup();
    seedLeftLayout(allEntryIds("left").filter((id) => id !== "apps"));
    render(<FullView />);

    await user.click(screen.getByRole("button", { name: "更多导航入口" }));
    await user.click(screen.getByRole("menuitem", { name: "自定义导航" }));

    expect(useUiStore.getState().tab).toBe("settings");
    expect(await screen.findByText("settings-panel")).toBeTruthy();
    expect(sessionStorage.getItem("taskdock.settings.reveal.v1")).toBe("navigation");
  });
});


// 英文模式：导航文案、aria-label、提示与计数全部走词典；入口身份/顺序/快捷键不变。
describe("英文导航", () => {
  afterEach(() => {
    __resetLocaleForTests();
    useSettingsStore.setState({ settings: null });
  });

  it("切换英文后导航标签、可访问名与提示即时更新，顺序不变", async () => {
    setLocalePreference("en-US");
    render(<FullView />);

    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(nav).toBeTruthy();
    const labels = [
      ...document.querySelectorAll(".rail-items .rail-label, .rail-foot > .rail-item .rail-label"),
    ].map((node) => node.textContent);
    expect(labels).toEqual([
      "Tasks",
      "Agents",
      "Apps",
      "Widgets",
      "Actions",
      "Clipboard",
      "Capture & Shelf",
      "Workflows",
      "History",
      "Roadmap",
      "Settings",
    ]);

    // 收集与暂存徽标数仍来自未处理计数（2），aria 与提示按英文模板拼接
    const collection = screen.getByRole("button", {
      name: "Capture & Shelf (2)",
    });
    expect(collection.getAttribute("data-tip")).toBe("Capture & Shelf (2 pending captures)");
    // 窄窗只留图标时，可访问名由 aria-label 提供
    expect(collection.getAttribute("aria-label")).toBe("Capture & Shelf (2)");

    const newTask = screen.getByRole("button", { name: "New task" });
    expect(newTask.getAttribute("data-tip")).toBe("New task (Ctrl+K)");
  });

  it("英文模式下切换页面仍按 Tab 身份工作（不依赖文案）", async () => {
    const user = userEvent.setup();
    setLocalePreference("en-US");
    render(<FullView />);

    await user.click(screen.getByRole("button", { name: "Roadmap" }));
    expect(await screen.findByText("roadmap-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("roadmap");
  });

  it("英文模式「更多」菜单与自定义导航文案翻译，隐藏项仍可访问", async () => {
    const user = userEvent.setup();
    setLocalePreference("en-US");
    seedLeftLayout(allEntryIds("left").filter((id) => id !== "apps"));
    render(<FullView />);

    const more = screen.getByRole("button", { name: "More navigation entries" });
    expect(more.getAttribute("data-tip")).toBe("More");
    await user.click(more);
    expect(screen.getByRole("menuitemradio", { name: "Apps" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Customize navigation" }));
    expect(useUiStore.getState().tab).toBe("settings");
  });
});

// ── 侧栏三区域布局（2026-11-05）────────────────────────────────────
// 顶部（新建任务）/ 中间（可排序入口，独立滚动）/ 底部（更多 + 固定设置）。
describe("侧栏固定底部区域", () => {
  it("设置固定底部；「更多」存在时位于设置上方", () => {
    seedLeftLayout(allEntryIds("left").filter((id) => id !== "apps"));
    render(<FullView />);

    const foot = document.querySelector(".rail-foot");
    expect(foot).toBeTruthy();
    const footButtons = [...foot!.querySelectorAll(":scope > .rail-item, :scope > .rail-more .rail-item")];
    const labels = footButtons.map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["更多导航入口", "设置"]);
    // 设置不属于中间滚动列表
    expect(document.querySelector(".rail-items .rail-item-fixed")).toBeNull();
    expect(screen.getByRole("button", { name: "设置" }).closest(".rail-items")).toBeNull();
  });

  it("无隐藏入口时底部只有设置", () => {
    // 显式回到默认布局（同文件前序用例可能注入过自定义配置）
    seedLeftLayout(allEntryIds("left"));
    render(<FullView />);
    const footLabels = [...document.querySelectorAll(".rail-foot > .rail-item, .rail-foot .rail-more .rail-item")].map(
      (el) => el.getAttribute("aria-label"),
    );
    expect(footLabels).toEqual(["设置"]);
  });

  it("排序变化后设置仍在底部，按配置顺序渲染中间列表", () => {
    const ids = allEntryIds("left").filter((id) => id !== "settings" && id !== "history");
    seedLeftLayout([...ids, "history"].filter((id) => id !== "tasks").concat("tasks"));
    render(<FullView />);

    // 中间列表按配置顺序（tasks 被排到末尾）
    const middle = [...document.querySelectorAll(".rail-items .rail-item")].map(
      (el) => el.getAttribute("aria-label")?.split("（")[0],
    );
    expect(middle[middle.length - 1]).toBe("任务");
    expect(middle).not.toContain("设置");
    // 设置仍在固定底部区域
    const settings = screen.getByRole("button", { name: "设置" });
    expect(settings.closest(".rail-foot")).toBeTruthy();
  });

  it("低高度窗口：中间列表独立滚动，设置不在滚动容器内（结构断言）", () => {
    render(<FullView />);
    const scroller = document.querySelector(".rail-items");
    expect(scroller).toBeTruthy();
    // 滚动容器与底部区域是兄弟：设置不受滚动位置影响
    expect(scroller!.nextElementSibling?.className).toBe("rail-foot");
    expect(scroller!.querySelector(".rail-item-fixed")).toBeNull();
  });
});
