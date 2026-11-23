/**
 * @vitest-environment jsdom
 */
//! 漫剧角色与场景模块（C3）前端测试。
//!
//! 覆盖：列表/选中编辑、归档只读、保存失败可见；
//! 本轮新增：参考图选择器、缩略图、大图预览、缺失提醒，且不影响其它字段编辑。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  comicCharacterList: vi.fn(),
  comicCharacterSave: vi.fn(),
  comicCharacterDelete: vi.fn(),
  comicSceneList: vi.fn(),
  comicSceneSave: vi.fn(),
  comicSceneDelete: vi.fn(),
}));

const fs = vi.hoisted(() => ({
  fsThumbnail: vi.fn(),
  fsReadBinary: vi.fn(),
  fsPreviewImage: vi.fn(),
}));

const dialog = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("./ipc", () => api);
vi.mock("../../../lib/bridge", () => fs);
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

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
  refImagePath: "D:/comic/gone-scene.png",
  refImageExists: false,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};
const withRef = {
  ...character,
  id: "c2",
  name: "队友",
  refImagePath: "D:/comic/gone.png",
  refImageExists: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.comicCharacterList.mockResolvedValue({ characters: [character, withRef] });
  api.comicSceneList.mockResolvedValue({ scenes: [scene] });
  api.comicCharacterSave.mockResolvedValue({ character });
  api.comicSceneSave.mockResolvedValue({ scene });
  api.comicCharacterDelete.mockResolvedValue({ ok: true });
  api.comicSceneDelete.mockResolvedValue({ ok: true });
  fs.fsThumbnail.mockResolvedValue(null);
  fs.fsReadBinary.mockRejectedValue(new Error("读取失败"));
  fs.fsPreviewImage.mockResolvedValue(null);
  dialog.open.mockResolvedValue("D:/comic/picked.png");
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

  it("参考图用现有文件选择器写入路径，保存时随角色提交", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("黑发少年");
    screen.getByText("黑发少年").click();
    await screen.findByDisplayValue("黑发少年");

    fireEvent.click(screen.getByRole("button", { name: /选择图片/ }));
    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalledWith(
        expect.objectContaining({ directory: false, multiple: false }),
      );
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText("参考图路径") as HTMLInputElement).value,
      ).toBe("D:/comic/picked.png");
    });

    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    await waitFor(() => {
      expect(api.comicCharacterSave).toHaveBeenCalledWith(
        expect.objectContaining({ refImagePath: "D:/comic/picked.png", name: "黑发少年" }),
      );
    });
  });

  it("已保存参考图缺失时给出提醒，路径不被清空", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("队友");
    screen.getByText("队友").click();

    await screen.findByDisplayValue("D:/comic/gone.png");
    expect(screen.getByText(/参考图文件缺失/)).toBeTruthy();
    expect((screen.getByLabelText("参考图路径") as HTMLInputElement).value).toBe(
      "D:/comic/gone.png",
    );
  });

  it("参考图可展开大图预览；解码失败给出错误占位", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("队友");
    screen.getByText("队友").click();
    await screen.findByDisplayValue("D:/comic/gone.png");

    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByText(/文件缺失：引用路径当前不存在/)).toBeTruthy();
  });

  it("清除参考图只清字段，不影响其它字段", async () => {
    render(<CharactersPanel {...base} archived={false} onNotice={vi.fn()} />);
    await screen.findByText("队友");
    screen.getByText("队友").click();
    await screen.findByDisplayValue("D:/comic/gone.png");

    fireEvent.click(screen.getByRole("button", { name: "清除参考图" }));
    expect((screen.getByLabelText("参考图路径") as HTMLInputElement).value).toBe("");
    expect(screen.getByDisplayValue("队友")).toBeTruthy();
  });

  it("归档项目：参考图选择/清除入口置灰（只读），预览仍可用", async () => {
    render(<CharactersPanel {...base} archived onNotice={vi.fn()} />);
    await screen.findByText("队友");
    screen.getByText("队友").click();
    await screen.findByDisplayValue("D:/comic/gone.png");

    expect(
      (screen.getByRole("button", { name: /选择图片/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "清除参考图" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "预览" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
