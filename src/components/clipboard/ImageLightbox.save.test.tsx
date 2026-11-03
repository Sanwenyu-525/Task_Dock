/**
 * @vitest-environment jsdom
 */
//! 图片另存为的覆盖授权契约。
//!
//! 系统保存对话框只负责选路径：当前 rfd/IFileSaveDialog 不设置 FOS_OVERWRITEPROMPT，
//! 对话框成功返回路径不构成可验证的覆盖授权。因此覆盖授权由应用内 ConfirmDialog 承担，
//! 并以显式 overwrite 布尔值交给 Rust 执行边界；写盘前必须 fail-closed 校验目标状态：
//! - "missing" → overwrite=false（新建写入；后端仍 create_new 排他，竞态出现不会被覆盖）
//! - "ok"      → 先弹应用内确认框；用户确认才 overwrite=true，拒绝/取消则不写盘
//! - "inaccessible" → 报错、不写盘
//! - 未知值/空数组/undefined/非数组/IPC 异常 → 视为无法确认，报错、不写盘
//! - 取消对话框（save 返回 null/空）→ 不查状态、不写盘
//! - 无确认通道（askConfirm 缺省）且目标已存在 → 按拒绝处理，绝不静默覆盖
//! - 后端失败（含目标已存在的竞争冲突）→ 展示错误，绝不改 overwrite=true 静默重试
//! - 对话框创建/调用抛异常 → 错误提示、不查状态、不写盘，并恢复可再次点击
//! - 保存流程中途卸载 → 不抛未处理 rejection，Toast 仍反馈最终结果
//! - 连点 → ref 同步守卫，只产生一次危险写入

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardImage: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardSaveImage: vi.fn(),
  clipboardPathStatus: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

const dialogPlugin = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogPlugin);

import ImageLightbox from "./ImageLightbox";
import type { ClipboardItem } from "../../lib/bridge";
import { resetOverlayStack } from "../../lib/overlayStack";
import { useUiStore } from "../../store/useUiStore";

/** 原生保存对话框返回的目标路径（各用例共用同一字面量，断言里引用同一常量）。 */
const TARGET = "D:\\\\tmp\\\\save-target.png";
const CONFIRM_TITLE = "覆盖已存在的文件？";

type ConfirmOpts = { title: string; run: () => void | Promise<void> };

/** 用户点「覆盖」：同步执行确认框动作。 */
function agreeConfirm() {
  return vi.fn((opts: ConfirmOpts) => {
    void opts.run();
  });
}

/** 用户取消/拒绝覆盖：不执行确认框动作（等价于点「取消」或 ESC）。 */
function declineConfirm() {
  return vi.fn((_opts: ConfirmOpts) => {});
}

afterEach(cleanup);

let seq = 0;
function makeItem(): ClipboardItem {
  return {
    id: `saveimg${++seq}`,
    kind: "image",
    text: "",
    html: "",
    preview: "1440x900",
    title: "image",
    title_source: "auto",
    byte_size: 123456,
    source_app: "chrome.exe",
    source_title: "page",
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOverlayStack();
  // Toast 队列是模块级 store：清空，避免上一个用例的提示干扰断言
  useUiStore.setState({ toast: null, toasts: [] });
  // jsdom 未实现指针捕获：补齐为无害空实现
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
  bridge.clipboardImage.mockResolvedValue("data:image/png;base64,QUJD");
  bridge.clipboardCopyItem.mockResolvedValue({
    mode: "image",
    bytes: 123456,
    warnings: [],
    sequence: 7,
    item_count: 1,
  });
  bridge.clipboardSaveImage.mockResolvedValue(211840);
});

