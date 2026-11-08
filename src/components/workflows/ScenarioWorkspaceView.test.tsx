/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShelfItem } from "../../lib/bridge";

const bridge = vi.hoisted(() => ({
  onWorkflowRunProgress: vi.fn(),
  onWorkspaceRestoreProgress: vi.fn(),
  scenarioDelete: vi.fn(),
  scenarioDuplicate: vi.fn(),
  scenarioEnter: vi.fn(),
  scenarioEnterCancel: vi.fn(),
  scenarioGet: vi.fn(),
  scenarioList: vi.fn(),
  scenarioSave: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfGetItem: vi.fn(),
  shelfList: vi.fn(),
  workflowList: vi.fn(),
  workspaceList: vi.fn(),
}));

const dialogOpen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpen(...args),
}));

vi.mock("../../lib/bridge", () => ({
  onWorkflowRunProgress: (...args: unknown[]) => bridge.onWorkflowRunProgress(...args),
  onWorkspaceRestoreProgress: (...args: unknown[]) => bridge.onWorkspaceRestoreProgress(...args),
  scenarioDelete: (...args: unknown[]) => bridge.scenarioDelete(...args),
  scenarioDuplicate: (...args: unknown[]) => bridge.scenarioDuplicate(...args),
  scenarioEnter: (...args: unknown[]) => bridge.scenarioEnter(...args),
  scenarioEnterCancel: (...args: unknown[]) => bridge.scenarioEnterCancel(...args),
  scenarioGet: (...args: unknown[]) => bridge.scenarioGet(...args),
  scenarioList: (...args: unknown[]) => bridge.scenarioList(...args),
  scenarioSave: (...args: unknown[]) => bridge.scenarioSave(...args),
  shelfCheckExists: (...args: unknown[]) => bridge.shelfCheckExists(...args),
  shelfGetItem: (...args: unknown[]) => bridge.shelfGetItem(...args),
  shelfList: (...args: unknown[]) => bridge.shelfList(...args),
  workflowList: (...args: unknown[]) => bridge.workflowList(...args),
  workspaceList: (...args: unknown[]) => bridge.workspaceList(...args),
}));

vi.mock("../../lib/navigation", () => ({ navListTargets: vi.fn().mockResolvedValue([]) }));

import { useScenarioStore } from "../../store/useScenarioStore";
import ScenarioWorkspaceView from "./ScenarioWorkspaceView";

function shelfItem(overrides: Partial<ShelfItem> = {}): ShelfItem {
  return {
    id: "shelf-file-1",
    kind: "file",
    display_name: "季度报告.docx",
    source_kind: "picker",
    storage_mode: "reference",
    original_path: "D:\\Private\\季度报告.docx",
    managed_path: null,
    content: null,
    byte_size: 2048,
    file_ext: "docx",
    favorite: false,
    pinned: false,
    exists_state: "unknown",
    group_id: null,
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(bridge).forEach((mock) => mock.mockReset());
  dialogOpen.mockReset();
  bridge.onWorkflowRunProgress.mockResolvedValue(() => undefined);
  bridge.onWorkspaceRestoreProgress.mockResolvedValue(() => undefined);
  bridge.scenarioList.mockResolvedValue([]);
  bridge.scenarioSave.mockResolvedValue({ id: "scene-new" });
  bridge.workflowList.mockResolvedValue([]);
  bridge.workspaceList.mockResolvedValue([]);
  bridge.shelfList.mockImplementation(({ kind }: { kind: string }) => Promise.resolve({
    items: kind === "file" ? [shelfItem()] : [],
    total: kind === "file" ? 1 : 0,
  }));
  bridge.shelfCheckExists.mockResolvedValue([{ id: "shelf-file-1", exists_state: "ok" }]);
  bridge.shelfGetItem.mockResolvedValue(shelfItem({ scene_id: "scene-existing" }));
  useScenarioStore.setState({
    summaries: [], loading: false, loaded: false, error: null,
    enteringId: null, cancellingId: null, editing: null, results: {}, progressByItem: {},
    activeSnapshotId: null, activeWorkflowId: null,
  });
});

afterEach(() => cleanup());

