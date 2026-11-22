/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  setScope: vi.fn(),
  grant: vi.fn(),
  revokeProject: vi.fn(),
  revoke: vi.fn(),
  rotateToken: vi.fn(),
  auditList: vi.fn(),
  snippet: vi.fn(),
  projects: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  agentMcpStatus: mocks.status,
  agentMcpList: mocks.list,
  agentMcpCreate: mocks.create,
  agentMcpSetScope: mocks.setScope,
  agentMcpGrantProject: mocks.grant,
  agentMcpRevokeProject: mocks.revokeProject,
  agentMcpRevoke: mocks.revoke,
  agentMcpRotateToken: mocks.rotateToken,
  agentMcpAuditList: mocks.auditList,
  agentMcpConfigSnippet: mocks.snippet,
  planningListProjects: mocks.projects,
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import McpAccessSection from "./McpAccessSection";

const STATUS = { enabled: false, running: true, port: 4400, agent_count: 1, started_at: "now" };
const PROJECT = {
  id: "project-1", name: "Project One", description: "", status: "planning", archived: false,
  target_date: null, sort_order: 0, created_at: "now", updated_at: "now", stats: {},
};
const AGENT = {
  id: "identity-1", agent_id: "codex", display_name: "Codex", scope: "readonly", created_at: "now",
  updated_at: "now", revoked_at: null, last_seen_at: null, granted_project_ids: [],
};

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue(STATUS);
  mocks.list.mockReset().mockResolvedValue([AGENT]);
  mocks.create.mockReset().mockResolvedValue({ ...AGENT, id: "new-id", token: "secret-once" });
  mocks.setScope.mockReset().mockImplementation(async (_id, scope) => ({ ...AGENT, scope }));
  mocks.grant.mockReset().mockResolvedValue({ ...AGENT, granted_project_ids: [PROJECT.id] });
  mocks.revokeProject.mockReset().mockResolvedValue(AGENT);
  mocks.revoke.mockReset().mockResolvedValue({ ...AGENT, revoked_at: "now" });
  mocks.rotateToken.mockReset().mockResolvedValue({ ...AGENT, token: "rotated-secret" });
  mocks.auditList.mockReset().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 20 });
  mocks.snippet.mockReset().mockResolvedValue("{\"token\":\"secret-once\"}");
  mocks.projects.mockReset().mockResolvedValue([PROJECT]);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => cleanup());

describe("McpAccessSection", () => {
  it("displays actual running status even when the enable setting is false", async () => {
    render(<McpAccessSection />);
    await screen.findByRole("status");
    expect(screen.getByRole("status").textContent).toContain("settings.mcpAccess.status.running");
    expect(screen.getByRole("status").textContent).toContain("settings.mcpAccess.port|{\"port\":4400}");
    expect(mocks.status).toHaveBeenCalled();
  });

  it("creates a one-time token, copies it, and clears it when the create state closes", async () => {
    render(<McpAccessSection />);
    fireEvent.click(await screen.findByRole("button", { name: "settings.mcpAccess.create" }));
    fireEvent.change(screen.getByLabelText("settings.mcpAccess.agentId"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("settings.mcpAccess.displayName"), { target: { value: "Codex local" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.createCredential" }));

    const token = await screen.findByDisplayValue("secret-once");
    expect(mocks.create).toHaveBeenCalledWith("codex", "Codex local");
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.copyToken" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("secret-once"));
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.generateConfig" }));
    const config = await screen.findByLabelText("settings.mcpAccess.configSnippet");
    expect((config as HTMLTextAreaElement).value).toContain("secret-once");
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.copyConfig" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{"token":"secret-once"}'));
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.closeCreate" }));
    expect(token.isConnected).toBe(false);
    expect(screen.queryByDisplayValue("secret-once")).toBeNull();
    expect(screen.queryByLabelText("settings.mcpAccess.configSnippet")).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("loads project grants and applies scope changes through the bridge", async () => {
    render(<McpAccessSection />);
    await screen.findByRole("heading", { name: "Codex" });
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.scope.project_rw" }));
    await waitFor(() => expect(mocks.setScope).toHaveBeenCalledWith(AGENT.id, "project_rw"));
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.grantProjectTo|{\"project\":\"Project One\"}" }));
    await waitFor(() => expect(mocks.grant).toHaveBeenCalledWith(AGENT.id, PROJECT.id));
    fireEvent.click(await screen.findByRole("button", { name: "settings.mcpAccess.revokeProject" }));
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.confirmAction" }));
    await waitFor(() => expect(mocks.revokeProject).toHaveBeenCalledWith(AGENT.id, PROJECT.id));
  });

  it("revokes an identity through the bridge", async () => {
    render(<McpAccessSection />);
    await screen.findByRole("heading", { name: "Codex" });
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.revoke" }));
    expect(mocks.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.confirmAction" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(AGENT.id));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Codex" })).toBeNull());
  });

  it("confirms token rotation and keeps the returned secret only in the open create state", async () => {
    render(<McpAccessSection />);
    await screen.findByRole("heading", { name: "Codex" });
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.rotateToken" }));
    expect(mocks.rotateToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.confirmAction" }));
    expect(await screen.findByDisplayValue("rotated-secret")).toBeTruthy();
    expect(mocks.rotateToken).toHaveBeenCalledWith(AGENT.id);
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.closeCreate" }));
    expect(screen.queryByDisplayValue("rotated-secret")).toBeNull();
  });

  it("loads audit metadata in pages without requesting record details", async () => {
    mocks.auditList
      .mockResolvedValueOnce({
        items: [{ agentId: "codex", displayName: "Codex", action: "read_project", entityType: "project", entityId: "p1", createdAt: "2026-11-06T10:00:00Z", success: true, authorized: true, errorCategory: null }],
        total: 21, offset: 0, limit: 20,
      })
      .mockResolvedValueOnce({ items: [], total: 21, offset: 20, limit: 20 });
    render(<McpAccessSection />);
    expect(await screen.findByText(/read_project/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.audit.next" }));
    await waitFor(() => expect(mocks.auditList).toHaveBeenLastCalledWith(20, 20));
  });

  it("shows bridge errors and still offers refresh", async () => {
    mocks.status.mockRejectedValueOnce(new Error("status failure"));
    render(<McpAccessSection />);
    expect((await screen.findByRole("alert")).textContent).toContain("status failure");
    fireEvent.click(screen.getByRole("button", { name: "settings.mcpAccess.refresh" }));
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toContain("settings.mcpAccess.status.running");
  });
});
