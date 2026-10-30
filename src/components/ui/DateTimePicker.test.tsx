/**
 * @vitest-environment jsdom
 */
//! 日期时间选择器：数据完整性。
//!
//! 任务提醒时间错了就是数据错了，所以这里锁死三条底线：
//! - 打开浮层不动值 → 不回调 onChange（否则秒数被截断）；
//! - 改日期不动时间、改时间不动日期；
//! - 截止时间与提醒时间两个实例互不干扰。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import DateTimePicker from "./DateTimePicker";

const DUE = "2026-10-30T18:30";
const REMIND = "2026-11-01T09:00";

function Harness({
  value = DUE,
  onChange,
  ariaLabel = "截止时间",
}: {
  value?: string;
  onChange?: (v: string) => void;
  ariaLabel?: string;
}) {
  const [v, setV] = useState(value);
  return (
    <DateTimePicker
      ariaLabel={ariaLabel}
      value={v}
      onChange={(next) => {
        setV(next);
        onChange?.(next);
      }}
    />
  );
}

afterEach(cleanup);

describe("DateTimePicker 数据完整性", () => {
  it("触发器展示本地时间，展开后 aria-expanded 为真", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "截止时间" });
    expect(trigger.textContent).toContain("2026-10-30 18:30");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "截止时间" })).toBeTruthy();
  });

  it("只是打开浮层不会改值（不截断秒数）", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "截止时间" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "截止时间" })).toBeTruthy());
    // 展开、翻月、切时区视图都不该产生数据变更
    await user.click(screen.getByRole("button", { name: "下个月" }));
    await user.click(screen.getByRole("button", { name: "上个月" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("点回原来那一天不产生变更", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "截止时间" }));
    const selected = screen.getByRole("button", { name: "2026-10-30" });
    await user.click(selected);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("换日期保留原来的时分", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "截止时间" }));
    await user.click(screen.getByRole("button", { name: "2026-11-01" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-11-01T18:30");
  });

  it("改时间保留原来的日期", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "截止时间" }));
    const hour = screen.getByRole("spinbutton", { name: "小时" });
    fireEvent.change(hour, { target: { value: "9" } });
    expect(onChange).toHaveBeenCalledWith("2026-10-30T09:30");

    const minute = screen.getByRole("spinbutton", { name: "分钟" });
    fireEvent.change(minute, { target: { value: "45" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-10-30T09:45");
  });

  it("非法输入只提示不提交", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "截止时间" }));
    const input = screen.getByRole("textbox", { name: "截止时间（可直接输入）" });
    fireEvent.change(input, { target: { value: "2026-13-45 99:99" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText(/格式不正确/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("直接键入合法时间可以提交", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "截止时间" }));
    const input = screen.getByRole("textbox", { name: "截止时间（可直接输入）" });
    fireEvent.change(input, { target: { value: "2026-12-05 07:15" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-12-05T07:15");
  });

  it("清空会提交空值并触发 onClear", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onClear = vi.fn();
    render(
      <DateTimePicker ariaLabel="截止时间" value={DUE} onChange={onChange} onClear={onClear} />,
    );
    await user.click(screen.getByRole("button", { name: "清空日期时间" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(onClear).toHaveBeenCalled();
  });

  it("两个实例互不干扰（截止时间与提醒时间）", async () => {
    const user = userEvent.setup();
    const dueChange = vi.fn();
    const remindChange = vi.fn();
    render(
      <>
        <DateTimePicker ariaLabel="截止时间" value={DUE} onChange={dueChange} />
        <DateTimePicker ariaLabel="提醒时间" value={REMIND} onChange={remindChange} />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "提醒时间" }));
    await user.click(screen.getByRole("button", { name: "2026-11-02" }));
    expect(remindChange).toHaveBeenCalledWith("2026-11-02T09:00");
    expect(dueChange).not.toHaveBeenCalled();
  });

  it("日历网格支持方向键移动焦点", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "截止时间" }));

    const day = screen.getByRole("button", { name: "2026-10-30" });
    day.focus();
    fireEvent.keyDown(day.closest("tbody")!, { key: "ArrowRight" });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe("2026-10-31");
    });
  });
});