describe("ScenarioWorkspaceView 暂存关联", () => {
  it("提供场景工作区对应的上下文教程入口", () => {
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    expect(screen.getByRole("button", { name: "查看帮助：场景工作区：管理并进入可复用场景" })).toBeTruthy();
  });

  it("只把已有暂存条目 UUID 保存为关联，不回传路径或调用文件删除", async () => {
    const user = userEvent.setup();
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "新建场景" }));
    await user.type(screen.getByLabelText("名称"), "季度复盘");
    const candidate = await screen.findByRole("button", { name: /季度报告\.docx/ });
    await user.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "保存场景" }));

    await waitFor(() => expect(bridge.scenarioSave).toHaveBeenCalledTimes(1));
    expect(bridge.scenarioSave.mock.calls[0][0]).toMatchObject({
      name: "季度复盘",
      shelfItemIds: ["shelf-file-1"],
    });
    expect(JSON.stringify(bridge.scenarioSave.mock.calls[0][0])).not.toContain("季度报告.docx");
    expect(bridge.scenarioDelete).not.toHaveBeenCalled();
  });

  it("已关联但路径失效的条目仍保留 ID 并明确显示状态", async () => {
    const user = userEvent.setup();
    bridge.scenarioGet.mockResolvedValue({
      id: "scene-existing", name: "现有场景", icon: null, appCount: 0, urlCount: 0, folderCount: 0,
      linkedWorkflowId: null, lastEnteredAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      apps: [], urls: [], folders: [], snapshotId: null, shelfItemIds: ["shelf-file-1"],
    });
    bridge.shelfCheckExists.mockResolvedValue([{ id: "shelf-file-1", exists_state: "missing" }]);
    bridge.shelfGetItem.mockResolvedValue(shelfItem({ scene_id: "scene-existing", exists_state: "missing" }));
    useScenarioStore.setState({
      summaries: [{
        id: "scene-existing", name: "现有场景", icon: null, appCount: 0, urlCount: 0, folderCount: 0,
        linkedWorkflowId: null, lastEnteredAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }],
      loaded: true,
    });
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "编辑 现有场景" }));
    expect(await screen.findByText("季度报告.docx")).toBeTruthy();
    expect(await screen.findByText("文件 · 引用路径 · 原路径失效")).toBeTruthy();
    expect(screen.getByText("只保存暂存架条目 ID，不复制或移动文件。路径失效时保留关联并显示失效状态；同一条目一次只能关联一个场景。")).toBeTruthy();
  });
});

