/**
 * @vitest-environment jsdom
 */
//! Agent 共享工作空间管理面：初始化、连接状态、交接、工作报告、冲突选择与解决。
//!
//! 重点回归 v81 的契约修复：
//! - 工作报告来自 `agentAccessReports`（旧实现误用 activity 流）；
//! - 冲突解决方式只能是 `db` / `file` / `dismiss`，且作用于**选中的**冲突；
//! - 交接操作按钮只在合法状态下可用。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  agentAccessActivity: vi.fn(),
  agentAccessAgents: vi.fn(),
  agentAccessConfigInfo: vi.fn(),
  agentAccessConflictDetail: vi.fn(),
  agentAccessConflicts: vi.fn(),
  agentAccessContext: vi.fn(),
  agentAccessExport: vi.fn(),
  agentAccessGrant: vi.fn(),
  agentAccessHandoffs: vi.fn(),
  agentAccessHandoffDetail: vi.fn(),
  agentAccessHandoffTransition: vi.fn(),
  agentAccessImportApprove: vi.fn(),
  agentAccessImportPolicies: vi.fn(),
  agentAccessImportPolicyRemove: vi.fn(),
  agentAccessImportPolicySet: vi.fn(),
  agentAccessImportReject: vi.fn(),
  agentAccessImportRequests: vi.fn(),
  agentAccessInit: vi.fn(),
  agentAccessPermissions: vi.fn(),
  agentAccessResolveConflict: vi.fn(),
  agentAccessReports: vi.fn(),
  agentAccessRevoke: vi.fn(),
  agentAccessScan: vi.fn(),
  agentAccessStatus: vi.fn(),
  agentAccessSyncStatus: vi.fn(),
  fsReveal: vi.fn(),
}));

vi.mock("../../lib/bridge", () => api);

import AgentAccessSection from "./AgentAccessSection";

const STATUS = {
  workspace: { workspace_id: "ws-1", root_path: "D:/ws", name: "共享空间" },
  rest: {
    state: "listening",
    running: true,
    base_url: "http://127.0.0.1:47911/api/v1",
    last_error: null,
  },
  cli: { installed: true, path: "D:/app/taskdock.exe" },
  watch: { running: true, last_error: null },
  recent_activity: [{ id: "a1", created_at: "2026-11-19T10:00:00Z", agent_id: "", interface: "cli" }],
};

const CONFLICTS = [
  {
    id: "c-1",
    rel_path: "inbox/a.json",
    resource_kind: "task.update",
    resource_id: "task-1",
    db_revision: 3,
    file_revision: 2,
    status: "open",
  },
  {
    id: "c-2",
    rel_path: "inbox/b.json",
    resource_kind: "knowledge.create",
    resource_id: "",
    db_revision: 1,
    file_revision: 1,
    status: "open",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.agentAccessStatus.mockResolvedValue(STATUS);
  api.agentAccessConfigInfo.mockResolvedValue({
    watch_enabled: true,
    mcp_enabled: true,
    rest_enabled: true,
    rest_port: 47911,
  });
  api.agentAccessSyncStatus.mockResolvedValue({
    workspace: { root_path: "D:/ws", last_scan_at: "2026-11-19T10:05:00Z" },
    pending_imports: 2,
    conflicts: 2,
    pending_reviews: 1,
    last_error: null,
  });
  api.agentAccessConflicts.mockResolvedValue(CONFLICTS);
  api.agentAccessConflictDetail.mockImplementation(async (id: string) => ({
    conflict: CONFLICTS.find((c) => c.id === id),
    file_exists: true,
    file_content: '{"schema":"taskdock.import/1"}',
  }));
  api.agentAccessAgents.mockResolvedValue([
    { id: "row-1", agent_id: "agent-a", display_name: "Agent A", scope: "project_rw" },
    { id: "row-2", agent_id: "agent-b", display_name: "Agent B", scope: "readonly" },
  ]);
  api.agentAccessPermissions.mockResolvedValue({
    capabilities: ["tasks.read", "tasks.write", "context.read"],
    grants: [{ capability: "tasks.read", resource_id: "" }],
  });
  api.agentAccessActivity.mockResolvedValue({
    items: [{ id: "act-1", created_at: "2026-11-19T10:00:00Z", agent_id: "agent-a", action: "task.create" }],
  });
  api.agentAccessHandoffs.mockResolvedValue({
    items: [
      {
        id: "h-1",
        summary: "交接摘要",
        from_agent_id: "agent-a",
        to_agent_id: "agent-b",
        status: "pending",
        revision: 1,
      },
    ],
  });
  api.agentAccessHandoffDetail.mockResolvedValue({
    handoff: {
      id: "h-1",
      status: "pending",
      from_agent_id: "agent-a",
      to_agent_id: "agent-b",
      summary: "交接摘要",
      revision: 1,
    },
  });
  api.agentAccessHandoffTransition.mockResolvedValue({ id: "h-1", status: "accepted", revision: 2 });
  api.agentAccessReports.mockResolvedValue({
    items: [
      {
        id: "r-1",
        agent_id: "agent-b",
        summary: "工作报告内容",
        result: "completed",
        created_at: "2026-11-19T11:00:00Z",
      },
    ],
  });
  api.agentAccessImportRequests.mockResolvedValue([
    {
      id: "req-1",
      rel_path: "inbox/pending.json",
      kind: "task.create",
      status: "pending",
      reason: "该目录未授权自动写入",
    },
  ]);
  api.agentAccessImportPolicies.mockResolvedValue([
    { id: "pol-1", rel_dir: "inbox", mode: "review", capabilities: ["tasks.write"] },
  ]);
  api.agentAccessImportApprove.mockResolvedValue({ message: "创建任务 t-1" });
  api.agentAccessImportReject.mockResolvedValue({ ok: true });
  api.agentAccessResolveConflict.mockResolvedValue({ id: "c-1", status: "resolved_db" });
  api.agentAccessGrant.mockResolvedValue([]);
  api.agentAccessRevoke.mockResolvedValue([]);
  api.agentAccessScan.mockResolvedValue({ scanned: 0 });
  api.agentAccessExport.mockResolvedValue({ written: 0 });
  api.agentAccessInit.mockResolvedValue({});
  api.agentAccessContext.mockResolvedValue({ markdown: "# ctx" });
});