/** 等原图就绪并让工具栏按钮不再 disabled（按钮条件是 state === "ready" 且非 busy）。 */
async function openToolbar(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(".clip-lightbox-img")).not.toBeNull());
  const img = document.querySelector<HTMLImageElement>(".clip-lightbox-img")!;
  Object.defineProperty(img, "naturalWidth", { value: 1440, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 900, configurable: true });
  fireEvent.load(img);
  let btn: HTMLElement | null = null;
  await waitFor(() => {
    btn = document.querySelector<HTMLElement>('button[aria-label="另存为"]');
    expect(btn).not.toBeNull();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
  return btn!;
}

/** 点击「另存为」并允许异步链路跑完（save → pathStatus → 确认 → saveImage / toast）。 */
async function clickSave(): Promise<void> {
  fireEvent.click(await openToolbar());
  await waitFor(() => expect(dialogPlugin.save).toHaveBeenCalledTimes(1));
  // 让 await save() 之后的微任务（含确认框调用与 finally 复位）全部落地
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function toastMessage(): string {
  return useUiStore.getState().toast?.message ?? "";
}

function toastKind(): string | undefined {
  return useUiStore.getState().toast?.kind;
}

describe("ImageLightbox 另存为：目标状态决定覆盖授权", () => {
  it("目标不存在：以 overwrite=false 新建写入，成功提示“已保存”，不弹应用内确认", async () => {
    const item = makeItem();
    const askConfirm = agreeConfirm();
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["missing"]);
    render(<ImageLightbox item={item} askConfirm={askConfirm} onClose={vi.fn()} />);

    await clickSave();

    expect(bridge.clipboardPathStatus).toHaveBeenCalledWith([TARGET]);
    expect(bridge.clipboardSaveImage).toHaveBeenCalledWith(item.id, TARGET, false);
    await waitFor(() => expect(toastKind()).toBe("success"));
    expect(toastMessage()).toContain("已保存");
    expect(toastMessage()).not.toContain("已覆盖保存");
    expect(toastMessage()).toContain(TARGET);
    // 目标不存在时无需覆盖授权
    expect(askConfirm).not.toHaveBeenCalled();
    // 写盘授权必须在状态查询之后才发生（fail-closed 的顺序契约）
    expect(bridge.clipboardPathStatus.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.clipboardSaveImage.mock.invocationCallOrder[0],
    );
    expect(bridge.clipboardSaveImage).toHaveBeenCalledTimes(1);
  });

  it("目标已存在：先弹应用内覆盖确认，用户确认后以 overwrite=true 写入并提示“已覆盖保存”", async () => {
    const item = makeItem();
    const askConfirm = agreeConfirm();
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["ok"]);
    render(<ImageLightbox item={item} askConfirm={askConfirm} onClose={vi.fn()} />);

    await clickSave();

    // 覆盖授权必须真正经过应用内确认框，并且发生在写盘之前
    expect(askConfirm).toHaveBeenCalledTimes(1);
    const opts = askConfirm.mock.calls[0][0];
    expect(opts.title).toBe(CONFIRM_TITLE);
    expect(opts.run).toBeTypeOf("function");
    expect(askConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.clipboardSaveImage.mock.invocationCallOrder[0],
    );
    expect(bridge.clipboardSaveImage).toHaveBeenCalledWith(item.id, TARGET, true);
    await waitFor(() => expect(toastKind()).toBe("success"));
    expect(toastMessage()).toContain("已覆盖保存");
    expect(toastMessage()).toContain(TARGET);
    expect(bridge.clipboardSaveImage).toHaveBeenCalledTimes(1);
  });

  it("目标已存在：用户拒绝覆盖（确认未执行）→ 不写盘、不提示成功", async () => {
    const item = makeItem();
    const askConfirm = declineConfirm();
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["ok"]);
    render(<ImageLightbox item={item} askConfirm={askConfirm} onClose={vi.fn()} />);

    await clickSave();

    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("目标已存在但无确认通道（askConfirm 缺省）：按拒绝处理，不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["ok"]);
    render(<ImageLightbox item={makeItem()} onClose={vi.fn()} />);

    await clickSave();

    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
    await waitFor(() => expect(toastKind()).toBe("info"));
    expect(toastMessage()).toContain("目标文件已存在，未覆盖");
  });

  it("对话框返回 null（取消或拒绝替换）：不查状态、不写盘、不报错", async () => {
    dialogPlugin.save.mockResolvedValue(null);
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    expect(bridge.clipboardPathStatus).not.toHaveBeenCalled();
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("save 返回 undefined（防御性）：同样不查状态、不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(undefined);
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    expect(bridge.clipboardPathStatus).not.toHaveBeenCalled();
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("save 返回空字符串：同样不查状态、不写盘", async () => {
    dialogPlugin.save.mockResolvedValue("");
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    expect(bridge.clipboardPathStatus).not.toHaveBeenCalled();
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("目标不可访问：报“无访问权限”错误、不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["inaccessible"]);
    const askConfirm = agreeConfirm();
    render(<ImageLightbox item={makeItem()} askConfirm={askConfirm} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("目标文件无访问权限，未保存");
    expect(toastMessage()).toContain(TARGET);
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("状态查询返回未知值：按无法确认处理，报错且不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["locked"]);
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("无法确认目标文件状态，未保存");
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
  });

  it("状态查询返回空数组：按无法确认处理，报错且不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue([]);
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("无法确认目标文件状态，未保存");
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
  });

  it("状态查询返回 undefined：按无法确认处理，报错且不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(undefined);
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("无法确认目标文件状态，未保存");
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
  });

  it("状态查询返回非数组（即使内容像合法状态）：严格校验失败，不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue("ok");
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("无法确认目标文件状态，未保存");
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
  });

  it("状态查询 IPC 异常：fail-closed，报错且不写盘", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockRejectedValue(new Error("ipc unavailable"));
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("无法确认目标文件状态，未保存");
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
  });

  it("后端竞争冲突（查询后文件才出现）：展示错误，绝不改 overwrite=true 静默重试", async () => {
    const item = makeItem();
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["missing"]);
    bridge.clipboardSaveImage.mockRejectedValue(new Error("目标文件已存在，未覆盖"));
    render(<ImageLightbox item={item} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("保存失败");
    expect(toastMessage()).toContain("目标文件已存在，未覆盖");
    // 只按初始授权写了一次，没有第二次 overwrite=true 调用
    expect(bridge.clipboardSaveImage).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardSaveImage.mock.calls.map((c) => c[2])).toEqual([false]);
  });

  it("保存对话框创建/调用抛异常：错误提示、不查状态、不写盘，并恢复可再次点击", async () => {
    const item = makeItem();
    dialogPlugin.save.mockRejectedValue(new Error("dialog unavailable"));
    render(<ImageLightbox item={item} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("打开保存对话框失败，未保存");
    expect(toastMessage()).toContain("dialog unavailable");
    expect(bridge.clipboardPathStatus).not.toHaveBeenCalled();
    expect(bridge.clipboardSaveImage).not.toHaveBeenCalled();
    // finally 必须复位 busy 与同步 in-flight 守卫：按钮重新可用，再点会重新打开对话框
    await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="另存为"]');
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);
    });
    fireEvent.click(document.querySelector<HTMLElement>('button[aria-label="另存为"]')!);
    await waitFor(() => expect(dialogPlugin.save).toHaveBeenCalledTimes(2));
  });

  it("保存流程中途卸载灯箱：不抛未处理 rejection，完成结果仍以 Toast 反馈", async () => {
    const item = makeItem();
    let resolveDialog!: (value: string | null) => void;
    dialogPlugin.save.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveDialog = resolve;
      }),
    );
    bridge.clipboardPathStatus.mockResolvedValue(["missing"]);
    const view = render(<ImageLightbox item={item} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    fireEvent.click(await openToolbar());
    await waitFor(() => expect(dialogPlugin.save).toHaveBeenCalledTimes(1));
    // 对话框尚未返回时用户关闭灯箱
    view.unmount();

    resolveDialog(TARGET);
    await waitFor(() => expect(bridge.clipboardSaveImage).toHaveBeenCalledWith(item.id, TARGET, false));
    expect(toastKind()).toBe("success");
    expect(toastMessage()).toContain("已保存");
  });

  it("保存失败（如磁盘错误）：展示后端错误，不显示成功提示", async () => {
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["ok"]);
    bridge.clipboardSaveImage.mockRejectedValue(new Error("写入失败：磁盘空间不足"));
    render(<ImageLightbox item={makeItem()} askConfirm={agreeConfirm()} onClose={vi.fn()} />);

    await clickSave();

    await waitFor(() => expect(toastKind()).toBe("error"));
    expect(toastMessage()).toContain("保存失败");
    expect(toastMessage()).toContain("磁盘空间不足");
    expect(bridge.clipboardSaveImage).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardSaveImage.mock.calls[0][2]).toBe(true);
  });

  it("连续点击只产生一次危险写入（ref 同步守卫）", async () => {
    const item = makeItem();
    dialogPlugin.save.mockResolvedValue(TARGET);
    bridge.clipboardPathStatus.mockResolvedValue(["ok"]);
    render(<ImageLightbox item={item} askConfirm={agreeConfirm()} onClose={vi.fn()} />);
    const btn = await openToolbar();

    // 同一个 act 作用域内连发两次 click：第二次赶在 React 以 busy=true 重渲染禁用
    // 按钮之前到达处理函数，只有同步 ref 守卫能拦住重复写盘。
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() =>
      expect(bridge.clipboardSaveImage).toHaveBeenCalledWith(item.id, TARGET, true),
    );
    expect(dialogPlugin.save).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardSaveImage).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardPathStatus).toHaveBeenCalledTimes(1);
  });
});
