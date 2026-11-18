/**
 * @vitest-environment jsdom
 */
//! Skill 子页：风险展示、启停、真实作用域绑定与导入。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  agentMcpList: vi.fn(),
  capabilitySkillDelete: vi.fn(),
  capabilitySkillGet: vi.fn(),
  capabilitySkillImport: vi.fn(),
  capabilitySkillList: vi.fn(),
  capabilitySkillSaveContent: vi.fn(),
  capabilitySkillScan: vi.fn(),
  capabilitySkillSetEnabled: vi.fn(),
  capabilitySkillSetScope: vi.fn(),
  workspaceProjectList: vi.fn(),
}));
const picker = vi.hoisted(() => ({ pickFolder: vi.fn() }));

vi.mock("../../lib/bridge", () => api);
vi.mock("../../lib/filesWorkspace/folderPicker", () => picker);

import SkillsSection from "./SkillsSection";

const globalSkill = {
  id: "s1",
  name: "风险技能",
  description: "包含脚本",
  sourceKind: "imported" as const,
  sourcePath: "C:\\skills\\risk",
  scope: "global" as const,
  projectId: null,
  workspaceId: null,
  agentId: null,
  enabled: true,
  riskLevel: "high" as const,
  riskNotes: [{ kind: "script", detail: "包含可执行脚本", file: "run.ps1" }],
  version: "1.0",
  formatOk: true,
  missing: false,
  nameConflict: false,
  updatedAt: "2026-11-18T00:00:00Z",
};

const projectSkill = {
  ...globalSkill,
  id: "s2",
  name: "项目技能",
  scope: "project" as const,
  projectId: "p1",
  riskLevel: "low" as const,
  riskNotes: [],
};

const agentSkill = {
  ...globalSkill,
  id: "s3",
  name: "Agent 技能",
  scope: "agent" as const,
  agentId: "row-a",
  riskLevel: "low" as const,
  riskNotes: [],
};

function resetMocks() {
  for (const fn of Object.values(api)) fn.mockReset();
  picker.pickFolder.mockReset();
  api.capabilitySkillList.mockResolvedValue([globalSkill, projectSkill, agentSkill]);
  api.capabilitySkillGet.mockImplementation(async (id: string) => ({
    ...(id === "s2" ? projectSkill : id === "s3" ? agentSkill : globalSkill),
    content: "正文",
    files: [{ path: "SKILL.md", isDir: false, sizeBytes: 10 }],
  }));
  api.capabilitySkillSetEnabled.mockImplementation(async (id: string, enabled: boolean) => ({
    ...globalSkill,
    id,
    enabled,
  }));
  api.capabilitySkillSetScope.mockImplementation(
    async (id: string, scope: string, projectId: string | null) => ({
      ...globalSkill,
      id,
      scope,
      projectId,
    }),
  );
  api.workspaceProjectList.mockResolvedValue({
    projects: [{ id: "p1", name: "项目 A", kind: "general", rootPath: "", status: "active" }],
  });
  api.agentMcpList.mockResolvedValue([
    {
      id: "row-a",
      agent_id: "agent-a",
      display_name: "Agent A",
      scope: "readonly",
      created_at: "",
      updated_at: "",
      revoked_at: null,
      last_seen_at: null,
      granted_project_ids: [],
    },
  ]);
}

beforeEach(resetMocks);
afterEach(cleanup);

describe("SkillsSection", () => {
  it("展示风险等级与具体风险原因", async () => {
    render(<SkillsSection />);
    await waitFor(() => expect(api.capabilitySkillGet).toHaveBeenCalledWith("s1"));
    expect(await screen.findByText(/包含可执行脚本/)).toBeTruthy();
    expect(screen.getAllByText("高风险").length).toBeGreaterThan(0);
  });

  it("启用/禁用调用真实命令", async () => {
    render(<SkillsSection />);
    await waitFor(() => expect(api.capabilitySkillGet).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(api.capabilitySkillSetEnabled).toHaveBeenCalledWith("s1", false),
    );
  });

  it("project 作用域绑定真实项目", async () => {
    render(<SkillsSection />);
    await waitFor(() => expect(api.capabilitySkillGet).toHaveBeenCalled());
    const scope = screen.getAllByRole("combobox", { name: "作用域" }).at(-1)!;
    fireEvent.click(scope);
    fireEvent.click(await screen.findByRole("option", { name: "项目" }));
    await waitFor(() =>
      expect(api.capabilitySkillSetScope).toHaveBeenCalledWith(
        "s1",
        "project",
        "p1",
        null,
        null,
      ),
    );
  });

  it("agent 作用域绑定现有 Agent", async () => {
    render(<SkillsSection />);
    await waitFor(() => expect(api.capabilitySkillGet).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("combobox", { name: "作用域" }).at(-1)!);
    fireEvent.click(await screen.findByRole("option", { name: "Agent" }));
    await waitFor(() =>
      expect(api.capabilitySkillSetScope).toHaveBeenCalledWith(
        "s1",
        "agent",
        null,
        null,
        "row-a",
      ),
    );
  });

  it("导入文件夹调用真实命令", async () => {
    picker.pickFolder.mockResolvedValue({ status: "ok", path: "C:\\skills\\new" });
    api.capabilitySkillImport.mockResolvedValue({
      ...globalSkill,
      id: "s9",
      name: "新技能",
      content: "正文",
      files: [],
    });
    render(<SkillsSection />);
    await screen.findByText("风险技能");
    fireEvent.click(screen.getByRole("button", { name: /导入文件夹/ }));
    await waitFor(() =>
      expect(api.capabilitySkillImport).toHaveBeenCalledWith("C:\\skills\\new"),
    );
    expect(await screen.findByText("已导入 Skill「新技能」")).toBeTruthy();
  });
});
