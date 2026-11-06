/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUiStore } from "../../store/useUiStore";
import type { PlanningAgentFeatureLink } from "../../lib/bridge";
import FeatureAgentLinks from "./FeatureAgentLinks";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    planningListFeatureAgentLinks: api.list,
    planningUnlinkAgentSession: api.unlink,
  };
});

const LINK: PlanningAgentFeatureLink = {
  id: "link-1",
  feature_id: "feature-1",
  feature_title: "Feature one",
  project_id: "project-1",
  project_name: "Project one",
  agent_source: "codex",
  agent_name: "Codex CLI",
  session_id: "external-session-1",
  status: "linked",
  agent_status: "running",
  agent_session_id: "session-row-1",
  last_seen_at: "2026-11-06T10:00:00Z",
  last_execution_at: "2026-11-06T10:00:00Z",
};

beforeEach(() => {
  api.list.mockResolvedValue([LINK]);
  api.unlink.mockResolvedValue(undefined);
  useUiStore.setState({ tab: "roadmap", agentFocus: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("规划功能 Agent 关联", () => {
  it("显示真实来源、会话、状态和最近执行时间；支持跳转与解除", async () => {
    render(<FeatureAgentLinks featureId="feature-1" />);

    expect(await screen.findByText("Codex CLI")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("会话 ID：external-session-1")).toBeTruthy();
    expect(screen.getByText(/Agent 状态：运行中/)).toBeTruthy();
    expect(screen.getByText(/最近执行：/).textContent).not.toContain("最近执行：未知");

    fireEvent.click(screen.getByRole("button", { name: "跳转 Agent 会话 external-session-1" }));
    expect(useUiStore.getState().tab).toBe("agents");
    expect(useUiStore.getState().agentFocus).toMatchObject({
      sourceId: "codex",
      sessionId: "session-row-1",
      refId: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "解除 codex 会话关联" }));
    await waitFor(() =>
      expect(api.unlink).toHaveBeenCalledWith("feature-1", "codex", "external-session-1"),
    );
  });

  it("未匹配到真实会话时显示未知且禁用跳转", async () => {
    api.list.mockResolvedValueOnce([
      {
        ...LINK,
        agent_status: null,
        agent_session_id: null,
        last_seen_at: null,
        last_execution_at: null,
      },
    ]);
    render(<FeatureAgentLinks featureId="feature-1" />);

    expect(await screen.findByText(/Agent 状态：未知/)).toBeTruthy();
    expect(screen.getByText(/最近执行：未知/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "跳转 Agent 会话 external-session-1" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
