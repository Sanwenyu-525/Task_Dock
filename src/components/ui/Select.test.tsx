/**
 * @vitest-environment jsdom
 */
//! Select 基元：键盘、鼠标、滚动、ARIA 与焦点恢复。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRect;
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

  it("选中项的勾选标记位于 hint 左侧，名称仍是首个子节点（左对齐基准）", async () => {
    const user = userEvent.setup();
    render(
      <Select
        ariaLabel="项目"
        value="novel"
        options={[{ value: "novel", label: "最后一种打法", hint: "小说" }]}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "项目" }));
    const selected = document.querySelector(".ui-option.is-selected") as HTMLElement;
    const label = selected.querySelector(".ui-option-label") as HTMLElement;
    const check = selected.querySelector(".ui-option-check") as HTMLElement;
    const hint = selected.querySelector(".ui-option-hint") as HTMLElement;
    expect(selected.firstElementChild).toBe(label);
    expect(label.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(check.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  // 左对齐是共享默认：浮层左边缘跟触发按钮左边缘一致，向右展开。
  it("默认左对齐（bottom-start），align=end 可覆盖为右对齐", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "来源筛选" }));
    const popover = document.querySelector(".ui-select-popover") as HTMLElement;
    expect(popover.getAttribute("data-placement")).toBe("bottom-start");

    cleanup();
    render(
      <Select
        ariaLabel="右对齐覆盖"
        align="end"
        value="codex"
        options={OPTIONS}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "右对齐覆盖" }));
    expect(document.querySelector(".ui-select-popover")?.getAttribute("data-placement")).toBe(
      "bottom-end",
    );
  });

  it("pointerdown 落在浮层外即关闭；落在浮层内不关闭", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button" data-testid="outside">
          别处
        </button>
      </div>,
    );
    const trigger = screen.getByRole("combobox", { name: "来源筛选" });
    await user.click(trigger);
    const listbox = screen.getByRole("listbox");
    fireEvent.pointerDown(listbox);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("外部滚动关闭，浮层内部列表滚动不关闭", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <div data-testid="scroller" />
      </div>,
    );
    const trigger = screen.getByRole("combobox", { name: "来源筛选" });
    await user.click(trigger);
    const listbox = document.querySelector(".ui-listbox") as HTMLElement;
    fireEvent.scroll(listbox);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("窗口失焦关闭浮层", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "来源筛选" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent(window, new Event("blur"));
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

  // ui-polish-round2 回归：菜单宽度贴合触发器。
  // 未传 menuMinWidth 时不注入 --menu-min-w（CSS 兜底下限已移除，
  // 弹层宽度 = max(触发器宽, 内容宽)）；传入时经 Popover style 注入该变量。
  it("弹层宽度策略：默认不注入 --menu-min-w，声明 menuMinWidth 时注入", async () => {
    const user = userEvent.setup();
    render(
      <Select ariaLabel="来源筛选" value="codex" options={OPTIONS} onChange={() => {}} />,
    );
    await user.click(screen.getByRole("combobox", { name: "来源筛选" }));
    let popover = document.querySelector(".ui-select-popover") as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.style.getPropertyValue("--menu-min-w")).toBe("");

    cleanup();
    render(
      <Select
        ariaLabel="来源筛选"
        value="codex"
        options={OPTIONS}
        onChange={() => {}}
        menuMinWidth={146}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "来源筛选" }));
    popover = document.querySelector(".ui-select-popover") as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.style.getPropertyValue("--menu-min-w")).toBe("146px");
  });
});

describe("Select 宽度策略", () => {
  it("展开后弹层严格等于触发按钮宽度，长选项在内部省略而不是撑宽", async () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList?.contains("ui-select-trigger")) return rect(184, 30);
        if (this.classList?.contains("ui-popover-host")) return rect(184, 220);
        return rect(0, 0);
      });
    const clientWidth = Object.getOwnPropertyDescriptor(
      document.documentElement,
      "clientWidth",
    );
    const clientHeight = Object.getOwnPropertyDescriptor(
      document.documentElement,
      "clientHeight",
    );
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 768,
    });
    try {
      const user = userEvent.setup();
      render(<Harness />);
      const trigger = screen.getByRole("combobox", { name: "来源筛选" });
      await user.click(trigger);
      const host = document.querySelector(".ui-popover-host") as HTMLElement;
      await waitFor(() => expect(host.dataset.popupWidth).toBe("exact"));
      expect(host.style.getPropertyValue("--popover-exact-w")).toBe("184px");
      // 选项 title 提供完整文字（宽度锁死后只能省略）
      const option = screen.getByRole("option", { name: /Codex/ });
      expect(option.getAttribute("title")).toContain("Codex");
    } finally {
      spy.mockRestore();
      if (clientWidth) {
        Object.defineProperty(document.documentElement, "clientWidth", clientWidth);
      } else {
        delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth;
      }
      if (clientHeight) {
        Object.defineProperty(document.documentElement, "clientHeight", clientHeight);
      } else {
        delete (document.documentElement as unknown as { clientHeight?: number }).clientHeight;
      }
    }
  });

  it("触发器已选文案带 title，便于查看被省略的完整值", () => {
    render(<Harness />);
    const label = document.querySelector(".ui-select-label") as HTMLElement;
    expect(label.getAttribute("title")).toBe("Codex");
  });
});
