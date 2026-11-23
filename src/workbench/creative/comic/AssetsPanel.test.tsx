/**
 * @vitest-environment jsdom
 */
//! 漫剧素材与产物版本模块（C4）前端测试。
//!
//! 覆盖：列表/缩略图降级、采用、归档只读、关联类型状态机（切换清空 / 失效重校验 /
//! 空目标 / 跨项目拒绝后保留输入）、图片缺失占位、访问失败提示、同镜头两个版本比较与采用。
//! 只 mock 本目录 IPC 包装层与共享文件访问 bridge，不 mock React/DOM。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  comicEpisodeList: vi.fn(),
  comicGenerationRecordList: vi.fn(),
  comicGenerationRecordCreate: vi.fn(),
  comicPromptTemplateList: vi.fn(),
  comicPromptVersionList: vi.fn(),
  comicPromptRender: vi.fn(),
  comicSkillSnapshotList: vi.fn(),
}));

const clip = vi.hoisted(() => ({ copyText: vi.fn() }));

const fs = vi.hoisted(() => ({
  fsThumbnail: vi.fn(),
  fsReadBinary: vi.fn(),
  fsPreviewImage: vi.fn(),
  fsPreviewMediaUrl: vi.fn(),
  fsReleasePreviewUrl: vi.fn(),
}));

vi.mock("./ipc", () => api);
vi.mock("../../../lib/bridge", () => fs);
vi.mock("../../../lib/clipboard", () => clip);

import { AssetsPanel, mediaKindOfPath } from "./AssetsPanel";
import { shortHash } from "./types";

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
  description: "",
  refImagePath: "",
  refImageExists: false,
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
const adopted = {
  ...missing,
  id: "m2",
  filePath: "D:/exists/b.png",
  fileExists: true,
  versionLabel: "v2",
  status: "adopted" as const,
};
const candidate = {
  ...missing,
  id: "m3",
  filePath: "D:/exists/c.png",
  fileExists: true,
  versionLabel: "v3",
  reviewNote: "换构图",
};

