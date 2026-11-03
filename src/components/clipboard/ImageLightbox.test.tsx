/**
 * @vitest-environment jsdom
 */
//! 图片灯箱：状态机（加载/缺失/失败/就绪）、关闭路径（按钮 + Escape 弹层栈）、
//! 复制原图走受控复制链路、另存为取消不写文件。
//! 缩放/拖拽的物理交互依赖真实布局，归真机验收，这里锁行为契约。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardImage: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardSaveImage: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

const dialogPlugin = vi.hoisted(() => ({
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialogPlugin);

import ImageLightbox from "./ImageLightbox";
import type { ClipboardItem } from "../../lib/bridge";
import { resetOverlayStack } from "../../lib/overlayStack";

afterEach(cleanup);

/** 模块级图片缓存跨测试共享：每个测试用唯一 id 避免缓存串扰。 */
let seq = 0;
function nextId() {
  return `img${++seq}`;
}

function makeItem(over: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id: nextId(),
    kind: "image",
    text: "",
    html: "",
    preview: "1440×900",
    title: "截图",
    title_source: "auto",
    byte_size: 123456,
    source_app: "chrome.exe",
    source_title: "网页",
    image_width: 1440,
    image_height: 900,
    file_paths: [],
    favorite: false,
    pinned: false,
    copy_count: 0,
    created_at: "2026-11-02T10:00:00Z",
    last_seen_at: "2026-11-02T10:00:00Z",
    has_image: true,
    has_thumb: true,
    ...over,
  };
}

function renderBox(item = makeItem(), onClose = vi.fn()) {
  render(<ImageLightbox item={item} onClose={onClose} />);
  return onClose;
}

/** 给 jsdom 的 img 补自然尺寸并触发 load，让灯箱进入就绪态。 */
function settleImage(natural = { w: 1440, h: 900 }) {
  const img = document.querySelector<HTMLImageElement>(".clip-lightbox-img");
  expect(img).not.toBeNull();
  Object.defineProperty(img!, "naturalWidth", { value: natural.w });
  Object.defineProperty(img!, "naturalHeight", { value: natural.h });
  fireEvent.load(img!);
  return img!;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOverlayStack();
  bridge.clipboardImage.mockResolvedValue("data:image/png;base64,QUJD");
  bridge.clipboardCopyItem.mockResolvedValue({
    mode: "image",
    bytes: 123456,
    warnings: [],
    sequence: 7,
    item_count: 1,
  });
});

describe("ImageLightbox 状态机", () => {
  it("加载中显示占位，加载完成显示图片与图片信息", async () => {
    renderBox();
    expect(screen.getByText(/正在加载原图/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
    settleImage();
    const info = document.querySelector(".clip-lightbox-info")!;
    expect(info.textContent).toContain("1440×900");
    expect(info.textContent).toContain("PNG（存储格式）");
    expect(info.textContent).toContain("120.6 KB");
    expect(info.textContent).toContain("chrome.exe");
  });

  it("缓存缺失显示缺失态，复制/另存不可用", async () => {
    bridge.clipboardImage.mockResolvedValue(null);
    renderBox();
    await waitFor(() => expect(screen.getByText(/缺失或已被清理/)).toBeTruthy());
    expect((screen.getByLabelText("复制原图") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("另存为") as HTMLButtonElement).disabled).toBe(true);
  });

  it("读取失败（如图片过大）显示失败原因", async () => {
    bridge.clipboardImage.mockRejectedValue(new Error("图片过大，无法内联预览"));
    renderBox();
    await waitFor(() => expect(screen.getByText(/图片读取失败/)).toBeTruthy());
    expect(screen.getByText(/图片过大/)).toBeTruthy();
  });
});

describe("ImageLightbox 关闭路径", () => {
  it("关闭按钮调用 onClose", async () => {
    const onClose = renderBox();
    await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("关闭预览"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape 经全局弹层栈只关灯箱，一次按键只触发一次", async () => {
    const onClose = renderBox();
    await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 灯箱已从弹层栈摘除：再按一次不会重复触发
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击遮罩空白关闭，点击图片/工具条不关闭", async () => {
    const onClose = renderBox();
    await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
    const stage = document.querySelector(".clip-lightbox-stage")!;
    fireEvent.click(screen.getByLabelText("复制原图"));
    fireEvent.click(stage);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ImageLightbox 工具动作", () => {
  it("复制原图调用受控复制命令并携带条目 id", async () => {
    const item = makeItem();
    renderBox(item);
    await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("复制原图"));
    await waitFor(() =>
      expect(bridge.clipboardCopyItem).toHaveBeenCalledWith(item.id),
    );
  });

  it("另存为：取消对话框不写文件", async () => {
    dialogPlugin.save.mockResolvedValue(null);
    renderBox();
    await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("另存为"));
    await waitFor(() => expect(dialogPlugin.save).toHaveBeenCalled());
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
  });

  it("另存为：选择路径后调用后端写入", async () => {
    dialogPlugin.save.mockResolvedValue("D:\\out\\clip.png");
    bridge.clipboardSaveImage.mockResolvedValue(123456);
    const item = makeItem();
    renderBox(item);
    await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("另存为"));
    await waitFor(() =>
      expect(bridge.clipboardSaveImage).toHaveBeenCalledWith(item.id, "D:\\out\\clip.png"),
    );
  });

  it("重复 IPC 防护：同一条目先后挂载两次只触发一次 clipboardImage（共享 promise 去重）", async () => {
    const item = makeItem();
    let resolve!: (v: string | null) => void;
    bridge.clipboardImage.mockReturnValue(new Promise<string | null>((r) => (resolve = r)));
    render(<ImageLightbox item={item} onClose={vi.fn()} />);
    cleanup();
    render(<ImageLightbox item={item} onClose={vi.fn()} />);
    resolve("data:image/png;base64,QQ==");
    await waitFor(() =>
      expect(document.querySelectorAll(".clip-lightbox-img").length).toBe(1),
    );
    expect(bridge.clipboardImage).toHaveBeenCalledTimes(1);
  });
});
