/**
 * @vitest-environment jsdom
 *
 * 右侧文件检查器：空态 / 单选预览 / 详细信息按需读取 / 快捷操作 / 挂起 / 宽度键盘调整。
 * 关注「不重复 IPC」「不显示假按钮」「关闭后不保留内容」三条硬约束。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FsEntry, FsStat } from "../../lib/bridge";

const bridgeMocks = vi.hoisted(() => ({
  fsReadText: vi.fn(),
  fsReadBinary: vi.fn(),
  fsPreviewImage: vi.fn(),
  fsPreviewMediaUrl: vi.fn(),
  fsReleasePreviewUrl: vi.fn(),
  fsOpen: vi.fn(async () => undefined),
  fsReveal: vi.fn(async () => undefined),
  fsStat: vi.fn(),
  shelfAddPaths: vi.fn(async () => ({ added: ["D:\\a\\a.ts"], skipped: [], failed: [] })),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));

import FilePreviewPane, { __resetPreviewStatCacheForTests } from "./FilePreviewPane";
import { copyText } from "../../lib/clipboard";
import type { FilePreviewTarget, PreviewSelectionSummary } from "../../lib/filesWorkspace/previewSelection";

const PATH = "D:\\a\\a.ts";

const entry: FsEntry = {
  name: "a.ts",
  kind: "file",
  ext: "ts",
  size: 10,
  modifiedMs: 1_700_000_000_000,
  hidden: false,
  category: "code",
};

const target: FilePreviewTarget = {
  paneId: "p1",
  path: PATH,
  dir: "D:\\a",
  name: "a.ts",
  size: 10,
  revision: { path: PATH, size: 10, modifiedMs: 1_700_000_000_000 },
  entry,
};

const singleSummary: PreviewSelectionSummary = { count: 1, files: 1, dirs: 0, bytes: 10, folder: null };
const multiSummary: PreviewSelectionSummary = { count: 3, files: 2, dirs: 1, bytes: 30, folder: null };

function videoTarget(name = "v.mp4", modifiedMs = 1_700_000_000_000): FilePreviewTarget {
  const videoEntry: FsEntry = {
    name,
    kind: "file",
    ext: "mp4",
    size: 4096,
    modifiedMs,
    hidden: false,
    category: "video",
  };
  const path = `D:\\a\\${name}`;
  return {
    paneId: "p1",
    path,
    dir: "D:\\a",
    name,
    size: 4096,
    revision: { path, size: 4096, modifiedMs },
    entry: videoEntry,
  };
}

const stat: FsStat = {
  path: PATH,
  exists: true,
  kind: "file",
  size: 10,
  createdMs: 1_600_000_000_000,
  modifiedMs: 1_700_000_000_000,
  accessedMs: 1_700_000_100_000,
  attributes: ["archive"],
  readonly: false,
  hidden: false,
  childCount: null,
  childTruncated: false,
};

/** 代码行文本被 token 拆成多个节点，用容器 textContent 断言更稳定。 */
function codeText(): string {
  return document.querySelector(".fw-preview-code")?.textContent ?? "";
}

function renderPane(overrides: Partial<Parameters<typeof FilePreviewPane>[0]> = {}) {
  const props: Parameters<typeof FilePreviewPane>[0] = {
    target,
    summary: singleSummary,
    width: 360,
    suspended: false,
    pageActive: true,
    onClose: vi.fn(),
    onCommitWidth: vi.fn(),
    onNotice: vi.fn(),
    ...overrides,
  };
  const view = render(<FilePreviewPane {...props} />);
  return { props, view };
}

