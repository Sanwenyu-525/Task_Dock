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

function linkAt(i: number): PlanningAgentFeatureLink {
  return {
    ...LINK,
    id: `link-${i}`,
    feature_id: `feature-${i}`,
    feature_title: `Feature ${i}`,
    project_id: `project-${i}`,
    project_name: `Project ${i}`,
  };
}

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

  it("链接超出默认条数时先折叠，展开后全部链接与定位入口仍可用", async () => {
    api.list.mockResolvedValue(Array.from({ length: 6 }, (_, i) => linkAt(i + 1)));
    render(<AgentPlanningLinks agentSource="codex" sessionId="external-session-1" />);

    // 折叠态只渲染前 5 条，第 6 条定位入口不可见；折叠入口带总数与展开状态。
    await screen.findByRole("button", { name: "展开全部 6 个关联功能" });
    expect(screen.getAllByRole("button", { name: /定位规划功能/ })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "定位规划功能 Feature 6" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 6 个关联功能" }));
    expect(screen.getAllByRole("button", { name: /定位规划功能/ })).toHaveLength(6);
    expect(screen.getByRole("button", { name: "定位规划功能 Feature 6" })).toBeTruthy();

    // 收起后回到折叠态，功能入口不丢失。
    fireEvent.click(screen.getByRole("button", { name: "收起关联功能" }));
    expect(screen.getAllByRole("button", { name: /定位规划功能/ })).toHaveLength(5);
  });
});
