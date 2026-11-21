/**
 * @vitest-environment jsdom
 */
//! 小说人物模块（B2）前端测试：列表渲染、空状态五态、归档只读、保存失败可见。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  novelCharacterList: vi.fn(),
  novelCharacterRelationList: vi.fn(),
  novelCharacterRelationSave: vi.fn(),
  novelCharacterRelationDelete: vi.fn(),
  novelCharacterSave: vi.fn(),
  novelCharacterDelete: vi.fn(),
  novelWorldviewList: vi.fn(),
  novelWorldviewSave: vi.fn(),
  novelWorldviewDelete: vi.fn(),
  novelEntityRefList: vi.fn(),
  novelEntityRefAdd: vi.fn(),
  novelEntityRefDelete: vi.fn(),
  novelChapterList: vi.fn(),
}));

vi.mock("./ipc", () => api);

import { CharactersPanel } from "./CharactersPanel";
import type { NovelCharacter, NovelCharacterRelation } from "./types";

/** 可控 Promise：精确控制 resolve/reject 时机，不依赖随机延时。 */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CharacterListResult = { characters: NovelCharacter[] };
type RelationListResult = { relations: NovelCharacterRelation[] };

const base = {
  projectId: "p1",
  projectName: "小说 A",
  kind: "novel" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const charA = {
  id: "ca",
  projectId: "p1",
  name: "林雷",
  aliases: "雷子",
  intro: "简介",
  appearance: "外貌",
  background: "背景",
  motivation: "动机",
  faction: "阵营",
  status: "active" as const,
  notes: "",
  tags: ["主角"],
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const charB = { ...charA, id: "cb", name: "艾米", status: "unknown" as const, tags: [] };
const relation = {
  id: "r1",
  projectId: "p1",
  fromCharacterId: "ca",
  toCharacterId: "cb",
  relationType: "friend" as const,
  description: "挚友",
  fromName: "林雷",
  toName: "艾米",
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const chapter = {
  id: "ch1",
  projectId: "p1",
  volumeId: null,
  title: "第一章",
  wordCount: 0,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const ref = {
  id: "ref1",
  projectId: "p1",
  entityType: "character" as const,
  entityId: "ca",
  entityName: "林雷",
  chapterId: "ch1",
  chapterTitle: "第一章",
  note: "",
  createdAt: "2026-11-16T09:00:00+00:00",
};

/** 页面上的「创建类入口」：空态下必须只剩 toolbar 那一个。 */
function createEntries() {
  return screen.queryAllByRole("button", {
    name: /新建人物|创建第一个人物|新建人物档案/,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.novelCharacterList.mockResolvedValue({ characters: [charA, charB] });
  api.novelCharacterRelationList.mockResolvedValue({ relations: [relation] });
  api.novelEntityRefList.mockResolvedValue({ refs: [ref] });
  api.novelChapterList.mockResolvedValue({ chapters: [chapter] });
  api.novelCharacterSave.mockResolvedValue({ character: charA });
  api.novelCharacterDelete.mockResolvedValue({ ok: true });
  api.novelCharacterRelationSave.mockResolvedValue({ relation });
  api.novelCharacterRelationDelete.mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("CharactersPanel", () => {
  it("渲染人物列表、选中人物后展示档案、关系与章节引用", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("林雷");
    expect(screen.getByText("艾米")).toBeTruthy();

    screen.getByText("林雷").click();

    await waitFor(() => {
      expect(screen.getByDisplayValue("林雷")).toBeTruthy();
    });
    expect(await screen.findByText(/挚友/)).toBeTruthy();
    expect(await screen.findByText("第一章")).toBeTruthy();
  });

  it("集合为空时只有 toolbar 一个创建入口，右侧不放大卡片", async () => {
    api.novelCharacterList.mockResolvedValue({ characters: [] });
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);

    expect(await screen.findByText("还没有人物")).toBeTruthy();
    expect(createEntries()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "新建人物" })).toBeTruthy();
    // 空集合不是「筛选无结果」，不应出现清空搜索。
    expect(screen.queryByRole("button", { name: "清空搜索" })).toBeNull();
  });

  it("空列表点击新建人物即可填写并保存首条人物", async () => {
    const newChar = { ...charA, id: "cnew", name: "新人物" };
    api.novelCharacterList
      .mockResolvedValueOnce({ characters: [] })
      .mockResolvedValue({ characters: [newChar] });
    api.novelCharacterSave.mockResolvedValue({ character: newChar });
    const onNotice = vi.fn();
    render(<CharactersPanel {...base} archived={false} onNotice={onNotice} />);

    await waitFor(() => {
      expect(screen.getByText("还没有人物")).toBeTruthy();
    });
    screen.getByRole("button", { name: "新建人物" }).click();

    const nameInput = await screen.findByLabelText("姓名");
    fireEvent.change(nameInput, { target: { value: "新人物" } });
    screen.getByRole("button", { name: "保存人物" }).click();

    await waitFor(() => {
      expect(api.novelCharacterSave).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ name: "新人物" }),
        null,
      );
    });
    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("新人物"));
    });
    // 保存后应选中刚创建的人物并打开其表单。
    await waitFor(() => {
      expect(screen.getByDisplayValue("新人物")).toBeTruthy();
    });
  });

  it("有数据但未选择时右侧展示选择提示且不带创建按钮", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("林雷");
    expect(screen.getByText("选择一个人物")).toBeTruthy();
    expect(createEntries()).toHaveLength(1);
  });

  it("搜索无结果时展示清空搜索，点击后清空并重新加载全量", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    api.novelCharacterList.mockResolvedValue({ characters: [] });
    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "无此人物" } });

    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledWith("p1", "无此人物");
    });
    expect(await screen.findByText("没有匹配的人物")).toBeTruthy();
    // 筛选无结果不能退化成首次创建引导。
    expect(screen.queryByText("还没有人物")).toBeNull();

    api.novelCharacterList.mockClear();
    screen.getByRole("button", { name: "清空搜索" }).click();

    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledWith("p1", null);
    });
    expect((screen.getByLabelText("搜索人物") as HTMLInputElement).value).toBe("");
  });

  it("加载失败时左侧可重试，右侧不误判为未选择", async () => {
    api.novelCharacterList
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockResolvedValue({ characters: [charA] });
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("读取失败");
    });
    // 右栏只给紧凑提示，不出现第二个 alert/重试按钮，也不出现「选择一个人物」。
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("人物列表读取失败，请在左侧重试。")).toBeTruthy();
    expect(screen.queryByText("选择一个人物")).toBeNull();

    screen.getByRole("button", { name: "重试" }).click();
    expect(await screen.findByText("林雷")).toBeTruthy();
    expect(screen.getByText("选择一个人物")).toBeTruthy();
  });

  it("归档项目：新建/保存/删除入口全部置灰并展示只读原因", async () => {
    render(<CharactersPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    expect(
      (screen.getByRole("button", { name: "新建人物" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("归档且集合为空时不存在可点击的创建入口", async () => {
    api.novelCharacterList.mockResolvedValue({ characters: [] });
    render(<CharactersPanel {...base} archived onNotice={vi.fn()} />);

    expect(await screen.findByText("还没有人物")).toBeTruthy();
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
    const entries = createEntries();
    expect(entries).toHaveLength(1);
    expect(entries.filter((entry) => !(entry as HTMLButtonElement).disabled)).toHaveLength(0);
  });

  it("保存失败时可见错误提示，不静默吞错", async () => {
    api.novelCharacterSave.mockRejectedValue(new Error("网络异常"));
    const onNotice = vi.fn();
    render(<CharactersPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText("林雷");
    screen.getByText("林雷").click();
    await screen.findByDisplayValue("林雷");

    screen.getByRole("button", { name: "保存人物" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("网络异常");
    });
    expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("网络异常"));
  });

  // ── 3.1 并发隔离 ──────────────────────────────────────────────────────

  it("搜索请求未返回时点击人物，搜索仍能完成", async () => {
    const onNotice = vi.fn();
    render(<CharactersPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText("林雷");
    expect(screen.getByText("艾米")).toBeTruthy();

    // 搜索请求挂起；此时点击人物发出的关系请求使用独立代次，不应作废它。
    const searchList = deferred<CharacterListResult>();
    api.novelCharacterList.mockImplementationOnce(() => searchList.promise);
    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "林" } });
    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledTimes(2);
    });

    screen.getByText("林雷").click();
    expect(await screen.findByText(/挚友/)).toBeTruthy();

    // 搜索结果后到仍被采用，关系也不被搜索请求取消。
    searchList.resolve({ characters: [charA] });
    await waitFor(() => {
      expect(screen.queryByText("艾米")).toBeNull();
    });
    expect(screen.getByText(/挚友/)).toBeTruthy();
    expect(screen.getByDisplayValue("林雷")).toBeTruthy();
  });

  it("两个列表请求逆序返回，只采用最新", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    const d1 = deferred<CharacterListResult>();
    const d2 = deferred<CharacterListResult>();
    api.novelCharacterList
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "A" } });
    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledTimes(2);
    });
    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "B" } });
    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledTimes(3);
    });

    // 后发的先返回、先发的后返回。
    d2.resolve({ characters: [charB] });
    await waitFor(() => {
      expect(screen.queryByText("林雷")).toBeNull();
    });
    d1.resolve({ characters: [charA] });
    await waitFor(() => {
      expect(screen.queryByText("林雷")).toBeNull();
      expect(screen.getByText("艾米")).toBeTruthy();
    });
  });

  it("两个关系请求逆序返回，只采用当前人物关系", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    const dA = deferred<RelationListResult>();
    const dB = deferred<RelationListResult>();
    api.novelCharacterRelationList
      .mockImplementationOnce(() => dA.promise)
      .mockImplementationOnce(() => dB.promise);

    screen.getByText("林雷").click();
    await waitFor(() => {
      expect(api.novelCharacterRelationList).toHaveBeenCalledWith("p1", "ca");
    });
    screen.getByText("艾米").click();
    await waitFor(() => {
      expect(api.novelCharacterRelationList).toHaveBeenCalledWith("p1", "cb");
    });

    // 后发的先返回，先发的后返回。
    dB.resolve({ relations: [{ ...relation, description: "最新关系" }] });
    expect(await screen.findByText(/最新关系/)).toBeTruthy();
    dA.resolve({ relations: [{ ...relation, description: "旧关系" }] });

    await waitFor(() => {
      expect(screen.queryByText(/旧关系/)).toBeNull();
    });
    expect(screen.getByText(/最新关系/)).toBeTruthy();
  });

  it("关系请求失败不影响人物列表", async () => {
    const onNotice = vi.fn();
    api.novelCharacterRelationList.mockRejectedValueOnce(new Error("关系异常"));
    render(<CharactersPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText("林雷");

    screen.getByText("林雷").click();

    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("关系读取失败"));
    });
    // 列表未被关系失败取消（编辑器标题也含「林雷」，用列表行按钮定位）。
    expect(screen.getByRole("button", { name: /林雷/ })).toBeTruthy();
    expect(screen.getByText("艾米")).toBeTruthy();
    expect(screen.queryByText("人物列表读取失败，请在左侧重试。")).toBeNull();
  });

  it("人物列表请求失败不影响关系请求", async () => {
    const onNotice = vi.fn();
    render(<CharactersPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText("林雷");

    const rel = deferred<RelationListResult>();
    api.novelCharacterRelationList.mockImplementationOnce(() => rel.promise);
    screen.getByText("林雷").click();
    await waitFor(() => {
      expect(api.novelCharacterRelationList).toHaveBeenCalledWith("p1", "ca");
    });

    // 搜索让列表失败；关系请求已在途，不应被列表失败取消。
    api.novelCharacterList.mockRejectedValueOnce(new Error("列表异常"));
    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "林" } });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("列表异常");
    });

    rel.resolve({ relations: [relation] });
    expect(await screen.findByText(/挚友/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("列表异常");
  });

  it("切换项目后旧请求返回不能污染新项目", async () => {
    const onNotice = vi.fn();
    const p1 = deferred<CharacterListResult>();
    api.novelCharacterList.mockImplementationOnce(() => p1.promise);
    const { rerender } = render(
      <CharactersPanel {...base} projectId="p1" archived={false} onNotice={onNotice} />,
    );
    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledWith("p1", null);
    });

    api.novelCharacterList.mockResolvedValueOnce({ characters: [charB] });
    rerender(<CharactersPanel {...base} projectId="p2" archived={false} onNotice={onNotice} />);
    expect(await screen.findByText("艾米")).toBeTruthy();

    // 旧项目响应最后返回，必须因项目切换作废而被丢弃。
    p1.resolve({ characters: [charA] });
    await waitFor(() => {
      expect(screen.queryByText("林雷")).toBeNull();
    });
    expect(screen.getByText("艾米")).toBeTruthy();
  });

  // ── 3.2 搜索条件保持 ──────────────────────────────────────────────────

  it("搜索失败后重试保留关键词", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    api.novelCharacterList
      .mockRejectedValueOnce(new Error("搜索失败"))
      .mockResolvedValue({ characters: [charA] });
    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "林" } });
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("搜索失败");
    });

    screen.getByRole("button", { name: "重试" }).click();
    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenLastCalledWith("p1", "林");
    });
    expect(await screen.findByText("林雷")).toBeTruthy();
  });

  it("搜索状态下编辑人物，刷新后仍保留筛选", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "林" } });
    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledWith("p1", "林");
    });

    screen.getByText("林雷").click();
    await screen.findByDisplayValue("林雷");

    const updated = { ...charA, name: "林雷改" };
    api.novelCharacterSave.mockResolvedValue({ character: updated });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "林雷改" } });
    screen.getByRole("button", { name: "保存人物" }).click();

    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenLastCalledWith("p1", "林");
    });
    expect(screen.getByDisplayValue("林雷改")).toBeTruthy();
  });

  it("搜索状态下删除人物，刷新后仍保留筛选", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    fireEvent.change(screen.getByLabelText("搜索人物"), { target: { value: "林" } });
    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenCalledWith("p1", "林");
    });

    screen.getByText("林雷").click();
    await screen.findByDisplayValue("林雷");

    screen.getByRole("button", { name: "删除人物" }).click();
    const confirm = await screen.findByRole("button", { name: "再次点击确认删除" });
    confirm.click();

    await waitFor(() => {
      expect(api.novelCharacterList).toHaveBeenLastCalledWith("p1", "林");
    });
  });
});
