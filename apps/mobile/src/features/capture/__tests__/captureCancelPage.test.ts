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
    TextInput: host("input"),
    ScrollView: host("div"),
    Image: host("img"),
    Pressable,
    ActivityIndicator: () => React.createElement("span", null, "…"),
    Modal: (props: Record<string, unknown>) =>
      props.visible ? React.createElement("div", null, props.children as React.ReactNode) : null,
    Dimensions: { get: () => ({ width: 400, height: 800 }) },
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
vi.mock("../../../feedback/ToastProvider", () => ({
  useToast: () => ({ showToast: () => undefined }),
}));
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
    getAsset: async () => asset,
    setDestination: vi.fn(async () => undefined),
    renameAsset: vi.fn(async () => undefined),
    updateAssetNote: vi.fn(async () => undefined),
    deleteAsset: vi.fn(async () => []),
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

describe("CaptureStashScreen 取消上传接线", () => {
  beforeEach(() => {
    page.stagedAssets = [];
    page.sentOptions = null;
    page.resolveSend = null;
    page.sendCalls = 0;
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
    page.sentOptions = null;
    page.resolveSend = null;
    page.sendCalls = 0;
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
