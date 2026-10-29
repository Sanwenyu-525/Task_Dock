/**
 * @vitest-environment jsdom
 */
//! AppPicker 真实 DOM 交互测试：应用列表渲染 / 搜索与分类过滤、关联链路
//! （navSaveTarget → navLinkTask → onClose）、「从当前运行的窗口选择」的窗口身份
//! 固化（navPickWindowIdentity）、busyKey 防重复与失败反馈。
//!
//! Tauri bridge 全部 mock：`../../lib/navigation` 中 invoke 系函数替换为 vi.fn，
//! 纯函数（分类文案 / 头像色等）保留原实现；zustand store 用真实实例 + setState 注入，
//! toast 通过挂在树内的探针组件读取 useUiStore 断言"可见"。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useNavigationStore } from "../../store/useNavigationStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import AppPicker from "./AppPicker";
import {
  navLinkTask,
  navListWindows,
  navListTargets,
  navPickWindowIdentity,
  navPickTaskWindow,
  navLinkTaskWindow,
  navSaveTarget,
  type DiscoveredApp,
  type NavTarget,
  type TaskNavLink,
  type WindowInfo,
} from "../../lib/navigation";

vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return {
    ...actual,
    navScanApps: vi.fn(async () => ({ apps: [], scanned_at: "", duration_ms: 0, counts: {} })),
    navListTargets: vi.fn(async () => []),
    navAllTaskLinks: vi.fn(async () => []),
    navListWindows: vi.fn(async () => [] as WindowInfo[]),
    navSaveTarget: vi.fn(),
    navLinkTask: vi.fn(async () => "link-id"),
    navSaveAgentSessionTarget: vi.fn(),
    navPickWindowIdentity: vi.fn(),
    navPickTaskWindow: vi.fn(async () => {}),
    navLinkTaskWindow: vi.fn(async () => "link-id"),
  };
});

// ── 测试数据 ─────────────────────────────────────────────────

function appFix(p: Partial<DiscoveredApp> & Pick<DiscoveredApp, "app_key" | "display_name" | "category">): DiscoveredApp {
  return {
    exe_path: `C:\\Program Files\\${p.app_key}\\${p.app_key}.exe`,
    launch_args: "",
    working_dir: "",
    app_user_model_id: "",
    window_title_hint: "",
    source: "startmenu",
    ...p,
  };
}

function targetFix(id: string, display_name: string, app_key: string): NavTarget {
  return {
    id,
    display_name,
    target_type: "application",
    app_key,
    exe_path: `C:\\Program Files\\${app_key}\\${app_key}.exe`,
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
    created_at: "2026-10-26T00:00:00Z",
    updated_at: "2026-10-26T00:00:00Z",
  };
}

function linkFix(id: string, target: NavTarget): TaskNavLink {
  return {
    id,
    task_id: "task-1",
    target_id: target.id,
    display_order: 0,
    is_default: false,
    launch_behavior: "default",
    created_at: "2026-10-26T00:00:00Z",
    running_state: "not_running",
    target,
  };
}

const APP_VSCODE = appFix({ app_key: "vscode", display_name: "VS Code", category: "dev" });
const APP_WECHAT = appFix({ app_key: "wechat", display_name: "微信", category: "im" });
const APP_CHROME = appFix({ app_key: "chrome", display_name: "Chrome", category: "browser" });

const WIN_NOTEPAD: WindowInfo = {
  hwnd: 4242,
  pid: 100,
  title: "doc.txt - 记事本",
  class_name: "Notepad",
  is_minimized: false,
  exe_path: "C:\\Windows\\System32\\notepad.exe",
};

/** 注入 store 初始数据（真实 zustand 实例；动作替换为 vi.fn 防意外 IPC）。 */
function seedStores(opts?: { apps?: DiscoveredApp[]; targets?: NavTarget[]; links?: TaskNavLink[] }) {
  vi.mocked(navListTargets).mockResolvedValue([]);
  vi.mocked(navPickTaskWindow).mockResolvedValue();
  vi.mocked(navLinkTaskWindow).mockResolvedValue("link-id");
  useNavigationStore.setState({
    scan: {
      apps: opts?.apps ?? [APP_VSCODE, APP_WECHAT, APP_CHROME],
      scanned_at: "2026-10-28T00:00:00Z",
      duration_ms: 1,
      counts: {},
    },
    scanning: false,
    targets: opts?.targets ?? [],
    targetsLoaded: true,
    linksByTask: opts?.links ? { "task-1": opts.links } : {},
    loadApps: vi.fn(async () => {}),
    loadTargets: vi.fn(async () => {}),
    loadTaskLinks: vi.fn(async () => {}),
  });
  useAgentsStore.setState({ snapshot: { sources: [], instances: [], sessions: [], runs: [] } });
  useUiStore.setState({ toast: null });
  useTasksStore.setState({ refresh: vi.fn(async () => {}) });
}

