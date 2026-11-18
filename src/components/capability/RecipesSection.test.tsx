/**
 * @vitest-environment jsdom
 */
//! 能力配方子页：保存、启停、运行、高风险确认、失败与导出。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  capabilityKbList: vi.fn(),
  capabilityMcpServersList: vi.fn(),
  capabilityRecipeDelete: vi.fn(),
  capabilityRecipeDuplicate: vi.fn(),
  capabilityRecipeExport: vi.fn(),
  capabilityRecipeGet: vi.fn(),
  capabilityRecipeImport: vi.fn(),
  capabilityRecipeList: vi.fn(),
  capabilityRecipeRun: vi.fn(),
  capabilityRecipeRunGet: vi.fn(),
  capabilityRecipeRuns: vi.fn(),
  capabilityRecipeSave: vi.fn(),
}));

vi.mock("../../lib/bridge", () => api);

import RecipesSection from "./RecipesSection";

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
      name: "write_file",
      description: "Write",
      inputSchema: { type: "object", properties: {} },
      highRisk: true,
      riskLevel: "high" as const,
      riskReasons: ["annotations.destructiveHint=true"],
      annotations: { destructiveHint: true },
      trusted: false,
    },
  ],
  resources: [],
  prompts: [],
  lastConnectedAt: null,
  createdAt: "",
  updatedAt: "",
};

const recipe = {
  id: "r1",
  name: "测试配方",
  description: "说明",
  projectId: null,
  enabled: true,
  steps: [
    { type: "knowledge_search" as const, kbIds: ["kb1"], query: "人物", limit: 5 },
    { type: "save_note" as const, title: "结果" },
  ],
  createdAt: "",
  updatedAt: "",
};

const summary = {
  id: "r1",
  name: "测试配方",
  description: "说明",
  projectId: null,
  enabled: true,
  stepCount: 2,
  lastRunStatus: null,
  lastRunAt: null,
  updatedAt: "",
};

const runResult = {
  id: "run1",
  recipeId: "r1",
  recipeName: "测试配方",
  status: "succeeded",
  startedAt: "",
  finishedAt: "",
  steps: [
    {
      index: 0,
      stepType: "knowledge_search",
      status: "succeeded",
      detail: "",
      output: { total: 1 },
      durationMs: 3,
    },
  ],
  error: "",
};

function resetMocks() {
  for (const fn of Object.values(api)) fn.mockReset();
  api.capabilityRecipeList.mockResolvedValue([summary]);
  api.capabilityRecipeGet.mockResolvedValue(recipe);
  api.capabilityRecipeSave.mockImplementation(async (input: Record<string, unknown>) => ({
    ...recipe,
    ...input,
  }));
  api.capabilityRecipeRuns.mockResolvedValue({
    items: [],
    total: 0,
    offset: 0,
    limit: 20,
    hasMore: false,
  });
  api.capabilityRecipeRun.mockResolvedValue(runResult);
  api.capabilityRecipeExport.mockResolvedValue('{"version":1}');
  api.capabilityKbList.mockResolvedValue([kb]);
  api.capabilityMcpServersList.mockResolvedValue([server]);
}

beforeEach(resetMocks);
afterEach(cleanup);

async function openRecipe() {
  render(<RecipesSection />);
  await screen.findByText("测试配方");
  fireEvent.click(screen.getByText("测试配方"));
  await waitFor(() => expect(api.capabilityRecipeGet).toHaveBeenCalledWith("r1"));
  await waitFor(() => expect(screen.getByRole("button", { name: /执行/ })).toBeTruthy());
}

describe("RecipesSection", () => {
  it("保存配方提交真实步骤；启停开关即时进入草稿", async () => {
    await openRecipe();
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.capabilityRecipeSave).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "r1",
          enabled: false,
          steps: recipe.steps,
        }),
      ),
    );
  });

  it("运行成功展示结果与步骤记录", async () => {
    await openRecipe();
    fireEvent.click(screen.getByRole("button", { name: /执行/ }));
    await waitFor(() => expect(api.capabilityRecipeRun).toHaveBeenCalledWith("r1", false));
    expect(await screen.findByText("配方执行成功")).toBeTruthy();
  });

  it("高风险步骤运行前必须确认", async () => {
    api.capabilityRecipeGet.mockResolvedValue({
      ...recipe,
      steps: [
        {
          type: "mcp_tool",
          serverId: "srv1",
          toolName: "write_file",
          args: {},
          highRisk: true,
        },
      ],
    });
    await openRecipe();
    fireEvent.click(screen.getByRole("button", { name: /执行/ }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: /仍然执行/ }));
    await waitFor(() => expect(api.capabilityRecipeRun).toHaveBeenCalledWith("r1", true));
  });

  it("运行失败如实展示，不伪装成功", async () => {
    api.capabilityMcpServersList.mockResolvedValue([]);
    api.capabilityRecipeRun.mockResolvedValue({
      ...runResult,
      status: "failed",
      error: "MCP Server 不可用",
      steps: [
        {
          index: 0,
          stepType: "mcp_tool",
          status: "failed",
          detail: "MCP Server 不可用",
          output: null,
          durationMs: 1,
        },
      ],
    });
    api.capabilityRecipeGet.mockResolvedValue({
      ...recipe,
      steps: [
        {
          type: "mcp_tool",
          serverId: "srv1",
          toolName: "write_file",
          args: {},
          highRisk: false,
        },
      ],
    });
    await openRecipe();
    fireEvent.click(screen.getByRole("button", { name: /执行/ }));
    expect(await screen.findByText(/配方执行失败/)).toBeTruthy();
  });

  it("导出默认不含敏感参数，勾选后才请求包含", async () => {
    await openRecipe();
    fireEvent.click(screen.getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(api.capabilityRecipeExport).toHaveBeenCalledWith("r1", false));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("switch"));
    await waitFor(() => expect(api.capabilityRecipeExport).toHaveBeenCalledWith("r1", true));
  });
});

