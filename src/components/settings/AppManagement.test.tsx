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
    loadApps: vi.fn(async () => "ok" as const),
    loadTaskLinks: vi.fn(async () => "ok" as const),
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

  it("编辑配置：页内表单（无弹窗），只提交后端白名单字段，身份路径保持只读", async () => {
    seed([targetFix()]);
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: "编辑 Obsidian" }));

    const form = await screen.findByRole("region", { name: "编辑应用配置" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(form).getByText(/目标身份/)).toBeTruthy();
    expect(within(form).getByText(targetFix().exe_path)).toBeTruthy();
    expect(within(form).queryByLabelText("程序路径")).toBeNull();

    fireEvent.change(within(form).getByLabelText("显示名称"), {
      target: { value: "Obsidian 笔记" },
    });
    fireEvent.change(within(form).getByLabelText("启动参数"), {
      target: { value: "--safe-mode" },
    });
    fireEvent.change(within(form).getByLabelText("窗口标题匹配提示"), {
      target: { value: "Obsidian" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));

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
    // 保存后刷新共享清单：应用中心/胶囊/设置三处读同一份 store
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("region", { name: "编辑应用配置" })).toBeNull();
  });

  it("有未保存更改时切换目标或添加应用需先确认，不静默丢弃输入", async () => {
    seed([
      targetFix(),
      targetFix({ id: "target-code", app_key: "code", display_name: "VS Code" }),
    ]);
    render(<AppManagement />);
    fireEvent.click(screen.getByRole("button", { name: "编辑 Obsidian" }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "改名后" } });

    // 切换到另一个目标：先弹放弃确认，未确认前仍是当前表单
    fireEvent.click(screen.getByRole("button", { name: "编辑 VS Code" }));
    const dialog = await screen.findByRole("dialog", { name: /放弃未保存的更改/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("显示名称")).toBeTruthy();
    expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("改名后");

    // 进入添加页同样被拦下，直到明确放弃
    fireEvent.click(screen.getByRole("button", { name: /添加应用/ }));
    const addDialog = await screen.findByRole("dialog", { name: /放弃未保存的更改/ });
    fireEvent.click(within(addDialog).getByRole("button", { name: "放弃更改" }));
    expect(await screen.findByRole("dialog", { name: "添加应用与快捷方式" })).toBeTruthy();
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

  it("最近导航记录将技术动作转为中文，原始标识保留在诊断属性中", async () => {
    seed([targetFix()]);
    vi.mocked(navRecentLogs).mockResolvedValue([
      {
        id: "log-focus",
        target_id: "target-obs",
        target_name: "Obsidian",
        requested_action: "focus",
        actual_action: "focus_window",
        success: true,
        fallback_used: false,
        reason: "",
        verification_level: "window",
        created_at: "2026-11-04T10:20:00Z",
      },
      {
        id: "log-open",
        target_id: "target-obs",
        target_name: "Obsidian",
        requested_action: "open",
        actual_action: "open_app",
        success: true,
        fallback_used: false,
        reason: "",
        verification_level: "process",
        created_at: "2026-11-04T10:21:00Z",
      },
    ]);

    render(<AppManagement />);
    const focusAction = await screen.findByText("聚焦窗口");
    expect(focusAction.getAttribute("data-action")).toBe("focus_window");
    expect(focusAction.getAttribute("title")).toBe("focus_window");

    const openAction = screen.getByText("启动应用");
    expect(openAction.getAttribute("data-action")).toBe("open_app");
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

describe("AppManagement 刷新结果语义", () => {
  type Outcome = "ok" | "stale" | "cancelled" | "error";

  function seedRefresh(
    targetsOutcome: Outcome,
    scanOutcome: Outcome,
    errors?: { targets?: string; scan?: string },
  ) {
    seed([targetFix()]);
    useNavigationStore.setState({
      targetsError: errors?.targets ?? null,
      scanError: errors?.scan ?? null,
      loadTargets: vi.fn(async () => targetsOutcome),
      loadApps: vi.fn(async () => scanOutcome),
    });
  }

  async function clickRescan() {
    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(useUiStore.getState().toast).not.toBeNull());
    return useUiStore.getState().toast!;
  }

  it("ok + ok：可以提示整体刷新完成", async () => {
    seedRefresh("ok", "ok");
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).toBe("success");
    expect(toast.message).toContain("应用清单已刷新");
  });

  it("ok + stale：不得提示全部刷新完成（扫描由其他入口负责）", async () => {
    seedRefresh("ok", "stale");
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).not.toBe("success");
    expect(toast.message).toContain("扫描由其他入口");
    expect(toast.message).not.toContain("应用清单已刷新");
  });

  it("stale + ok：不宣称两项均由本次完成", async () => {
    seedRefresh("stale", "ok");
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).not.toBe("success");
    expect(toast.message).toContain("应用清单由其他刷新更新");
  });

  it("stale + stale：只给一次非成功说明，不重复成功提示", async () => {
    seedRefresh("stale", "stale");
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).toBe("info");
    expect(toast.message).toContain("应用清单由其他刷新更新");
    expect(toast.message).toContain("扫描由其他入口");
  });

  it("ok + cancelled：不得提示扫描成功", async () => {
    seedRefresh("ok", "cancelled");
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).toBe("info");
    expect(toast.message).toContain("扫描已取消");
    expect(toast.message).not.toContain("已刷新");
  });

  it("error + ok：明确目标列表刷新失败", async () => {
    seedRefresh("error", "ok", { targets: "读取被拒绝" });
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).toBe("warning");
    expect(toast.message).toContain("刷新部分失败");
    expect(toast.message).toContain("应用清单：读取被拒绝");
    expect(toast.message).not.toContain("应用扫描：");
  });

  it("ok + error：明确扫描失败", async () => {
    seedRefresh("ok", "error", { scan: "开始菜单不可读" });
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).toBe("warning");
    expect(toast.message).toContain("应用扫描：开始菜单不可读");
    expect(toast.message).not.toContain("应用清单：");
  });

  it("error + error：展示合并后的真实失败信息", async () => {
    seedRefresh("error", "error", { targets: "清单错误", scan: "扫描错误" });
    render(<AppManagement />);
    const toast = await clickRescan();
    expect(toast.kind).toBe("warning");
    expect(toast.message).toContain("应用清单：清单错误");
    expect(toast.message).toContain("应用扫描：扫描错误");
  });

  it("定向重试：仅重试失败的扫描，不重复刷新已成功的目标清单", async () => {
    seedRefresh("ok", "error", { scan: "扫描错误" });
    render(<AppManagement />);
    const toast = await clickRescan();
    const loadApps = useNavigationStore.getState().loadApps as unknown as {
      mock: { calls: unknown[][] };
    };
    const loadTargets = useNavigationStore.getState().loadTargets as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(loadApps.mock.calls).toHaveLength(1);
    expect(loadTargets.mock.calls).toHaveLength(1);

    // 重试只执行扫描，不再请求已成功的目标清单
    toast.action?.run();
    await waitFor(() => expect(loadApps.mock.calls).toHaveLength(2));
    expect(loadTargets.mock.calls).toHaveLength(1);
  });
});