afterEach(cleanup);

describe("Agent 共享工作空间管理面", () => {
  it("初始化失败时显示错误且不崩溃", async () => {
    api.agentAccessStatus.mockRejectedValueOnce(new Error("数据库不可用"));
    render(<AgentAccessSection />);
    await waitFor(() => expect(screen.getByText(/数据库不可用/)).toBeTruthy());
  });

  it("概览展示真实连接状态（REST 监听 / CLI 就绪 / 文件监听）", async () => {
    render(<AgentAccessSection />);
    await waitFor(() => expect(screen.getByText("D:/ws")).toBeTruthy());
    expect(screen.getAllByText(/运行中/).length).toBeGreaterThan(0);
    expect(screen.getByText(/D:\/app\/taskdock.exe/)).toBeTruthy();
  });

  it("REST 失败时展示失败状态与原因", async () => {
    api.agentAccessStatus.mockResolvedValue({
      ...STATUS,
      rest: { state: "failed", running: false, base_url: "http://127.0.0.1:47911/api/v1", last_error: "端口被占用" },
    });
    render(<AgentAccessSection />);
    await waitFor(() => expect(screen.getByText(/端口被占用/)).toBeTruthy());
    expect(screen.getByText(/失败/)).toBeTruthy();
  });

  it("活动页展示活动记录", async () => {
    render(<AgentAccessSection />);
    fireEvent.click(screen.getByRole("tab", { name: /活动/ }));
    await waitFor(() => expect(screen.getByText("task.create")).toBeTruthy());
  });

  it("交接页用 reports 接口展示工作报告，而非活动流", async () => {
    render(<AgentAccessSection />);
    fireEvent.click(screen.getByRole("tab", { name: /交接/ }));
    await waitFor(() => expect(screen.getByText("工作报告内容")).toBeTruthy());
    expect(api.agentAccessReports).toHaveBeenCalled();
  });

  it("交接按钮只在合法状态可用", async () => {
    render(<AgentAccessSection />);
    fireEvent.click(screen.getByRole("tab", { name: /交接/ }));
    fireEvent.click(await screen.findByText("交接摘要"));
    await waitFor(() => expect(screen.getByText("pending")).toBeTruthy());
    const accept = screen.getByRole("button", { name: "接收" }) as HTMLButtonElement;
    const complete = screen.getByRole("button", { name: "完成" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    expect(complete.disabled).toBe(true);
  });

  it("同步页展示待批准导入并可批准", async () => {
    render(<AgentAccessSection />);
    fireEvent.click(screen.getByRole("tab", { name: /同步/ }));
    await waitFor(() => expect(screen.getByText("inbox/pending.json")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "批准导入" }));
    await waitFor(() => expect(api.agentAccessImportApprove).toHaveBeenCalledWith("req-1"));
  });

  it("冲突解决作用于选中项，且取值只能是 db/file/dismiss", async () => {
    render(<AgentAccessSection />);
    fireEvent.click(screen.getByRole("tab", { name: /同步/ }));
    const items = await screen.findAllByText("inbox/b.json");
    fireEvent.click(items[0]);
    await waitFor(() => expect(api.agentAccessConflictDetail).toHaveBeenCalledWith("c-2"));
    const resolveButton = screen.getByRole("button", { name: "解决" });
    await waitFor(() => expect((resolveButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(resolveButton);
    await waitFor(() =>
      expect(api.agentAccessResolveConflict).toHaveBeenCalledWith("c-2", "db"),
    );
  });

  it("权限页支持搜索 Agent 并展示授权分组", async () => {
    render(<AgentAccessSection />);
    fireEvent.click(screen.getByRole("tab", { name: /权限/ }));
    await waitFor(() => expect(screen.getByText("agent-a")).toBeTruthy());
    const search = screen.getByLabelText("搜索 Agent 名称或 ID");
    fireEvent.change(search, { target: { value: "agent-b" } });
    await waitFor(() => expect(screen.queryByText("agent-a")).toBeNull());
    expect(screen.getByText("agent-b")).toBeTruthy();
    const group = screen.getByText("任务");
    expect(within(group.parentElement as HTMLElement).getByText("tasks.read")).toBeTruthy();
  });
});
