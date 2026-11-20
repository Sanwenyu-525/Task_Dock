/**
 * @vitest-environment jsdom
 *
 * R13 Agent B：布局模板快捷入口（文件/回收站切换右侧）。
 * - 无模板时整块不渲染；
 * - 最近使用优先、过滤已删除、最多 2 个快捷按钮，其余模板进紧凑菜单；
 * - 点击快捷模板复用现有应用前确认，确认后才调用 applyTemplate；
 * - persist-failed 必须显示失败而不是成功。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";

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
  useLocale: () => ({
    // 保留 key 便于断言文案来源，同时把插值变量拼进结果（身份 mock 会丢失 {error}）。
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    locale: "zh-CN",
  }),
}));
vi.mock("./FilePane", () => ({ default: () => <div data-testid="stub-pane" /> }));

import FilesWorkspacePanel from "./FilesWorkspacePanel";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import { useUiStore } from "../../store/useUiStore";
import { FILE_WORKSPACE_SETTING_KEY } from "../../lib/filesWorkspace/persist";
import { cancelFwDrag, clearFwClipboard } from "../../lib/filesWorkspace/interactions";

const DIR = "D:\\templates";

/** 取 @container 规则块（按花括号层级配对），用于窄窗收纳契约检查。 */
function containerBlock(header: string): string {
  const css = readFileSync("src/components/files/files.css", "utf8");
  const start = css.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unclosed container block: ${header}`);
}

type TemplateSeed = { id: string; name: string };

function templateOf(id: string, name: string) {
  return {
    id,
    name,
    tree: { type: "pane", paneId: "pane-1" },
    panes: [{ paneId: "pane-1", tabs: [{ tabId: `${id}-tab`, path: DIR }], activeTabId: `${id}-tab` }],
  };
}

function seed(templates: TemplateSeed[], recentTemplates: string[]): void {
  useSettingsStore.setState({
    settings: {
      [FILE_WORKSPACE_SETTING_KEY]: {
        version: 1,
        states: {
          global: {
            tree: { type: "pane", paneId: "pane-1" },
            panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: DIR }], activeTabId: "t1" }],
            activePaneId: "pane-1",
          },
        },
        templates: templates.map((tpl) => templateOf(tpl.id, tpl.name)),
        recentTemplates,
      },
    } as never,
  });
}

async function mountPanel(): Promise<void> {
  render(<FilesWorkspacePanel project={null} />);
  await waitFor(() => expect(useFilesWorkspaceStore.getState().hydrated).toBe(true));
}

beforeEach(() => {
  Object.values(bridgeMocks).forEach((fn) => vi.mocked(fn).mockClear());
  bridgeMocks.fsPlaces.mockResolvedValue([]);
  bridgeMocks.fsStat.mockResolvedValue([]);
  useUiStore.setState({ toasts: [], toast: null });
  clearFwClipboard();
});

afterEach(() => {
  cancelFwDrag();
  clearFwClipboard();
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("布局模板快捷入口", () => {
  it("没有模板时整块入口不渲染（无空白占位）", async () => {
    seed([], []);
    await mountPanel();
    expect(screen.queryByRole("group", { name: "fw.toolbar.templates" })).toBeNull();
  });

  it("最近使用优先、过滤已删除模板、最多 2 个按钮，其余进菜单", async () => {
    seed(
      [
        { id: "t1", name: "Alpha" },
        { id: "t2", name: "Beta" },
        { id: "t3", name: "Gamma" },
      ],
      ["gone", "t2"],
    );
    await mountPanel();

    const group = screen.getByRole("group", { name: "fw.toolbar.templates" });
    expect(group).toBeTruthy();
    // quick：Beta（最近使用）→ Alpha（按模板顺序补齐）；已删除的 gone 不参与。
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
    // Gamma 不占快捷按钮，只出现在「其余模板」菜单触发器的菜单里。
    expect(screen.queryByRole("button", { name: "Gamma" })).toBeNull();
    // 其余模板菜单触发器存在（宽栏箭头 + 窄栏图标各一个）。
    expect(screen.getAllByLabelText("fw.toolbar.templates").length).toBeGreaterThanOrEqual(2);
  });

  it("点击快捷模板先走现有确认，确认后才调用 applyTemplate", async () => {
    seed([{ id: "t1", name: "Alpha" }], ["t1"]);
    await mountPanel();

    const applySpy = vi
      .spyOn(useFilesWorkspaceStore.getState(), "applyTemplate")
      .mockResolvedValue({ ok: true, templateId: "t1" } as never);
    vi.spyOn(useFilesWorkspaceStore.getState(), "persistNow").mockResolvedValue();

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    // 复用现有应用前确认对话框：此时尚未应用。
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("fw.template.applyTitle");
    expect(applySpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "fw.template.applyConfirm" }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy.mock.calls[0][0]).toBe("t1");
  });

  it("窄窗 980px 收纳为单个「模板」图标菜单（回收站入口不受影响）", () => {
    const block = containerBlock("@container fw-page (max-width: 980px)");
    expect(block).toContain(".fw-quick-template,");
    expect(block).toContain(".fw-quick-template-more");
    expect(block).toContain(".fw-quick-template-compact");
    expect(block).toMatch(/\.fw-quick-template-compact\s*\{\s*display: inline-flex;/);
    // 收纳只作用于模板快捷入口，文件/回收站切换按钮不在该容器查询内。
    expect(block).not.toContain(".fw-source-btn");
  });

  it("persist-failed 提示已应用但未保存，绝不显示成功", async () => {
    seed([{ id: "t1", name: "Alpha" }], ["t1"]);
    await mountPanel();

    vi.spyOn(useFilesWorkspaceStore.getState(), "applyTemplate").mockResolvedValue({
      ok: false,
      reason: "persist-failed",
      error: "disk full",
    } as never);

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "fw.template.applyConfirm" }));

    // 面板持有的 showToast 引用在挂载时捕获，直接断言真实 store 的 toast 记录。
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((toast) => toast.kind === "error")).toBe(true),
    );
    const errorToast = useUiStore.getState().toasts.filter((toast) => toast.kind === "error").at(-1)!;
    expect(errorToast.message).toContain("已应用模板");
    expect(errorToast.message).toContain("disk full");
    expect(useUiStore.getState().toasts.some((toast) => toast.message === "fw.template.applied")).toBe(
      false,
    );
  });
});
