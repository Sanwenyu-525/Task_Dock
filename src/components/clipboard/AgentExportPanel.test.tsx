/**
 * @vitest-environment jsdom
 */
//! Agent 入口：只展示可核验能力，本地导出与桌面粘贴必须明确区分。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardAgentTargets: vi.fn(),
  clipboardExportForAgent: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import AgentExportPanel from "./AgentExportPanel";
import type { AgentClipboardTarget, ExportPackage } from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";

const TARGET: AgentClipboardTarget = {
  source_id: "agent-1",
  display_name: "示例 Agent",
  installed: true,
  window_present: true,
  evidence: "window-present",
  note: "检测到运行中的窗口。",
  direct_send: {
    supported: false,
    evidence: "unsupported-interface",
    note: "当前没有经过验证的结构化发送接口，不会自动上传或发送。",
  },
  file_import: { supported: false, evidence: "unverified", note: "文件导入未验证。" },
  desktop_paste: {
    supported: true,
    evidence: "window-present",
    note: "需用户手动触发桌面粘贴，只代表按键动作已发送。",
  },
  export: { supported: true, evidence: "local-export", note: "本地导出始终可用。" },
  recommended: "paste",
};

const PKG: ExportPackage = {
  dir: "C:\\Users\\me\\AppData\\Local\\TaskDock\\agent-exports\\pkg-1",
  markdown_path: "C:\\Users\\me\\AppData\\Local\\TaskDock\\agent-exports\\pkg-1\\clipboard.md",
  manifest_path: "C:\\Users\\me\\AppData\\Local\\TaskDock\\agent-exports\\pkg-1\\manifest.json",
  files: ["clipboard.md", "manifest.json"],
  item_count: 3,
  summary: "已导出 3 项（图片 1 张）",
  warnings: [],
};

let toastSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  bridge.clipboardAgentTargets.mockResolvedValue([TARGET]);
  bridge.clipboardExportForAgent.mockResolvedValue(PKG);
  toastSpy = vi.fn();
  useUiStore.setState({ toast: null, showToast: toastSpy as never });
});

afterEach(() => {
  cleanup();
});

describe("AgentExportPanel", () => {
  it("区分直接发送、文件导入、桌面粘贴与本地导出", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    fireEvent.click(screen.getByRole("button", { name: /导出给 Agent/ }));

    expect(await screen.findByText(/直接发送：不支持/)).toBeTruthy();
    expect(screen.getByText(/文件导入：未验证/)).toBeTruthy();
    expect(screen.getByText(/桌面粘贴：可手动触发/)).toBeTruthy();
    expect(screen.getByText(/本地导出：可用/)).toBeTruthy();
    expect(screen.getAllByText(/不会自动上传或发送/).length).toBeGreaterThan(0);
  });

  it("导出只生成本地文件包，并明确提示未发送", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" taskId="task-9" />);
    fireEvent.click(screen.getByRole("button", { name: /导出给 Agent/ }));
    await screen.findByText(/直接发送：不支持/);

    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));
    await waitFor(() =>
      expect(bridge.clipboardExportForAgent).toHaveBeenCalledWith("group", "g1", "task-9"),
    );
    expect(await screen.findByText(PKG.dir)).toBeTruthy();
    expect(screen.getByText(/已导出 3 项/)).toBeTruthy();
    expect(toastSpy).toHaveBeenCalledWith(
      "已导出 3 项到本地文件（未发送）",
      expect.objectContaining({ kind: "success" }),
    );
  });
});
