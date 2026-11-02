/**
 * @vitest-environment jsdom
 */
//! UI Store 的浮层互斥（v0.6）：
//! - 任务上下文抽屉与剪贴板抽屉互斥：开一个必关另一个；
//! - 剪贴板抽屉的关联模式携带任务，关闭后清空；
//! - 切到剪贴板页面（Tab）不等于打开抽屉，两者互不影响。

import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore, TOAST_QUEUE_MAX } from "./useUiStore";
import type { Task } from "../lib/bridge";

const TASK = { id: "t1", title: "写周报" } as unknown as Task;

beforeEach(() => {
  useUiStore.setState({
    tab: "tasks",
    editor: { open: false, task: null },
    workspace: { open: false, task: null },
    context: { open: false, task: null },
    clipboardOpen: false,
    clipboardLinkTask: null,
    clipboardLinkVersion: 0,
    toast: null,
    toasts: [],
  });
});

describe("浮层互斥", () => {
  it("打开任务上下文抽屉会关闭剪贴板抽屉", () => {
    useUiStore.getState().openClipboard();
    expect(useUiStore.getState().clipboardOpen).toBe(true);

    useUiStore.getState().openContext(TASK);
    expect(useUiStore.getState().context.open).toBe(true);
    expect(useUiStore.getState().clipboardOpen).toBe(false);
    expect(useUiStore.getState().clipboardLinkTask).toBeNull();
  });

  it("打开剪贴板抽屉会关闭任务上下文抽屉", () => {
    useUiStore.getState().openContext(TASK);
    useUiStore.getState().openClipboard();
    expect(useUiStore.getState().clipboardOpen).toBe(true);
    expect(useUiStore.getState().context.open).toBe(false);
  });

  it("关联模式携带任务，关闭抽屉后清空关联目标", () => {
    useUiStore.getState().openClipboard({ linkTask: TASK });
    expect(useUiStore.getState().clipboardLinkTask?.id).toBe("t1");

    useUiStore.getState().closeClipboard();
    expect(useUiStore.getState().clipboardOpen).toBe(false);
    expect(useUiStore.getState().clipboardLinkTask).toBeNull();
  });

  it("切到剪贴板标签页不会打开抽屉（页面与抽屉是两种形态）", () => {
    useUiStore.getState().setTab("clipboard");
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });

  it("关联版本号只增不减，用于任务编辑器重读关联列表", () => {
    const before = useUiStore.getState().clipboardLinkVersion;
    useUiStore.getState().bumpClipboardLink();
    expect(useUiStore.getState().clipboardLinkVersion).toBe(before + 1);
  });
});

describe("Toast 队列", () => {
  it("连续消息进入队列，旧消息不被覆盖", () => {
    const { showToast } = useUiStore.getState();
    showToast("已复制", { kind: "success" });
    showToast("已删除", { kind: "info" });
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.map((t) => t.message)).toEqual(["已复制", "已删除"]);
  });

  it("支持 warning 类型", () => {
    useUiStore.getState().showToast("配置已降级", { kind: "warning" });
    expect(useUiStore.getState().toasts[0].kind).toBe("warning");
  });

  it("相同消息短时间去重：同文案同类型不重复入队", () => {
    const { showToast } = useUiStore.getState();
    showToast("已复制", { kind: "success" });
    showToast("已复制", { kind: "success" });
    expect(useUiStore.getState().toasts).toHaveLength(1);
    // 类型不同仍视为不同提示
    showToast("已复制", { kind: "error" });
    expect(useUiStore.getState().toasts).toHaveLength(2);
  });

  it("队列有上限：超出时优先挤掉最早的普通提示，错误保留", () => {
    const { showToast } = useUiStore.getState();
    showToast("普通 1", { kind: "info" });
    showToast("普通 2", { kind: "success" });
    showToast("出错了", { kind: "error" });
    showToast("普通 3", { kind: "info" }); // 超上限：挤掉最早的普通提示「普通 1」
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(TOAST_QUEUE_MAX);
    expect(toasts.map((t) => t.message)).toEqual(["普通 2", "出错了", "普通 3"]);
    expect(toasts.some((t) => t.kind === "error"), "错误提示不被挤出队列").toBe(true);
  });

  it("dismissToast(id) 只关对应条目；无参调用清空全部", () => {
    const { showToast, dismissToast } = useUiStore.getState();
    showToast("A", { kind: "info" });
    showToast("B", { kind: "info" });
    const first = useUiStore.getState().toasts[0];
    dismissToast(first.id);
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(["B"]);
    dismissToast();
    expect(useUiStore.getState().toasts).toHaveLength(0);
    expect(useUiStore.getState().toast).toBeNull();
  });
});
