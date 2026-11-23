/**
 * @vitest-environment jsdom
 *
 * 右侧文件检查器：空态 / 单选预览 / 详细信息按需读取 / 快捷操作 / 挂起 / 宽度键盘调整。
 * 关注「不重复 IPC」「不显示假按钮」「关闭后不保留内容」三条硬约束。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  entry,
};

const singleSummary: PreviewSelectionSummary = { count: 1, files: 1, dirs: 0, bytes: 10, folder: null };
const multiSummary: PreviewSelectionSummary = { count: 3, files: 2, dirs: 1, bytes: 30, folder: null };

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
  vi.mocked(copyText).mockClear();
});

afterEach(() => cleanup());

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
});
