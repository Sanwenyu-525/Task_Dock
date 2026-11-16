// Toast 页面锚点纯函数测试：顶部实测、底部操作区、键盘与注册/注销。
import { describe, expect, it } from "vitest";

import {
  activeToastLayout,
  clearToastLayout,
  resolveToastBottomOffset,
  resolveToastTopOffset,
  updateToastLayout,
  type ToastLayouts,
} from "../toastLayout";

describe("toastLayout", () => {
  it("页面顶部实测高度会覆盖 56dp 默认标题栏", () => {
    expect(
      resolveToastTopOffset({
        safeTop: 24,
        layout: { topInset: 148 },
        defaultHeaderHeight: 56,
        gap: 8,
      }),
    ).toBe(180);
  });

  it("没有页面锚点时回退到状态栏 + 56dp + 间距", () => {
    expect(
      resolveToastTopOffset({
        safeTop: 24,
        layout: {},
        defaultHeaderHeight: 56,
        gap: 8,
      }),
    ).toBe(88);
  });

  it("键盘打开时底部操作区随键盘上移：同时避开键盘与操作区", () => {
    expect(
      resolveToastBottomOffset({
        keyboardHeight: 300,
        layout: { bottomBarHeight: 64, bottomBarAboveKeyboard: true },
        defaultBottomOffset: 102,
        gap: 8,
      }),
    ).toBe(372);
  });

  it("键盘打开但操作区被遮住：只避开键盘", () => {
    expect(
      resolveToastBottomOffset({
        keyboardHeight: 300,
        layout: { bottomBarHeight: 64, bottomBarAboveKeyboard: false },
        defaultBottomOffset: 102,
        gap: 8,
      }),
    ).toBe(308);
  });

  it("键盘关闭时使用实测操作区高度，而不是页面登记的固定高度", () => {
    expect(
      resolveToastBottomOffset({
        keyboardHeight: 0,
        layout: { bottomBarHeight: 72 },
        defaultBottomOffset: 102,
        gap: 8,
      }),
    ).toBe(80);
  });

  it("没有底部锚点时回退页面默认值", () => {
    expect(
      resolveToastBottomOffset({
        keyboardHeight: 0,
        layout: {},
        defaultBottomOffset: 102,
        gap: 8,
      }),
    ).toBe(102);
  });

  it("布局注册、更新、注销按页面隔离，并保留其它页面锚点", () => {
    let layouts: ToastLayouts = {};
    layouts = updateToastLayout(layouts, "tab:notes", { topInset: 148 });
    layouts = updateToastLayout(layouts, "tab:inbox", { topInset: 240 });
    expect(activeToastLayout(layouts, "tab:notes").topInset).toBe(148);
    expect(activeToastLayout(layouts, "tab:inbox").topInset).toBe(240);

    layouts = updateToastLayout(layouts, "tab:notes", { topInset: 160 });
    expect(activeToastLayout(layouts, "tab:notes").topInset).toBe(160);
    expect(activeToastLayout(layouts, "tab:inbox").topInset).toBe(240);

    layouts = clearToastLayout(layouts, "tab:notes");
    expect(activeToastLayout(layouts, "tab:notes")).toEqual({});
    expect(activeToastLayout(layouts, "tab:inbox").topInset).toBe(240);
  });

  it("相同锚点重复上报返回同一 Map，避免 onLayout 抖动重渲染", () => {
    const layouts = updateToastLayout({}, "push:files", {
      bottomBarHeight: 116,
      bottomBarAboveKeyboard: false,
    });
    expect(
      updateToastLayout(layouts, "push:files", {
        bottomBarHeight: 116,
        bottomBarAboveKeyboard: false,
      }),
    ).toBe(layouts);
  });
});
