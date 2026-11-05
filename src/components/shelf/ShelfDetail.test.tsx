// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  bridge.shelfCheckExists.mockReset().mockResolvedValue([]);
  bridge.shelfReadText.mockReset().mockResolvedValue({ content: "", truncated: false });
  bridge.shelfReadImage.mockReset().mockResolvedValue({ data_url: "", full: false });
  bridge.shelfOpenItem.mockReset().mockResolvedValue(undefined);
  bridge.shelfRevealItem.mockReset().mockResolvedValue(undefined);
  bridge.shelfCopyPaths.mockReset().mockResolvedValue({ copied: 0, failed: [] });
  bridge.shelfUnlinkTask.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("ShelfDetail 任务关联选择器", () => {
  it("加载中显示占位且不可展开", async () => {
    bridge.listTasks.mockReturnValue(new Promise(() => {}));
    renderDetail();

    const trigger = screen.getByRole("combobox", { name: "选择要关联的任务" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("正在加载任务…");
    expect((screen.getByRole("button", { name: /关联/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("无任务时提示暂无可关联任务", async () => {
    bridge.listTasks.mockResolvedValue([]);
    renderDetail();

    const trigger = (await screen.findByRole("combobox", { name: "选择要关联的任务" })) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain("暂无可关联任务");
    expect((screen.getByRole("button", { name: /关联/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("加载失败时错误可见且不可关联", async () => {
    bridge.listTasks.mockRejectedValue(new Error("网络不可用"));
    renderDetail();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("任务列表加载失败");
    expect(alert.textContent).toContain("网络不可用");

    const trigger = screen.getByRole("combobox", { name: "选择要关联的任务" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect((screen.getByRole("button", { name: /关联/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("选中任务后调用原有 shelfLinkTask IPC，并在成功后清空选择", async () => {
    bridge.listTasks.mockResolvedValue([task("t-1", "写周报"), task("t-2", "修缺陷")]);
    renderDetail();

    const trigger = (await screen.findByRole("combobox", { name: "选择要关联的任务" })) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: "写周报" }));

    expect(trigger.textContent).toContain("写周报");
    const linkButton = screen.getByRole("button", { name: /关联/ }) as HTMLButtonElement;
    expect(linkButton.disabled).toBe(false);
    await userEvent.click(linkButton);

    await waitFor(() => expect(bridge.shelfLinkTask).toHaveBeenCalledWith("item-1", "t-1"));
    expect(bridge.shelfLinkTask).toHaveBeenCalledTimes(1);
    // 关联成功后刷新任务链接并清空选择，避免误把同一任务重复提交
    await waitFor(() => expect(bridge.shelfTaskLinks).toHaveBeenCalledWith("item-1"));
    expect(trigger.textContent).toContain("选择任务…");
    expect((screen.getByRole("button", { name: /关联/ }) as HTMLButtonElement).disabled).toBe(true);
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
    expect((screen.getByRole("button", { name: /关联/ }) as HTMLButtonElement).disabled).toBe(false);
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
});

