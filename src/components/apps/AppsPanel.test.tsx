/**
 * @vitest-environment jsdom
 */
//! 应用中心行为测试：入口渲染、搜索/筛选、运行中真实数据源、添加、收藏、
//! 启动成功刷新最近使用、失败不刷新、删除确认、全部应用（不截断）、分区。
//! 后端命令全部 mock，store 用真实实例（共享状态语义）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import AppsPanel from "./AppsPanel";
import {
  navDeleteTarget,
  navListTargets,
  navNavigate,
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
});

afterEach(cleanup);

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
});
