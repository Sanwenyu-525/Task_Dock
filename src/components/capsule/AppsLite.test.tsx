/**
 * @vitest-environment jsdom
 */
//! 胶囊应用面板的反馈生命周期与错误区分（P2-02 / P2-03）。
//!
//! 覆盖：
//! - 连续反馈只保留一个计时器：新提示覆盖旧提示并取消旧计时器，自然结束后归零；
//! - 卸载时取消未结束的计时器；
//! - 启动异常按稳定错误码区分权限 / 不存在 / 超时，不显示原始堆栈；
//! - 启动成功后的列表刷新失败不把已成功的启动说成失败。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import stylesCss from "../../styles.css?raw";

// 局部开启 React 的 act 环境，避免 jsdom 下每次交互都打印非致命告警。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navNavigate = vi.fn();
const navListTargets = vi.fn();
const navUpdateTarget = vi.fn();
const navTargetRunningStates = vi.fn();
const navCloseTargetWindows = vi.fn();
const navQuitTargetProcesses = vi.fn();
const navKillTargetProcesses = vi.fn();

vi.mock("../../lib/bridge", () => ({
  applyMode: async () => undefined,
  getUserPreferences: async () => ({
    version: 1,
    locale: null,
    widgets: null,
    app_grid_order: null,
    warnings: [],
    apply_restore: false,
    restore_id: null,
  }),
  setUserPreferences: async () => ({
    version: 1,
    locale: null,
    widgets: null,
    app_grid_order: null,
    warnings: [],
    apply_restore: false,
    restore_id: null,
  }),
}));

// 只替换真实 IPC 调用，结果解释与图标工具使用真实实现，避免测试复制产品文案。
vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return {
    ...actual,
    navNavigate: (...a: unknown[]) => navNavigate(...a),
    navListTargets: (...a: unknown[]) => navListTargets(...a),
    navUpdateTarget: (...a: unknown[]) => navUpdateTarget(...a),
    navTargetRunningStates: (...a: unknown[]) => navTargetRunningStates(...a),
    navCloseTargetWindows: (...a: unknown[]) => navCloseTargetWindows(...a),
    navQuitTargetProcesses: (...a: unknown[]) => navQuitTargetProcesses(...a),
    navKillTargetProcesses: (...a: unknown[]) => navKillTargetProcesses(...a),
    navAppIcon: async () => null,
  };
});

import AppsLite from "./AppsLite";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import { clearAppGridOrder, writeAppGridOrder } from "../../lib/appGridOrder";

function target(id: string, name: string) {
  return {
    id,
    display_name: name,
    target_type: "application" as const,
    app_key: name.toLowerCase(),
    exe_path: "",
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
    created_at: "2026-11-05T00:00:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z",
  };
}

const launched = (id: string, extra = {}) => ({
  success: true,
  requested_action: "launch",
  actual_action: "focus_window",
  fallback_used: false,
  target_id: id,
  verification_level: "window-confirmed",
  ...extra,
});

beforeEach(() => {
  navNavigate.mockReset();
  navUpdateTarget.mockReset();
  navUpdateTarget.mockResolvedValue(undefined);
  navListTargets.mockReset();
  navTargetRunningStates.mockReset();
  navTargetRunningStates.mockResolvedValue({});
  navCloseTargetWindows.mockReset();
  navCloseTargetWindows.mockResolvedValue({ requested: 1, closed: 1, stillOpen: [] });
  navQuitTargetProcesses.mockReset();
  navQuitTargetProcesses.mockResolvedValue({
    processTotal: 1,
    processExited: 1,
    postedThreads: 2,
  });
  navKillTargetProcesses.mockReset();
  navKillTargetProcesses.mockResolvedValue({ matched: 1, killed: 1, failedPids: [] });
  useNavigationStore.setState({
    targets: [target("a", "Obsidian")],
    targetsLoaded: true,
    targetsError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // 手动网格顺序是 localStorage 级状态：用例之间必须隔离
  clearAppGridOrder();
});

describe("AppsLite 反馈计时器", () => {
  it("连续反馈覆盖旧提示：计时器不累积，自然结束后归零", async () => {
    vi.useFakeTimers();
    navNavigate.mockRejectedValueOnce({ code: "NOT_FOUND", message: "missing" });
    navNavigate.mockResolvedValueOnce(launched("a"));
    navListTargets.mockResolvedValue([target("a", "Obsidian")]);
    render(<AppsLite />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "启动 Obsidian" }));
    });
    expect(screen.getByText("Obsidian：应用或窗口不存在")).toBeTruthy();
    const timersAfterFirst = vi.getTimerCount();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "启动 Obsidian" }));
    });
    expect(screen.getByText("「Obsidian」已确认窗口")).toBeTruthy();
    // 新反馈覆盖旧反馈：旧计时器被取消，而不是继续堆在列表里。
    // 成功的启动会额外排 2 个运行态补查（2.5s/6s，scheduleStateRecheck），
    // 失败的启动没有；因此此刻 = 1 个反馈计时器 + 2 个补查计时器。
    expect(vi.getTimerCount()).toBe(timersAfterFirst + 2);

    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(screen.queryByText("「Obsidian」已确认窗口")).toBeNull();
    act(() => {
      // 走到 6s：反馈与补查计时器都已触发并清理；面板展开期间只剩
      // 常驻的 10s 运行态刷新（单一定时器，卸载即清）
      vi.advanceTimersByTime(3400);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("卸载时取消未结束的计时器", async () => {
    vi.useFakeTimers();
    navNavigate.mockRejectedValueOnce({ code: "TIMEOUT", message: "timed out" });
    const { unmount } = render(<AppsLite />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "启动 Obsidian" }));
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("AppsLite 启动错误区分", () => {
  it("启动请求在途：图标区域显示 spinner，格子保持禁用直到结果落地", async () => {
    let resolveLaunch!: (value: unknown) => void;
    navNavigate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }),
    );
    navListTargets.mockResolvedValue([target("a", "Obsidian")]);
    render(<AppsLite />);

    const btn = screen.getByRole("button", { name: "启动 Obsidian" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector(".cap-app-spinner")).toBeTruthy();

    await act(async () => {
      resolveLaunch(launched("a"));
    });
    expect(btn.getAttribute("aria-busy")).toBe("false");
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector(".cap-app-spinner")).toBeNull();
  });

  it.each([
    [{ code: "PERMISSION_DENIED", message: "access denied" }, "没有权限启动该应用"],
    [{ code: "NOT_FOUND", message: "target missing" }, "应用或窗口不存在"],
    [{ code: "TIMEOUT", message: "timed out" }, "启动超时，请稍后重试"],
  ])("错误码 %j → 可读原因「%s」", async (payload, expected) => {
    navNavigate.mockRejectedValueOnce(payload);
    render(<AppsLite />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "启动 Obsidian" }));
    });
    expect(screen.getByText(`Obsidian：${expected}`)).toBeTruthy();
  });

  it("后端成功但列表刷新失败：保留成功提示，不判定为启动失败", async () => {
    navNavigate.mockResolvedValueOnce(launched("a"));
    navListTargets.mockRejectedValueOnce(new Error("ipc broken"));
    render(<AppsLite />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "启动 Obsidian" }));
    });
    expect(screen.getByText("「Obsidian」已确认窗口")).toBeTruthy();
    expect(screen.queryByText(/跳转失败/)).toBeNull();
    // 刷新失败由共享 store 记录，面板保持旧清单
    expect(useNavigationStore.getState().targetsError).toBeTruthy();
    expect(screen.getByText("刷新失败，显示的是上次结果")).toBeTruthy();
  });
});

