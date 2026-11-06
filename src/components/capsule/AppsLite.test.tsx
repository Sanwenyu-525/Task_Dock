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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import stylesCss from "../../styles.css?raw";

// 局部开启 React 的 act 环境，避免 jsdom 下每次交互都打印非致命告警。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navNavigate = vi.fn();
const navListTargets = vi.fn();
const navUpdateTarget = vi.fn();

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
    navAppIcon: async () => null,
  };
});

import AppsLite from "./AppsLite";
import { useNavigationStore } from "../../store/useNavigationStore";

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
  useNavigationStore.setState({
    targets: [target("a", "Obsidian")],
    targetsLoaded: true,
    targetsError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    // 新反馈覆盖旧反馈：旧计时器被取消，而不是继续堆在列表里
    expect(vi.getTimerCount()).toBe(timersAfterFirst);

    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(screen.queryByText("「Obsidian」已确认窗口")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
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
});
