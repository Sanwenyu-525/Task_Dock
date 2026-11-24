/**
 * @vitest-environment jsdom
 */
//! 开发 D1 前端测试。
//!
//! 覆盖：Git 风险降级与反馈、打开开发工作台走壳层回调、AgentsPanel 的
//! summary/handoff 独立状态与乱序保护、BuildTracePanel 的构建状态可信度、
//! 台账来源、排序、删除保护与输入校验、归档只读。
//! 只 mock 本目录 IPC 包装层，不 mock React/DOM。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreativeModuleProps } from "../types";

const api = vi.hoisted(() => ({
  dwsDevelopmentSummary: vi.fn(),
  dwsTaskLinkSave: vi.fn(),
  dwsTaskLinkDelete: vi.fn(),
  dwsTaskHandoff: vi.fn(),
  dwsBuildTrace: vi.fn(),
  dwsGitRiskProbe: vi.fn(),
  dwsRevealPath: vi.fn(),
}));

vi.mock("./ipc", () => api);

import AgentsPanel from "./AgentsPanel";
import BuildTracePanel, { describeBuildStatus, resolveLedgerPath } from "./BuildTracePanel";
import GitRiskPanel from "./GitRiskPanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const base = {
  projectId: "p1",
  projectName: "开发 A",
  kind: "development" as const,
  rootPath: null as string | null,
  rootExists: false,
  devProjectId: null as string | null,
  switchModule: vi.fn(),
};

function props(over: Record<string, unknown> = {}): CreativeModuleProps {
  return {
    ...base,
    archived: false,
    onNotice: vi.fn(),
    ...over,
  } as unknown as CreativeModuleProps;
}

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

const twoTasks = {
  summary: {
    ...summaryTasks.summary,
    tasks: [
      ...summaryTasks.summary.tasks,
      {
        taskId: "t2",
        title: "任务二",
        status: "open",
        priority: 1,
        dueAt: null,
        linkOrigin: "workspace_link",
      },
    ],
  },
};

const packV1 = {
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
};

