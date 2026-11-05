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

// 局部开启 React 的 act 环境，避免 jsdom 下每次交互都打印非致命告警。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navNavigate = vi.fn();
const navListTargets = vi.fn();

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