/** toast 探针：把 useUiStore 的 toast 渲染进 DOM，断言"用户可见"。 */
function ToastProbe() {
  const toast = useUiStore((s) => s.toast);
  return (
    <div data-testid="toast" data-kind={toast?.kind ?? ""}>
      {toast?.message ?? ""}
    </div>
  );
}

function renderPicker(props?: { taskId?: string | null }) {
  const onClose = vi.fn();
  render(
    <>
      <AppPicker taskId={props?.taskId ?? null} onClose={onClose} />
      <ToastProbe />
    </>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ── 测试 ─────────────────────────────────────────────────────

describe("AppPicker", () => {
  it("渲染应用列表；搜索框输入与分类按钮切换都能过滤列表", async () => {
    const user = userEvent.setup();
    seedStores();
    renderPicker({ taskId: "task-1" });

    const list = screen.getByRole("listbox", { name: "已安装软件" });
    expect(within(list).getByText("VS Code")).toBeTruthy();
    expect(within(list).getByText("微信")).toBeTruthy();
    expect(within(list).getByText("Chrome")).toBeTruthy();

    // 搜索过滤：命中 Chrome，其余隐藏
    await user.type(screen.getByLabelText("搜索应用"), "chr");
    expect(within(list).queryByText("VS Code")).toBeNull();
    expect(within(list).queryByText("微信")).toBeNull();
    expect(within(list).getByText("Chrome")).toBeTruthy();

    // 清空搜索后用分类按钮过滤：通讯类只剩微信
    await user.clear(screen.getByLabelText("搜索应用"));
    await user.click(screen.getByRole("button", { name: "通讯" }));
    expect(within(list).getByText("微信")).toBeTruthy();
    expect(within(list).queryByText("VS Code")).toBeNull();
    expect(within(list).queryByText("Chrome")).toBeNull();
  });

  it("点击应用项：按 TargetInput 保存目标 → 关联任务 → 关闭弹窗", async () => {
    const user = userEvent.setup();
    seedStores();
    const t = targetFix("target-vsc", "VS Code", "vscode");
    vi.mocked(navSaveTarget).mockResolvedValue(t);
    const { onClose } = renderPicker({ taskId: "task-1" });

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navSaveTarget)).toHaveBeenCalledWith(
      expect.objectContaining({
        target_type: "application",
        display_name: "VS Code",
        exe_path: APP_VSCODE.exe_path,
        launch_args: APP_VSCODE.launch_args,
        working_dir: APP_VSCODE.working_dir,
        app_user_model_id: APP_VSCODE.app_user_model_id,
        window_title_hint: APP_VSCODE.window_title_hint,
        category: "dev",
        overwrite_name: false,
      }),
    );
    expect(vi.mocked(navLinkTask)).toHaveBeenCalledWith("task-1", "target-vsc", false, "default");
  });

  it("点击已关联（linkedKeys 命中）的应用：提示已关联，不重复 navLinkTask", async () => {
    const user = userEvent.setup();
    const t = targetFix("target-vsc", "VS Code", "vscode");
    seedStores({ links: [linkFix("link-1", t)] });
    vi.mocked(navSaveTarget).mockResolvedValue(t);
    const { onClose } = renderPicker({ taskId: "task-1" });

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navSaveTarget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(navLinkTask)).not.toHaveBeenCalled();
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("已关联该任务");
    expect(toast.dataset.kind).toBe("info");
  });

  it("「从当前运行的窗口选择」展开后渲染窗口条目；点击窗口保存目标并固化窗口身份", async () => {
    const user = userEvent.setup();
    seedStores();
    const t = targetFix("target-win", "doc.txt", "notepad.exe");
    vi.mocked(navListWindows).mockResolvedValue([WIN_NOTEPAD]);
    vi.mocked(navSaveTarget).mockResolvedValue(t);
    const { onClose } = renderPicker({ taskId: "task-1" });

    await user.click(await screen.findByRole("button", { name: /从当前运行的窗口选择/ }));
    const winItem = await screen.findByRole("button", { name: /doc\.txt - 记事本/ });
    await user.click(winItem);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navSaveTarget)).toHaveBeenCalledWith(
      expect.objectContaining({
        target_type: "application",
        exe_path: WIN_NOTEPAD.exe_path,
      }),
    );
    // 用户选中的窗口身份属于任务关联，而不是共用应用目标。
    expect(vi.mocked(navLinkTaskWindow)).toHaveBeenCalledWith("task-1", "target-win", WIN_NOTEPAD.hwnd);
    expect(vi.mocked(navPickWindowIdentity)).not.toHaveBeenCalled();
    expect(vi.mocked(navLinkTask)).not.toHaveBeenCalled();
  });

  it("窗口身份记录失败时显示错误并保留选择器，便于重试", async () => {
    const user = userEvent.setup();
    seedStores();
    const t = targetFix("target-win", "doc.txt", "notepad.exe");
    vi.mocked(navListWindows).mockResolvedValue([WIN_NOTEPAD]);
    vi.mocked(navSaveTarget).mockResolvedValue(t);
    vi.mocked(navPickWindowIdentity).mockRejectedValue(new Error("window gone"));
    // 不传 taskId 也不传 onSelect：afterPick 走到 onClose 且不弹成功 toast，
    // 这样 info 提示不会被覆盖，可以直接断言
    const { onClose } = renderPicker({ taskId: null });

    await user.click(await screen.findByRole("button", { name: /从当前运行的窗口选择/ }));
    await user.click(await screen.findByRole("button", { name: /doc\.txt - 记事本/ }));

    await waitFor(() => expect(screen.getByTestId("toast").textContent).toContain("window gone"));
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.mocked(navSaveTarget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(navPickWindowIdentity)).toHaveBeenCalledWith("target-win", WIN_NOTEPAD.hwnd);
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("未能记录窗口身份");
    expect(toast.dataset.kind).toBe("error");
  });

  it("两个任务重用同一应用时分别更新各自关联的窗口", async () => {
    const user = userEvent.setup();
    seedStores();
    const t = { ...targetFix("shared", "应用", "app"), exe_path: WIN_NOTEPAD.exe_path! };
    vi.mocked(navListTargets).mockResolvedValue([t]);
    vi.mocked(navListWindows).mockResolvedValue([WIN_NOTEPAD]);
    const first = renderPicker({ taskId: "task-1" });
    await user.click(screen.getByRole("button", { name: /从当前运行的窗口选择/ }));
    await user.click(await screen.findByRole("button", { name: /doc\.txt - 记事本/ }));
    await waitFor(() => expect(first.onClose).toHaveBeenCalled());
    cleanup();
    const second = renderPicker({ taskId: "task-2" });
    await user.click(screen.getByRole("button", { name: /从当前运行的窗口选择/ }));
    await user.click(await screen.findByRole("button", { name: /doc\.txt - 记事本/ }));
    await waitFor(() => expect(second.onClose).toHaveBeenCalled());
    expect(vi.mocked(navLinkTaskWindow).mock.calls).toEqual([["task-1", "shared", WIN_NOTEPAD.hwnd], ["task-2", "shared", WIN_NOTEPAD.hwnd]]);
    expect(navPickWindowIdentity).not.toHaveBeenCalled();
    expect(navSaveTarget).not.toHaveBeenCalled();
  });

  it("busyKey 防重复：连点两次同一应用，navSaveTarget 只调用一次", async () => {
    const user = userEvent.setup();
    seedStores();
    const t = targetFix("target-vsc", "VS Code", "vscode");
    let resolveSave!: (v: NavTarget) => void;
    // 保存挂起期间 busyKey 保持非空（按钮禁用），才能测出防重复
    vi.mocked(navSaveTarget).mockImplementation(
      () => new Promise<NavTarget>((res) => { resolveSave = res; }),
    );
    const { onClose } = renderPicker({ taskId: "task-1" });

    const btn = (await screen.findByRole("option", { name: /VS Code/ })) as HTMLButtonElement;
    await user.click(btn); // 第一次点击：进入 busy
    expect(btn.disabled).toBe(true);
    await user.click(btn); // 第二次点击：禁用态被忽略
    expect(vi.mocked(navSaveTarget)).toHaveBeenCalledTimes(1);

    resolveSave(t);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navSaveTarget)).toHaveBeenCalledTimes(1);
  });

  it("navSaveTarget 失败：错误 toast 可见，弹窗不关闭", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navSaveTarget).mockRejectedValue(new Error("路径不合法"));
    const { onClose } = renderPicker({ taskId: "task-1" });

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    await waitFor(() => {
      const toast = screen.getByTestId("toast");
      expect(toast.textContent).toContain("路径不合法");
      expect(toast.dataset.kind).toBe("error");
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
