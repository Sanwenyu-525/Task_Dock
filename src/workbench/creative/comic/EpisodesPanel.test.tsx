/**
 * @vitest-environment jsdom
 */
//! 漫剧剧集与剧本模块（C1）前端测试：列表渲染、选中编辑、归档只读、保存失败可见。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  comicEpisodeList: vi.fn(),
  comicEpisodeSave: vi.fn(),
  comicEpisodeDelete: vi.fn(),
  comicEpisodeReorder: vi.fn(),
  comicCharacterList: vi.fn(),
  comicShotList: vi.fn(),
  comicSceneList: vi.fn(),
  comicMediaList: vi.fn(),
  comicEpisodeCharacterOverrideList: vi.fn(),
  comicEpisodeCharacterOverrideSave: vi.fn(),
  comicEpisodeCharacterOverrideDelete: vi.fn(),
}));

const dialog = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("./ipc", () => api);
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { EpisodesPanel } from "./EpisodesPanel";
import { buildEpisodeShotStats } from "./shotStats";

const base = {
  projectId: "p1",
  projectName: "测试漫剧",
  kind: "ai_comic" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const episodeA = {
  id: "e1",
  projectId: "p1",
  episodeNo: 1,
  title: "第一集",
  synopsis: "开场简介",
  script: "第一场剧本正文。",
  status: "scripting" as const,
  progress: 30,
  characterIds: ["c1"],
  shotCount: 3,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const episodeB = { ...episodeA, id: "e2", title: "第二集", status: "draft" as const, progress: 10 };
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

/** 本集镜头：完成 2 / 进行中 1 / 待办 1（共 4 条），用于派生统计断言。 */
const shotsOfEpisodeA = [
  { id: "h1", episodeId: "e1", status: "done" as const, characterIds: ["c1"] },
  { id: "h2", episodeId: "e1", status: "done" as const, characterIds: ["c1"] },
  { id: "h3", episodeId: "e1", status: "doing" as const, characterIds: ["c1"] },
  { id: "h4", episodeId: "e1", status: "todo" as const, characterIds: ["c1"] },
];

const overrideEp1 = {
  id: "o1",
  projectId: "p1",
  episodeId: "e1",
  characterId: "c1",
  roleInEpisode: "学生",
  appearanceLabel: "高中时期",
  appearanceDescription: "16 岁，黑色短发",
  costumeDescription: "蓝白校服",
  hairStyleDescription: "自然短发",
  stateDescription: "正常状态",
  visualPromptOverride: "",
  refImagePath: "",
  refImageExists: false,
  character,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

const overrideEp2 = {
  ...overrideEp1,
  id: "o2",
  episodeId: "e2",
  roleInEpisode: "成年",
  appearanceLabel: "成年时期",
  appearanceDescription: "26 岁，稍长发型",
  costumeDescription: "深色夹克",
  hairStyleDescription: "稍长发型",
  stateDescription: "成熟状态",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.comicEpisodeList.mockResolvedValue({ episodes: [episodeA, episodeB] });
  api.comicCharacterList.mockResolvedValue({ characters: [character] });
  api.comicShotList.mockResolvedValue({ shots: shotsOfEpisodeA });
  api.comicEpisodeSave.mockResolvedValue({ episode: episodeA });
  api.comicEpisodeDelete.mockResolvedValue({ ok: true });
  api.comicEpisodeReorder.mockResolvedValue({ episodes: [episodeA, episodeB] });
  api.comicEpisodeCharacterOverrideList.mockImplementation(
    (_projectId: string, episodeId: string) =>
      Promise.resolve({
        overrides: episodeId === "e2" ? [overrideEp2] : [overrideEp1],
      }),
  );
  api.comicEpisodeCharacterOverrideSave.mockImplementation(
    (input: Record<string, unknown>) =>
      Promise.resolve({
        record: {
          ...overrideEp1,
          ...input,
          appearanceLabel: String(input.appearanceLabel ?? ""),
          costumeDescription: String(input.costumeDescription ?? ""),
        },
      }),
  );
  api.comicEpisodeCharacterOverrideDelete.mockResolvedValue({ ok: true });
  dialog.open.mockResolvedValue(null);
});

afterEach(() => cleanup());

describe("EpisodesPanel", () => {
  it("渲染剧集列表，选中后展示标题、剧本与出场角色", async () => {
    render(<EpisodesPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/第一集/);
    expect(screen.getByText(/第二集/)).toBeTruthy();

    screen.getByText(/第一集/).click();

    await waitFor(() => {
      expect(screen.getByDisplayValue("第一集")).toBeTruthy();
    });
    expect(screen.getByDisplayValue("第一场剧本正文。")).toBeTruthy();
    expect(screen.getAllByText("黑发少年").length).toBeGreaterThan(0);
  });

  it("保存前裁剪已失效的角色弱引用，不向校验层发送悬空 ID", async () => {
    const stale = { ...episodeA, characterIds: ["c1", "gone"] };
    api.comicEpisodeList.mockResolvedValue({ episodes: [stale] });
    render(<EpisodesPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/第一集/);
    screen.getByText(/第一集/).click();
    await screen.findByDisplayValue("第一集");

    screen.getByRole("button", { name: "保存剧集" }).click();

    await waitFor(() => {
      expect(api.comicEpisodeSave).toHaveBeenCalledWith(
        expect.objectContaining({ characterIds: ["c1"] }),
      );
    });
  });

  it("空列表点击新建剧集即可填写并保存首集", async () => {
    const newEpisode = { ...episodeA, id: "enew", title: "新剧集", episodeNo: 1 };
    api.comicEpisodeList
      .mockResolvedValueOnce({ episodes: [] })
      .mockResolvedValue({ episodes: [newEpisode] });
    api.comicCharacterList.mockResolvedValue({ characters: [] });
    api.comicEpisodeSave.mockResolvedValue({ episode: newEpisode });
    const onNotice = vi.fn();
    render(<EpisodesPanel {...base} archived={false} onNotice={onNotice} />);

    await waitFor(() => {
      expect(screen.getByText(/暂无剧集/)).toBeTruthy();
    });
    screen.getByRole("button", { name: "新建剧集" }).click();

    const titleInput = await screen.findByLabelText("剧集标题");
    fireEvent.change(titleInput, { target: { value: "新剧集" } });
    screen.getByRole("button", { name: "保存剧集" }).click();

    await waitFor(() => {
      expect(api.comicEpisodeSave).toHaveBeenCalledWith(
        expect.objectContaining({ id: null, title: "新剧集" }),
      );
    });
    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("新剧集"));
    });
  });

  it("归档项目：新建入口置灰并展示只读原因", async () => {
    render(<EpisodesPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText(/第一集/);

    expect(
      (screen.getByRole("button", { name: "新建剧集" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("保存失败时可见错误提示，不静默吞错", async () => {
    api.comicEpisodeSave.mockRejectedValue(new Error("网络异常"));
    const onNotice = vi.fn();
    render(<EpisodesPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText(/第一集/);
    screen.getByText(/第一集/).click();
    await screen.findByDisplayValue("第一集");

    screen.getByRole("button", { name: "保存剧集" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("网络异常");
    });
    expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("网络异常"));
  });

  it("按剧集展示派生镜头统计，且不覆盖剧集制作进度", async () => {
    render(<EpisodesPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/第一集/);

    // 列表行给出镜头完成比例（来自真实镜头状态）。
    expect(screen.getByText(/（完成 50%）/)).toBeTruthy();

    screen.getByText(/第一集/).click();
    await screen.findByDisplayValue("第一集");

    const stats = screen.getByRole("region", { name: "本集镜头统计" });
    expect(stats.textContent).toContain("镜头总数");
    expect(stats.textContent).toContain("4");
    expect(stats.textContent).toContain("待办");
    expect(stats.textContent).toContain("进行中");
    expect(stats.textContent).toContain("阻塞");
    expect(stats.textContent).toContain("已完成");
    expect(stats.textContent).toContain("镜头完成比例 50%（2/4）");
    expect(stats.textContent).toContain("不写入也不覆盖");

    // 剧集自身制作进度仍是用户填写的 30，没有被镜头比例改写。
    expect((screen.getByLabelText("制作进度") as HTMLInputElement).value).toBe("30");
  });

  it("镜头统计按剧集分组，未知剧集不计入", () => {
    const stats = buildEpisodeShotStats([
      { episodeId: "e1", status: "done" },
      { episodeId: "e1", status: "done" },
      { episodeId: "e1", status: "doing" },
      { episodeId: "e1", status: "todo" },
      { episodeId: "e2", status: "blocked" },
      { episodeId: "e2", status: "done" },
      { episodeId: "", status: "done" },
    ]);

    expect(stats.get("e1")).toMatchObject({ total: 4, todo: 1, doing: 1, blocked: 0, done: 2 });
    expect(stats.get("e1")?.doneRatio).toBe(50);
    expect(stats.get("e2")).toMatchObject({ total: 2, blocked: 1, done: 1 });
    expect(stats.get("e2")?.doneRatio).toBe(50);
    expect(stats.size).toBe(2);
  });

  it("没有镜头的剧集统计为 0，不显示伪造比例", async () => {
    api.comicShotList.mockResolvedValue({ shots: [] });
    render(<EpisodesPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/第一集/);
    screen.getByText(/第一集/).click();
    await screen.findByDisplayValue("第一集");

    const stats = screen.getByRole("region", { name: "本集镜头统计" });
    expect(stats.textContent).toContain("镜头完成比例 0%（0/0）");
  });

  it("同一角色在两集拥有不同本集形象，切换剧集互不影响", async () => {
    render(<EpisodesPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/第一集/);

    screen.getByText(/第一集/).click();
    await waitFor(() => {
      expect(screen.getByText(/本集形象：高中时期/)).toBeTruthy();
    });
    expect(screen.getByText("蓝白校服")).toBeTruthy();
    expect(screen.getByText(/全局基础设定：196cm，25 号球衣/)).toBeTruthy();

    screen.getByText(/第二集/).click();
    await waitFor(() => {
      expect(screen.getByText(/本集形象：成年时期/)).toBeTruthy();
    });
    expect(screen.getByText("深色夹克")).toBeTruthy();
    expect(screen.queryByText("蓝白校服")).toBeNull();
    expect(api.comicEpisodeCharacterOverrideList).toHaveBeenCalledWith("p1", "e2");
  });

  it("保存第二集形象只提交本集覆盖，不修改全局档案", async () => {
    const onNotice = vi.fn();
    render(<EpisodesPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText(/第二集/);
    screen.getByText(/第二集/).click();
    await screen.findByDisplayValue("第二集");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "编辑本集形象" })).toBeTruthy();
    });
    screen.getByRole("button", { name: "编辑本集形象" }).click();

    await screen.findByLabelText("本集服装");
    fireEvent.change(screen.getByLabelText("本集服装"), {
      target: { value: "深色风衣" },
    });
    screen.getByRole("button", { name: "保存本集形象" }).click();

    await waitFor(() => {
      expect(api.comicEpisodeCharacterOverrideSave).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          episodeId: "e2",
          characterId: "c1",
          costumeDescription: "深色风衣",
        }),
      );
    });
    expect(api.comicEpisodeSave).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("全局档案未修改"));
    // 全局基础设定仍在页面上，没有被本集覆盖覆盖掉。
    expect(screen.getByText(/全局基础设定：196cm，25 号球衣/)).toBeTruthy();
  });

  it("恢复全局形象只删除本集覆盖", async () => {
    const onNotice = vi.fn();
    render(<EpisodesPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText(/第一集/);
    screen.getByText(/第一集/).click();
    await screen.findByDisplayValue("第一集");

    const resetButton = await screen.findByRole("button", { name: "恢复全局形象" });
    resetButton.click();
    const confirmReset = await screen.findByRole("button", { name: "再次点击确认恢复" });
    confirmReset.click();

    await waitFor(() => {
      expect(api.comicEpisodeCharacterOverrideDelete).toHaveBeenCalledWith("p1", "e1", "c1");
    });
    await waitFor(() => {
      expect(screen.getByText(/沿用全局形象/)).toBeTruthy();
    });
    expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("恢复"));
  });

  it("角色仍被本集镜头引用时拒绝移出，并说明还有几个镜头", async () => {
    render(<EpisodesPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/第一集/);
    screen.getByText(/第一集/).click();
    await screen.findByDisplayValue("第一集");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "移出本集" })).toBeTruthy();
    });
    screen.getByRole("button", { name: "移出本集" }).click();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "移出本集" })).toBeNull();
    });
    screen.getByRole("button", { name: "保存剧集" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("仍被本集 4 个镜头引用");
    });
    expect(api.comicEpisodeSave).not.toHaveBeenCalled();
  });

  it("归档项目：本集形象编辑与恢复入口置灰", async () => {
    render(<EpisodesPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText(/第一集/);
    screen.getByText(/第一集/).click();
    await screen.findByDisplayValue("第一集");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "编辑本集形象" })).toBeTruthy();
    });
    expect(
      (screen.getByRole("button", { name: "编辑本集形象" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "恢复全局形象" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
