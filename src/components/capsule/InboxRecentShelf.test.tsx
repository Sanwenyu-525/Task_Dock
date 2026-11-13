/**
 * @vitest-environment jsdom
 */
//! 胶囊「最近暂存」接收区：标记只在接入仲裁器时暴露，拖入提示/高亮只在
//! 拖拽会话期间出现，且不改变既有 [+] 添加、列表展示与删除入口。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listRecent = vi.fn();
const addShelfPaths = vi.fn();
const openDialog = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
}));

vi.mock("../../lib/bridge", () => ({
  shelfList: (...a: unknown[]) => listRecent(...a),
  shelfCheckExists: vi.fn(async () => []),
  shelfAddPaths: (...a: unknown[]) => addShelfPaths(...a),
  shelfUpdate: vi.fn(),
  shelfDelete: vi.fn(),
  shelfStats: vi.fn(async () => ({
    total: 0,
    file_count: 0,
    image_count: 0,
    folder_count: 0,
    link_count: 0,
    text_count: 0,
    managed_bytes: 0,
    disk_bytes: 0,
    quota_mb: 2048,
  })),
  shelfGroups: vi.fn(async () => []),
  shelfDragOut: vi.fn(),
  shelfOpenItem: vi.fn(),
  shelfCopyFiles: vi.fn(),
  shelfCopyPaths: vi.fn(),
  shelfGetItem: vi.fn(),
  shelfReadText: vi.fn(),
  shelfRevealItem: vi.fn(),
  clipboardCopyText: vi.fn(),
  applyMode: async () => undefined,
}));

import InboxRecentShelf, { SHELF_RECENT_DROP_ZONE } from "./InboxRecentShelf";
import { useShelfStore, __resetShelfRecentCache } from "../../store/useShelfStore";
import { useLocaleStore } from "../../i18n";

function shelfItem(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    kind: "file",
    display_name: "报告.pdf",
    source_kind: "picker",
    storage_mode: "reference",
    original_path: "C:\\Docs\\报告.pdf",
    managed_path: null,
    content: null,
    byte_size: 1024,
    file_ext: "pdf",
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: "shelf-default",
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  listRecent.mockReset();
  addShelfPaths.mockReset();
  openDialog.mockReset();
  listRecent.mockResolvedValue({ items: [], total: 0 });
  addShelfPaths.mockResolvedValue({ added: [], failed: [] });
  openDialog.mockResolvedValue(null);
  __resetShelfRecentCache();
  useShelfStore.setState({
    recent: [],
    recentLoading: false,
    recentLoaded: false,
    recentError: null,
  });
  useLocaleStore.setState({ locale: "zh-CN", preference: "zh-CN" });
});

afterEach(() => {
  cleanup();
  useLocaleStore.setState({ locale: "zh-CN", preference: "zh-CN" });
});

function sectionOf(container: HTMLElement): HTMLElement {
  return container.querySelector(".cap-shelf-recent") as HTMLElement;
}

