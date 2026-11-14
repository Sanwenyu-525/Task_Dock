// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShelfItem } from "../../lib/bridge";
import { resetOverlayStack } from "../../lib/overlayStack";
import ShelfDetail from "./ShelfDetail";

const bridge = vi.hoisted(() => ({
  listTasks: vi.fn(),
  shelfTaskLinks: vi.fn(),
  shelfLinkTask: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfOpenItem: vi.fn(),
  shelfRevealItem: vi.fn(),
  shelfReadText: vi.fn(),
  shelfReadImage: vi.fn(),
  shelfCopyPaths: vi.fn(),
  shelfUnlinkTask: vi.fn(),
  shelfProjectLinks: vi.fn(),
  shelfLinkProject: vi.fn(),
  shelfUnlinkProject: vi.fn(),
  workspaceProjectList: vi.fn(),
  shelfOcrItem: vi.fn(),
  shelfOcrCancel: vi.fn(),
  shelfAddText: vi.fn(),
  shelfUpdate: vi.fn(),
  shelfItemTags: vi.fn(),
  shelfTagItems: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

const ITEM: ShelfItem = {
  id: "item-1",
  kind: "link",
  display_name: "示例链接",
  source_kind: "url",
  storage_mode: "link",
  original_path: null,
  managed_path: null,
  content: "https://example.com",
  byte_size: 0,
  file_ext: null,
  favorite: false,
  pinned: false,
  exists_state: "ok",
  group_id: null,
  scene_id: null,
  note: "",
  expire_at: null,
  created_at: "2026-11-05T00:00:00Z",
  updated_at: "2026-11-05T00:00:00Z",
};

function task(id: string, title: string) {
  return {
    id,
    title,
    description: "",
    priority: 0,
    status: "pending" as const,
    category: "",
    tags: [],
    due_at: null,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
    completed_at: null,
    linked_agents: 0,
  };
}

function renderDetail() {
  return render(<ShelfDetail item={ITEM} onClose={() => {}} />);
}

beforeEach(() => {
  resetOverlayStack();
  bridge.listTasks.mockReset();
  bridge.shelfTaskLinks.mockReset().mockResolvedValue([]);
  bridge.shelfLinkTask.mockReset().mockResolvedValue(undefined);
  bridge.shelfProjectLinks.mockReset().mockResolvedValue([]);
  bridge.shelfLinkProject.mockReset().mockResolvedValue(undefined);
  bridge.shelfUnlinkProject.mockReset().mockResolvedValue(undefined);
  bridge.workspaceProjectList.mockReset().mockResolvedValue({ projects: [] });
  bridge.shelfOcrItem.mockReset();
  bridge.shelfOcrCancel.mockReset().mockResolvedValue(true);
  bridge.shelfAddText.mockReset();
  bridge.shelfUpdate.mockReset();
  bridge.shelfCheckExists.mockReset().mockResolvedValue([]);
  bridge.shelfReadText.mockReset().mockResolvedValue({ content: "", truncated: false });
  bridge.shelfReadImage.mockReset().mockResolvedValue({ data_url: "", full: false });
  bridge.shelfOpenItem.mockReset().mockResolvedValue(undefined);
  bridge.shelfRevealItem.mockReset().mockResolvedValue(undefined);
  bridge.shelfCopyPaths.mockReset().mockResolvedValue({ copied: 0, failed: [] });
  bridge.shelfUnlinkTask.mockReset().mockResolvedValue(undefined);
  bridge.shelfItemTags.mockReset().mockResolvedValue([]);
  bridge.shelfTagItems.mockReset().mockResolvedValue({
    tags: [],
    items: 1,
    changed: 1,
    skipped: 0,
    failed: [],
    success: true,
    partial: false,
    code: null,
  });
});

afterEach(() => {
  cleanup();
});

function taskLinkButton(): HTMLButtonElement {
  const section = screen.getByRole("region", { name: "任务关联" });
  return within(section).getByRole("button", { name: "关联" }) as HTMLButtonElement;
}

describe("ShelfDetail 任务关联选择器", () => {
  it("加载中显示占位且不可展开", async () => {
    bridge.listTasks.mockReturnValue(new Promise(() => {}));
    renderDetail();

    const trigger = screen.getByRole("combobox", { name: "选择要关联的任务" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("正在加载任务…");
    expect(taskLinkButton().disabled).toBe(true);
  });

  it("无任务时提示暂无可关联任务", async () => {
    bridge.listTasks.mockResolvedValue([]);
    renderDetail();

    const trigger = (await screen.findByRole("combobox", { name: "选择要关联的任务" })) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("暂无可关联任务");
    expect(taskLinkButton().disabled).toBe(true);
  });

  it("加载失败时错误可见且不可关联", async () => {
    bridge.listTasks.mockRejectedValue(new Error("网络不可用"));
    renderDetail();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("任务列表加载失败");
    expect(alert.textContent).toContain("网络不可用");

    const trigger = screen.getByRole("combobox", { name: "选择要关联的任务" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(taskLinkButton().disabled).toBe(true);
  });

  it("选中任务后调用原有 shelfLinkTask IPC，并在成功后清空选择", async () => {
    bridge.listTasks.mockResolvedValue([task("t-1", "写周报"), task("t-2", "修缺陷")]);
    renderDetail();

    const trigger = (await screen.findByRole("combobox", { name: "选择要关联的任务" })) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: "写周报" }));

    expect(trigger.textContent).toContain("写周报");
    const linkButton = taskLinkButton();
    expect(linkButton.disabled).toBe(false);
    await userEvent.click(linkButton);

    await waitFor(() => expect(bridge.shelfLinkTask).toHaveBeenCalledWith("item-1", "t-1"));
    expect(bridge.shelfLinkTask).toHaveBeenCalledTimes(1);
    // 关联成功后刷新任务链接并清空选择，避免误把同一任务重复提交
    await waitFor(() => expect(bridge.shelfTaskLinks).toHaveBeenCalledWith("item-1"));
    expect(trigger.textContent).toContain("选择任务…");
    expect(taskLinkButton().disabled).toBe(true);
  });

  it("键盘可展开、导航并选中任务", async () => {
    bridge.listTasks.mockResolvedValue([task("t-1", "写周报"), task("t-2", "修缺陷")]);
    renderDetail();

    const trigger = (await screen.findByRole("combobox", { name: "选择要关联的任务" })) as HTMLButtonElement;
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(trigger.textContent).toContain("修缺陷");
    expect(taskLinkButton().disabled).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("ShelfDetail 文件操作入口", () => {
  const physical = (over: Partial<ShelfItem>): ShelfItem => ({
    ...ITEM,
    kind: "file",
    storage_mode: "reference",
    original_path: "C:\\tmp\\shelf-a.txt",
    ...over,
  });

  it("引用文件显示移动与复制入口", async () => {
    bridge.listTasks.mockResolvedValue([]);
    const onFileOp = vi.fn();
    render(<ShelfDetail item={physical({})} onClose={() => {}} onFileOp={onFileOp} />);

    await userEvent.click(screen.getByRole("button", { name: "移动原文件到…" }));
    expect(onFileOp).toHaveBeenCalledWith("move");
    await userEvent.click(screen.getByRole("button", { name: "复制到…" }));
    expect(onFileOp).toHaveBeenCalledWith("copy");
  });

  it("托管副本只显示导出入口", async () => {
    bridge.listTasks.mockResolvedValue([]);
    const onFileOp = vi.fn();
    render(
      <ShelfDetail
        item={physical({ storage_mode: "managed", managed_path: "files/a.txt" })}
        onClose={() => {}}
        onFileOp={onFileOp}
      />,
    );

    expect(screen.queryByRole("button", { name: "移动原文件到…" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "导出副本到…" }));
    expect(onFileOp).toHaveBeenCalledWith("copy");
  });

  it("失效引用隐藏移动/复制并提供重新定位", async () => {
    bridge.listTasks.mockResolvedValue([]);
    const onFileOp = vi.fn();
    const onRelocate = vi.fn();
    render(
      <ShelfDetail
        item={physical({ exists_state: "missing" })}
        onClose={() => {}}
        onFileOp={onFileOp}
        onRelocate={onRelocate}
      />,
    );

    expect(screen.queryByRole("button", { name: "移动原文件到…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制到…" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重新定位…" }));
    expect(onRelocate).toHaveBeenCalledTimes(1);
    expect(onFileOp).not.toHaveBeenCalled();
  });

  it("托管副本失效只提示恢复策略，不提供指向外部文件", async () => {
    bridge.listTasks.mockResolvedValue([]);
    render(
      <ShelfDetail
        item={physical({ storage_mode: "managed", managed_path: "files/a.txt", exists_state: "missing" })}
        onClose={() => {}}
        onRelocate={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "重新定位…" })).toBeNull();
    expect(screen.getByText(/托管副本已丢失/)).toBeTruthy();
  });

  it("链接与文本条目不显示文件操作入口", async () => {
    bridge.listTasks.mockResolvedValue([]);
    const onFileOp = vi.fn();
    render(<ShelfDetail item={ITEM} onClose={() => {}} onFileOp={onFileOp} />);

    expect(screen.queryByRole("button", { name: "移动原文件到…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制到…" })).toBeNull();
    expect(onFileOp).not.toHaveBeenCalled();
  });

  it("项目关联展示名称并可解除，不复制项目内容", async () => {
    bridge.listTasks.mockResolvedValue([]);
    bridge.shelfProjectLinks.mockResolvedValue([
      {
        project_id: "p1",
        item_id: ITEM.id,
        project_name: "漫剧项目",
        created_at: "2026-11-14T00:00:00Z",
      },
    ]);
    render(<ShelfDetail item={ITEM} onClose={() => {}} />);
    expect(await screen.findByText("漫剧项目")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "解除项目关联 漫剧项目" }));
    await waitFor(() =>
      expect(bridge.shelfUnlinkProject).toHaveBeenCalledWith("item-1", "p1"),
    );
  });

  it("图片 OCR 结果可复制/保存为文本，原图不改动", async () => {
    bridge.listTasks.mockResolvedValue([]);
    bridge.shelfOcrItem.mockResolvedValue({
      status: "ok",
      code: "ok",
      text: "错误日志 0x80070005",
      reason: null,
      durationMs: 12,
      cached: false,
      lines: 1,
      chars: 13,
      width: 640,
      height: 480,
      engine: "windows",
      suggestedTitle: "错误日志",
    });
    const created = {
      ...ITEM,
      id: "text-1",
      kind: "text" as const,
      display_name: "错误日志 0x80070005",
      content: "错误日志 0x80070005",
    };
    bridge.shelfAddText.mockResolvedValue(created);
    bridge.shelfUpdate.mockResolvedValue({
      ...created,
      note: "OCR 自：截图.png",
    });
    const imageItem = {
      ...ITEM,
      kind: "image" as const,
      display_name: "截图.png",
      file_ext: "png",
      original_path: "C:/shots/截图.png",
    };
    render(<ShelfDetail item={imageItem} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "识别图片文字" }));
    await waitFor(() =>
      expect(bridge.shelfOcrItem).toHaveBeenCalledWith(
        "item-1",
        expect.stringContaining("shelf-ocr-item-1"),
      ),
    );
    const textarea = (await screen.findByLabelText("OCR 识别结果")) as HTMLTextAreaElement;
    expect(textarea.value).toBe("错误日志 0x80070005");

    fireEvent.click(screen.getByRole("button", { name: "保存为文本条目" }));
    await waitFor(() =>
      expect(bridge.shelfAddText).toHaveBeenCalledWith("错误日志 0x80070005", null),
    );
    await waitFor(() =>
      expect(bridge.shelfUpdate).toHaveBeenCalledWith(
        "text-1",
        expect.objectContaining({ note: "OCR 自：截图.png" }),
      ),
    );
  });
});

