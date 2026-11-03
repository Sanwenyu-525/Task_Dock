/**
 * @vitest-environment jsdom
 */
//! 分组详情：主操作常驻、整理类高级操作默认收起，截图条目带头像级缩略图与标题。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const bridge = vi.hoisted(() => ({
  clipboardGroup: vi.fn(),
  clipboardThumb: vi.fn(),
  clipboardRemoveGroupItem: vi.fn(),
  clipboardMoveGroupItem: vi.fn(),
  clipboardRenameGroup: vi.fn(),
  clipboardCloseGroup: vi.fn(),
  clipboardSplitGroup: vi.fn(),
  clipboardCopyGroupRich: vi.fn(),
  clipboardCopyGroupFiles: vi.fn(),
  clipboardDeleteGroup: vi.fn(),
  clipboardDeleteItems: vi.fn(),
  clipboardToggleGroup: vi.fn(),
  clipboardLinkTask: vi.fn(),
  clipboardAgentTargets: vi.fn(),
  clipboardExportForAgent: vi.fn(),
  workspaceList: vi.fn(),
  clipboardLinkSnapshot: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import ClipboardGroupDetail from "./ClipboardGroupDetail";
import type { ClipboardGroup, ClipboardItem, ClipboardView } from "../../lib/bridge";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

function makeItem(i: number, over: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id: `ci${i}`,
    kind: "text",
    text: "",
    html: "",
    preview: `预览 ${i}`,
    title: `标题 ${i}`,
    title_source: "auto",
    byte_size: 20,
    source_app: "notepad.exe",
    source_title: "记事本",
    image_width: null,
    image_height: null,
    file_paths: [],
    favorite: false,
    pinned: false,
    copy_count: 0,
    created_at: "2026-11-02T00:00:00Z",
    last_seen_at: "2026-11-02T00:00:00Z",
    has_image: false,
    has_thumb: false,
    ...over,
  };
}

function makeGroup(items: ClipboardItem[]): ClipboardGroup {
  return {
    id: "g1",
    name: "截图集合",
    mode: "auto",
    status: "closed",
    favorite: false,
    pinned: false,
    created_at: "2026-11-02T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    closed_at: null,
    item_count: items.length,
    image_count: items.filter((i) => i.kind === "image").length,
    preview: "分组预览",
    items,
  };
}

const noProps = { linkTask: null, askConfirm: vi.fn(), onBack: vi.fn(), onChanged: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  bridge.clipboardGroup.mockResolvedValue(
    makeGroup([
      makeItem(0, { kind: "image", has_thumb: true, has_image: true, title: "截图 800×600" }),
      makeItem(1),
    ]),
  );
  bridge.clipboardThumb.mockResolvedValue("data:image/png;base64,AA==");
  bridge.clipboardRemoveGroupItem.mockResolvedValue(makeGroup([]));
  bridge.workspaceList.mockResolvedValue([]);
  bridge.clipboardAgentTargets.mockResolvedValue([]);
  useSettingsStore.setState({ settings: {} as never });
  useUiStore.setState({ toast: null });
  useClipboardStore.setState({
    view: null,
    exiting: {},
    selectedItems: [],
    selectedGroups: [],
  });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: null });
});

