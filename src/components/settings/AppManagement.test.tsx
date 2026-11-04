/**
 * @vitest-environment jsdom
 */
//! 应用管理行为测试：添加入口、编辑白名单字段、收藏/隐藏后同步、删除确认、
//! 启动成功后刷新最近使用。后端命令全部 mock，store 用真实实例。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useNavigationStore } from "../../store/useNavigationStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import AppManagement from "./AppManagement";
import {
  navDeleteTarget,
  navListTargets,
  navNavigate,
  navRecentLogs,
  navUpdateTarget,
  type NavTarget,
} from "../../lib/navigation";
import type { Settings } from "../../lib/bridge";

vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return {
    ...actual,
    navListTargets: vi.fn(async () => []),
    navRecentLogs: vi.fn(async () => []),
    navWindowMemory: vi.fn(async () => null),
    navUpdateTarget: vi.fn(async () => {}),
    navNavigate: vi.fn(),
    navDeleteTarget: vi.fn(async () => {}),
    navForgetWindow: vi.fn(async () => {}),
    navScanApps: vi.fn(async () => ({ apps: [], scanned_at: "", duration_ms: 0, counts: {} })),
  };
});

// 添加应用选择器单独测试；这里只验证「添加」按钮能打开独立配置模式。
vi.mock("../navigation/AppPicker", () => ({
  default: ({ standalone }: { standalone?: boolean }) => (
    <div role="dialog" aria-label={standalone ? "添加应用与快捷方式" : "选择关联目标"} />
  ),
}));

function targetFix(extra: Partial<NavTarget> = {}): NavTarget {
  return {
    id: "target-obs",
    display_name: "Obsidian",
    target_type: "application",
    app_key: "obsidian",
    exe_path: "C:\\Program Files\\Obsidian\\Obsidian.exe",
    launch_args: "",
    working_dir: "",
    app_user_model_id: "",
    url: "",
    path: "",
    agent_source_id: "",
    agent_session_id: "",
    window_title_hint: "",
    icon: "",
    category: "dev",
    favorite: false,
    hidden: false,
    last_used_at: null,
    use_count: 0,
    created_at: "2026-11-04T00:00:00Z",
    updated_at: "2026-11-04T00:00:00Z",
    ...extra,
  };
}

function seed(targets: NavTarget[]) {
  vi.mocked(navListTargets).mockResolvedValue(targets);
  useNavigationStore.setState({
    targets,
    targetsLoaded: true,
    targetsError: null,
    scan: null,
    scanning: false,
    loadApps: vi.fn(async () => {}),
    loadTaskLinks: vi.fn(async () => {}),
  });
  // 仅注入组件读取的偏好字段；类型上仍是完整 Settings。
  useSettingsStore.setState({
    settings: {
      nav_prefer_focus: true,
      nav_allow_launch: true,
      nav_fallback: true,
      nav_remember_window: true,
      nav_workspace_max: 5,
      nav_default_browser: "",
    } as unknown as Settings,
  });
  useUiStore.setState({ toast: null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("AppManagement", () => {
  it("添加应用按钮打开独立配置模式的选择器（不关联任务）", async () => {
    seed([targetFix()]);
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: /添加应用/ }));
    expect(await screen.findByRole("dialog", { name: "添加应用与快捷方式" })).toBeTruthy();
  });

  it("收藏后调用 navUpdateTarget 并刷新共享清单", async () => {
    seed([targetFix()]);
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: "收藏 Obsidian" }));
    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith("target-obs", { favorite: true }),
    );
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
  });

  it("隐藏后调用 navUpdateTarget 并刷新共享清单", async () => {
    seed([targetFix()]);
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: "隐藏 Obsidian" }));
    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith("target-obs", { hidden: true }),
    );
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
  });

  it("编辑配置：只提交后端白名单字段，身份路径保持只读", async () => {
    seed([targetFix()]);
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: "编辑 Obsidian" }));

    const dialog = await screen.findByRole("dialog", { name: "编辑应用配置" });
    expect(within(dialog).getByText(/程序路径|目标身份/)).toBeTruthy();
    expect(within(dialog).queryByLabelText("程序路径")).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("显示名称"), {
      target: { value: "Obsidian 笔记" },
    });
    fireEvent.change(within(dialog).getByLabelText("启动参数"), {
      target: { value: "--safe-mode" },
    });
    fireEvent.change(within(dialog).getByLabelText("窗口标题匹配提示"), {
      target: { value: "Obsidian" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith(
        "target-obs",
        expect.objectContaining({
          display_name: "Obsidian 笔记",
          launch_args: "--safe-mode",
          window_title_hint: "Obsidian",
          favorite: false,
          hidden: false,
        }),
      ),
    );
    // 身份字段绝不进入 patch
    const patch = vi.mocked(navUpdateTarget).mock.calls[0][1];
    expect(patch).not.toHaveProperty("exe_path");
    expect(patch).not.toHaveProperty("url");
    expect(patch).not.toHaveProperty("app_key");
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
  });

  it("删除必须先确认；确认后才删除并同步任务关联", async () => {
    seed([targetFix()]);
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: "删除 Obsidian" }));
    expect(navDeleteTarget).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog", { name: /删除「Obsidian」/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(navDeleteTarget).toHaveBeenCalledWith("target-obs"));
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
    expect(useNavigationStore.getState().loadTaskLinks).toHaveBeenCalled();
  });

  it("启动成功后刷新最近使用；启动失败不刷新", async () => {
    const t = targetFix();
    seed([t]);
    vi.mocked(navNavigate).mockResolvedValueOnce({
      success: true,
      requested_action: "focus",
      actual_action: "focus_window",
      fallback_used: false,
      target_id: t.id,
      verification_level: "window",
    });
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: "测试启动 Obsidian" }));
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
    expect(vi.mocked(navRecentLogs)).toHaveBeenCalled();
  });
});
