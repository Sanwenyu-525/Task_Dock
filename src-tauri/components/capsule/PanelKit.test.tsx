/**
 * @vitest-environment jsdom
 */
//! `PanelHead` 布局变体的结构契约：
//! - 默认仍是「标题在上、说明在下」，六个面板的既有结构不受影响；
//! - 只有显式传 `layout="inline"`（当前只有应用面板）才把说明移到右侧同一行；
//! - 右侧动作区与布局变体无关，不会被合并进标题行。

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { PanelHead, PanelCloseButton } from "./PanelKit";
import { PanelCloseProvider } from "./panelClose";

afterEach(cleanup);

describe("PanelHead 布局变体", () => {
  it("默认纵向：不带 inline 修饰类", () => {
    const { container } = render(<PanelHead title="任务" sub="今日与逾期" />);
    const text = container.querySelector(".cap-head-text") as HTMLElement;
    // 只断言布局修饰类，不锁死完整类名：标题区同时承担窗口拖拽热区
    // （`ui-drag-surface` 由窗口拖拽任务维护），不应因其他合法类名而失败。
    expect(text.classList.contains("cap-head-text")).toBe(true);
    expect(text.classList.contains("cap-head-text--inline")).toBe(false);
    expect(text.querySelector(".cap-title")?.textContent).toBe("任务");
    expect(text.querySelector(".cap-sub")?.textContent).toBe("今日与逾期");
  });

  it("inline：说明与标题同处一个文本容器，由局部类切换横向布局", () => {
    const { container } = render(
      <PanelHead title="应用" sub="常用应用 · 快捷启动与窗口切换" layout="inline" />,
    );
    const text = container.querySelector(".cap-head-text") as HTMLElement;
    expect(text.classList.contains("cap-head-text--inline")).toBe(true);
    // 结构仍是「标题 + 说明」两个 span，不额外拆成新的标题层级
    expect(Array.from(text.children).map((el) => el.className)).toEqual([
      "cap-title",
      "cap-sub",
    ]);
  });

  it("动作区独立于标题文本容器", () => {
    const { container } = render(
      <PanelHead title="应用" sub="说明" layout="inline" actions={<button type="button">管理</button>} />,
    );
    const header = container.querySelector(".cap-head") as HTMLElement;
    expect(header.children).toHaveLength(2);
    expect(header.querySelector(".cap-head-text--inline")).toBeTruthy();
    expect(header.querySelector(".cap-actions button")?.textContent).toBe("管理");
    // 文本容器里不能混入动作按钮
    expect(header.querySelector(".cap-head-text")?.querySelector("button")).toBeNull();
  });
});

describe("PanelHead 关闭入口", () => {
  it("没有关闭动作时不渲染 X（脱离胶囊的复用场景不受影响）", () => {
    const { container } = render(<PanelHead title="任务" sub="说明" />);
    expect(container.querySelector(".cap-close")).toBeNull();
    expect(container.querySelector(".cap-actions")).toBeNull();
  });

  it("关闭按钮位于动作区最右、可读名称明确、只调用一次收起回调", () => {
    const onClose = vi.fn();
    const { container } = render(
      <PanelCloseProvider onClose={onClose}>
        <PanelHead
          title="应用"
          sub="说明"
          layout="inline"
          actions={<button type="button">管理</button>}
        />
      </PanelCloseProvider>,
    );
    const actions = container.querySelector(".cap-actions") as HTMLElement;
    const close = screen.getByRole("button", { name: "关闭应用面板" });

    // 永远在动作区最后（= 标题栏最右），排在既有操作按钮之后
    expect(actions.lastElementChild).toBe(close);
    expect(actions.firstElementChild?.textContent).toBe("管理");

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭按钮不是窗口拖拽热区：按下不会让标题进入拖动", () => {
    const onClose = vi.fn();
    const { container } = render(
      <PanelCloseProvider onClose={onClose}>
        <PanelHead title="剪贴板" sub="说明" />
      </PanelCloseProvider>,
    );
    const header = container.querySelector(".cap-head") as HTMLElement;
    const close = screen.getByRole("button", { name: "关闭剪贴板面板" });

    expect(close.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(close.querySelector("svg")?.hasAttribute("data-tauri-drag-region")).toBe(false);

    fireEvent.pointerDown(close, { button: 0, buttons: 1 });
    expect(header.classList.contains("is-dragging")).toBe(false);

    // 标题文字仍是拖拽热区，关闭按钮的排除不靠禁用整个标题
    fireEvent.pointerDown(header.querySelector(".cap-title") as HTMLElement, {
      button: 0,
      buttons: 1,
    });
    expect(header.classList.contains("is-dragging")).toBe(true);
  });
});

describe("PanelCloseButton（二级页面共用）", () => {
  it("无 provider 返回 null；有 provider 时用调用方给的标签触发关闭", () => {
    const { container, rerender } = render(<PanelCloseButton label="关闭剪贴板面板" />);
    // 脱离胶囊渲染时不产生孤立按钮
    expect(container.querySelector(".cap-close")).toBeNull();

    const onClose = vi.fn();
    rerender(
      <PanelCloseProvider onClose={onClose}>
        <PanelCloseButton label="关闭剪贴板面板" />
      </PanelCloseProvider>,
    );
    const close = screen.getByRole("button", { name: "关闭剪贴板面板" });
    expect(close.className).toBe("cap-close");
    expect(close.hasAttribute("data-tauri-drag-region")).toBe(false);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("默认标签是通用「关闭面板」，调用方可以覆盖", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <PanelCloseProvider onClose={onClose}>
        <PanelCloseButton />
      </PanelCloseProvider>,
    );
    expect(screen.getByRole("button", { name: "关闭面板" })).toBeTruthy();

    rerender(
      <PanelCloseProvider onClose={onClose}>
        <PanelCloseButton label="关闭任务面板" />
      </PanelCloseProvider>,
    );
    expect(screen.getByRole("button", { name: "关闭任务面板" })).toBeTruthy();
  });
});
