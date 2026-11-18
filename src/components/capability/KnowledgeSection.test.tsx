/**
 * @vitest-environment jsdom
 */
//! 知识库子页：真实绑定、导入、失败状态、重建与删除。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  capabilityKnowledgeStats: vi.fn(),
  capabilityKbList: vi.fn(),
  capabilityKbGet: vi.fn(),
  capabilityKbCreate: vi.fn(),
  capabilityKbUpdate: vi.fn(),
  capabilityKbDelete: vi.fn(),
  capabilityKbSetFavorite: vi.fn(),
  capabilityKbRebuild: vi.fn(),
  capabilityDocumentList: vi.fn(),
  capabilityDocumentGet: vi.fn(),
  capabilityDocumentImportFile: vi.fn(),
  capabilityDocumentImportFolder: vi.fn(),
  capabilityDocumentImportNote: vi.fn(),
  capabilityDocumentImportCapture: vi.fn(),
  capabilityDocumentCreateText: vi.fn(),
  capabilityDocumentReindex: vi.fn(),
  capabilityDocumentDelete: vi.fn(),
  capabilityKnowledgeSearch: vi.fn(),
  capabilityKnowledgeLinkAdd: vi.fn(),
  capabilityKnowledgeLinkRemove: vi.fn(),
  workspaceProjectList: vi.fn(),
}));

vi.mock("../../lib/bridge", () => api);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../lib/filesWorkspace/folderPicker", () => ({ pickFolder: vi.fn() }));

import KnowledgeSection from "./KnowledgeSection";

const base = {
  id: "kb1",
  name: "资料库",
  description: "项目资料",
  kind: "personal" as const,
  projectId: null,
  workspaceId: null,
  favorite: false,
  docCount: 2,
  indexedCount: 1,
  failedCount: 1,
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
};

const indexedDoc = {
  id: "d1",
  kbId: "kb1",
  title: "设定.md",
  sourceKind: "file" as const,
  sourceMode: "reference" as const,
  sourcePath: "D:\\docs\\setting.md",
  mime: "text/markdown",
  sizeBytes: 10,
  contentHash: "h1",
  status: "indexed" as const,
  error: "",
  chunkCount: 1,
  indexedAt: "2026-11-18T00:00:00Z",
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
};

const failedDoc = {
  ...indexedDoc,
  id: "d2",
  title: "丢失.md",
  status: "failed" as const,
  error: "[source_missing] 原始文件不存在",
  chunkCount: 0,
};

const projects = [
  { id: "p1", name: "项目 A", kind: "general", rootPath: "", status: "active" },
  { id: "p2", name: "项目 B", kind: "novel", rootPath: "", status: "active" },
];

function resetMocks() {
  for (const fn of Object.values(api)) fn.mockReset();
  api.capabilityKnowledgeStats.mockResolvedValue({
    kbCount: 1,
    docCount: 2,
    indexedCount: 1,
    failedCount: 1,
    chunkCount: 1,
  });
  api.capabilityKbList.mockResolvedValue([base]);
  api.capabilityKbCreate.mockResolvedValue({ ...base, id: "kb2", name: "新库" });
  api.capabilityKbUpdate.mockResolvedValue(base);
  api.capabilityKbDelete.mockResolvedValue({ deletedDocs: 2, deletedCopies: 0 });
  api.capabilityKbRebuild.mockResolvedValue({ indexed: 1, failed: 1, skipped: 0 });
  api.capabilityDocumentList.mockResolvedValue({
    documents: [indexedDoc, failedDoc],
    total: 2,
    offset: 0,
    limit: 100,
    hasMore: false,
  });
  api.capabilityDocumentGet.mockImplementation(async (id: string) => ({
    ...(id === "d2" ? failedDoc : indexedDoc),
    content: "正文",
    truncated: false,
    links: [],
  }));
  api.capabilityDocumentImportFile.mockResolvedValue({
    imported: 1,
    skipped: 0,
    duplicates: 0,
    failed: 0,
    items: [],
    documents: [indexedDoc],
  });
  api.capabilityDocumentReindex.mockResolvedValue(indexedDoc);
  api.capabilityDocumentDelete.mockResolvedValue({ deletedCopy: false });
  api.workspaceProjectList.mockResolvedValue({ projects });
}

beforeEach(resetMocks);
afterEach(cleanup);

describe("KnowledgeSection", () => {
  it("创建 personal 知识库时不绑定项目/工作区", async () => {
    render(<KnowledgeSection />);
    await screen.findAllByText("资料库");
    fireEvent.click(screen.getByRole("button", { name: /新建知识库/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "新库" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.capabilityKbCreate).toHaveBeenCalledWith({
        name: "新库",
        description: "",
        kind: "personal",
        projectId: null,
        workspaceId: null,
      }),
    );
  });

  it("project 类型必须选择真实项目，选择后提交 projectId", async () => {
    render(<KnowledgeSection />);
    await screen.findAllByText("资料库");
    fireEvent.click(screen.getByRole("button", { name: /新建知识库/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "项目库" } });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "知识库类型" }));
    fireEvent.click(await screen.findByRole("option", { name: "项目" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.capabilityKbCreate).not.toHaveBeenCalled());
    expect(await screen.findByText("项目类型知识库必须选择真实项目")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("combobox", { name: "项目" }));
    fireEvent.click(await screen.findByRole("option", { name: "项目 A" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.capabilityKbCreate).toHaveBeenCalledWith({
        name: "项目库",
        description: "",
        kind: "project",
        projectId: "p1",
        workspaceId: null,
      }),
    );
  });

  it("编辑时可见并更新绑定关系", async () => {
    render(<KnowledgeSection />);
    await screen.findAllByText("资料库");
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox", { name: "知识库类型" }));
    fireEvent.click(await screen.findByRole("option", { name: "项目" }));
    fireEvent.click(within(dialog).getByRole("combobox", { name: "项目" }));
    fireEvent.click(await screen.findByRole("option", { name: "项目 B" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.capabilityKbUpdate).toHaveBeenCalledWith("kb1", {
        name: "资料库",
        description: "项目资料",
        kind: "project",
        projectId: "p2",
        workspaceId: null,
      }),
    );
  });

  it("导入引用文件走真实 command 参数", async () => {
    render(<KnowledgeSection />);
    await screen.findAllByText("资料库");
    fireEvent.click(screen.getByRole("button", { name: "导入文件" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("文件/文件夹路径"), {
      target: { value: "D:\\docs\\a.md" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "导入" }));
    await waitFor(() =>
      expect(api.capabilityDocumentImportFile).toHaveBeenCalledWith(
        "kb1",
        "D:\\docs\\a.md",
        "reference",
        undefined,
      ),
    );
  });

  it("失败文档展示诊断原因，重建与删除调用真实命令", async () => {
    render(<KnowledgeSection />);
    await screen.findByText("丢失.md");
    fireEvent.click(screen.getByText("丢失.md"));
    await waitFor(() => expect(api.capabilityDocumentGet).toHaveBeenCalledWith("d2"));
    expect(await screen.findByText("[source_missing] 原始文件不存在")).toBeTruthy();
    expect(screen.getAllByText("索引失败").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: /重建索引/ }).at(-1)!);
    await waitFor(() => expect(api.capabilityDocumentReindex).toHaveBeenCalledWith("d2"));

    fireEvent.click(screen.getAllByRole("button", { name: /删除/ }).at(-1)!);
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.capabilityDocumentDelete).toHaveBeenCalledWith("d2"));
  });
});
