import { describe, expect, it, vi } from "vitest";

import { createMappedWidgetSource } from "./sources";

describe("createMappedWidgetSource", () => {
  it("原始引用不变时返回同一对象，避免无限重渲染", () => {
    let current: { n: number } | null = { n: 1 };
    const map = vi.fn((value: { n: number } | null) =>
      value ? { doubled: value.n * 2 } : null,
    );
    const source = createMappedWidgetSource(
      () => current,
      () => () => {},
      map,
    );

    const first = source.getSnapshot();
    const second = source.getSnapshot();
    expect(second).toBe(first);
    expect(map).toHaveBeenCalledTimes(1);

    current = { n: 2 };
    const third = source.getSnapshot();
    expect(third).toEqual({ doubled: 4 });
    expect(third).not.toBe(first);
    expect(map).toHaveBeenCalledTimes(2);
  });

  it("原始快照为 null 时也只映射一次", () => {
    const map = vi.fn(() => null);
    const source = createMappedWidgetSource(
      () => null,
      () => () => {},
      map,
    );

    expect(source.getSnapshot()).toBeNull();
    expect(source.getSnapshot()).toBeNull();
    expect(map).toHaveBeenCalledTimes(1);
  });
});
