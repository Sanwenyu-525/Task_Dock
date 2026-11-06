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
  scenarioGet: vi.fn(),
  scenarioList: vi.fn(),
  scenarioSave: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfGetItem: vi.fn(),
  shelfList: vi.fn(),
  workflowList: vi.fn(),
  workspaceList: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  onWorkflowRunProgress: (...args: unknown[]) => bridge.onWorkflowRunProgress(...args),
  onWorkspaceRestoreProgress: (...args: unknown[]) => bridge.onWorkspaceRestoreProgress(...args),
  scenarioDelete: (...args: unknown[]) => bridge.scenarioDelete(...args),
  scenarioDuplicate: (...args: unknown[]) => bridge.scenarioDuplicate(...args),
  scenarioEnter: (...args: unknown[]) => bridge.scenarioEnter(...args),
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
    enteringId: null, editing: null, results: {}, progressByItem: {},
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
