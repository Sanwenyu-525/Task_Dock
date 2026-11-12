/**
 * @vitest-environment jsdom
 */
//! DevHandoffSection（任务交接包区块）交互测试：
//! 1. 初始预填：任务标题/备注 → 任务目标；当前项目名/分支/路径 → 项目背景（不覆盖已编辑）；
//! 2. 空节不输出：预览 Markdown 不含未填写节的标题；
//! 3. 敏感扫描：命中只显示「节名 + 行号 + 类型」，绝不渲染原文；无命中显示绿色提示；
//! 4. 复制成功/失败：失败时错误提示且编辑内容不丢失；
//! 5. 保存版本：dev_handoff_save 参数与预览一致，成功后刷新版本列表；失败不丢编辑。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useLocaleStore } from "../../i18n";
import DevHandoffSection from "./DevHandoffSection";
import { invalidateDevProjectCache } from "./DevProjectContext";
import type { DevGitInfo, DevHandoffPack, DevProject, Task } from "../../lib/bridge";

const FIX_TASK: Task = {
  id: "t1",
  title: "重构剪贴板模块",
  description: "把 Win32 访问收敛到 platform.rs",
  priority: 1,
  status: "pending",
  category: "dev",
  tags: [],
  due_at: null,
  remind_at: null,
  advance_minutes: 0,
  recurrence: null,
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
  completed_at: null,
  linked_agents: 0,
};

const FIX_PROJECT: DevProject = {
  id: "p1",
  name: "Task Dock",
  rootPath: "D:\\code\\task-dock",
  note: "",
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
  exists: true,
};

const GIT_OK: DevGitInfo = {
  status: "ok",
  branch: "main",
  detached: false,
  isWorktree: false,
  mainRepoPath: null,
  headSha: null,
  dirtyCount: 2,
  probedAt: "2026-11-12T08:00:00Z",
};

function packOf(patch: Partial<DevHandoffPack>): DevHandoffPack {
  return {
    id: "pk1",
    taskId: "t1",
    title: "重构剪贴板模块",
    version: 1,
    contentMd: "# 任务交接包：重构剪贴板模块",
    sourceSummary: "",
    secretScan: "",
    createdAt: "2026-11-12T09:00:00Z",
    ...patch,
  };
}

const {
  fetchTask,
  listTaskLinks,
  planningListAgentFeatureLinks,
  planningListFeatures,
  devProjectList,
  devProjectProbe,
  devHandoffList,
  devHandoffSave,
  devHandoffDelete,
  devHandoffSecretScan,
  copyText,
} = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  listTaskLinks: vi.fn(),
  planningListAgentFeatureLinks: vi.fn(),
  planningListFeatures: vi.fn(),
  devProjectList: vi.fn(),
  devProjectProbe: vi.fn(),
  devHandoffList: vi.fn(),
  devHandoffSave: vi.fn(),
  devHandoffDelete: vi.fn(),
  devHandoffSecretScan: vi.fn(),
  copyText: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    fetchTask,
    listTaskLinks,
    planningListAgentFeatureLinks,
    planningListFeatures,
    devProjectList,
    devProjectProbe,
    devHandoffList,
    devHandoffSave,
    devHandoffDelete,
    devHandoffSecretScan,
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      ...(useSettingsStore.getState().settings ?? {}),
      ...patch,
    })),
    getSettings: vi.fn(async () => useSettingsStore.getState().settings ?? {}),
  };
});

vi.mock("../../lib/clipboard", () => ({
  copyText: (...a: unknown[]) => copyText(...a),
}));

function seedSettings(patch: Record<string, unknown> = {}) {
  useSettingsStore.setState({
    settings: {
      ...(useSettingsStore.getState().settings ?? {}),
      theme: "system",
      mode: "full",
      ...patch,
    } as never,
  });
}