describe("InboxRecentShelf 拖入接收区", () => {
  it("未接入仲裁器时不暴露接收区标记，也不显示拖入提示", async () => {
    const { container } = render(
      <InboxRecentShelf onNotice={vi.fn()} dropActive dropOver />,
    );
    await screen.findByText("最近暂存");

    const section = sectionOf(container);
    expect(section.hasAttribute("data-drop-zone")).toBe(false);
    expect(section.className).not.toContain("is-drop-active");
    expect(section.className).not.toContain("is-drop-over");
    expect(screen.queryByText(/可暂存/)).toBeNull();
  });

  it("空列表也可接收：拖拽期间显示轻提示与落点高亮", async () => {
    const { container } = render(
      <InboxRecentShelf onNotice={vi.fn()} dropZone dropActive dropOver />,
    );
    await screen.findByText(/暂存架还是空的/);

    const section = sectionOf(container);
    expect(section.getAttribute("data-drop-zone")).toBe(SHELF_RECENT_DROP_ZONE);
    expect(section.className).toContain("is-drop-active");
    expect(section.className).toContain("is-drop-over");
    // 落点在接收区：短标签只回答「松手会怎样」；「只保存引用」的语义由同区域的说明承担
    const hint = screen.getByText(/松开即加入/);
    expect(hint.closest(".cap-shelf-recent")).toBe(section);
    expect(screen.getByText(/默认只保存引用/)).toBeTruthy();
  });

  it("提示与高亮只在拖拽期间出现，拖拽结束后不占用列表空间", async () => {
    const { container, rerender } = render(
      <InboxRecentShelf onNotice={vi.fn()} dropZone />,
    );
    await screen.findByText("最近暂存");
    const section = sectionOf(container);
    expect(section.className).not.toContain("is-drop-active");
    expect(screen.queryByText(/可暂存/)).toBeNull();

    rerender(<InboxRecentShelf onNotice={vi.fn()} dropZone dropActive />);
    expect(section.className).toContain("is-drop-active");
    expect(section.className).not.toContain("is-drop-over");
    expect(screen.getByText(/可暂存/)).toBeTruthy();

    rerender(<InboxRecentShelf onNotice={vi.fn()} dropZone dropActive dropOver />);
    expect(section.className).toContain("is-drop-over");
    expect(screen.getByText(/松开即加入/)).toBeTruthy();
    expect(screen.queryByText(/可暂存/)).toBeNull();

    rerender(<InboxRecentShelf onNotice={vi.fn()} dropZone />);
    expect(section.className).not.toContain("is-drop-active");
    expect(section.className).not.toContain("is-drop-over");
    expect(screen.queryByText(/可暂存/)).toBeNull();
    expect(screen.queryByText(/松开即加入/)).toBeNull();
  });

  it("拖入提示只在标题行内：不进入列表项，也不改变列表条目数", async () => {
    listRecent.mockResolvedValue({
      items: [shelfItem(), shelfItem({ id: "s2", display_name: "截图.png" })],
      total: 2,
    });
    const { container, rerender } = render(
      <InboxRecentShelf onNotice={vi.fn()} dropZone />,
    );
    await screen.findByText("报告.pdf");
    const list = container.querySelector(".cap-shelf-recent-list") as HTMLElement;
    const itemsBefore = Array.from(list.children);
    expect(itemsBefore.length).toBe(2);

    rerender(<InboxRecentShelf onNotice={vi.fn()} dropZone dropActive dropOver />);
    const hint = screen.getByText(/松开即加入/);
    // 提示是标题行里的状态标签（与 22px 按钮同高）：不插进 <ul> 里挤占列表空间，
    // 也不再是盖住最后一行的绝对定位浮层。
    expect(hint.closest(".cap-shelf-recent-list")).toBeNull();
    expect(hint.closest(".cap-shelf-recent-head")).toBeTruthy();
    expect(hint.tagName).toBe("SPAN");
    expect(list.children.length).toBe(itemsBefore.length);
    expect(Array.from(list.children).every((el, i) => el === itemsBefore[i])).toBe(true);
    // 拖拽提示出现期间原有条目与操作入口仍在
    expect(screen.getByText("报告.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加文件到暂存架" })).toBeTruthy();
  });

  it("有条目时同样可接收，现有最近列表保持可见", async () => {
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    const { container } = render(
      <InboxRecentShelf onNotice={vi.fn()} dropZone dropActive dropOver />,
    );
    await screen.findByText("报告.pdf");

    const section = sectionOf(container);
    expect(section.getAttribute("data-drop-zone")).toBe(SHELF_RECENT_DROP_ZONE);
    expect(screen.getByText(/松开即加入/)).toBeTruthy();
    expect(screen.getByText("报告.pdf")).toBeTruthy();
  });

  it("拖入提示显示期间「+」添加按钮仍可用", async () => {
    openDialog.mockResolvedValue(["C:\\Docs\\新文件.txt"]);
    addShelfPaths.mockResolvedValue({ added: [shelfItem()], failed: [] });
    render(<InboxRecentShelf onNotice={vi.fn()} dropZone dropActive dropOver />);
    await screen.findByText("最近暂存");

    fireEvent.click(screen.getByRole("button", { name: "添加文件到暂存架" }));
    await waitFor(() =>
      expect(addShelfPaths).toHaveBeenCalledWith(
        ["C:\\Docs\\新文件.txt"],
        "reference",
        "picker",
        null,
      ),
    );
  });

  it("英文环境使用对应提示文案（拖拽中 / 落点在上）", async () => {
    useLocaleStore.setState({ locale: "en-US", preference: "en-US" });
    const { rerender } = render(
      <InboxRecentShelf onNotice={vi.fn()} dropZone dropActive />,
    );
    await screen.findByText(/Droppable/);

    rerender(<InboxRecentShelf onNotice={vi.fn()} dropZone dropActive dropOver />);
    await screen.findByText(/Release to add/);
  });
});
