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
import { APP_PAGE_SIZE } from "../../lib/appSearch";
import {
  navLinkTask,
  navListWindows,
  navListTargets,
  navPickWindowIdentity,
  navPickTaskWindow,
  navLinkTaskWindow,
  navSaveTarget,
  navSaveWindowTarget,
  navUpdateTarget,
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
    navSaveWindowTarget: vi.fn(),
    navLinkTask: vi.fn(async () => "link-id"),
    navSaveAgentSessionTarget: vi.fn(),
    navPickWindowIdentity: vi.fn(),
    navPickTaskWindow: vi.fn(async () => {}),
    navLinkTaskWindow: vi.fn(async () => "link-id"),
    navUpdateTarget: vi.fn(async () => {}),
    navAppIcon: vi.fn(async () => null),
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

const WIN_CHROME_GITHUB: WindowInfo = {
  hwnd: 777,
  pid: 200,
  title: "GitHub - Google Chrome",
  class_name: "Chrome_WidgetWin_1",
  is_minimized: false,
  exe_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};

const WIN_CHROME_CHATGPT: WindowInfo = {
  ...WIN_CHROME_GITHUB,
  hwnd: 888,
  title: "ChatGPT - Google Chrome",
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
    scanProgress: null,
    scanPartial: false,
    targets: opts?.targets ?? [],
    targetsLoaded: true,
    targetsError: null,
    scanError: null,
    linksError: null,
    linksByTask: opts?.links ? { "task-1": opts.links } : {},
    loadApps: vi.fn(async () => "ok" as const),
    loadTargets: vi.fn(async () => "ok" as const),
    loadTaskLinks: vi.fn(async () => "ok" as const),
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

function renderPicker(props?: { taskId?: string | null; standalone?: boolean }) {
  const onClose = vi.fn();
  render(
    <>
      <AppPicker taskId={props?.taskId ?? null} standalone={props?.standalone} onClose={onClose} />
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

  it("关联成功但关联列表刷新失败：保留成功事实，提示刷新失败且不重复创建", async () => {
    const user = userEvent.setup();
    seedStores();
    useNavigationStore.setState({
      loadTaskLinks: vi.fn(async () => "error" as const),
      linksError: "读取超时",
    });
    const t = targetFix("target-vsc", "VS Code", "vscode");
    vi.mocked(navSaveTarget).mockResolvedValue(t);
    const { onClose } = renderPicker({ taskId: "task-1" });

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const toast = screen.getByTestId("toast");
    // 保存/关联已成功，但刷新失败必须单独说明，不能当成整体成功
    expect(toast.textContent).toContain("已关联");
    expect(toast.textContent).toContain("列表刷新失败");
    expect(toast.dataset.kind).toBe("warning");
    // 数据只写入一次：刷新失败不会触发重复创建
    expect(navSaveTarget).toHaveBeenCalledTimes(1);
    expect(navLinkTask).toHaveBeenCalledTimes(1);
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

  it("独立配置模式：保存目标但不产生任务关联，刷新共享目标后关闭", async () => {
    const user = userEvent.setup();
    seedStores();
    const t = targetFix("target-vsc", "VS Code", "vscode");
    vi.mocked(navSaveTarget).mockResolvedValue(t);
    const loadTargets = useNavigationStore.getState().loadTargets;
    const { onClose } = renderPicker({ standalone: true });

    // 标题与 Agent 会话区按应用配置模式呈现，不混入任务/会话语义
    expect(screen.getByRole("dialog", { name: "添加应用与快捷方式" })).toBeTruthy();
    expect(screen.queryByText(/从 Agent 会话选择/)).toBeNull();

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navLinkTask)).not.toHaveBeenCalled();
    expect(loadTargets).toHaveBeenCalledWith(true);
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("已添加「VS Code」");
    expect(toast.dataset.kind).toBe("success");
  });

  it("独立配置保存成功但目标列表刷新失败：不伪装成纯成功", async () => {
    const user = userEvent.setup();
    seedStores();
    useNavigationStore.setState({
      loadTargets: vi.fn(async () => "error" as const),
      targetsError: "读取超时",
    });
    const t = targetFix("target-vsc", "VS Code", "vscode");
    vi.mocked(navSaveTarget).mockResolvedValue(t);
    const { onClose } = renderPicker({ standalone: true });

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("已添加「VS Code」");
    expect(toast.textContent).toContain("列表刷新失败");
    expect(toast.dataset.kind).toBe("warning");
  });

  it("独立配置模式重复添加：复用现有目标并提示「已在快捷列表中」，不关联任务", async () => {
    const user = userEvent.setup();
    const existing = targetFix("target-vsc", "VS Code", "vscode");
    seedStores({ targets: [existing] });
    vi.mocked(navSaveTarget).mockResolvedValue(existing);
    const { onClose } = renderPicker({ standalone: true });

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // 后端按 app_key 幂等，前端只保存一次、不产生第二套关联
    expect(vi.mocked(navSaveTarget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(navLinkTask)).not.toHaveBeenCalled();
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("已在快捷列表中");
    expect(toast.dataset.kind).toBe("info");
  });

  it("独立配置模式重复添加已隐藏目标：提示可恢复显示，确认后取消隐藏且不覆盖自定义配置", async () => {
    const user = userEvent.setup();
    const hidden = { ...targetFix("target-vsc", "VS Code（自定义名）", "vscode"), hidden: true, favorite: true, launch_args: "--safe-mode" };
    seedStores({ targets: [hidden] });
    vi.mocked(navSaveTarget).mockResolvedValue(hidden);
    const loadTargets = useNavigationStore.getState().loadTargets;
    const { onClose } = renderPicker({ standalone: true });

    await user.click(await screen.findByRole("option", { name: /VS Code/ }));

    // 保持选择器打开并明确提示，而不是「提示已存在但页面上看不到」
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("恢复显示");
    expect(vi.mocked(navUpdateTarget)).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "恢复显示" }));
    await waitFor(() => expect(vi.mocked(navUpdateTarget)).toHaveBeenCalledWith("target-vsc", { hidden: false }));
    // 只取消隐藏：名称/收藏/启动参数等自定义配置不提交
    expect(vi.mocked(navUpdateTarget).mock.calls[0][1]).toEqual({ hidden: false });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(loadTargets).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("toast").textContent).toContain("已恢复显示");
  });

  it("扫描失败显示错误与重试，不会永远停在「加载中」", () => {
    seedStores();
    useNavigationStore.setState({ scan: null, scanning: false, scanError: "扫描服务不可用" });
    renderPicker({ standalone: true });

    expect(screen.getByText(/扫描失败/)).toBeTruthy();
    expect(screen.queryByText("加载中…")).toBeNull();
    expect(screen.getByRole("button", { name: "扫描本机应用" })).toBeTruthy();
  });

  it("未扫描时不自动发起扫描，显示主动扫描引导", async () => {
    const user = userEvent.setup();
    seedStores();
    useNavigationStore.setState({ scan: null, scanning: false, scanError: null });
    const loadApps = useNavigationStore.getState().loadApps;
    renderPicker({ standalone: true });

    // 挂载只读取已保存目标，不触发本机软件扫描
    expect(loadApps).not.toHaveBeenCalled();
    expect(screen.getByText("尚未扫描本机应用")).toBeTruthy();
    expect(screen.getByText(/点击「扫描本机应用」查找可以添加的桌面程序/)).toBeTruthy();
    // 弹层同样按列表区常规布局靠左，不居中
    const gate = screen.getByText("尚未扫描本机应用").closest(".picker-scan-state");
    expect(gate?.className).toContain("picker-scan-state--top");
    expect(gate?.className).not.toContain("picker-scan-state--center");
    expect(screen.queryByText(/加载中/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "扫描本机应用" }));
    expect(loadApps).toHaveBeenCalledWith(true);
  });

  it("弹层首次扫描：状态区仍使用居中修饰类", () => {
    seedStores();
    useNavigationStore.setState({
      scan: null,
      scanning: true,
      scanError: null,
      scanPartial: true,
      scanProgress: { discovered: 1, sourcesDone: 1, sourcesTotal: 5, batches: 1 },
    });
    renderPicker({ standalone: true });

    const gate = screen.getByText(/正在扫描本机应用/).closest(".picker-scan-state");
    expect(gate?.className).toContain("picker-scan-state");
    expect(gate?.className).toContain("picker-scan-state--center");
    expect(gate?.className).not.toContain("picker-scan-state--top");
  });

  it("已有会话扫描结果直接展示，不自动刷新；显示上次扫描时间并可手动重扫", async () => {
    const user = userEvent.setup();
    seedStores();
    const loadApps = useNavigationStore.getState().loadApps;
    renderPicker({ standalone: true });

    expect(loadApps).not.toHaveBeenCalled();
    expect(screen.getByText(/上次扫描/)).toBeTruthy();
    expect(screen.getByText(/共 3 个可添加应用/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    expect(loadApps).toHaveBeenCalledWith(true);
  });

  it("高级项默认折叠、可展开，普通程序不受影响", async () => {
    const user = userEvent.setup();
    seedStores({
      apps: [
        APP_VSCODE,
        appFix({
          app_key: "updater",
          display_name: "Google Update",
          category: "other",
          tier: "advanced",
        }),
      ],
    });
    render(
      <>
        <AppPicker standalone variant="page" onClose={vi.fn()} />
        <ToastProbe />
      </>,
    );
    const list = screen.getByRole("listbox", { name: "已安装软件" });

    expect(within(list).queryByText("Google Update")).toBeNull();
    await user.click(screen.getByRole("button", { name: /显示高级项（1）/ }));
    expect(within(list).getByText("Google Update")).toBeTruthy();
  });

  it("搜索「微信」命中主程序与相关独立应用；不连续中文不命中", async () => {
    const user = userEvent.setup();
    seedStores({
      apps: [
        appFix({ app_key: "weixin", display_name: "微信", category: "im", exe_path: "D:\\微信\\Weixin\\Weixin.exe" }),
        appFix({ app_key: "wxwork", display_name: "企业微信", category: "im", exe_path: "C:\\Program Files\\WXWork\\WXWork.exe" }),
        appFix({ app_key: "wxdev", display_name: "微信开发者工具", category: "dev", exe_path: "C:\\Tencent\\微信开发者工具\\微信开发者工具.exe" }),
        appFix({ app_key: "minichat", display_name: "微型聊天工具", category: "im" }),
        APP_CHROME,
      ],
    });
    renderPicker({ standalone: true });
    const list = screen.getByRole("listbox", { name: "已安装软件" });

    await user.type(screen.getByLabelText("搜索应用"), "微信");
    expect(within(list).getByText("微信")).toBeTruthy();
    expect(within(list).getByText("企业微信")).toBeTruthy();
    expect(within(list).getByText("微信开发者工具")).toBeTruthy();
    expect(within(list).queryByText("微型聊天工具")).toBeNull();

    await user.clear(screen.getByLabelText("搜索应用"));
    await user.type(screen.getByLabelText("搜索应用"), "微开");
    expect(within(list).queryByText("微信开发者工具")).toBeNull();
    expect(screen.getByText("没有找到匹配的应用，可以尝试其他关键词或手动添加。")).toBeTruthy();
  });

  it("英文搜索大小写不敏感：WECHAT / wechat 命中同一应用", async () => {
    const user = userEvent.setup();
    seedStores({
      apps: [
        appFix({ app_key: "weixin", display_name: "WeChat", category: "im", exe_path: "D:\\微信\\Weixin\\Weixin.exe" }),
        APP_CHROME,
      ],
    });
    renderPicker({ standalone: true });
    const list = screen.getByRole("listbox", { name: "已安装软件" });

    for (const q of ["WECHAT", "wechat", "WeChat"]) {
      await user.clear(screen.getByLabelText("搜索应用"));
      await user.type(screen.getByLabelText("搜索应用"), q);
      expect(within(list).getByText("WeChat")).toBeTruthy();
      expect(within(list).queryByText("Chrome")).toBeNull();
    }
  });

  it("大量结果分页完整：首屏 40 条，「加载更多」后 60 条全部可见", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, i) =>
      appFix({ app_key: `wechat-${i}`, display_name: `微信应用${i}`, category: "im" }),
    );
    seedStores({ apps: many });
    renderPicker({ standalone: true });
    const list = screen.getByRole("listbox", { name: "已安装软件" });

    expect(within(list).getAllByRole("option")).toHaveLength(APP_PAGE_SIZE);
    expect(within(list).getByText(/共 60 个可添加应用/)).toBeTruthy();

    await user.click(within(list).getByRole("button", { name: /加载更多/ }));
    expect(within(list).getAllByRole("option")).toHaveLength(60);
    expect(within(list).queryByRole("button", { name: /加载更多/ })).toBeNull();
  });

  it("扫描不完整时明确提示，不与「没有匹配」混淆", () => {
    seedStores();
    useNavigationStore.setState({
      scan: {
        apps: [APP_VSCODE, APP_WECHAT, APP_CHROME],
        scanned_at: "2026-10-28T00:00:00Z",
        duration_ms: 1,
        counts: {},
        diagnostics: { startmenu_truncated: 1 },
      },
    });
    renderPicker({ standalone: true });

    expect(screen.getByText(/应用发现可能不完整/)).toBeTruthy();
  });

  it("扫描中搜索无匹配：提示仍在继续扫描，不提前说「没有匹配」", async () => {
    const user = userEvent.setup();
    seedStores();
    useNavigationStore.setState({
      scanning: true,
      scanProgress: { discovered: 3, sourcesDone: 1, sourcesTotal: 5, batches: 1 },
    });
    renderPicker({ standalone: true });

    await user.type(screen.getByLabelText("搜索应用"), "zzz");
    expect(screen.getByText("正在继续扫描，暂未发现匹配的应用…")).toBeTruthy();
    expect(screen.queryByText(/没有找到匹配的应用/)).toBeNull();
    // 扫描进度提示仍然保留
    expect(screen.getByText(/正在扫描（已发现 3 个 · 已扫描来源 1\/5）/)).toBeTruthy();
  });

  it("扫描失败但保留部分结果：明确不完整，搜索无匹配不冒充扫描结束", async () => {
    const user = userEvent.setup();
    seedStores({ apps: [APP_VSCODE] });
    useNavigationStore.setState({ scanning: false, scanError: "来源读取失败", scanPartial: true });
    renderPicker({ standalone: true });

    await user.type(screen.getByLabelText("搜索应用"), "微信");
    expect(screen.getByText(/当前仅显示已发现的部分结果（不完整）/)).toBeTruthy();
    expect(
      screen.getByText("没有找到匹配的应用；扫描未完成，结果可能不完整，可尝试重新扫描或手动添加。"),
    ).toBeTruthy();
    expect(screen.queryByText(/没有找到匹配的应用，可以尝试其他关键词/)).toBeNull();
    // 已发现的内容仍可用：清空搜索后部分结果没有被丢弃
    await user.clear(screen.getByLabelText("搜索应用"));
    expect(screen.getByText(/共 1 个可添加应用/)).toBeTruthy();
    expect(screen.getByRole("option", { name: /VS Code/ })).toBeTruthy();
  });
});