beforeEach(() => {
  invalidateDevProjectCache();
  useLocaleStore.setState({ locale: "zh-CN", preference: "zh-CN" });
  useUiStore.setState({ toasts: [], toast: null });
  seedSettings({ workbench_current_task: "t1", workbench_current_project: "p1" });
  fetchTask.mockResolvedValue(FIX_TASK);
  listTaskLinks.mockResolvedValue([]);
  devProjectList.mockResolvedValue({ projects: [FIX_PROJECT] });
  devProjectProbe.mockResolvedValue(GIT_OK);
  devHandoffList.mockResolvedValue({ packs: [] });
  devHandoffSecretScan.mockResolvedValue({ findings: [], truncated: false });
  devHandoffSave.mockImplementation(async (input: { taskId: string | null; title: string }) => ({
    pack: packOf({ title: input.title, version: 1 }),
  }));
  devHandoffDelete.mockResolvedValue({ ok: true });
  copyText.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("DevHandoffSection · 初始预填", () => {
  it("任务标题/备注进「任务目标」，标题输入预填任务标题", async () => {
    render(<DevHandoffSection />);
    const goal = (await screen.findByLabelText("任务目标")) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(goal.value).toContain("重构剪贴板模块");
      expect(goal.value).toContain("把 Win32 访问收敛到 platform.rs");
    });
    expect((screen.getByLabelText("交接包标题") as HTMLInputElement).value).toBe(
      "重构剪贴板模块",
    );
  });

  it("项目背景预填：项目名 + 路径 + 分支 + 未提交数", async () => {
    render(<DevHandoffSection />);
    const bg = (await screen.findByLabelText("项目背景")) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(bg.value).toContain("项目：Task Dock");
      expect(bg.value).toContain("路径：D:\\code\\task-dock");
      expect(bg.value).toContain("分支：main");
      expect(bg.value).toContain("未提交 2 处");
    });
  });

  it("关联功能的验收标准预填到「验收标准」节", async () => {
    listTaskLinks.mockResolvedValue([
      {
        id: "l1",
        task_id: "t1",
        source_id: "codex",
        session_external_id: "sess-1",
        run_external_id: null,
        created_at: "2026-11-12T00:00:00Z",
        available: true,
      },
    ]);
    // DevAcceptanceSection.findFeaturesForTask 真实链路 → planning 命令
    planningListAgentFeatureLinks.mockResolvedValue([
      {
        id: "fl1",
        feature_id: "f1",
        feature_title: "采集管线加固",
        project_id: "prj1",
        project_name: "Task Dock",
        agent_source: "codex",
        agent_name: null,
        session_id: "sess-1",
        status: "linked",
        agent_status: null,
        agent_session_id: null,
        last_seen_at: null,
        last_execution_at: null,
      },
    ]);
    planningListFeatures.mockResolvedValue([
      {
        id: "f1",
        project_id: "prj1",
        title: "采集管线加固",
        description: "",
        acceptance_criteria: "waiting/failed 不合并",
        status: "in_progress",
        priority: "P1",
        milestone_id: null,
        milestone_name: null,
        target_date: null,
        sort_order: 0,
        created_at: "2026-11-12T00:00:00Z",
        updated_at: "2026-11-12T00:00:00Z",
        completed_at: null,
        steps: [],
        step_total: 0,
        step_done: 0,
      },
    ]);
    render(<DevHandoffSection />);
    const criteria = (await screen.findByLabelText("验收标准")) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(criteria.value).toBe("waiting/failed 不合并");
    });
  });

  it("用户已编辑的节不被预填覆盖", async () => {
    fetchTask.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(FIX_TASK), 20),
        ),
    );
    render(<DevHandoffSection />);
    const goal = (await screen.findByLabelText("任务目标")) as HTMLTextAreaElement;
    // 数据到达前先编辑：稍后到达的预填不得覆盖
    fireEvent.change(goal, { target: { value: "我自己的说明" } });
    await waitFor(() => {
      expect(fetchTask).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 40));
    expect((screen.getByLabelText("任务目标") as HTMLTextAreaElement).value).toBe("我自己的说明");
  });
});

describe("DevHandoffSection · Markdown 预览", () => {
  it("空节不输出：预览含已填节标题，不含未填节标题；标题行恒存在", async () => {
    render(<DevHandoffSection />);
    const preview = (await screen.findByLabelText("Markdown 预览")) as HTMLElement;
    await waitFor(() => {
      expect(preview.textContent).toContain("# 任务交接包：重构剪贴板模块");
    });
    expect(preview.textContent).toContain("## 任务目标");
    expect(preview.textContent).not.toContain("## 技术限制");
    expect(preview.textContent).not.toContain("## 依赖任务");
  });
});

