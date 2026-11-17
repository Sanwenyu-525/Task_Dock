/**
 * @vitest-environment jsdom
 */
//! 游戏「资源」模块测试（G1）：识别结果展示、事项分组、资源失效提示、归档只读、非游戏降级。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  gameProjectDetect: vi.fn(),
  gameProjectFactsGet: vi.fn(),
  gameProjectFactsSave: vi.fn(),
  gameAssetList: vi.fn(),
  gameAssetSave: vi.fn(),
  gameAssetDelete: vi.fn(),
  workspaceItemList: vi.fn(),
  workspaceItemSave: vi.fn(),
  workspaceItemDelete: vi.fn(),
  fsOpen: vi.fn(),
}));

vi.mock("./ipc", () => api);

import GameAssetsPanel from "./GameAssetsPanel";

const baseProps = {
  projectId: "p1",
  projectName: "测试游戏",
  kind: "game" as const,
  archived: false,
  rootPath: "D:\\proj",
  rootExists: true,
  devProjectId: null,
  onNotice: vi.fn(),
  switchModule: vi.fn(),
};

const item = {
  id: "it1",
  projectId: "p1",
  parentId: null,
  title: "关卡设计",
  stage: "草稿",
  status: "doing" as const,
  sortOrder: 0,
  metadataJson: '{"category":"level"}',
  createdAt: "2026-11-16T09:00:00+08:00",
  updatedAt: "2026-11-16T09:00:00+08:00",
};

const existingAsset = {
  id: "a1",
  projectId: "p1",
  kind: "image",
  name: "玩家贴图",
  path: "D:\\proj\\player.png",
  relativePath: "player.png",
  location: "inside",
  sizeBytes: 1234,
  modifiedAt: "2026-11-16T09:00:00+08:00",
  itemId: "it1",
  note: "",
  createdAt: "2026-11-16T09:00:00+08:00",
  updatedAt: "2026-11-16T09:00:00+08:00",
  pathExists: true,
  itemExists: true,
};

const lostAsset = {
  id: "a2",
  projectId: "p1",
  kind: "model",
  name: "待导入模型",
  path: "D:\\proj\\pending.glb",
  relativePath: "pending.glb",
  location: "inside",
  sizeBytes: 0,
  modifiedAt: "",
  itemId: null,
  note: "",
  createdAt: "2026-11-16T09:00:00+08:00",
  updatedAt: "2026-11-16T09:00:00+08:00",
  pathExists: false,
  itemExists: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.gameProjectDetect.mockResolvedValue({
    detection: {
      engine: "godot",
      engineVersion: "4.3",
      evidence: ["project.godot"],
      conflicts: [],
      rootExists: true,
      rootPath: "D:\\proj",
    },
    facts: null,
  });
  api.workspaceItemList.mockResolvedValue({ items: [item] });
  api.gameAssetList.mockResolvedValue({ assets: [existingAsset, lostAsset] });
  api.workspaceItemSave.mockResolvedValue({ item });
  api.gameAssetSave.mockResolvedValue({ asset: existingAsset });
});

afterEach(() => cleanup());

describe("GameAssetsPanel", () => {
  it("展示识别结果、事项分组与资源失效提示", async () => {
    const { container } = render(<GameAssetsPanel {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("game-engine-badge").textContent).toContain("Godot");
    });
    await waitFor(() => expect(container.textContent).toContain("关卡设计"));
    expect(container.textContent).toContain("玩家贴图");
    // 失效资源必须可见降级提示。
    expect(screen.getByTestId("asset-lost").textContent).toContain("文件丢失");
    // 存在的资源提供打开原文件入口。
    expect(screen.getByLabelText("打开原文件")).toBeTruthy();
  });

  it("归档项目隐藏所有写入口", async () => {
    const { container } = render(<GameAssetsPanel {...baseProps} archived />);
    await waitFor(() => expect(container.textContent).toContain("关卡设计"));
    expect(screen.queryByText("新增事项")).toBeNull();
    expect(screen.queryByText("登记资源")).toBeNull();
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("非 game 类型防御性降级", () => {
    render(<GameAssetsPanel {...baseProps} kind="novel" />);
    expect(screen.getByText("游戏资源模块仅对游戏项目开放。")).toBeTruthy();
  });

  it("多引擎标记冲突时展示冲突警告，不静默取首个", async () => {
    api.gameProjectDetect.mockResolvedValue({
      detection: {
        engine: "unity",
        engineVersion: "2021.3.0f1",
        evidence: ["ProjectSettings/ProjectVersion.txt"],
        conflicts: ["unreal: Duel.uproject", "godot: project.godot"],
        rootExists: true,
        rootPath: "D:\\proj",
      },
      facts: null,
    });
    render(<GameAssetsPanel {...baseProps} />);

    await waitFor(() => expect(screen.getByTestId("game-detect-conflicts")).toBeTruthy());
    expect(screen.getByTestId("game-detect-conflicts").textContent).toContain("多引擎标记冲突");
  });

  it("已保存手动指定的事实不被自动扫描覆盖", async () => {
    api.gameProjectDetect.mockResolvedValue({
      detection: {
        engine: "unity",
        engineVersion: "2021.3.0f1",
        evidence: ["ProjectSettings/ProjectVersion.txt"],
        conflicts: [],
        rootExists: true,
        rootPath: "D:\\proj",
      },
      facts: {
        id: "f1",
        projectId: "p1",
        engine: "godot",
        detectionMethod: "manual",
        engineVersion: "4.3",
        evidence: "用户手动指定",
        createdAt: "2026-11-16T09:00:00+08:00",
        updatedAt: "2026-11-16T09:00:00+08:00",
      },
    });
    render(<GameAssetsPanel {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByTestId("game-engine-badge").textContent).toContain("Godot"),
    );

    fireEvent.click(screen.getByText("重新识别"));
    await waitFor(() => expect(api.gameProjectFactsSave).not.toHaveBeenCalled());
  });

  it("保存事项时写入分类元数据并刷新", async () => {
    const { container } = render(<GameAssetsPanel {...baseProps} />);
    await waitFor(() => expect(container.textContent).toContain("关卡设计"));

    fireEvent.click(screen.getByText("新增事项"));
    const titleInput = screen.getByPlaceholderText("事项标题") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "玩法机制" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(api.workspaceItemSave).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          title: "玩法机制",
          metadataJson: expect.stringContaining("system"),
        }),
      );
    });
    // 保存后重新拉取列表。
    expect(api.workspaceItemList).toHaveBeenCalled();
  });
});
