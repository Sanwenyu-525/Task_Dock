/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanningAgentFeatureLink } from "../../lib/bridge";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import AgentPlanningLinks from "./AgentPlanningLinks";

const api = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, planningListAgentFeatureLinks: api.list };
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
  agent_status: "waiting",
  agent_session_id: "session-row-1",
  last_seen_at: "2026-11-06T10:00:00Z",
  last_execution_at: "2026-11-06T10:00:00Z",
};

beforeEach(() => {
  api.list.mockResolvedValue([LINK]);
  useUiStore.setState({ tab: "agents", agentFocus: null });
  useGlobalSearchStore.setState({ pendingLocate: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agent 会话关联的规划功能", () => {
  it("展开真实会话后可切到规划中心并定位关联功能", async () => {
    render(<AgentPlanningLinks agentSource="codex" sessionId="external-session-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "定位规划功能 Feature one" }));

    expect(api.list).toHaveBeenCalledWith("codex", "external-session-1");
    expect(useUiStore.getState().tab).toBe("roadmap");
    expect(useGlobalSearchStore.getState().pendingLocate).toMatchObject({
      category: "planning",
      id: "feature-1",
      kind: "feature",
      parentId: "project-1",
      keyword: "",
    });
  });
});
