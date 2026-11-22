/**
 * @vitest-environment jsdom
 */
//! 对话框内嵌下拉弹层（Select / Combobox / DateTimePicker 共用 Popover）。
//!
//! jsdom 没有排版引擎，这里只断言 DOM 结构、Portal 宿主与弹层栈行为，
//! **不**证明坐标与遮挡——那部分由 scripts/serve-preview.mjs + 实测脚本覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import Select from "./Select";
import { ConfirmDialog, Dialog } from "./Dialog";
import { overlayStack, resetOverlayStack, setWindowEscapeHandler } from "../../lib/overlayStack";

const OPTIONS = [
  { value: "a", label: "选项 A" },
  { value: "b", label: "选项 B" },
];

/** 在焦点元素上按一次 Escape（走真实的 capture → 冒泡链路）。 */
function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

function Harness({ withConfirm = false }: { withConfirm?: boolean }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [value, setValue] = useState("a");

  return (
    <>
      <button type="button" onClick={() => setDialogOpen(true)}>
        打开对话框
      </button>
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="编辑工作流"
        footer={
          withConfirm ? (
            <button type="button" onClick={() => setConfirmOpen(true)}>
              打开确认框
            </button>
          ) : undefined
        }
      >
        <Select ariaLabel="添加步骤" value={value} options={OPTIONS} onChange={setValue} />
      </Dialog>
      <ConfirmDialog
        open={confirmOpen}
        title="确认删除？"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => setConfirmOpen(false)}
      />
    </>
  );
}

/** 单独一个 Select（不在任何对话框里），用于对照 body 级挂载。 */
function PageSelect() {
  const [value, setValue] = useState("a");
  return <Select ariaLabel="页面下拉" value={value} options={OPTIONS} onChange={setValue} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOverlayStack();
  setWindowEscapeHandler(null);
});

afterEach(() => {
  cleanup();
  resetOverlayStack();
  setWindowEscapeHandler(null);
});

describe("对话框内的弹层挂载", () => {
  it("Select 弹层挂进对话框遮罩，而不是 document.body", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "打开对话框" }));
    await user.click(screen.getByRole("combobox", { name: "添加步骤" }));

    const listbox = await screen.findByRole("listbox");
    const host = listbox.closest(".ui-popover-host");
    expect(host).toBeTruthy();
    expect(host?.parentElement).toBe(document.querySelector(".ui-dialog-mask"));
    // 弹层是同层叠上下文内的兄弟，不会被面板的 overflow:hidden 裁剪
    expect(document.querySelector(".ui-dialog")?.contains(host!)).toBe(false);
  });

  it("不在对话框里的 Select 仍然挂到 document.body（行为不变）", async () => {
    const user = userEvent.setup();
    render(<PageSelect />);

    await user.click(screen.getByRole("combobox", { name: "页面下拉" }));
    const listbox = await screen.findByRole("listbox");

    expect(listbox.closest(".ui-popover-host")?.parentElement).toBe(document.body);
  });

  it("一次 Escape 先关菜单，再按一次才关对话框", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "打开对话框" }));
    await user.click(screen.getByRole("combobox", { name: "添加步骤" }));
    expect(await screen.findByRole("listbox")).toBeTruthy();

    // 栈里同时存在 dialog 与 menu：遮罩包含菜单外壳，菜单是子层，必须先关
    expect(overlayStack().map((e) => e.kind).sort()).toEqual(["dialog", "menu"]);

    pressEscape();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "编辑工作流" })).toBeTruthy();

    pressEscape();
    expect(screen.queryByRole("dialog", { name: "编辑工作流" })).toBeNull();
  });

  it("点击对话框面板内、菜单外的位置只关菜单，不关父级对话框", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "打开对话框" }));
    await user.click(screen.getByRole("combobox", { name: "添加步骤" }));
    expect(await screen.findByRole("listbox")).toBeTruthy();

    await user.click(screen.getByText("编辑工作流"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "编辑工作流" })).toBeTruthy();
  });

  it("确认框打开时菜单留在下层：结构上不进入确认框遮罩，Escape 先关确认框", async () => {
    const user = userEvent.setup();
    render(<Harness withConfirm />);

    await user.click(screen.getByRole("button", { name: "打开对话框" }));
    await user.click(screen.getByRole("button", { name: "打开确认框" }));
    await user.click(screen.getByRole("combobox", { name: "添加步骤" }));
    const listbox = await screen.findByRole("listbox");

    const host = listbox.closest(".ui-popover-host")!;
    const masks = Array.from(document.querySelectorAll(".ui-dialog-mask"));
    expect(masks.length).toBe(2);
    // 确认框在对话框之后打开，遮罩在 DOM 中更靠后（与对话框同 z，绘制在更上层）
    const confirmMask = masks[masks.length - 1];
    expect(confirmMask.classList.contains("ui-confirm-mask")).toBe(true);
    expect(confirmMask.contains(host)).toBe(false);
    expect(masks[0].contains(host)).toBe(true);

    pressEscape();
    expect(screen.queryByRole("dialog", { name: "确认删除？" })).toBeNull();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("反复开合后卸载：弹层栈清空、DOM 无残留弹层", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PageSelect />);
    const trigger = screen.getByRole("combobox", { name: "页面下拉" });

    for (let i = 0; i < 3; i += 1) {
      await user.click(trigger);
      expect(await screen.findByRole("listbox")).toBeTruthy();
      await user.click(trigger);
      expect(screen.queryByRole("listbox")).toBeNull();
    }

    unmount();
    expect(overlayStack().length).toBe(0);
    expect(document.querySelectorAll(".ui-popover-host").length).toBe(0);
  });
});