const handoffV1 = {
  handoff: {
    taskId: "t1",
    taskTitle: "任务一",
    taskStatus: "open",
    packs: [packV1],
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

const handoffV2 = {
  handoff: {
    ...handoffV1.handoff,
    taskId: "t2",
    taskTitle: "任务二",
    packs: [{ ...packV1, id: "pk2", taskId: "t2", title: "交接包 v2", version: 2 }],
    agentCandidates: [],
    acceptanceRecords: [],
    latestAcceptanceVerdict: null,
    acceptanceRecordCount: 0,
    agentSelfReportedCompleted: false,
  },
};

const traceUnavailable = {
  trace: {
    ledgerAvailable: false,
    ledgerRoot: null,
    ledgerReason: "未找到台账目录",
    tasks: [],
    snapshots: [],
    builds: [],
    sources: [],
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

function buildRow(over: Record<string, unknown>) {
  return {
    id: "bld-1",
    snapshot: "snap-1",
    commit: "0123456789ab",
    shortCommit: "01234567",
    dirty: false,
    platform: "windows",
    config: "release",
    status: "succeeded",
    exitCode: 0,
    startedAt: "2026-11-16T09:00:00+00:00",
    finishedAt: "2026-11-16T09:05:00+00:00",
    durationMs: 300000,
    tasks: [],
    logPath: "tmp/integration/builds/bld-1/build.log",
    artifacts: [],
    host: "ci",
    repoName: "repo-a",
    repoRoot: "D:\\repo-a",
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.dwsRevealPath.mockResolvedValue(undefined);
  api.dwsDevelopmentSummary.mockResolvedValue(summaryTasks);
  api.dwsTaskHandoff.mockResolvedValue(handoffV1);
  api.dwsBuildTrace.mockResolvedValue(traceUnavailable);
  api.dwsTaskLinkSave.mockResolvedValue({ link: traceUnavailable.trace.links[0] });
  api.dwsTaskLinkDelete.mockResolvedValue({ ok: true });
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
            changedFilesKnown: true,
            risks: [],
          },
        ],
        risks: [],
        advice: "建议人工处理，不要自动清理。",
        persisted: true,
        history: [],
      },
    });

    render(<GitRiskPanel {...props()} />);

    await screen.findByText("repo-a");
    expect(screen.getByText("分支：main")).toBeTruthy();
    expect(screen.getByText("提交：abc12345")).toBeTruthy();
    expect(screen.getByText("改动文件（1）")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("建议人工处理，不要自动清理。")).toBeTruthy();
    expect(screen.getByText("本机探测快照（0）")).toBeTruthy();
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
            changedFilesKnown: false,
            risks: [{ level: "info", code: "not_a_repo", message: "目录不是 Git 仓库", files: [] }],
          },
        ],
        risks: [],
        advice: "",
        persisted: false,
        history: [],
      },
    });

    render(<GitRiskPanel {...props()} />);

    await screen.findByText("plain-dir");
    expect(screen.getByText("非 Git 目录")).toBeTruthy();
    expect(screen.queryByText("分支：main")).toBeNull();
    // 改动清单未读取 ≠ 零改动。
    expect(screen.getByText("改动文件（未读取）")).toBeTruthy();
    expect(screen.queryByText("改动文件（0）")).toBeNull();
  });

  it("改动清单读取失败（超时）不显示为零改动", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: {
        repos: [
          {
            devProjectId: "dp3",
            name: "slow-repo",
            rootPath: "D:/slow",
            exists: true,
            git: { ...okGit, dirtyCount: null },
            changedFiles: [],
            truncated: false,
            changedFilesKnown: false,
            risks: [
              {
                level: "warn",
                code: "git_status_timeout",
                message: "git status 超时，改动清单未读取；这不代表没有改动。",
                files: [],
              },
            ],
          },
        ],
        risks: [],
        advice: "",
        persisted: false,
        history: [],
      },
    });

    render(<GitRiskPanel {...props()} />);

    await screen.findByText("slow-repo");
    expect(screen.getByText("未提交：未读取")).toBeTruthy();
    expect(screen.getAllByText(/这不代表没有改动/).length).toBeGreaterThan(0);
    expect(screen.queryByText("改动文件（0）")).toBeNull();
  });

  it("探测失败可见错误与重试，重试后恢复", async () => {
    api.dwsGitRiskProbe.mockRejectedValueOnce(new Error("探测失败"));
    const onNotice = vi.fn();
    render(<GitRiskPanel {...props({ onNotice })} />);

    await waitFor(() => {
      expect(screen.getByText("探测失败")).toBeTruthy();
    });
    expect(onNotice).toHaveBeenCalledWith("error", "探测失败");

    api.dwsGitRiskProbe.mockResolvedValue({
      risk: { repos: [], risks: [], advice: "", persisted: false, history: [] },
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(/尚未关联开发仓库/);
  });

  it("打开开发工作台走壳层回调，并传入 devProjectId", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: { repos: [], risks: [], advice: "", persisted: false, history: [] },
    });
    const onOpenDevWorkbench = vi.fn();
    render(<GitRiskPanel {...props({ devProjectId: "dp-1", onOpenDevWorkbench })} />);

    await screen.findByText(/尚未关联开发仓库/);
    fireEvent.click(screen.getByRole("button", { name: "打开开发工作台" }));

    expect(onOpenDevWorkbench).toHaveBeenCalledTimes(1);
    expect(onOpenDevWorkbench).toHaveBeenCalledWith("dp-1");
  });

  it("未关联开发项目时提示并引导去项目设置", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: { repos: [], risks: [], advice: "", persisted: false, history: [] },
    });
    const onNotice = vi.fn();
    const switchModule = vi.fn();
    render(<GitRiskPanel {...props({ onNotice, switchModule })} />);

    await screen.findByText(/尚未关联开发仓库/);
    fireEvent.click(screen.getByRole("button", { name: "打开开发工作台" }));

    expect(onNotice).toHaveBeenCalledWith(
      "error",
      "该项目还没有关联开发项目；请先到「项目设置」关联开发仓库。",
    );

    fireEvent.click(screen.getByRole("button", { name: "去项目设置" }));
    expect(switchModule).toHaveBeenCalledWith("settings");
    fireEvent.click(screen.getByRole("button", { name: "去项目设置关联仓库" }));
    expect(switchModule).toHaveBeenCalledTimes(2);
  });

  it("壳层回调抛错时给出可见反馈", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: { repos: [], risks: [], advice: "", persisted: false, history: [] },
    });
    const onNotice = vi.fn();
    const onOpenDevWorkbench = vi.fn(() => {
      throw new Error("导航事务失败");
    });
    render(<GitRiskPanel {...props({ devProjectId: "dp-1", onNotice, onOpenDevWorkbench })} />);

    await screen.findByText(/尚未关联开发仓库/);
    fireEvent.click(screen.getByRole("button", { name: "打开开发工作台" }));

    expect(onNotice).toHaveBeenCalledWith("error", "打开开发工作台失败：导航事务失败");
  });

  it("打开仓库目录失败时给出可见反馈", async () => {
    api.dwsRevealPath.mockRejectedValueOnce(new Error("拒绝访问"));
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: {
        repos: [
          {
            devProjectId: "dp1",
            name: "repo-a",
            rootPath: "D:/repo-a",
            exists: true,
            git: okGit,
            changedFiles: [],
            truncated: false,
            changedFilesKnown: true,
            risks: [],
          },
        ],
        risks: [],
        advice: "",
        persisted: false,
        history: [],
      },
    });
    const onNotice = vi.fn();
    render(<GitRiskPanel {...props({ onNotice })} />);

    await screen.findByText("repo-a");
    fireEvent.click(screen.getByRole("button", { name: "打开仓库目录" }));

    await waitFor(() => {
      expect(onNotice).toHaveBeenCalledWith("error", "打开仓库目录失败：拒绝访问");
    });
  });

  it("目录失效时如实降级，按钮置灰且不展示假 Git 状态", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: {
        repos: [
          {
            devProjectId: "dp4",
            name: "gone-repo",
            rootPath: "D:/gone",
            exists: false,
            git: { ...notRepoGit, status: "path_missing" },
            changedFiles: [],
            truncated: false,
            changedFilesKnown: false,
            risks: [
              { level: "warn", code: "path_missing", message: "仓库目录不存在", files: [] },
            ],
          },
        ],
        risks: [],
        advice: "",
        persisted: false,
        history: [],
      },
    });

    render(<GitRiskPanel {...props()} />);

    await screen.findByText("gone-repo");
    expect(screen.getByText("目录失效")).toBeTruthy();
    expect(screen.getByText("路径失效")).toBeTruthy();
    expect(screen.queryByText("分支：main")).toBeNull();
    expect(screen.queryByText(/未提交：/)).toBeNull();
    expect(screen.getByRole("button", { name: "打开仓库目录" })).toHaveProperty("disabled", true);
  });

  it("展示本机探测快照，并声明其口径", async () => {
    api.dwsGitRiskProbe.mockResolvedValue({
      risk: {
        repos: [],
        risks: [],
        advice: "",
        persisted: true,
        history: [
          {
            id: "ph1",
            probedAt: "2026-11-16T09:00:00+00:00",
            gitStatus: "ok",
            branch: "main",
            headSha: "abc1234567890",
            dirtyCount: 3,
            repoCount: 2,
            truncated: true,
          },
        ],
      },
    });

    render(<GitRiskPanel {...props()} />);

    await screen.findByText("本机探测快照（1）");
    expect(screen.getByText(/不跨机同步/)).toBeTruthy();
    expect(screen.getByText(/改动已截断/)).toBeTruthy();
    expect(screen.getByText(/收录仓库 2 个/)).toBeTruthy();
  });
});

