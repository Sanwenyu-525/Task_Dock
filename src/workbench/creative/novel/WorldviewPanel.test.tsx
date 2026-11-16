/**
 * @vitest-environment jsdom
 */
//! 小说世界观模块（B2）前端测试：列表与类型筛选、归档只读、章节引用展示。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

  it("点击类型筛选会按类型向后端请求", async () => {
    render(<WorldviewPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("艾尔王国");

    api.novelWorldviewList.mockClear();
    screen.getByRole("tab", { name: "物品道具" }).click();

    await waitFor(() => {
      expect(api.novelWorldviewList).toHaveBeenCalledWith("p1", "item");
    });
  });

  it("归档项目：新建/保存/删除入口置灰并展示只读原因", async () => {
    render(<WorldviewPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText("艾尔王国");

    expect(
      (screen.getByRole("button", { name: "新建设定" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });
});
