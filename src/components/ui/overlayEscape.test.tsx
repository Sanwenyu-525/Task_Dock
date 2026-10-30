/**
 * @vitest-environment jsdom
 */
//! Escape 关闭优先级：确认框 → 子弹层 → 下拉菜单 → 临时抽屉 → 主窗口。
//!
//! 这是 v0.6 修掉的结构性冲突：以前标题栏菜单和窗口级监听会同时消费一次
//! Escape，结果「菜单关掉了，窗口也被顺手藏进托盘」。
//!
//! 这里锁死三条规则：
//! - 一次 Escape 只做**一个**最高优先级的关闭动作；
//! - 栈里还有任何一层时，主窗口永远收不到 Escape；
//! - 栈空时 Escape 才交给窗口级动作（隐藏到托盘）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import DropdownMenu from "./DropdownMenu";
import { ConfirmDialog } from "./Dialog";
import { useOverlayLayer } from "./overlay";
import { resetOverlayStack, setWindowEscapeHandler } from "../../lib/overlayStack";

/** 窗口级 Escape 动作（真实实现是隐藏到托盘）。 */
const hideWindow = vi.fn();

function LayerHarness() {
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [sub, setSub] = useState(false);

  // 子弹层：抽屉内部再开一层
  useOverlayLayer("sublayer", sub, () => setSub(false));
  // 临时抽屉
  useOverlayLayer("drawer", drawer, () => setDrawer(false));

  return (
    <div>
      <button type="button" onClick={() => setDrawer(true)}>
        打开抽屉
      </button>
      {drawer ? (
        <section role="dialog" aria-label="临时抽屉">
          <button type="button" onClick={() => setSub(true)}>
            打开子弹层
          </button>
          {sub ? <p>子弹层内容</p> : null}
        </section>
      ) : null}

      <DropdownMenu
        menuLabel="更多操作"
        items={[{ key: "a", label: "动作 A" }]}
        trigger={(p) => (
          <button
            type="button"
            ref={p.ref}
            aria-haspopup="menu"
            aria-expanded={p.expanded}
            onClick={p.onClick}
            onKeyDown={p.onKeyDown}
          >
            更多
          </button>
        )}
      />

      <button type="button" onClick={() => setDialog(true)}>
        打开确认框
      </button>
      <ConfirmDialog
        open={dialog}
        title="确认删除这条记录？"
        onCancel={() => setDialog(false)}
        onConfirm={() => setDialog(false)}
      />
    </div>
  );
}

/** 在当前焦点元素上按一次 Escape（走真实的捕获→冒泡链路）。 */
function pressEscape() {
  const target = document.activeElement ?? document.body;
  fireEvent.keyDown(target, { key: "Escape" });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOverlayStack();
  setWindowEscapeHandler(hideWindow);
});

afterEach(() => {
  cleanup();
  resetOverlayStack();
  setWindowEscapeHandler(null);
});

describe("Escape 关闭优先级", () => {
  it("没有任何弹层时，Escape 才交给窗口级动作（隐藏到托盘）", async () => {
    render(<LayerHarness />);
    pressEscape();
    expect(hideWindow).toHaveBeenCalledTimes(1);
  });

  it("抽屉打开时，Escape 只关抽屉，主窗口不受影响", async () => {
    const user = userEvent.setup();
    render(<LayerHarness />);

    await user.click(screen.getByRole("button", { name: "打开抽屉" }));
    expect(screen.getByRole("dialog", { name: "临时抽屉" })).toBeTruthy();

    pressEscape();
    expect(screen.queryByRole("dialog", { name: "临时抽屉" })).toBeNull();
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("菜单与抽屉同时存在时，Escape 先关菜单", async () => {
    const user = userEvent.setup();
    render(<LayerHarness />);

    await user.click(screen.getByRole("button", { name: "打开抽屉" }));
    await user.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menu", { name: "更多操作" })).toBeTruthy();

    pressEscape();
    expect(screen.queryByRole("menu")).toBeNull();
    // 抽屉还在：一次 Escape 只做一个动作
    expect(screen.getByRole("dialog", { name: "临时抽屉" })).toBeTruthy();
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("确认框优先级最高：Escape 先关确认框，菜单与抽屉保持不动", async () => {
    const user = userEvent.setup();
    render(<LayerHarness />);

    // 先开确认框再开菜单：反向顺序时点击确认框按钮会被菜单的「外部点击关闭」吃掉
    await user.click(screen.getByRole("button", { name: "打开抽屉" }));
    await user.click(screen.getByRole("button", { name: "打开确认框" }));
    await user.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("dialog", { name: "确认删除这条记录？" })).toBeTruthy();
    expect(screen.getByRole("menu", { name: "更多操作" })).toBeTruthy();

    pressEscape();
    expect(screen.queryByRole("dialog", { name: "确认删除这条记录？" })).toBeNull();
    expect(screen.getByRole("menu", { name: "更多操作" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "临时抽屉" })).toBeTruthy();
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("子弹层优先于抽屉：Escape 先关子弹层", async () => {
    const user = userEvent.setup();
    render(<LayerHarness />);

    await user.click(screen.getByRole("button", { name: "打开抽屉" }));
    await user.click(screen.getByRole("button", { name: "打开子弹层" }));
    expect(screen.getByText("子弹层内容")).toBeTruthy();

    pressEscape();
    expect(screen.queryByText("子弹层内容")).toBeNull();
    expect(screen.getByRole("dialog", { name: "临时抽屉" })).toBeTruthy();
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("连续按 Escape 逐层关闭，最后一层关闭后主窗口才收到 Escape", async () => {
    const user = userEvent.setup();
    render(<LayerHarness />);

    await user.click(screen.getByRole("button", { name: "打开抽屉" }));
    await user.click(screen.getByRole("button", { name: "打开确认框" }));
    await user.click(screen.getByRole("button", { name: "更多" }));

    pressEscape();
    expect(screen.queryByRole("dialog", { name: "确认删除这条记录？" })).toBeNull();
    expect(hideWindow).not.toHaveBeenCalled();

    pressEscape();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(hideWindow).not.toHaveBeenCalled();

    pressEscape();
    expect(screen.queryByRole("dialog", { name: "临时抽屉" })).toBeNull();
    expect(hideWindow).not.toHaveBeenCalled();

    pressEscape();
    expect(hideWindow).toHaveBeenCalledTimes(1);
  });

  it("菜单关闭后焦点回到触发它的按钮", async () => {
    const user = userEvent.setup();
    render(<LayerHarness />);
    const trigger = screen.getByRole("button", { name: "更多" });

    trigger.focus();
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "更多操作" })).toBeTruthy();

    pressEscape();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