describe("AgentsPanel", () => {
  it("区分 Agent 自述完成与人工验收结论，不自动判通过", async () => {
    render(<AgentsPanel {...props()} />);

    await screen.findByText("交接包 v1");
    // Agent 轮次尚无验收记录 → 待人工验收，不显示通过。
    expect(screen.getByText("待人工验收")).toBeTruthy();
    // 人工验收记录结论为未通过（子标题与记录徽标各一处）。
    expect(screen.getAllByText("未通过").length).toBeGreaterThan(0);
    expect(screen.getByText("改动未通过")).toBeTruthy();
    expect(screen.getByText(/Agent 完成轮次不等于验收通过/)).toBeTruthy();
  });

  it("无关联任务时展示空态并可直接进入「任务关联」", async () => {
    api.dwsDevelopmentSummary.mockResolvedValue({
      summary: { ...summaryTasks.summary, tasks: [] },
    });
    const switchModule = vi.fn();

    render(<AgentsPanel {...props({ switchModule })} />);

    await screen.findByText(/还没有关联任务/);
    expect(api.dwsTaskHandoff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "去「任务关联」" }));
    expect(switchModule).toHaveBeenCalledWith("links");
  });

  it("summary 加载失败只重试 summary，成功后正常展示", async () => {
    api.dwsDevelopmentSummary.mockRejectedValueOnce(new Error("网络中断"));
    render(<AgentsPanel {...props()} />);

    await screen.findByText("关联任务加载失败：网络中断");
    expect(api.dwsTaskHandoff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await screen.findByText("交接包 v1");
    expect(api.dwsDevelopmentSummary).toHaveBeenCalledTimes(2);
  });

  it("handoff 加载失败只重试当前 taskId 的 handoff", async () => {
    api.dwsTaskHandoff.mockRejectedValueOnce(new Error("读取失败"));
    render(<AgentsPanel {...props()} />);

    await screen.findByText("接续记录加载失败（任务一）：读取失败");
    expect(api.dwsDevelopmentSummary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await screen.findByText("交接包 v1");
    expect(api.dwsTaskHandoff).toHaveBeenLastCalledWith("p1", "t1");
    expect(api.dwsDevelopmentSummary).toHaveBeenCalledTimes(1);
  });

  it("切换任务立即清空旧交接，不短暂展示旧记录", async () => {
    const pending = deferred<{ handoff: typeof handoffV2.handoff }>();
    api.dwsDevelopmentSummary.mockResolvedValue(twoTasks);
    api.dwsTaskHandoff.mockImplementation((_pid: string, taskId: string) =>
      taskId === "t1" ? Promise.resolve(handoffV1) : pending.promise,
    );

    render(<AgentsPanel {...props()} />);
    await screen.findByText("交接包 v1");

    fireEvent.click(screen.getByRole("button", { name: "任务二" }));
    expect(screen.queryByText("交接包 v1")).toBeNull();
    expect(screen.getByText("正在加载接续记录…")).toBeTruthy();

    pending.resolve(handoffV2);
    await screen.findByText("交接包 v2");
    expect(screen.queryByText("交接包 v1")).toBeNull();
  });

  it("快速连续切换时旧请求返回不覆盖新任务数据", async () => {
    const slowT1 = deferred<{ handoff: typeof handoffV1.handoff }>();
    const fastT2 = deferred<{ handoff: typeof handoffV2.handoff }>();
    api.dwsDevelopmentSummary.mockResolvedValue(twoTasks);
    api.dwsTaskHandoff.mockImplementation((_pid: string, taskId: string) =>
      taskId === "t1" ? slowT1.promise : fastT2.promise,
    );

    render(<AgentsPanel {...props()} />);
    await screen.findByRole("button", { name: "任务二" });

    fireEvent.click(screen.getByRole("button", { name: "任务二" }));
    fastT2.resolve(handoffV2);
    await screen.findByText("交接包 v2");

    slowT1.resolve(handoffV1);
    await waitFor(() => {
      expect(screen.queryByText("交接包 v1")).toBeNull();
    });
    expect(screen.getByText("交接包 v2")).toBeTruthy();
  });

  it("当前任务被解除关联后不再显示其旧交接信息", async () => {
    api.dwsDevelopmentSummary
      .mockResolvedValueOnce(summaryTasks)
      .mockResolvedValueOnce({ summary: { ...summaryTasks.summary, tasks: [] } });

    render(<AgentsPanel {...props()} />);
    await screen.findByText("交接包 v1");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await screen.findByText(/还没有关联任务/);
    expect(screen.queryByText("交接包 v1")).toBeNull();
    expect(screen.queryByText("改动未通过")).toBeNull();
  });

  it("任务被移除后自动选中列表中的第一个有效任务", async () => {
    api.dwsDevelopmentSummary
      .mockResolvedValueOnce(twoTasks)
      .mockResolvedValueOnce({
        summary: {
          ...twoTasks.summary,
          tasks: twoTasks.summary.tasks.filter((t) => t.taskId === "t2"),
        },
      });
    api.dwsTaskHandoff.mockImplementation((_pid: string, taskId: string) =>
      Promise.resolve(taskId === "t2" ? handoffV2 : handoffV1),
    );

    render(<AgentsPanel {...props()} />);
    await screen.findByText("交接包 v1");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await screen.findByText("交接包 v2");
    expect(screen.queryByText("交接包 v1")).toBeNull();
    expect(api.dwsTaskHandoff).toHaveBeenLastCalledWith("p1", "t2");
  });

  it("卸载后旧请求不写入状态（不产生未处理异常）", async () => {
    const pending = deferred<{ handoff: typeof handoffV1.handoff }>();
    api.dwsTaskHandoff.mockReturnValue(pending.promise);

    const { unmount } = render(<AgentsPanel {...props()} />);
    await screen.findByText(/正在加载接续记录|正在加载关联任务/);
    unmount();

    pending.resolve(handoffV1);
    await Promise.resolve();
    expect(screen.queryByText("交接包 v1")).toBeNull();
  });
});

