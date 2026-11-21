/**
 * @vitest-environment jsdom
 */
//! 小说工作空间导航（2026-11-20 分组；2026-11-21 无障碍改造）：
//! 一级/二级都是**页内导航**，不是 Tabs——`<nav aria-label>` + `aria-current="page"`，
//! 不再有 `role="tablist"` / `role="tab"` / `aria-selected`。
//! 七个模块 ID 不删减，只归并为 概览 / 正文 / 设定 / 推进 / 项目设置；
//! 其他类型保持平铺；模块切换仍统一走 switchModule（含正文 flush 门禁）；
//! moduleRequest 继续使用原有模块 ID。
//!
//! 键盘契约：Tab 逐个聚焦；Enter / Space 由原生按钮 click 激活；
//! 方向键 / Home / End 只在同一导航容器内移动焦点（循环），不激活模块。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import globalStyles from "../styles.css?raw";

const bridge = vi.hoisted(() => ({
  agentSnapshot: vi.fn(),
}));

const flushStore = vi.hoisted(() => ({
  flush: null as null | (() => Promise<boolean>),
}));

/** 数据层的写入口用 mock 暴露，便于断言「方向键没有触发模块切换/保存」。 */
const moduleApi = vi.hoisted(() => ({
  saveModule: vi.fn(),
  saveLayout: vi.fn(),
}));

const ctxStore = vi.hoisted(() => {
  let snapshot: Record<string, unknown> | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot as Record<string, unknown>,
    set: (next: Record<string, unknown>) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: (next: Record<string, unknown>) => {
      snapshot = next;
      listeners.clear();
    },
  };
});

vi.mock("../lib/bridge", () => bridge);

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => undefined),
}));

vi.mock("./NovelManuscriptPanel", () => ({
  default: ({ registerFlush }: { registerFlush?: (f: (() => Promise<boolean>) | null) => void }) => {
    // 稳定包装：测试可在不重渲染的情况下替换下一次 flush 的返回值。
    registerFlush?.(() => (flushStore.flush ? flushStore.flush() : Promise.resolve(true)));
    return <div data-testid="manuscript-stub" />;
  },
}));

vi.mock("./creative/CreativeModuleHost", () => ({
  default: ({ moduleId }: { moduleId: string }) => (
    <div data-testid="creative-stub">{moduleId}</div>
  ),
}));

vi.mock("../workspace/ProjectWorkspaceExtras", () => ({
  ProjectProgressCard: () => <div data-testid="progress-stub" />,
  ProjectResourcesCard: () => <div data-testid="resources-stub" />,
}));

vi.mock("../workspace/useWorkspaceProjectContext", async () => {
  const React = await import("react");
  return {
    useWorkspaceProjectContext: () => {
      React.useSyncExternalStore(ctxStore.subscribe, ctxStore.get, ctxStore.get);
      const ctx = ctxStore.get();
      return {
        ...ctx,
        reload: async () => undefined,
        saveModule: async (module: string) => {
          moduleApi.saveModule(module);
          const layout = ctxStore.get().layout as Record<string, unknown>;
          ctxStore.set({ ...ctxStore.get(), layout: { ...layout, activeModule: module } });
          return "ok";
        },
        saveLayout: async (layout: Record<string, unknown>) => {
          moduleApi.saveLayout(layout);
          ctxStore.set({ ...ctxStore.get(), layout });
          return "ok";
        },
        addItem: async () => "ok",
        cycleItemStatus: async () => "ok",
        removeItem: async () => "ok",
        addTaskLink: async () => "ok",
        removeTaskLink: async () => "ok",
        lastStaleNotice: null,
        clearStaleNotice: () => undefined,
      };
    },
    useWorkspaceDevContext: () => ({
      status: "idle",
      devProject: null,
      probe: null,
      error: null,
      reason: null,
      refresh: async () => undefined,
    }),
    useWorkspaceTaskPicker: () => ({
      tasks: [],
      loading: false,
      error: null,
      query: "",
      setQuery: () => undefined,
      status: "all",
      setStatus: () => undefined,
      limit: 40,
      canLoadMore: false,
      atWindowLimit: false,
      loadMore: () => undefined,
      reload: () => undefined,
    }),
  };
});

