/**
 * @vitest-environment jsdom
 */
//! 开发 D1 前端测试：Git 风险降级、Agent 自述与验收结论区分、台账不可用降级、归档只读。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  dwsDevelopmentSummary: vi.fn(),
  dwsTaskLinkSave: vi.fn(),
  dwsTaskLinkList: vi.fn(),
  dwsTaskLinkDelete: vi.fn(),
  dwsTaskHandoff: vi.fn(),
  dwsBuildTrace: vi.fn(),
  dwsGitRiskProbe: vi.fn(),
  dwsRevealPath: vi.fn(),
  dwsOpenDevWorkbench: vi.fn(),
}));

vi.mock("./ipc", () => api);

import AgentsPanel from "./AgentsPanel";
import BuildTracePanel from "./BuildTracePanel";
import GitRiskPanel from "./GitRiskPanel";

const base = {
  projectId: "p1",
  projectName: "开发 A",
  kind: "development" as const,
  rootPath: null,
  rootExists: false,
  devProjectId: null,
  switchModule: vi.fn(),
};

const okGit = {
  status: "ok" as const,
  branch: "main",
  detached: false,
  isWorktree: false,
  mainRepoPath: null,
  headSha: "abc1234567890",
  dirtyCount: 2,
  probedAt: "2026-11-16T09:00:00+00:00",
};

const notRepoGit = {
  status: "not_a_repo" as const,
  branch: null,
  detached: false,
  isWorktree: false,
  mainRepoPath: null,
  headSha: null,
  dirtyCount: null,
  probedAt: "2026-11-16T09:00:00+00:00",
};

const summaryTasks = {
  summary: {
    projectId: "p1",
    projectName: "开发 A",
    kind: "development",
    archived: false,
    weakDevProjectId: null,
    devProjects: [],
    tasks: [
      {
        taskId: "t1",
        title: "任务一",
        status: "open",
        priority: 1,
        dueAt: null,
        linkOrigin: "workspace_link",
      },
    ],
  },
};

const handoff = {
  handoff: {
    taskId: "t1",
    taskTitle: "任务一",
    taskStatus: "open",
    packs: [
      {
        id: "pk1",
        taskId: "t1",
        title: "交接包 v1",
        version: 1,
        contentMd: "",
        sourceSummary: "",
        secretScan: "",
        createdAt: "2026-11-16T09:00:00+00:00",
        agentSourceId: null,
        agentSessionExternalId: null,
        agentSessionTitle: "会话 A",
        agentSessionAvailable: true,
      },
    ],
    agentCandidates: [
      {
        sourceId: "r1",
        sessionExternalId: "s1",
        sessionId: "sid",
        sessionTitle: "会话 A",
        sessionStatus: "running",
        linkOrigin: "handoff",
        runExternalId: "run1",
        runTaskTitle: "任务一",
        runStatus: "completed",
        endedAt: "2026-11-16T09:05:00+00:00",
        updatedAt: "2026-11-16T09:05:00+00:00",
        acceptedRecordId: null,
        acceptedVerdict: null,
        acceptedAt: null,
      },
    ],
    acceptanceRecords: [
      {
        id: "ar1",
        subjectKind: "task" as const,
        subjectId: "t1",
        verdict: "fail" as const,
        summary: "改动未通过",
        evidence: [],
        createdAt: "2026-11-16T09:10:00+00:00",
        agentSourceId: null,
        agentSessionExternalId: null,
        agentRunExternalId: null,
      },
    ],
    links: [],
    latestAcceptanceVerdict: "fail",
    acceptanceRecordCount: 1,
    agentSelfReportedCompleted: true,
  },
};

const trace = {
  trace: {
    ledgerAvailable: false,
    ledgerRoot: null,
    ledgerReason: "未找到台账目录",
    tasks: [],
    snapshots: [],
    builds: [],
    links: [
      {
        id: "lk1",
        projectId: "p1",
        devProjectId: null,
        devProjectName: null,
        taskId: "t1",
        taskTitle: "任务一",
        handoffPackId: "",
        buildId: "b02-web-r1",
        acceptanceRecordId: "",
        acceptanceVerdict: null,
        note: "手工关联",
        createdAt: "2026-11-16T09:00:00+00:00",
        updatedAt: "2026-11-16T09:00:00+00:00",
      },
    ],
    acceptanceRecords: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.dwsRevealPath.mockResolvedValue(undefined);
  api.dwsOpenDevWorkbench.mockResolvedValue({ opened: true, projectId: null, requestId: null });
});

