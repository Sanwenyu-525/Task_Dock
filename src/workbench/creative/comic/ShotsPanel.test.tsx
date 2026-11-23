/**
 * @vitest-environment jsdom
 */
//! 漫剧分镜模块（C2）前端测试。
//!
//! 覆盖：镜头列表/编辑/排序入口、归档只读、保存失败可见；
//! 本轮新增：镜头↔素材版本的正式关联（`shot_id`）在分镜页只读展示、可展开查看，
//! 历史 `assetRefs`（文件路径）只读兼容且保存时不再提交（后端保留原值）。

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
  comicMediaList: vi.fn(),
  comicEpisodeCharacterOverrideList: vi.fn(),
}));

const fs = vi.hoisted(() => ({
  fsThumbnail: vi.fn(),
  fsReadBinary: vi.fn(),
  fsPreviewImage: vi.fn(),
}));

vi.mock("./ipc", () => api);
vi.mock("../../../lib/bridge", () => fs);

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
  characterIds: ["c1"],
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

const version = {
  id: "m1",
  projectId: "p1",
  shotId: "h1",
  characterId: null,
  sceneId: null,
  filePath: "D:/comic/shot-a1.png",
  fileExists: true,
  mediaKind: "image" as const,
  versionLabel: "v1 线稿",
  status: "adopted" as const,
  reviewNote: "构图偏右",
  source: "imported" as const,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const missingVersion = {
  ...version,
  id: "m2",
  filePath: "D:/comic/gone.png",
  fileExists: false,
  versionLabel: "v2 配色",
  status: "candidate" as const,
  reviewNote: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.comicEpisodeList.mockResolvedValue({ episodes: [episode] });
  api.comicCharacterList.mockResolvedValue({ characters: [character] });
  api.comicSceneList.mockResolvedValue({ scenes: [scene] });
  api.comicShotList.mockResolvedValue({ shots: [shotA, shotB] });
  api.comicShotSave.mockResolvedValue({ shot: shotA });
  api.comicShotDelete.mockResolvedValue({ ok: true });
  api.comicShotReorder.mockResolvedValue({ shots: [shotA, shotB] });
  api.comicMediaList.mockResolvedValue({ versions: [version, missingVersion] });
  api.comicEpisodeCharacterOverrideList.mockResolvedValue({ overrides: [] });
  fs.fsThumbnail.mockResolvedValue(null);
  fs.fsReadBinary.mockRejectedValue(new Error("读取失败"));
  fs.fsPreviewImage.mockResolvedValue(null);
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

  it("保存前裁剪失效角色与场景弱引用", async () => {
    const stale = { ...shotA, characterIds: ["c1", "gone"], sceneId: "gone-scene" };
    api.comicShotList.mockResolvedValue({ shots: [stale] });
    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    screen.getByRole("button", { name: "保存镜头" }).click();

    await waitFor(() => {
      expect(api.comicShotSave).toHaveBeenCalledWith(
        expect.objectContaining({ characterIds: ["c1"], sceneId: null }),
      );
    });
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

  it("展示镜头关联的素材版本（名称/类型/采用状态/缺失），不再要求手填版本 ID", async () => {
    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    expect(screen.queryByLabelText(/素材引用/)).toBeNull();
    expect(screen.getByText(/v1 线稿 · 图片/)).toBeTruthy();
    expect(screen.getByText(/v2 配色 · 图片/)).toBeTruthy();
    expect(screen.getAllByText(/采用/).length).toBeGreaterThan(0);
    expect(screen.getByText(/文件缺失/)).toBeTruthy();
    // 列表行也给素材数量，便于一眼看出哪些镜头有产物。
    expect(screen.getByText(/1 个素材版本|2 个素材版本/)).toBeTruthy();
  });

  it("展开查看关联素材：大图区域 + 修改意见 + 路径", async () => {
    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    fireEvent.click(screen.getAllByRole("button", { name: "查看" })[0]);

    expect(screen.getByText(/修改意见：构图偏右/)).toBeTruthy();
    expect(screen.getByText("D:/comic/shot-a1.png")).toBeTruthy();
    // 图片加载失败给出可见错误，而不是白屏。
    expect(await screen.findByText(/系统缩略图管线无法解码该图片/)).toBeTruthy();
  });

  it("历史 assetRefs（文件路径）只读展示，保存时不再提交", async () => {
    const legacy = {
      ...shotA,
      assetRefs: ["D:/comic/gone.png", "D:/comic/unknown.png"],
    };
    api.comicShotList.mockResolvedValue({ shots: [legacy] });
    // 该版本挂在角色上（不是本镜头），因此历史路径能匹配到版本但不能当作本镜头关联。
    api.comicMediaList.mockResolvedValue({
      versions: [version, { ...missingVersion, shotId: null, characterId: "c1" }],
    });
    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    expect(screen.getByText(/历史素材引用（只读）/)).toBeTruthy();
    expect(screen.getByText(/路径已匹配素材版本「v2 配色」/)).toBeTruthy();
    expect(screen.getByText(/未匹配到素材版本：unknown.png/)).toBeTruthy();

    screen.getByRole("button", { name: "保存镜头" }).click();
    await waitFor(() => {
      expect(api.comicShotSave).toHaveBeenCalledWith(
        expect.objectContaining({ assetRefs: null }),
      );
    });
  });

  it("重新打开（重新挂载）后素材关联仍然一致", async () => {
    const first = render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/A-镜头1描述/);
    first.unmount();

    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    expect(screen.getByText(/v1 线稿 · 图片/)).toBeTruthy();
    expect(api.comicMediaList).toHaveBeenCalledWith("p1");
  });

  it("只展示本集出场角色，不展示其他角色", async () => {
    const other = { ...character, id: "c2", name: "队友" };
    api.comicCharacterList.mockResolvedValue({ characters: [character, other] });
    api.comicEpisodeCharacterOverrideList.mockResolvedValue({
      overrides: [
        {
          id: "o1",
          projectId: "p1",
          episodeId: "e1",
          characterId: "c1",
          roleInEpisode: "",
          appearanceLabel: "高中时期",
          appearanceDescription: "",
          costumeDescription: "蓝白校服",
          hairStyleDescription: "",
          stateDescription: "",
          visualPromptOverride: "",
          refImagePath: "",
          refImageExists: false,
          character,
          createdAt: "2026-11-16T09:00:00+00:00",
          updatedAt: "2026-11-16T09:00:00+00:00",
        },
      ],
    });
    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    await waitFor(() => {
      expect(screen.getByText(/黑发少年 · 本集形象：高中时期/)).toBeTruthy();
    });
    expect(screen.queryByText(/队友/)).toBeNull();
  });

  it("本集没有出场角色时给出明确空状态并可切到剧集模块", async () => {
    api.comicEpisodeList.mockResolvedValue({
      episodes: [{ ...episode, characterIds: [] }],
    });
    const switchModule = vi.fn();
    render(
      <ShotsPanel
        {...base}
        switchModule={switchModule}
        archived={false}
        onNotice={vi.fn()}
      />,
    );

    await screen.findByText(/A-镜头1描述/);
    expect(screen.getByText(/本集还没有出场角色/)).toBeTruthy();
    expect(screen.getByText(/分镜不会回退到项目全部角色/)).toBeTruthy();

    screen.getByRole("button", { name: "去剧集添加出场角色" }).click();
    expect(switchModule).toHaveBeenCalledWith("episodes");
  });

  it("后端拒绝跨集角色时错误可见，不静默吞错", async () => {
    api.comicShotSave.mockRejectedValue(
      new Error("角色「队友」不在本集出场名单，不能用于本集分镜"),
    );
    const onNotice = vi.fn();
    render(<ShotsPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText(/A-镜头1描述/);
    screen.getByText(/A-镜头1描述/).click();
    await screen.findByDisplayValue("A-镜头1描述");

    screen.getByRole("button", { name: "保存镜头" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("不在本集出场名单");
    });
    expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("不在本集出场名单"));
  });

  it("切换剧集后角色名单与覆盖刷新", async () => {
    const other = { ...character, id: "c2", name: "队友" };
    const episode2 = {
      ...episode,
      id: "e2",
      episodeNo: 2,
      title: "第二集",
      characterIds: ["c2"],
    };
    api.comicEpisodeList.mockResolvedValue({ episodes: [episode, episode2] });
    api.comicCharacterList.mockResolvedValue({ characters: [character, other] });
    api.comicShotList.mockImplementation((_projectId: string, episodeId: string | null) =>
      Promise.resolve({ shots: episodeId === "e2" ? [] : [shotA, shotB] }),
    );
    render(<ShotsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/A-镜头1描述/);

    fireEvent.click(screen.getByRole("combobox", { name: "剧集" }));
    const episodeOption = await screen.findByRole("option", { name: /第二集/ });
    fireEvent.click(episodeOption);

    await screen.findByRole("button", { name: "加镜头" });
    screen.getByRole("button", { name: "加镜头" }).click();

    await waitFor(() => {
      expect(screen.getByText(/队友 · 沿用全局形象/)).toBeTruthy();
    });
    expect(screen.queryByText(/黑发少年/)).toBeNull();
    expect(api.comicEpisodeCharacterOverrideList).toHaveBeenCalledWith("p1", "e2");
  });
});
