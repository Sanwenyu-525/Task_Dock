/**
 * @vitest-environment jsdom
 */
//! ProjectContext 契约：透传 Shell 状态（不复制第二份）、缺 Provider 明确报错。

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceProject } from "../lib/bridge";
import { ProjectContextProvider, useProjectContext } from "./ProjectContext";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeProject(id: string, name: string): WorkspaceProject {
  return {
    id,
    name,
    kind: "general",
    status: "active",
    rootPath: "",
    rootExists: false,
    devProjectId: null,
    devProjectExists: false,
    devProjectName: null,
    note: "",
    itemCount: 0,
    taskLinkCount: 0,
    createdAt: "",
    updatedAt: "",
  };
}

function Probe() {
  const ctx = useProjectContext();
  return (
    <div>
      <span data-testid="pid">{ctx.projectId ?? "(none)"}</span>
      <span data-testid="name">{ctx.selectedProject?.name ?? "(no project)"}</span>
      <span data-testid="count">{ctx.projects.length}</span>
      <button onClick={() => void ctx.selectProject(null)}>clear</button>
      <button onClick={() => void ctx.refreshProjects()}>refresh</button>
    </div>
  );
}

describe("ProjectContext", () => {
  it("透传 Shell 状态与方法：同一引用直达 Shell，不产生第二份状态", () => {
    const selectProject = vi.fn().mockResolvedValue(true);
    const refreshProjects = vi.fn().mockResolvedValue([makeProject("p1", "项目 A")]);
    const value = {
      projectId: "p1",
      selectedProject: makeProject("p1", "项目 A"),
      projects: [makeProject("p1", "项目 A")],
      projectsLoading: false,
      projectsError: null,
      selectProject,
      refreshProjects,
    };
    render(
      <ProjectContextProvider value={value}>
        <Probe />
      </ProjectContextProvider>,
    );
    // selectedProject.id 必须等于 projectId（契约一致性）
    expect(screen.getByTestId("pid").textContent).toBe("p1");
    expect(screen.getByTestId("name").textContent).toBe("项目 A");
    fireEvent.click(screen.getByText("clear"));
    expect(selectProject).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByText("refresh"));
    expect(refreshProjects).toHaveBeenCalledTimes(1);
  });

  it("缺 Provider 时明确抛错，不静默返回虚假默认项目", () => {
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ProjectContextProvider/);
    silence.mockRestore();
  });
});
