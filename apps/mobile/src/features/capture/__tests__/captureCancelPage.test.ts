/* @vitest-environment jsdom */
// 页面级取消接线测试：用真实 React 组件 + DOM 宿主，验证「忙碌面板的取消按钮」
// 确实把取消意图传给 sendToDesktop 的 cancelToken，而不是只在 service 单测里成立。
// 原生组件与数据库边界用替身；页面状态机、按钮渲染、Tauri/文件业务代码原样运行。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const page = vi.hoisted(() => ({
  asset: {
    id: "asset-1",
    kind: "file" as const,
    source: "file_picker" as const,
    name: "报告.pdf",
    localPath: "file:///data/user/0/dev.taskdock.mobile/files/taskdock-captures/library/report.pdf",
    mime: "application/pdf",
    byteSize: 603,
    sha256: "c".repeat(64),
    width: null,
    height: null,
    durationMs: null,
    thumbnailPath: null,
    note: "",
    favorite: false,
    projectId: null,
    state: "saved" as const,
    createdAt: 1,
    updatedAt: 1,
    lastError: null,
  },
  stagedAssets: [] as Array<Record<string, unknown>>,
  sentOptions: null as Record<string, unknown> | null,
  resolveSend: null as ((value: unknown) => void) | null,
  sendCalls: 0,
  toasts: [] as string[],
  renameError: null as Error | null,
  noteError: null as Error | null,
  reloadError: null as Error | null,
  renameCalls: 0,
  noteCalls: 0,
  deleteError: null as Error | null,
  deleteCalls: 0,
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const clean = (props: Record<string, unknown>) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "children" || key === "style" || key === "contentStyle") continue;
      if (key === "accessibilityLabel") next["aria-label"] = value;
      else if (key === "accessibilityRole" || key === "accessibilityState") continue;
      else if (key === "numberOfLines" || key.startsWith("on")) continue;
      else next[key] = value;
    }
    return next;
  };
  const host = (tag: string) => (props: Record<string, unknown>) =>
    React.createElement(tag, clean(props), props.children as React.ReactNode);
  const TextInput = (props: Record<string, unknown>) =>
    React.createElement("input", {
      ...clean(props),
      value: props.value as string | undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        (props.onChangeText as ((value: string) => void) | undefined)?.(event.target.value);
      },
      onBlur: () => {
        (props.onEndEditing as (() => void) | undefined)?.();
      },
    });
  const Pressable = (props: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        ...clean(props),
        disabled: Boolean(props.disabled),
        onClick: props.onPress as (() => void) | undefined,
      },
      props.children as React.ReactNode,
    );
  return {
    View: host("div"),
    Text: host("span"),
    TextInput,
    ScrollView: host("div"),
    Image: host("img"),
    Pressable,
    ActivityIndicator: () => React.createElement("span", null, "…"),
    Modal: (props: Record<string, unknown>) =>
      props.visible ? React.createElement("div", null, props.children as React.ReactNode) : null,
    Dimensions: { get: () => ({ width: 400, height: 800 }) },
    Animated: {
      Value: class {
        constructor(public value: number) {}
        setValue(value: number) {
          this.value = value;
        }
      },
      View: host("div"),
      timing: () => ({
        start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
      }),
      spring: () => ({
        start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
      }),
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    StyleSheet: {
      create: (value: unknown) => value,
      hairlineWidth: 1,
      absoluteFill: {},
    },
    Alert: { alert: vi.fn() },
  };
});

