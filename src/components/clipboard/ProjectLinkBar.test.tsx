/**
 * @vitest-environment jsdom
 *
 * 数据作用域 Phase 2：条目/分组详情里「关联项目」的显式操作。
 * 覆盖：已关联项目以可取消的 chip 呈现；取消关联只删关系、不删除内容；
 * 项目列表为空时给出可执行的说明，而不是静默隐藏。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  workspaceProjectList: vi.fn(),
  clipboardProjectLinks: vi.fn(),
  clipboardLinkProject: vi.fn(),
  clipboardUnlinkProject: vi.fn(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);

import ProjectLinkBar from "./ProjectLinkBar";
import { useUiStore } from "../../store/useUiStore";
import type { ClipboardProjectLink, WorkspaceProject } from "../../lib/bridge";

const PROJECT_A = { id: "p-a", name: "项目A" } as WorkspaceProject;
const PROJECT_B = { id: "p-b", name: "项目B" } as WorkspaceProject;

function link(projectId: string): ClipboardProjectLink {
  return { projectId, targetType: "item", targetId: "i1", createdAt: "2026-11-23T00:00:00Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMocks.workspaceProjectList.mockResolvedValue({ projects: [PROJECT_A, PROJECT_B] });
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  cleanup();
});

describe("ProjectLinkBar", () => {
  it("已关联项目渲染为 chip，取消关联只删关系并刷新", async () => {
    bridgeMocks.clipboardProjectLinks
      .mockResolvedValueOnce([link("p-a"), link("p-b")])
      .mockResolvedValue([link("p-b")]);
    bridgeMocks.clipboardUnlinkProject.mockResolvedValue(undefined);

    render(<ProjectLinkBar targetType="item" targetId="i1" />);

    await waitFor(() => expect(screen.getByText("项目A")).toBeTruthy());
    expect(screen.getByText("项目B")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("取消关联项目「项目A」"));

    await waitFor(() =>
      expect(bridgeMocks.clipboardUnlinkProject).toHaveBeenCalledWith("p-a", "item", "i1"),
    );
    await waitFor(() => expect(screen.queryByText("项目A")).toBeNull());
    expect(screen.getByText("项目B")).toBeTruthy();
    expect(useUiStore.getState().toast?.message).toContain("剪贴板内容仍保留");
  });

  it("全部项目都已关联时给出说明，不重复展示关联入口", async () => {
    bridgeMocks.clipboardProjectLinks.mockResolvedValue([link("p-a"), link("p-b")]);

    render(<ProjectLinkBar targetType="group" targetId="g1" />);

    await waitFor(() => expect(screen.getByText("已关联全部可用项目。")).toBeTruthy());
    expect(screen.queryByText("关联")).toBeNull();
  });

  it("没有项目时提示先创建项目根", async () => {
    bridgeMocks.workspaceProjectList.mockResolvedValue({ projects: [] });
    bridgeMocks.clipboardProjectLinks.mockResolvedValue([]);

    render(<ProjectLinkBar targetType="item" targetId="i1" />);

    await waitFor(() => expect(screen.getByText(/还没有项目/)).toBeTruthy());
  });
});
