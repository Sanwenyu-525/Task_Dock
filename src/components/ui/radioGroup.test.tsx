/**
 * @vitest-environment jsdom
 */
//! 单选组键盘契约：方向键移动焦点并选中、Home/End 跳到首末、组内只有一个 Tab 停靠点。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { radioTabIndex, useRovingRadioGroup } from "./radioGroup";

afterEach(cleanup);

function Fixture({ onSelect }: { onSelect: (value: string) => void }) {
  const [value, setValue] = useState("a");
  const options = ["a", "b", "c"];
  const group = useRovingRadioGroup<HTMLDivElement>();
  return (
    <div role="radiogroup" aria-label="测试单选组" ref={group.ref} onKeyDown={group.onKeyDown}>
      {options.map((option, index) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={radioTabIndex(value === option, true, index)}
          onClick={() => {
            setValue(option);
            onSelect(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

const press = (key: string) => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
};

describe("radioTabIndex", () => {
  it("已选中项为唯一停靠点；无选中时第一项兜底", () => {
    expect(radioTabIndex(true, true, 2)).toBe(0);
    expect(radioTabIndex(false, true, 2)).toBe(-1);
    expect(radioTabIndex(false, false, 0)).toBe(0);
    expect(radioTabIndex(false, false, 1)).toBe(-1);
  });
});

describe("useRovingRadioGroup", () => {
  it("方向键移动焦点并同步选中，Home/End 到首末", () => {
    const onSelect = vi.fn();
    render(<Fixture onSelect={onSelect} />);
    const [first, second, third] = screen.getAllByRole("radio");

    first.focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-checked")).toBe("true");

    press("End");
    expect(document.activeElement).toBe(third);
    expect(third.getAttribute("aria-checked")).toBe("true");

    press("ArrowDown");
    expect(document.activeElement).toBe(first);

    press("ArrowUp");
    expect(document.activeElement).toBe(third);
    expect(onSelect).toHaveBeenLastCalledWith("c");

    press("Home");
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-checked")).toBe("true");
  });

  it("非导航键不拦截", () => {
    render(<Fixture onSelect={() => {}} />);
    const first = screen.getAllByRole("radio")[0];
    first.focus();
    const event = fireEvent.keyDown(first, { key: "Tab" });
    expect(event).toBe(true);
  });
});
