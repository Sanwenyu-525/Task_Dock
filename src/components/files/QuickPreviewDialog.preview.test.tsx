/**
 * @vitest-environment jsdom
 *
 * R12 / FW-PREVIEW-001：第一阶段文件内容预览。
 *
 * 覆盖：图片（原始字节 / Shell 回退 / 失败 / 资源释放）、文本（编码/截断/复制/二进制错误）、
 * PDF（真实 pdf.js 调用链：getDocument → getPage → render → 翻页取消 → 销毁 / 加载失败）、
 * 视频与音频（token 获取与释放、自定义控制条）、格式不支持、左右切换与请求竞态、
 * 关闭取消、连续开关、选择恢复、输入控件不抢键、50 次媒体切换无泄漏。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../../lib/bridge";

const pdfMock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {} as { workerSrc?: string },
}));

vi.mock("pdfjs-dist", () => pdfMock);

const clipboardMock = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }));
vi.mock("../../lib/clipboard", () => clipboardMock);

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string) => key,
  }),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    fsOpen: vi.fn(),
    fsReadBinary: vi.fn(),
    fsPreviewImage: vi.fn(),
    fsPreviewMediaUrl: vi.fn(),
    fsReadText: vi.fn(),
    fsReleasePreviewUrl: vi.fn(),
  };
});

import {
  fsPreviewImage,
  fsPreviewMediaUrl,
  fsReadBinary,
  fsReadText,
  fsReleasePreviewUrl,
} from "../../lib/bridge";
import QuickPreviewDialog, { type PreviewRequest } from "./QuickPreviewDialog";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";

const binaryMock = vi.mocked(fsReadBinary);
const imageMock = vi.mocked(fsPreviewImage);
const mediaMock = vi.mocked(fsPreviewMediaUrl);
const textMock = vi.mocked(fsReadText);
const releaseMock = vi.mocked(fsReleasePreviewUrl);

const blobUrl = "blob:taskdock-preview-object-url";
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

function entry(name: string, category: string, ext: string, size = 1024): FsEntry {
  return { name, kind: "file", ext, size, modifiedMs: 1700000000000, hidden: false, category };
}
const image = (name: string, size = 1024) => entry(name, "image", name.split(".").pop() ?? "", size);
const code = (name: string) => entry(name, "code", "ts");
const video = (name: string) => entry(name, "video", "mp4");
const audio = (name: string) => entry(name, "audio", "mp3");
const pdf = (name: string, size = 2048) => entry(name, "doc", "pdf", size);
const docx = (name: string) => entry(name, "doc", "docx");

function requestFor(path: string, entries: FsEntry[]): PreviewRequest {
  return { paneId: "p1", dir: "D:\\a", path, entries };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const stagePath = () =>
  document.querySelector(".fw-preview-stage")?.getAttribute("data-preview-path") ?? null;

beforeEach(() => {
  // jsdom 没有布局：给 PDF 容器一个可用尺寸，渲染链路才会真正走到 page.render。
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  binaryMock.mockReset();
  imageMock.mockReset();
  mediaMock.mockReset();
  textMock.mockReset();
  releaseMock.mockReset();
  pdfMock.getDocument.mockReset();
  clipboardMock.copyText.mockClear();
  createObjectURL = vi.fn(() => blobUrl);
  revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as unknown as { clientHeight?: number }).clientHeight;
  vi.restoreAllMocks();
});

describe("图片预览", () => {
  it("原始字节 → Blob URL，优先于 Shell 解码", async () => {
    binaryMock.mockResolvedValue({
      path: "D:\\a\\p.png",
      size: 4,
      truncated: false,
      mime: "image/png",
      base64: btoa("fake"),
    });
    imageMock.mockResolvedValue("data:image/png;base64,FALLBACK");

    render(<QuickPreviewDialog request={requestFor("p.png", [image("p.png")])} onClose={() => undefined} />);

    const img = (await screen.findByRole("img")) as HTMLImageElement;
    expect(img.src).toBe(blobUrl);
    expect(imageMock).not.toHaveBeenCalled();

    cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl);
  });

  it("Blob 解码失败回退 Shell 解码（TIFF/异常编码）", async () => {
    binaryMock.mockResolvedValue({
      path: "D:\\a\\p.tif",
      size: 4,
      truncated: false,
      mime: "image/tiff",
      base64: btoa("fake"),
    });
    imageMock.mockResolvedValue("data:image/png;base64,SHELL");

    render(<QuickPreviewDialog request={requestFor("p.tif", [image("p.tif")])} onClose={() => undefined} />);
    const img = (await screen.findByRole("img")) as HTMLImageElement;
    fireEvent.error(img);

    await waitFor(() => expect(img.src).toContain("data:image/png;base64,SHELL"));
  });

  it("超过原始字节上限的大图直接走 Shell 解码，不整文件读入", async () => {
    imageMock.mockResolvedValue("data:image/png;base64,BIG");

    render(
      <QuickPreviewDialog
        request={requestFor("big.png", [image("big.png", 40 * 1024 * 1024)])}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(imageMock).toHaveBeenCalledTimes(1));
    expect(binaryMock).not.toHaveBeenCalled();
  });

  it("两条解码路径都失败时显示错误与重试，不显示空白页面", async () => {
    binaryMock.mockRejectedValue(new Error("read failed"));
    imageMock.mockResolvedValue(null);

    render(<QuickPreviewDialog request={requestFor("bad.png", [image("bad.png")])} onClose={() => undefined} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("fw.preview.error");
    expect(screen.getByText("common.retry")).toBeTruthy();
  });
});

describe("文本 / 代码预览", () => {
  it("显示内容、语言与编码信息；按 512 KiB 口径读取", async () => {
    textMock.mockResolvedValue({
      path: "D:\\a\\b.ts",
      size: 20,
      truncated: false,
      encoding: "UTF-8",
      content: "const hello = 1;\nconsole.log(hello);",
    });

    render(<QuickPreviewDialog request={requestFor("b.ts", [code("b.ts")])} onClose={() => undefined} />);

    await screen.findByText(/const/);
    expect(textMock).toHaveBeenCalledWith("D:\\a\\b.ts", 512 * 1024);
    expect(screen.getByText("TypeScript")).toBeTruthy();
    // 行号与高亮：两行代码 → 行号 1/2；关键字生成 span（非 innerHTML）。
    const numbers = Array.from(document.querySelectorAll(".fw-preview-line-number")).map((el) => el.textContent);
    expect(numbers).toEqual(["1", "2"]);
    expect(document.querySelectorAll(".fw-preview-token-keyword").length).toBeGreaterThan(0);
  });

  it("截断文件显示截断提示，内容仍可见", async () => {
    textMock.mockResolvedValue({
      path: "D:\\a\\long.log",
      size: 8 * 1024 * 1024,
      truncated: true,
      encoding: "UTF-8",
      content: "first line\nsecond line",
    });

    render(<QuickPreviewDialog request={requestFor("long.log", [entry("long.log", "text", "log")])} onClose={() => undefined} />);

    await screen.findByText(/first line/);
    expect(screen.getByText("fw.preview.truncated")).toBeTruthy();
    expect(screen.getByText("fw.preview.truncatedShort")).toBeTruthy();
  });

  it("非 UTF-8（lossy）内容提示乱码风险", async () => {
    textMock.mockResolvedValue({
      path: "D:\\a\\gbk.txt",
      size: 12,
      truncated: false,
      encoding: "UTF-8 (lossy)",
      content: "无法解码 \uFFFD\uFFFD",
    });

    render(<QuickPreviewDialog request={requestFor("gbk.txt", [entry("gbk.txt", "text", "txt")])} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText("fw.preview.encodingWarning")).toBeTruthy());
  });

  it("读取失败保留文件名与错误信息（不是空白页）", async () => {
    textMock.mockRejectedValue(new Error("二进制文件不支持文本预览"));

    render(<QuickPreviewDialog request={requestFor("b.ts", [code("b.ts")])} onClose={() => undefined} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("fw.preview.error");
    expect(alert.textContent).toContain("b.ts");
  });

  it("复制内容写入剪贴板并给出反馈", async () => {
    textMock.mockResolvedValue({
      path: "D:\\a\\b.ts",
      size: 3,
      truncated: false,
      encoding: "UTF-8",
      content: "abc",
    });

    render(<QuickPreviewDialog request={requestFor("b.ts", [code("b.ts")])} onClose={() => undefined} />);
    await screen.findByText("abc");
    fireEvent.click(screen.getByText("fw.preview.copy"));

    await waitFor(() => expect(clipboardMock.copyText).toHaveBeenCalledWith("abc"));
    expect(await screen.findByText("fw.preview.copied")).toBeTruthy();
  });
});

describe("PDF 预览", () => {
  function pdfDoc(pages = 3) {
    const renderTasks: Array<{ cancel: ReturnType<typeof vi.fn>; promise: Promise<void> }> = [];
    const getPage = vi.fn(async (pageNumber: number) => ({
      pageNumber,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => {
        const task = { cancel: vi.fn(), promise: Promise.resolve() };
        renderTasks.push(task);
        return task;
      }),
    }));
    const doc = { numPages: pages, getPage, destroy: vi.fn(async () => undefined) };
    return { doc, getPage, renderTasks };
  }

  function setupPdf(options: { pages?: number; fail?: boolean } = {}) {
    const { doc, getPage, renderTasks } = pdfDoc(options.pages ?? 3);
    const loadingTask = {
      promise: options.fail ? Promise.reject(new Error("Invalid PDF structure")) : Promise.resolve(doc),
      onProgress: null as null | ((p: { loaded: number; total: number }) => void),
      destroy: vi.fn(async () => undefined),
    };
    // 避免未处理拒绝：失败用例由组件捕获，这里补一个消费者。
    loadingTask.promise.catch(() => undefined);
    pdfMock.getDocument.mockReturnValue(loadingTask);
    binaryMock.mockResolvedValue({
      path: "D:\\a\\doc.pdf",
      size: 2048,
      truncated: false,
      mime: "application/pdf",
      base64: btoa("%PDF-1.7 fake"),
    });
    return { doc, getPage, renderTasks, loadingTask };
  }

  it("真实渲染链路：读取字节 → getDocument → getPage → render 当前页", async () => {
    const { getPage, renderTasks } = setupPdf();

    render(<QuickPreviewDialog request={requestFor("doc.pdf", [pdf("doc.pdf")])} onClose={() => undefined} />);

    await waitFor(() => expect(pdfMock.getDocument).toHaveBeenCalledTimes(1));
    const init = pdfMock.getDocument.mock.calls[0][0] as { data: Uint8Array; cMapUrl: string };
    expect(init.data).toBeInstanceOf(Uint8Array);
    expect(init.data.length).toBeGreaterThan(0);
    expect(init.cMapUrl).toBe("/pdfjs/cmaps/");

    await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
    await waitFor(() => expect(renderTasks.length).toBe(1));
    const canvas = document.querySelector(".fw-preview-pdf-canvas") as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
  });

  it("翻页渲染下一页，并取消上一页的渲染任务", async () => {
    const { getPage, renderTasks } = setupPdf();

    render(<QuickPreviewDialog request={requestFor("doc.pdf", [pdf("doc.pdf")])} onClose={() => undefined} />);
    await waitFor(() => expect(renderTasks.length).toBe(1));

    fireEvent.click(screen.getByLabelText("fw.preview.pdf.nextPage"));
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(2));
    await waitFor(() => expect(renderTasks.length).toBe(2));
    expect(renderTasks[0].cancel).toHaveBeenCalled();
  });

  it("加载失败显示错误与重试，销毁 loading task", async () => {
    const { loadingTask } = setupPdf({ fail: true });

    render(<QuickPreviewDialog request={requestFor("doc.pdf", [pdf("doc.pdf")])} onClose={() => undefined} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("fw.preview.error");
    cleanup();
    expect(loadingTask.destroy).toHaveBeenCalled();
  });

  it("超过 64 MiB 的 PDF 不读取字节，直接提示用默认程序打开", async () => {
    render(
      <QuickPreviewDialog
        request={requestFor("huge.pdf", [pdf("huge.pdf", 65 * 1024 * 1024)])}
        onClose={() => undefined}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("fw.preview.pdf.tooLarge");
    expect(binaryMock).not.toHaveBeenCalled();
  });

  it("关闭预览销毁文档与 worker（loadingTask.destroy 一次）", async () => {
    const { loadingTask } = setupPdf();
    const { unmount } = render(
      <QuickPreviewDialog request={requestFor("doc.pdf", [pdf("doc.pdf")])} onClose={() => undefined} />,
    );
    await waitFor(() => expect(loadingTask.onProgress).toBeTypeOf("function"));
    unmount();
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("视频 / 音频", () => {
  it("视频：渲染 controls 并在关闭时释放 token", async () => {
    mediaMock.mockResolvedValue("http://taskdock-preview.localhost/tok-v");
    releaseMock.mockResolvedValue(undefined);

    const { unmount } = render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );

    await waitFor(() => {
      const el = document.querySelector("video");
      expect(el?.getAttribute("src")).toBe("http://taskdock-preview.localhost/tok-v");
      expect(el?.hasAttribute("controls")).toBe(true);
    });

    unmount();
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-v"));
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("音频：自定义控制条（播放/进度/音量/时长），不使用浏览器默认播放器", async () => {
    mediaMock.mockResolvedValue("http://taskdock-preview.localhost/tok-a");
    releaseMock.mockResolvedValue(undefined);

    render(<QuickPreviewDialog request={requestFor("a.mp3", [audio("a.mp3")])} onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByLabelText("fw.preview.audio.play")).toBeTruthy());
    expect(screen.getByLabelText("fw.preview.audio.seek")).toBeTruthy();
    expect(screen.getByLabelText("fw.preview.audio.volume")).toBeTruthy();
    // 音频元素本身隐藏，但存在（提供播放能力）。
    const el = document.querySelector("audio") as HTMLAudioElement;
    expect(el).toBeTruthy();
    expect(el.hasAttribute("controls")).toBe(false);
  });

  it("媒体解码失败显示错误反馈", async () => {
    mediaMock.mockResolvedValue("http://taskdock-preview.localhost/tok-bad");
    releaseMock.mockResolvedValue(undefined);

    render(<QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />);
    const el = await waitFor(() => {
      const node = document.querySelector("video");
      expect(node).toBeTruthy();
      return node as HTMLVideoElement;
    });
    fireEvent.error(el);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("格式矩阵与导航", () => {
  it("DOCX/XLSX/PPTX 明确标记不支持，且不读取二进制内容", async () => {
    render(<QuickPreviewDialog request={requestFor("a.docx", [docx("a.docx")])} onClose={() => undefined} />);

    await screen.findByText("fw.preview.unsupported");
    expect(textMock).not.toHaveBeenCalled();
    expect(binaryMock).not.toHaveBeenCalled();
  });

  it("只跳过文件夹；左右切换按列表顺序", async () => {
    textMock.mockImplementation(async (path: string) => ({
      path,
      size: 2,
      truncated: false,
      encoding: "UTF-8",
      content: path.endsWith("b.ts") ? "bbb" : "aaa",
    }));

    const entries = [
      { ...entry("sub", "folder", ""), kind: "dir" as const, size: null },
      code("a.ts"),
      code("b.ts"),
    ];
    render(<QuickPreviewDialog request={requestFor("a.ts", entries)} onClose={() => undefined} />);

    await screen.findByText("aaa");
    expect(stagePath()).toBe("D:\\a\\a.ts");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await screen.findByText("bbb");
    expect(stagePath()).toBe("D:\\a\\b.ts");

    // 末尾再按不越界。
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(stagePath()).toBe("D:\\a\\b.ts"));

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await screen.findByText("aaa");
    expect(stagePath()).toBe("D:\\a\\a.ts");
  });

  it("左右方向键不干扰输入控件（音频进度条）", async () => {
    mediaMock.mockResolvedValue("http://taskdock-preview.localhost/tok-seek");
    releaseMock.mockResolvedValue(undefined);

    render(
      <QuickPreviewDialog request={requestFor("a.mp3", [audio("a.mp3"), audio("b.mp3")])} onClose={() => undefined} />,
    );
    const seek = await screen.findByLabelText("fw.preview.audio.seek");
    fireEvent.keyDown(seek, { key: "ArrowRight" });

    expect(stagePath()).toBe("D:\\a\\a.mp3");
    expect(mediaMock).toHaveBeenCalledTimes(1);
  });

  it("Escape 关闭预览（回到文件工作区）", async () => {
    const onClose = vi.fn();
    textMock.mockResolvedValue({
      path: "D:\\a\\b.ts",
      size: 1,
      truncated: false,
      encoding: "UTF-8",
      content: "x",
    });

    render(<QuickPreviewDialog request={requestFor("b.ts", [code("b.ts")])} onClose={onClose} />);
    await screen.findByText("x");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("关闭预览不改变文件选择", async () => {
    const selected = "D:\\a\\b.ts";
    act(() => {
      useFilesWorkspaceStore.getState().hydrate(
        {
          tree: { type: "pane", paneId: "p1" },
          panes: [{ paneId: "p1", tabs: [{ tabId: "t1", path: "D:\\a" }], activeTabId: "t1" }],
          activePaneId: "p1",
        },
        "global",
      );
      useFilesWorkspaceStore.getState().setSelection("p1", [selected], selected);
    });
    textMock.mockResolvedValue({
      path: "D:\\a\\b.ts",
      size: 1,
      truncated: false,
      encoding: "UTF-8",
      content: "x",
    });

    const { rerender } = render(
      <QuickPreviewDialog request={requestFor("b.ts", [code("b.ts")])} onClose={() => undefined} />,
    );
    await screen.findByText("x");
    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);

    expect(useFilesWorkspaceStore.getState().selection["p1"]?.paths).toEqual([selected]);
  });
});

describe("竞态与资源生命周期", () => {
  it("A 加载慢、B 加载快：A 的晚到结果不覆盖 B", async () => {
    const slow = deferred<{ path: string; size: number; truncated: boolean; encoding: string; content: string }>();
    const fast = deferred<{ path: string; size: number; truncated: boolean; encoding: string; content: string }>();
    textMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    render(<QuickPreviewDialog request={requestFor("a.ts", [code("a.ts"), code("b.ts")])} onClose={() => undefined} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });

    await act(async () =>
      fast.resolve({ path: "D:\\a\\b.ts", size: 1, truncated: false, encoding: "UTF-8", content: "BBB" }),
    );
    await screen.findByText("BBB");

    await act(async () =>
      slow.resolve({ path: "D:\\a\\a.ts", size: 1, truncated: false, encoding: "UTF-8", content: "AAA" }),
    );
    expect(screen.queryByText("AAA")).toBeNull();
    expect(screen.getByText("BBB")).toBeTruthy();
  });

  it("关闭后返回的文本结果不更新界面", async () => {
    const pending = deferred<{ path: string; size: number; truncated: boolean; encoding: string; content: string }>();
    textMock.mockReturnValue(pending.promise);

    const { rerender } = render(
      <QuickPreviewDialog request={requestFor("a.ts", [code("a.ts")])} onClose={() => undefined} />,
    );
    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);
    await act(async () =>
      pending.resolve({ path: "D:\\a\\a.ts", size: 1, truncated: false, encoding: "UTF-8", content: "LATE" }),
    );
    expect(screen.queryByText("LATE")).toBeNull();
  });

  it("连续打开关闭 10 次：每次重新加载，无残留内容", async () => {
    textMock.mockResolvedValue({
      path: "D:\\a\\b.ts",
      size: 1,
      truncated: false,
      encoding: "UTF-8",
      content: "x",
    });

    const { rerender } = render(<QuickPreviewDialog request={null} onClose={() => undefined} />);
    for (let i = 0; i < 10; i += 1) {
      rerender(<QuickPreviewDialog request={requestFor("b.ts", [code("b.ts")])} onClose={() => undefined} />);
      await waitFor(() => expect(textMock).toHaveBeenCalledTimes(i + 1));
      rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);
      expect(screen.queryByText("x")).toBeNull();
    }
  });

  it("连续切换 50 个媒体文件：token 注册数与释放数一致，无重复释放", async () => {
    releaseMock.mockResolvedValue(undefined);
    let seq = 0;
    mediaMock.mockImplementation(async () => {
      seq += 1;
      return `http://taskdock-preview.localhost/tok-${seq}`;
    });

    const entries = Array.from({ length: 50 }, (_, index) => video(`v${index}.mp4`));
    render(<QuickPreviewDialog request={requestFor("v0.mp4", entries)} onClose={() => undefined} />);
    await waitFor(() => expect(mediaMock).toHaveBeenCalled());

    for (let i = 0; i < 49; i += 1) {
      fireEvent.keyDown(window, { key: "ArrowRight" });
      await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(i + 2));
    }

    cleanup();
    await waitFor(() => expect(releaseMock).toHaveBeenCalledTimes(50));
    const released = releaseMock.mock.calls.map(([url]) => url);
    expect(new Set(released).size).toBe(50);
  });
});