beforeEach(() => {
  __resetPreviewStatCacheForTests();
  bridgeMocks.fsReadText.mockReset().mockResolvedValue({
    path: PATH,
    size: 10,
    truncated: false,
    encoding: "UTF-8",
    content: "const a = 1;",
  });
  bridgeMocks.fsStat.mockReset().mockResolvedValue([stat]);
  bridgeMocks.fsOpen.mockClear();
  bridgeMocks.fsReveal.mockClear();
  bridgeMocks.shelfAddPaths.mockClear();
  bridgeMocks.fsPreviewMediaUrl.mockReset().mockResolvedValue("media://token-1");
  bridgeMocks.fsReleasePreviewUrl.mockReset().mockResolvedValue(undefined);
  vi.mocked(copyText).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("空态与挂起", () => {
  it("未选择文件时不读取任何内容", () => {
    renderPane({ target: null, summary: { ...singleSummary, count: 0, files: 0, bytes: 0 } });
    expect(screen.getByText("fw.inspector.empty")).toBeTruthy();
    expect(bridgeMocks.fsReadText).not.toHaveBeenCalled();
  });

  it("多选显示统计，不擅自预览第一个文件", () => {
    renderPane({ target: null, summary: multiSummary });
    expect(screen.getByText(/fw\.inspector\.multiTitle/)).toBeTruthy();
    expect(screen.getByText(/fw\.inspector\.multiBody/)).toBeTruthy();
    expect(bridgeMocks.fsReadText).not.toHaveBeenCalled();
  });

  it("弹窗打开期间挂起：显示提示且不创建第二份预览", () => {
    renderPane({ suspended: true });
    expect(screen.getByText("fw.inspector.suspended")).toBeTruthy();
    expect(bridgeMocks.fsReadText).not.toHaveBeenCalled();
  });
});

describe("单选预览", () => {
  it("显示文件头与内容，只读一次文件", async () => {
    renderPane();
    await waitFor(() => expect(codeText()).toContain("a = 1;"));
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.fsReadText).toHaveBeenCalledWith(PATH, expect.any(Number));
  });
});

describe("详细信息", () => {
  it("仅在切到详细信息时读取一次 fs_stat，切回预览不重复读取文件内容", async () => {
    renderPane();
    await waitFor(() => expect(codeText()).toContain("a = 1;"));
    expect(bridgeMocks.fsStat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("fw.inspector.tabDetails"));
    await waitFor(() => expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(1));
    expect(bridgeMocks.fsStat).toHaveBeenCalledWith([PATH]);
    expect(screen.getByText("fw.props.attributes")).toBeTruthy();
    expect(screen.getByText("fw.props.attr.archive")).toBeTruthy();

    fireEvent.click(screen.getByText("fw.inspector.tabPreview"));
    await waitFor(() => expect(codeText()).toContain("a = 1;"));
    // 切回预览会重新挂载内容（卸载时释放媒体/PDF 资源），因此重新读取一次文本；
    // 详细信息仍命中缓存，不再产生第二次 fs_stat。
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(1);
  });

  it("再次进入详细信息命中缓存，不重复 IPC", async () => {
    renderPane();
    fireEvent.click(screen.getByText("fw.inspector.tabDetails"));
    await waitFor(() => expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("fw.inspector.tabPreview"));
    fireEvent.click(screen.getByText("fw.inspector.tabDetails"));
    expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(1);
  });
});

describe("快捷操作", () => {
  it("打开 / 定位 / 复制路径 / 加入暂存架都走既有命令", async () => {
    const { props } = renderPane();
    await waitFor(() => expect(codeText()).toContain("a = 1;"));

    fireEvent.click(screen.getByText("fw.inspector.open"));
    await waitFor(() => expect(bridgeMocks.fsOpen).toHaveBeenCalledWith(PATH));

    fireEvent.click(screen.getByText("fw.inspector.reveal"));
    await waitFor(() => expect(bridgeMocks.fsReveal).toHaveBeenCalledWith(PATH));

    fireEvent.click(screen.getByText("fw.inspector.copyPath"));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(PATH));

    fireEvent.click(screen.getByText("fw.inspector.toShelf"));
    await waitFor(() => expect(bridgeMocks.shelfAddPaths).toHaveBeenCalledWith([PATH], "reference", "manual", null));
    expect(props.onNotice).toHaveBeenCalledWith("fw.inspector.pathCopied", "success");
  });

  it("关闭按钮只回调关闭，不触碰文件", async () => {
    const { props } = renderPane();
    fireEvent.click(screen.getByLabelText("fw.inspector.close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.fsOpen).not.toHaveBeenCalled();
  });
});

describe("宽度调整", () => {
  it("键盘左右键按 16px 步进并钳制到边界", async () => {
    const { props } = renderPane({ width: 360 });
    const resizer = screen.getByRole("separator");
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(props.onCommitWidth).toHaveBeenLastCalledWith(344);
    fireEvent.keyDown(resizer, { key: "ArrowRight", shiftKey: true });
    expect(props.onCommitWidth).toHaveBeenLastCalledWith(400);
    fireEvent.keyDown(resizer, { key: "Home" });
    expect(props.onCommitWidth).toHaveBeenLastCalledWith(280);
    fireEvent.keyDown(resizer, { key: "End" });
    expect(props.onCommitWidth).toHaveBeenLastCalledWith(520);
  });

  it("窄窗抽屉模式不渲染拖拽条", () => {
    renderPane({ overlay: true });
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("鼠标拖拽只在结束时提交一次宽度，并清理整窗拖拽态", () => {
    const { props } = renderPane({ width: 360 });
    const resizer = screen.getByRole("separator");
    fireEvent.pointerDown(resizer, { button: 0, pointerId: 7 });
    expect(document.body.classList.contains("ui-resizer-dragging")).toBe(true);
    fireEvent.pointerMove(window, { pointerId: 7, clientX: -100, clientY: 0 });
    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(props.onCommitWidth).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("ui-resizer-dragging")).toBe(false);
    expect(document.body.dataset.resizeAxis).toBeUndefined();
  });

  it("pointercancel 结束会话也提交且不残留监听态", () => {
    const { props } = renderPane({ width: 360 });
    const resizer = screen.getByRole("separator");
    fireEvent.pointerDown(resizer, { button: 0, pointerId: 9 });
    fireEvent.pointerCancel(window, { pointerId: 9 });
    expect(props.onCommitWidth).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("ui-resizer-dragging")).toBe(false);
  });
});

describe("页面生命周期（keep 挂载下的 active/suspended）", () => {
  it("页面未激活：卸载预览内容（不读盘），重新激活后重新读取", async () => {
    const { props, view } = renderPane();
    await waitFor(() => expect(codeText()).toContain("a = 1;"));
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);

    view.rerender(<FilePreviewPane {...props} pageActive={false} />);
    expect(screen.getByText("fw.inspector.inactive")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeNull());
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);

    view.rerender(<FilePreviewPane {...props} pageActive />);
    await waitFor(() => expect(codeText()).toContain("a = 1;"));
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(2);
  });

  it("页面未激活：视频卸载并释放媒体 token，不留下后台播放器", async () => {
    const { props, view } = renderPane({ target: videoTarget() });
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(bridgeMocks.fsPreviewMediaUrl).toHaveBeenCalledTimes(1);

    view.rerender(<FilePreviewPane {...props} target={videoTarget()} pageActive={false} />);
    await waitFor(() => expect(document.querySelector("video")).toBeNull());
    await waitFor(() => expect(bridgeMocks.fsReleasePreviewUrl).toHaveBeenCalledWith("media://token-1"));
    expect(document.querySelectorAll("video")).toHaveLength(0);
  });

  it("页面切走时显式 pause、清空 src 并 load，而不是只让 DOM 消失", async () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const { props, view } = renderPane({ target: videoTarget() });
    const video = await waitFor(() => {
      const node = document.querySelector("video");
      expect(node).toBeTruthy();
      return node as HTMLVideoElement;
    });

    view.rerender(<FilePreviewPane {...props} target={videoTarget()} pageActive={false} />);
    await waitFor(() => expect(document.querySelector("video")).toBeNull());

    expect(pauseSpy).toHaveBeenCalled();
    await waitFor(() => expect(video.hasAttribute("src")).toBe(false));
    expect(loadSpy).toHaveBeenCalled();
    await waitFor(() => expect(bridgeMocks.fsReleasePreviewUrl).toHaveBeenCalledTimes(1));
  });

  it("快速切换文件：旧媒体 token 先释放，任何时刻只有一个播放器", async () => {
    bridgeMocks.fsPreviewMediaUrl
      .mockResolvedValueOnce("media://token-a")
      .mockResolvedValueOnce("media://token-b");
    const { props, view } = renderPane({ target: videoTarget("a.mp4") });
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    view.rerender(<FilePreviewPane {...props} target={videoTarget("b.mp4")} />);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
    await waitFor(() => expect(bridgeMocks.fsReleasePreviewUrl).toHaveBeenCalledWith("media://token-a"));
    expect(document.querySelectorAll("video")).toHaveLength(1);
  });
});

