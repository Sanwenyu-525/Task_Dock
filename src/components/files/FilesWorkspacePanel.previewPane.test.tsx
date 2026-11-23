/**
 * @vitest-environment jsdom
 *
 * 文件工作区 × 右侧检查器联动：
 * - 工具栏按钮与 Alt+P 同一开关语义；
 * - 活动窗格发布选择 → 检查器显示目标；多选 → 统计；非活动窗格晚到 → 忽略；
 * - 关闭检查器卸载内容；
 * - 预览弹窗打开期间挂起侧栏内容（不创建第二份播放器/文档）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FsEntry } from "../../lib/bridge";

const previewMock = vi.hoisted(() => ({
  snapshot: null as unknown,
}));

const bridgeMocks = vi.hoisted(() => ({
  fsReadText: vi.fn(),
  fsReadBinary: vi.fn(),
  fsPreviewImage: vi.fn(),
  fsPreviewMediaUrl: vi.fn(),
  fsReleasePreviewUrl: vi.fn(),
  fsOpen: vi.fn(async () => undefined),
  fsReveal: vi.fn(async () => undefined),
  fsStat: vi.fn(),
  fsPlaces: vi.fn(async () => []),
  fsJobs: vi.fn(async () => []),
  fsJobStatus: vi.fn(),
  fsJobReport: vi.fn(),
  shelfAddPaths: vi.fn(async () => ({ added: [], skipped: [], failed: [] })),
  onRecycleJobProgress: vi.fn(async () => () => {}),
  isFileJobTerminal: vi.fn(() => true),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));
// FilePane 懒加载：联动测试只关心「选择变化如何进入检查器」。
vi.mock("./FilePane", () => ({
  default: (props: {
    paneId: string;
    onPreviewSelectionChange?: (snapshot: unknown) => void;
  }) => (
    <div data-testid={`stub-pane-${props.paneId}`}>
      <button
        type="button"
        data-testid={`publish-${props.paneId}`}
        onClick={() =>
          props.onPreviewSelectionChange?.({
            ...(previewMock.snapshot as Record<string, unknown>),
            paneId: props.paneId,
          })
        }
      >
        publish
      </button>
    </div>
  ),
}));

import FilesWorkspacePanel from "./FilesWorkspacePanel";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { FILE_WORKSPACE_SETTING_KEY } from "../../lib/filesWorkspace/persist";
import type { FilePreviewTarget, PreviewSelectionSummary } from "../../lib/filesWorkspace/previewSelection";

const DIR = "D:\\demo";
const PATH = "D:\\demo\\a.ts";

const entry: FsEntry = {
  name: "a.ts",
  kind: "file",
  ext: "ts",
  size: 12,
  modifiedMs: 1_700_000_000_000,
  hidden: false,
  category: "code",
};

const target: FilePreviewTarget = { paneId: "pane-1", path: PATH, dir: DIR, name: "a.ts", size: 12, entry };
const singleSummary: PreviewSelectionSummary = { count: 1, files: 1, dirs: 0, bytes: 12, folder: null };
const multiSummary: PreviewSelectionSummary = { count: 2, files: 2, dirs: 0, bytes: 24, folder: null };

const SPLIT_TREE = {
  type: "split" as const,
  id: "split-1",
  direction: "horizontal" as const,
  ratio: 0.5,
  first: { type: "pane" as const, paneId: "pane-1" },
  second: { type: "pane" as const, paneId: "pane-2" },
};

function seed(): void {
  useSettingsStore.setState({
    settings: {
      [FILE_WORKSPACE_SETTING_KEY]: {
        version: 1,
        states: {
          global: {
            tree: SPLIT_TREE,
            panes: [
              { paneId: "pane-1", tabs: [{ tabId: "t1", path: DIR }], activeTabId: "t1" },
              { paneId: "pane-2", tabs: [{ tabId: "t2", path: DIR }], activeTabId: "t2" },
            ],
            activePaneId: "pane-1",
            previewPane: { open: false, width: 360 },
          },
        },
        templates: [],
        recentTemplates: [],
      },
    },
  } as never);
}

function publish(snapshot: { target: FilePreviewTarget | null; summary: PreviewSelectionSummary }, paneId = "pane-1") {
  previewMock.snapshot = { dir: DIR, ...snapshot };
  fireEvent.click(screen.getByTestId(`publish-${paneId}`));
}

beforeEach(() => {
  previewMock.snapshot = null;
  bridgeMocks.fsReadText.mockReset().mockResolvedValue({
    path: PATH,
    size: 12,
    truncated: false,
    encoding: "UTF-8",
    content: "const a = 1;",
  });
  bridgeMocks.fsStat.mockReset().mockResolvedValue([]);
  seed();
  useFilesWorkspaceStore.setState({ previewPaneOpen: false, previewPaneWidth: 360, hydrated: false });
});

afterEach(() => {
  cleanup();
});

describe("检查器开关", () => {
  it("工具栏按钮打开 → 显示检查器；再次点击关闭并卸载内容", async () => {
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(screen.getByText("fw.inspector.toggle")).toBeTruthy());

    fireEvent.click(screen.getByText("fw.inspector.toggle"));
    expect(useFilesWorkspaceStore.getState().previewPaneOpen).toBe(true);
    expect(screen.getByLabelText("fw.inspector.aria")).toBeTruthy();
    expect(screen.getByText("fw.inspector.empty")).toBeTruthy();

    fireEvent.click(screen.getByText("fw.inspector.toggle"));
    expect(useFilesWorkspaceStore.getState().previewPaneOpen).toBe(false);
    expect(screen.queryByLabelText("fw.inspector.aria")).toBeNull();
  });

  it("Alt+P 与按钮同一动作", async () => {
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(screen.getByText("fw.inspector.toggle")).toBeTruthy());

    fireEvent.keyDown(window, { key: "p", altKey: true });
    expect(useFilesWorkspaceStore.getState().previewPaneOpen).toBe(true);
    fireEvent.keyDown(window, { key: "p", altKey: true });
    expect(useFilesWorkspaceStore.getState().previewPaneOpen).toBe(false);
  });

  it("关闭按钮写入 store（面板因此卸载）", async () => {
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(screen.getByText("fw.inspector.toggle")).toBeTruthy());
    fireEvent.click(screen.getByText("fw.inspector.toggle"));
    fireEvent.click(screen.getByLabelText("fw.inspector.close"));
    expect(useFilesWorkspaceStore.getState().previewPaneOpen).toBe(false);
    expect(screen.queryByLabelText("fw.inspector.aria")).toBeNull();
  });
});

describe("选择联动", () => {
  it("活动窗格单选 → 检查器显示该文件并读取一次内容", async () => {
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(screen.getByText("fw.inspector.toggle")).toBeTruthy());
    fireEvent.click(screen.getByText("fw.inspector.toggle"));

    publish({ target, summary: singleSummary });
    await waitFor(() => expect(document.querySelector(".fw-preview-code")?.textContent).toContain("a = 1;"));
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
  });

  it("多选显示统计，不显示第一个文件", async () => {
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(screen.getByText("fw.inspector.toggle")).toBeTruthy());
    fireEvent.click(screen.getByText("fw.inspector.toggle"));

    publish({ target: null, summary: multiSummary });
    expect(screen.getByText(/fw\.inspector\.multiTitle/)).toBeTruthy();
    expect(document.querySelector(".fw-preview-code")).toBeNull();
    expect(bridgeMocks.fsReadText).not.toHaveBeenCalled();
  });

  it("非活动窗格的晚到选择被忽略，不覆盖当前目标", async () => {
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(screen.getByText("fw.inspector.toggle")).toBeTruthy());
    fireEvent.click(screen.getByText("fw.inspector.toggle"));

    publish({ target, summary: singleSummary }, "pane-1");
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());

    // pane-2 不是活动窗格：它上报的目标不得覆盖 pane-1 的选择。
    publish({ target: { ...target, paneId: "pane-2", name: "b.ts", path: "D:\\demo\\b.ts" }, summary: singleSummary }, "pane-2");
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.queryByText("b.ts")).toBeNull();
  });
});

describe("与快速预览弹窗互斥", () => {
  it("弹窗打开时侧栏挂起，不创建第二份预览内容", async () => {
    render(<FilesWorkspacePanel project={null} />);
    await waitFor(() => expect(screen.getByText("fw.inspector.toggle")).toBeTruthy());
    fireEvent.click(screen.getByText("fw.inspector.toggle"));
    publish({ target, summary: singleSummary });
    await waitFor(() => expect(document.querySelector(".fw-preview-code")?.textContent).toContain("a = 1;"));
    bridgeMocks.fsReadText.mockClear();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("taskdock-fw-preview", {
          detail: { paneId: "pane-1", path: PATH, dir: DIR, entries: [entry] },
        }),
      );
    });

    await waitFor(() => expect(screen.getByText("fw.inspector.suspended")).toBeTruthy());
    // 侧栏内容已卸载；读取由弹窗自己发起，不会出现两份内容。
    expect(document.querySelectorAll(".fw-preview-text")).toHaveLength(1);
  });
});
