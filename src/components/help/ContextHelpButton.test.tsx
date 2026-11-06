/**
 * @vitest-environment jsdom
 */
//! ContextHelpButton：? 图标按钮 + Popover（overlayStack menu 层）+ 跳完整教程。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import ContextHelpButton from "./ContextHelpButton";
import { useUiStore } from "../../store/useUiStore";
import { resetOverlayStack, overlayStack } from "../../lib/overlayStack";
import { setLocalePreference, __resetLocaleForTests } from "../../i18n";

function fireGlobalEscape() {
  // overlayStack 的 Escape 分发器装在 window capture 阶段（模块加载即安装）
  fireEvent.keyDown(window, { key: "Escape" });
}

beforeEach(() => {
  resetOverlayStack();
  useUiStore.setState({ tab: "tasks", helpOpenRequest: null });
});

afterEach(() => {
  cleanup();
  resetOverlayStack();
  __resetLocaleForTests();
});

describe("ContextHelpButton", () => {
  it("渲染 ? 图标按钮，可访问名含文章标题；未注册 ID 不渲染", () => {
    const { container } = render(
      <div>
        <ContextHelpButton articleId="help.quickstart.capture" />
        <ContextHelpButton articleId="help.deleted.ghost" />
      </div>,
    );
    const buttons = screen.getAllByRole("button", { name: /查看帮助：/ });
    expect(buttons.length).toBe(1);
    expect(buttons[0].getAttribute("aria-label")).toBe("查看帮助：全局快速捕获：随手记不打断");
    expect(container.querySelectorAll(".help-context-btn").length).toBe(1);
  });

  it("点击弹出摘要 Popover（menu 层接入弹层栈）；再点收起", async () => {
    render(<ContextHelpButton articleId="help.quickstart.capture" />);
    const btn = screen.getByRole("button", { name: /查看帮助：/ });
    expect(overlayStack().length).toBe(0);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("查看完整教程")).toBeTruthy());
    expect(screen.getByText("全局快速捕获：随手记不打断")).toBeTruthy();
    expect(screen.getByText("已核对")).toBeTruthy();
    expect(overlayStack().length).toBe(1);
    expect(overlayStack()[0].kind).toBe("menu");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByText("查看完整教程")).toBeNull());
    expect(overlayStack().length).toBe(0);
  });

  it("Escape 只关本层（经全局弹层栈），不重复消费", async () => {
    render(<ContextHelpButton articleId="help.quickstart.capture" />);
    fireEvent.click(screen.getByRole("button", { name: /查看帮助：/ }));
    await waitFor(() => expect(screen.getByText("查看完整教程")).toBeTruthy());
    fireGlobalEscape();
    expect(screen.queryByText("查看完整教程")).toBeNull();
    expect(overlayStack().length).toBe(0);
  });

  it("「查看完整教程」切到 help tab 并携带一次性意图", async () => {
    render(<ContextHelpButton articleId="help.quickstart.capture" />);
    fireEvent.click(screen.getByRole("button", { name: /查看帮助：/ }));
    fireEvent.click(screen.getByRole("button", { name: "查看完整教程" }));
    await waitFor(() => {
      const ui = useUiStore.getState();
      expect(ui.tab).toBe("help");
      expect(ui.helpOpenRequest?.articleId).toBe("help.quickstart.capture");
    });
  });

  it("en-US 下 zh-only 文章显示缺失徽标；状态徽标随语言切换", () => {
    setLocalePreference("en-US");
    render(<ContextHelpButton articleId="help.tasks.create-reminders" />);
    const btn = screen.getByRole("button", { name: "Help: 创建任务与自然语言提醒" });
    fireEvent.click(btn);
    expect(screen.getByText("This guide is not available in English yet")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
  });
});