import ProjectWorkspacePanel from "./ProjectWorkspacePanel";
import type { WorkspaceKind } from "../lib/bridge";
import {
  WORKSPACE_PROFILES,
  defaultLayout,
  type WorkspaceLayoutConfig,
  type WorkspaceModuleId,
} from "../workspace/workspaceProfiles";

const project = (kind: WorkspaceKind) => ({
  id: "p1",
  name: "小说项目一",
  kind,
  status: "active" as const,
  rootPath: "D:\\写作\\长篇小说",
  rootExists: true,
  devProjectId: null,
  devProjectExists: false,
  devProjectName: null,
  note: "简介",
  itemCount: 1,
  taskLinkCount: 1,
  createdAt: "2026-11-20T08:00:00+00:00",
  updatedAt: "2026-11-20T09:00:00+00:00",
});

const item = {
  id: "i1",
  projectId: "p1",
  parentId: null,
  title: "第一章推进",
  stage: "章节",
  status: "doing" as const,
  sortOrder: 0,
  metadataJson: "{}",
  createdAt: "2026-11-20T08:00:00+00:00",
  updatedAt: "2026-11-20T08:00:00+00:00",
};

const link = {
  projectId: "p1",
  taskId: "t1",
  title: "写作任务",
  status: "pending",
  priority: 1,
  dueAt: null,
  createdAt: "2026-11-20T08:00:00+00:00",
};

function resetContext(layout: WorkspaceLayoutConfig) {
  ctxStore.reset({
    projectId: "p1",
    status: "ready",
    error: null,
    items: [item],
    links: [link],
    instance: null,
    layout,
    layoutRepaired: false,
  });
}

function renderPanel(options?: {
  kind?: WorkspaceKind;
  layout?: WorkspaceLayoutConfig;
  moduleRequest?: { token: number; module: WorkspaceModuleId } | null;
}) {
  const kind = options?.kind ?? "novel";
  const profile = WORKSPACE_PROFILES[kind];
  resetContext(options?.layout ?? defaultLayout(profile));
  const view = render(
    <ProjectWorkspacePanel
      project={project(kind)}
      devProjects={[]}
      onProjectsChanged={async () => []}
      onSelectProject={() => undefined}
      onRefreshDevProjects={async () => undefined}
      onNavigateWorkbench={() => "pending"}
      onOpenDevWorkbench={() => undefined}
      onCreateProject={() => undefined}
      moduleRequest={options?.moduleRequest ?? null}
      onNotice={() => undefined}
    />,
  );
  return view;
}

function primaryNav() {
  return screen.getByRole("navigation", { name: "工作空间模块" });
}

function primaryItems() {
  return within(primaryNav()).getAllByRole("button");
}

function subNav(label: string) {
  return screen.getByRole("navigation", { name: label });
}

function currentOf(nav: HTMLElement) {
  return within(nav)
    .getAllByRole("button")
    .filter((item) => item.getAttribute("aria-current") === "page")
    .map((item) => item.textContent);
}

function activeModule() {
  return (ctxStore.get().layout as WorkspaceLayoutConfig).activeModule;
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.agentSnapshot.mockResolvedValue({
    live_summary: { running: 0, waiting: 0, failed: 0 },
    runs: [],
    sessions: [],
  });
  flushStore.flush = null;
});

afterEach(() => cleanup());

