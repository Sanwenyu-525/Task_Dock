/**
 * @vitest-environment jsdom
 */
//! 收集箱图片附件：缩略图数量、超过 4 张折叠、点击查看大图与左右切换。
//! 图片字节都在后端，这里只验证「按 ID 读取 + 展示」的编排。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CaptureAttachment } from "../../lib/bridge";

const bridge = vi.hoisted(() => ({
  quickCaptureAttachmentThumb: vi.fn(),
  quickCaptureAttachmentPreview: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bridge")>()),
  ...bridge,
}));

import CaptureAttachmentStrip from "./CaptureAttachmentStrip";

function attachment(id: string): CaptureAttachment {
  return { id, mime: "image/png", byte_size: 2048, width: 640, height: 360, position: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.quickCaptureAttachmentThumb.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
  bridge.quickCaptureAttachmentPreview.mockImplementation(
    async (id: string) => `data:image/png;base64,full-${id}`,
  );
});

afterEach(cleanup);

describe("收集箱图片附件", () => {
  it("空数组不渲染任何东西（旧记录保持原样）", () => {
    const { container } = render(<CaptureAttachmentStrip attachments={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("最多展示 4 张缩略图，其余折叠成 +N", async () => {
    const list = ["a", "b", "c", "d", "e", "f"].map((id) => attachment(`strip1-${id}`));
    render(<CaptureAttachmentStrip attachments={list} />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /查看第 \d 张图片大图/ })).toHaveLength(4),
    );
    expect(screen.getByRole("button", { name: "查看全部 6 张图片" }).textContent).toBe("+2");
  });

  it("点击缩略图打开大图（原图按需读取，不拿缩略图冒充）", async () => {
    render(<CaptureAttachmentStrip attachments={[attachment("strip2-a")]} />);
    await waitFor(() => expect(bridge.quickCaptureAttachmentThumb).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "查看第 1 张图片大图" }));
    expect(await screen.findByRole("dialog", { name: "图片预览" })).toBeTruthy();
    await waitFor(() =>
      expect(bridge.quickCaptureAttachmentPreview).toHaveBeenCalledWith("strip2-a"),
    );
    const img = document.querySelector(".inbox-image-stage img") as HTMLImageElement;
    expect(img?.getAttribute("src")).toContain("full-strip2-a");
  });

  it("多图可左右切换，标题与按钮状态跟随当前索引", async () => {
    const list = [attachment("strip3-a"), attachment("strip3-b")];
    render(<CaptureAttachmentStrip attachments={list} />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /查看第 \d 张图片大图/ })).toHaveLength(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看第 1 张图片大图" }));
    expect(await screen.findByText("图片 1 / 2")).toBeTruthy();
    const prev = screen.getByRole("button", { name: "上一张" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(await screen.findByText("图片 2 / 2")).toBeTruthy();
    await waitFor(() =>
      expect(bridge.quickCaptureAttachmentPreview).toHaveBeenCalledWith("strip3-b"),
    );
    expect((screen.getByRole("button", { name: "下一张" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("缩略图读取失败时显示占位而不是空白按钮", async () => {
    bridge.quickCaptureAttachmentThumb.mockRejectedValueOnce(new Error("文件不存在"));
    render(<CaptureAttachmentStrip attachments={[attachment("strip4-a")]} />);
    const button = await screen.findByRole("button", { name: "查看第 1 张图片大图" });
    await waitFor(() => expect(button.className).toContain("is-pending"));
  });
});
