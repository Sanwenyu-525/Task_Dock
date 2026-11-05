// @vitest-environment jsdom
//! 快速笔记 store 测试：防抖自动保存 / 四态 / 失败保留草稿 / 冲突覆盖 /
//! 快速切换不被旧请求覆盖 / 本地草稿恢复 / 删除 / 模板 / 收集箱转笔记。

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  AUTOSAVE_DELAY_MS,
  __resetNotesRuntimeForTests,
  initialNotesState,
  useNotesStore,
  type Note,
} from "./useNotesStore";

vi.mock("../lib/errors", () => ({
  invokeCommand: vi.fn(),
  errorMessage: (error: { message?: string }) => error?.message ?? "未知错误",
  normalizeError: (error: { code?: string; message?: string }) => ({
    code: error?.code ?? "UNKNOWN",
    message: error?.message ?? String(error),
    retryable: false,
  }),
}));

vi.mock("../lib/bridge", () => ({
  listTasks: vi.fn(async () => []),
  workspaceList: vi.fn(async () => []),
}));

import { invokeCommand } from "../lib/errors";

type InvokeArgs = Record<string, unknown>;
type MockedInvoke = Mock<(command: string, args?: InvokeArgs) => Promise<unknown>>;

const invoke = invokeCommand as unknown as MockedInvoke;

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    title: "标题",
    content: "正文",
    pinned: false,
    favorite: false,
    task_id: null,
    workspace_id: null,
    source_capture_id: null,
    revision: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function installFakeBackend(initial: Note[]) {
  const db = new Map(initial.map((item) => [item.id, item]));
  let seq = 0;

  invoke.mockImplementation(async (command: string, rawArgs?: InvokeArgs) => {
    const args = rawArgs ?? {};
    switch (command) {
      case "notes_list":
        return Array.from(db.values()).map((item) => ({
          ...item,
          excerpt: item.content.slice(0, 120),
          content_chars: item.content.length,
        }));
      case "notes_get": {
        const found = db.get(String(args.id));
        if (!found) throw { code: "NOT_FOUND", message: "笔记不存在" };
        return { ...found };
      }
      case "notes_create": {
        seq += 1;
        const created = note({
          id: `new-${seq}`,
          title: "",
          content: "",
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        });
        db.set(created.id, created);
        return { ...created };
      }
      case "notes_update": {
        const id = String(args.id);
        const input = args.input as {
          title: string;
          content: string;
          expectedRevision?: number | null;
          force?: boolean;
        };
        const current = db.get(id);
        if (!current) throw { code: "NOT_FOUND", message: "笔记不存在" };
        if (
          !input.force &&
          input.expectedRevision != null &&
          input.expectedRevision !== current.revision
        ) {
          throw { code: "CONFLICT", message: "笔记已在其他位置更新" };
        }
        const updated: Note = {
          ...current,
          title: input.title,
          content: input.content,
          revision: current.revision + 1,
          updated_at: "2026-01-03T00:00:00Z",
        };
        db.set(id, updated);
        return { ...updated };
      }
      case "notes_set_flags": {
        const id = String(args.id);
        const current = db.get(id);
        if (!current) throw { code: "NOT_FOUND", message: "笔记不存在" };
        const updated: Note = {
          ...current,
          pinned: args.pinned == null ? current.pinned : Boolean(args.pinned),
          favorite: args.favorite == null ? current.favorite : Boolean(args.favorite),
        };
        db.set(id, updated);
        return { ...updated };
      }
      case "notes_set_task": {
        const id = String(args.id);
        const current = db.get(id);
        if (!current) throw { code: "NOT_FOUND", message: "笔记不存在" };
        const updated: Note = { ...current, task_id: (args.taskId as string | null) ?? null };
        db.set(id, updated);
        return { ...updated };
      }
      case "notes_set_workspace": {
        const id = String(args.id);
        const current = db.get(id);
        if (!current) throw { code: "NOT_FOUND", message: "笔记不存在" };
        const updated: Note = {
          ...current,
          workspace_id: (args.workspaceId as string | null) ?? null,
        };
        db.set(id, updated);
        return { ...updated };
      }
      case "notes_delete": {
        const id = String(args.id);
        const deleted = db.delete(id);
        return deleted;
      }
      case "notes_templates":
        return [
          { id: "meeting", name: "会议记录", content: "## 会议记录\n" },
        ];
      case "notes_convert_capture": {
        const captureId = String(args.captureId);
        const existing = Array.from(db.values()).find(
          (item) => item.source_capture_id === captureId,
        );
        if (existing) return { note: { ...existing }, duplicate: true };
        seq += 1;
        const created = note({
          id: `conv-${seq}`,
          title: "收集箱笔记",
          content: "来自收集箱",
          source_capture_id: captureId,
        });
        db.set(created.id, created);
        return { note: { ...created }, duplicate: false };
      }
      default:
        throw { code: "UNKNOWN_COMMAND", message: command };
    }
  });

  return db;
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetNotesRuntimeForTests();
  useNotesStore.setState({ ...initialNotesState });
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  invoke.mockReset();
});

