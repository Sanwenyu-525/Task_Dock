/**
 * @vitest-environment jsdom
 */
//! 操作菜单基元：键盘导航、禁用项、单选组、Escape 与焦点恢复。
//!
//! 菜单是 TitleBar 与任务面板里到处复用的交互原语，
//! 一旦导航或焦点行为漂移，所有调用点会同时出问题，所以在这里锁死。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DropdownMenu, { type DropdownMenuItem } from "./DropdownMenu";

const BASIC: DropdownMenuItem[] = [
  { key: "asc", label: "升序排列" },
  { key: "desc", label: "降序排列" },
  { key: "none", label: "不排序", disabled: true },
  { key: "due", label: "按截止时间" },
];

const RADIO: DropdownMenuItem[] = [
  { key: "due", label: "按截止时间", radio: true, checked: true },
  { key: "created", label: "按创建时间", radio: true },
  { key: "priority", label: "按优先级", radio: true },
];

function Harness({
  items = BASIC,
  onSelect,
  disabled = false,
}: {
  items?: DropdownMenuItem[];
  onSelect?: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu
      menuLabel="排序方式"
      disabled={disabled}
      items={items.map((it) => ({ ...it, onSelect: () => onSelect?.(it.key) }))}
      trigger={(p) => (
        <button
          type="button"
          ref={p.ref}
          aria-haspopup="menu"
          aria-expanded={p.expanded}
          onClick={p.onClick}
          onKeyDown={p.onKeyDown}
        >
          排序
        </button>
      )}
    />
  );
}

/** 菜单展开后会把焦点交给当前高亮项（rAF），这里等它落位。 */
async function waitForFocus(index: number) {
  await waitFor(
    () => {
      // 单选组渲染成 menuitemradio，普通项是 menuitem；
      // 这里必须用 query*（不抛错），否则单选组会直接失败而不是等待。
      const plain = screen.queryAllByRole("menuitem");
      const radio = screen.queryAllByRole("menuitemradio");
      const items = plain.length ? plain : radio;
      expect(document.activeElement).toBe(items[index]);
    },
    { timeout: 3000 },
  );
}

afterEach(cleanup);

describe("DropdownMenu 基元", () => {
  it("触发器暴露 menu 语义与展开状态", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "排序" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "排序方式" })).toBeTruthy();
  });

  it("点击展开、再次点击收起", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "排序" });

    await user.click(trigger);
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);

    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("方向键在菜单项之间移动，并跳过禁用项", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "排序" });

    await user.click(trigger);
    await waitForFocus(0);

    await user.keyboard("{ArrowDown}");
    await waitForFocus(1);
    // 第 3 项「不排序」是禁用的，不应该成为焦点
    await user.keyboard("{ArrowDown}");
    await waitForFocus(3);
  });

  it("Enter 触发当前高亮项并收起菜单", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "排序" }));
    await waitForFocus(0);
    await user.keyboard("{ArrowDown}");
    await waitForFocus(1);
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("desc");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Home / End 跳到首尾可用项", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "排序" }));
    await waitForFocus(0);

    await user.keyboard("{End}");
    await waitForFocus(3);
    await user.keyboard("{Home}");
    await waitForFocus(0);
  });

  it("禁用项不可触发，菜单保持展开", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "排序" }));
    await waitForFocus(0);

    const items = screen.getAllByRole("menuitem");
    expect(items[2].getAttribute("aria-disabled")).toBe("true");
    await user.click(items[2]);

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("字母键快速定位到对应菜单项", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "排序" }));
    await waitForFocus(0);

    await user.keyboard("降");
    await waitForFocus(1);
  });

  it("Escape 只关闭菜单，焦点回到触发器", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "排序" });
    await user.click(trigger);
    await waitForFocus(0);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("点击外部关闭菜单", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">别处</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "排序" }));
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "别处" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("单选组用 menuitemradio + aria-checked 表达选中态", async () => {
    const user = userEvent.setup();
    render(<Harness items={RADIO} />);
    const trigger = screen.getByRole("button", { name: "排序" });

    await user.click(trigger);
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(3);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[1].getAttribute("aria-checked")).toBe("false");
    // 展开时默认落在已选项上
    await waitForFocus(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("禁用的触发器打不开菜单", async () => {
    const user = userEvent.setup();
    render(<Harness disabled />);
    const trigger = screen.getByRole("button", { name: "排序" });

    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
