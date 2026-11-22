/**
 * @vitest-environment jsdom
 */
//! 应用中心行为测试：入口渲染、搜索/筛选、运行中真实数据源、添加、收藏、
//! 启动成功刷新最近使用、失败不刷新、删除确认、全部应用（不截断）、分区。
//! 后端命令全部 mock，store 用真实实例（共享状态语义）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { useNavigationStore } from "../../store/useNavigationStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useUiStore } from "../../store/useUiStore";
import { APP_ADD_KEY, APP_GRID_ORDER_KEY, clearAppGridOrder } from "../../lib/appGridOrder";
import AppsPanel from "./AppsPanel";
import {
  navCloseTargetWindows,
  navDeleteTarget,
  navKillTargetProcesses,
  navListTargets,
  navNavigate,
  navQuitTargetProcesses,
  navTargetRunningStates,
  navUpdateTarget,
  type NavTarget,
} from "../../lib/navigation";

vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return {
    ...actual,
    navListTargets: vi.fn(async () => []),
    navTargetRunningStates: vi.fn(async () => ({})),
    navUpdateTarget: vi.fn(async () => {}),
    navNavigate: vi.fn(),
    navDeleteTarget: vi.fn(async () => {}),
    navCloseTargetWindows: vi.fn(async () => ({ requested: 0, closed: 0, stillOpen: [] })),
    navKillTargetProcesses: vi.fn(async () => ({ matched: 0, killed: 0, failedPids: [] })),
    navQuitTargetProcesses: vi.fn(async () => ({ processTotal: 0, processExited: 0, postedThreads: 0 })),
    navScanApps: vi.fn(async () => ({ apps: [], scanned_at: "", duration_ms: 0, counts: {} })),
    navAllTaskLinks: vi.fn(async () => []),
    navAppIcon: vi.fn(async () => null),
  };
});

// 选择器有独立测试；这里只验证「添加应用」能打开独立配置模式。
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
    scanError: null,
    loadTaskLinks: vi.fn(async () => "ok" as const),
  });
  useUiStore.setState({ toast: null, tab: "apps", appsAddRequest: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAppGridOrder();
  useEdgeSnapStore.setState({ phase: "free" });
});

afterEach(() => {
  cleanup();
  clearAppGridOrder();
});