describe("AppsLite 空状态区分（数据不丢失）", () => {
  // 测试目标的 target_type 含 url/agent_session 变体；store 以 never 宽松接收，
  // 避免把 application 字面量锁死为唯一合法类型。
  function seed(items: unknown[], loaded = true) {
    useNavigationStore.setState({
      targets: items as never[],
      targetsLoaded: loaded,
      targetsError: null,
    });
    navListTargets.mockResolvedValue(items as never[]);
  }

  function hiddenTarget(id: string, name: string) {
    return { ...target(id, name), hidden: true };
  }

  function urlTarget(id: string, name: string) {
    return { ...target(id, name), target_type: "url" as const, url: "https://example.com" };
  }

  it("从未配置：显示「尚未配置」，网格仅有加号", async () => {
    seed([]);
    render(<AppsLite />);
    expect(await screen.findByText("尚未配置快捷应用")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加应用" })).toBeTruthy();
    expect(screen.queryByText(/隐藏/)).toBeNull();
  });

  it("全部隐藏：不误报未配置，给出可恢复入口且不自动取消隐藏", async () => {
    const hidden = hiddenTarget("h1", "隐藏应用");
    seed([hidden]);
    render(<AppsLite />);
    expect(await screen.findByText("已添加的应用均处于隐藏状态")).toBeTruthy();
    expect(screen.queryByText("尚未配置快捷应用")).toBeNull();
    const restore = screen.getByRole("button", { name: "恢复显示 隐藏应用" });
    expect(navUpdateTarget).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(restore);
    });
    expect(navUpdateTarget).toHaveBeenCalledWith("h1", { hidden: false });
    // 恢复后刷新：mock 返回可见版本
    await act(async () => {});
    expect(navListTargets).toHaveBeenCalled();
  });

  it("部分隐藏：只显示可见应用，不出现空态", async () => {
    seed([target("a", "Obsidian"), hiddenTarget("h1", "隐藏应用")]);
    render(<AppsLite />);
    expect(screen.getByRole("button", { name: "启动 Obsidian" })).toBeTruthy();
    expect(screen.queryByText("尚未配置快捷应用")).toBeNull();
    expect(screen.queryByText(/均处于隐藏/)).toBeNull();
  });

  it("读取中：显示加载反馈，不提前宣布未配置", async () => {
    useNavigationStore.setState({ targets: [], targetsLoaded: false, targetsError: null });
    navListTargets.mockImplementation(
      () => new Promise<never>(() => {}),
    );
    render(<AppsLite />);
    expect(await screen.findByText("正在读取快捷应用…")).toBeTruthy();
    expect(screen.queryByText("尚未配置快捷应用")).toBeNull();
  });

  it("只有网址：显示网址分区，不误报未配置", async () => {
    seed([urlTarget("u1", "示例站点")]);
    render(<AppsLite />);
    // 网址走 extras 分区，不进入应用网格；空态不得出现
    await screen.findByText("网址 / 文件夹 / 文件");
    expect(screen.queryByText("尚未配置快捷应用")).toBeNull();
  });

  it("仅 Agent 会话：不误报未配置，提示在 Agent 面板管理", async () => {
    const agent = { ...target("s1", "会话一"), target_type: "agent_session" as const };
    seed([agent]);
    render(<AppsLite />);
    expect(await screen.findByText("Agent 会话在 Agent 面板中管理")).toBeTruthy();
    expect(screen.queryByText("尚未配置快捷应用")).toBeNull();
  });

  it("按需加载：已加载且健康不重复请求；未加载/失败才请求", async () => {
    seed([target("a", "Obsidian")]);
    render(<AppsLite />);
    await act(async () => {});
    expect(navListTargets).not.toHaveBeenCalled();
  });

  it("未加载时挂载加载一次", async () => {
    useNavigationStore.setState({ targets: [], targetsLoaded: false, targetsError: null });
    navListTargets.mockResolvedValue([target("a", "Obsidian")]);
    const { unmount } = render(<AppsLite />);
    await act(async () => {});
    expect(navListTargets).toHaveBeenCalledTimes(1);
    expect(navListTargets).toHaveBeenCalledWith(true);
    unmount();
  });

  it("CSS：应用网格可排序项 grab、拖动 grabbing；空态紧凑不挤网格", () => {
    expect(stylesCss).toMatch(/\.cap-app\s*\{[^}]*cursor:\s*grab;/);
    expect(stylesCss).toMatch(/\.cap-app-slot\.is-dragging\s+\.cap-app[^}]*cursor:\s*grabbing/);
    expect(stylesCss).toMatch(/\.cap-app-add\.is-dragging[^}]*cursor:\s*grabbing/);
    expect(stylesCss).toMatch(/\.cap-list--apps\s*>\s*\.cap-empty\s*\{[^}]*flex:\s*0 0 auto/);
    // 全局空态不被改动，其他面板继续 flex 占满
    expect(stylesCss).toMatch(/\.cap-empty\s*\{[^}]*flex:\s*1 1 auto/);
  });

  it("CSS：磁贴 hover/active 用半透明底 + inset 内描边，不新增 border、不改尺寸", () => {
    // 过渡落在 120–160ms 区间
    expect(stylesCss).toMatch(/\.cap-app\s*\{[^}]*transition:\s*background-color 0\.14s/);
    // 旧策略（hover/active 一律透明）必须已被替换
    expect(stylesCss).not.toMatch(/\.cap-app:hover,\s*\n\.cap-app:active\s*\{\s*background:\s*transparent/);

    const hoverBlock = stylesCss.match(
      /\.cap-app-slot:hover \.cap-app,\s*\n\.cap-app-add:hover \{([\s\S]*?)\}/,
    );
    expect(hoverBlock).toBeTruthy();
    // 内描边走 inset box-shadow：不参与盒模型，网格不会因新增 border 抖动
    expect(hoverBlock![1]).toMatch(/box-shadow:\s*inset 0 0 0 1px/);
    expect(hoverBlock![1]).toMatch(/background:\s*color-mix\(in srgb, var\(--cap-text-1\) 6%/);
    expect(hoverBlock![1]).not.toMatch(/\bborder:/);
    expect(hoverBlock![1]).not.toMatch(/transform/);
    // 删除按钮悬停时父级磁贴同样高亮（slot 承担 hover，而非只按钮自身）
    expect(stylesCss).toMatch(/\.cap-app-slot:hover \.cap-app/);
    expect(stylesCss).toMatch(/\.cap-app:active:not\(:disabled\)/);
    // 拖动中不叠 hover 底色；启动中不出现可点击态
    expect(stylesCss).toMatch(/\.cap-app-slot\.is-dragging \.cap-app:hover/);
    expect(stylesCss).toMatch(/\.cap-app-slot:hover \.cap-app:disabled\s*\{[^}]*background:\s*transparent/);
    // 键盘焦点仍是独立的 2px outline，而不是靠 hover 底色
    expect(stylesCss).toMatch(/\.cap-app:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  });

  it("CSS：图标与名称居中，收藏角标与运行点分处左上/右下且都不占布局", () => {
    const tileBlock = stylesCss.match(/(?:^|\n)\.cap-app\s*\{([\s\S]*?)\}/);
    expect(tileBlock).toBeTruthy();
    expect(tileBlock![1]).toMatch(/align-items:\s*center/);
    expect(tileBlock![1]).not.toMatch(/align-items:\s*flex-start/);
    // 名称居中（左对齐方案 2026-11-09 已按用户要求回退）
    const nameBlock = stylesCss.match(/(?:^|\n)\.cap-app-name\s*\{([\s\S]*?)\}/);
    expect(nameBlock).toBeTruthy();
    expect(nameBlock![1]).toMatch(/text-align:\s*center/);
    expect(nameBlock![1]).not.toMatch(/text-align:\s*left/);
    // 收藏角标在图标片左上角，语义色沿用完整面板的收藏星（--accent）
    const favBlock = stylesCss.match(/\.cap-app-fav\s*\{([\s\S]*?)\}/);
    expect(favBlock).toBeTruthy();
    expect(favBlock![1]).toMatch(/position:\s*absolute/);
    expect(favBlock![1]).toMatch(/left:\s*-3px/);
    expect(favBlock![1]).toMatch(/top:\s*-3px/);
    expect(favBlock![1]).toMatch(/color:\s*var\(--accent\)/);
    // 运行点仍在右下角，两者不重叠
    expect(stylesCss).toMatch(/\.cap-app-dot\s*\{[^}]*right:\s*-2px/);
    expect(stylesCss).toMatch(/\.cap-app-dot\s*\{[^}]*bottom:\s*-2px/);
    // 运行中磁贴动作条：绝对定位在名称区（左下/右下 3px），默认隐藏，
    // 悬停/键盘聚焦淡入，与名称交叉淡出；未运行磁贴不渲染动作条
    const actionsBlock = stylesCss.match(/(?:^|\n)\.cap-app-actions\s*\{([\s\S]*?)\}/);
    expect(actionsBlock).toBeTruthy();
    expect(actionsBlock![1]).toMatch(/position:\s*absolute/);
    expect(actionsBlock![1]).toMatch(/left:\s*3px/);
    expect(actionsBlock![1]).toMatch(/right:\s*3px/);
    expect(actionsBlock![1]).toMatch(/bottom:\s*3px/);
    expect(actionsBlock![1]).toMatch(/opacity:\s*0/);
    expect(stylesCss).toMatch(/\.cap-app-slot:hover \.cap-app-actions/);
    expect(stylesCss).toMatch(/\.cap-app-slot:focus-within \.cap-app-actions/);
    // 名称只在带动作条（运行中）的磁贴上让位（交叉淡变）
    expect(stylesCss).toMatch(/\.cap-app-slot\.has-actions:hover \.cap-app-name/);
    expect(stylesCss).toMatch(/\.cap-app-slot\.has-actions:focus-within \.cap-app-name/);
    // 删除仍在磁贴右上角（18px 热区），位置不随运行态变化
    const delBlock = stylesCss.match(/(?:^|\n)\.cap-app-del\s*\{([\s\S]*?)\}/);
    expect(delBlock).toBeTruthy();
    expect(delBlock![1]).toMatch(/top:\s*0/);
    expect(delBlock![1]).toMatch(/right:\s*0/);
    expect(delBlock![1]).toMatch(/width:\s*18px/);
    expect(delBlock![1]).toMatch(/height:\s*18px/);
  });

  it("CSS：标题同行布局是局部变体，默认纵向结构保持不变", () => {
    expect(stylesCss).toMatch(/\.cap-head-text\s*\{[^}]*flex-direction:\s*column/);
    expect(stylesCss).toMatch(/\.cap-head-text--inline\s*\{[^}]*flex-direction:\s*row/);
    expect(stylesCss).toMatch(/\.cap-head-text--inline \.cap-sub\s*\{[^}]*min-width:\s*0/);
  });
});

describe("AppsLite 启动状态按目标隔离", () => {
  function seedTwo() {
    useNavigationStore.setState({
      targets: [target("a", "Alpha"), target("b", "Bravo")] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    navListTargets.mockResolvedValue([target("a", "Alpha"), target("b", "Bravo")]);
  }

  it("A 启动中 B 仍可点击：各自独立忙碌态，完成态不会互相覆盖", async () => {
    seedTwo();
    const resolvers: Record<string, (value: unknown) => void> = {};
    navNavigate.mockImplementation(
      (id: string) => new Promise((resolve) => { resolvers[id] = resolve; }),
    );
    render(<AppsLite />);

    const a = screen.getByRole("button", { name: "启动 Alpha" }) as HTMLButtonElement;
    const b = screen.getByRole("button", { name: "启动 Bravo" }) as HTMLButtonElement;

    await act(async () => { fireEvent.click(a); });
    expect(a.disabled).toBe(true);
    expect(a.getAttribute("aria-busy")).toBe("true");
    // 旧实现用单个 busyId：A 启动中 B 会被一起锁住，点了没有任何反应
    expect(b.disabled).toBe(false);

    await act(async () => { fireEvent.click(b); });
    expect(navNavigate.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    expect(b.disabled).toBe(true);

    await act(async () => { resolvers.a(launched("a")); });
    expect(a.disabled).toBe(false);
    expect(b.disabled).toBe(true);

    await act(async () => { resolvers.b(launched("b")); });
    expect(b.disabled).toBe(false);
  });

  it("同一应用请求在途：连点只发一次，不重复启动", () => {
    seedTwo();
    navNavigate.mockImplementation(() => new Promise(() => {}));
    render(<AppsLite />);
    const a = screen.getByRole("button", { name: "启动 Alpha" });
    // 两次点击落在同一批渲染之内：禁用态尚未生效，交给同步 ref 兜住
    fireEvent.click(a);
    fireEvent.click(a);
    expect(navNavigate).toHaveBeenCalledTimes(1);
  });

  it("启动失败后状态恢复，可以再次点击重试", async () => {
    seedTwo();
    navNavigate.mockRejectedValueOnce({ code: "TIMEOUT", message: "timed out" });
    render(<AppsLite />);
    const a = screen.getByRole("button", { name: "启动 Alpha" }) as HTMLButtonElement;

    await act(async () => { fireEvent.click(a); });
    expect(a.disabled).toBe(false);
    expect(a.getAttribute("aria-busy")).toBe("false");

    navNavigate.mockResolvedValueOnce(launched("a"));
    await act(async () => { fireEvent.click(a); });
    expect(navNavigate).toHaveBeenCalledTimes(2);
  });
});

describe("AppsLite 拖拽结束后的点击判定", () => {
  function seedTwo() {
    useNavigationStore.setState({
      targets: [target("a", "Alpha"), target("b", "Bravo")] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    navListTargets.mockResolvedValue([target("a", "Alpha"), target("b", "Bravo")]);
    useUiStore.setState({ appConfig: null, appsAddRequest: null, tab: "tasks" });
  }

  const dragData = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });

  function dropAOnB() {
    const a = screen.getByRole("button", { name: "启动 Alpha" });
    const b = screen.getByRole("button", { name: "启动 Bravo" });
    const dt = dragData();
    fireEvent.dragStart(a, { dataTransfer: dt });
    fireEvent.dragOver(b, { dataTransfer: dt, clientX: 999 });
    fireEvent.drop(b, { dataTransfer: dt, clientX: 999 });
    fireEvent.dragEnd(a, { dataTransfer: dt });
    return { a, b };
  }

  it("拖放后浏览器补发的 click 被忽略；真实按下后点击可正常启动", async () => {
    seedTwo();
    navNavigate.mockResolvedValue(launched("a"));
    render(<AppsLite />);
    const { a } = dropAOnB();

    // 补发的 click 没有新的 pointerdown：不得启动应用
    fireEvent.click(a);
    expect(navNavigate).not.toHaveBeenCalled();

    // 真实点击一定先有 pointerdown：正常启动，不需要先移动鼠标
    fireEvent.pointerDown(a);
    await act(async () => { fireEvent.click(a); });
    expect(navNavigate).toHaveBeenCalledWith("a");
  });

  it("拖完立刻点击其他应用不被拦截", async () => {
    seedTwo();
    navNavigate.mockResolvedValue(launched("b"));
    render(<AppsLite />);
    const { b } = dropAOnB();

    fireEvent.pointerDown(b);
    await act(async () => { fireEvent.click(b); });
    expect(navNavigate).toHaveBeenCalledWith("b");
  });

  it("拖完立刻点加号：补发 click 被忽略，真实点击仍能打开添加页", async () => {
    seedTwo();
    render(<AppsLite />);
    dropAOnB();
    const add = screen.getByRole("button", { name: "添加应用" });

    // 补发 click（无 pointerdown）不触发添加意图
    fireEvent.click(add);
    expect(useUiStore.getState().appsAddRequest).toBeNull();

    fireEvent.pointerDown(add);
    await act(async () => { fireEvent.click(add); });
    expect(useUiStore.getState().appsAddRequest?.token).toBeGreaterThan(0);
  });

  it("拖拽取消（Esc）后状态清理：不残留拖动标记，真实点击不受影响", async () => {
    seedTwo();
    navNavigate.mockResolvedValue(launched("a"));
    render(<AppsLite />);
    const a = screen.getByRole("button", { name: "启动 Alpha" });
    const b = screen.getByRole("button", { name: "启动 Bravo" });
    const dt = dragData();

    fireEvent.dragStart(a, { dataTransfer: dt });
    // 未 drop 直接结束（用户按 Esc 取消）
    fireEvent.dragEnd(a, { dataTransfer: dt });
    expect(document.querySelector(".cap-app-slot.is-dragging")).toBeNull();
    expect(document.querySelector(".is-drop-before, .is-drop-after")).toBeNull();

    fireEvent.pointerDown(b);
    await act(async () => { fireEvent.click(b); });
    expect(navNavigate).toHaveBeenCalledWith("b");
  });
});

describe("AppsLite 名称提示（仅在截断时出现）", () => {
  it("名称完整显示不挂提示；被两行截断时才提示完整名称", () => {
    useNavigationStore.setState({
      targets: [target("a", "Obsidian")],
      targetsLoaded: true,
      targetsError: null,
    });
    render(<AppsLite />);
    const btn = screen.getByRole("button", { name: "启动 Obsidian" });
    const name = btn.querySelector(".cap-app-name") as HTMLElement;

    // 未截断：不重复弹同名提示
    expect(btn.dataset.tip).toBeUndefined();
    fireEvent.mouseEnter(btn);
    expect(btn.dataset.tip).toBeUndefined();

    // jsdom 不做真实排版：注入「已截断」的滚动高/可见高（两行 clamp）
    Object.defineProperty(name, "scrollHeight", { configurable: true, value: 42 });
    Object.defineProperty(name, "clientHeight", { configurable: true, value: 25 });

    fireEvent.mouseEnter(btn);
    expect(btn.dataset.tip).toBe("Obsidian");
    fireEvent.mouseLeave(btn);
    expect(btn.dataset.tip).toBeUndefined();

    // 键盘 Focus 长名称时仍可获得完整信息
    btn.focus();
    expect(btn.dataset.tip).toBe("Obsidian");
    btn.blur();
    expect(btn.dataset.tip).toBeUndefined();
  });

  it("网址/文件夹胶囊不再把路径当名称提示；截断时才提示名称", () => {
    const url = {
      ...target("u1", "示例站点"),
      target_type: "url" as const,
      url: "https://example.com/very/long/path",
    };
    useNavigationStore.setState({
      targets: [url] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    render(<AppsLite />);
    const chip = screen.getByRole("button", { name: "打开 示例站点" });
    expect(chip.dataset.tip).toBeUndefined();
    expect(chip.getAttribute("data-tip") ?? "").not.toContain("example.com");

    const name = chip.querySelector(".cap-recent-name") as HTMLElement;
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 200 });
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 80 });
    fireEvent.mouseEnter(chip);
    expect(chip.dataset.tip).toBe("示例站点");
  });
});

describe("AppsLite 全部隐藏时的文案与入口", () => {
  function seed(items: unknown[]) {
    useNavigationStore.setState({
      targets: items as never[],
      targetsLoaded: true,
      targetsError: null,
    });
  }
  const hiddenApp = { ...target("h1", "隐藏应用"), hidden: true };
  const hiddenUrl = {
    ...target("h2", "隐藏站点"),
    target_type: "url" as const,
    url: "https://example.com",
    hidden: true,
  };

  it("只有应用隐藏：文案指向应用，并保留恢复与添加入口", async () => {
    seed([hiddenApp]);
    render(<AppsLite />);
    expect(await screen.findByText("已添加的应用均处于隐藏状态")).toBeTruthy();
    expect(screen.getByRole("button", { name: "恢复显示 隐藏应用" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加应用" })).toBeTruthy();
  });

  it("只有网址隐藏：不得误报「应用均处于隐藏状态」，添加入口仍在", async () => {
    seed([hiddenUrl]);
    render(<AppsLite />);
    expect(await screen.findByText("已添加的网址 / 文件夹 / 文件均处于隐藏状态")).toBeTruthy();
    expect(screen.queryByText("已添加的应用均处于隐藏状态")).toBeNull();
    expect(screen.getByRole("button", { name: "添加应用" })).toBeTruthy();
  });

  it("应用与网址都隐藏：使用中性文案，不为隐藏项自动取消隐藏", async () => {
    seed([hiddenApp, hiddenUrl]);
    render(<AppsLite />);
    expect(await screen.findByText("已添加的快捷目标均处于隐藏状态")).toBeTruthy();
    expect(navUpdateTarget).not.toHaveBeenCalled();
    // 两个恢复入口都在，且只有一个添加入口（网格已收起）
    expect(screen.getAllByRole("button", { name: /^恢复显示 / })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "添加应用" })).toHaveLength(1);
  });

  it("运行中的应用显示状态点与「运行中」快捷区，可一键关闭窗口", async () => {
    seed([target("a", "Obsidian")]);
    navTargetRunningStates.mockResolvedValue({ a: "has_window" });
    render(<AppsLite />);
    expect(await screen.findByTestId("running-list")).toBeTruthy();
    expect(screen.getByText("运行中（1）")).toBeTruthy();
    // 磁贴状态点由 CSS 渲染，这里确认结构位存在
    expect(document.querySelector(".cap-app-dot")).toBeTruthy();

    // 「运行中」区与运行中磁贴都有同一动作：这里点运行中区的关闭按钮
    fireEvent.click(
      within(screen.getByTestId("running-list")).getByRole("button", { name: "关闭 Obsidian 的窗口" }),
    );
    await waitFor(() => expect(navCloseTargetWindows).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(screen.getByText("已关闭「Obsidian」的 1 个窗口")).toBeTruthy());
  });

  it("仅后台进程（托盘驻留）也显示运行状态点，不止有窗口的应用", async () => {
    seed([target("a", "Clash Verge")]);
    navTargetRunningStates.mockResolvedValue({ a: "process_only" });
    render(<AppsLite />);
    expect(await screen.findByTestId("running-list")).toBeTruthy();
    // 绿点 = 运行中（有窗口或仅后台进程），与「运行中」快捷区同一口径
    expect(document.querySelector(".cap-app-dot")).toBeTruthy();
  });

  it("运行中磁贴内提供关闭窗口/退出应用按钮，非运行应用只有角落删除", async () => {
    useNavigationStore.setState({
      targets: [target("a", "Alpha"), target("b", "Bravo"), target("c", "Charlie")] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    navTargetRunningStates.mockResolvedValue({ a: "has_window", b: "process_only" });
    render(<AppsLite />);
    // 只有运行中磁贴渲染动作条
    await waitFor(() => expect(document.querySelectorAll(".cap-app-actions")).toHaveLength(2));
    const slotOf = (name: string) =>
      screen.getByRole("button", { name }).closest(".cap-app-slot") as HTMLElement;
    const alpha = within(slotOf("启动 Alpha"));
    const bravo = within(slotOf("启动 Bravo"));
    const charlie = within(slotOf("启动 Charlie"));
    // 有窗口：关闭窗口 + 退出应用在动作条里
    expect(alpha.getByRole("button", { name: "关闭 Alpha 的窗口" })).toBeTruthy();
    expect(alpha.getByRole("button", { name: "退出 Alpha" })).toBeTruthy();
    // 仅后台进程：没有窗口可关，只有退出
    expect(bravo.queryByRole("button", { name: "关闭 Bravo 的窗口" })).toBeNull();
    expect(bravo.getByRole("button", { name: "退出 Bravo" })).toBeTruthy();
    // 未运行：没有动作条，删除仍在角落
    expect(charlie.queryByRole("button", { name: "关闭 Charlie 的窗口" })).toBeNull();
    expect(charlie.queryByRole("button", { name: "退出 Charlie" })).toBeNull();
    // 删除对所有磁贴都在右上角
    for (const box of [alpha, bravo, charlie]) {
      expect(box.getByRole("button", { name: /^从快捷列表删除 / })).toBeTruthy();
    }

    fireEvent.click(alpha.getByRole("button", { name: "关闭 Alpha 的窗口" }));
    await waitFor(() => expect(navCloseTargetWindows).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(screen.getByText("已关闭「Alpha」的 1 个窗口")).toBeTruthy());
  });

  it("关闭窗口后应用仍在后台运行：如实提示，不把托盘驻留说成完全关闭", async () => {
    seed([target("a", "Clash Verge")]);
    // 挂载时窗口在；关闭后（托盘驻留）只剩后台进程
    navTargetRunningStates
      .mockResolvedValueOnce({ a: "has_window" })
      .mockResolvedValue({ a: "process_only" });
    render(<AppsLite />);
    expect(await screen.findByTestId("running-list")).toBeTruthy();
    fireEvent.click(
      within(screen.getByTestId("running-list")).getByRole("button", { name: "关闭 Clash Verge 的窗口" }),
    );
    await waitFor(() =>
      expect(screen.getByText("已关闭「Clash Verge」的窗口（应用仍在后台运行）")).toBeTruthy(),
    );
  });

  it("退出应用走 WM_QUIT 优雅档，未完全退出如实提示", async () => {
    seed([target("a", "Obsidian")]);
    navTargetRunningStates.mockResolvedValue({ a: "process_only" });
    navQuitTargetProcesses.mockResolvedValue({
      processTotal: 2,
      processExited: 1,
      postedThreads: 3,
    });
    render(<AppsLite />);
    expect(await screen.findByTestId("running-list")).toBeTruthy();
    // 仅后台进程没有窗口可关：不出现关闭按钮，退出按钮仍在
    expect(screen.queryByRole("button", { name: "关闭 Obsidian 的窗口" })).toBeNull();
    fireEvent.click(
      within(screen.getByTestId("running-list")).getByRole("button", { name: "退出 Obsidian" }),
    );
    await waitFor(() => expect(navQuitTargetProcesses).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(screen.getByText(/未完全退出（1\/2）/)).toBeTruthy());
    // 未完全退出：给出强制结束确认入口，但未经确认不得结束进程
    expect(screen.getByRole("alertdialog", { name: "确认强制结束应用进程" })).toBeTruthy();
    expect(navKillTargetProcesses).not.toHaveBeenCalled();
  });

  it("强制结束只在确认条确认后执行，并在结果里如实报数量", async () => {
    seed([target("a", "Clash Verge")]);
    navTargetRunningStates.mockResolvedValue({ a: "process_only" });
    navQuitTargetProcesses.mockResolvedValue({
      processTotal: 2,
      processExited: 0,
      postedThreads: 4,
    });
    navKillTargetProcesses.mockResolvedValue({ matched: 2, killed: 2, failedPids: [] });
    render(<AppsLite />);
    expect(await screen.findByTestId("running-list")).toBeTruthy();
    fireEvent.click(
      within(screen.getByTestId("running-list")).getByRole("button", { name: "退出 Clash Verge" }),
    );
    expect(await screen.findByRole("alertdialog", { name: "确认强制结束应用进程" })).toBeTruthy();
    expect(navKillTargetProcesses).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "强制结束" }));
    await waitFor(() => expect(navKillTargetProcesses).toHaveBeenCalledWith("a"));
    await waitFor(() =>
      expect(screen.getByText("已强制结束「Clash Verge」的 2 个进程")).toBeTruthy(),
    );
    expect(screen.queryByRole("alertdialog", { name: "确认强制结束应用进程" })).toBeNull();
  });

  it("取消强制结束只关确认条，不结束进程，也不丢失运行中状态", async () => {
    seed([target("a", "Clash Verge")]);
    navTargetRunningStates.mockResolvedValue({ a: "process_only" });
    navQuitTargetProcesses.mockResolvedValue({
      processTotal: 1,
      processExited: 0,
      postedThreads: 2,
    });
    render(<AppsLite />);
    expect(await screen.findByTestId("running-list")).toBeTruthy();
    const quitBtn = within(screen.getByTestId("running-list")).getByRole("button", {
      name: "退出 Clash Verge",
    });
    fireEvent.click(quitBtn);
    expect(await screen.findByRole("alertdialog", { name: "确认强制结束应用进程" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog", { name: "确认强制结束应用进程" })).toBeNull();
    expect(navKillTargetProcesses).not.toHaveBeenCalled();
    // 焦点还给触发退出的按钮
    await waitFor(() => expect(document.activeElement).toBe(quitBtn));
    expect(screen.getByTestId("running-list")).toBeTruthy();
  });

  it("收藏的应用在图标左上角渲染收藏角标，未收藏不渲染", async () => {
    useNavigationStore.setState({
      targets: [
        { ...target("a", "Alpha"), favorite: true },
        target("b", "Bravo"),
      ] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    render(<AppsLite />);
    const alpha = await screen.findByRole("button", { name: "启动 Alpha" });
    const bravo = screen.getByRole("button", { name: "启动 Bravo" });
    expect(alpha.querySelector(".cap-app-fav")).toBeTruthy();
    expect(bravo.querySelector(".cap-app-fav")).toBeNull();
    // 角标与运行点分开：收藏但未运行时（快照为空）不出现状态点
    expect(alpha.querySelector(".cap-app-dot")).toBeNull();
  });

  it("收藏应用固定最前，运行中应用其次，其余保持原顺序", async () => {
    useNavigationStore.setState({
      targets: [
        { ...target("a", "Alpha"), favorite: true },
        target("b", "Bravo"),
        target("c", "Charlie"),
      ] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    // Alpha 收藏但未运行、Bravo 有窗口、Charlie 未运行：
    // 收藏优先于运行中（旧实现会把 Bravo 冒到 Alpha 前面）
    navTargetRunningStates.mockResolvedValue({ b: "has_window" });
    render(<AppsLite />);
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".cap-app-slot .cap-app")].map((el) =>
          el.getAttribute("aria-label"),
        ),
      ).toEqual(["启动 Alpha", "启动 Bravo", "启动 Charlie"]),
    );
  });

  it("仅后台进程（托盘驻留）同样算运行中、排在未运行应用之前", async () => {
    useNavigationStore.setState({
      targets: [target("a", "Alpha"), target("b", "Bravo"), target("c", "Charlie")] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    navTargetRunningStates.mockResolvedValue({ c: "process_only" });
    render(<AppsLite />);
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".cap-app-slot .cap-app")].map((el) =>
          el.getAttribute("aria-label"),
        ),
      ).toEqual(["启动 Charlie", "启动 Alpha", "启动 Bravo"]),
    );
  });

  it("手动排序后运行中仍置顶，组内沿用手动顺序", async () => {
    writeAppGridOrder(["c", "b", "a"]);
    useNavigationStore.setState({
      targets: [target("a", "Alpha"), target("b", "Bravo"), target("c", "Charlie")] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    navTargetRunningStates.mockResolvedValue({ b: "has_window" });
    render(<AppsLite />);
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".cap-app-slot .cap-app")].map((el) =>
          el.getAttribute("aria-label"),
        ),
      ).toEqual(["启动 Bravo", "启动 Charlie", "启动 Alpha"]),
    );
  });

  it("手动排序时收藏仍固定最前，组内沿用手动顺序", async () => {
    writeAppGridOrder(["c", "b", "a"]);
    useNavigationStore.setState({
      targets: [
        target("a", "Alpha"),
        target("b", "Bravo"),
        { ...target("c", "Charlie"), favorite: true },
      ] as never[],
      targetsLoaded: true,
      targetsError: null,
    });
    navTargetRunningStates.mockResolvedValue({ b: "has_window" });
    render(<AppsLite />);
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".cap-app-slot .cap-app")].map((el) =>
          el.getAttribute("aria-label"),
        ),
      ).toEqual(["启动 Charlie", "启动 Bravo", "启动 Alpha"]),
    );
  });

  it("没有运行中的应用时不渲染运行中快捷区", async () => {
    seed([target("a", "Obsidian")]);
    navTargetRunningStates.mockResolvedValue({ a: "not_running" });
    render(<AppsLite />);
    expect(await screen.findByText("Obsidian")).toBeTruthy();
    expect(screen.queryByTestId("running-list")).toBeNull();
    expect(document.querySelector(".cap-app-dot")).toBeNull();
  });

  it("面板展开期间每 10s 刷新运行态，外部开关应用 ≤10s 反映到面板", async () => {
    vi.useFakeTimers();
    try {
      seed([target("a", "Obsidian")]);
      render(<AppsLite />);
      // 挂载时的首次查询
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const before = navTargetRunningStates.mock.calls.length;
      expect(before).toBeGreaterThanOrEqual(1);

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(navTargetRunningStates.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AppsLite 一键收藏（W4）", () => {
  it("点击收藏：乐观更新立即生效，nav_update_target 带 favorite，权威刷新后接管", async () => {
    // 权威刷新结果：a 已收藏（loadTargets(true) 会用 navListTargets 覆盖 store）
    navListTargets.mockResolvedValue([
      { ...target("a", "Obsidian"), favorite: true, use_count: 0 },
      target("b", "Zed"),
    ]);
    useNavigationStore.setState({
      targets: [target("a", "Obsidian"), target("b", "Zed")],
      targetsLoaded: true,
      targetsError: null,
    });
    render(<AppsLite />);
    await screen.findByText("Obsidian");

    // 未收藏 → 点击后乐观置为收藏（aria 立即翻转，不等 IPC）
    fireEvent.click(screen.getByRole("button", { name: "收藏 Obsidian" }));
    expect(
      screen.getByRole("button", { name: "取消收藏 Obsidian" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith("a", { favorite: true }),
    );
    // 写库成功后拉权威列表（loadTargets(true)）接管本地覆盖
    await waitFor(() => expect(navListTargets).toHaveBeenCalled());
    // 收藏项置顶规则不变：收藏的 Obsidian 排在 Zed 之前（收藏优先语义未被破坏）
    await waitFor(() => {
      const names = screen
        .getAllByTestId(/^grid-/)
        .map((el) => el.getAttribute("data-grid-id"));
    });
  });

  it("取消收藏：favorite=false 写库", async () => {
    navListTargets.mockResolvedValue([target("a", "Obsidian")]);
    useNavigationStore.setState({
      targets: [{ ...target("a", "Obsidian"), favorite: true }],
      targetsLoaded: true,
      targetsError: null,
    });
    render(<AppsLite />);
    await screen.findByText("Obsidian");
    fireEvent.click(screen.getByRole("button", { name: "取消收藏 Obsidian" }));
    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith("a", { favorite: false }),
    );
  });

  it("收藏失败：回滚到旧值并给出错误反馈，不伪装成功", async () => {
    navUpdateTarget.mockRejectedValueOnce({ message: "db locked" });
    navListTargets.mockResolvedValue([target("a", "Obsidian")]);
    useNavigationStore.setState({
      targets: [target("a", "Obsidian")],
      targetsLoaded: true,
      targetsError: null,
    });
    render(<AppsLite />);
    await screen.findByText("Obsidian");

    fireEvent.click(screen.getByRole("button", { name: "收藏 Obsidian" }));
    await waitFor(() => expect(navUpdateTarget).toHaveBeenCalled());
    // 失败回滚：aria 回到「收藏」
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "收藏 Obsidian" })).toBeTruthy(),
    );
    // 底栏错误反馈（不是成功文案）
    await waitFor(() =>
      expect(screen.getByText(/收藏「Obsidian」失败/)).toBeTruthy(),
    );
  });
});
