// @vitest-environment jsdom
//! 工作台首页 v2：无项目可用、真实数据区块、快速操作分发与项目卡打开。
//! 不依赖任何主窗口状态；不测具体问候语（随时间变化）。
//!
//! 2026-11-24 响应式专项补充：
//! - 页头 / 卡片标题行的判据必须是 `.wb-content` **容器查询**，不是窗口宽度
//!   （jsdom 不求值 CSS，这里用 CSS 文本契约锁规则；真实几何由 Playwright 取证）；
//! - 被省略号截断的名称要能查看全文（悬停 + 键盘聚焦，复用全局 `data-tip`）；
//! - 日期走 i18n 格式化，跨午夜后「今日」判定必须重算。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 可变的 store 状态：新用例需要真实任务/工作流行来验证提示与跨日筛选。 */
const h = vi.hoisted(() => ({
  tasks: [] as unknown[],
  stats: { pending: 4, overdue: 1 },
  workflows: [] as unknown[],
}));

beforeEach(() => {
  h.tasks = [];
  h.workflows = [];
});

vi.mock("../store/useTasksStore", () => ({
  useTasksStore: (selector: (state: unknown) => unknown) =>
    selector({ stats: h.stats, tasks: h.tasks }),
}));
vi.mock("../store/useAgentsStore", () => ({
  useAgentsStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: {
        live_summary: { running: 2, waiting: 1, failed: 0 },
        runs: [],
        sessions: [],
      },
      snapshotError: null,
      load: vi.fn(),
    }),
}));
vi.mock("../store/useWorkflowsStore", () => ({
  useWorkflowsStore: (selector: (state: unknown) => unknown) =>
    selector({
      workflows: h.workflows,
      activeRunDetail: null,
      loadWorkflows: vi.fn(() => Promise.resolve()),
      refreshActive: vi.fn(() => Promise.resolve()),
    }),
}));

import WorkbenchHome from "./WorkbenchHome";
import { formatLocalizedDate } from "../i18n/format";
import type { WorkspaceProject } from "../lib/bridge";

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: "p1",
    name: "示例项目",
    kind: "development",
    status: "active",
    rootPath: "D:\\Projects\\demo",
    rootExists: true,
    devProjectId: null,
    devProjectExists: false,
    devProjectName: null,
    note: "",
    itemCount: 3,
    taskLinkCount: 2,
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-14T00:00:00Z",
    ...overrides,
  };
}

function renderHome(overrides: {
  onNavigate?: ReturnType<typeof vi.fn>;
  onSelectProjectAndOpen?: ReturnType<typeof vi.fn>;
  onCreateProject?: ReturnType<typeof vi.fn>;
  onQuickAddTask?: ReturnType<typeof vi.fn>;
  projects?: WorkspaceProject[];
} = {}) {
  return render(
    <WorkbenchHome
      projects={overrides.projects ?? []}
      projectsLoading={false}
      onNavigate={overrides.onNavigate ?? vi.fn()}
      onSelectProjectAndOpen={overrides.onSelectProjectAndOpen ?? vi.fn()}
      onCreateProject={overrides.onCreateProject ?? vi.fn()}
      onQuickAddTask={overrides.onQuickAddTask ?? vi.fn()}
    />,
  );
}

describe("WorkbenchHome", () => {
  it("没有项目也能渲染问候、空态与真实 Agent 计数", () => {
    renderHome();

    expect(screen.getByText(/上午好|下午好|晚上好/)).toBeTruthy();
    expect(screen.getByText(/还没有工作空间项目/)).toBeTruthy();
    expect(screen.getByText(/等待 1/)).toBeTruthy();
    expect(screen.getByText(/失败 0/)).toBeTruthy();
    expect(screen.getByText(/今天没有待办任务/)).toBeTruthy();
    expect(screen.getByText(/还没有登记工作流/)).toBeTruthy();
  });

  it("项目卡点击后交给 shell 选择并打开项目页", () => {
    const onSelectProjectAndOpen = vi.fn();
    renderHome({ onSelectProjectAndOpen, projects: [project()] });

    expect(screen.getByText("示例项目")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /示例项目/ }));
    expect(onSelectProjectAndOpen).toHaveBeenCalledWith("p1");
  });

  it("快速操作宫格分别分发新建任务与新建项目", () => {
    const onQuickAddTask = vi.fn();
    const onCreateProject = vi.fn();
    renderHome({ onQuickAddTask, onCreateProject });

    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));
    expect(onQuickAddTask).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it("导航类宫格与面板「查看全部」走 onNavigate", () => {
    const onNavigate = vi.fn();
    renderHome({ onNavigate });

    fireEvent.click(screen.getByRole("button", { name: /启动工作流/ }));
    expect(onNavigate).toHaveBeenCalledWith("workflows");

    fireEvent.click(screen.getByRole("button", { name: /创建 Agent/ }));
    expect(onNavigate).toHaveBeenCalledWith("agents");
  });
});