vi.mock("../../../components/AppBar", async () => {
  const React = await import("react");
  return {
    AppBar: (props: Record<string, unknown>) =>
      React.createElement("div", null, props.title as React.ReactNode, props.right as React.ReactNode),
  };
});
vi.mock("../../../components/PressableScale", async () => {
  const React = await import("react");
  return {
    PressableScale: (props: Record<string, unknown>) =>
      React.createElement(
        "button",
        { disabled: Boolean(props.disabled), onClick: props.onPress as (() => void) | undefined },
        props.children as React.ReactNode,
      ),
  };
});
vi.mock("../../../components/BulkActionBar", async () => {
  const React = await import("react");
  return {
    BULK_ACTION_BAR_HEIGHT: 56,
    BulkActionBar: (props: Record<string, unknown>) =>
      React.createElement(
        "div",
        null,
        ...((props.actions as Array<{ key: string; label: string; onPress: () => void }>) ?? []).map(
          (action) =>
            React.createElement(
              "button",
              { key: action.key, onClick: action.onPress },
              action.label,
            ),
        ),
      ),
  };
});
vi.mock("../../../components/BottomSheet", async () => {
  const React = await import("react");
  return {
    BottomSheet: (props: Record<string, unknown>) =>
      props.visible ? React.createElement("div", null, props.children as React.ReactNode) : null,
  };
});
vi.mock("../../../components/EmptyState", async () => {
  const React = await import("react");
  return {
    EmptyState: (props: Record<string, unknown>) =>
      React.createElement("div", null, props.title as React.ReactNode),
  };
});
vi.mock("../../../components/FileTypeIcon", async () => {
  const React = await import("react");
  return {
    FileTypeIcon: () => React.createElement("span", null, "FILE"),
    fileTypeOf: () => "file",
  };
});
vi.mock("../../../components/ImageLightbox", async () => {
  const React = await import("react");
  return {
    ImageLightbox: () => React.createElement("div", null),
  };
});
vi.mock("../../../components/SearchField", async () => {
  const React = await import("react");
  return {
    SearchField: () => React.createElement("input", { "aria-label": "搜索本机素材" }),
  };
});
vi.mock("../../../components/SegmentedControl", async () => {
  const React = await import("react");
  return {
    SegmentedControl: () => React.createElement("div", null),
  };
});
vi.mock("../../../feedback/ToastProvider", () => {
  // 必须返回稳定引用：页面 load 的 useCallback 依赖 showToast，若每次 render 都新建函数，
  // Effect 会反复触发 load 并造成页面级测试超时。
  const showToast = (message: string) => {
    page.toasts.push(message);
  };
  return { useToast: () => ({ showToast }), useToastScope: () => "global" };
});
vi.mock("../../../components/icons/AppIcon", async () => {
  const React = await import("react");
  return { AppIcon: () => React.createElement("span", null) };
});
vi.mock("../../../theme/ThemeProvider", () => ({
  useTheme: () => ({
    tokens: new Proxy({}, { get: () => "#000" }),
  }),
}));
vi.mock("../../../lib/insets", () => ({
  useWindowInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../../lib/keyboard", () => ({ useKeyboardHeight: () => 0 }));
vi.mock("../revision", () => ({
  bumpCaptureRevision: vi.fn(),
  subscribeCaptureRevision: () => () => undefined,
}));
vi.mock("../files", () => ({ deleteFileQuietly: vi.fn() }));
vi.mock("../status", () => ({
  captureStatusOf: () => ({ label: "待处理", tone: "neutral" }),
  statusTone: () => "#000",
}));
vi.mock("../components/ImageCropOverlay", async () => {
  const React = await import("react");
  return {
    CROP_DEFAULT: { x: 0, y: 0, width: 1, height: 1 },
    ImageCropOverlay: () => React.createElement("div", null),
    ZoomableImage: (props: Record<string, unknown>) =>
      React.createElement("div", null, props.children as React.ReactNode),
  };
});

vi.mock("../../../db/captureAssets", async () => {
  const asset = page.asset;
  return {
    listAssets: async () => [asset],
    listStagedAssets: async () => page.stagedAssets,
    listAllDestinations: async () => [],
    listDestinations: async () => [],
    getAsset: async () => {
      if (page.reloadError) throw page.reloadError;
      return asset;
    },
    setDestination: vi.fn(async () => undefined),
    renameAsset: vi.fn(async () => {
      page.renameCalls += 1;
      if (page.renameError) throw page.renameError;
    }),
    updateAssetNote: vi.fn(async () => {
      page.noteCalls += 1;
      if (page.noteError) throw page.noteError;
    }),
    setAssetFavorite: vi.fn(async () => undefined),
    deleteAsset: vi.fn(async () => {
      page.deleteCalls += 1;
      if (page.deleteError) throw page.deleteError;
      return [];
    }),
  };
});

vi.mock("../service", () => {
  return {
    captureAvailability: async () => ({
      paired: true,
      legacy: false,
      serverName: "DESKTOP",
      reason: null,
    }),
    reconcileShelfDestinations: async () => ({ checked: 0, stale: 0, updated: 0 }),
    listShelfGroups: async () => [],
    saveToLocal: async (asset: unknown) => asset,
    saveToAlbum: vi.fn(async () => undefined),
    transformStagedAsset: async (asset: unknown) => asset,
    retryShelfImport: vi.fn(async () => ({
      state: "done",
      remoteId: "f".repeat(32),
      remoteShelfId: "mf-r",
      message: "已加入暂存架",
      stopBatch: false,
    })),
    cleanupStagedAfterRun: vi.fn(async () => 0),
    sendToDesktop: vi.fn(async (_assets: unknown, options: Record<string, unknown>) => {
      page.sendCalls += 1;
      page.sentOptions = options;
      return new Promise((resolve) => {
        page.resolveSend = resolve;
      });
    }),
  };
});


import { CaptureStashScreen } from "../CaptureStashScreen";
import { CaptureReviewScreen } from "../CaptureReviewScreen";

const nav = { back: vi.fn(), push: vi.fn() } as never;

function resetPage() {
  page.sentOptions = null;
  page.resolveSend = null;
  page.sendCalls = 0;
  page.toasts = [];
  page.renameError = null;
  page.noteError = null;
  page.reloadError = null;
  page.renameCalls = 0;
  page.noteCalls = 0;
  page.deleteError = null;
  page.deleteCalls = 0;
}

function anyButton(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}


async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function changeInput(host: HTMLElement, label: string, value: string) {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  if (!input) throw new Error(`input not found: ${label}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("value setter unavailable");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function mountReview() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(CaptureReviewScreen, { nav }));
  });
  await flush();
  return { host, root };
}

async function mountStash() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(CaptureStashScreen, { nav }));
  });
  await flush();
  return { host, root };
}

describe("CaptureStashScreen 取消上传接线", () => {
  beforeEach(() => {
    page.stagedAssets = [];
    resetPage();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("选择素材 -> 发电脑 -> 忙碌面板取消按钮会置位 cancelToken", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(CaptureStashScreen, { nav }));
    });
    await flush();

    await act(async () => {
      anyButton(host, "选择").click();
    });
    await flush();
    await act(async () => {
      host.querySelector('button[aria-label="报告.pdf"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    await act(async () => {
      anyButton(host, "发电脑").click();
    });
    await flush();

    expect(page.sendCalls).toBe(1);
    expect(page.sentOptions?.cancelToken).toBeTruthy();
    expect(anyButton(host, "取消上传")).toBeTruthy();

    await act(async () => {
      anyButton(host, "取消上传").click();
    });
    const token = page.sentOptions?.cancelToken as { cancelled?: boolean };
    expect(token.cancelled).toBe(true);
    expect(anyButton(host, "正在取消…")).toBeTruthy();

    await act(async () => {
      page.resolveSend?.({ outcomes: [{ assetId: page.asset.id, state: "cancelled" }], offline: false });
    });
    await flush();
    root.unmount();
    host.remove();
  });
});

describe("CaptureReviewScreen 取消上传接线", () => {
  beforeEach(() => {
    page.stagedAssets = [page.asset];
    resetPage();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("勾选发送到电脑 -> 保存 -> 取消按钮会置位 cancelToken", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(CaptureReviewScreen, { nav }));
    });
    await flush();

    await act(async () => {
      anyButton(host, "发送到电脑").click();
    });
    await flush();
    await act(async () => {
      anyButton(host, "保存到所选位置").click();
    });
    await flush();

    expect(page.sendCalls).toBe(1);
    expect(page.sentOptions?.cancelToken).toBeTruthy();
    expect(anyButton(host, "取消上传")).toBeTruthy();

    await act(async () => {
      anyButton(host, "取消上传").click();
    });
    const token = page.sentOptions?.cancelToken as { cancelled?: boolean };
    expect(token.cancelled).toBe(true);

    await act(async () => {
      page.resolveSend?.({ outcomes: [{ assetId: page.asset.id, state: "cancelled" }], offline: false });
    });
    await flush();
    root.unmount();
    host.remove();
  });
});

describe("CaptureReviewScreen 保存前置失败恢复（P1）", () => {
  beforeEach(() => {
    page.stagedAssets = [page.asset];
    resetPage();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("SQLite 改名失败：显示明确错误、释放 busy、不发送、不删本机素材", async () => {
    page.renameError = new Error("database is locked");
    const { host, root } = await mountReview();
    await act(async () => {
      anyButton(host, "发送到电脑").click();
    });
    await flush();
    await changeInput(host, "文件名", "新的文件名.pdf");
    await act(async () => {
      anyButton(host, "保存到所选位置").click();
    });
    await flush();

    expect(page.renameCalls).toBe(1);
    expect(page.noteCalls).toBe(0);
    expect(page.sendCalls).toBe(0);
    expect(page.deleteCalls).toBe(0);
    expect(page.toasts.join("\n")).toContain("文件名保存失败");
    expect(page.toasts.join("\n")).toContain("database is locked");
    expect(anyButton(host, "保存到所选位置")).toBeTruthy();
    root.unmount();
    host.remove();
  });

  it("备注写入失败：提示明确错误、不误报上传成功、释放 busy", async () => {
    page.noteError = new Error("attempt to write a readonly database");
    const { host, root } = await mountReview();
    await act(async () => {
      anyButton(host, "发送到电脑").click();
    });
    await flush();
    await changeInput(host, "备注", "这条备注写不进去");
    await act(async () => {
      anyButton(host, "保存到所选位置").click();
    });
    await flush();

    expect(page.noteCalls).toBe(1);
    expect(page.sendCalls).toBe(0);
    expect(page.toasts.join("\n")).toContain("备注保存失败");
    expect(page.toasts.join("\n")).not.toContain("已完成");
    expect(anyButton(host, "保存到所选位置")).toBeTruthy();
    root.unmount();
    host.remove();
  });

  it("改名成功但 reload 失败：提示刷新失败、可再次保存、素材仍在", async () => {
    page.reloadError = new Error("refresh failed");
    const { host, root } = await mountReview();
    await act(async () => {
      anyButton(host, "发送到电脑").click();
    });
    await flush();
    await changeInput(host, "文件名", "已改名但刷新失败.pdf");
    await act(async () => {
      anyButton(host, "保存到所选位置").click();
    });
    await flush();

    expect(page.renameCalls).toBe(1);
    expect(page.sendCalls).toBe(0);
    expect(page.deleteCalls).toBe(0);
    expect(page.toasts.join("\n")).toContain("文件名保存失败");
    expect(page.toasts.join("\n")).toContain("refresh failed");
    expect(page.stagedAssets).toHaveLength(1);
    expect(anyButton(host, "保存到所选位置")).toBeTruthy();
    root.unmount();
    host.remove();
  });

  it("失败后再次保存：busy 已释放，重试能继续发送且只发一次", async () => {
    page.renameError = new Error("temporary write failure");
    const { host, root } = await mountReview();
    await act(async () => {
      anyButton(host, "发送到电脑").click();
    });
    await flush();
    await changeInput(host, "文件名", "重试后成功.pdf");

    await act(async () => {
      anyButton(host, "保存到所选位置").click();
    });
    await flush();
    expect(page.sendCalls).toBe(0);

    page.renameError = null;
    await act(async () => {
      anyButton(host, "保存到所选位置").click();
    });
    await flush();
    expect(page.renameCalls).toBe(2);
    expect(page.sendCalls).toBe(1);

    await act(async () => {
      page.resolveSend?.({
        outcomes: [
          {
            assetId: page.asset.id,
            state: "done",
            remoteId: "f".repeat(32),
            shelfId: "mf-" + "f".repeat(32),
          },
        ],
        offline: false,
      });
    });
    await flush();
    expect(page.toasts.join("\n")).toContain("已完成");
    root.unmount();
    host.remove();
  });
});

describe("CaptureStashScreen 静默失败兜底", () => {
  beforeEach(() => {
    resetPage();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("详情保存改名失败：显示错误且释放 busy", async () => {
    page.renameError = new Error("disk I/O error");
    const { host, root } = await mountStash();
    await act(async () => {
      host.querySelector('button[aria-label="报告.pdf"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    await changeInput(host, "文件名", "详情改名失败.pdf");
    await act(async () => {
      anyButton(host, "保存修改").click();
    });
    await flush();

    expect(page.renameCalls).toBe(1);
    expect(page.toasts.join("\n")).toContain("文件名保存失败");
    expect(page.toasts.join("\n")).toContain("disk I/O error");
    root.unmount();
    host.remove();
  });
});