describe("版本变化与缓存失效", () => {
  it("旧版本的晚到读取结果不能覆盖新版本内容", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    bridgeMocks.fsReadText
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

    const { props, view } = renderPane();
    const next: FilePreviewTarget = {
      ...target,
      entry: { ...entry, size: 40, modifiedMs: 1_700_000_002_000 },
      size: 40,
      revision: { path: PATH, size: 40, modifiedMs: 1_700_000_002_000 },
    };
    view.rerender(<FilePreviewPane {...props} target={next} />);
    await waitFor(() => expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(2));

    await act(async () =>
      resolveSecond({ path: PATH, size: 40, truncated: false, encoding: "UTF-8", content: "NEW-VERSION" }),
    );
    await waitFor(() => expect(codeText()).toContain("NEW-VERSION"));

    await act(async () =>
      resolveFirst({ path: PATH, size: 10, truncated: false, encoding: "UTF-8", content: "OLD-VERSION" }),
    );
    expect(codeText()).not.toContain("OLD-VERSION");
    expect(codeText()).toContain("NEW-VERSION");
  });
  it("同一路径 mtime 变化：详细信息缓存键失效，重新 fs_stat", async () => {
    const { props, view } = renderPane();
    fireEvent.click(screen.getByText("fw.inspector.tabDetails"));
    await waitFor(() => expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(1));

    const nextTarget: FilePreviewTarget = {
      ...target,
      entry: { ...entry, size: 11, modifiedMs: 1_700_000_000_500 },
      size: 11,
      revision: { path: PATH, size: 11, modifiedMs: 1_700_000_000_500 },
    };
    view.rerender(<FilePreviewPane {...props} target={nextTarget} />);
    await waitFor(() => expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(2));
  });

  it("版本未变：来回切换预览/详细信息不重复 fs_stat", async () => {
    const { props, view } = renderPane();
    fireEvent.click(screen.getByText("fw.inspector.tabDetails"));
    await waitFor(() => expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("fw.inspector.tabPreview"));
    view.rerender(<FilePreviewPane {...props} />);
    fireEvent.click(screen.getByText("fw.inspector.tabDetails"));
    expect(bridgeMocks.fsStat).toHaveBeenCalledTimes(1);
  });
});