const promptTemplate = {
  id: "t1",
  projectId: "p1",
  name: "图片生成模板",
  category: "image_generation" as const,
  description: "",
  versionCount: 1,
  defaultVersionId: "pv1",
  defaultVersionNo: 1,
  defaultContentHash: "hash-1",
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

const promptVersion = {
  id: "pv1",
  templateId: "t1",
  versionNo: 1,
  content: "{{characters.block}}",
  variablesJson: "[]",
  contentHash: "hash-1",
  changeNote: "v1",
  isDefault: true,
  createdAt: "2026-11-16T09:00:00+00:00",
};

const promptPreview = {
  promptVersionId: "pv1",
  templateId: "t1",
  templateName: "图片生成模板",
  versionNo: 1,
  contentHash: "hash-1",
  requiredVariables: [],
  rendered: "【角色】林远\n自动渲染的初始内容",
  context: {
    projectId: "p1",
    episodeId: "e1",
    shotId: null,
    variables: {},
    characters: [],
    scenes: [],
    shot: null,
  },
};

function runStub(overrides: Record<string, unknown>) {
  return {
    id: "r0",
    projectId: "p1",
    episodeId: "e1",
    episodeTitle: "第一集",
    shotId: null,
    shotNo: null,
    promptVersionId: "pv1",
    promptTemplateName: "图片生成模板",
    promptVersionNo: 1,
    promptContentHashSnapshot: "hash-1",
    skillSnapshotId: null,
    skillName: null,
    skillDeclaredVersion: null,
    renderedPromptSnapshot: "提示词",
    contextSnapshotJson: "{}",
    skillContentHashSnapshot: "",
    modelProvider: "外部工具",
    modelName: "",
    modelVersion: "",
    parametersJson: "{}",
    seed: "",
    inputMediaIds: [],
    outputMediaIds: [],
    externalJobId: "",
    note: "",
    createdAt: "2026-11-16T09:00:00+00:00",
    ...overrides,
  };
}

function openImportForm() {
  fireEvent.click(screen.getByRole("button", { name: "导入本地素材" }));
}

function pickSelect(name: string, optionLabel: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(screen.getByRole("option", { name: optionLabel }));
}

function fillPath(value: string) {
  fireEvent.change(screen.getByLabelText(/本地文件绝对路径/), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.comicMediaList.mockResolvedValue({ versions: [missing, adopted, candidate] });
  api.comicShotList.mockResolvedValue({ shots: [shot] });
  api.comicCharacterList.mockResolvedValue({ characters: [character] });
  api.comicSceneList.mockResolvedValue({ scenes: [scene] });
  api.comicMediaImport.mockResolvedValue({ version: missing });
  api.comicMediaSave.mockResolvedValue({ version: missing });
  api.comicMediaAdopt.mockResolvedValue({ version: adopted });
  api.comicMediaDelete.mockResolvedValue({ ok: true });
  api.comicEpisodeList.mockResolvedValue({
    episodes: [
      {
        id: "e1",
        projectId: "p1",
        episodeNo: 1,
        title: "第一集",
        synopsis: "",
        script: "",
        status: "draft",
        progress: 0,
        characterIds: [],
        shotCount: 1,
        sortOrder: 0,
        createdAt: "2026-11-16T09:00:00+00:00",
        updatedAt: "2026-11-16T09:00:00+00:00",
      },
    ],
  });
  api.comicGenerationRecordList.mockResolvedValue({ runs: [] });
  api.comicGenerationRecordCreate.mockResolvedValue({
    run: { id: "run1" },
  });
  api.comicPromptTemplateList.mockResolvedValue({ templates: [] });
  api.comicPromptVersionList.mockResolvedValue({ versions: [] });
  api.comicPromptRender.mockResolvedValue({ preview: promptPreview });
  clip.copyText.mockResolvedValue(true);
  api.comicSkillSnapshotList.mockResolvedValue({ snapshots: [] });
  fs.fsThumbnail.mockResolvedValue(null);
  fs.fsReadBinary.mockRejectedValue(new Error("读取失败"));
  fs.fsPreviewImage.mockResolvedValue(null);
  fs.fsPreviewMediaUrl.mockResolvedValue("http://127.0.0.1/preview");
  fs.fsReleasePreviewUrl.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("AssetsPanel", () => {
  it("渲染版本列表：版本名称、关联镜头、采用状态与文件缺失", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/v1/);
    expect(screen.getByText(/v2/)).toBeTruthy();
    expect(screen.getAllByText(/采用/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/文件缺失/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/镜头 1/).length).toBeGreaterThan(0);
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

  it("切换关联类型立即清除旧目标，空目标不允许提交", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v1/);
    openImportForm();

    pickSelect("关联类型", "关联镜头");
    pickSelect("关联对象", "镜头 1 · A-镜头1描述");
    fillPath("D:/comic/a.png");
    expect(screen.getByRole("combobox", { name: "关联对象" }).textContent).toContain("镜头 1");

    // 镜头 → 角色：旧镜头 ID 必须立刻清空。
    pickSelect("关联类型", "关联角色");
    expect(screen.getByRole("combobox", { name: "关联对象" }).textContent).toContain("选择对象");
    expect(
      (screen.getByRole("button", { name: "登记素材" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.comicMediaImport).not.toHaveBeenCalled();

    // 选上角色后恢复可提交，且提交的是角色目标。
    pickSelect("关联对象", "黑发少年");
    fireEvent.click(screen.getByRole("button", { name: "登记素材" }));
    await waitFor(() => {
      expect(api.comicMediaImport).toHaveBeenCalledWith(
        expect.objectContaining({ shotId: null, characterId: "c1", sceneId: null }),
      );
    });
  });

  it("目标被删除后刷新会重新校验并阻止提交旧 ID", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v1/);
    openImportForm();
    pickSelect("关联对象", "镜头 1 · A-镜头1描述");
    fillPath("D:/comic/a.png");

    // 采用会触发 loadAll；此时后端已没有该镜头。
    api.comicShotList.mockResolvedValue({ shots: [] });
    screen.getByText(/v1/).click();
    await screen.findByDisplayValue("C:/definitely/not/existing/a.png");
    fireEvent.click(screen.getAllByRole("button", { name: "标记采用" })[0]);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("原关联对象已不存在");
    });
    expect(screen.getByRole("combobox", { name: "关联对象" }).textContent).not.toContain("镜头 1");
    expect(
      (screen.getByRole("button", { name: "登记素材" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.comicMediaImport).not.toHaveBeenCalled();
  });

  it("快速切换关联类型：只提交最后类型的目标，其它目标为 null", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v1/);
    openImportForm();

    pickSelect("关联类型", "关联角色");
    pickSelect("关联对象", "黑发少年");
    pickSelect("关联类型", "关联场景");
    pickSelect("关联对象", "篮球场");
    fillPath("D:/comic/scene.png");
    fireEvent.click(screen.getByRole("button", { name: "登记素材" }));

    await waitFor(() => {
      expect(api.comicMediaImport).toHaveBeenCalledWith(
        expect.objectContaining({
          shotId: null,
          characterId: null,
          sceneId: "s1",
          filePath: "D:/comic/scene.png",
        }),
      );
    });
    expect(api.comicMediaImport).toHaveBeenCalledTimes(1);
  });

  it("跨项目目标被后端拒绝：错误可见且保留用户输入", async () => {
    api.comicMediaImport.mockRejectedValue(new Error("镜头不属于当前项目"));
    const onNotice = vi.fn();
    render(<AssetsPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText(/v1/);
    openImportForm();
    pickSelect("关联对象", "镜头 1 · A-镜头1描述");
    fillPath("D:/comic/a.png");

    fireEvent.click(screen.getByRole("button", { name: "登记素材" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("镜头不属于当前项目");
    });
    expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("镜头不属于当前项目"));
    // 失败不清空路径与目标，用户可直接改完重试。
    expect(
      (screen.getByLabelText(/本地文件绝对路径/) as HTMLInputElement).value,
    ).toBe("D:/comic/a.png");
    expect(screen.getByRole("combobox", { name: "关联对象" }).textContent).toContain("镜头 1");
  });

  it("文件缺失的版本只给占位提示，不请求解码", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v1/);
    screen.getByText(/v1/).click();

    await screen.findByDisplayValue("C:/definitely/not/existing/a.png");
    expect(screen.getByText(/文件缺失：引用路径当前不存在/)).toBeTruthy();
    expect(fs.fsReadBinary).not.toHaveBeenCalled();
    expect(fs.fsPreviewImage).not.toHaveBeenCalled();
  });

  it("图片访问失败给出错误占位，不崩溃", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v2/);
    screen.getByText(/v2/).click();
    await screen.findByDisplayValue("D:/exists/b.png");

    expect(await screen.findByText(/系统缩略图管线无法解码该图片/)).toBeTruthy();
  });

  it("同镜头两个图片版本并排比较，并可直接采用", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v2/);

    fireEvent.click(screen.getByRole("button", { name: "对比 v2" }));
    fireEvent.click(screen.getByRole("button", { name: "对比 v3" }));

    expect(screen.getByRole("region", { name: "版本比较" })).toBeTruthy();
    expect(screen.getByText(/版本比较 · 镜头 1/)).toBeTruthy();
    expect(screen.getByText("当前采用")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "采用此版本" }));
    await waitFor(() => {
      expect(api.comicMediaAdopt).toHaveBeenCalledWith("m3");
    });
  });

  it("文件缺失的版本不可加入比较", async () => {
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v1/);

    expect(
      (screen.getByRole("button", { name: "对比 v1" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("按扩展名推断素材类型，避免图片选了视频类型", () => {
    expect(mediaKindOfPath("D:/a/b.PNG")).toBe("image");
    expect(mediaKindOfPath("D:/a/b.mp4")).toBe("video");
    expect(mediaKindOfPath("D:/a/b.psd")).toBe("other");
  });

  it("登记外部生成：自动渲染→复制→修改实际提示词后原样提交", async () => {
    api.comicPromptTemplateList.mockResolvedValue({ templates: [promptTemplate] });
    api.comicPromptVersionList.mockResolvedValue({ versions: [promptVersion] });
    const onNotice = vi.fn();
    render(<AssetsPanel {...base} archived={false} onNotice={onNotice} />);
    await screen.findByText(/v1/);

    fireEvent.click(screen.getByRole("button", { name: "登记外部生成" }));
    pickSelect("生成记录剧集", "第 1 集 · 第一集");
    pickSelect("生成记录提示词模板", "图片生成模板 · 图片生成");
    await waitFor(() => {
      expect(api.comicPromptVersionList).toHaveBeenCalledWith("t1");
    });
    pickSelect("生成记录提示词版本", `v1 · 默认 · ${shortHash("hash-1")}`);

    await waitFor(() => {
      expect(
        (screen.getByRole("textbox", { name: "实际使用提示词" }) as HTMLTextAreaElement).value,
      ).toBe(promptPreview.rendered);
    });
    expect(api.comicPromptRender).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", promptVersionId: "pv1", episodeId: "e1" }),
    );
    expect(screen.getByText(`v1 · Hash ${shortHash("hash-1")}`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^复制提示词$/ }));
    await waitFor(() => {
      expect(clip.copyText).toHaveBeenCalledWith(promptPreview.rendered);
    });
    expect(await screen.findByRole("button", { name: /已复制提示词/ })).toBeTruthy();
    expect(onNotice).toHaveBeenCalledWith("ok", "已复制提示词到剪贴板");

    // 外部工具实际收到的文本可能被改过：登记必须保存这份文本，而不是自动渲染结果。
    const edited = "【角色】林远\n外部工具实际收到的文本（已改）\n--ar 16:9，中文标点：。";
    fireEvent.change(screen.getByRole("textbox", { name: "实际使用提示词" }), { target: { value: edited } });
    expect(screen.getByText(/已修改：登记将保存当前文本/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "登记生成记录" }));
    await waitFor(() => {
      expect(api.comicGenerationRecordCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          episodeId: "e1",
          shotId: null,
          promptVersionId: "pv1",
          renderedPromptSnapshot: edited,
        }),
      );
    });
  });

  it("实际使用提示词为空时拒绝登记，不伪造空记录", async () => {
    api.comicPromptTemplateList.mockResolvedValue({ templates: [promptTemplate] });
    api.comicPromptVersionList.mockResolvedValue({ versions: [promptVersion] });
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText(/v1/);

    fireEvent.click(screen.getByRole("button", { name: "登记外部生成" }));
    pickSelect("生成记录剧集", "第 1 集 · 第一集");
    pickSelect("生成记录提示词模板", "图片生成模板 · 图片生成");
    await waitFor(() => {
      expect(api.comicPromptVersionList).toHaveBeenCalledWith("t1");
    });
    pickSelect("生成记录提示词版本", `v1 · 默认 · ${shortHash("hash-1")}`);
    await waitFor(() => {
      expect(
        (screen.getByRole("textbox", { name: "实际使用提示词" }) as HTMLTextAreaElement).value,
      ).toBe(promptPreview.rendered);
    });

    fireEvent.change(screen.getByRole("textbox", { name: "实际使用提示词" }), {
      target: { value: "   \n  " },
    });
    expect(
      (screen.getByRole("button", { name: /^复制提示词$/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "登记生成记录" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("请填写外部工具实际收到的提示词");
    });
    expect(api.comicGenerationRecordCreate).not.toHaveBeenCalled();
  });

  it("导入素材：整集级记录只能选本集镜头，跨集记录不出现", async () => {
    api.comicGenerationRecordList.mockResolvedValue({
      runs: [
        runStub({ id: "r1", shotId: "h1", shotNo: 1, modelProvider: "同镜头记录" }),
        runStub({ id: "r2", shotId: null, modelProvider: "整集本集记录" }),
        runStub({ id: "r3", shotId: null, episodeId: "e2", modelProvider: "整集跨集记录" }),
        runStub({ id: "r4", shotId: "h9", shotNo: 9, modelProvider: "别的镜头记录" }),
      ],
    });
    render(<AssetsPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findAllByText(/v1/);
    openImportForm();
    pickSelect("关联对象", "镜头 1 · A-镜头1描述");

    fireEvent.click(screen.getByRole("combobox", { name: "关联生成记录" }));
    expect(screen.getByRole("option", { name: /同镜头记录/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /整集本集记录/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /整集跨集记录/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /别的镜头记录/ })).toBeNull();
  });
});

