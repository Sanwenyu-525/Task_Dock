/**
 * @vitest-environment jsdom
 */
//! 剪贴板图片加载策略守卫（2026-11-16）：
//! - 未进入视口不发起预览/缩略图 IPC；
//! - 同一图片的多张卡片共享一次在途请求；
//! - 640px 预览成功后不再补发 192px 缩略图；
//! - 删除/清空历史后缓存失效，重新挂载必须重新请求。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ClipboardHeroImage, clearClipboardMediaCache, forgetClipboardMedia } from "./Media";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(async (id: string) => `data:image/png;base64,${id}`),
  thumb: vi.fn(async (id: string) => `data:image/png;base64,thumb-${id}`),
  image: vi.fn(async () => null),
}));

vi.mock("../../lib/bridge", () => ({
  clipboardPreview: mocks.preview,
  clipboardThumb: mocks.thumb,
  clipboardImage: mocks.image,
}));

beforeEach(() => {
  cleanup();
  clearClipboardMediaCache();
  vi.clearAllMocks();
});

describe("ClipboardHeroImage 懒加载与缓存", () => {
  it("enabled=false 时不发起任何图片 IPC", async () => {
    render(<ClipboardHeroImage itemId="m-off" hasThumb enabled={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.thumb).not.toHaveBeenCalled();
  });

  it("进入视口后只请求 640px 预览；预览成功不再补发缩略图", async () => {
    const { container } = render(<ClipboardHeroImage itemId="m-on" hasThumb enabled />);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("data-preview-state")).toBe("ready"),
    );
    expect(mocks.preview).toHaveBeenCalledWith("m-on");
    expect(mocks.thumb).not.toHaveBeenCalled();
  });

  it("同一图片的两张卡片合并为一次在途请求", async () => {
    const { container } = render(
      <>
        <ClipboardHeroImage itemId="m-dup" hasThumb enabled />
        <ClipboardHeroImage itemId="m-dup" hasThumb enabled />
      </>,
    );
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
    expect(mocks.thumb).not.toHaveBeenCalled();
  });

  it("缓存命中时重新挂载不重复请求；forgetClipboardMedia 后必须重新请求", async () => {
    const first = render(<ClipboardHeroImage itemId="m-cache" hasThumb enabled />);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = render(<ClipboardHeroImage itemId="m-cache" hasThumb enabled />);
    await waitFor(() => expect(second.container.querySelector("img")).not.toBeNull());
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    second.unmount();

    forgetClipboardMedia("m-cache");
    const third = render(<ClipboardHeroImage itemId="m-cache" hasThumb enabled />);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(2));
    third.unmount();
  });

  it("clearClipboardMediaCache 使旧缓存失效", async () => {
    const first = render(<ClipboardHeroImage itemId="m-clear" hasThumb enabled />);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    first.unmount();

    clearClipboardMediaCache();
    render(<ClipboardHeroImage itemId="m-clear" hasThumb enabled />);
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(2));
  });
});