afterEach(() => cleanup());

describe("GitRiskPanel", () => {
  it("展示仓库分支 / 提交 / 改动文件与风险建议", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: {
        repos: [
          {
            devProjectId: "dp1",
            name: "repo-a",
            rootPath: "D:/repo-a",
            exists: true,
            git: okGit,
            changedFiles: [{ path: "src/a.ts", status: "M", group: "src" }],
            truncated: false,
            risks: [],
          },
        ],
        risks: [],
        advice: "建议人工处理，不要自动清理。",
        persisted: true,
      },
    });

    render(<GitRiskPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("repo-a");
    expect(screen.getByText("分支：main")).toBeTruthy();
    expect(screen.getByText(/abc12345/)).toBeTruthy();
    expect(screen.getByText("改动文件（1）")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("建议人工处理，不要自动清理。")).toBeTruthy();
  });

  it("非 Git 目录如实降级，不伪造分支与提交", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: {
        repos: [
          {
            devProjectId: "dp2",
            name: "plain-dir",
            rootPath: "D:/plain",
            exists: true,
            git: notRepoGit,
            changedFiles: [],
            truncated: false,
            risks: [{ level: "info", code: "not_a_repo", message: "目录不是 Git 仓库", files: [] }],
          },
        ],
        risks: [],
        advice: "",
        persisted: false,
      },
    });

    render(<GitRiskPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("plain-dir");
    expect(screen.getByText("非 Git 目录")).toBeTruthy();
    expect(screen.queryByText("分支：main")).toBeNull();
  });

  it("探测失败可见错误与重试，重试后恢复", async () => {
    api.dwsGitRiskProbe.mockRejectedValueOnce(new Error("探测失败"));
    const onNotice = vi.fn();
    render(<GitRiskPanel {...base} archived={false} onNotice={onNotice} />);

    await waitFor(() => {
      expect(screen.getByText("探测失败")).toBeTruthy();
    });
    expect(onNotice).toHaveBeenCalledWith("error", "探测失败");

    api.dwsGitRiskProbe.mockResolvedValue({
      risk: { repos: [], risks: [], advice: "", persisted: false },
    });
    screen.getByRole("button", { name: "重试" }).click();
    await screen.findByText("尚未关联开发仓库；关联后这里展示分支、改动与冲突风险。");
  });
});

describe("AgentsPanel", () => {
  it("区分 Agent 自述完成与人工验收结论，不自动判通过", async () => {
    api.dwsDevelopmentSummary.mockResolvedValue(summaryTasks);
    api.dwsTaskHandoff.mockResolvedValue(handoff);

    render(<AgentsPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText("交接包 v1");
    // Agent 轮次尚无验收记录 → 待人工验收，不显示通过。
    expect(screen.getByText("待人工验收")).toBeTruthy();
    // 人工验收记录结论为未通过（子标题与记录徽标各一处）。
    expect(screen.getAllByText("未通过").length).toBeGreaterThan(0);
    expect(screen.getByText("改动未通过")).toBeTruthy();
    expect(screen.getByText(/Agent 完成轮次不等于验收通过/)).toBeTruthy();
    expect(screen.getByText("交接包 v1")).toBeTruthy();
  });

  it("无关联任务时展示空态，不伪造数据", async () => {
    api.dwsDevelopmentSummary.mockResolvedValue({
      summary: { ...summaryTasks.summary, tasks: [] },
    });

    render(<AgentsPanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/还没有关联任务/);
    expect(api.dwsTaskHandoff).not.toHaveBeenCalled();
  });
});

describe("BuildTracePanel", () => {
  it("台账不可用时可见降级，同时展示本地显式关联", async () => {
    api.dwsBuildTrace.mockResolvedValue(trace);
    api.dwsDevelopmentSummary.mockResolvedValue(summaryTasks);

    render(<BuildTracePanel {...base} archived={false} onNotice={vi.fn()} />);

    await screen.findByText(/集成台账暂不可用/);
    expect(screen.getByText(/b02-web-r1/)).toBeTruthy();
    expect(screen.getByText("手工关联")).toBeTruthy();
  });

  it("归档项目不渲染关联表单，写入口置灰", async () => {
    api.dwsBuildTrace.mockResolvedValue(trace);
    api.dwsDevelopmentSummary.mockResolvedValue(summaryTasks);

    render(<BuildTracePanel {...base} archived onNotice={vi.fn()} />);

    await screen.findByText(/b02-web-r1/);
    expect(screen.queryByRole("button", { name: "保存关联" })).toBeNull();
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });
});