describe("describeBuildStatus", () => {
  it("failed + exitCode=0 判为状态冲突，绝不显示成功", () => {
    const view = describeBuildStatus("failed", 0);
    expect(view.tone).toBe("bad");
    expect(view.label).toContain("状态冲突");
    expect(view.label).not.toContain("成功");
  });

  it("succeeded + 非 0 退出码判为状态冲突", () => {
    const view = describeBuildStatus("succeeded", 2);
    expect(view.tone).toBe("bad");
    expect(view.label).toContain("状态冲突");
  });

  it("unknown + exitCode=0 不显示为成功", () => {
    const view = describeBuildStatus("unknown", 0);
    expect(view.tone).toBe("warn");
    expect(view.label).toBe("未知（退出码 0）");
    expect(view.tone).not.toBe("ok");
  });

  it("成功但缺退出码只给琥珀色证据不足提示", () => {
    const view = describeBuildStatus("succeeded", null);
    expect(view.tone).toBe("warn");
    expect(view.label).toBe("成功（退出码未记录）");
  });

  it("成功且退出码为 0 才是绿色成功", () => {
    const view = describeBuildStatus("succeeded", 0);
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("成功");
  });

  it("中文状态映射与未知状态原样回显", () => {
    expect(describeBuildStatus("running", null).label).toBe("进行中");
    expect(describeBuildStatus("CANCELLED", null).label).toBe("已取消");
    expect(describeBuildStatus("weird", null).label).toBe("weird");
  });
});

