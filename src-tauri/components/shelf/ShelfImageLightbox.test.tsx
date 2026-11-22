/** @vitest-environment jsdom */
//! 暂存架图片灯箱光标契约：平移区 grab / 拖动中 grabbing；
//! 工具栏按钮维持 pointer（全局 button 规则）。同时锁定两件行为：
//! 图片本体也要能起拖（放大后图片铺满视口时只能从图片上平移），
//! 以及拖拽后的补发 click 不会误触发「点遮罩关闭」。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ShelfItem } from "../../lib/bridge";
import { resetOverlayStack } from "../../lib/overlayStack";
import uiCss from "../../styles-ui.css?raw";
import stylesCss from "../../styles.css?raw";

const bridge = vi.hoisted(() => ({ shelfReadImage: vi.fn() }));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import ShelfImageLightbox from "./ShelfImageLightbox";

const ITEM: ShelfItem = {
  id: "img-1",
  kind: "image",
  display_name: "截图.png",
  source_kind: "drag",
  storage_mode: "managed",
  original_path: null,
  managed_path: "images/shot.png",
  content: null,
  byte_size: 2048,
  file_ext: "png",
  favorite: false,
  pinned: false,
  exists_state: "ok",
  group_id: null,
  scene_id: null,
  note: "",
  expire_at: null,
  created_at: "2026-11-04T00:00:00Z",
  updated_at: "2026-11-04T00:00:00Z",
};

beforeAll(() => {
  // jsdom 未实现指针捕获，和剪贴板灯箱测试保持同样的兜底
  const proto = Element.prototype as unknown as { setPointerCapture?: (id: number) => void };
  proto.setPointerCapture ??= () => {};
});

beforeEach(() => {
  resetOverlayStack();
  bridge.shelfReadImage.mockReset();
  bridge.shelfReadImage.mockResolvedValue("data:image/png;base64,AAAA");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderLightbox() {
  const onClose = vi.fn();
  const view = render(<ShelfImageLightbox item={ITEM} onClose={onClose} />);
  // 灯箱走 createPortal 挂到 document.body，不在 render 容器内
  const img = await waitFor(() => {
    const el = document.querySelector<HTMLImageElement>(".shelf-lightbox-stage img");
    expect(el).toBeTruthy();
    return el!;
  });
  Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true });
  fireEvent.load(img);
  const stage = document.querySelector(".shelf-lightbox-stage") as HTMLElement;
  return { view, img, stage, onClose };
}

function dragging(stage: HTMLElement) {
  return stage.classList.contains("is-dragging");
}

describe("暂存架灯箱平移光标", () => {
  it("图片与舞台平移区给 grab，拖动中给 grabbing", () => {
    expect(stylesCss).toMatch(/\.shelf-lightbox-stage img\s*\{[^}]*cursor:\s*grab/);
    expect(uiCss).toMatch(/\.shelf-lightbox-stage\s*\{[^}]*cursor:\s*grab/);
    expect(uiCss).toMatch(/\.shelf-lightbox-stage\.is-dragging[^{]*\{[^}]*cursor:\s*grabbing/);
  });

  it("按住图片起拖进入 grabbing，松手复位且监听成对摘除", async () => {
    const { stage, img } = await renderLightbox();
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const count = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((call) => call[0] === type).length;

    const TYPES = ["pointerup", "pointercancel", "blur"] as const;
    const active = (t: string) => count(winAdd, t) - count(winRemove, t);
    const before = TYPES.map((t) => active(t));
    const docBefore =
      count(docAdd, "visibilitychange") - count(docRemove, "visibilitychange");

    fireEvent.pointerDown(img, { button: 0, pointerId: 1 });
    expect(dragging(stage)).toBe(true);
    TYPES.forEach((t, i) => expect(active(t) - before[i]).toBe(1));

    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(dragging(stage)).toBe(false);
    TYPES.forEach((t, i) => expect(active(t) - before[i]).toBe(0));
    expect(
      count(docAdd, "visibilitychange") - count(docRemove, "visibilitychange") - docBefore,
    ).toBe(0);
    expect(count(winRemove, "pointerup")).toBeGreaterThanOrEqual(1);
    expect(count(docRemove, "visibilitychange")).toBeGreaterThanOrEqual(1);
  });

  it("非主键按下与失焦都不留 grabbing", async () => {
    const { stage, img } = await renderLightbox();

    fireEvent.pointerDown(img, { button: 2 });
    expect(dragging(stage)).toBe(false);

    fireEvent.pointerDown(img, { button: 0 });
    expect(dragging(stage)).toBe(true);
    fireEvent.blur(window);
    expect(dragging(stage)).toBe(false);
  });

  it("无位移点击图片关闭灯箱；超过 4px 拖拽后的补发 click 不关闭", async () => {
    const { stage, img, onClose } = await renderLightbox();

    fireEvent.pointerDown(img, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.click(stage);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(img, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { buttons: 1, pointerId: 2, clientX: 34, clientY: 10 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    fireEvent.click(stage);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── 序列浏览 / 失败重试 / 焦点恢复（2026-11-14）──

describe("暂存架灯箱序列与恢复", () => {
  function item(id: string, name: string): ShelfItem {
    return { ...ITEM, id, display_name: name };
  }

  it("左右方向键与按钮按调用方给出的顺序切换，并显示序号", async () => {
    const a = item("img-a", "一.png");
    const b = item("img-b", "二.png");
    const onNavigate = vi.fn();
    render(
      <ShelfImageLightbox
        item={a}
        images={[a, b]}
        onNavigate={onNavigate}
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "图片预览：一.png" });
    expect(dialog.textContent).toContain("1 / 2");

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(onNavigate).toHaveBeenLastCalledWith(-1);

    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(onNavigate).toHaveBeenLastCalledWith(1);
  });

  it("加载失败显示重试与下一张，重试重新读取图片", async () => {
    bridge.shelfReadImage.mockResolvedValueOnce(null);
    bridge.shelfReadImage.mockResolvedValueOnce("data:image/png;base64,BBBB");
    const onNavigate = vi.fn();
    render(
      <ShelfImageLightbox
        item={ITEM}
        images={[ITEM, { ...ITEM, id: "img-2", display_name: "二.png" }]}
        onNavigate={onNavigate}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(document.querySelector(".shelf-lightbox-stage img")).toBeTruthy(),
    );
    expect(bridge.shelfReadImage).toHaveBeenCalledTimes(2);
  });

  it("关闭后焦点回到打开灯箱前的按钮", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const view = render(<ShelfImageLightbox item={ITEM} onClose={() => {}} />);
    await screen.findByRole("dialog", { name: "图片预览：截图.png" });
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("双击在适应窗口与 100% 之间切换", async () => {
    const { stage } = await renderLightbox();
    const zoom = () => document.querySelector(".shelf-lightbox-zoom")?.textContent;
    fireEvent.doubleClick(stage);
    expect(zoom()).toBe("100%");
    fireEvent.doubleClick(stage);
    expect(zoom()).not.toBe("100%");
  });
});
