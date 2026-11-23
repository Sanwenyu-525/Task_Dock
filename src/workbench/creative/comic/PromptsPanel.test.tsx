/**
 * @vitest-environment jsdom
 */
//! 提示词与 Skill 模块（v96）前端测试。
//!
//! 覆盖：模板/版本历史、旧版本只读语义（保存会创建新版本）、默认版本切换、
//! 真实上下文预览、Skill 声明版本与实际内容版本区分、归档只读。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  comicEpisodeList: vi.fn(),
  comicShotList: vi.fn(),
  comicPromptTemplateList: vi.fn(),
  comicPromptTemplateSave: vi.fn(),
  comicPromptVersionList: vi.fn(),
  comicPromptVersionCreate: vi.fn(),
  comicPromptVersionSetDefault: vi.fn(),
  comicPromptRender: vi.fn(),
  comicSkillList: vi.fn(),
  comicSkillSnapshotCapture: vi.fn(),
  comicSkillSnapshotList: vi.fn(),
  comicSkillSnapshotGet: vi.fn(),
}));

const clip = vi.hoisted(() => ({ copyText: vi.fn() }));

vi.mock("./ipc", () => api);
vi.mock("../../../lib/clipboard", () => clip);

import { PromptsPanel } from "./PromptsPanel";

