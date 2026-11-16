/* @vitest-environment jsdom */
// ToastProvider 集成测试：用真实 Provider + React 生命周期验证 scope 丢弃、
// 页面切换清队列、当前条保留，以及「页面挂载首帧提示」与 Shell 更新顺序。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useEffect, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ToastProvider, ToastScope, useToast, useToastState } from "../ToastProvider";
import type { ToastState } from "../toastQueue";

interface ProbeApi {
  setActiveScope: (scope: string) => void;
  showToast: (
    text: string,
    tone?: "info" | "success" | "warn" | "danger",
    placement?: "top" | "bottom",
  ) => void;
  dismissToast: (id: number) => void;
  clearToasts: () => void;
}

let latest: { state: ToastState; api: ProbeApi } | null = null;

function Probe() {
  const state = useToastState();
  const api = useToast();
  latest = { state, api };
  return <div data-testid="probe">{state.current?.text ?? ""}</div>;
}

function Harness({ scope, children }: { scope: string; children?: ReactNode }) {
  return (
    <ToastScope scope={scope}>
      {children}
      <Probe />
    </ToastScope>
  );
}

/** 模拟 Shell：activeScope 在 layout effect 中切换，子页面在 passive effect 中发提示。 */
function MountingPage({ scope, text }: { scope: string; text: string }) {
  const toast = useToast();
  useLayoutEffect(() => {
    toast.setActiveScope(scope);
  }, [scope, toast]);
  useEffect(() => {
    toast.showToast(text, "success", "top");
  }, [scope, text, toast]);
  return null;
}

/** 模拟 Shell：activeScope 在 render 阶段同步，子页面在 layout effect 中发提示。 */
function SyncScope({ scope, text }: { scope: string; text: string }) {
  const toast = useToast();
  toast.syncActiveScope(scope);
  return (
    <ToastScope scope={scope}>
      <PageOnLayout text={text} />
    </ToastScope>
  );
}

function PageOnLayout({ text }: { text: string }) {
  const toast = useToast();
  useLayoutEffect(() => {
    toast.showToast(text, "success", "top");
  }, [text, toast]);
  return null;
}

describe("ToastProvider integration", () => {
  let root: Root;

  beforeEach(() => {
    latest = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(node);
    });
  }

  it("活动 scope 的消息正常入队，隐藏页面的晚到消息被丢弃", async () => {
    await render(
      <ToastProvider>
        <Harness scope="tab:home" />
      </ToastProvider>,
    );
    act(() => latest!.api.setActiveScope("tab:home"));
    act(() => latest!.api.showToast("首页保存完成", "success", "top"));
    expect(latest!.state.current?.text).toBe("首页保存完成");

    act(() => latest!.api.setActiveScope("tab:notes"));
    act(() => latest!.api.showToast("首页异步完成", "success", "top"));
    expect(latest!.state.queue).toHaveLength(0);
    expect(latest!.state.current?.text).toBe("首页保存完成");
  });

  it("切入新页面清空旧页排队消息，但允许当前条播完", async () => {
    await render(
      <ToastProvider>
        <Harness scope="tab:home" />
      </ToastProvider>,
    );
    act(() => latest!.api.setActiveScope("tab:home"));
    act(() => latest!.api.showToast("正在显示", "info", "top"));
    act(() => latest!.api.showToast("旧页排队", "success", "top"));
    expect(latest!.state.current?.text).toBe("正在显示");
    expect(latest!.state.queue).toHaveLength(1);

    act(() => latest!.api.setActiveScope("tab:tasks"));
    expect(latest!.state.current?.text).toBe("正在显示");
    expect(latest!.state.queue).toHaveLength(0);
  });

  it("页面挂载首帧提示不会因 activeScope 晚一拍而丢失", async () => {
    await render(
      <ToastProvider>
        <ToastScope scope="push:note_editor">
          <MountingPage scope="push:note_editor" text="编辑器已打开" />
        </ToastScope>
      </ToastProvider>,
    );
    expect(latest!.state.current?.text).toBe("编辑器已打开");
    expect(latest!.state.current?.scope).toBe("push:note_editor");
  });

  it("render 阶段同步 scope 后，子页面 layout effect 的提示不会丢", async () => {
    await render(
      <ToastProvider>
        <SyncScope scope="push:capture_review" text="已进入处理页" />
      </ToastProvider>,
    );
    expect(latest!.state.current?.text).toBe("已进入处理页");
    expect(latest!.state.current?.scope).toBe("push:capture_review");
  });

  it("快速连续切换页面不串台，新页面消息按自己的 scope 入队", async () => {
    await render(
      <ToastProvider>
        <Harness scope="tab:home" />
      </ToastProvider>,
    );
    act(() => latest!.api.setActiveScope("tab:home"));
    act(() => latest!.api.showToast("首页消息", "info", "top"));
    act(() => latest!.api.setActiveScope("tab:tasks"));
    await render(
      <ToastProvider>
        <Harness scope="tab:tasks" />
      </ToastProvider>,
    );
    act(() => latest!.api.setActiveScope("tab:tasks"));
    act(() => latest!.api.showToast("任务消息", "success", "bottom"));
    expect(latest!.state.current?.text).toBe("首页消息");
    expect(latest!.state.queue[0]?.text).toBe("任务消息");
    expect(latest!.state.queue[0]?.scope).toBe("tab:tasks");
  });
});