describe("AppsPanel 应用中心", () => {
  it("顶部标题/副标题与添加入口；点击添加打开独立配置选择器", async () => {
    seed([targetFix()]);
    render(<AppsPanel />);
    expect(screen.getByRole("heading", { name: "应用" })).toBeTruthy();
    expect(screen.getByText("快捷启动与窗口切换")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "添加应用" })[0]);
    expect(await screen.findByRole("dialog", { name: "添加应用与快捷方式" })).toBeTruthy();
  });

  it("胶囊添加意图只消费一次：打开添加页并清除，取消/重新挂载不会自动重开", async () => {
    seed([targetFix()]);
    useUiStore.setState({ appsAddRequest: { token: 1 } });
    render(<AppsPanel />);
    expect(await screen.findByRole("dialog", { name: "添加应用与快捷方式" })).toBeTruthy();
    expect(useUiStore.getState().appsAddRequest).toBeNull();

    // 取消/返回后重新挂载：没有新意图就不再自动打开。
    cleanup();
    render(<AppsPanel />);
    expect(screen.queryByRole("dialog", { name: "添加应用与快捷方式" })).toBeNull();
  });

  it("展示全部已配置应用（不受胶囊 6–7 个容量限制），添加入口只在顶部保留一处", () => {
    seed(
      Array.from({ length: 9 }, (_, i) =>
        targetFix({ id: `t-${i}`, app_key: `app-${i}`, display_name: `应用 ${i}` }),
      ),
    );
    render(<AppsPanel />);
    expect(document.querySelectorAll(".apps-tile")).toHaveLength(9);
    // 网格末尾不再有重复的添加卡片，只保留顶部主操作
    expect(document.querySelector(".apps-tile-add")).toBeNull();
    expect(screen.getAllByRole("button", { name: "添加应用" })).toHaveLength(1);
  });

  it("无任何应用时保留空态添加引导，不渲染空网格", async () => {
    seed([]);
    render(<AppsPanel />);
    expect(document.querySelector(".apps-grid")).toBeNull();
    expect(screen.getByText(/还没有配置应用/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "添加应用" })).toHaveLength(2);

    fireEvent.click(screen.getByText(/还没有配置应用/).parentElement!.querySelector("button")!);
    expect(await screen.findByRole("dialog", { name: "添加应用与快捷方式" })).toBeTruthy();
  });

  it("搜索按名称即时过滤、可清除，无结果给出明确空状态（不触发扫描）", () => {
    seed([
      targetFix({ id: "a", app_key: "obsidian", display_name: "Obsidian" }),
      targetFix({ id: "b", app_key: "code", display_name: "VS Code", favorite: true }),
    ]);
    render(<AppsPanel />);
    fireEvent.change(screen.getByLabelText("搜索应用名称"), { target: { value: "code" } });
    expect(screen.queryByText("Obsidian")).toBeNull();
    expect(screen.getByText("VS Code")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("搜索应用名称"), { target: { value: "zzz" } });
    expect(screen.getByText(/没有匹配「zzz」的应用/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByText("Obsidian")).toBeTruthy();
  });

  it("收藏筛选只显示收藏项；收藏操作调用后端并刷新共享清单", async () => {
    seed([
      targetFix({ id: "a", app_key: "obsidian", display_name: "Obsidian" }),
      targetFix({ id: "b", app_key: "code", display_name: "VS Code", favorite: true }),
    ]);
    render(<AppsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "收藏 Obsidian" }));
    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith("a", { favorite: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(screen.queryByText("Obsidian")).toBeNull();
    expect(screen.getByText("VS Code")).toBeTruthy();
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
  });

  it("默认视图按收藏 → 运行中 → 其余置顶，与胶囊应用面板一致", async () => {
    seed([
      targetFix({ id: "a", app_key: "zeta", display_name: "Zeta 运行" }),
      targetFix({ id: "b", app_key: "alpha", display_name: "Alpha 普通" }),
      targetFix({ id: "c", app_key: "beta", display_name: "Beta 收藏", favorite: true }),
      targetFix({ id: "d", app_key: "gamma", display_name: "Gamma 托盘" }),
    ]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({
      a: "has_window",
      d: "process_only",
      b: "not_running",
      c: "not_running",
    });
    render(<AppsPanel />);

    await waitFor(() => {
      const names = Array.from(document.querySelectorAll(".apps-tile-name")).map((el) => el.textContent);
      expect(names).toEqual(["Beta 收藏", "Gamma 托盘", "Zeta 运行", "Alpha 普通"]);
    });
  });

  it("「运行中」使用后端真实状态快照，不靠使用次数推断", async () => {
    const a = targetFix({ id: "a", app_key: "obsidian", display_name: "Obsidian" });
    const b = targetFix({ id: "b", app_key: "code", display_name: "VS Code", use_count: 9 });
    seed([a, b]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ a: "has_window", b: "not_running" });
    render(<AppsPanel />);

    await waitFor(() =>
      expect(navTargetRunningStates).toHaveBeenCalledWith(["a", "b"]),
    );
    fireEvent.click(screen.getByRole("button", { name: "运行中" }));
    expect(screen.getByText("Obsidian")).toBeTruthy();
    expect(screen.queryByText("VS Code")).toBeNull();
  });

  it("启动成功才刷新最近使用；失败显示真实原因且不刷新", async () => {
    const t = targetFix();
    seed([t]);
    vi.mocked(navNavigate).mockResolvedValueOnce({
      success: false,
      requested_action: "focus",
      actual_action: null,
      fallback_used: false,
      target_id: t.id,
      reason: "程序路径不存在",
      verification_level: "none",
    });
    render(<AppsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "启动 Obsidian" })[0]);
    await waitFor(() => expect(navNavigate).toHaveBeenCalledWith("target-obs"));
    await waitFor(() =>
      expect(useUiStore.getState().toast?.message ?? "").toContain("程序路径不存在"),
    );
    // 失败不得刷新「最近使用」
    expect(navListTargets).not.toHaveBeenCalledWith(true);

    vi.mocked(navNavigate).mockResolvedValueOnce({
      success: true,
      requested_action: "focus",
      actual_action: "focus_window",
      fallback_used: false,
      target_id: t.id,
      verification_level: "window-confirmed",
    });
    fireEvent.click(screen.getAllByRole("button", { name: "启动 Obsidian" })[0]);
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
  });

  it("网址/文件夹单独分区；Agent 会话不进入应用中心", () => {
    seed([
      targetFix({ id: "app", app_key: "obsidian", display_name: "Obsidian" }),
      targetFix({
        id: "url",
        target_type: "url",
        app_key: "url-key",
        display_name: "团队文档",
        url: "https://example.com",
      }),
      targetFix({
        id: "agent",
        target_type: "agent_session",
        app_key: "agent-key",
        display_name: "会话 A",
      }),
    ]);
    render(<AppsPanel />);
    expect(screen.getByRole("region", { name: "网址与文件夹" })).toBeTruthy();
    expect(screen.getByText("团队文档")).toBeTruthy();
    expect(screen.queryByText("会话 A")).toBeNull();
  });

  it("编辑配置在页内展开（无弹窗），保存后刷新共享清单", async () => {
    seed([targetFix()]);
    render(<AppsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /编辑配置/ }));

    const form = await screen.findByRole("region", { name: "编辑应用配置" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(form.textContent).toContain(targetFix().exe_path);

    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Obsidian 笔记" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith(
        "target-obs",
        expect.objectContaining({ display_name: "Obsidian 笔记" }),
      ),
    );
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("region", { name: "编辑应用配置" })).toBeNull();
  });

  it("有未保存更改时点「添加应用」先确认，不静默丢弃输入", async () => {
    seed([targetFix()]);
    render(<AppsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /编辑配置/ }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "改名后" } });

    fireEvent.click(screen.getAllByRole("button", { name: "添加应用" })[0]);
    const dialog = await screen.findByRole("dialog", { name: /放弃未保存的更改/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("改名后");
  });

  it("隐藏目标不出现在应用中心；删除需确认并同步共享清单", async () => {
    seed([
      targetFix({ id: "a", app_key: "obsidian", display_name: "Obsidian" }),
      targetFix({ id: "h", app_key: "hidden", display_name: "已隐藏应用", hidden: true }),
    ]);
    render(<AppsPanel />);
    expect(screen.queryByText("已隐藏应用")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /从快捷列表删除/ }));
    expect(navDeleteTarget).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog", { name: /删除「Obsidian」/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(navDeleteTarget).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
  });

  it("直接 X 删除是启动的并列按钮：不启动、需确认、取消不调用后端", async () => {
    seed([targetFix()]);
    render(<AppsPanel />);

    const del = screen.getByRole("button", { name: "从快捷列表删除 Obsidian" });
    // 删除按钮与启动主区域同级，内部不再嵌套按钮
    expect(del.closest(".apps-tile")?.querySelector(".apps-tile-main")).toBeTruthy();
    expect(del.querySelector("button")).toBeNull();
    // 不占布局宽度：直接挂在卡片根节点上，而不是收藏/更多所在的布局流里，
    // 因此名称可用宽度与没有删除按钮时一致
    expect(del.parentElement?.className).toContain("apps-tile");
    expect(del.closest(".apps-tile-actions")).toBeNull();
    expect(
      document.querySelector(".apps-tile-actions")?.querySelectorAll("button"),
    ).toHaveLength(2);

    fireEvent.click(del);
    expect(navNavigate).not.toHaveBeenCalled();
    expect(navDeleteTarget).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog", { name: /删除「Obsidian」/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(navDeleteTarget).not.toHaveBeenCalled();
    expect(screen.getByText("Obsidian")).toBeTruthy();
  });

  it("直接 X 删除失败保留条目并给出原因", async () => {
    seed([targetFix()]);
    vi.mocked(navDeleteTarget).mockRejectedValueOnce(new Error("database is locked"));
    render(<AppsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "从快捷列表删除 Obsidian" }));
    const dialog = await screen.findByRole("dialog", { name: /删除「Obsidian」/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(navDeleteTarget).toHaveBeenCalledWith("target-obs"));
    await waitFor(() =>
      expect(useUiStore.getState().toast?.message ?? "").toContain("删除失败"),
    );
    expect(screen.getByText("Obsidian")).toBeTruthy();
  });

  it("删除成功但刷新失败：提示部分成功，不误报删除失败", async () => {
    seed([targetFix()]);
    vi.mocked(navDeleteTarget).mockResolvedValueOnce(undefined);
    vi.mocked(navListTargets).mockRejectedValueOnce(new Error("ipc broken"));
    render(<AppsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "从快捷列表删除 Obsidian" }));
    const dialog = await screen.findByRole("dialog", { name: /删除「Obsidian」/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(useUiStore.getState().toast?.message ?? "").toContain("目标已删除，但关联列表刷新失败"),
    );
    expect(useUiStore.getState().toast?.kind).toBe("warning");
    expect(useUiStore.getState().toast?.message ?? "").not.toContain("删除失败");
    // 删除已成功：本地隐藏，不因刷新失败把条目显示回来
    expect(screen.queryByText("Obsidian")).toBeNull();
  });

  it("单行卡片：真实图标、收藏与更多并列，均不触发启动；菜单保留三项操作", async () => {
    seed([targetFix()]);
    render(<AppsPanel />);

    const main = screen.getByRole("button", { name: "启动 Obsidian" });
    expect(screen.getAllByRole("button", { name: "启动 Obsidian" })).toHaveLength(1);
    expect(main.querySelector(".app-icon")).toBeTruthy();
    // 卡片内并列四个按钮：启动主区域 / 收藏 / 更多 / 直接删除（不嵌套）
    expect(document.querySelector(".apps-tile")?.querySelectorAll("button")).toHaveLength(4);
    expect(document.querySelector(".apps-tile-main")?.querySelector("button")).toBeNull();
    expect(screen.queryByLabelText("启动 / 聚焦窗口")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收藏 Obsidian" }));
    expect(navNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    expect(await screen.findByRole("menuitem", { name: /编辑配置/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /隐藏/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /从快捷列表删除/ })).toBeTruthy();
    expect(navNavigate).not.toHaveBeenCalled();
  });

  it("菜单展开时卡片保持 menu-open 状态，关闭后恢复", async () => {
    seed([targetFix()]);
    render(<AppsPanel />);
    const more = screen.getByRole("button", { name: "更多操作：Obsidian" });
    fireEvent.click(more);
    await waitFor(() => expect(more.getAttribute("aria-expanded")).toBe("true"));
    expect(document.querySelector(".apps-tile.is-menu-open")).toBeTruthy();

    // 选中菜单项后菜单关闭，卡片状态复位（不触发启动）
    fireEvent.click(await screen.findByRole("menuitem", { name: /编辑配置/ }));
    await waitFor(() => expect(document.querySelector(".apps-tile.is-menu-open")).toBeNull());
    expect(navNavigate).not.toHaveBeenCalled();
  });

  it("启动进行中主按钮禁用，重复点击不会重复提交", async () => {
    const t = targetFix();
    seed([t]);
    let resolveNavigate!: (value: {
      success: boolean;
      requested_action: string;
      actual_action: string | null;
      fallback_used: boolean;
      target_id: string;
      verification_level: string;
    }) => void;
    vi.mocked(navNavigate).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNavigate = resolve;
      }) as ReturnType<typeof navNavigate>,
    );
    render(<AppsPanel />);

    const main = screen.getByRole("button", { name: "启动 Obsidian" }) as HTMLButtonElement;
    fireEvent.click(main);
    await waitFor(() => expect(main.disabled).toBe(true));
    fireEvent.click(main);
    expect(navNavigate).toHaveBeenCalledTimes(1);
    expect(navNavigate).toHaveBeenCalledWith(t.id);

    resolveNavigate({
      success: true,
      requested_action: "focus",
      actual_action: "focus_window",
      fallback_used: false,
      target_id: t.id,
      verification_level: "window-confirmed",
    });
    await waitFor(() => expect(main.disabled).toBe(false));
    expect(navNavigate).toHaveBeenCalledTimes(1);
  });

  it("超长名称保留在同一张单行卡片内，不破坏结构", () => {
    const longName = "这是一个非常非常非常长的应用名称用于验证省略与不换行";
    seed([targetFix({ display_name: longName })]);
    render(<AppsPanel />);
    const tile = document.querySelector(".apps-tile") as HTMLElement;
    expect(tile.querySelector(".apps-tile-name")?.textContent).toBe(longName);
    expect(tile.querySelectorAll("button")).toHaveLength(4);
  });

  it("hover 未截断的名称不挂 data-tip，不会把 exe 路径弹成浮层", () => {
    seed([targetFix()]);
    render(<AppsPanel />);
    const main = screen.getByRole("button", { name: "启动 Obsidian" });
    expect(main.dataset.tip).toBeUndefined();

    fireEvent.mouseEnter(main);
    // 名称完整可见时完全不弹提示；即使弹出也绝不能是 exe 路径
    expect(main.dataset.tip).toBeUndefined();
    expect(main.getAttribute("data-tip") ?? "").not.toContain(".exe");

    fireEvent.mouseLeave(main);
    expect(main.dataset.tip).toBeUndefined();
  });

  it("名称被省略号截断时，hover/focus 只提示应用名而不是 exe 路径", () => {
    seed([targetFix({ display_name: "超长应用名称用于验证省略" })]);
    render(<AppsPanel />);
    const main = screen.getByRole("button", { name: "启动 超长应用名称用于验证省略" });
    const name = main.querySelector(".apps-tile-name") as HTMLElement;
    // jsdom 不做真实排版，直接注入「已截断」的滚动宽/可见宽
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 220 });
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 80 });

    fireEvent.mouseEnter(main);
    expect(main.dataset.tip).toBe("超长应用名称用于验证省略");
    expect(main.dataset.tip).not.toContain("Obsidian.exe");

    fireEvent.mouseLeave(main);
    expect(main.dataset.tip).toBeUndefined();

    main.focus();
    expect(main.dataset.tip).toBe("超长应用名称用于验证省略");
    main.blur();
    expect(main.dataset.tip).toBeUndefined();
  });

  it("清单加载失败显示错误与重试，不伪装成空列表", async () => {
    useNavigationStore.setState({
      targets: [],
      targetsLoaded: true,
      targetsError: "IPC 读取失败",
      scan: null,
      scanning: false,
      scanError: null,
    });
    render(<AppsPanel />);
    expect(screen.getByRole("alert").textContent).toContain("应用清单加载失败：IPC 读取失败");
    expect(screen.queryByText(/还没有配置应用/)).toBeNull();
  });

  it("窗口已打开时卡片直接提供关闭按钮（高频直连），菜单不再重复该项", async () => {
    seed([targetFix()]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ "target-obs": "has_window" });
    vi.mocked(navCloseTargetWindows).mockResolvedValue({
      requested: 1,
      closed: 1,
      stillOpen: [],
    });
    render(<AppsPanel />);
    // 徽标刷新拿到 has_window 后卡片操作区才出现关闭按钮
    await waitFor(() =>
      expect(screen.getByText("窗口已打开")).toBeTruthy(),
    );

    const closeBtn = screen.getByRole("button", { name: "关闭 Obsidian 的窗口" });
    expect(closeBtn.closest(".apps-tile-actions")).toBeTruthy();
    // 与启动主区域并列的独立按钮，不嵌套、不冒泡触发启动
    expect(closeBtn.querySelector("button")).toBeNull();

    fireEvent.click(closeBtn);
    expect(navNavigate).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(navCloseTargetWindows).toHaveBeenCalledWith("target-obs"),
    );
    await waitFor(() =>
      expect(useUiStore.getState().toast?.message ?? "").toContain("已关闭「Obsidian」的 1 个窗口"),
    );
    expect(useUiStore.getState().toast?.kind).toBe("success");
    // 关闭后刷新运行态快照，徽标随之更新
    await waitFor(() => expect(navTargetRunningStates).toHaveBeenCalled());

    // 菜单里不再有关闭窗口（已上卡片），但保留破坏性的结束进程入口
    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    expect(await screen.findByRole("menuitem", { name: /编辑配置/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /关闭窗口/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /结束进程/ })).toBeTruthy();
  });

  it("后台进程（process_only）没有窗口可关：卡片无关闭按钮，菜单提供结束进程", async () => {
    seed([targetFix()]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ "target-obs": "process_only" });
    render(<AppsPanel />);
    await waitFor(() => expect(screen.getByText("后台运行")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "关闭 Obsidian 的窗口" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    expect(await screen.findByRole("menuitem", { name: /编辑配置/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /关闭窗口/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /结束进程/ })).toBeTruthy();
    expect(navNavigate).not.toHaveBeenCalled();
  });

  it("应用仍在等待确认（stillOpen）时如实提示 warning，不虚报全部关闭", async () => {
    seed([targetFix()]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ "target-obs": "has_window" });
    vi.mocked(navCloseTargetWindows).mockResolvedValue({
      requested: 2,
      closed: 1,
      stillOpen: ["未保存 - 记事本"],
    });
    render(<AppsPanel />);
    await waitFor(() => expect(screen.getByText("窗口已打开")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "关闭 Obsidian 的窗口" }));

    await waitFor(() =>
      expect(useUiStore.getState().toast?.kind).toBe("warning"),
    );
    expect(useUiStore.getState().toast?.message ?? "").toContain("还有 1 个窗口未关闭");
  });

  it("结束进程是破坏性动作：菜单选择后需确认，取消不调用后端", async () => {
    seed([targetFix()]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ "target-obs": "has_window" });
    render(<AppsPanel />);
    await waitFor(() => expect(screen.getByText("窗口已打开")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /结束进程/ }));

    expect(navKillTargetProcesses).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: /强制结束「Obsidian」的进程/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(navKillTargetProcesses).not.toHaveBeenCalled();
  });

  it("确认结束进程后调用后端并按结果提示，部分失败如实 warning", async () => {
    seed([targetFix()]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ "target-obs": "process_only" });
    vi.mocked(navKillTargetProcesses).mockResolvedValue({
      matched: 3,
      killed: 2,
      failedPids: [4321],
    });
    render(<AppsPanel />);
    await waitFor(() => expect(screen.getByText("后台运行")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /结束进程/ }));
    const dialog = await screen.findByRole("dialog", { name: /强制结束「Obsidian」的进程/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "结束进程" }));

    await waitFor(() =>
      expect(navKillTargetProcesses).toHaveBeenCalledWith("target-obs"),
    );
    await waitFor(() =>
      expect(useUiStore.getState().toast?.kind).toBe("warning"),
    );
    expect(useUiStore.getState().toast?.message ?? "").toContain("1 个进程结束失败");
    // 结束后刷新运行态快照
    await waitFor(() => expect(navTargetRunningStates).toHaveBeenCalled());
  });

  it("菜单提供「退出应用」（WM_QUIT 优雅档，无需确认），未完全退出如实提示", async () => {
    seed([targetFix()]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ "target-obs": "process_only" });
    vi.mocked(navQuitTargetProcesses).mockResolvedValue({
      processTotal: 2,
      processExited: 1,
      postedThreads: 3,
    });
    render(<AppsPanel />);
    await waitFor(() => expect(screen.getByText("后台运行")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "更多操作：Obsidian" }));
    // 退出应用排在结束进程之前（优雅档优先），且不弹确认
    const quitItem = await screen.findByRole("menuitem", { name: /退出应用/ });
    expect(
      screen.getByRole("menuitem", { name: /结束进程/ }).compareDocumentPosition(quitItem) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    fireEvent.click(quitItem);

    await waitFor(() =>
      expect(navQuitTargetProcesses).toHaveBeenCalledWith("target-obs"),
    );
    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("warning"));
    expect(useUiStore.getState().toast?.message ?? "").toContain("未完全退出（1/2）");
    expect(navKillTargetProcesses).not.toHaveBeenCalled();
    // 退出后刷新运行态快照
    await waitFor(() => expect(navTargetRunningStates).toHaveBeenCalled());
  });

  it("启动成功后安排两次有界补查：慢启动应用窗口晚于返回出现也能跟上状态", async () => {
    vi.useFakeTimers();
    try {
      const t = targetFix();
      seed([t]);
      vi.mocked(navNavigate).mockResolvedValueOnce({
        success: true,
        requested_action: "launch",
        actual_action: "launch",
        fallback_used: false,
        target_id: t.id,
        verification_level: "window-confirmed",
      });
      render(<AppsPanel />);
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "启动 Obsidian" })[0]);
      });
      // 启动流程内的首次运行态查询已完成
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const before = vi.mocked(navTargetRunningStates).mock.calls.length;
      expect(before).toBeGreaterThanOrEqual(1);

      // +2.5s 第一次补查
      await act(async () => {
        vi.advanceTimersByTime(2500);
        await Promise.resolve();
        await Promise.resolve();
      });
      const afterFirst = vi.mocked(navTargetRunningStates).mock.calls.length;
      expect(afterFirst).toBeGreaterThan(before);

      // 累计 +6s 第二次补查
      await act(async () => {
        vi.advanceTimersByTime(3500);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vi.mocked(navTargetRunningStates).mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 应用网格手动排序（与胶囊 AppsLite 同一 lib/appGridOrder 数据源）──

function savedOrderInStorage(): string[] | null {
  const raw = localStorage.getItem(APP_GRID_ORDER_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { version: number; order: string[] };
  return parsed.order;
}

function writeSavedOrder(order: string[]) {
  localStorage.setItem(APP_GRID_ORDER_KEY, JSON.stringify({ version: 1, order }));
}

/** 三应用固定 id/名：a=Obsidian、b=VS Code、c=Zed，避免依赖自然排序细节。 */
function seedThreeApps() {
  seed([
    targetFix({ id: "a", app_key: "obsidian", display_name: "Obsidian" }),
    targetFix({ id: "b", app_key: "code", display_name: "VS Code" }),
    targetFix({ id: "c", app_key: "zed", display_name: "Zed" }),
  ]);
}

function tileNames(): string[] {
  return Array.from(document.querySelectorAll(".apps-tile-name")).map((el) => el.textContent);
}

function mainButtonOf(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name: `启动 ${name}` }) as HTMLButtonElement;
}

function tileOf(name: string): HTMLElement {
  return mainButtonOf(name).closest(".apps-tile") as HTMLElement;
}

describe("AppsPanel 应用网格手动排序", () => {

  // 前置 describe 的 mockResolvedValue 实现会跨用例残留（vi.clearAllMocks 不清除实现），
  // 这里显式复位为「无运行态」，保证排序断言不依赖执行顺序。
  beforeEach(() => {
    vi.mocked(navTargetRunningStates).mockReset();
    vi.mocked(navTargetRunningStates).mockResolvedValue({});
  });

  it("读序：默认「全部」视图按手动序显示；未排序时保持自然规则", async () => {
    seedThreeApps();
    writeSavedOrder(["c", "a", "b"]);
    render(<AppsPanel />);
    await waitFor(() =>
      expect(tileNames()).toEqual(["Zed", "Obsidian", "VS Code"]),
    );
  });

  it("置顶只作展示层叠加：收藏/运行置顶，其余保持手动序；启动不改写手动序", async () => {
    seedThreeApps();
    writeSavedOrder(["c", "a", "b"]);
    vi.mocked(navTargetRunningStates).mockResolvedValue({ a: "has_window" });
    render(<AppsPanel />);
    // 运行中的 Obsidian 置顶，其余保持手动序（Zed 在 VS Code 前）
    await waitFor(() =>
      expect(tileNames()).toEqual(["Obsidian", "Zed", "VS Code"]),
    );

    // 启动成功并刷新清单后，localStorage 手动序不被改写
    vi.mocked(navNavigate).mockResolvedValueOnce({
      success: true,
      requested_action: "launch",
      actual_action: "launch",
      fallback_used: false,
      target_id: "c",
      verification_level: "window-confirmed",
    });
    fireEvent.click(mainButtonOf("Zed"));
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
    expect(savedOrderInStorage()).toEqual(["c", "a", "b"]);
  });

  /**
   * jsdom 没有 DragEvent：fireEvent.dragOver/drop 只能造出普通 Event，
   * clientX 不会带上。这里手工构造带 clientX 与 dataTransfer 的真实事件，
   * 让落点中线判定可以走到 after 分支。
   */
  function fireDrag(el: Element, type: "dragover" | "drop", clientX: number) {
    const event = document.createEvent("Event");
    event.initEvent(type, true, true);
    Object.defineProperty(event, "clientX", { value: clientX });
    Object.defineProperty(event, "dataTransfer", {
      value: { setData: vi.fn(), effectAllowed: "", dropEffect: "" },
    });
    fireEvent(el, event);
  }

  it("拖拽写序：落点中线判定，写回 localStorage + 提示已保存，且不触发启动", async () => {
    seedThreeApps();
    render(<AppsPanel />);
    await screen.findByText("Obsidian");
    expect(screen.queryByText(/手动排序已开启/)).toBeNull();

    // 拖 Obsidian 到 VS Code 右半侧（after=true）
    fireEvent.dragStart(mainButtonOf("Obsidian"), {
      dataTransfer: { effectAllowed: "", setData: vi.fn() },
    });
    fireDrag(tileOf("VS Code"), "dragover", 999);
    expect(tileOf("VS Code").className).toContain("is-drop-after");

    // 前置用例遗留的 warning 可能占满 Toast 队列（上限 3，驱逐策略会丢弃新的
    // success 提示）：断言前先清空队列，保证「顺序已保存」可见。
    useUiStore.setState({ toasts: [], toast: null });
    fireDrag(tileOf("VS Code"), "drop", 999);
    await waitFor(() =>
      expect(savedOrderInStorage()).toEqual(["b", "a", "c", APP_ADD_KEY]),
    );
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.message === "顺序已保存")).toBe(true),
    );
    expect(tileNames()).toEqual(["VS Code", "Obsidian", "Zed"]);
    // 拖拽绝不触发启动
    expect(navNavigate).not.toHaveBeenCalled();
    // 手动序生效后显示排序提示
    expect(screen.getByText(/手动排序已开启/)).toBeTruthy();
  });

  it("拖拽结束的补发 click 不启动应用；真实 pointerdown 后恢复点击", async () => {
    seedThreeApps();
    render(<AppsPanel />);
    await screen.findByText("Obsidian");

    fireEvent.dragStart(mainButtonOf("Obsidian"), {
      dataTransfer: { effectAllowed: "", setData: vi.fn() },
    });
    fireEvent.drop(tileOf("VS Code"), { clientX: 999, dataTransfer: { dropEffect: "" } });
    await waitFor(() => expect(savedOrderInStorage()).toBeTruthy());

    // 浏览器补发的 click（没有 pointerdown）被忽略
    fireEvent.click(mainButtonOf("Obsidian"));
    expect(navNavigate).not.toHaveBeenCalled();

    // 真实点击（先 pointerdown）恢复启动
    fireEvent.pointerDown(mainButtonOf("Zed"));
    fireEvent.click(mainButtonOf("Zed"));
    await waitFor(() => expect(navNavigate).toHaveBeenCalledWith("c"));
  });

  it("键盘 Alt+←/→ 逐格移动并写回", async () => {
    seedThreeApps();
    writeSavedOrder(["c", "a", "b"]);
    render(<AppsPanel />);
    await screen.findByText("Zed");

    // 本页没有加号磁贴，但顺序数组保留胶囊加号占位（跨面板顺序不漂移）
    fireEvent.keyDown(mainButtonOf("Zed"), { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(savedOrderInStorage()).toEqual(["a", "c", "b", APP_ADD_KEY]));

    fireEvent.keyDown(mainButtonOf("Zed"), { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(savedOrderInStorage()).toEqual(["c", "a", "b", APP_ADD_KEY]));

    // 不带 Alt 的方向键不参与排序
    fireEvent.keyDown(mainButtonOf("Zed"), { key: "ArrowRight" });
    expect(savedOrderInStorage()).toEqual(["c", "a", "b", APP_ADD_KEY]);
    expect(navNavigate).not.toHaveBeenCalled();
  });

  it("顺序容错：已删除/隐藏应用自动跳过，新增应用追加在末尾", async () => {
    seedThreeApps();
    writeSavedOrder(["c", "ghost", "a", "b"]);
    render(<AppsPanel />);
    // ghost 不在任何清单里：被 buildAppGrid 跳过，顺序不中断
    await waitFor(() => expect(tileNames()).toEqual(["Zed", "Obsidian", "VS Code"]));

    // 新增应用 d（不在手动序中）追加在末尾
    useNavigationStore.setState((s) => ({
      targets: [
        ...s.targets,
        targetFix({ id: "d", app_key: "delta", display_name: "Delta" }),
      ],
    }));
    await waitFor(() =>
      expect(tileNames()).toEqual(["Zed", "Obsidian", "VS Code", "Delta"]),
    );
  });

  it("保活重读：胶囊里排完序回到完整面板后显示新顺序", async () => {
    seedThreeApps();
    writeSavedOrder(["c", "a", "b"]);
    render(<AppsPanel />);
    await waitFor(() => expect(tileNames()).toEqual(["Zed", "Obsidian", "VS Code"]));

    // 胶囊期间（完整面板 CSS 隐藏）另一面板改写手动序
    writeSavedOrder(["b", "a", "c"]);
    // 完整面板可见性翻转：进入停靠 → 回到 docked-full
    await act(async () => {
      useEdgeSnapStore.setState({ phase: "docked-visible" });
    });
    await act(async () => {
      useEdgeSnapStore.setState({ phase: "docked-full" });
    });
    await waitFor(() => expect(tileNames()).toEqual(["VS Code", "Obsidian", "Zed"]));
  });

  it("收藏/最近/运行筛选不使用手动序（保持各自排序规则）", async () => {
    seed([
      targetFix({ id: "a", app_key: "obsidian", display_name: "Obsidian" }),
      targetFix({ id: "b", app_key: "code", display_name: "VS Code", favorite: true }),
    ]);
    writeSavedOrder(["a", "b"]);
    render(<AppsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "收藏" }));
    // 收藏筛选按名称排序（favorite=false 传给 sortTargetsForDisplay），
    // 不按手动序，也不受置顶叠加影响
    await waitFor(() => expect(tileNames()).toEqual(["VS Code"]));
  });
});