describe("分组详情", () => {
  it("默认只保留主操作，移除误分组条目的入口常驻", async () => {
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    expect(await screen.findByRole("button", { name: "从分组移除第 1 项" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "从分组移除第 2 项" })).toBeTruthy();
    // 高级操作（勾选拆分、上移/下移）默认不占每行主区域
    expect(screen.queryByRole("button", { name: "上移第 1 项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择用于拆分" })).toBeNull();
  });

  it("展开「整理与拆分」后才出现勾选与排序按钮", async () => {
    const user = userEvent.setup();
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "整理与拆分" }));

    // 每行一个拆分勾选框（第 1 行是截图、第 2 行是文字）
    expect(await screen.findAllByRole("button", { name: "选择用于拆分" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "上移第 2 项" })).toBeTruthy();
    // 首项没有上一次序，末项的下一次序存在
    expect(screen.getByRole("button", { name: "上移第 1 项" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "下移第 1 项" })).toBeTruthy();
  });

  it("截图条目显示缩略图，标题优先于预览", async () => {
    // 缩略图有进程内缓存，用独立 id 断言「只为图片条目请求缩略图」
    bridge.clipboardGroup.mockResolvedValue(
      makeGroup([
        makeItem(0, {
          id: "ci-shot-a",
          kind: "image",
          has_thumb: true,
          has_image: true,
          title: "截图 800×600",
        }),
        makeItem(1, { id: "ci-note-b", title: "标题 1", preview: "预览 1" }),
      ]),
    );
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await waitFor(() => expect(bridge.clipboardThumb).toHaveBeenCalledWith("ci-shot-a"));
    expect(bridge.clipboardThumb.mock.calls.length).toBe(1);
    const thumb = document.querySelector("img.clip-thumb");
    expect(thumb).toBeTruthy();
    expect(thumb?.getAttribute("alt")).toBe("");

    expect(screen.getByText("截图 800×600")).toBeTruthy();
    expect(screen.getByText("标题 1")).toBeTruthy();
    expect(screen.queryByText("预览 1")).toBeNull();
  });

  it("从分组移除只解除关联并提示内容仍保留", async () => {
    const user = userEvent.setup();
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "从分组移除第 1 项" }));

    await waitFor(() => expect(bridge.clipboardRemoveGroupItem).toHaveBeenCalledWith("g1", "ci0"));
    expect(useUiStore.getState().toast?.message).toContain("内容仍保留在历史中");
    // 从分组移除 ≠ 删除历史
    expect(bridge.clipboardDeleteItems).not.toHaveBeenCalled();
    expect(bridge.clipboardDeleteGroup).not.toHaveBeenCalled();
  });
});