/* ── 响应式判据：容器查询（2026-11-24） ─────────────────────────────── */

const HOME_CSS = readFileSync(
  resolve(process.cwd(), "src/workbench/workbench.css"),
  "utf8",
);
const HOME_SRC = readFileSync(
  resolve(process.cwd(), "src/workbench/WorkbenchHome.tsx"),
  "utf8",
);

/** 取 `@media/@container` 指令的整块（花括号配对，含嵌套规则）。 */
function directiveBlock(css: string, at: number): string {
  const start = css.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return "";
}

function blocksOf(css: string, prelude: string): string[] {
  const out: string[] = [];
  let at = css.indexOf(prelude);
  while (at >= 0) {
    out.push(directiveBlock(css, at));
    at = css.indexOf(prelude, at + prelude.length);
  }
  return out;
}

/** 去掉注释再扫描指令块：说明文字里会引用 `@media (max-width: 560px)` 本身。 */
const HOME_CSS_RULES = HOME_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("首页页头与卡片标题按内容容器响应", () => {
  const containerBlocks = blocksOf(HOME_CSS_RULES, "@container wb-content (max-width: 560px)");
  const windowBlocks = blocksOf(HOME_CSS_RULES, "@media (max-width: 560px)");

  it("首页专属规则在 wb-content 容器查询里，断点沿用 560", () => {
    expect(containerBlocks.length).toBeGreaterThan(0);
    const joined = containerBlocks.join("\n");
    for (const selector of [
      ".wb-home-head",
      ".wb-home-head-main",
      ".wb-home-date",
      ".wb-home-greeting",
      ".wb-panel-head",
      ".wb-panel-head h3",
      ".wb-panel-more",
    ]) {
      expect(joined, `${selector} 应随内容区宽度响应`).toContain(selector);
    }
  });

  it("窗口级媒体查询不再判断首页（顶栏/搜索/窗口控制仍属窗口级）", () => {
    for (const block of windowBlocks) {
      expect(block).not.toContain(".wb-home-head");
      expect(block).not.toContain(".wb-home-greeting");
      expect(block).not.toContain(".wb-home-date");
      expect(block).not.toContain(".wb-panel-head");
    }
    const last = windowBlocks[windowBlocks.length - 1] ?? "";
    expect(last).toContain(".wb-topbar");
    expect(last).toContain(".wb-window-controls");
    expect(last).toContain(".wb-search-field");
  });

  it("标题可换行、日期可压缩，不用固定宽度硬撑", () => {
    expect(HOME_CSS).toMatch(/\.wb-panel-head h3 \{[^}]*min-width: 0;/);
    expect(containerBlocks.join("\n")).toMatch(
      /\.wb-panel-head h3 \{[^}]*white-space: normal;/,
    );
    expect(HOME_CSS).toMatch(/\.wb-home-date \{[^}]*max-width: 100%;/);
    expect(HOME_CSS).toMatch(/\.wb-home-date-text \{[^}]*overflow-wrap: anywhere;/);
    expect(HOME_CSS).not.toMatch(/\.wb-home-date \{[^}]*width: \d+px/);
    // 窄内容区日期换到第二行（order: 2），不与问候语抢宽度。
    expect(containerBlocks.join("\n")).toMatch(/\.wb-home-date \{[^}]*order: 2;/);
  });

  it("保留首页网格架构，不用 ResizeObserver 代替容器查询", () => {
    expect(HOME_SRC).toContain('className="wb-home-grid ui-adaptive-grid"');
    expect(HOME_SRC).toContain("wb-panel wb-panel--");
    expect(HOME_SRC).not.toContain("ResizeObserver");
    expect(HOME_CSS).toContain("@container wb-content");
    // 宽内容区仍是六列构图（容器 ≥940px）。
    expect(HOME_CSS).toMatch(/@container wb-content \(min-width: 940px\)/);
    expect(HOME_CSS).toMatch(
      /@container wb-content \(max-width: 560px\)[\s\S]*?\.wb-home-grid \{/,
    );
  });
});

/* ── 长内容可查看：截断名称给完整提示 ─────────────────────────────── */

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    title: "示例任务",
    description: "",
    status: "pending",
    priority: 2,
    due_at: null,
    created_at: "2026-11-20T02:00:00Z",
    updated_at: "2026-11-20T02:00:00Z",
    ...overrides,
  };
}

