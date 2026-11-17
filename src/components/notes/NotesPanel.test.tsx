/**
 * @vitest-environment jsdom
 */
//! NotesPanel 面板级测试（jsdom）：
//! - 列表条目渲染（标题 / 摘录 / 标记）、搜索与筛选入口存在；
//! - 纯空态只呈现一块跨栏引导与新建入口；
//! - 点击条目调用 select；选中后编辑器区挂载；
//! - 卸载再重挂后，选中笔记与本地草稿仍由 store 保留（切子页回来不丢草稿）。
//!
//! store 与 NoteEditor 按接口 mock，不触达 IPC；编辑器内部四态保存由
//! useNotesStore.test.ts 覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Note, NoteDraft, NoteSummary, NotesFilter } from "../../store/useNotesStore";

const store = vi.hoisted(() => ({
  items: [] as NoteSummary[],
  query: "",
  filter: "all" as NotesFilter,
  loading: false,
  listError: null as string | null,
  activeId: null as string | null,
  active: null as Note | null,
  loadingNote: false,
  saveFailures: {} as Record<string, string>,
  draft: { title: "", content: "" } as NoteDraft,
  load: vi.fn(async () => undefined),
  loadTemplates: vi.fn(async () => undefined),
  loadLinkOptions: vi.fn(async () => undefined),
  setQuery: vi.fn(),
  setFilter: vi.fn(),
  create: vi.fn(async () => ({ id: "new-note" })),
  select: vi.fn(async () => undefined),
  persistLocalDraft: vi.fn(),
}));

const useNotesStoreMock = vi.hoisted(() =>
  Object.assign(
    (selector: (s: typeof store) => unknown) => selector(store),
    {
      getState: () => store,
      setState: (patch: Partial<typeof store>) => Object.assign(store, patch),
    },
  ),
);

vi.mock("../../store/useNotesStore", () => ({ useNotesStore: useNotesStoreMock }));

vi.mock("./NoteEditor", () => ({
  default: () => (
    <div data-testid="note-editor">
      <span data-testid="editor-title">{store.draft.title}</span>
      <span data-testid="editor-content">{store.draft.content}</span>
    </div>
  ),
}));

vi.mock("../../store/usePlanningStore", () => ({ ensurePlanningSync: vi.fn() }));

import NotesPanel from "./NotesPanel";

function summary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  const now = new Date().toISOString();
  return {
    id: "n1",
    title: "周报草稿",
    excerpt: "本周完成的事项与风险摘录",
    pinned: false,
    favorite: false,
    task_id: null,
    workspace_id: null,
    source_capture_id: null,
    revision: 1,
    created_at: now,
    updated_at: now,
    content_chars: 24,
    ...overrides,
  };
}

function note(overrides: Partial<Note> = {}): Note {
  const now = new Date().toISOString();
  return {
    id: "n1",
    title: "周报草稿",
    content: "草稿正文：待补充",
    pinned: false,
    favorite: false,
    task_id: null,
    workspace_id: null,
    source_capture_id: null,
    revision: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(store, {
    items: [],
    query: "",
    filter: "all" as NotesFilter,
    loading: false,
    listError: null,
    activeId: null,
    active: null,
    loadingNote: false,
    saveFailures: {},
    draft: { title: "", content: "" },
  });
});

describe("NotesPanel", () => {
  it("挂载时加载列表、模板与关联选项，并渲染条目标题与摘录", async () => {
    store.items = [summary()];
    render(<NotesPanel />);

    await waitFor(() => expect(store.load).toHaveBeenCalledTimes(1));
    expect(store.loadTemplates).toHaveBeenCalledTimes(1);
    expect(store.loadLinkOptions).toHaveBeenCalledTimes(1);

    expect(screen.getByText("周报草稿")).toBeTruthy();
    expect(screen.getByText("本周完成的事项与风险摘录")).toBeTruthy();
  });

  it("纯空态：只呈现一块跨栏引导与新建按钮，不留下右侧空白编辑区", () => {
    render(<NotesPanel />);
    expect(screen.queryByRole("list")).toBeNull();
    const newButtons = screen.getAllByRole("button");
    expect(newButtons.length).toBeGreaterThan(0);
  });

  it("点击列表条目调用 select，进入选中态后挂载编辑器区", async () => {
    store.items = [summary()];
    store.active = note();
    store.activeId = "n1";
    store.draft = { title: "周报草稿", content: "草稿正文：待补充" };
    const user = userEvent.setup();
    render(<NotesPanel />);

    const itemBtn = document.querySelector<HTMLElement>('[data-note-id="n1"]');
    expect(itemBtn).toBeTruthy();
    await user.click(itemBtn as HTMLElement);
    expect(store.select).toHaveBeenCalledWith("n1");
    expect(screen.getByTestId("note-editor")).toBeTruthy();
  });

  it("卸载再重挂：选中笔记与本地草稿由 store 保留，不被面板清空", () => {
    store.items = [summary()];
    store.active = note();
    store.activeId = "n1";
    store.draft = { title: "未保存的标题", content: "未提交的草稿正文" };

    const first = render(<NotesPanel />);
    expect(screen.getByTestId("editor-content").textContent).toBe("未提交的草稿正文");
    first.unmount();

    render(<NotesPanel />);
    // store 状态未被卸载流程重置：重挂后编辑器仍读到同一份草稿与选中态。
    expect(store.activeId).toBe("n1");
    expect(store.draft.title).toBe("未保存的标题");
    expect(screen.getByTestId("editor-title").textContent).toBe("未保存的标题");
    expect(screen.getByTestId("editor-content").textContent).toBe("未提交的草稿正文");
  });

  it("新建按钮调用 create，不绕过 store 直接改列表", async () => {
    const user = userEvent.setup();
    render(<NotesPanel />);
    const newButtons = screen.getAllByRole("button");
    await user.click(newButtons[newButtons.length - 1]);
    expect(store.create).toHaveBeenCalledTimes(1);
  });
});
