/**
 * @vitest-environment jsdom
 */
//! TargetMenu 真实 DOM 交互测试：键盘 ArrowDown/ArrowUp 循环移动焦点索引、
//! Enter 触发对应项、Escape 关闭菜单、工作区入口固定排第 0 位且可聚焦。
//!
//! 组件是纯 props 驱动（不触 Tauri bridge，键盘模型函数用真实实现），无需 mock。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import TargetMenu from "./TargetMenu";
import type { TaskNavLink } from "../../lib/navigation";

function linkFix(id: string, display_name: string): TaskNavLink {
  return {
    id: `link-${id}`,
    task_id: "task-1",
    target_id: `target-${id}`,
    display_order: 0,
    is_default: false,
    launch_behavior: "default",
    created_at: "2026-10-26T00:00:00Z",
    running_state: "not_running",
    target: {
      id: `target-${id}`,
      display_name,
      target_type: "application",
      app_key: id,
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
      category: "",
      favorite: false,
      hidden: false,
      last_used_at: null,
      use_count: 0,
      created_at: "2026-10-26T00:00:00Z",
      updated_at: "2026-10-26T00:00:00Z",
    },
  };
}

const LINKS = [linkFix("vscode", "VS Code"), linkFix("wechat", "微信")];

function renderMenu(handlers?: {
  onNavigate?: (l: TaskNavLink) => void;
  onClose?: () => void;
  onOpenAll?: () => void;
}) {
  const onNavigate = handlers?.onNavigate ?? vi.fn();
  const onClose = handlers?.onClose ?? vi.fn();
  render(
    <TargetMenu
      links={LINKS}
      onNavigate={onNavigate}
      onClose={onClose}
      onOpenAll={handlers?.onOpenAll}
    />,
  );
  return { onNavigate, onClose };
}

/** 等待焦点落到 data-idx 对应条目上（索引切换后 effect 重新聚焦）。 */
async function expectFocusedIdx(idx: string) {
  await waitFor(() => {
    expect((document.activeElement as HTMLElement | null)?.dataset?.idx).toBe(idx);
  });
}

afterEach(() => {
  cleanup();
});

describe("TargetMenu 键盘交互", () => {
  it("打开即聚焦第 0 项；工作区入口排第 0 位、索引与 DOM 顺序一致", async () => {
    renderMenu({ onOpenAll: vi.fn() });

    const workspace = screen.getByRole("menuitem", { name: /打开工作区/ });
    const idxButtons = Array.from(document.querySelectorAll<HTMLElement>("[data-idx]"));
    expect(idxButtons[0]).toBe(workspace); // 工作区是 DOM 里第一个条目
    expect(idxButtons.map((b) => b.dataset.idx)).toEqual(["0", "1", "2"]);
    await expectFocusedIdx("0"); // 打开即聚焦，键盘用户无需先 Tab
  });

  it("ArrowDown/ArrowUp 循环移动焦点，首尾自动回绕", async () => {
    renderMenu({ onOpenAll: vi.fn() });
    await expectFocusedIdx("0");
    const menu = screen.getByRole("menu", { name: "选择跳转目标" });

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await expectFocusedIdx("1");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await expectFocusedIdx("2");
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // 从最后一项回绕到工作区
    await expectFocusedIdx("0");
    fireEvent.keyDown(menu, { key: "ArrowUp" }); // 从第 0 项回绕到最后一项
    await expectFocusedIdx("2");
  });

  it("Enter 触发当前焦点项：目标项走 onNavigate 并关闭菜单", async () => {
    const { onNavigate, onClose } = renderMenu({ onOpenAll: vi.fn() });
    await expectFocusedIdx("0");
    const menu = screen.getByRole("menu", { name: "选择跳转目标" });

    fireEvent.keyDown(menu, { key: "ArrowDown" }); // → 索引 1（VS Code）
    await expectFocusedIdx("1");
    fireEvent.keyDown(menu, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(LINKS[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter 在工作区入口触发 onOpenAll（旧缺陷回归：工作区必须可键盘触发）", async () => {
    const onOpenAll = vi.fn();
    const { onNavigate, onClose } = renderMenu({ onOpenAll });
    await expectFocusedIdx("0");
    const menu = screen.getByRole("menu", { name: "选择跳转目标" });

    fireEvent.keyDown(menu, { key: "Enter" });

    expect(onOpenAll).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape 关闭菜单", async () => {
    const { onClose } = renderMenu({ onOpenAll: vi.fn() });
    await expectFocusedIdx("0");

    fireEvent.keyDown(screen.getByRole("menu", { name: "选择跳转目标" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("没有工作区入口时目标从索引 0 开始", async () => {
    renderMenu();

    const idxButtons = Array.from(document.querySelectorAll<HTMLElement>("[data-idx]"));
    expect(idxButtons.map((b) => b.dataset.idx)).toEqual(["0", "1"]);
    expect(idxButtons[0].textContent).toContain("VS Code");
    await expectFocusedIdx("0");
  });
});
