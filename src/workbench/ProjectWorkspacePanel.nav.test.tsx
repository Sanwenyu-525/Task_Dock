/**
 * @vitest-environment jsdom
 */
//! 小说工作空间一级/二级导航（2026-11-20）：
//! 七个模块 ID 不删减，只归并为 概览 / 正文 / 设定 / 推进 / 项目设置；
//! 其他类型保持平铺；模块切换仍统一走 switchModule（含正文 flush 门禁）；
//! moduleRequest 继续使用原有模块 ID。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  agentSnapshot: vi.fn(),
}));

const flushStore = vi.hoisted(() => ({
  flush: null as null | (() => Promise<boolean>),
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
          const layout = ctxStore.get().layout as Record<string, unknown>;
          ctxStore.set({ ...ctxStore.get(), layout: { ...layout, activeModule: module } });
          return "ok";
        },
        saveLayout: async (layout: Record<string, unknown>) => {
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

function primaryTabs() {
  return within(screen.getByRole("tablist", { name: "工作空间模块" })).getAllByRole("tab");
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

describe("小说工作空间导航分组", () => {
  it("一级导航固定五个入口，二级只出现在设定 / 推进", async () => {
    renderPanel();
    await waitFor(() =>
      expect(primaryTabs().map((tab) => tab.textContent)).toEqual([
        "概览",
        "正文",
        "设定",
        "推进",
        "项目设置",
      ]),
    );
    // 概览下没有二级导航
    expect(screen.queryByRole("tablist", { name: /子模块$/ })).toBeNull();
  });

  it("点击设定显示人物/世界观，切换二级模块仍走 saveModule", async () => {
    renderPanel();
    fireEvent.click((await screen.findByRole("tab", { name: "设定" })) as HTMLElement);

    const subtabs = await screen.findByRole("tablist", { name: "设定子模块" });
    expect(within(subtabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "人物",
      "世界观",
    ]);
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("characters"));
    expect((ctxStore.get().layout as WorkspaceLayoutConfig).activeModule).toBe("characters");

    fireEvent.click(within(subtabs).getByRole("tab", { name: "世界观" }));
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("worldview"));
    expect((ctxStore.get().layout as WorkspaceLayoutConfig).activeModule).toBe("worldview");
  });

  it("隐藏人物但保留世界观：设定入口仍显示并直接进入世界观", async () => {
    const layout = { ...defaultLayout(WORKSPACE_PROFILES.novel), hiddenModules: ["characters" as const] };
    renderPanel({ layout });

    expect(primaryTabs().map((tab) => tab.textContent)).toContain("设定");
    fireEvent.click(screen.getByRole("tab", { name: "设定" }));

    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("worldview"));
    // 只剩一个可见子模块时不再渲染二级条，但入口本身仍然存在
    expect(screen.queryByRole("tablist", { name: "设定子模块" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "人物" })).toBeNull();
  });

  it("整个分组隐藏后不显示入口", async () => {
    const layout = {
      ...defaultLayout(WORKSPACE_PROFILES.novel),
      hiddenModules: ["characters" as const, "worldview" as const],
    };
    renderPanel({ layout });

    await waitFor(() => expect(primaryTabs().map((tab) => tab.textContent)).toEqual([
      "概览",
      "正文",
      "推进",
      "项目设置",
    ]));
    expect(screen.queryByRole("tab", { name: "设定" })).toBeNull();
  });

  it("推进分组下是写作事项 / 任务关联，任务关联沿用原模块 ID", async () => {
    renderPanel();
    fireEvent.click((await screen.findByRole("tab", { name: "推进" })) as HTMLElement);

    const subtabs = await screen.findByRole("tablist", { name: "推进子模块" });
    expect(within(subtabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "写作事项",
      "任务关联",
    ]);
    fireEvent.click(within(subtabs).getByRole("tab", { name: "任务关联" }));
    await waitFor(() =>
      expect((ctxStore.get().layout as WorkspaceLayoutConfig).activeModule).toBe("links"),
    );
  });

  it("离开正文前必须等 flush：失败则原模块与草稿保留，成功才切换", async () => {
    const layout = {
      ...defaultLayout(WORKSPACE_PROFILES.novel),
      activeModule: "manuscript" as const,
    };
    renderPanel({ layout });
    await screen.findByTestId("manuscript-stub");

    flushStore.flush = vi.fn(async () => false);
    fireEvent.click(screen.getByRole("tab", { name: "设定" }));
    await waitFor(() => expect(flushStore.flush).toHaveBeenCalled());
    expect((ctxStore.get().layout as WorkspaceLayoutConfig).activeModule).toBe("manuscript");
    expect(screen.queryByTestId("creative-stub")).toBeNull();

    flushStore.flush = vi.fn(async () => true);
    fireEvent.click(screen.getByRole("tab", { name: "设定" }));
    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("characters"));
    expect((ctxStore.get().layout as WorkspaceLayoutConfig).activeModule).toBe("characters");
  });

  it("moduleRequest 继续使用原有模块 ID，并落在对应分组", async () => {
    renderPanel({ moduleRequest: { token: 1, module: "worldview" } });

    await waitFor(() => expect(screen.getByTestId("creative-stub").textContent).toBe("worldview"));
    expect(screen.getByRole("tab", { name: "设定" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "世界观" }).getAttribute("aria-selected")).toBe("true");
  });

  it("其他工作空间类型保持平铺导航，没有分组二级条", async () => {
    renderPanel({ kind: "general" });

    await waitFor(() =>
      expect(primaryTabs().map((tab) => tab.textContent)).toEqual(
        WORKSPACE_PROFILES.general.modules.map((module) => module.label),
      ),
    );
    expect(screen.queryByRole("tablist", { name: /子模块$/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: "设定" })).toBeNull();
  });
});
