/**
 * @vitest-environment jsdom
 */
//! 液态玻璃菜单交互测试：结构渲染、勾选态同步、动作分发与键盘导航。
//! Tauri IPC（invoke / listen）打桩，业务断言只看调用参数与 DOM 状态。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type InvokeArgs = Record<string, unknown>;
const invokeMock = vi.fn<(cmd: string, args?: InvokeArgs) => Promise<unknown>>();
const listenHandlers = new Map<string, (e: { payload?: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: InvokeArgs) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (e: { payload?: unknown }) => void) => {
    listenHandlers.set(event, cb);
    return Promise.resolve(() => listenHandlers.delete(event));
  },
}));

import ContextMenuApp from "./ContextMenuApp";

function settingsStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    theme: "system",
    mode: "full",
    material: "solid",
    visual_preset: "dream-gradient",
    autostart: false,
    snap_enabled: true,
    hotkey_enabled: true,
    ...overrides,
  };
}

function snapshotOf(s: ReturnType<typeof settingsStub>) {
  return { mode: s.mode, theme: s.theme, autostart: s.autostart, visual_preset: s.visual_preset };
}

/** 动作默认成功并回传最新快照（与后端 MenuActionResult 协议一致）。 */
let actionResult: { ok: boolean; error?: string; snapshot?: unknown } | null = null;

/** 触发后端「菜单即将显示」事件。 */
function fireShow() {
  listenHandlers.get("context-menu-show")?.({});
}

function lastInvoke(cmd: string) {
  const calls = invokeMock.mock.calls.filter(([c]) => c === cmd);
  return calls[calls.length - 1];
}

beforeEach(() => {
  listenHandlers.clear();
  actionResult = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd) => {
    if (cmd === "get_settings") return Promise.resolve(settingsStub());
    if (cmd === "context_menu_action") {
      return Promise.resolve(actionResult ?? { ok: true, snapshot: snapshotOf(settingsStub()) });
    }
    return Promise.resolve();
  });
});

afterEach(() => cleanup());

describe("渲染结构", () => {
  it("渲染四组标题与全部 10 个菜单项", async () => {
    render(<ContextMenuApp />);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    for (const label of ["常用操作", "布局模式", "外观与系统", "退出操作"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByRole("menuitem")).toHaveLength(3); // 显示/隐藏 · 快速添加 · 退出
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(6); // 3 模式 + 3 主题
    expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(1); // 自启动
  });

  it("勾选态与设置快照同步（mode=compact / theme=dark / 自启动开）", async () => {
    invokeMock.mockImplementation((cmd) =>
      cmd === "get_settings"
        ? Promise.resolve(settingsStub({ mode: "compact", theme: "dark", autostart: true }))
        : Promise.resolve(),
    );
    fireShow();
    render(<ContextMenuApp />);
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "紧凑模式" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("menuitemradio", { name: "深色主题" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "极简模式" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemcheckbox", { name: "开机自启动" }).getAttribute("aria-checked")).toBe("true");
  });

  it("收到 theme-changed 事件时勾选态实时更新（与主窗同步）", async () => {
    render(<ContextMenuApp />);
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe("true"));
    listenHandlers.get("theme-changed")?.({ payload: "dark" });
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "深色主题" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("menuitemradio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("动作分发", () => {
  it("点击菜单项调用后端动作（退出）", async () => {
    const user = userEvent.setup();
    render(<ContextMenuApp />);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    await user.click(screen.getByRole("menuitem", { name: "退出" }));
    expect(lastInvoke("context_menu_action")?.[1]).toEqual({ action: "quit" });
  });

  it("点击单选项调用带参数动作（mode:compact）", async () => {
    const user = userEvent.setup();
    render(<ContextMenuApp />);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    await user.click(screen.getByRole("menuitemradio", { name: "紧凑模式" }));
    expect(lastInvoke("context_menu_action")?.[1]).toEqual({ action: "mode:compact" });
  });

  it("挂载即回传实测内容高度（首开前完成 fit，无跳动）", async () => {
    render(<ContextMenuApp />);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    // 不触发 show 事件：挂载后 rAF 内就应回传高度
    await waitFor(() => expect(lastInvoke("fit_context_menu")).toBeTruthy());
    const args = lastInvoke("fit_context_menu")?.[1] as { height: number };
    expect(args).toHaveProperty("height");
    // 宽度是设计常量，不回传（避免测量回环漂移）
    expect(args).not.toHaveProperty("width");
  });

  it("动作成功时以返回快照渲染勾选态（不做乐观更新）", async () => {
    const user = userEvent.setup();
    // 点击「深色主题」：后端成功后返回 theme=dark 的快照
    actionResult = { ok: true, snapshot: { ...snapshotOf(settingsStub()), theme: "dark" } };
    render(<ContextMenuApp />);
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitemradio", { name: "深色主题" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "深色主题" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("动作失败时显示行内反馈并回读权威快照（不虚假显示成功）", async () => {
    const user = userEvent.setup();
    // 后端主题持久化失败：ok=false + 当前真实快照（theme 仍是 system）
    actionResult = { ok: false, error: "切换主题失败：数据库错误", snapshot: snapshotOf(settingsStub()) };
    render(<ContextMenuApp />);
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitemradio", { name: "深色主题" }));
    // 行内错误反馈出现
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("切换主题失败"));
    // 权威快照回读：勾选态不得虚假变化（跟随系统仍是勾选项）
    expect(screen.getByRole("menuitemradio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "深色主题" }).getAttribute("aria-checked")).toBe("false");
  });

  it("IPC 异常（invoke reject）同样给出反馈并回读状态", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "get_settings") return Promise.resolve(settingsStub());
      if (cmd === "context_menu_action") return Promise.reject(new Error("ipc down"));
      return Promise.resolve();
    });
    render(<ContextMenuApp />);
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "退出" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("菜单命令未响应"));
  });
});

describe("键盘交互", () => {
  it("show 后初始焦点落在勾选项，↑↓ 移动，Enter 触发当前项", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((cmd) =>
      cmd === "get_settings"
        ? Promise.resolve(settingsStub({ mode: "compact", theme: "dark" }))
        : Promise.resolve(),
    );
    render(<ContextMenuApp />);
    const menu = await screen.findByRole("menu");
    fireShow();
    // 初始焦点：第一个勾选项 = 紧凑模式（快照 mode=compact）
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "紧凑模式" })),
    );
    // ↓ 移到下一项（完整模式），Enter 触发
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "完整模式" })),
    );
    await user.keyboard("{Enter}");
    expect(lastInvoke("context_menu_action")?.[1]).toEqual({ action: "mode:full" });
    void menu;
  });

  it("Escape 关闭菜单（调用 hide_context_menu）", async () => {
    const user = userEvent.setup();
    render(<ContextMenuApp />);
    await screen.findByRole("menu");
    fireShow();
    // 初始焦点落在勾选项（跟随系统 = menuitemradio）
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("role")?.startsWith("menuitem")).toBe(true),
    );
    await user.keyboard("{Escape}");
    expect(lastInvoke("hide_context_menu")).toBeTruthy();
  });
});
