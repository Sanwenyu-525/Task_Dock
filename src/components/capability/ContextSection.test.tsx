/**
 * @vitest-environment jsdom
 */
//! 项目上下文子页：保存、复制、装配、字符上限与来源。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  capabilityContextAssemble: vi.fn(),
  capabilityContextDelete: vi.fn(),
  capabilityContextDuplicate: vi.fn(),
  capabilityContextGet: vi.fn(),
  capabilityContextList: vi.fn(),
  capabilityContextSave: vi.fn(),
  capabilityKbList: vi.fn(),
  capabilityMcpServersList: vi.fn(),
  capabilitySkillList: vi.fn(),
  workspaceProjectList: vi.fn(),
}));

vi.mock("../../lib/bridge", () => api);

import ContextSection from "./ContextSection";

const kb = {
  id: "kb1",
  name: "资料库",
  description: "",
  kind: "personal" as const,
  projectId: null,
  workspaceId: null,
  favorite: false,
  docCount: 1,
  indexedCount: 1,
  failedCount: 0,
  createdAt: "",
  updatedAt: "",
};

const skill = {
  id: "s1",
  name: "章节检查",
  description: "检查一致性",
  sourceKind: "discovered" as const,
  sourcePath: "C:\\skills\\check",
  scope: "global" as const,
  projectId: null,
  workspaceId: null,
  agentId: null,
  enabled: true,
  riskLevel: "low" as const,
  riskNotes: [],
  version: "1.0",
  formatOk: true,
  missing: false,
  nameConflict: false,
  updatedAt: "",
};

const profile = {
  id: "ctx1",
  name: "写作上下文",
  description: "说明",
  projectId: null,
  config: {
    kbIds: ["kb1"],
    skillIds: ["s1"],
    mcpTools: [{ serverId: "srv1", toolName: "echo" }],
    taskIds: ["t1"],
    rules: "保持人物一致",
  },
  createdAt: "",
  updatedAt: "",
};

const server = {
  id: "srv1",
  name: "Fixture",
  transport: "stdio" as const,
  command: "node",
  args: [],
  env: [],
  enabled: true,
  allowHighRisk: false,
  status: "ok" as const,
  lastError: "",
  serverInfo: {},
  tools: [
    {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object", properties: {} },
      highRisk: false,
      riskLevel: "low" as const,
      riskReasons: [],
      annotations: { readOnlyHint: true },
      trusted: false,
    },
  ],
  resources: [],
  prompts: [],
  lastConnectedAt: null,
  createdAt: "",
  updatedAt: "",
};

const bundle = {
  sections: [
    {
      kind: "knowledge",
      title: "相关知识",
      items: [
        {
          id: "d1",
          title: "设定",
          source: "知识库：资料库",
          excerpt: "Alpha 设定",
          chars: 8,
        },
      ],
      chars: 8,
    },
  ],
  totalChars: 8,
  truncated: true,
  sources: [{ kind: "knowledge", id: "d1", label: "设定", path: null }],
};

function resetMocks() {
  for (const fn of Object.values(api)) fn.mockReset();
  api.capabilityContextList.mockResolvedValue([profile]);
  api.capabilityContextGet.mockResolvedValue(profile);
  api.capabilityContextSave.mockImplementation(async (input: Record<string, unknown>) => ({
    ...profile,
    ...input,
  }));
  api.capabilityContextDuplicate.mockResolvedValue({ ...profile, id: "ctx2", name: "写作上下文（副本）" });
  api.capabilityContextDelete.mockResolvedValue(true);
  api.capabilityContextAssemble.mockResolvedValue(bundle);
  api.capabilityKbList.mockResolvedValue([kb]);
  api.capabilitySkillList.mockResolvedValue([skill]);
  api.capabilityMcpServersList.mockResolvedValue([server]);
  api.workspaceProjectList.mockResolvedValue({ projects: [] });
}

beforeEach(resetMocks);
afterEach(cleanup);

describe("ContextSection", () => {
  it("保存上下文时提交绑定的库/Skill/工具与任务", async () => {
    render(<ContextSection />);
    await waitFor(() => expect(api.capabilityContextGet).toHaveBeenCalledWith("ctx1"));
    fireEvent.click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.capabilityContextSave).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "ctx1",
          config: expect.objectContaining({
            kbIds: ["kb1"],
            skillIds: ["s1"],
            taskIds: ["t1"],
          }),
        }),
      ),
    );
  });

  it("装配时传递 maxChars 并展示截断与来源", async () => {
    render(<ContextSection />);
    await waitFor(() => expect(api.capabilityContextGet).toHaveBeenCalledWith("ctx1"));
    fireEvent.change(await screen.findByPlaceholderText(/检索关键词/), {
      target: { value: "Alpha" },
    });
    const budget = screen.getByLabelText("字符上限");
    fireEvent.change(budget, { target: { value: "800" } });
    fireEvent.click(screen.getByRole("button", { name: "装配" }));
    await waitFor(() =>
      expect(api.capabilityContextAssemble).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ctx1", query: "Alpha", maxChars: 800 }),
      ),
    );
    expect(await screen.findByText("共 8 字符")).toBeTruthy();
    expect(screen.getByText("已按上限截断")).toBeTruthy();
    expect(screen.getByText("Alpha 设定")).toBeTruthy();
    expect(document.querySelector(".cap-sources")?.textContent).toContain("knowledge · 设定");
  });

  it("复制与删除走真实命令", async () => {
    render(<ContextSection />);
    await waitFor(() => expect(api.capabilityContextGet).toHaveBeenCalledWith("ctx1"));
    fireEvent.click(await screen.findByRole("button", { name: "复制" }));
    await waitFor(() => expect(api.capabilityContextDuplicate).toHaveBeenCalledWith("ctx1"));

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.capabilityContextDelete).toHaveBeenCalledWith("ctx1"));
  });
});
