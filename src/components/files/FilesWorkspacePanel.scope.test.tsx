/**
 * @vitest-environment jsdom
 *
 * 全局/项目数据作用域 Phase 1：文件工作区页面内现场切换。
 *
 * 覆盖架构规范 §7.2 / §14 的验收点：
 * - 有当前项目默认进项目现场；未选项目默认全局现场且项目段不可用；
 * - 切到「全局文件」只换浏览现场，不清空项目选择、不改变顶栏项目；
 * - 全局现场下切换项目，全局现场原样保留（不重载、不串位）；
 * - 项目现场下切换项目，立即换成新项目现场（旧项目标签不外泄）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  fsCopyJobStart: vi.fn(),
  fsDragOut: vi.fn(async (_paths: string[]) => {}),
  fsMoveJobStart: vi.fn(),
  fsDeleteJobStart: vi.fn(),
  fsCopyPaths: vi.fn(),
  fsMovePaths: vi.fn(),
  fsDeletePaths: vi.fn(),
  fsDeleteVerifiedDuplicates: vi.fn(),
  fsPlaces: vi.fn(),
  fsStat: vi.fn(),
  fsJobs: vi.fn(async () => []),
  fsJobStatus: vi.fn(),
  fsJobReport: vi.fn(),
  fsJobCancel: vi.fn(),
  isFileJobTerminal: vi.fn(() => true),
  onRecycleJobProgress: vi.fn(async () => () => {}),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));
vi.mock("./FilePane", () => ({ default: () => <div data-testid="stub-pane" /> }));

import FilesWorkspacePanel from "./FilesWorkspacePanel";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import {
  FILE_WORKSPACE_SETTING_KEY,
  FILE_WORKSPACE_VERSION,
  GLOBAL_STATE_KEY,
} from "../../lib/filesWorkspace/persist";
import { cancelFwDrag, clearFwClipboard } from "../../lib/filesWorkspace/interactions";
import type { WorkspaceProject } from "../../lib/contracts/models";

const PROJECT_A: WorkspaceProject = {
  id: "p1",
  name: "项目A",
  kind: "general",
  status: "active",
  rootPath: "D:\\proj-a",
  rootExists: true,
  devProjectId: null,
  devProjectExists: false,
  devProjectName: null,
  note: "",
  itemCount: 0,
  taskLinkCount: 0,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};

const PROJECT_B: WorkspaceProject = {
  ...PROJECT_A,
  id: "p2",
  name: "项目B",
  rootPath: "D:\\proj-b",
};

const GLOBAL_PATH = "D:\\global-view";
const PATH_A = "D:\\proj-a\\only";
const PATH_B = "D:\\proj-b\\only";

function stateWith(path: string) {
  return {
    tree: { type: "pane", paneId: "pane-1" },
    panes: [
      {
        paneId: "pane-1",
        tabs: [{ tabId: "tab-1", path }],
        activeTabId: "tab-1",
      },
    ],
    activePaneId: "pane-1",
  };
}

function seedStates(states: Record<string, string>): void {
  const byKey: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(states)) byKey[key] = stateWith(path);
  useSettingsStore.setState({
    settings: {
      [FILE_WORKSPACE_SETTING_KEY]: {
        version: FILE_WORKSPACE_VERSION,
        states: byKey,
        templates: [],
        recentTemplates: [],
      },
    } as never,
  });
}

function activePath(): string | undefined {
  const s = useFilesWorkspaceStore.getState();
  const pane = s.panes[s.activePaneId];
  return pane?.tabs.find((tab) => tab.tabId === pane.activeTabId)?.path;
}

async function renderAndSettle(project: WorkspaceProject | null) {
  const view = render(<FilesWorkspacePanel project={project} />);
  await waitFor(() => expect(useFilesWorkspaceStore.getState().hydrated).toBe(true));
  return view;
}

function scopeButton(kind: "project" | "global"): HTMLElement {
  return screen.getByRole("tab", { name: new RegExp(`fw.scope.${kind}`) });
}

beforeEach(() => {
  Object.values(bridgeMocks).forEach((fn) => vi.mocked(fn).mockClear());
  bridgeMocks.fsPlaces.mockResolvedValue([]);
  bridgeMocks.fsStat.mockResolvedValue([]);
  clearFwClipboard();
  // store 是模块级单例：显式回到未 hydrate 状态，避免上一用例的现场冒充现场。
  useFilesWorkspaceStore.setState({ hydrated: false, stateKey: GLOBAL_STATE_KEY });
});

afterEach(() => {
  cancelFwDrag();
  clearFwClipboard();
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("文件工作区现场作用域", () => {
  it("有当前项目时默认进项目现场，读取 project:<id>", async () => {
    seedStates({ "project:p1": PATH_A, [GLOBAL_STATE_KEY]: GLOBAL_PATH });
    await renderAndSettle(PROJECT_A);

    expect(useFilesWorkspaceStore.getState().stateKey).toBe("project:p1");
    expect(activePath()).toBe(PATH_A);
    expect(scopeButton("project").getAttribute("aria-selected")).toBe("true");
    expect(scopeButton("global").getAttribute("aria-selected")).toBe("false");
  });

  it("切到全局文件：换现场但不清空项目选择", async () => {
    seedStates({ "project:p1": PATH_A, [GLOBAL_STATE_KEY]: GLOBAL_PATH });
    await renderAndSettle(PROJECT_A);

    fireEvent.click(scopeButton("global"));
    await waitFor(() => expect(useFilesWorkspaceStore.getState().stateKey).toBe(GLOBAL_STATE_KEY));

    expect(activePath()).toBe(GLOBAL_PATH);
    expect(scopeButton("global").getAttribute("aria-selected")).toBe("true");
    // 顶栏项目仍是A：作用域切换不碰全局项目选择。
    const projectTab = scopeButton("project");
    expect(projectTab.textContent).toContain("项目A");
    expect((projectTab as HTMLButtonElement).disabled).toBe(false);
  });

  it("全局现场下切换项目：全局现场原样保留，不重载成新项目", async () => {
    seedStates({ "project:p1": PATH_A, "project:p2": PATH_B, [GLOBAL_STATE_KEY]: GLOBAL_PATH });
    const view = await renderAndSettle(PROJECT_A);

    fireEvent.click(scopeButton("global"));
    await waitFor(() => expect(useFilesWorkspaceStore.getState().stateKey).toBe(GLOBAL_STATE_KEY));
    expect(activePath()).toBe(GLOBAL_PATH);

    view.rerender(<FilesWorkspacePanel project={PROJECT_B} />);
    await waitFor(() => expect(useFilesWorkspaceStore.getState().hydrated).toBe(true));

    expect(useFilesWorkspaceStore.getState().stateKey).toBe(GLOBAL_STATE_KEY);
    expect(activePath()).toBe(GLOBAL_PATH);
  });

  it("项目现场下切换项目：立即换成新项目现场，旧标签不外泄", async () => {
    seedStates({ "project:p1": PATH_A, "project:p2": PATH_B, [GLOBAL_STATE_KEY]: GLOBAL_PATH });
    const view = await renderAndSettle(PROJECT_A);
    expect(activePath()).toBe(PATH_A);

    view.rerender(<FilesWorkspacePanel project={PROJECT_B} />);

    await waitFor(() => expect(useFilesWorkspaceStore.getState().stateKey).toBe("project:p2"));
    expect(activePath()).toBe(PATH_B);
  });

  it("未选择项目：默认全局现场，项目段不可切换", async () => {
    seedStates({ [GLOBAL_STATE_KEY]: GLOBAL_PATH });
    await renderAndSettle(null);

    expect(useFilesWorkspaceStore.getState().stateKey).toBe(GLOBAL_STATE_KEY);
    expect(activePath()).toBe(GLOBAL_PATH);
    expect((scopeButton("project") as HTMLButtonElement).disabled).toBe(true);
  });
});