function summaryOf(id: string, name: string) {
  return {
    id, name, icon: null, appCount: 1, urlCount: 1, folderCount: 0,
    linkedWorkflowId: null, lastEnteredAt: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("ScenarioWorkspaceView 进入取消", () => {
  it("进入中只在进入卡片显示取消按钮，点击转发后端取消", async () => {
    const user = userEvent.setup();
    bridge.scenarioEnterCancel.mockResolvedValue(true);
    useScenarioStore.setState({
      summaries: [summaryOf("scene-1", "写作场景")],
      loaded: true,
      enteringId: "scene-1",
    });
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    const cancel = screen.getByRole("button", { name: "取消进入 写作场景" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    await user.click(cancel);

    await waitFor(() => expect(bridge.scenarioEnterCancel).toHaveBeenCalledTimes(1));
    expect(bridge.scenarioEnterCancel).toHaveBeenCalledWith("scene-1");
  });

  it("进入期间禁用所有卡片的编辑/复制/删除与进入，只有进入卡片有取消入口", () => {
    useScenarioStore.setState({
      summaries: [summaryOf("scene-1", "写作场景"), summaryOf("scene-2", "会议场景")],
      loaded: true,
      enteringId: "scene-1",
    });
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    // 两张卡的进入按钮都必须禁用（按文本匹配；进入按钮无 aria-label）
    expect(screen.getAllByText("进入").every((el) => (el.closest("button") as HTMLButtonElement).disabled)).toBe(true);
    for (const label of ["编辑 写作场景", "复制 写作场景", "删除 写作场景", "编辑 会议场景", "复制 会议场景", "删除 会议场景"]) {
      const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled, label).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "取消进入 会议场景" })).toBeNull();
    expect(screen.getByRole("button", { name: "取消进入 写作场景" })).toBeTruthy();
  });

  it("取消后的结果展示已取消摘要、已处理计数，且取消项不冒充失败", () => {
    useScenarioStore.setState({
      summaries: [summaryOf("scene-1", "写作场景")],
      loaded: true,
      results: {
        "scene-1": {
          startedAt: "2026-01-01T00:00:00Z",
          total: 5,
          cancelled: true,
          timedOut: false,
          items: [
            { kind: "app", label: "记事本", status: "ok" },
            { kind: "snapshot", label: "snap-1", status: "failed", detail: "场景进入已取消，现场恢复尚未启动" },
          ],
        },
      },
    });
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    expect(screen.getByText(/已取消：已处理 2\/5 项，剩余项未执行；已启动的应用、网页与现场恢复不会被关闭/)).toBeTruthy();
    expect(screen.queryByText("失败")).toBeNull();
    expect(screen.getAllByText("已取消").length).toBeGreaterThanOrEqual(2);
  });

  it("超时结果按已超时呈现已处理计数", () => {
    useScenarioStore.setState({
      summaries: [summaryOf("scene-1", "写作场景")],
      loaded: true,
      results: {
        "scene-1": {
          startedAt: "2026-01-01T00:00:00Z",
          total: 3,
          cancelled: false,
          timedOut: true,
          items: [{ kind: "app", label: "记事本", status: "ok" }],
        },
      },
    });
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    expect(screen.getByText(/已超时：已处理 1\/3 项/)).toBeTruthy();
  });
});

describe("ScenarioWorkspaceView 编辑器选择器", () => {
  it("文件夹走系统文件浏览器：多选并入清单并去重，可移除，保存传路径数组", async () => {
    const user = userEvent.setup();
    dialogOpen.mockResolvedValueOnce(["D:\\资料\\项目A", "D:\\资料\\项目B", "D:\\资料\\项目A"]);
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "新建场景" }));
    await user.type(screen.getByLabelText("名称"), "资料场景");
    await user.click(screen.getByRole("button", { name: /浏览添加/ }));

    await waitFor(() => {
      expect(screen.getByLabelText("移除文件夹 D:\\资料\\项目A")).toBeTruthy();
      expect(screen.getByLabelText("移除文件夹 D:\\资料\\项目B")).toBeTruthy();
    });
    expect(screen.getAllByLabelText("移除文件夹 D:\\资料\\项目A")).toHaveLength(1);

    // 手动输入作为补充：回车添加
    const manual = screen.getByLabelText("手动添加文件夹路径");
    await user.type(manual, "D:\\资料\\项目C{Enter}");
    expect(screen.getByLabelText("移除文件夹 D:\\资料\\项目C")).toBeTruthy();

    // 保存前移除其一，清单同步（保存成功会关闭编辑器）
    await user.click(screen.getByLabelText("移除文件夹 D:\\资料\\项目B"));
    expect(screen.queryByLabelText("移除文件夹 D:\\资料\\项目B")).toBeNull();

    await user.click(screen.getByRole("button", { name: "保存场景" }));
    await waitFor(() => expect(bridge.scenarioSave).toHaveBeenCalledTimes(1));
    expect(bridge.scenarioSave.mock.calls[0][0]).toMatchObject({
      name: "资料场景",
      folders: ["D:\\资料\\项目A", "D:\\资料\\项目C"],
    });
  });

  it("用户取消文件选择器不改动清单，对话框报错显示到页面", async () => {
    const user = userEvent.setup();
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "新建场景" }));
    dialogOpen.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: /浏览添加/ }));
    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /^移除文件夹/ })).toBeNull();

    dialogOpen.mockRejectedValueOnce(new Error("dialog crashed"));
    await user.click(screen.getByRole("button", { name: /浏览添加/ }));
    expect(await screen.findByText(/文件夹选择失败：dialog crashed/)).toBeTruthy();
  });

  it("图标改为预设点选：选中写入图标，清除恢复占位", async () => {
    const user = userEvent.setup();
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "新建场景" }));
    await user.type(screen.getByLabelText("名称"), "图标场景");

    await user.click(screen.getByRole("button", { name: "选择场景图标" }));
    const option = screen.getByRole("button", { name: "图标 💼" });
    expect(option.getAttribute("aria-pressed")).toBe("false");
    await user.click(option);

    // 选中即写入并关闭弹层
    expect(screen.getByRole("button", { name: "场景图标 💼，点击更换" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "图标 💼" })).toBeNull();

    // 重新打开可清除（清除断言必须在保存前：保存成功会关闭编辑器）
    await user.click(screen.getByRole("button", { name: "场景图标 💼，点击更换" }));
    await user.click(screen.getByRole("button", { name: "清除图标" }));
    expect(screen.getByRole("button", { name: "选择场景图标" })).toBeTruthy();

    // 再次选择后保存
    await user.click(screen.getByRole("button", { name: "选择场景图标" }));
    await user.click(screen.getByRole("button", { name: "图标 💼" }));
    await user.click(screen.getByRole("button", { name: "保存场景" }));
    await waitFor(() => expect(bridge.scenarioSave).toHaveBeenCalledTimes(1));
    expect(bridge.scenarioSave.mock.calls[0][0]).toMatchObject({ icon: "💼" });
  });

  it("编辑已有场景时文件夹与图标回填为点选/列表形态", async () => {
    const user = userEvent.setup();
    bridge.scenarioGet.mockResolvedValue({
      id: "scene-existing", name: "现有场景", icon: "📚", appCount: 0, urlCount: 0, folderCount: 2,
      linkedWorkflowId: null, lastEnteredAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      apps: [], urls: [], folders: ["C:\\旧资料", "D:\\旧备份"], snapshotId: null, shelfItemIds: [],
    });
    useScenarioStore.setState({
      summaries: [{
        id: "scene-existing", name: "现有场景", icon: "📚", appCount: 0, urlCount: 0, folderCount: 2,
        linkedWorkflowId: null, lastEnteredAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      }],
      loaded: true,
    });
    render(<ScenarioWorkspaceView onBack={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "编辑 现有场景" }));
    expect(await screen.findByLabelText("移除文件夹 C:\\旧资料")).toBeTruthy();
    expect(screen.getByLabelText("移除文件夹 D:\\旧备份")).toBeTruthy();
    expect(screen.getByRole("button", { name: "场景图标 📚，点击更换" })).toBeTruthy();
  });
});
