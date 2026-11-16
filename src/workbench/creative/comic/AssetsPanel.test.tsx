/**
 * @vitest-environment jsdom
 */
//! 漫剧素材与产物版本模块（C4）前端测试：版本列表、采用状态、文件缺失降级、归档只读。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  comicMediaList: vi.fn(),
  comicMediaImport: vi.fn(),
  comicMediaSave: vi.fn(),
  comicMediaAdopt: vi.fn(),
  comicMediaDelete: vi.fn(),
  comicShotList: vi.fn(),
  comicCharacterList: vi.fn(),
  comicSceneList: vi.fn(),
}));

vi.mock("./ipc", () => api);

import { AssetsPanel } from "./AssetsPanel";

const base = {
  projectId: "p1",
  projectName: "测试漫剧",
  kind: "ai_comic" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const shot = {
  id: "h1",
  projectId: "p1",
  episodeId: "e1",
  shotNo: 1,
  description: "A-镜头1描述",
  characterIds: [],
  sceneId: null,
  dialogue: "",
  shotSize: "",
  cameraMove: "",
  durationSec: 3.5,
  status: "todo" as const,
  assetRefs: [],
  note: "",
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const missing = {
  id: "m1",
  projectId: "p1",
  shotId: "h1",
  characterId: null,
  sceneId: null,
  filePath: "C:/definitely/not/existing/a.png",
  fileExists: false,
  mediaKind: "image" as const,
  versionLabel: "v1",
  status: "candidate" as const,
  reviewNote: "初稿构图",
  source: "imported" as const,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const adopted = { ...missing, id: "m2", filePath: "D:/exists/b.png", fileExists: true, versionLabel: "v2", status: "adopted" as const };

beforeEach(() => {
  vi.clearAllMocks();
  api.comicMediaList.mockResolvedValue({ versions: [missing, adopted] });
  api.comicShotList.mockResolvedValue({ shots: [shot] });
  api.comicCharacterList.mockResolvedValue({ characters: [] });
  api.comicSceneList.mockResolvedValue({ scenes: [] });
  api.comicMediaImport.mockResolvedValue({ version: missing });
  api.comicMediaSave.mockResolvedValue({ version: missing });
  api.comicMediaAdopt.mockResolvedValue({ version: adopted });
  api.comicMediaDelete.mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("AssetsPanel", () => {
  it("渲染版本列表，展示采用徽标与文件缺失降级提示", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/v1/);
    expect(screen.getByText(/v2/)).toBeTruthy();
    expect(screen.getAllByText(/采用/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/文件缺失/).length).toBeGreaterThan(0);
  });

  it("归档项目：导入入口置灰并展示只读原因", async () => {
    render(<AssetsPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText(/v1/);

    expect(
      (screen.getByRole("button", { name: "导入本地素材" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("对候选版本点击采用，调用 adopt 命令", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v1/);

    screen.getByText(/v1/).click();
    await screen.findByDisplayValue("C:/definitely/not/existing/a.png");

    screen.getByRole("button", { name: "标记采用" }).click();

    await waitFor(() => {
      expect(api.comicMediaAdopt).toHaveBeenCalledWith("m1");
    });
  });
});
