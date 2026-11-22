// @vitest-environment jsdom
//! 工作台自绘标题栏的窗口控制：无障碍名称、三按钮行为、最大化图标、关闭状态呈现。
//!
//! 只测组件契约（真实窗口行为由原生验收覆盖）：非 Tauri 环境下注入窗口替身，
//! 不依赖 `window.__TAURI_INTERNALS__`。
//!
//! 关闭专项（2026-11-19）：按钮不再自己判断「关没关掉」，一律由 `closeState`
//! 驱动；`win.close()` 的 resolve 不得解锁按钮。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorkbenchWindowControls, {
  type WorkbenchWindowHandle,
} from "./WorkbenchWindowControls";
import {
  flushDiagnostics,
  setDiagnosticTransport,
} from "../lib/diagnostics";

type FakeWindow = WorkbenchWindowHandle & {
  setMaximized: (value: boolean) => void;
  fireResize: () => void;
};

function fakeWindow(): FakeWindow {
  let maximized = false;
  let resizeHandler: (() => void) | null = null;
  return {
    isMaximized: vi.fn(async () => maximized),
    onResized: vi.fn(async (handler: () => void) => {
      resizeHandler = handler;
      return () => {
        resizeHandler = null;
      };
    }),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {
      maximized = !maximized;
    }),
    close: vi.fn(async () => {}),
    label: () => "workspace",
    setMaximized: (value: boolean) => {
      maximized = value;
    },
    fireResize: () => resizeHandler?.(),
  };
}

beforeEach(async () => {
  // 诊断队列是模块级全局：每例先排空，避免上一例的事件混入。
  setDiagnosticTransport(async () => {});
  await flushDiagnostics();
});
afterEach(() => {
  cleanup();
  setDiagnosticTransport(null);
});

