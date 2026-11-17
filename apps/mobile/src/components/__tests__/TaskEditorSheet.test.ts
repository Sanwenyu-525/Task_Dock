/* @vitest-environment jsdom */
// TaskEditorSheet 提交契约回归：
// 保存失败必须保留输入并允许修改后重试；保存成功才关闭；保存中禁止重复提交。
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { TaskEditorSheet } from "../TaskEditorSheet";

vi.mock("react-native", async () => {
  const React = await import("react");
  const clean = (props: Record<string, unknown>) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (
        key === "children" ||
        key === "style" ||
        key === "contentStyle" ||
        key === "contentContainerStyle" ||
        key === "hitSlop" ||
        key === "accessibilityHint" ||
        key === "accessibilityLiveRegion" ||
        key === "autoFocus" ||
        key === "autoCapitalize" ||
        key === "autoCorrect" ||
        key === "returnKeyType" ||
        key === "underlineColorAndroid" ||
        key === "placeholderTextColor" ||
        key === "keyboardShouldPersistTaps" ||
        key === "showsVerticalScrollIndicator"
      ) {
        continue;
      }
      if (key === "accessibilityLabel") next["aria-label"] = value;
      else if (key === "accessibilityRole" || key === "accessibilityState") continue;
      else if (key.startsWith("on")) continue;
      else next[key] = value;
    }
    return next;
  };
  const host = (tag: string) => (props: Record<string, unknown>) =>
    React.createElement(tag, clean(props), props.children as React.ReactNode);
  const Pressable = (props: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        ...clean(props),
        "aria-disabled": Boolean(props.disabled),
        onClick: props.onPress as (() => void) | undefined,
      },
      props.children as React.ReactNode,
    );
  const TextInput = (props: Record<string, unknown>) => {
    const onChangeText = props.onChangeText as ((value: string) => void) | undefined;
    return React.createElement("input", {
      ...clean(props),
      value: props.value as string,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        onChangeText?.(event.target.value);
      },
    });
  };
  return {
    View: host("div"),
    Text: host("span"),
    TextInput,
    ScrollView: host("div"),
    Pressable,
    ActivityIndicator: () => React.createElement("span", null, "saving-indicator"),
    Dimensions: { get: () => ({ width: 400, height: 800 }) },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  };
});

vi.mock("../BottomSheet", async () => {
  const React = await import("react");
  return {
    BottomSheet: (props: Record<string, unknown>) =>
      props.visible
        ? React.createElement("div", null, props.children as React.ReactNode)
        : null,
  };
});
vi.mock("../Chip", async () => {
  const React = await import("react");
  return {
    Chip: (props: Record<string, unknown>) =>
      React.createElement(
        "button",
        {
          "aria-label": props.accessibilityLabel,
          onClick: props.onPress as (() => void) | undefined,
        },
        props.label as React.ReactNode,
      ),
  };
});
vi.mock("../AttachmentStrip", async () => {
  const React = await import("react");
  return { AttachmentStrip: () => React.createElement("div") };
});
vi.mock("../../theme/ThemeProvider", () => ({
  useTheme: () => ({
    tokens: new Proxy({}, { get: () => "#000" }),
  }),
}));

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];

// 与既有组件测试一致：声明 jsdom 支持 act，避免控制台噪音并保证状态更新时序。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderEditor(onSubmit: (input: unknown) => Promise<unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      React.createElement(TaskEditorSheet, {
        visible: true,
        mode: "create",
        onClose,
        onSubmit: onSubmit as never,
      }),
    );
  });
  mounted.push({ root, host });
  return { host, onClose };
}

function fillTitle(host: HTMLDivElement, text: string) {
  const input = host.querySelector('input[aria-label="任务标题"]') as HTMLInputElement | null;
  expect(input).not.toBeNull();
  // React 受控输入：用原生 setter + input 事件，触发 onChangeText。
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, text);
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickSave(host: HTMLDivElement) {
  const button = host.querySelector('button[aria-label="保存任务"]') as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  act(() => {
    button!.click();
  });
}

afterEach(() => {
  while (mounted.length) {
    const item = mounted.pop()!;
    act(() => item.root.unmount());
    item.host.remove();
  }
});

describe("TaskEditorSheet 保存契约", () => {
  it("保存失败：弹层不关闭、输入保留并显示失败原因", async () => {
    const { host, onClose } = await renderEditor(async () => ({
      ok: false,
      message: "磁盘空间不足",
    }));

    fillTitle(host, "买牛奶");
    clickSave(host);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect((host.querySelector('input[aria-label="任务标题"]') as HTMLInputElement).value).toBe(
      "买牛奶",
    );
    expect(host.textContent).toContain("保存失败：磁盘空间不足");
    expect(host.textContent).toContain("输入内容已保留");
  });

  it("保存成功才关闭弹层", async () => {
    const { host, onClose } = await renderEditor(async () => ({ ok: true }));
    fillTitle(host, "写周报");
    clickSave(host);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("保存中连续点击只提交一次", async () => {
    let release: ((value: unknown) => void) | null = null;
    const onSubmit = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { host } = await renderEditor(onSubmit);
    fillTitle(host, "整理桌面");
    clickSave(host);
    clickSave(host);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.({ ok: true });
      await Promise.resolve();
    });
  });

  it("调用方抛异常也按失败处理，输入不丢", async () => {
    const { host, onClose } = await renderEditor(async () => {
      throw new Error("database locked");
    });
    fillTitle(host, "备份照片");
    clickSave(host);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect((host.querySelector('input[aria-label="任务标题"]') as HTMLInputElement).value).toBe(
      "备份照片",
    );
    expect(host.textContent).toContain("database locked");
  });
});