/** jsdom 没有布局：显式模拟「省略号真的截断了」的几何。 */
function fakeClipped(el: HTMLElement, scroll = 480, client = 140) {
  Object.defineProperty(el, "scrollWidth", { value: scroll, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: client, configurable: true });
}

function fakeFits(el: HTMLElement, width = 140) {
  Object.defineProperty(el, "scrollWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
}

describe("首页名称截断提示", () => {
  const LONG = "跨模块对齐的超长名称 / English / C:\\deep\\path\\to\\file.md";

  it("任务行：悬停与键盘聚焦都能看到全名，点击行为不变", () => {
    h.tasks = [task({ id: "t-long", title: LONG })];
    const onNavigate = vi.fn();
    renderHome({ onNavigate });

    const row = document.querySelector(".wb-row") as HTMLButtonElement;
    expect(row).toBeTruthy();
    fakeClipped(row.querySelector(".wb-row-title") as HTMLElement);

    fireEvent.mouseOver(row);
    expect(row.getAttribute("data-tip")).toBe(LONG);

    fireEvent.mouseOut(row);
    expect(row.hasAttribute("data-tip")).toBe(false);

    act(() => row.focus());
    expect(row.getAttribute("data-tip")).toBe(LONG);
    act(() => row.blur());
    expect(row.hasAttribute("data-tip")).toBe(false);

    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("项目卡与工作流：同一套提示，不新增固定宽度", () => {
    h.workflows = [
      {
        id: "w1",
        name: "每日构建与发布流水线（含多环境校验）",
        last_run_at: "2026-11-23T10:00:00Z",
      },
    ];
    renderHome({ projects: [project({ name: LONG })] });

    const card = document.querySelector(".wb-pcard") as HTMLButtonElement;
    fakeClipped(card.querySelector(".wb-pcard-name span") as HTMLElement);
    fireEvent.mouseOver(card);
    expect(card.getAttribute("data-tip")).toBe(LONG);

    const wf = document.querySelector(".wb-wf-row") as HTMLButtonElement;
    fakeClipped(wf.querySelector(".wb-wf-name") as HTMLElement);
    act(() => wf.focus());
    expect(wf.getAttribute("data-tip")).toBe("每日构建与发布流水线（含多环境校验）");
  });

  it("名称完整显示时不挂提示（避免浮层噪声）", () => {
    h.tasks = [task({ id: "t-short", title: "短标题" })];
    renderHome();
    const row = document.querySelector(".wb-row") as HTMLButtonElement;
    fakeFits(row.querySelector(".wb-row-title") as HTMLElement);
    fireEvent.mouseOver(row);
    expect(row.hasAttribute("data-tip")).toBe(false);
  });
});

/* ── 日期本地化与跨午夜 ─────────────────────────────────────────── */

describe("首页日期", () => {
  it("走 Task Dock 的 i18n 格式化，而不是系统默认语言", () => {
    renderHome();
    const text = document.querySelector(".wb-home-date-text")?.textContent ?? "";
    expect(text).toBe(
      formatLocalizedDate(new Date(), {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      }),
    );
    // 组件源码不再直接调用系统 locale 版本。
    expect(HOME_SRC).not.toContain("toLocaleDateString");
  });

  it("跨午夜后日期与「今日」判定都会更新，不用过期快照", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T23:59:00+08:00"));
    h.tasks = [
      task({ id: "t-tonight", title: "今晚交付", due_at: "2026-11-24T18:00:00+08:00" }),
    ];
    renderHome();

    const before = document.querySelector(".wb-home-date-text")?.textContent ?? "";
    expect(before).toContain("2026");
    expect(screen.getByText("今天")).toBeTruthy();

    // 跨过午夜：系统时钟前进 2 分钟，同时触发到下一个整点的 timeout。
    act(() => {
      vi.setSystemTime(new Date("2026-11-25T00:01:00+08:00"));
      vi.advanceTimersByTime(90_000);
    });

    const after = document.querySelector(".wb-home-date-text")?.textContent ?? "";
    expect(after).not.toBe(before);
    expect(after).toContain("25");
    expect(screen.getByText("已逾期")).toBeTruthy();
    expect(screen.queryByText("今天")).toBeNull();
  });
});