describe("WorkbenchWindowControls · 基础契约", () => {
  it("三个按钮都有清晰的名称，且整簇显式排除在拖动区之外", () => {
    render(<WorkbenchWindowControls window={fakeWindow()} />);

    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭工作台" })).toBeTruthy();

    const group = screen.getByRole("group", { name: "窗口控制" });
    expect(group.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("最小化/最大化落到窗口 API；关闭优先走统一协调器入口", () => {
    const win = fakeWindow();
    const onRequestClose = vi.fn();
    render(
      <WorkbenchWindowControls window={win} onRequestClose={onRequestClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    expect(win.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台" }));
    // 有协调器时组件不得自己调 win.close（否则会绕过保存守卫）。
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(win.close).not.toHaveBeenCalled();
  });

  it("没有协调器（预览/旧调用）时才退化为直接 close", () => {
    const win = fakeWindow();
    render(<WorkbenchWindowControls window={win} />);

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台" }));
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("最大化图标跟随真实窗口状态，并随 resize 事件更新", async () => {
    const win = fakeWindow();
    render(<WorkbenchWindowControls window={win} />);

    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();

    await act(async () => {
      win.setMaximized(true);
      win.fireResize();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();

    await act(async () => {
      win.setMaximized(false);
      win.fireResize();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
  });
});

describe("WorkbenchWindowControls · 关闭状态由协调器驱动", () => {
  it("saving：按钮持续 disabled，tooltip 说明正在保存并关闭", () => {
    render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={vi.fn()}
        closeState="saving"
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    expect(closeBtn.getAttribute("aria-busy")).toBe("true");
    expect(closeBtn.getAttribute("title")).toBe("正在保存并关闭工作台");
  });

  it("retrying-close：仍在关闭中，不得因为 close IPC 已返回而解锁", () => {
    render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={vi.fn()}
        closeState="retrying-close"
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    expect(closeBtn.getAttribute("aria-busy")).toBe("true");
  });

  it("closed：窗口已受理关闭，UI 不回到可点击（也不谎称还在保存）", () => {
    render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={vi.fn()}
        closeState="closed"
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    expect(closeBtn.getAttribute("aria-busy")).toBeNull();
    expect(closeBtn.getAttribute("title")).toBe("关闭工作台");
  });

  it("重复点击只产生一次关闭请求", () => {
    const onRequestClose = vi.fn();
    render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" });
    fireEvent.click(closeBtn);
    fireEvent.click(closeBtn);
    fireEvent.click(closeBtn);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("保存失败后恢复按钮，并把原因放到 tooltip", () => {
    const onRequestClose = vi.fn();
    const view = render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        closeState="saving"
      />,
    );
    let closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);

    view.rerender(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        closeState="failed"
        closeMessage="正文尚未保存，工作台窗口保持打开"
      />,
    );
    closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);
    expect(closeBtn.getAttribute("title")).toContain("正文尚未保存");

    fireEvent.click(closeBtn);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("close IPC reject 后同样恢复按钮并暴露错误", () => {
    const view = render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={vi.fn()}
        closeState="retrying-close"
      />,
    );
    view.rerender(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={vi.fn()}
        closeState="failed"
        closeMessage="IPC 断连"
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);
    expect(closeBtn.getAttribute("title")).toContain("IPC 断连");
  });

  it("Alt+F4 触发的关闭状态也会同步到标题栏", () => {
    // 原生关闭走的是同一笔事务：外壳把 coordinator 的 saving 状态传下来，
    // 标题栏必须呈现为「保存中」，而不是仍可点击。
    const view = render(
      <WorkbenchWindowControls window={fakeWindow()} onRequestClose={vi.fn()} closeState="idle" />,
    );
    expect(
      (screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    view.rerender(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={vi.fn()}
        closeState="saving"
      />,
    );
    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    expect(closeBtn.getAttribute("title")).toBe("正在保存并关闭工作台");
  });
});

describe("WorkbenchWindowControls · 关闭链路就绪状态（P0 2026-11-22）", () => {
  it("保护器未就绪：按钮 disabled 并显示「初始化中」，点击不发起关闭请求", () => {
    const onRequestClose = vi.fn();
    render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        closeReady={false}
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    expect(closeBtn.getAttribute("title")).toBe("关闭保护初始化中，请稍候…");

    fireEvent.click(closeBtn);
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("保护器就绪：恢复可用并可发起关闭请求", () => {
    const onRequestClose = vi.fn();
    const view = render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        closeReady={false}
      />,
    );
    view.rerender(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        closeReady={true}
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);
    fireEvent.click(closeBtn);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("保护器安装失败：保持未就绪并把原因放到 tooltip，不静默失去关闭能力", () => {
    const onRequestClose = vi.fn();
    render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        closeReady={false}
        closeMessage="工作台关闭保护未启用：监听注册失败"
      />,
    );

    const closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    expect(closeBtn.getAttribute("title")).toContain("工作台关闭保护未启用");
    fireEvent.click(closeBtn);
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("quitBusy：退出请求在途时保持 disabled + aria-busy；取消后恢复可重试", () => {
    const onRequestClose = vi.fn();
    const view = render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        quitBusy={true}
      />,
    );

    let closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    expect(closeBtn.getAttribute("aria-busy")).toBe("true");
    expect(closeBtn.getAttribute("title")).toBe("正在保存并退出应用…");

    // 退出被取消（app-exit-blocked）：外壳把 quitBusy 复位，按钮恢复可重试。
    view.rerender(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        quitBusy={false}
      />,
    );
    closeBtn = screen.getByRole("button", { name: "关闭工作台" }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);
    fireEvent.click(closeBtn);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("quitBusy 期间点击被 clickLock 拦截，busy 解除后不再被锁住", () => {
    const onRequestClose = vi.fn();
    const view = render(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        quitBusy={true}
      />,
    );
    // quitBusy=true 时按钮 disabled，click 无法触发（浏览器原生行为）。
    fireEvent.click(screen.getByRole("button", { name: "关闭工作台" }));
    expect(onRequestClose).not.toHaveBeenCalled();

    // busy 解除：clickLock 必须复位，否则按钮恢复后永远点不动（不允许永久锁定）。
    view.rerender(
      <WorkbenchWindowControls
        window={fakeWindow()}
        onRequestClose={onRequestClose}
        quitBusy={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭工作台" }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
