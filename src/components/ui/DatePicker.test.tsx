/**
 * @vitest-environment jsdom
 */
//! 纯日期选择器：数据完整性 + 交互契约。
//!
//! 锁死几条底线：
//! - 只处理 `YYYY-MM-DD`，开关/切月不触发 onChange；
//! - 值未变不重复提交；清除映射为空串；
//! - 非法输入只提示，不污染已保存值；
//! - Escape 只关日历，外部点击关闭，多实例互不干扰。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import DatePicker from "./DatePicker";
import { todayIsoDate } from "../../lib/datetime";
import { setWindowEscapeHandler } from "../../lib/overlayStack";

function Harness({
  value = "2026-11-04",
  onChange,
  ariaLabel = "目标日期",
  clearable,
}: {
  value?: string;
  onChange?: (v: string) => void;
  ariaLabel?: string;
  clearable?: boolean;
}) {
  const [v, setV] = useState(value);
  return (
    <DatePicker
      ariaLabel={ariaLabel}
      value={v}
      clearable={clearable}
      onChange={(next) => {
        setV(next);
        onChange?.(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  setWindowEscapeHandler(null);
});

describe("DatePicker 交互与数据完整性", () => {
  it("输入框消费共享嵌入式输入规则，焦点边界只由外层容器绘制", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "目标日期" });
    // 全局约定见 styles-ui.css「嵌入式输入原语」：内层 input 不画边界/焦点环，
    // 容器 .ui-dp 负责背景、边框、圆角、阴影与 :focus-within 高亮。
    expect(input.classList.contains("ui-dp-input")).toBe(true);
    expect(input.classList.contains("input-embedded")).toBe(true);
    expect(input.closest(".ui-dp")).toBeTruthy();
  });

  it("日历图标可通过 Tab 获得键盘焦点", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "目标日期" });
    const toggle = screen.getByRole("button", { name: "选择日期" });

    input.focus();
    await user.tab();
    expect(document.activeElement).toBe(toggle);
  });

  it("输入框点开日历，图标可再关闭（同一入口）", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "目标日期" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input).toHaveProperty("value", "2026-11-04");

    await user.click(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "目标日期" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "选择日期" }));
    expect(screen.queryByRole("dialog", { name: "目标日期" })).toBeNull();
  });

  it("开关与切月不触发 onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("textbox", { name: "目标日期" }));
    await user.click(screen.getByRole("button", { name: "下个月" }));
    await user.click(screen.getByRole("button", { name: "上个月" }));
    await user.click(screen.getByRole("button", { name: "选择日期" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("选中日期立即提交一次并关闭，焦点回到输入框", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "目标日期" });
    await user.click(input);
    await user.click(screen.getByRole("button", { name: "2026-11-12" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-11-12");
    expect(screen.queryByRole("dialog", { name: "目标日期" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("点回原来的日期不产生重复提交", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("textbox", { name: "目标日期" }));
    await user.click(screen.getByRole("button", { name: "2026-11-04" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("今天取本地日期并关闭", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness value="2026-10-01" onChange={onChange} />);

    await user.click(screen.getByRole("textbox", { name: "目标日期" }));
    await user.click(screen.getByRole("button", { name: "今天" }));
    expect(onChange).toHaveBeenCalledWith(todayIsoDate());
    expect(screen.queryByRole("dialog", { name: "目标日期" })).toBeNull();
  });

  it("清除提交空串并关闭", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("textbox", { name: "目标日期" }));
    await user.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("clearable=false 时不显示清除入口", async () => {
    const user = userEvent.setup();
    render(<Harness clearable={false} />);
    await user.click(screen.getByRole("textbox", { name: "目标日期" }));
    expect(screen.queryByRole("button", { name: "清除" })).toBeNull();
    expect(screen.getByRole("button", { name: "今天" })).toBeTruthy();
  });

  it("直接键入合法日期可提交（斜杠与单位数也规范化）", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "目标日期" });
    fireEvent.change(input, { target: { value: "2026/12/5" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("2026-12-05");
    expect(input).toHaveProperty("value", "2026-12-05");
  });

  it("非法日期只提示不提交（含闰年与月天数校验）", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "目标日期" });
    fireEvent.change(input, { target: { value: "2026-02-30" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("alert").textContent).toContain("格式不正确");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2024-02-29" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2024-02-29");
  });

  it("清空输入并在失焦时提交空串", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "目标日期" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("键盘方向键导航 + Enter 选择", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    // 图标打开时焦点落在当前选中日，方向键可直接导航
    await user.click(screen.getByRole("button", { name: "选择日期" }));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("2026-11-04"));

    fireEvent.keyDown(document.activeElement!.closest("tbody")!, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("2026-11-05"));

    fireEvent.keyDown(document.activeElement!.closest("tbody")!, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-11-05");
  });

  it("Escape 只关日历，不触发窗口级动作", async () => {
    const user = userEvent.setup();
    const hideWindow = vi.fn();
    setWindowEscapeHandler(hideWindow);
    render(<Harness />);

    await user.click(screen.getByRole("textbox", { name: "目标日期" }));
    expect(screen.getByRole("dialog", { name: "目标日期" })).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "目标日期" })).toBeNull();
    expect(hideWindow).not.toHaveBeenCalled();
  });

  it("点外部关闭日历", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("textbox", { name: "目标日期" }));
    expect(screen.getByRole("dialog", { name: "目标日期" })).toBeTruthy();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "目标日期" })).toBeNull());
  });

  it("两个实例互不干扰", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        <DatePicker ariaLabel="开始日期" value="2026-11-04" onChange={first} />
        <DatePicker ariaLabel="结束日期" value="2026-12-01" onChange={second} />
      </>,
    );

    await user.click(screen.getByRole("textbox", { name: "结束日期" }));
    const dialogs = screen.getAllByRole("dialog", { name: "结束日期" });
    expect(dialogs).toHaveLength(1);
    const day = dialogs[0].querySelector<HTMLElement>('[data-iso="2026-12-12"]');
    await user.click(day!);

    expect(second).toHaveBeenCalledWith("2026-12-12");
    expect(first).not.toHaveBeenCalled();
  });

  it("disabled 时不可展开", async () => {
    const user = userEvent.setup();
    render(<DatePicker ariaLabel="目标日期" value="2026-11-04" onChange={() => {}} disabled />);

    const input = screen.getByRole("textbox", { name: "目标日期" });
    expect(input.hasAttribute("disabled")).toBe(true);
    await user.click(input);
    expect(screen.queryByRole("dialog", { name: "目标日期" })).toBeNull();
  });
});
