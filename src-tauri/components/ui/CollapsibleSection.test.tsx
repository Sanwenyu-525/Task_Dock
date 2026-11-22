/**
 * @vitest-environment jsdom
 */
//! CollapsibleSection：初始/展开/收起、键盘 Enter/Space、aria 关联、
//! 内部按钮不误触发折叠、受控模式、disabled；标题行/描述/箭头两层结构。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import CollapsibleSection from "./CollapsibleSection";

afterEach(cleanup);

describe("CollapsibleSection", () => {
  it("默认折叠，点击标题展开并保持 aria 关联", () => {
    render(
      <CollapsibleSection title="分组标题" description="说明文本">
        <div>内容</div>
      </CollapsibleSection>,
    );

    const toggle = screen.getByRole("button", { name: /分组标题/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("内容")).toBeNull();
    expect(screen.getByText("说明文本")).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const body = screen.getByText("内容").parentElement as HTMLElement;
    expect(toggle.getAttribute("aria-controls")).toBe(body.id);
  });

  it("支持 defaultExpanded 与键盘 Enter/Space 切换", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="键盘分组" defaultExpanded>
        <div>内容</div>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole("button", { name: /键盘分组/ });
    expect(screen.getByText("内容")).toBeTruthy();

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("内容")).toBeNull();

    await user.keyboard(" ");
    expect(screen.getByText("内容")).toBeTruthy();
  });

  it("无描述：箭头位于标题行内，不渲染描述节点", () => {
    render(
      <CollapsibleSection title="无描述分组">
        <div>内容</div>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole("button", { name: /无描述分组/ });
    const titleRow = toggle.querySelector(".collapsible-title-row");
    expect(titleRow).not.toBeNull();
    expect(titleRow?.querySelector(".collapsible-desc")).toBeNull();
    expect(titleRow?.lastElementChild?.classList.contains("collapsible-chevron")).toBe(true);
  });

  it("有描述：箭头仍属于标题行，描述是标题行的下一个兄弟节点", () => {
    render(
      <CollapsibleSection title="带描述分组" description="说明文本">
        <div>内容</div>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole("button", { name: /带描述分组/ });
    const titleRow = toggle.querySelector(".collapsible-title-row") as HTMLElement;
    const desc = toggle.querySelector(".collapsible-desc") as HTMLElement;
    expect(titleRow.querySelector(".collapsible-chevron")).not.toBeNull();
    // 箭头与描述不嵌套：箭头只属于标题行，描述在标题行之后
    expect(desc.parentElement).toBe(titleRow.parentElement);
    expect(titleRow.nextElementSibling).toBe(desc);
    expect(desc.contains(titleRow.querySelector(".collapsible-chevron"))).toBe(false);
  });

  it("图标 + 标题 + 徽标 + 箭头同时存在时结构顺序稳定", () => {
    render(
      <CollapsibleSection
        title="完整标题"
        icon={<span data-testid="section-icon" />}
        badge="3 个"
        description="多行说明"
      >
        <div>内容</div>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole("button", { name: /完整标题/ });
    const titleRow = toggle.querySelector(".collapsible-title-row") as HTMLElement;
    const title = titleRow.querySelector(".collapsible-title") as HTMLElement;
    expect(title.children).toHaveLength(3);
    expect(title.children[0].querySelector('[data-testid="section-icon"]')).not.toBeNull();
    expect(title.children[1].textContent).toBe("完整标题");
    expect(title.children[2].textContent).toBe("3 个");
    expect(titleRow.lastElementChild?.classList.contains("collapsible-chevron")).toBe(true);
  });

  it("展开/折叠时箭头旋转状态随 aria-expanded 同步", () => {
    render(
      <CollapsibleSection title="旋转分组">
        <div>内容</div>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole("button", { name: /旋转分组/ });
    const chevron = () => toggle.querySelector(".collapsible-chevron");
    expect(chevron()?.classList.contains("is-open")).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(chevron()?.classList.contains("is-open")).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(chevron()?.classList.contains("is-open")).toBe(false);
  });

  it("右侧 actions 与折叠按钮分离：点击操作不触发折叠", () => {
    const onExpandedChange = vi.fn();
    render(
      <CollapsibleSection
        title="带操作分组"
        actions={<button type="button">刷新</button>}
        onExpandedChange={onExpandedChange}
      >
        <div>内容</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /带操作分组/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("受控模式只通过回调变更，内部按钮不触发折叠", () => {
    const onExpandedChange = vi.fn();
    render(
      <CollapsibleSection title="受控分组" expanded onExpandedChange={onExpandedChange}>
        <button type="button">内部操作</button>
      </CollapsibleSection>,
    );

    fireEvent.click(screen.getByRole("button", { name: "内部操作" }));
    expect(onExpandedChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /受控分组/ }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
    // 受控值未变，内容仍在
    expect(screen.getByText("内部操作")).toBeTruthy();
  });

  it("折叠时 aria-controls 仍指向真实存在且隐藏的内容容器", () => {
    render(<CollapsibleSection title="容器关联"><div>内容</div></CollapsibleSection>);
    const toggle = screen.getByRole("button", { name: /容器关联/ });
    const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(body).not.toBeNull();
    expect(body?.hidden).toBe(true);
    expect(screen.queryByText("内容")).toBeNull();
  });

  it("受控父组件从外部收起时，焦点从内容区回到触发按钮", () => {
    const { rerender } = render(
      <CollapsibleSection title="外部收起" expanded>
        <button type="button">内部操作</button>
      </CollapsibleSection>,
    );
    const inner = screen.getByRole("button", { name: "内部操作" });
    inner.focus();
    expect(document.activeElement).toBe(inner);

    rerender(
      <CollapsibleSection title="外部收起" expanded={false}>
        <button type="button">内部操作</button>
      </CollapsibleSection>,
    );

    expect(screen.queryByRole("button", { name: "内部操作" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /外部收起/ }));
  });

  it("disabled 时不响应点击", () => {
    const onExpandedChange = vi.fn();
    render(
      <CollapsibleSection title="禁用分组" disabled onExpandedChange={onExpandedChange}>
        <div>内容</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: /禁用分组/ }));
    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(screen.queryByText("内容")).toBeNull();
  });
});
