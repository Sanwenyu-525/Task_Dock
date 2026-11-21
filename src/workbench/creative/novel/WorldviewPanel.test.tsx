/**
 * @vitest-environment jsdom
 */
//! 小说世界观模块（B2）前端测试：列表与类型筛选、空状态五态、归档只读、章节引用展示。

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

import { WorldviewPanel } from "./WorldviewPanel";

const base = {
  projectId: "p1",
  projectName: "小说 A",
  kind: "novel" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const kingdom = {
  id: "w1",
  projectId: "p1",
  kind: "faction" as const,
  name: "艾尔王国",
  description: "北部强权",
  tags: ["人类"],
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const sword = {
  ...kingdom,
  id: "w2",
  kind: "item" as const,
  name: "灰烬之剑",
  description: "传世利器",
  tags: ["武器"],
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
  entityType: "worldview" as const,
  entityId: "w1",
  entityName: "艾尔王国",
  chapterId: "ch1",
  chapterTitle: "第一章",
  note: "",
  createdAt: "2026-11-16T09:00:00+00:00",
};

/** 页面上的「创建类入口」：空态下必须只剩 toolbar 那一个。 */
function createEntries() {
  return screen.queryAllByRole("button", {
    name: /新建设定|创建第一条设定|新建设定条目/,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.novelWorldviewList.mockResolvedValue({ entries: [kingdom, sword] });
  api.novelEntityRefList.mockResolvedValue({ refs: [ref] });
  api.novelChapterList.mockResolvedValue({ chapters: [chapter] });
  api.novelWorldviewSave.mockResolvedValue({ entry: kingdom });
  api.novelWorldviewDelete.mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("WorldviewPanel", () => {
  it("渲染设定列表，选中后展示描述与章节引用", async () => {
    render(<WorldviewPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("艾尔王国");
    expect(screen.getByText("灰烬之剑")).toBeTruthy();

    screen.getByText("艾尔王国").click();
    await waitFor(() => {
      expect(screen.getByDisplayValue("艾尔王国")).toBeTruthy();
    });
    expect(await screen.findByText("北部强权")).toBeTruthy();
    expect(await screen.findByText("第一章")).toBeTruthy();
  });

  it("集合为空时只有 toolbar 一个创建入口，右侧不放大卡片", async () => {
    api.novelWorldviewList.mockResolvedValue({ entries: [] });
    render(<WorldviewPanel {...base} archived={false} onNotice={vi.fn()} />);

    expect(await screen.findByText("还没有世界观设定")).toBeTruthy();
    expect(createEntries()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "新建设定" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清空筛选" })).toBeNull();
  });

  it("空列表点击新建设定即可填写并保存首条设定", async () => {
    const newEntry = { ...kingdom, id: "wnew", name: "新设定" };
    api.novelWorldviewList
      .mockResolvedValueOnce({ entries: [] })
      .mockResolvedValue({ entries: [newEntry] });
    api.novelWorldviewSave.mockResolvedValue({ entry: newEntry });
    const onNotice = vi.fn();
    render(<WorldviewPanel {...base} archived={false} onNotice={onNotice} />);

    await waitFor(() => {
      expect(screen.getByText("还没有世界观设定")).toBeTruthy();
    });
    screen.getByRole("button", { name: "新建设定" }).click();

    const nameInput = await screen.findByLabelText("名称");
    fireEvent.change(nameInput, { target: { value: "新设定" } });
    screen.getByRole("button", { name: "保存设定" }).click();

    await waitFor(() => {
      expect(api.novelWorldviewSave).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ name: "新设定" }),
        null,
      );
    });
    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("新设定"));
    });
  });

  it("类型筛选是普通按钮组：按类型请求后端并暴露 aria-pressed", async () => {
    render(<WorldviewPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("艾尔王国");

    expect(screen.getByRole("group", { name: "按类型筛选" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();

    api.novelWorldviewList.mockClear();
    const itemChip = screen.getByRole("button", { name: "物品道具" });
    expect(itemChip.getAttribute("aria-pressed")).toBe("false");
    itemChip.click();

    await waitFor(() => {
      expect(api.novelWorldviewList).toHaveBeenCalledWith("p1", "item", null);
    });
    expect(itemChip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("有数据但未选择时右侧展示选择提示且不带创建按钮", async () => {
    render(<WorldviewPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("艾尔王国");
    expect(screen.getByText("选择一条设定")).toBeTruthy();
    expect(createEntries()).toHaveLength(1);
  });

  it("筛选无结果时展示清空筛选，点击后同时清空搜索与类型", async () => {
    render(<WorldviewPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("艾尔王国");

    api.novelWorldviewList.mockResolvedValue({ entries: [] });
    fireEvent.change(screen.getByLabelText("搜索设定"), { target: { value: "不存在" } });
    await waitFor(() => {
      expect(api.novelWorldviewList).toHaveBeenCalledWith("p1", null, "不存在");
    });

    screen.getByRole("button", { name: "物品道具" }).click();
    await waitFor(() => {
      expect(api.novelWorldviewList).toHaveBeenCalledWith("p1", "item", "不存在");
    });

    expect(await screen.findByText("没有匹配的设定")).toBeTruthy();
    // 筛选无结果不能退化成首次创建引导。
    expect(screen.queryByText("还没有世界观设定")).toBeNull();

    api.novelWorldviewList.mockClear();
    screen.getByRole("button", { name: "清空筛选" }).click();

    await waitFor(() => {
      expect(api.novelWorldviewList).toHaveBeenCalledWith("p1", null, null);
    });
    expect((screen.getByLabelText("搜索设定") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("加载失败时左侧可重试，右侧不误判为未选择", async () => {
    api.novelWorldviewList
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockResolvedValue({ entries: [kingdom] });
    render(<WorldviewPanel {...base} archived={false} onNotice={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("读取失败");
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("设定列表读取失败，请在左侧重试。")).toBeTruthy();
    expect(screen.queryByText("选择一条设定")).toBeNull();

    screen.getByRole("button", { name: "重试" }).click();
    expect(await screen.findByText("艾尔王国")).toBeTruthy();
    expect(screen.getByText("选择一条设定")).toBeTruthy();
  });

  it("归档项目：新建/保存/删除入口置灰并展示只读原因", async () => {
    render(<WorldviewPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText("艾尔王国");

    expect(
      (screen.getByRole("button", { name: "新建设定" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("归档且集合为空时不存在可点击的创建入口", async () => {
    api.novelWorldviewList.mockResolvedValue({ entries: [] });
    render(<WorldviewPanel {...base} archived onNotice={vi.fn()} />);

    expect(await screen.findByText("还没有世界观设定")).toBeTruthy();
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
    const entries = createEntries();
    expect(entries).toHaveLength(1);
    expect(entries.filter((entry) => !(entry as HTMLButtonElement).disabled)).toHaveLength(0);
  });
});