const base = {
  projectId: "p1",
  projectName: "测试漫剧",
  kind: "ai_comic" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const template = {
  id: "t1",
  projectId: "p1",
  name: "角色参考模板",
  category: "character_reference" as const,
  description: "定妆用",
  versionCount: 2,
  defaultVersionId: "v2",
  defaultVersionNo: 2,
  defaultContentHash: "bbbbbbbbbbbbbbbb",
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

const v1 = {
  id: "v1",
  templateId: "t1",
  versionNo: 1,
  content: "项目：{{project.name}}",
  variablesJson: '["project.name"]',
  contentHash: "aaaaaaaaaaaaaaaa",
  changeNote: "初始版本",
  isDefault: false,
  createdAt: "2026-11-16T09:00:00+00:00",
};
const v2 = {
  ...v1,
  id: "v2",
  versionNo: 2,
  content: "项目：{{project.name}}\n角色：{{characters.block}}",
  variablesJson: '["project.name","characters.block"]',
  contentHash: "bbbbbbbbbbbbbbbb",
  changeNote: "加入角色块",
  isDefault: true,
  createdAt: "2026-11-17T09:00:00+00:00",
};

const episode = {
  id: "e1",
  projectId: "p1",
  episodeNo: 1,
  title: "第一集",
  synopsis: "",
  script: "",
  status: "draft" as const,
  progress: 0,
  characterIds: ["c1"],
  shotCount: 1,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const shot = {
  id: "h1",
  projectId: "p1",
  episodeId: "e1",
  shotNo: 1,
  description: "起跳投篮",
  characterIds: ["c1"],
  sceneId: null,
  dialogue: "",
  shotSize: "中景",
  cameraMove: "",
  durationSec: 1,
  status: "todo" as const,
  assetRefs: [],
  note: "",
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

const skill = {
  id: "s1",
  name: "分镜助手",
  description: "拆解镜头",
  declaredVersion: "1.2.0",
  scope: "global",
  projectId: null,
  enabled: true,
  missing: false,
  riskLevel: "low",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

const snapshot = {
  id: "snap1",
  projectId: "p1",
  sourceSkillId: "s1",
  skillName: "分镜助手",
  declaredVersion: "1.2.0",
  contentHash: "cccccccccccccccc",
  contentSnapshot: "Skill 正文内容\n第二行",
  filesManifestJson: '[{"path":"SKILL.md","isDir":false,"sizeBytes":10,"sha256":"dddd"}]',
  filesManifestHash: "eeeeeeeeeeeeeeee",
  snapshotFingerprint: '["s1","cccccccccccccccc","1.2.0","eeeeeeeeeeeeeeee"]',
  fileCount: 1,
  createdAt: "2026-11-20T09:00:00+00:00",
};

const preview = {
  promptVersionId: "v2",
  templateId: "t1",
  templateName: "角色参考模板",
  versionNo: 2,
  contentHash: "bbbbbbbbbbbbbbbb",
  requiredVariables: ["project.name", "characters.block"],
  rendered: "项目：测试漫剧\n角色：\n【角色】林远\n本集服装：蓝白校服",
  context: {
    projectId: "p1",
    episodeId: "e1",
    shotId: null,
    variables: {},
    characters: [
      {
        id: "c1",
        name: "林远",
        role: "主角",
        baseDescription: "18 岁",
        appearanceLabel: "高中时期",
        appearanceDescription: "16 岁",
        costumeDescription: "蓝白校服",
        hairStyleDescription: "",
        stateDescription: "",
        visualPromptOverride: "",
        refImagePath: "",
        usingOverride: true,
      },
    ],
    scenes: [],
    shot: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.comicPromptTemplateList.mockResolvedValue({ templates: [template] });
  api.comicPromptVersionList.mockResolvedValue({ versions: [v2, v1] });
  api.comicEpisodeList.mockResolvedValue({ episodes: [episode] });
  api.comicShotList.mockResolvedValue({ shots: [shot] });
  api.comicPromptRender.mockResolvedValue({ preview });
  api.comicSkillList.mockResolvedValue([skill]);
  api.comicSkillSnapshotList.mockResolvedValue({ snapshots: [snapshot] });
  api.comicSkillSnapshotGet.mockResolvedValue({ snapshot });
  api.comicSkillSnapshotCapture.mockResolvedValue({ snapshot });
  api.comicPromptVersionCreate.mockResolvedValue({
    version: { ...v2, id: "v3", versionNo: 3, content: "新正文" },
  });
  api.comicPromptVersionSetDefault.mockResolvedValue({ version: { ...v1, isDefault: true } });
  api.comicPromptTemplateSave.mockResolvedValue({ template });
  clip.copyText.mockResolvedValue(true);
});

afterEach(() => cleanup());

describe("PromptsPanel", () => {
  it("展示模板与版本历史；选择旧版本后保存会创建新版本而不是改写历史", async () => {
    const onNotice = vi.fn();
    render(<PromptsPanel {...base} archived={false} onNotice={onNotice} />);

    await screen.findByText("角色参考模板");
    screen.getByText("角色参考模板").click();

    await waitFor(() => {
      expect(screen.getByText(/v2 · 默认/)).toBeTruthy();
    });
    expect(screen.getByText(/v1/)).toBeTruthy();

    // 查看 v1：编辑区载入 v1 正文，且明确提示保存会创建新版本。
    fireEvent.click(screen.getByText(/^v1$/));
    await waitFor(() => {
      expect((screen.getByLabelText("提示词正文") as HTMLTextAreaElement).value).toBe(
        "项目：{{project.name}}",
      );
    });
    expect(screen.getByText(/正在基于 v1 编辑/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("提示词正文"), {
      target: { value: "项目：{{project.name}}\n新的补充" },
    });
    fireEvent.change(screen.getByLabelText("修改说明"), {
      target: { value: "补充说明" },
    });
    screen.getByRole("button", { name: /创建新版本/ }).click();

    await waitFor(() => {
      expect(api.comicPromptVersionCreate).toHaveBeenCalledWith({
        templateId: "t1",
        content: "项目：{{project.name}}\n新的补充",
        variablesJson: '["project.name"]',
        changeNote: "补充说明",
      });
    });
    expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("旧版本未修改"));
  });

  it("切换默认版本调用后端并保证只切一个", async () => {
    render(<PromptsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("角色参考模板");
    screen.getByText("角色参考模板").click();
    await screen.findByText(/v2 · 默认/);

    screen.getByRole("button", { name: "设为默认" }).click();

    await waitFor(() => {
      expect(api.comicPromptVersionSetDefault).toHaveBeenCalledWith("t1", "v1");
    });
  });

  it("按真实剧集/镜头渲染预览，并展示实际使用角色", async () => {
    render(<PromptsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("角色参考模板");
    screen.getByText("角色参考模板").click();
    await screen.findByText(/v2 · 默认/);

    screen.getByRole("button", { name: "渲染预览" }).click();

    await waitFor(() => {
      expect(api.comicPromptRender).toHaveBeenCalledWith({
        projectId: "p1",
        promptVersionId: "v2",
        episodeId: "e1",
        shotId: null,
      });
    });
    expect(await screen.findByText(/【角色】林远/)).toBeTruthy();
    expect(screen.getByText(/实际使用角色：/)).toBeTruthy();
    expect(screen.getByText(/林远（本集形象：高中时期）/)).toBeTruthy();
  });

  it("Skill 快照同时展示声明版本与实际内容版本，且内容只读", async () => {
    const onNotice = vi.fn();
    render(<PromptsPanel {...base} archived={false} onNotice={onNotice} />);
    const skillEntries = await screen.findAllByText("分镜助手");
    skillEntries[0].click();

    // 声明版本来自 SKILL.md，实际内容版本是快照 Hash。
    await screen.findByText("声明版本（SKILL.md）");
    expect(screen.getByText("1.2.0")).toBeTruthy();
    expect(screen.getByText(/实际内容版本以快照 Hash 为准/)).toBeTruthy();

    screen.getByRole("button", { name: "捕获当前版本为快照" }).click();
    await waitFor(() => {
      expect(api.comicSkillSnapshotCapture).toHaveBeenCalledWith("p1", "s1");
    });
    expect(await screen.findByText(/Skill 正文内容/)).toBeTruthy();
    expect(screen.getAllByText(/声明版本 1.2.0/).length).toBeGreaterThan(0);
    expect(screen.getByText(/实际内容 cccccccc/)).toBeTruthy();
    expect(onNotice).toHaveBeenCalledWith("ok", expect.stringContaining("内容快照"));
  });

  it("渲染结果可一键复制，空内容禁止复制", async () => {
    const onNotice = vi.fn();
    render(<PromptsPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText("角色参考模板");
    screen.getByText("角色参考模板").click();
    await screen.findByText(/v2 · 默认/);

    screen.getByRole("button", { name: "渲染预览" }).click();
    const copyButton = await screen.findByRole("button", { name: /复制提示词/ });
    expect((copyButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(clip.copyText).toHaveBeenCalledWith(preview.rendered);
    });
    expect(await screen.findByRole("button", { name: /已复制/ })).toBeTruthy();
    expect(onNotice).toHaveBeenCalledWith("ok", "已复制提示词到剪贴板");

    // 复制失败如实提示，不假装成功。
    clip.copyText.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: /已复制|复制提示词/ }));
    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("复制失败"),
      );
    });
  });

  it("切换版本后清除旧预览并明确标记过期，不展示旧版本的渲染结果", async () => {
    api.comicEpisodeList.mockResolvedValue({
      episodes: [episode, { ...episode, id: "e2", episodeNo: 2, title: "第二集" }],
    });
    api.comicPromptRender.mockImplementation(
      ({ promptVersionId }: { promptVersionId: string }) => ({
        preview: {
          ...preview,
          promptVersionId,
          versionNo: promptVersionId === "v1" ? 1 : 2,
          contentHash: promptVersionId === "v1" ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb",
        },
      }),
    );
    render(<PromptsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("角色参考模板");
    screen.getByText("角色参考模板").click();
    await screen.findByText(/v2 · 默认/);

    screen.getByRole("button", { name: "渲染预览" }).click();
    expect(await screen.findByText(/【角色】林远/)).toBeTruthy();
    expect(screen.getByText(/模板「角色参考模板」v2/)).toBeTruthy();

    // 切到 v1：旧的 v2 预览必须消失。
    fireEvent.click(screen.getByText(/^v1$/));
    await waitFor(() => {
      expect(screen.queryByText(/模板「角色参考模板」v2/)).toBeNull();
    });
    expect(screen.getByText(/之前的预览已过期并被清除/)).toBeTruthy();
    expect(screen.queryByText(/【角色】林远/)).toBeNull();

    // 剧集变化同样清除。
    screen.getByRole("button", { name: "渲染预览" }).click();
    await screen.findByText(/模板「角色参考模板」v1/);
    fireEvent.click(screen.getByRole("combobox", { name: "预览剧集" }));
    const otherEpisode = screen.getByRole("option", { name: /第 2 集/ });
    fireEvent.click(otherEpisode);
    await waitFor(() => {
      expect(screen.queryByText(/模板「角色参考模板」v1/)).toBeNull();
    });
  });

  it("首次创建模板时 v1 失败：退出创建态、载入模板、保留正文并可直接重试", async () => {
    const createdTemplate = {
      ...template,
      id: "t2",
      name: "新模板",
      versionCount: 0,
      defaultVersionId: null,
      defaultVersionNo: null,
      defaultContentHash: null,
    };
    api.comicPromptTemplateList.mockResolvedValue({ templates: [template, createdTemplate] });
    api.comicPromptTemplateSave.mockResolvedValue({ template: createdTemplate });
    api.comicPromptVersionList.mockResolvedValue({ versions: [] });
    api.comicPromptVersionCreate.mockRejectedValue(new Error("磁盘写入失败"));

    render(<PromptsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("角色参考模板");

    fireEvent.click(screen.getByRole("button", { name: "新建模板" }));
    fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "新模板" } });
    fireEvent.change(screen.getByLabelText("提示词正文"), {
      target: { value: "新模板正文：{{project.name}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建模板并保存 v1" }));

    // 模板已建成：必须退出创建态并载入它，而不是把用户困在「新建」界面。
    expect(
      await screen.findByText(/已创建，但首个版本保存失败/),
    ).toBeTruthy();
    await waitFor(() => {
      expect(api.comicPromptVersionList).toHaveBeenCalledWith("t2");
    });
    expect(screen.getByRole("button", { name: "保存模板信息" })).toBeTruthy();
    expect(
      (screen.getByLabelText("提示词正文") as HTMLTextAreaElement).value,
    ).toBe("新模板正文：{{project.name}}");
    // 可直接重试创建 v1。
    expect(
      (screen.getByRole("button", { name: /创建新版本/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    api.comicPromptVersionCreate.mockResolvedValue({
      version: { ...v1, id: "v9", versionNo: 1, content: "新模板正文：{{project.name}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创建新版本/ }));
    await waitFor(() => {
      expect(api.comicPromptVersionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: "t2",
          content: "新模板正文：{{project.name}}",
        }),
      );
    });
  });

  it("归档项目：新建模板/创建版本/捕获 Skill 全部置灰", async () => {
    render(<PromptsPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText("角色参考模板");

    expect(
      (screen.getByRole("button", { name: "新建模板" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    screen.getByText("角色参考模板").click();
    await screen.findByText(/v2 · 默认/);
    expect(
      (screen.getByRole("button", { name: /创建新版本/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    (await screen.findAllByText("分镜助手"))[0].click();
    await screen.findByText("声明版本（SKILL.md）");
    expect(
      (screen.getByRole("button", { name: "捕获当前版本为快照" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });
});
