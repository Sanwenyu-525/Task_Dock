/**
 * @vitest-environment jsdom
 */
//! 漫剧分镜模块（C2）前端测试：镜头列表渲染、选中编辑、归档只读、保存失败可见。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  comicEpisodeList: vi.fn(),
  comicCharacterList: vi.fn(),
  comicSceneList: vi.fn(),
  comicShotList: vi.fn(),
  comicShotSave: vi.fn(),
  comicShotDelete: vi.fn(),
  comicShotReorder: vi.fn(),
}));

vi.mock("./ipc", () => api);

import { ShotsPanel } from "./ShotsPanel";

const base = {
  projectId: "p1",
  projectName: "测试漫剧",
  kind: "ai_comic" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const episode = {
  id: "e1",
  projectId: "p1",
  episodeNo: 1,
  title: "第一集",
  synopsis: "",
  script: "",
  status: "scripting" as const,
  progress: 30,
  characterIds: [],
  shotCount: 3,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const character = {
  id: "c1",
  projectId: "p1",
  name: "黑发少年",
  role: "小前锋",
  description: "",
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
const shotA = {
  id: "h1",
  projectId: "p1",
  episodeId: "e1",
  shotNo: 1,
  description: "A-镜头1描述",
  characterIds: ["c1"],
  sceneId: "s1",
  dialogue: "开场台词",
  shotSize: "中景",
  cameraMove: "固定机位",
  durationSec: 3.5,
  status: "todo" as const,
  assetRefs: [],
  note: "备注",
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const shotB = { ...shotA, id: "h2", shotNo: 2, description: "A-镜头2描述" };

beforeEach(() => {
  vi.clearAllMocks();
  api.comicEpisodeList.mockResolvedValue({ episodes: [episode] });
  api.comicCharacterList.mockResolvedValue({ characters: [character] });
  api.comicSceneList.mockResolvedValue({ scenes: [scene] });
  api.comicShotList.mockResolvedValue({ shots: [shotA, shotB] });
  api.comicShotSave.mockResolvedValue({ shot: shotA });
  api.comicShotDelete.mockResolvedValue({ ok: true });
  api.comicShotReorder.mockResolvedValue({ shots: [shotA, shotB] });
});

afterEach(() => cleanup());

describe("ShotsPanel", () => {
  it("渲染镜头列表，选中后展示描述、台词、景别与场景", async () => {
    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/A-镜头1描述/);
    expect(screen.getByText(/A-镜头2描述/)).toBeTruthy();

    screen.getByText(/A-镜头1描述/).click();

    await waitFor(() => {
      expect(screen.getByDisplayValue("A-镜头1描述")).toBeTruthy();
    });
    expect(screen.getByDisplayValue("开场台词")).toBeTruthy();
    expect(screen.getByDisplayValue("中景")).toBeTruthy();
  });

  it("空集点击加镜头即可填写并保存首条镜头", async () => {
    const newShot = { ...shotA, id: "hnew", shotNo: 1, description: "新镜头" };
    api.comicShotList
      .mockResolvedValueOnce({ shots: [] })
      .mockResolvedValue({ shots: [newShot] });
    api.comicShotSave.mockResolvedValue({ shot: newShot });
    const onNotice = vi.fn();
    render(<ShotsPanel {...base} archived={false} onNotice={onNotice} />);

    await waitFor(() => {
      expect(screen.getByText(/本集暂无镜头/)).toBeTruthy();
    });
    screen.getByRole("button", { name: "加镜头" }).click();

    const descInput = await screen.findByLabelText("镜头描述");
    fireEvent.change(descInput, { target: { value: "新镜头" } });
    screen.getByRole("button", { name: "保存镜头" }).click();

    await waitFor(() => {
      expect(api.comicShotSave).toHaveBeenCalledWith(
        expect.objectContaining({ id: null, episodeId: "e1", description: "新镜头" }),
      );
    });
    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("已新建镜头"));
    });
  });

  it("归档项目：加镜头入口置灰并展示只读原因", async () => {
    render(<ShotsPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText(/A-镜头1描述/);

    expect(
      (screen.getByRole("button", { name: "加镜头" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("保存失败时可见错误提示，不静默吞错", async () => {
    api.comicShotSave.mockRejectedValue(new Error("数据库繁忙"));
    const onNotice = vi.fn();
    render(<ShotsPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    screen.getByRole("button", { name: "保存镜头" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("数据库繁忙");
    });
    expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("数据库繁忙"));
  });
});
