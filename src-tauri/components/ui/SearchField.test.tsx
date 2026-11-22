/**
 * @vitest-environment jsdom
 */
//! SearchField：输入、清空按钮占位、Escape 转发、组合输入不误触发、
//! disabled、焦点留存、只做输入交互不触发业务回调之外的行为。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SearchField from "./SearchField";

afterEach(cleanup);

describe("SearchField", () => {
  it("输入只回传字符串，带搜索图标和可访问名称", () => {
    const onChange = vi.fn();
    render(
      <SearchField value="" onChange={onChange} ariaLabel="搜索任务" placeholder="搜索…" />,
    );
    const input = screen.getByRole("textbox", { name: "搜索任务" });
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("有值才显示清空按钮；清空后焦点留在输入框且不改变占位", () => {
    const onChange = vi.fn();
    const { rerender, container } = render(
      <SearchField value="" onChange={onChange} ariaLabel="搜索剪贴板" />,
    );
    const input = screen.getByRole("textbox", { name: "搜索剪贴板" }) as HTMLInputElement;
    // 按钮始终占位（无值时不可见且不参与 Tab）；aria-hidden 元素不会出现在 role 查询里
    const emptyButton = container.querySelector(".ui-search-clear");
    expect(emptyButton).not.toBeNull();
    expect(emptyButton?.getAttribute("aria-hidden")).toBe("true");
    expect(emptyButton?.getAttribute("tabindex")).toBe("-1");

    rerender(<SearchField value="abc" onChange={onChange} ariaLabel="搜索剪贴板" />);
    const button = screen.getByRole("button", { name: "清除搜索" });
    fireEvent.click(button);
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(document.activeElement).toBe(input);
  });

  it("Escape 只转发给调用方，不由组件隐式清空", () => {
    const onKeyDown = vi.fn();
    const onChange = vi.fn();
    render(
      <SearchField value="abc" onChange={onChange} ariaLabel="搜索应用" onKeyDown={onKeyDown} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索应用" }), { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("中文输入法组合输入期间的按键不转发，避免误清空", () => {
    const onKeyDown = vi.fn();
    render(
      <SearchField value="拼" onChange={() => {}} ariaLabel="搜索笔记" onKeyDown={onKeyDown} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索笔记" }), {
      key: "Escape",
      isComposing: true,
    });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("disabled 时不可输入，清空按钮也不可操作", () => {
    const onChange = vi.fn();
    render(
      <SearchField value="abc" onChange={onChange} ariaLabel="搜索暂存" disabled />,
    );
    const input = screen.getByRole("textbox", { name: "搜索暂存" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("紧凑尺寸与常规尺寸共享同一套焦点边界（外层容器）", () => {
    const { rerender } = render(
      <SearchField value="" onChange={() => {}} ariaLabel="紧凑搜索" size="compact" />,
    );
    const container = screen.getByRole("textbox", { name: "紧凑搜索" }).parentElement as HTMLElement;
    expect(container.classList.contains("ui-search--compact")).toBe(true);
    expect(container.classList.contains("search-box")).toBe(true);

    rerender(<SearchField value="" onChange={() => {}} ariaLabel="紧凑搜索" />);
    expect(container.classList.contains("ui-search--compact")).toBe(false);
  });
});