describe("分组详情的离场与顺序反馈", () => {
  const rowIds = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-clip-row]")).map((r) => r.dataset.clipRow);

  function viewOf(items: ClipboardItem[], groups: ClipboardGroup[] = []): ClipboardView {
    return { items, groups, stats: {}, total_items: items.length } as unknown as ClipboardView;
  }

  it("移除行先收拢离场，动画结束才按服务端顺序落定", async () => {
    const user = userEvent.setup();
    bridge.clipboardGroup.mockResolvedValue(
      makeGroup([makeItem(0), makeItem(1), makeItem(2)]),
    );
    bridge.clipboardRemoveGroupItem.mockResolvedValue(makeGroup([makeItem(0), makeItem(2)]));
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "从分组移除第 2 项" }));

    await waitFor(() => expect(bridge.clipboardRemoveGroupItem).toHaveBeenCalledWith("g1", "ci1"));
    // mock 已调用 ≠ React 已把离场行提交到 DOM：setGroup(next) 与 scheduleRowExit
    // 是两次提交，全量并发渲染变慢时会先看到「ci1 已不在列表」的中间态。
    // 等离场行真正带着 removing 出现，再断言顺序，避免把提交时序当成回归。
    await waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-clip-row="ci1"]');
      expect(row?.classList.contains("removing")).toBe(true);
      expect(row?.getAttribute("aria-hidden")).toBe("true");
    });
    // 离场行按原位补位，其余行不被打乱
    expect(rowIds()).toEqual(["ci0", "ci1", "ci2"]);

    await waitFor(() => expect(document.querySelector('[data-clip-row="ci1"]')).toBeNull());
    expect(rowIds()).toEqual(["ci0", "ci2"]);
  });

  /** 确定性冲刷：等 mock IPC 与 React 提交完成（act 退出时强制 flush 渲染）。 */
  async function flushClick(click: () => void) {
    await act(async () => {
      click();
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
  }

  it("连续移除相邻两条：第二条的离场位置保持在第一条之后，顺序不乱", async () => {
    const base = [makeItem(0), makeItem(1), makeItem(2)];
    bridge.clipboardGroup.mockResolvedValue(makeGroup(base));
    const removed: string[] = [];
    bridge.clipboardRemoveGroupItem.mockImplementation(async (_gid: string, itemId: string) => {
      removed.push(itemId);
      return makeGroup(base.filter((i) => !removed.includes(i.id)));
    });
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    const mm = vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await flushClick(() =>
        fireEvent.click(screen.getByRole("button", { name: "从分组移除第 1 项" })),
      );
      expect(bridge.clipboardRemoveGroupItem).toHaveBeenCalledTimes(1);
      await flushClick(() =>
        fireEvent.click(screen.getByRole("button", { name: "从分组移除第 2 项" })),
      );
      expect(bridge.clipboardRemoveGroupItem).toHaveBeenCalledTimes(2);
      // 两条都在离场时，展示顺序必须仍是原始顺序（索引偏移的症状是 ci1 跑到 ci0 前）
      expect(rowIds()).toEqual(["ci0", "ci1", "ci2"]);

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(rowIds()).toEqual(["ci2"]);
    } finally {
      vi.useRealTimers();
      mm.mockRestore();
    }
  });

  it("连续移除不相邻两条：各自按展示位置离场，中间行不被挤动", async () => {
    const base = [makeItem(0), makeItem(1), makeItem(2), makeItem(3)];
    bridge.clipboardGroup.mockResolvedValue(makeGroup(base));
    const removed: string[] = [];
    bridge.clipboardRemoveGroupItem.mockImplementation(async (_gid: string, itemId: string) => {
      removed.push(itemId);
      return makeGroup(base.filter((i) => !removed.includes(i.id)));
    });
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    const mm = vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await flushClick(() =>
        fireEvent.click(screen.getByRole("button", { name: "从分组移除第 1 项" })),
      );
      expect(bridge.clipboardRemoveGroupItem).toHaveBeenCalledTimes(1);
      await flushClick(() =>
        fireEvent.click(screen.getByRole("button", { name: "从分组移除第 3 项" })),
      );
      expect(bridge.clipboardRemoveGroupItem).toHaveBeenCalledTimes(2);
      expect(rowIds()).toEqual(["ci0", "ci1", "ci2", "ci3"]);

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(rowIds()).toEqual(["ci1", "ci3"]);
    } finally {
      vi.useRealTimers();
      mm.mockRestore();
    }
  });

  it("移除后焦点交给相邻行；分组空了则回到返回按钮", async () => {
    const user = userEvent.setup();
    bridge.clipboardGroup.mockResolvedValue(makeGroup([makeItem(0), makeItem(1)]));
    bridge.clipboardRemoveGroupItem.mockResolvedValue(makeGroup([makeItem(1)]));
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "从分组移除第 1 项" }));
    await waitFor(() => {
      const main = document.querySelector<HTMLElement>('[data-clip-row="ci1"] .clip-group-item-main');
      expect(main).toBeTruthy();
      expect(document.activeElement).toBe(main);
    });

    // 分组只剩最后一条：移除后没有相邻行，焦点退回返回按钮
    bridge.clipboardGroup.mockResolvedValue(makeGroup([makeItem(1)]));
    bridge.clipboardRemoveGroupItem.mockResolvedValue(makeGroup([]));
    await user.click(screen.getByRole("button", { name: "从分组移除第 1 项" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "返回分组列表" }),
      ),
    );
  });

  it("拆分成功：被拆条目收拢离场，Toast 说明拆分数量", async () => {
    const user = userEvent.setup();
    bridge.clipboardGroup.mockResolvedValueOnce(
      makeGroup([makeItem(0), makeItem(1), makeItem(2)]),
    );
    bridge.clipboardSplitGroup.mockResolvedValue(makeGroup([makeItem(2)]));
    // 拆分后 reload 拿到的分组里已没有被拆走的条目
    bridge.clipboardGroup.mockResolvedValue(makeGroup([makeItem(2)]));
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "整理与拆分" }));
    const checks = screen.getAllByRole("button", { name: "选择用于拆分" });
    await user.click(checks[0]);
    await user.click(checks[1]);
    await user.click(screen.getByRole("button", { name: "拆分为新分组" }));

    await waitFor(() => expect(bridge.clipboardSplitGroup).toHaveBeenCalledWith("g1", ["ci0", "ci1"], "拆分分组"));
    await waitFor(() => expect(rowIds()).toEqual(["ci2"]));
    expect(useUiStore.getState().toast?.message).toContain("已把 2 项拆分为新分组");
    expect(useUiStore.getState().toast?.message).toContain("本分组剩 1 项");
  });

  it("拆分失败：不播任何成功动画，行保持原样", async () => {
    const user = userEvent.setup();
    bridge.clipboardSplitGroup.mockRejectedValueOnce(new Error("数据库被占用"));
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "整理与拆分" }));
    await user.click(screen.getAllByRole("button", { name: "选择用于拆分" })[0]);
    await user.click(screen.getByRole("button", { name: "拆分为新分组" }));

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("error"));
    expect(document.querySelector(".removing")).toBeNull();
    expect(rowIds()).toEqual(["ci0", "ci1"]);
  });

  it("移除失败时保持原样：不播离场、不谎报已移除", async () => {
    const user = userEvent.setup();
    bridge.clipboardRemoveGroupItem.mockRejectedValueOnce(new Error("数据库被占用"));
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "从分组移除第 2 项" }));

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("error"));
    expect(useUiStore.getState().toast?.message).toContain("数据库被占用");
    expect(useUiStore.getState().toast?.message).not.toContain("已把");
    expect(document.querySelector(".removing")).toBeNull();
    expect(rowIds()).toEqual(["ci0", "ci1"]);
  });

  it("上移/下移后行顺序与后端返回一致", async () => {
    const user = userEvent.setup();
    const base = [makeItem(0), makeItem(1), makeItem(2)];
    bridge.clipboardGroup.mockResolvedValue(makeGroup(base));
    bridge.clipboardMoveGroupItem.mockImplementation(async (_id, itemId, to: number) => {
      const next = [...base];
      const from = next.findIndex((i) => i.id === itemId);
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return makeGroup(next);
    });
    render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "整理与拆分" }));
    await user.click(screen.getByRole("button", { name: "下移第 1 项" }));

    await waitFor(() => expect(bridge.clipboardMoveGroupItem).toHaveBeenCalledWith("g1", "ci0", 1));
    await waitFor(() => expect(rowIds()).toEqual(["ci1", "ci0", "ci2"]));
  });

  it("系统「减少动态」下移除立即落定，业务状态不受影响", async () => {
    const user = userEvent.setup();
    const mm = vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList);
    try {
      bridge.clipboardRemoveGroupItem.mockResolvedValue(makeGroup([makeItem(0)]));
      render(<ClipboardGroupDetail groupId="g1" {...noProps} />);
      await screen.findByText("截图集合");

      await user.click(screen.getByRole("button", { name: "从分组移除第 2 项" }));

      await waitFor(() => expect(bridge.clipboardRemoveGroupItem).toHaveBeenCalledWith("g1", "ci1"));
      await new Promise((r) => setTimeout(r, 0));
      expect(rowIds()).toEqual(["ci0"]);
      expect(document.querySelector(".removing")).toBeNull();
      expect(useUiStore.getState().toast?.message).toContain("内容仍保留在历史中");
    } finally {
      mm.mockRestore();
    }
  });

  it("连带删除分组内容时仍有条目被引用保留：不把它们从历史列表本地抹掉", async () => {
    const user = userEvent.setup();
    const group = makeGroup([makeItem(0), makeItem(1)]);
    bridge.clipboardGroup.mockResolvedValue(group);
    bridge.clipboardDeleteGroup.mockResolvedValue({
      deleted: 1,
      freed_bytes: 20,
      retained_shared: 1,
      groups_deleted: 1,
    });
    const onBack = vi.fn();
    const askAndRun = (opts: { run: () => unknown }) => {
      void opts.run();
    };
    useClipboardStore.setState({
      view: viewOf([makeItem(0), makeItem(1), makeItem(2)], [group]),
    });
    render(
      <ClipboardGroupDetail groupId="g1" {...noProps} askConfirm={askAndRun} onBack={onBack} />,
    );
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "删除分组及内容" }));

    await waitFor(() =>
      expect(bridge.clipboardDeleteGroup).toHaveBeenCalledWith("g1", true),
    );
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    const state = useClipboardStore.getState();
    // 分组已确认删除
    expect(state.view?.groups.map((g) => g.id)).toEqual([]);
    // 分不清哪条被保留，就不能本地抹掉任何一条（否则看起来像丢数据）
    expect(state.view?.items.map((i) => i.id)).toEqual(["ci0", "ci1", "ci2"]);
    expect(useUiStore.getState().toast?.message).toContain("1 条因仍被引用而保留");
  });

  it("连带删除分组内容且没有保留条目：本地立即摘掉条目与分组", async () => {
    const user = userEvent.setup();
    const group = makeGroup([makeItem(0), makeItem(1)]);
    bridge.clipboardGroup.mockResolvedValue(group);
    bridge.clipboardDeleteGroup.mockResolvedValue({
      deleted: 2,
      freed_bytes: 40,
      retained_shared: 0,
      groups_deleted: 1,
    });
    const askAndRun = (opts: { run: () => unknown }) => {
      void opts.run();
    };
    useClipboardStore.setState({
      view: viewOf([makeItem(0), makeItem(1), makeItem(2)], [group]),
    });
    render(<ClipboardGroupDetail groupId="g1" {...noProps} askConfirm={askAndRun} />);
    await screen.findByText("截图集合");

    await user.click(screen.getByRole("button", { name: "删除分组及内容" }));

    await waitFor(() =>
      expect(useClipboardStore.getState().view?.items.map((i) => i.id)).toEqual(["ci2"]),
    );
    expect(useClipboardStore.getState().view?.groups).toEqual([]);
  });
});