describe("AppPicker 子页面（variant=page）", () => {
  function renderPage() {
    const onClose = vi.fn();
    render(
      <>
        <AppPicker standalone variant="page" onClose={onClose} />
        <ToastProbe />
      </>,
    );
    return { onClose };
  }

  it("以内容区页面呈现：没有 dialog 遮罩，返回按钮关闭页面", async () => {
    const user = userEvent.setup();
    seedStores();
    const { onClose } = renderPage();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "添加应用" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "已安装软件" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "返回应用列表" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("首次进入添加子页不自动扫描；只有用户点扫描才触发", async () => {
    const user = userEvent.setup();
    seedStores();
    useNavigationStore.setState({ scan: null, scanning: false, scanError: null });
    const loadApps = useNavigationStore.getState().loadApps;
    renderPage();

    expect(loadApps).not.toHaveBeenCalled();
    expect(screen.getByText("尚未扫描本机应用")).toBeTruthy();
    // 未扫描引导按列表区常规布局靠左，不使用扫描中的居中容器
    const gate = screen.getByText("尚未扫描本机应用").closest(".picker-scan-state");
    expect(gate?.className).toContain("picker-scan-state--top");
    expect(gate?.className).not.toContain("picker-scan-state--center");
    // 从当前窗口选择 / 手动添加始终可达
    expect(screen.getByRole("button", { name: "从当前窗口选择" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "手动添加" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "扫描本机应用" }));
    expect(loadApps).toHaveBeenCalledWith(true);
    expect(loadApps).toHaveBeenCalledTimes(1);
  });

  it("未扫描切换到扫描中：只切换修饰类，不重建外框、不挤动工具栏", async () => {
    seedStores();
    useNavigationStore.setState({ scan: null, scanning: false, scanError: null });
    renderPage();

    const gate = screen.getByText("尚未扫描本机应用").closest(".picker-scan-state");
    expect(gate).toBeTruthy();
    expect(gate?.className).toContain("picker-scan-state");
    expect(gate?.className).toContain("picker-scan-state--top");

    useNavigationStore.setState({
      scanning: true,
      scanPartial: true,
      scanProgress: { discovered: 3, sourcesDone: 1, sourcesTotal: 5, batches: 1 },
    });

    const next = document.querySelector(".picker-scan-state");
    // 外框沿用同一 DOM 节点 + 同一基础类（appPicker.css 的 min-height 契约），
    // 切换状态只换修饰类，所以外框高度与上下工具栏位置不变。
    expect(next).toBe(gate);
    await waitFor(() =>
      expect(next?.className).toContain("picker-scan-state--center"),
    );
    expect(next?.className).toContain("picker-scan-state");
    expect(next?.className).not.toContain("picker-scan-state--top");
    expect(screen.getByRole("textbox", { name: "搜索应用" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "分类筛选" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加已选应用" })).toBeTruthy();
  });

  it("首次扫描失败保持列表区常规布局，不居中", () => {
    seedStores();
    useNavigationStore.setState({
      scan: null,
      scanning: false,
      scanError: "来源读取失败",
      scanPartial: false,
    });
    renderPage();

    expect(screen.getByText(/应用扫描失败/)).toBeTruthy();
    const gate = screen.getByText(/应用扫描失败/).closest(".picker-scan-state");
    expect(gate?.className).toContain("picker-scan-state--top");
    expect(gate?.className).not.toContain("picker-scan-state--center");
  });

  it("扫描中禁用重复提交，已有结果时保留展示", () => {
    seedStores();
    useNavigationStore.setState({ scanning: true });
    renderPage();

    const rescan = screen.getByRole("button", { name: /扫描中…/ });
    expect((rescan as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("listbox", { name: "已安装软件" })).toBeTruthy();
    expect(screen.getByText(/正在扫描/)).toBeTruthy();
  });

  it("首次扫描：加载状态在列表区域居中，并显示真实来源进度", () => {
    seedStores();
    useNavigationStore.setState({
      scan: null,
      scanning: true,
      scanError: null,
      scanPartial: true,
      scanProgress: { discovered: 42, sourcesDone: 2, sourcesTotal: 5, batches: 2 },
    });
    renderPage();

    // 两行结构：第一行动作+图标，第二行为真实进度（不塞在同一行）
    const line = screen.getByText(/正在扫描本机应用/);
    expect(line.className).toContain("picker-scanning-line");
    const box = line.closest(".picker-scanning");
    expect(box).toBeTruthy();
    const progress = box?.querySelector(".picker-scan-progress");
    expect(progress?.textContent).toContain("已发现 42 个");
    expect(progress?.textContent).toContain("已扫描来源 2/5");
    // 进度是独立元素，不与动作行共用同一容器
    expect(progress?.previousElementSibling).toBe(line);
    // 不伪造百分比
    expect(box?.textContent).not.toMatch(/\d+\s?%/);
    // 状态区占据可用列表区域并居中（搜索栏/分类/底栏保持稳定）
    const centered = box?.closest(".picker-scan-state");
    expect(centered).toBeTruthy();
    expect(centered?.className).toContain("picker-scan-state");
    expect(centered?.className).toContain("picker-scan-state--center");
    expect(centered?.className).not.toContain("picker-scan-state--top");
    expect(centered?.parentElement?.className).toContain("app-picker-page-body");
    expect(screen.getByRole("textbox", { name: "搜索应用" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "分类筛选" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加已选应用" })).toBeTruthy();
  });

  it("扫描中的空批次不提前显示「扫描完成」：保持居中加载态", () => {
    seedStores();
    useNavigationStore.setState({
      scan: null,
      scanning: true,
      scanError: null,
      scanPartial: true,
      scanProgress: { discovered: 0, sourcesDone: 1, sourcesTotal: 5, batches: 1 },
    });
    renderPage();

    expect(screen.queryByText(/扫描完成，未发现/)).toBeNull();
    expect(screen.getByText(/正在扫描本机应用/)).toBeTruthy();
    const box = screen.getByText(/正在扫描本机应用/).closest(".picker-scanning");
    expect(box?.querySelector(".picker-scan-progress")?.textContent).toContain("已发现 0 个");
    // 状态区仍在可用列表区域居中，不会退化成空列表提示
    expect(document.querySelector(".picker-scan-state")).toBeTruthy();
  });

  it("扫描中尚未收到首批事件：第二行仍显示真实已发现数，不编造来源进度", () => {
    seedStores();
    useNavigationStore.setState({
      scan: null,
      scanning: true,
      scanError: null,
      scanPartial: true,
      scanProgress: { discovered: 0, sourcesDone: 0, sourcesTotal: 0, batches: 0 },
    });
    renderPage();

    const box = screen.getByText(/正在扫描本机应用/).closest(".picker-scanning");
    const progress = box?.querySelector(".picker-scan-progress");
    expect(progress?.textContent).toBe("已发现 0 个");
    expect(box?.textContent).not.toMatch(/\d+\s?%/);
  });

  it("已有结果时重扫：列表与选择保持，只显示进度", async () => {
    const user = userEvent.setup();
    seedStores();
    renderPage();
    const list = screen.getByRole("listbox", { name: "已安装软件" });
    await user.click(within(list).getByRole("option", { name: /VS Code/ }));
    expect(screen.getByText("已选 1")).toBeTruthy();

    useNavigationStore.setState({
      scanning: true,
      scanProgress: { discovered: 7, sourcesDone: 1, sourcesTotal: 5, batches: 1 },
    });

    await waitFor(() =>
      expect(screen.getByText(/正在扫描（已发现 7 个 · 已扫描来源 1\/5）/)).toBeTruthy(),
    );
    expect(screen.getByText(/共 3 个可添加应用/)).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "已安装软件" })).toBeTruthy();
    expect(screen.getByText("已选 1")).toBeTruthy();
  });

  it("首次扫描中途失败：明确提示仅有部分结果，并保留已发现条目", () => {
    seedStores({ apps: [APP_VSCODE] });
    useNavigationStore.setState({
      scanning: false,
      scanError: "来源读取失败",
      scanPartial: true,
    });
    renderPage();

    expect(screen.getByText(/当前仅显示已发现的部分结果（不完整）/)).toBeTruthy();
    expect(screen.getByText(/共 1 个可添加应用/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("多选两个应用后批量添加：逐个保存、刷新列表并关闭页面", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navSaveTarget).mockImplementation(async (input) =>
      targetFix("t-" + input.display_name, input.display_name, input.exe_path ?? ""),
    );
    const { onClose } = renderPage();
    const list = screen.getByRole("listbox", { name: "已安装软件" });

    const addBtn = screen.getByRole("button", { name: "添加已选应用" });
    expect((addBtn as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(list).getByRole("option", { name: /VS Code/ }));
    await user.click(within(list).getByRole("option", { name: /微信/ }));
    expect(screen.getByText("已选 2")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "添加已选应用（2）" }));
    await waitFor(() => expect(navSaveTarget).toHaveBeenCalledTimes(2));
    expect(useNavigationStore.getState().loadTargets).toHaveBeenCalledWith(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("批量部分失败：成功项不回滚、失败项保留可重试，不误报整体成功", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navSaveTarget).mockImplementation(async (input) => {
      if (input.display_name === "微信") throw new Error("数据库正忙");
      return targetFix("t-" + input.display_name, input.display_name, input.exe_path ?? "");
    });
    const { onClose } = renderPage();
    const list = screen.getByRole("listbox", { name: "已安装软件" });

    await user.click(within(list).getByRole("option", { name: /VS Code/ }));
    await user.click(within(list).getByRole("option", { name: /微信/ }));
    await user.click(screen.getByRole("button", { name: "添加已选应用（2）" }));

    await waitFor(() => expect(navSaveTarget).toHaveBeenCalledTimes(2));
    // 失败项不会被自动重试重复创建，成功项也不回滚
    expect(navSaveTarget).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/1 个失败/)).toBeTruthy();
    // 只剩失败项保持选中，用户可直接重试而不必重新勾选成功项
    expect(screen.getByText("已选 1")).toBeTruthy();
    expect(screen.getByTestId("toast").textContent).toContain("部分应用添加失败");
  });

  it("已添加应用显示明确状态且不可重复选择", async () => {
    seedStores({ targets: [targetFix("t1", "微信", "wechat")] });
    renderPage();
    const list = screen.getByRole("listbox", { name: "已安装软件" });

    const saved = within(list).getByRole("option", { name: /微信/ });
    expect((saved as HTMLButtonElement).disabled).toBe(true);
    expect(within(saved).getByText("已添加")).toBeTruthy();
  });

  it("运行窗口选择在页面内切换，返回后回到发现列表且不重置搜索", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navListWindows).mockResolvedValue([]);
    renderPage();

    const search = screen.getByRole("textbox", { name: "搜索应用" });
    await user.type(search, "VS");
    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("没有可交互的窗口")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "返回添加应用" }));
    expect(screen.getByRole("listbox", { name: "已安装软件" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "搜索应用" }) as HTMLInputElement).value).toBe("VS");
  });

  it("窗口页默认单选且优先切换：确认只保存稳定身份，不聚焦/不串已选计数", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navListWindows).mockResolvedValue([WIN_CHROME_GITHUB, WIN_CHROME_CHATGPT]);
    vi.mocked(navSaveWindowTarget).mockResolvedValue(targetFix("t-win", "Chrome", "chrome"));
    renderPage();

    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    const github = await screen.findByRole("radio", { name: /GitHub - Google Chrome/ });
    await user.click(github);

    expect(github.getAttribute("aria-checked")).toBe("true");
    // 窗口页不沿用已安装软件的多选状态
    expect(screen.queryByText(/已选 \d/)).toBeNull();
    expect(
      screen.getByRole("radio", { name: /优先切换到此窗口/ }).getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "确认添加" }));
    await waitFor(() => expect(navSaveWindowTarget).toHaveBeenCalledWith(777));
    // 添加是配置行为，不触发导航/窗口聚焦，也不退化成旧的「先存应用再绑身份」
    expect(navPickWindowIdentity).not.toHaveBeenCalled();
    expect(navSaveTarget).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "已安装软件" })).toBeTruthy(),
    );
  });

  it("同程序多窗口各自独立提交，不会复用同一个普通应用目标", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navListWindows).mockResolvedValue([WIN_CHROME_GITHUB, WIN_CHROME_CHATGPT]);
    vi.mocked(navSaveWindowTarget).mockImplementation(async (hwnd) =>
      targetFix(`t-${hwnd}`, "Chrome", "chrome"),
    );
    renderPage();

    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    await user.click(await screen.findByRole("radio", { name: /GitHub - Google Chrome/ }));
    await user.click(screen.getByRole("button", { name: "确认添加" }));
    await waitFor(() => expect(navSaveWindowTarget).toHaveBeenCalledWith(777));

    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    await user.click(await screen.findByRole("radio", { name: /ChatGPT - Google Chrome/ }));
    await user.click(screen.getByRole("button", { name: "确认添加" }));
    await waitFor(() => expect(navSaveWindowTarget).toHaveBeenCalledWith(888));
    expect(navSaveWindowTarget).toHaveBeenCalledTimes(2);
  });

  it("「仅添加应用」只保存普通快捷方式，不绑定窗口身份", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navListWindows).mockResolvedValue([WIN_NOTEPAD]);
    vi.mocked(navSaveTarget).mockResolvedValue(targetFix("t-app", "doc.txt", "notepad"));
    renderPage();

    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    await user.click(await screen.findByRole("radio", { name: /doc.txt - 记事本/ }));
    await user.click(screen.getByRole("radio", { name: /仅添加应用，不绑定窗口/ }));
    expect(
      screen.getByRole("radio", { name: /仅添加应用，不绑定窗口/ }).getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "确认添加" }));

    await waitFor(() => expect(navSaveTarget).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navSaveTarget).mock.calls[0][0].exe_path).toBe(WIN_NOTEPAD.exe_path);
    expect(navSaveWindowTarget).not.toHaveBeenCalled();
  });

  it("无 exe 身份的窗口明确提示不能添加，且确认按钮保持禁用", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navListWindows).mockResolvedValue([{ ...WIN_NOTEPAD, hwnd: 999, exe_path: null }]);
    renderPage();

    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    const row = await screen.findByRole("radio", { name: /doc.txt - 记事本/ });
    await user.click(row);

    expect(screen.getByText(/无法识别该窗口所属程序（权限受限），不能添加/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "确认添加" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(navSaveWindowTarget).not.toHaveBeenCalled();
  });

  it("刷新后所选窗口消失：清空选择并提示重选", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navListWindows).mockResolvedValue([WIN_NOTEPAD]);
    renderPage();

    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    await user.click(await screen.findByRole("radio", { name: /doc.txt - 记事本/ }));
    vi.mocked(navListWindows).mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "刷新窗口" }));

    expect(await screen.findByText(/所选窗口已关闭或标题已变化，请重新选择/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "确认添加" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("绑定失败：留在窗口页、保留选择并给出具体原因，可重试", async () => {
    const user = userEvent.setup();
    seedStores();
    vi.mocked(navListWindows).mockResolvedValue([WIN_NOTEPAD]);
    vi.mocked(navSaveWindowTarget).mockRejectedValue(new Error("窗口已关闭，请重新选择"));
    const { onClose } = renderPage();

    await user.click(screen.getByRole("button", { name: "从当前窗口选择" }));
    const row = await screen.findByRole("radio", { name: /doc.txt - 记事本/ });
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "确认添加" }));

    // 页面内提示 + Toast 都会给出具体原因
    expect((await screen.findAllByText(/添加失败：窗口已关闭，请重新选择/)).length).toBeGreaterThan(0);
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("listbox", { name: "已安装软件" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(navSaveWindowTarget).toHaveBeenCalledTimes(1);
  });

  it("子页扫描中搜索无匹配：显示继续扫描，不显示扫描结束文案", async () => {
    const user = userEvent.setup();
    seedStores();
    useNavigationStore.setState({
      scanning: true,
      scanProgress: { discovered: 2, sourcesDone: 1, sourcesTotal: 5, batches: 1 },
    });
    renderPage();

    await user.type(screen.getByLabelText("搜索应用"), "zzz");
    expect(screen.getByText("正在继续扫描，暂未发现匹配的应用…")).toBeTruthy();
    expect(screen.queryByText("没有找到匹配的应用，可以尝试其他关键词或手动添加。")).toBeNull();
    // 匹配结果区域为空，但搜索栏、分类与扫描进度都保留
    expect(screen.getByRole("textbox", { name: "搜索应用" })).toBeTruthy();
    expect(screen.getByText(/正在扫描（已发现 2 个 · 已扫描来源 1\/5）/)).toBeTruthy();
  });

  it("子页扫描中后续批次发现匹配：立即展示，并保留扫描进度", async () => {
    const user = userEvent.setup();
    seedStores();
    useNavigationStore.setState({
      scan: null,
      scanning: true,
      scanPartial: true,
      scanError: null,
      scanProgress: { discovered: 0, sourcesDone: 0, sourcesTotal: 0, batches: 0 },
    });
    renderPage();

    await user.type(screen.getByLabelText("搜索应用"), "微信");
    expect(screen.queryByRole("listbox", { name: "已安装软件" })).toBeNull();
    expect(screen.getByText(/正在扫描本机应用/)).toBeTruthy();

    // 后续来源批次到达：无需重新输入关键词，匹配项立即出现
    useNavigationStore.setState({
      scan: { apps: [APP_WECHAT], scanned_at: "", duration_ms: 1, counts: {} },
      scanProgress: { discovered: 4, sourcesDone: 2, sourcesTotal: 5, batches: 2 },
    });
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "已安装软件" })).toBeTruthy(),
    );
    const list = screen.getByRole("listbox", { name: "已安装软件" });
    expect(within(list).getByText("微信")).toBeTruthy();
    expect(screen.getByText(/正在扫描（已发现 4 个 · 已扫描来源 2\/5）/)).toBeTruthy();
  });

  it("重新扫描中保留上次结果、搜索词、分类筛选与已选项", async () => {
    const user = userEvent.setup();
    seedStores();
    renderPage();

    await user.type(screen.getByLabelText("搜索应用"), "chr");
    await user.click(screen.getByRole("button", { name: "浏览器" }));
    const list = screen.getByRole("listbox", { name: "已安装软件" });
    await user.click(within(list).getByRole("option", { name: /Chrome/ }));
    expect(screen.getByText("已选 1")).toBeTruthy();

    useNavigationStore.setState({
      scanning: true,
      scanProgress: { discovered: 7, sourcesDone: 1, sourcesTotal: 5, batches: 1 },
    });

    await waitFor(() =>
      expect(screen.getByText(/正在扫描（已发现 7 个 · 已扫描来源 1\/5）/)).toBeTruthy(),
    );
    expect((screen.getByRole("textbox", { name: "搜索应用" }) as HTMLInputElement).value).toBe("chr");
    expect(
      screen.getByRole("button", { name: "浏览器" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("已选 1")).toBeTruthy();
    expect(within(screen.getByRole("listbox", { name: "已安装软件" })).getByText("Chrome")).toBeTruthy();
  });
});