describe("notes store 自动保存", () => {
  it("防抖后才写库，连续输入只保存一次，成功后进入已保存", async () => {
    installFakeBackend([note()]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().select("n1");

    useNotesStore.getState().updateDraft({ content: "一" });
    useNotesStore.getState().updateDraft({ content: "一二" });
    expect(useNotesStore.getState().saveState).toBe("editing");
    expect(useNotesStore.getState().dirty).toBe(true);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "notes_update")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "notes_update")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "notes_update")).toHaveLength(1);

    const state = useNotesStore.getState();
    expect(state.saveState).toBe("saved");
    expect(state.dirty).toBe(false);
    expect(state.draft?.content).toBe("一二");
    expect(state.active?.revision).toBe(2);
    expect(state.savedAt).toBeTruthy();
  });

  it("保存失败保留草稿并标记失败，重试成功后才变为已保存", async () => {
    installFakeBackend([note()]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().select("n1");

    const updateCalls: Array<() => void> = [];
    let shouldFail = true;
    invoke.mockImplementation(async (command: string, rawArgs?: InvokeArgs) => {
      if (command === "notes_update" && shouldFail) {
        throw { code: "DB", message: "磁盘写入失败" };
      }
      updateCalls.push(() => undefined);
      // 回落到本用例的简化后端
      if (command === "notes_get") return { ...note({ content: "正文" }) };
      if (command === "notes_update") {
        const input = rawArgs?.input as { title: string; content: string };
        return { ...note({ title: input.title, content: input.content, revision: 2 }) };
      }
      return null;
    });

    useNotesStore.getState().updateDraft({ title: "标题", content: "未保存内容" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);

    let state = useNotesStore.getState();
    expect(state.saveState).toBe("failed");
    expect(state.conflict).toBe(false);
    expect(state.draft?.content).toBe("未保存内容");
    expect(state.saveError).toContain("写入失败");

    shouldFail = false;
    await useNotesStore.getState().retrySave(false);
    state = useNotesStore.getState();
    expect(state.saveState).toBe("saved");
    expect(state.draft?.content).toBe("未保存内容");
    expect(state.conflict).toBe(false);
  });

  it("并发编辑冲突时停止自动保存并保留草稿，显式覆盖时带 force", async () => {
    installFakeBackend([note()]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().select("n1");

    invoke.mockImplementation(async (command: string, rawArgs?: InvokeArgs) => {
      if (command === "notes_get") {
        return { ...note({ revision: 9, content: "服务器较新内容" }) };
      }
      if (command === "notes_update") {
        const input = rawArgs?.input as { force?: boolean; expectedRevision?: number | null };
        if (!input.force) throw { code: "CONFLICT", message: "笔记已在其他位置更新" };
        return { ...note({ revision: 10, title: "本地标题", content: "本地内容" }) };
      }
      return [];
    });

    useNotesStore.getState().updateDraft({ title: "本地标题", content: "本地内容" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);

    let state = useNotesStore.getState();
    expect(state.saveState).toBe("failed");
    expect(state.conflict).toBe(true);
    expect(state.dirty).toBe(true);
    expect(state.draft?.content).toBe("本地内容");

    // 冲突后继续输入只改内存，不再次自动写库
    const before = invoke.mock.calls.filter(([cmd]) => cmd === "notes_update").length;
    useNotesStore.getState().updateDraft({ content: "本地内容 + 新输入" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "notes_update").length).toBe(before);
    expect(useNotesStore.getState().draft?.content).toBe("本地内容 + 新输入");

    await useNotesStore.getState().retrySave(true);
    state = useNotesStore.getState();
    const forcedCall = invoke.mock.calls.filter(([cmd]) => cmd === "notes_update").at(-1);
    const forcedInput = (forcedCall?.[1] as { input: { force?: boolean; expectedRevision?: number | null } })
      .input;
    expect(forcedInput.force).toBe(true);
    expect(forcedInput.expectedRevision).toBeNull();
    expect(state.saveState).toBe("saved");
  });

  it("冲突后继续输入仍保留冲突入口，放弃本地修改只加载库内最新内容", async () => {
    installFakeBackend([note({ id: "n1", content: "库内正文", revision: 5 })]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().select("n1");
    expect(useNotesStore.getState().active?.revision).toBe(5);

    invoke.mockImplementation(async (command: string) => {
      if (command === "notes_update") {
        throw { code: "CONFLICT", message: "笔记已在其他位置更新" };
      }
      if (command === "notes_get") {
        return { ...note({ id: "n1", content: "远端最新正文", revision: 6 }) };
      }
      return [];
    });

    useNotesStore.getState().updateDraft({ content: "本地未保存内容" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    let state = useNotesStore.getState();
    expect(state.saveState).toBe("failed");
    expect(state.conflict).toBe(true);

    // 继续输入不能把「保存失败 / 冲突」提示与恢复入口藏掉。
    useNotesStore.getState().updateDraft({ content: "本地未保存内容 + 继续输入" });
    state = useNotesStore.getState();
    expect(state.saveState).toBe("failed");
    expect(state.conflict).toBe(true);
    expect(state.draft?.content).toBe("本地未保存内容 + 继续输入");

    // 放弃本地修改：不写库，读取服务端最新版本并清掉本地草稿。
    const updatesBefore = invoke.mock.calls.filter(([cmd]) => cmd === "notes_update").length;
    await useNotesStore.getState().reloadFromServer();
    state = useNotesStore.getState();
    expect(state.draft?.content).toBe("远端最新正文");
    expect(state.active?.revision).toBe(6);
    expect(state.dirty).toBe(false);
    expect(state.saveState).toBe("saved");
    expect(state.conflict).toBe(false);
    expect(localStorage.getItem("taskdock.notes.draft.n1")).toBeNull();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "notes_update").length).toBe(updatesBefore);
  });
});

describe("notes store 切换与恢复", () => {
  it("冲突状态跟随笔记：切走再切回仍保留冲突入口，不自动保存覆盖他人修改", async () => {
    installFakeBackend([
      note({ id: "n1", content: "库内正文", revision: 5 }),
      note({ id: "n2", content: "另一条笔记", revision: 1 }),
    ]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().select("n1");

    invoke.mockImplementation(async (command: string, rawArgs?: InvokeArgs) => {
      if (command === "notes_update") {
        throw { code: "CONFLICT", message: "笔记已在其他位置更新" };
      }
      if (command === "notes_get") {
        if (rawArgs?.id === "n1") {
          return { ...note({ id: "n1", content: "远端最新正文", revision: 6 }) };
        }
        return { ...note({ id: "n2", content: "另一条笔记", revision: 1 }) };
      }
      return [];
    });

    useNotesStore.getState().updateDraft({ content: "本地未保存内容" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    expect(useNotesStore.getState().conflict).toBe(true);

    // 切到另一条再切回：冲突标记与本地草稿都必须保留。
    await useNotesStore.getState().select("n2");
    await useNotesStore.getState().select("n1");
    const state = useNotesStore.getState();
    expect(state.draft?.content).toBe("本地未保存内容");
    expect(state.saveState).toBe("failed");
    expect(state.conflict).toBe(true);
    expect(state.saveError).toContain("其他位置更新");

    // 不自动重试：给足防抖时间也不能产生新的写库请求。
    const updatesBefore = invoke.mock.calls.filter(([cmd]) => cmd === "notes_update").length;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "notes_update").length).toBe(updatesBefore);
    expect(useNotesStore.getState().conflict).toBe(true);
  });

  it("快速切换时立即切换 UI，旧请求完成后只更新列表摘要，不覆盖新笔记", async () => {
    installFakeBackend([
      note({ id: "n1", content: "A 的正文" }),
      note({ id: "n2", content: "B 的正文", revision: 3 }),
    ]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().select("n1");

    let updateCalls = 0;
    let resolveA!: (value: unknown) => void;
    invoke.mockImplementation(async (command: string, rawArgs?: InvokeArgs) => {
      if (command === "notes_update") {
        updateCalls += 1;
        const id = String(rawArgs?.id);
        const input = rawArgs?.input as { title: string; content: string };
        if (updateCalls === 1) {
          return new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        return note({ id, title: input.title, content: input.content, revision: 2 });
      }
      if (command === "notes_get") {
        const id = String(rawArgs?.id);
        return id === "n2"
          ? note({ id: "n2", content: "B 的正文", revision: 3 })
          : note({ id: "n1", content: "A 的正文" });
      }
      return [];
    });

    useNotesStore.getState().updateDraft({ content: "A 的修改" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    expect(useNotesStore.getState().saveState).toBe("saving");

    const switching = useNotesStore.getState().select("n2");
    // 切换不等待 A 的慢写入，UI 立即指向 B。
    expect(useNotesStore.getState().activeId).toBe("n2");

    resolveA(note({ id: "n1", content: "A 的修改", revision: 2 }));
    await switching;
    await vi.advanceTimersByTimeAsync(1);

    const state = useNotesStore.getState();
    expect(state.activeId).toBe("n2");
    expect(state.active?.id).toBe("n2");
    expect(state.draft?.content).toBe("B 的正文");
    expect(state.saveState).toBe("saved");
    expect(state.items.find((item) => item.id === "n1")?.revision).toBe(2);
    expect(localStorage.getItem("taskdock.notes.draft.n1")).toBeNull();
  });

  it("本地残留草稿与库内不同时恢复为未保存状态", async () => {
    installFakeBackend([note({ id: "n1", content: "库内正文" })]);
    await useNotesStore.getState().load();
    localStorage.setItem(
      "taskdock.notes.draft.n1",
      JSON.stringify({ title: "本地标题", content: "本地未保存内容", at: "2026-01-02T00:00:00Z" }),
    );

    await useNotesStore.getState().select("n1");
    const state = useNotesStore.getState();
    expect(state.restored).toBe(true);
    expect(state.dirty).toBe(true);
    expect(state.saveState).toBe("editing");
    expect(state.draft?.title).toBe("本地标题");
    expect(state.draft?.content).toBe("本地未保存内容");

    // 恢复的草稿仍是未保存内容，恢复后自动排一次保存，成功后清除草稿标记
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    expect(useNotesStore.getState().saveState).toBe("saved");
    expect(localStorage.getItem("taskdock.notes.draft.n1")).toBeNull();
  });
});

describe("notes store 其他操作", () => {
  it("新建后立即选中并出现在列表顶部", async () => {
    installFakeBackend([note({ id: "n1" })]);
    await useNotesStore.getState().load();
    const created = await useNotesStore.getState().create();
    const state = useNotesStore.getState();
    expect(state.activeId).toBe(created.id);
    expect(state.items[0].id).toBe(created.id);
  });

  it("筛选或搜索生效时新建笔记不塞进当前列表结果", async () => {
    installFakeBackend([note({ id: "n1", favorite: true })]);
    await useNotesStore.getState().load();
    useNotesStore.getState().setFilter("favorite");
    await vi.advanceTimersByTimeAsync(0);
    const before = useNotesStore.getState().items.length;
    expect(before).toBe(1);

    const created = await useNotesStore.getState().create();
    const state = useNotesStore.getState();
    expect(state.activeId).toBe(created.id);
    expect(state.items.some((item) => item.id === created.id)).toBe(false);
    expect(state.items.length).toBe(before);
  });

  it("删除当前笔记后选中下一条并清理本地草稿", async () => {
    installFakeBackend([
      note({ id: "n1", content: "第一条" }),
      note({ id: "n2", content: "第二条" }),
    ]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().select("n1");
    localStorage.setItem(
      "taskdock.notes.draft.n1",
      JSON.stringify({ title: "", content: "草稿", at: "" }),
    );

    const deleted = await useNotesStore.getState().remove("n1");
    const state = useNotesStore.getState();
    expect(deleted).toBe(true);
    expect(state.items.map((item) => item.id)).toEqual(["n2"]);
    expect(state.activeId).toBe("n2");
    expect(localStorage.getItem("taskdock.notes.draft.n1")).toBeNull();
  });

  it("模板只追加到现有正文，不覆盖内容", async () => {
    installFakeBackend([note({ id: "n1", content: "已有内容" })]);
    await useNotesStore.getState().load();
    await useNotesStore.getState().loadTemplates();
    await useNotesStore.getState().select("n1");

    useNotesStore.getState().applyTemplate("meeting");
    const content = useNotesStore.getState().draft?.content ?? "";
    expect(content).toBe("已有内容\n\n## 会议记录\n");
  });

  it("收集箱转笔记后刷新列表并选中新笔记，重试返回 duplicate", async () => {
    installFakeBackend([note({ id: "n1" })]);
    await useNotesStore.getState().load();
    // 转换前处于搜索 + 收藏筛选：新笔记不属于该结果集，转换后应复位以便可见。
    useNotesStore.getState().setQuery("不存在的关键词");
    useNotesStore.getState().setFilter("favorite");
    await vi.advanceTimersByTimeAsync(0);

    const first = await useNotesStore.getState().convertCapture("cap1");
    expect(first.duplicate).toBe(false);
    expect(useNotesStore.getState().activeId).toBe(first.note.id);
    expect(useNotesStore.getState().items.some((item) => item.id === first.note.id)).toBe(true);
    expect(useNotesStore.getState().query).toBe("");
    expect(useNotesStore.getState().filter).toBe("all");

    const second = await useNotesStore.getState().convertCapture("cap1");
    expect(second.duplicate).toBe(true);
    expect(second.note.id).toBe(first.note.id);
  });
});
