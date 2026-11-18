/**
 * @vitest-environment jsdom
 */
//! 外部 MCP 子页：连接测试、Tools/Resources/Prompts、风险确认、参数脱敏与导出。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  agentMcpStatus: vi.fn(),
  capabilityMcpCalls: vi.fn(),
  capabilityMcpServerCall: vi.fn(),
  capabilityMcpServerDelete: vi.fn(),
  capabilityMcpServerSave: vi.fn(),
  capabilityMcpServerSetAllowHighRisk: vi.fn(),
  capabilityMcpServerSetEnabled: vi.fn(),
  capabilityMcpServerTest: vi.fn(),
  capabilityMcpServersList: vi.fn(),
}));

vi.mock("../../lib/bridge", () => api);

import McpServersSection from "./McpServersSection";

const tools = [
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
  {
    name: "search",
    description: "Find",
    inputSchema: { type: "object", properties: {} },
    highRisk: false,
    riskLevel: "unknown" as const,
    riskReasons: [],
    annotations: null,
    trusted: false,
  },
  {
    name: "write_file",
    description: "Write a file",
    inputSchema: { type: "object", properties: {} },
    highRisk: true,
    riskLevel: "high" as const,
    riskReasons: ["annotations.destructiveHint=true", "名称/描述包含 write"],
    annotations: { destructiveHint: true },
    trusted: false,
  },
];

const resources = [
  {
    uri: "file:///fixture/readme.md",
    name: "readme",
    description: "Fixture readme",
    mimeType: "text/markdown",
  },
];

const prompts = [
  {
    name: "summarize",
    description: "Summarize",
    arguments: [{ name: "text", required: true }],
  },
];

const server = {
  id: "srv1",
  name: "Fixture Server",
  transport: "stdio" as const,
  command: "node",
  args: ["--token", "secret-value", "--verbose"],
  env: [{ key: "API_KEY", hasValue: true }],
  enabled: true,
  allowHighRisk: false,
  status: "ok" as const,
  lastError: "",
  serverInfo: {},
  tools,
  resources,
  prompts,
  lastConnectedAt: "2026-11-18T00:00:00Z",
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
};

const emptyCalls = { items: [], total: 0, offset: 0, limit: 20, hasMore: false };

function resetMocks() {
  for (const fn of Object.values(api)) fn.mockReset();
  api.capabilityMcpServersList.mockResolvedValue([server]);
  api.capabilityMcpCalls.mockResolvedValue(emptyCalls);
  api.agentMcpStatus.mockResolvedValue({
    enabled: true,
    running: true,
    port: 43123,
    agent_count: 1,
    active_agent_count: 1,
    last_call: null,
  });
  api.capabilityMcpServerTest.mockResolvedValue({
    ok: true,
    durationMs: 42,
    protocolVersion: "2026-07-28",
    serverInfo: {},
    tools,
    resources,
    prompts,
    error: null,
  });
  api.capabilityMcpServerCall.mockResolvedValue({
    ok: true,
    durationMs: 5,
    isError: false,
    content: [{ type: "text", text: "ok" }],
    error: null,
  });
  api.capabilityMcpServerSave.mockImplementation(async (input: Record<string, unknown>) => ({
    ...server,
    ...input,
    id: (input.id as string) ?? "srv2",
  }));
  api.capabilityMcpServerSetEnabled.mockResolvedValue(server);
  api.capabilityMcpServerSetAllowHighRisk.mockResolvedValue(server);
}

beforeEach(resetMocks);
afterEach(cleanup);

describe("McpServersSection", () => {
  it("敏感启动参数脱敏展示，导出默认剔除", async () => {
    render(<McpServersSection />);
    await screen.findAllByText("Fixture Server");
    expect(screen.queryByText(/secret-value/)).toBeNull();
    expect(screen.getAllByText(/••••••••/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    const dialog = await screen.findByRole("dialog");
    const pre = within(dialog).getByText((_, element) => element?.tagName === "PRE");
    expect(pre.textContent).not.toContain("secret-value");
    fireEvent.click(within(dialog).getByRole("switch"));
    await waitFor(() => expect(pre.textContent).toContain("secret-value"));
  });

  it("连接测试后展示 Resources 与 Prompts 明细", async () => {
    render(<McpServersSection />);
    await screen.findAllByText("Fixture Server");
    fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));
    await waitFor(() => expect(api.capabilityMcpServerTest).toHaveBeenCalledWith("srv1"));
    expect(await screen.findByText("file:///fixture/readme.md")).toBeTruthy();
    expect(await screen.findByText("summarize")).toBeTruthy();
    expect(screen.getByText("text/markdown")).toBeTruthy();
  });

  it("高风险工具每次确认，未知风险首次确认", async () => {
    render(<McpServersSection />);
    await screen.findAllByText("Fixture Server");

    fireEvent.click(screen.getByText("write_file"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "调用" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "调用" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/write_file/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /仍然调用/ }));
    await waitFor(() =>
      expect(api.capabilityMcpServerCall).toHaveBeenCalledWith(
        "srv1",
        "write_file",
        "{}",
        true,
      ),
    );

    api.capabilityMcpServerCall.mockClear();
    fireEvent.click(screen.getByText("search"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "调用" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "调用" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /仍然调用/ }));
    await waitFor(() =>
      expect(api.capabilityMcpServerCall).toHaveBeenCalledWith(
        "srv1",
        "search",
        "{}",
        true,
      ),
    );
  });

  it("新增 Server 保存真实参数；编辑未改参数时保留原值", async () => {
    render(<McpServersSection />);
    await screen.findAllByText("Fixture Server");
    fireEvent.click(screen.getByRole("button", { name: /添加 Server/ }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "新 Server" } });
    fireEvent.change(within(dialog).getByLabelText("启动命令"), {
      target: { value: "node" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("每行一个参数"), {
      target: { value: "server.mjs\n--verbose" },
    });    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.capabilityMcpServerSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "新 Server",
          command: "node",
          args: ["server.mjs", "--verbose"],
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.capabilityMcpServerSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "srv1", args: server.args }),
      ),
    );
  });
});
