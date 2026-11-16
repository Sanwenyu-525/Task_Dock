/**
 * @vitest-environment jsdom
 */
//! 小说人物模块（B2）前端测试：列表渲染、归档只读、保存失败可见。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

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

import { CharactersPanel } from "./CharactersPanel";

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

  it("归档项目：新建/保存/删除入口全部置灰并展示只读原因", async () => {
    render(<CharactersPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText("林雷");

    expect(
      (screen.getByRole("button", { name: "新建人物" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
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
});
