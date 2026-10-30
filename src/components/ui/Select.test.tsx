/**
 * @vitest-environment jsdom
 */
//! Select 基元：键盘、鼠标、滚动、ARIA 与焦点恢复。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import Select from "./Select";

const OPTIONS = [
  { value: "all", label: "全部来源" },
  { value: "codex", label: "Codex" },
  { value: "qoder", label: "Qoder" },
  { value: "dsh", label: "DSH（不可用）", disabled: true },
];

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("codex");
  return (
    <Select
      ariaLabel="来源筛选"
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

afterEach(cleanup);

describe("Select 基元", () => {
  it("渲染触发器并暴露 combobox 语义", () => {
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "来源筛选" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Codex");
  });

  it("点击展开并列出选项，已选项可辨识", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "来源筛选" }));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(4);
    const selected = options.find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("Codex");
    expect(screen.getByRole("combobox", { name: "来源筛选" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("方向键导航 + Enter 选择", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "来源筛选" });

    await user.click(trigger);
    await user.keyboard("{ArrowDown}");
    // 当前高亮是已选项，ArrowDown 移到下一项（DSH 已禁用，应跳过）
    expect(trigger.getAttribute("aria-activedescendant")).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("qoder");
  });

  it("禁用项不可选择", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "来源筛选" }));
    const disabled = screen.getAllByRole("option").find((o) => o.getAttribute("aria-disabled") === "true");
    expect(disabled?.textContent).toContain("DSH");
    await user.click(disabled!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape 只关闭菜单，焦点回到触发器", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "来源筛选" });
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("点击外部关闭菜单", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">别处</button>
      </div>,
    );
    await user.click(screen.getByRole("combobox", { name: "来源筛选" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "别处" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Home / End 跳到首尾可用项", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "来源筛选" });
    await user.click(trigger);
    await user.keyboard("{End}");
    const options = screen.getAllByRole("option");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(options[2].id);
    await user.keyboard("{Home}");
    expect(trigger.getAttribute("aria-activedescendant")).toBe(options[0].id);
  });

  it("Tab 正常离开（收起菜单但不拦截焦点移动）", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">下一个</button>
      </div>,
    );
    const trigger = screen.getByRole("combobox", { name: "来源筛选" });
    await user.click(trigger);
    await user.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "下一个" }));
  });

  it("长列表：跳到末尾时把高亮项滚进可视区域", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 50 }, (_, i) => ({
      value: `opt-${i}`,
      label: `选项 ${i}`,
    }));
    render(
      <Select ariaLabel="长列表" value="opt-0" options={many} onChange={() => {}} />,
    );

    const trigger = screen.getByRole("combobox", { name: "长列表" });
    await user.click(trigger);

    // jsdom 没有布局：用实例属性模拟「每项 20px、视口 100px」的可滚动列表
    const listbox = document.querySelector(".ui-listbox") as HTMLElement;
    Object.defineProperty(listbox, "clientHeight", { configurable: true, value: 100 });
    let scrollTop = 0;
    Object.defineProperty(listbox, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    screen.getAllByRole("option").forEach((opt, i) => {
      Object.defineProperty(opt, "offsetTop", { configurable: true, value: i * 20 });
      Object.defineProperty(opt, "offsetHeight", { configurable: true, value: 20 });
    });

    await user.keyboard("{End}");
    // 末项 top=980 height=20 → 需要滚到 1000-100=900
    expect(scrollTop).toBe(900);

    await user.keyboard("{Home}");
    // 回到首项：首项在视口之上 → 滚回 0
    expect(scrollTop).toBe(0);
  });
});
