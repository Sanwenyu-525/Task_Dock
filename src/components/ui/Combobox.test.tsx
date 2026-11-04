/**
 * @vitest-environment jsdom
 */
//! 可搜索下拉：放大镜在未聚焦/展开/输入/关闭时都保留，
//! 保证输入文字起始位置与右侧箭头位置不随状态跳变；键盘流程不受影响。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Combobox from "./Combobox";

const OPTIONS = [
  { value: "t1", label: "任务一" },
  { value: "t2", label: "任务二" },
];

afterEach(cleanup);

function iconCount(container: HTMLElement) {
  return container.querySelectorAll(".ui-combobox-icon").length;
}

describe("Combobox", () => {
  it("放大镜在未聚焦、展开、输入、关闭后始终只有一个", async () => {
    const { container } = render(
      <Combobox value={null} options={OPTIONS} onChange={vi.fn()} ariaLabel="关联任务" />,
    );
    const input = screen.getByRole("combobox", { name: "关联任务" });

    expect(iconCount(container)).toBe(1);
    expect(input.getAttribute("aria-expanded")).toBe("false");

    fireEvent.focus(input);
    expect(iconCount(container)).toBe(1);
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("true"));

    fireEvent.change(input, { target: { value: "任务二" } });
    expect(iconCount(container)).toBe(1);

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"));
    expect(iconCount(container)).toBe(1);
  });

  it("键盘导航、Enter 选择与再次展开清空检索词保持原有行为", async () => {
    const onChange = vi.fn();
    render(<Combobox value={null} options={OPTIONS} onChange={onChange} ariaLabel="关联任务" />);
    const input = screen.getByRole("combobox", { name: "关联任务" });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("t1");

    // 已选中后重新聚焦：检索词清空，完整列表可见
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "任务一" } });
    expect(await screen.findByRole("option", { name: /任务一/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(await screen.findByRole("option", { name: /任务二/ })).toBeTruthy();
  });
});