describe("DevHandoffSection · 敏感扫描", () => {
  it("命中只显示节名 + 行号 + 类型，绝不渲染原文；输入文本按节序传入", async () => {
    const SECRET = "sk-live-abcdef1234567890";
    fetchTask.mockResolvedValue({
      ...FIX_TASK,
      description: `密钥 ${SECRET} 别提交`,
    });
    devHandoffSecretScan.mockResolvedValue({
      findings: [{ textIndex: 1, line: 1, kind: "api_key" }],
      truncated: false,
    });
    render(<DevHandoffSection />);
    const goal = (await screen.findByLabelText("任务目标")) as HTMLTextAreaElement;
    await waitFor(() => expect(goal.value).toContain(SECRET));
    fireEvent.click(screen.getByRole("button", { name: "扫描敏感内容" }));
    expect(await screen.findByText(/「任务目标」第 1 行 · api_key/)).toBeTruthy();
    // 扫描结果绝不包含原文
    const findingsBox = screen.getByRole("alert");
    expect(findingsBox.textContent).not.toContain(SECRET);
    // 12 节文本按固定顺序传入
    await waitFor(() => {
      expect(devHandoffSecretScan).toHaveBeenCalledTimes(1);
    });
    const texts = vi.mocked(devHandoffSecretScan).mock.calls[0][0] as string[];
    expect(texts).toHaveLength(12);
    expect(texts[1]).toContain(SECRET);
  });

  it("无命中显示绿色「未发现敏感模式」；truncated 显示截断提示", async () => {
    render(<DevHandoffSection />);
    await screen.findByLabelText("任务目标");
    fireEvent.click(screen.getByRole("button", { name: "扫描敏感内容" }));
    expect(await screen.findByText("未发现敏感模式")).toBeTruthy();

    devHandoffSecretScan.mockResolvedValue({
      findings: [
        { textIndex: 0, line: 1, kind: "password" },
        { textIndex: 0, line: 2, kind: "password" },
      ],
      truncated: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "扫描敏感内容" }));
    expect(await screen.findByText(/结果已截断/)).toBeTruthy();
  });
});

describe("DevHandoffSection · 复制", () => {
  it("复制成功：copyText 收到预览 Markdown；失败：错误提示且编辑内容不丢失", async () => {
    render(<DevHandoffSection />);
    const goal = (await screen.findByLabelText("任务目标")) as HTMLTextAreaElement;
    await waitFor(() => expect(goal.value).not.toBe(""));
    const before = goal.value;

    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown" }));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(
        expect.stringContaining("# 任务交接包：重构剪贴板模块"),
      );
    });

    copyText.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown" }));
    expect(await screen.findByText(/复制失败/)).toBeTruthy();
    // 复制失败不丢编辑内容
    expect((screen.getByLabelText("任务目标") as HTMLTextAreaElement).value).toBe(before);
  });
});

describe("DevHandoffSection · 保存版本", () => {
  it("保存：contentMd 与预览一致、sourceSummary 为来源 JSON；成功后刷新版本列表", async () => {
    const savedPack = packOf({});
    devHandoffList
      .mockResolvedValueOnce({ packs: [] })
      .mockResolvedValueOnce({ packs: [savedPack] });
    render(<DevHandoffSection />);
    const goal = (await screen.findByLabelText("任务目标")) as HTMLTextAreaElement;
    await waitFor(() => expect(goal.value).not.toBe(""));
    const preview = (screen.getByLabelText("Markdown 预览") as HTMLElement).textContent ?? "";

    fireEvent.click(screen.getByRole("button", { name: "保存版本" }));
    await waitFor(() => {
      expect(devHandoffSave).toHaveBeenCalledTimes(1);
    });
    const arg = vi.mocked(devHandoffSave).mock.calls[0][0] as {
      taskId: string | null;
      title: string;
      contentMd: string;
      sourceSummary: string;
    };
    expect(arg.taskId).toBe("t1");
    expect(arg.title).toBe("重构剪贴板模块");
    expect(arg.contentMd).toBe(preview);
    const source = JSON.parse(arg.sourceSummary) as { taskId: string; projectId: string | null };
    expect(source.taskId).toBe("t1");
    expect(source.projectId).toBe("p1");
    // 保存成功后重读版本列表，v1 出现
    expect(await screen.findByText(/v1/)).toBeTruthy();
    expect(devHandoffList.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("保存失败：错误提示且编辑内容不丢失", async () => {
    devHandoffSave.mockRejectedValue(new Error("db locked"));
    render(<DevHandoffSection />);
    const goal = (await screen.findByLabelText("任务目标")) as HTMLTextAreaElement;
    await waitFor(() => expect(goal.value).not.toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "保存版本" }));
    expect(await screen.findByText(/保存失败/)).toBeTruthy();
    expect((screen.getByLabelText("任务目标") as HTMLTextAreaElement).value).toBe(goal.value);
    expect((screen.getByLabelText("交接包标题") as HTMLInputElement).value).toBe(
      "重构剪贴板模块",
    );
  });

  it("版本列表操作：查看展开只读正文、删除走确认框", async () => {
    devHandoffList.mockResolvedValue({ packs: [packOf({})] });
    render(<DevHandoffSection />);
    expect(await screen.findByText(/v1/)).toBeTruthy();
    // 查看：展开只读正文
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(await screen.findByText("# 任务交接包：重构剪贴板模块")).toBeTruthy();
    // 删除：先确认框，确认后才调用 dev_handoff_delete
    fireEvent.click(screen.getByRole("button", { name: "删除版本 v1" }));
    expect(await screen.findByText("删除交接包版本")).toBeTruthy();
    expect(devHandoffDelete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除版本" }));
    await waitFor(() => {
      expect(devHandoffDelete).toHaveBeenCalledWith("pk1");
    });
  });
});
