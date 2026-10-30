/**
 * @vitest-environment jsdom
 */
//! UI Store 的浮层互斥（v0.6）：
//! - 任务上下文抽屉与剪贴板抽屉互斥：开一个必关另一个；
//! - 剪贴板抽屉的关联模式携带任务，关闭后清空；
//! - 切到剪贴板页面（Tab）不等于打开抽屉，两者互不影响。

import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./useUiStore";
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