describe("resolveLedgerPath", () => {
  it("绝对路径原样返回，相对路径按仓库根拼接", () => {
    expect(resolveLedgerPath("D:\\repo", "C:\\logs\\build.log")).toBe("C:\\logs\\build.log");
    expect(resolveLedgerPath("D:\\repo", "/var/log/build.log")).toBe("/var/log/build.log");
    expect(resolveLedgerPath("D:\\repo\\", "tmp/integration/builds/b1/build.log")).toBe(
      "D:\\repo\\tmp\\integration\\builds\\b1\\build.log",
    );
  });

  it("无路径或无仓库根时返回 null，不猜路径", () => {
    expect(resolveLedgerPath("D:\\repo", null)).toBeNull();
    expect(resolveLedgerPath("", "tmp/a.log")).toBeNull();
  });
});

describe("BuildTracePanel", () => {
  it("台账不可用时可见降级，同时展示本地显式关联", async () => {
    render(<BuildTracePanel {...props()} />);

    await screen.findByText(/集成台账暂不可用/);
    expect(screen.getByText(/b02-web-r1/)).toBeTruthy();
    expect(screen.getByText("手工关联")).toBeTruthy();
  });

  it("归档项目不渲染关联表单，写入口置灰", async () => {
    render(<BuildTracePanel {...props({ archived: true })} />);

    await screen.findByText(/b02-web-r1/);
    expect(screen.queryByRole("button", { name: "保存关联" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
    expect(screen.getByText(/项目已归档/)).toBeTruthy();
  });

  it("summary 加载失败不再静默：错误可见且可重试", async () => {
    api.dwsDevelopmentSummary.mockRejectedValueOnce(new Error("任务接口超时"));
    render(<BuildTracePanel {...props()} />);

    await screen.findByText("关联任务清单加载失败：任务接口超时");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(screen.queryByText(/关联任务清单加载失败/)).toBeNull();
    });
    expect(screen.getByRole("option", { name: "任务一" })).toBeTruthy();
  });

  it("构建状态冲突与未知状态在界面上按异常 / 未知展示", async () => {
    api.dwsBuildTrace.mockResolvedValue({
      trace: {
        ...traceUnavailable.trace,
        ledgerAvailable: true,
        ledgerRoot: "D:/repo-a/tmp/integration",
        ledgerReason: null,
        sources: [
          {
            devProjectId: "dp1",
            name: "repo-a",
            repoRoot: "D:\\repo-a",
            ledgerDir: "D:\\repo-a\\tmp\\integration",
            available: true,
            reason: null,
            taskCount: 0,
            snapshotCount: 0,
            buildCount: 2,
            truncated: false,
          },
        ],
        builds: [
          buildRow({ id: "bld-failed-0", status: "failed", exitCode: 0 }),
          buildRow({ id: "bld-unknown-0", status: "unknown", exitCode: 0 }),
        ],
      },
    });

    render(<BuildTracePanel {...props()} />);

    await screen.findByText("失败（退出码 0，状态冲突）");
    expect(screen.getByText("未知（退出码 0）")).toBeTruthy();
    expect(screen.queryByText("成功")).toBeNull();
    expect(screen.getByText("台账来源（1）")).toBeTruthy();
    expect(screen.getByText("可读")).toBeTruthy();
  });

  it("快照按 createdAt 倒序展示", async () => {
    api.dwsBuildTrace.mockResolvedValue({
      trace: {
        ...traceUnavailable.trace,
        ledgerAvailable: true,
        ledgerReason: null,
        snapshots: [
          {
            id: "snap-old",
            branch: "main",
            base: null,
            commit: "aaa",
            tasks: [],
            note: "",
            createdAt: "2026-11-10T09:00:00+00:00",
            repoName: "repo-a",
            repoRoot: "D:\\repo-a",
          },
          {
            id: "snap-new",
            branch: "main",
            base: null,
            commit: "bbb",
            tasks: [],
            note: "",
            createdAt: "2026-11-20T09:00:00+00:00",
            repoName: "repo-a",
            repoRoot: "D:\\repo-a",
          },
        ],
      },
    });

    render(<BuildTracePanel {...props()} />);

    await screen.findByText("集成快照（2）");
    const text = document.body.textContent ?? "";
    expect(text.indexOf("snap-new")).toBeLessThan(text.indexOf("snap-old"));
  });

  it("没有任务的构建关联也显示明确标题，不留空白行", async () => {
    api.dwsBuildTrace.mockResolvedValue({
      trace: {
        ...traceUnavailable.trace,
        links: [
          {
            ...traceUnavailable.trace.links[0],
            id: "lk2",
            taskId: "",
            taskTitle: null,
            handoffPackId: "",
            buildId: "bld-9",
            note: "",
          },
        ],
      },
    });

    render(<BuildTracePanel {...props()} />);

    await screen.findByText("未关联任务");
    expect(screen.getByText("构建 bld-9")).toBeTruthy();
  });

  it("保存关联给出输入校验反馈", async () => {
    render(<BuildTracePanel {...props()} />);

    await screen.findByRole("button", { name: "保存关联" });
    fireEvent.click(screen.getByRole("button", { name: "保存关联" }));

    expect(screen.getByRole("alert").textContent).toContain("请至少选择任务或填写构建 buildId");
    expect(api.dwsTaskLinkSave).not.toHaveBeenCalled();

    const buildInput = screen.getByLabelText("构建 buildId");
    fireEvent.change(buildInput, { target: { value: "非法 id/../x" } });
    fireEvent.click(screen.getByRole("button", { name: "保存关联" }));
    expect(screen.getByRole("alert").textContent).toContain("buildId 只能包含字母、数字");

    fireEvent.change(buildInput, { target: { value: "b02-web-r1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存关联" }));
    await waitFor(() => {
      expect(api.dwsTaskLinkSave).toHaveBeenCalledTimes(1);
    });
    expect(api.dwsTaskLinkSave).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: null,
      buildId: "b02-web-r1",
      note: null,
    });
  });

  it("重复点击移除按钮只发一次删除请求，并按原型置灰", async () => {
    const pending = deferred<{ ok: boolean }>();
    api.dwsTaskLinkDelete.mockReturnValue(pending.promise);

    render(<BuildTracePanel {...props()} />);

    const remove = await screen.findByRole("button", { name: "移除" });
    fireEvent.click(remove);
    fireEvent.click(remove);

    expect(api.dwsTaskLinkDelete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "移除中…" })).toHaveProperty("disabled", true);
  });

  it("台账读取失败可见错误与重试", async () => {
    api.dwsBuildTrace.mockRejectedValueOnce(new Error("台账读取失败"));
    const onNotice = vi.fn();
    render(<BuildTracePanel {...props({ onNotice })} />);

    await screen.findByText("台账读取失败");
    expect(onNotice).toHaveBeenCalledWith("error", "台账读取失败");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(/集成台账暂不可用/);
  });
});