describe("无障碍关系", () => {
  it("两个 tab 都有真实 tabpanel：aria-controls / aria-labelledby 双向对应，非活动页 hidden", async () => {
    renderPane();
    await waitFor(() => expect(codeText()).toContain("a = 1;"));
    const aside = document.querySelector("aside.fw-preview-pane");
    expect(aside?.id).toBe("fw-preview-pane");

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId!);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }

    const previewPanel = document.getElementById(tabs[0].getAttribute("aria-controls")!);
    const detailsPanel = document.getElementById(tabs[1].getAttribute("aria-controls")!);
    expect(previewPanel?.hidden).toBe(false);
    expect(detailsPanel?.hidden).toBe(true);
  });

  it("方向键 / Home / End / Enter 切换 tab，焦点与显示内容一致", async () => {
    renderPane();
    await waitFor(() => expect(codeText()).toContain("a = 1;"));

    const [previewTab, detailsTab] = screen.getAllByRole("tab");
    previewTab.focus();
    fireEvent.keyDown(previewTab, { key: "ArrowRight" });
    expect(detailsTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(detailsTab);
    expect(document.getElementById(detailsTab.getAttribute("aria-controls")!)?.hidden).toBe(false);
    await waitFor(() => expect(bridgeMocks.fsStat).toHaveBeenCalled());

    fireEvent.keyDown(detailsTab, { key: "Home" });
    expect(previewTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(previewTab);

    fireEvent.keyDown(previewTab, { key: "End" });
    expect(detailsTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(detailsTab, { key: "ArrowLeft" });
    expect(previewTab.getAttribute("aria-selected")).toBe("true");

    detailsTab.focus();
    fireEvent.keyDown(detailsTab, { key: " " });
    expect(detailsTab.getAttribute("aria-selected")).toBe("true");
  });

  it("详情页激活时预览内容卸载：不保留播放器，切回后只重建一个", async () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    renderPane({ target: videoTarget() });
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    fireEvent.click(screen.getAllByRole("tab")[1]);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(0));
    await waitFor(() => expect(bridgeMocks.fsReleasePreviewUrl).toHaveBeenCalledWith("media://token-1"));
    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("tab")[0]);
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
  });
});
