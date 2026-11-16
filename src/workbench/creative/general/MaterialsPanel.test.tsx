/**
 * @vitest-environment jsdom
 */
//! 通用线 materials 模块测试（U1 D3）：资料列表、失效提示、移除关联、归档只读。
//! 只 mock 本目录 `./ipc.ts` 包装层。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  generalMaterialList: vi.fn(),
  generalMaterialSave: vi.fn(),
  generalMaterialDelete: vi.fn(),
  generalMaterialOpen: vi.fn(),
}));

vi.mock("./ipc", () => api);

import MaterialsPanel from "./MaterialsPanel";

const baseProps = {
  projectId: "p1",
  projectName: "通用项目",
  kind: "general" as const,
  archived: false,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  onNotice: vi.fn(),
  switchModule: vi.fn(),
};

const materials = [
  {
    id: "mat1",
    projectId: "p1",
    kind: "file" as const,
    title: "原始笔记",
    path: "D:\\docs\\note.txt",
    note: "",
    alive: true,
    aliveReason: null,
    linkedTitle: null,
    sortOrder: 0,
    createdAt: "2026-11-16T09:00:00+08:00",
    updatedAt: "2026-11-16T09:00:00+08:00",
  },
  {
    id: "mat2",
    projectId: "p1",
    kind: "link" as const,
    title: "旧页面",
    path: "https://old.example.com",
    note: "",
    alive: false,
    aliveReason: "链接地址无效或已失效",
    linkedTitle: null,
    sortOrder: 1,
    createdAt: "2026-11-16T09:05:00+08:00",
    updatedAt: "2026-11-16T09:05:00+08:00",
  },
];

beforeEach(() => {
  api.generalMaterialList.mockResolvedValue({ materials });
  api.generalMaterialSave.mockResolvedValue({ material: materials[0] });
  api.generalMaterialDelete.mockResolvedValue({ ok: true });
  api.generalMaterialOpen.mockResolvedValue({ kind: "file", opened: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MaterialsPanel 资料关联", () => {
  it("渲染可用与失效资料，失效项显示原因且禁止打开", async () => {
    render(<MaterialsPanel {...baseProps} />);
    await waitFor(() => expect(api.generalMaterialList).toHaveBeenCalledWith("p1"));

    expect(screen.getByText("原始笔记")).toBeTruthy();
    expect(screen.getByText("可用")).toBeTruthy();
    expect(screen.getByText("旧页面")).toBeTruthy();
    expect(screen.getByText("失效")).toBeTruthy();
    expect(screen.getByText("链接地址无效或已失效")).toBeTruthy();

    const openDead = screen.getByRole("button", { name: "打开 旧页面" }) as HTMLButtonElement;
    expect(openDead.disabled).toBe(true);
  });

  it("两步确认后移除关联，调用删除命令", async () => {
    render(<MaterialsPanel {...baseProps} />);
    await waitFor(() => expect(screen.getByText("原始笔记")).toBeTruthy());

    const remove = screen.getByRole("button", { name: /移除 原始笔记/ });
    fireEvent.click(remove);
    expect(api.generalMaterialDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /确认移除 原始笔记/ }));
    await waitFor(() => expect(api.generalMaterialDelete).toHaveBeenCalledWith("mat1"));
  });

  it("归档项目禁用添加入口", async () => {
    render(<MaterialsPanel {...baseProps} archived />);
    await waitFor(() => expect(api.generalMaterialList).toHaveBeenCalled());
    expect(
      (screen.getByRole("button", { name: /添加资料/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText("项目已归档，资料关联为只读；恢复为进行中后才能添加或移除。"),
    ).toBeTruthy();
  });
});