describe("小说工作空间导航分组（页内导航语义）", () => {
  it("一级导航固定五个入口，且不再使用 Tabs 语义", async () => {
    renderPanel();
    await waitFor(() =>
      expect(primaryItems().map((item) => item.textContent)).toEqual([
        "概览",
        "正文",
        "设定",
        "推进",
        "项目设置",
      ]),
    );
    // 不是 Tabs：入口是普通导航按钮，内容区没有 tabpanel。
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("navigation", { name: /子模块$/ })).toBeNull();
  });

  it("选中态用 aria-current=page：默认概览，切到设定后一级/二级各只有一项", async () => {
    renderPanel();
    await waitFor(() => expect(currentOf(primaryNav())).toEqual(["概览"]));

    fireEvent.click(within(primaryNav()).getByRole("button", { name: "设定" }));

    await waitFor(() => expect(currentOf(primaryNav())).toEqual(["设定"]));
    expect(currentOf(subNav("设定子模块"))).toEqual(["人物"]);
    expect(activeModule()).toBe("characters");
  });

  it("一级键盘：方向键/Home/End 只移动焦点并循环，不切换模块", async () => {
    renderPanel();
    await waitFor(() => expect(primaryItems()).toHaveLength(5));
    const nav = primaryNav();
    const [overview, manuscript, setting, , settings] = primaryItems();

    overview.focus();
    fireEvent.keyDown(nav, { key: "ArrowRight" });
    expect(document.activeElement).toBe(manuscript);
    fireEvent.keyDown(nav, { key: "ArrowRight" });
    expect(document.activeElement).toBe(setting);
    fireEvent.keyDown(nav, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(manuscript);
    fireEvent.keyDown(nav, { key: "Home" });
    expect(document.activeElement).toBe(overview);
    fireEvent.keyDown(nav, { key: "End" });
    expect(document.activeElement).toBe(settings);
    // 循环：最后一项继续向右回到第一项。
    fireEvent.keyDown(nav, { key: "ArrowRight" });
    expect(document.activeElement).toBe(overview);

    // 方向键只移动焦点：模块与保存都没有变化，正文区也没有出现。
    expect(activeModule()).toBe("overview");
    expect(moduleApi.saveModule).not.toHaveBeenCalled();
    expect(screen.queryByTestId("creative-stub")).toBeNull();
  });

  it("二级键盘：方向键只移动焦点，Enter 真正激活当前按钮", async () => {
    const user = userEvent.setup();
    renderPanel();
    fireEvent.click(within(primaryNav()).getByRole("button", { name: "设定" }));
    const nav = await screen.findByRole("navigation", { name: "设定子模块" });
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("characters"));

    const [characters, worldview] = within(nav).getAllByRole("button");
    characters.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(worldview);
    // 焦点移动不等于激活：模块与保存都没变化。
    expect(activeModule()).toBe("characters");
    expect(moduleApi.saveModule).not.toHaveBeenCalledWith("worldview");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(characters);

    // 真正的键盘激活：聚焦世界观后按 Enter（不派发 click）。
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(worldview);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("worldview"));
    expect(activeModule()).toBe("worldview");
    expect(moduleApi.saveModule).toHaveBeenCalledWith("worldview");
  });

  it("Space 真正激活当前按钮，且不触发重复模块切换", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(primaryItems()).toHaveLength(5));
    const setting = within(primaryNav()).getByRole("button", { name: "设定" });
    setting.focus();
    expect(document.activeElement).toBe(setting);

    // Space 激活：一次按键只切换一次，saveModule 只记一次。
    await user.keyboard(" ");
    await waitFor(() => expect(activeModule()).toBe("characters"));
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("characters"));
    expect(moduleApi.saveModule).toHaveBeenCalledTimes(1);
    // 当前项再按 Enter 不应产生第二次切换（switchGroup 对已在组内的入口早退）。
    await user.keyboard("{Enter}");
    expect(moduleApi.saveModule).toHaveBeenCalledTimes(1);
  });

  it("方向键跳过 disabled 入口，Home/End 仍落在可用项", async () => {
    const user = userEvent.setup();
    // 归档等场景可能出现禁用入口：这里直接把「正文」置灰验证 moveNavFocus 的过滤。
    renderPanel();
    await waitFor(() => expect(primaryItems()).toHaveLength(5));
    const [overview, manuscript, setting, , settings] = primaryItems();
    (manuscript as HTMLButtonElement).disabled = true;

    overview.focus();
    await user.keyboard("{ArrowRight}");
    // 跳过禁用的「正文」，直接落到「设定」。
    expect(document.activeElement).toBe(setting);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(overview);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(settings);
    expect(activeModule()).toBe("overview");
  });

  it("焦点环可见：键盘聚焦的导航按钮命中全局 :focus-visible outline 规则", () => {
    // jsdom 不计算样式，按仓库样式守卫惯例用 ?raw 读原文断言焦点环规则存在。
    expect(globalStyles).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    renderPanel();
    const nav = primaryNav();
    const first = within(nav).getAllByRole("button")[0];
    first.focus();
    expect(document.activeElement).toBe(first);
    // 导航按钮不是被抑制 outline 的输入控件，也不是 self-closing 元素。
    expect(first.tagName).toBe("BUTTON");
  });

  it("点击设定显示人物/世界观，切换二级模块仍走 saveModule", async () => {
    renderPanel();
    fireEvent.click(within(primaryNav()).getByRole("button", { name: "设定" }));

    const subtabs = await screen.findByRole("navigation", { name: "设定子模块" });
    expect(within(subtabs).getAllByRole("button").map((item) => item.textContent)).toEqual([
      "人物",
      "世界观",
    ]);
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("characters"));
    expect(activeModule()).toBe("characters");
    expect(moduleApi.saveModule).toHaveBeenCalledWith("characters");

    fireEvent.click(within(subtabs).getByRole("button", { name: "世界观" }));
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("worldview"));
    expect(activeModule()).toBe("worldview");
    expect(currentOf(subtabs)).toEqual(["世界观"]);
  });

  it("隐藏人物但保留世界观：设定入口仍显示并直接进入世界观", async () => {
    const layout = { ...defaultLayout(WORKSPACE_PROFILES.novel), hiddenModules: ["characters" as const] };
    renderPanel({ layout });

    await waitFor(() => expect(primaryItems().map((item) => item.textContent)).toContain("设定"));
    fireEvent.click(within(primaryNav()).getByRole("button", { name: "设定" }));

    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("worldview"));
    // 只剩一个可见子模块时不再渲染二级条，但入口本身仍然存在。
    expect(screen.queryByRole("navigation", { name: "设定子模块" })).toBeNull();
    expect(screen.queryByRole("button", { name: "人物" })).toBeNull();
  });

  it("整个分组隐藏后不显示入口", async () => {
    const layout = {
      ...defaultLayout(WORKSPACE_PROFILES.novel),
      hiddenModules: ["characters" as const, "worldview" as const],
    };
    renderPanel({ layout });

    await waitFor(() =>
      expect(primaryItems().map((item) => item.textContent)).toEqual([
        "概览",
        "正文",
        "推进",
        "项目设置",
      ]),
    );
    expect(screen.queryByRole("button", { name: "设定" })).toBeNull();
  });

  it("推进分组下是写作事项 / 任务关联，任务关联沿用原模块 ID", async () => {
    renderPanel();
    fireEvent.click(within(primaryNav()).getByRole("button", { name: "推进" }));

    const subtabs = await screen.findByRole("navigation", { name: "推进子模块" });
    expect(within(subtabs).getAllByRole("button").map((item) => item.textContent)).toEqual([
      "写作事项",
      "任务关联",
    ]);
    fireEvent.click(within(subtabs).getByRole("button", { name: "任务关联" }));
    await waitFor(() => expect(activeModule()).toBe("links"));
  });

  it("离开正文前必须等 flush：失败则原模块与草稿保留，成功才切换", async () => {
    const layout = {
      ...defaultLayout(WORKSPACE_PROFILES.novel),
      activeModule: "manuscript" as const,
    };
    renderPanel({ layout });
    await screen.findByTestId("manuscript-stub");

    flushStore.flush = vi.fn(async () => false);
    fireEvent.click(within(primaryNav()).getByRole("button", { name: "设定" }));
    await waitFor(() => expect(flushStore.flush).toHaveBeenCalled());
    expect(activeModule()).toBe("manuscript");
    expect(screen.queryByTestId("creative-stub")).toBeNull();

    flushStore.flush = vi.fn(async () => true);
    fireEvent.click(within(primaryNav()).getByRole("button", { name: "设定" }));
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("characters"));
    expect(activeModule()).toBe("characters");
  });

  it("moduleRequest 继续使用原有模块 ID，两级 aria-current 都落在对应入口", async () => {
    renderPanel({ moduleRequest: { token: 1, module: "worldview" } });

    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("worldview"));
    expect(currentOf(primaryNav())).toEqual(["设定"]);
    expect(currentOf(subNav("设定子模块"))).toEqual(["世界观"]);
  });

  it("其他工作空间类型保持平铺导航，没有分组二级条", async () => {
    renderPanel({ kind: "general" });

    await waitFor(() =>
      expect(primaryItems().map((item) => item.textContent)).toEqual(
        WORKSPACE_PROFILES.general.modules.map((module) => module.label),
      ),
    );
    expect(screen.queryByRole("navigation", { name: /子模块$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "设定" })).toBeNull();
  });

  it("布局按钮是普通操作，位于导航容器之外", async () => {
    renderPanel();
    await waitFor(() => expect(primaryNav()).toBeTruthy());

    expect(within(primaryNav()).queryByRole("button", { name: "编辑模块布局" })).toBeNull();
    expect(screen.getByRole("button", { name: "编辑模块布局" })).toBeTruthy();
  });
});
