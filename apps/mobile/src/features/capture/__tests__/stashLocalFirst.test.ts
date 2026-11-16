/* @vitest-environment jsdom */
// 暂存页 Local First 回归：首屏只依赖本地 SQLite；远程对账在页面已展示后才执行。
// 使用真实 React 组件和 jsdom，原生组件/数据库边界用替身，验证用户可见行为而不是只测私有函数。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const page = vi.hoisted(() => ({
  assets: [] as Array<Record<string, unknown>>,
  assetResults: [] as Array<Array<Record<string, unknown>>>,
  destinations: [] as Array<Record<string, unknown>>,
  staged: [] as Array<Record<string, unknown>>,
  pairing: {
    paired: true,
    legacy: false,
    serverName: "DESKTOP",
    reason: null as string | null,
  },
  localError: null as Error | null,
  reconcileDeferred: null as {
    promise: Promise<{ checked: number; stale: number; updated: number }>;
    resolve: (value: { checked: number; stale: number; updated: number }) => void;
    reject: (error: Error) => void;
  } | null,
  reconcileError: null as Error | null,
  reconcileCalls: 0,
  listCalls: 0,
  destinationCalls: 0,
  deleteCalls: 0,
  revisionListeners: [] as Array<() => void>,
}));

function assetName(index: number, prefix = "素材"): Record<string, unknown> {
  return {
    id: `${prefix}-${index}`,
    kind: "photo",
    source: "camera",
    name: `${prefix}-${String(index).padStart(2, "0")}.jpg`,
    localPath: `file:///local/${prefix}-${index}.jpg`,
    mime: "image/jpeg",
    byteSize: 32,
    sha256: "a".repeat(64),
    width: 10,
    height: 10,
    durationMs: null,
    thumbnailPath: null,
    note: "",
    favorite: false,
    projectId: null,
    state: "saved",
    createdAt: index,
    updatedAt: index,
    lastError: null,
  };
}

function assets(count: number, prefix = "素材"): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => assetName(index + 1, prefix));
}

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
        key === "resizeMode" ||
        key === "showsVerticalScrollIndicator"
      ) {
        continue;
      }
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
      "div",
      {
        ...clean(props),
        role: "button",
        "aria-disabled": Boolean(props.disabled),
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
    ActivityIndicator: () => React.createElement("span", null, "loading-indicator"),
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
        "div",
        {
          role: "button",
          "aria-disabled": Boolean(props.disabled),
          "aria-label": props.accessibilityLabel,
          onClick: props.onPress as (() => void) | undefined,
        },
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
          (action) => React.createElement("button", { key: action.key, onClick: action.onPress }, action.label),
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
      React.createElement(
        "div",
        null,
        props.title as React.ReactNode,
        props.hint as React.ReactNode,
        props.actionLabel && props.onAction
          ? React.createElement(
              "button",
              { onClick: props.onAction as () => void },
              props.actionLabel as React.ReactNode,
            )
          : null,
      ),
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
  return { ImageLightbox: () => React.createElement("div", null) };
});
vi.mock("../../../components/SearchField", async () => {
  const React = await import("react");
  return {
    SearchField: () => React.createElement("input", { "aria-label": "搜索本机素材" }),
  };
});
vi.mock("../../../components/SegmentedControl", async () => {
  const React = await import("react");
  return { SegmentedControl: () => React.createElement("div", null) };
});
vi.mock("../../../feedback/ToastProvider", () => {
  const showToast = () => undefined;
  return { useToast: () => ({ showToast }), useToastScope: () => "global" };
});
vi.mock("../../../feedback/ToastLayoutProvider", () => ({
  useToastBottomAnchor: () => ({ onLayout: () => undefined }),
}));
vi.mock("../../../components/icons/AppIcon", async () => {
  const React = await import("react");
  return { AppIcon: () => React.createElement("span", null) };
});
vi.mock("../../../theme/ThemeProvider", () => ({
  useTheme: () => ({ tokens: new Proxy({}, { get: () => "#000" }) }),
}));
vi.mock("../../../lib/insets", () => ({
  useWindowInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../../lib/keyboard", () => ({ useKeyboardHeight: () => 0 }));
vi.mock("../revision", () => ({
  bumpCaptureRevision: vi.fn(),
  subscribeCaptureRevision: (listener: () => void) => {
    page.revisionListeners.push(listener);
    return () => {
      const index = page.revisionListeners.indexOf(listener);
      if (index >= 0) page.revisionListeners.splice(index, 1);
    };
  },
}));
vi.mock("../files", () => ({ deleteFileQuietly: vi.fn() }));
vi.mock("../status", () => ({
  captureStatusOf: () => ({ label: "待处理", tone: "neutral" }),
  statusTone: () => "#000",
}));
vi.mock("../../../domain/taskQuery", () => ({
  formatRelative: () => "刚刚",
}));
vi.mock("../../../lib/sync/fileIo", () => ({
  formatBytes: () => "32 B",
  previewLocalFile: async () => undefined,
}));
vi.mock("../sendFeedback", () => ({
  feedbackForOutcome: () => ({ message: "ok", tone: "success" }),
  feedbackForSendResult: () => ({ message: "ok", tone: "success" }),
  feedbackForShelfRetry: () => ({ message: "ok", tone: "success" }),
}));

vi.mock("../../../db/captureAssets", async () => {
  return {
    listAssets: async () => {
      page.listCalls += 1;
      if (page.localError) throw page.localError;
      return page.assetResults.length > 0 ? page.assetResults.shift()! : page.assets;
    },
    listAllDestinations: async () => {
      page.destinationCalls += 1;
      return page.destinations;
    },
    listStagedAssets: async () => page.staged,
    deleteAsset: async () => {
      page.deleteCalls += 1;
      return [];
    },
    setDestination: vi.fn(async () => undefined),
    renameAsset: vi.fn(async () => undefined),
    updateAssetNote: vi.fn(async () => undefined),
    setAssetFavorite: vi.fn(async () => undefined),
    getAsset: vi.fn(async () => null),
  };
});

vi.mock("../service", () => ({
  captureAvailability: async () => page.pairing,
  reconcileShelfDestinations: async () => {
    page.reconcileCalls += 1;
    if (page.reconcileError) throw page.reconcileError;
    if (page.reconcileDeferred) return page.reconcileDeferred.promise;
    return { checked: 0, stale: 0, updated: 0 };
  },
  retryShelfImport: vi.fn(async () => ({
    state: "done",
    remoteId: "f".repeat(32),
    remoteShelfId: "mf-r",
    message: "已加入暂存架",
    stopBatch: false,
  })),
  saveToAlbum: vi.fn(async () => undefined),
  sendToDesktop: vi.fn(async () => ({
    outcomes: [],
    offline: false,
    message: undefined,
    stopBatch: false,
  })),
}));

import { CaptureStashScreen } from "../CaptureStashScreen";

const nav = { back: vi.fn(), push: vi.fn() } as never;

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderPage() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(CaptureStashScreen, { nav }));
  });
  await flush();
  return { host, root };
}

