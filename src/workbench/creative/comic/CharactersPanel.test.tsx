/**
 * @vitest-environment jsdom
 */
//! 漫剧角色与场景模块（C3）前端测试：列表渲染、选中编辑、归档只读、保存失败可见。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  comicCharacterList: vi.fn(),
  comicCharacterSave: vi.fn(),
  comicCharacterDelete: vi.fn(),
  comicSceneList: vi.fn(),
  comicSceneSave: vi.fn(),
  comicSceneDelete: vi.fn(),
}));

vi.mock("./ipc", () => api);

import { CharactersPanel } from "./CharactersPanel";

const base = {
  projectId: "p1",
  projectName: "测试漫剧",
  kind: "ai_comic" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const character = {
  id: "c1",
  projectId: "p1",
  name: "黑发少年",
  role: "小前锋",
  description: "196cm，25 号球衣",
  refImagePath: "",
  refImageExists: false,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const scene = {
  id: "s1",
  projectId: "p1",
  name: "篮球场",
  description: "室内体育馆",
  refImagePath: "",
  refImageExists: false,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.comicCharacterList.mockResolvedValue({ characters: [character] });
  api.comicSceneList.mockResolvedValue({ scenes: [scene] });
  api.comicCharacterSave.mockResolvedValue({ character });
  api.comicSceneSave.mockResolvedValue({ scene });
  api.comicCharacterDelete.mockResolvedValue({ ok: true });
  api.comicSceneDelete.mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("CharactersPanel", () => {
  it("渲染角色与场景，选中角色后展示档案字段", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("黑发少年");
    expect(screen.getByText("篮球场")).toBeTruthy();

    screen.getByText("黑发少年").click();

    await waitFor(() => {
      expect(screen.getByDisplayValue("黑发少年")).toBeTruthy();
    });
    expect(screen.getByDisplayValue("小前锋")).toBeTruthy();
  });

  it("归档项目：新建入口置灰并展示只读原因", async () => {
    render(<CharactersPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText("黑发少年");

    expect(
      (screen.getByRole("button", { name: "新角色" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "新场景" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("角色保存失败时可见错误提示，不静默吞错", async () => {
    api.comicCharacterSave.mockRejectedValue(new Error("校验失败"));
    const onNotice = vi.fn();
    render(<CharactersPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText("黑发少年");
    screen.getByText("黑发少年").click();
    await screen.findByDisplayValue("黑发少年");

    screen.getByRole("button", { name: "保存角色" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("校验失败");
    });
    expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("校验失败"));
  });
});