function makeDeferred() {
  let resolve!: (value: { checked: number; stale: number; updated: number }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ checked: number; stale: number; updated: number }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  page.assets = [];
  page.assetResults = [];
  page.destinations = [];
  page.staged = [];
  page.pairing = { paired: true, legacy: false, serverName: "DESKTOP", reason: null };
  page.localError = null;
  page.reconcileDeferred = null;
  page.reconcileError = null;
  page.reconcileCalls = 0;
  page.listCalls = 0;
  page.destinationCalls = 0;
  page.deleteCalls = 0;
  page.revisionListeners = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CaptureStashScreen Local First", () => {
  it("A. 远程对账延迟时不阻塞 10 个本地素材展示，Loading 先结束", async () => {
    page.assets = assets(10);
    page.reconcileDeferred = makeDeferred();
    const { host, root } = await renderPage();

    expect(page.listCalls).toBe(1);
    expect(page.reconcileCalls).toBe(1);
    for (let index = 1; index <= 10; index += 1) {
      expect(host.textContent).toContain(`素材-${String(index).padStart(2, "0")}.jpg`);
    }
    expect(host.textContent).not.toContain("loading-indicator");

    await act(async () => {
      page.reconcileDeferred!.resolve({ checked: 10, stale: 0, updated: 0 });
    });
    await flush();

    // 对账最终返回后，页面会重新读取目的地状态；但没有重复对账请求。
    expect(page.destinationCalls).toBeGreaterThanOrEqual(2);
    expect(page.reconcileCalls).toBe(1);
    for (let index = 1; index <= 10; index += 1) {
      expect(host.textContent).toContain(`素材-${String(index).padStart(2, "0")}.jpg`);
    }

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("B. 电脑离线/远程失败时本地素材仍显示，不误删本地记录", async () => {
    page.assets = assets(3, "离线素材");
    page.reconcileError = new Error("offline: desktop unreachable");
    const { host, root } = await renderPage();

    expect(host.textContent).toContain("离线素材-01.jpg");
    expect(host.textContent).toContain("离线素材-03.jpg");
    expect(host.textContent).not.toContain("本机素材读取失败");
    expect(page.deleteCalls).toBe(0);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("C. 连续 revision 不产生对账风暴，旧结果不覆盖最新本地结果", async () => {
    page.assetResults = [
      assets(1, "run1"),
      assets(1, "run2"),
      assets(1, "run3"),
      assets(1, "run4"),
    ];
    page.reconcileDeferred = makeDeferred();
    const { host, root } = await renderPage();

    await act(async () => {
      for (let index = 0; index < 3; index += 1) {
        page.revisionListeners.slice().forEach((listener) => listener());
      }
    });
    await flush();

    expect(host.textContent).toContain("run4-01.jpg");
    expect(host.textContent).not.toContain("run1-01.jpg");
    // 初始对账 + 最多一次 pending 补跑，不会按每个 revision 各发一次。
    expect(page.reconcileCalls).toBeLessThanOrEqual(2);

    await act(async () => {
      page.reconcileDeferred!.resolve({ checked: 1, stale: 0, updated: 0 });
    });
    await flush();

    expect(host.textContent).toContain("run4-01.jpg");
    expect(page.reconcileCalls).toBeLessThanOrEqual(2);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("D. 页面卸载后远程对账返回不产生无效状态更新，重新进入仍可用", async () => {
    page.assets = assets(2);
    page.reconcileDeferred = makeDeferred();
    const first = await renderPage();

    expect(first.host.textContent).toContain("素材-01.jpg");
    await act(async () => {
      first.root.unmount();
    });
    first.host.remove();

    await act(async () => {
      page.reconcileDeferred!.resolve({ checked: 2, stale: 0, updated: 0 });
    });
    await flush();

    const second = await renderPage();
    expect(second.host.textContent).toContain("素材-01.jpg");
    expect(second.host.textContent).not.toContain("本机素材读取失败");
    await act(async () => {
      second.root.unmount();
    });
    second.host.remove();
  });

  it("E. 本地数据库读取失败时进入明确错误态，不伪装成空列表", async () => {
    page.localError = new Error("local sqlite unavailable");
    const { host, root } = await renderPage();

    expect(host.textContent).toContain("本机素材读取失败");
    expect(host.textContent).toContain("local sqlite unavailable");
    expect(host.textContent).not.toContain("还没有本机采集素材");
    expect(page.reconcileCalls).toBe(0);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
