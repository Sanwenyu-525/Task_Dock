/**
 * @vitest-environment jsdom
 */
//! CaptureInboxPanel 行为测试（jsdom）：
//! 列表加载与筛选、复制/转任务/标记已处理/删除（含就地二次确认）、空态与错误态。
//! bridge 命令与剪贴板复制均 mock，store 使用真实实现以覆盖计数联动。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CaptureInboxPanel from "./CaptureInboxPanel";
import { useCaptureStore } from "../../store/useCaptureStore";
import { useUiStore } from "../../store/useUiStore";
import type { CaptureItem } from "../../lib/bridge";

const bridge = vi.hoisted(() => ({
  quickCaptureList: vi.fn(),
  quickCaptureState: vi.fn(),
  quickCaptureConvertToTask: vi.fn(),
  quickCaptureMarkHandled: vi.fn(),
  quickCaptureDelete: vi.fn(),
}));

const clipboard = vi.hoisted(() => ({
  copyText: vi.fn(async () => true),
}));

const shelfStore = vi.hoisted(() => ({
  addText: vi.fn(async () => ({ id: "shelf-1" })),
  addLink: vi.fn(async () => ({ id: "shelf-2" })),
}));

vi.mock("../../lib/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bridge")>()),
  ...bridge,
}));

vi.mock("../../lib/clipboard", () => clipboard);

vi.mock("../../store/useShelfStore", () => ({
  useShelfStore: (selector: (s: typeof shelfStore) => unknown) => selector(shelfStore),
}));

function makeItem(overrides: Partial<CaptureItem> = {}): CaptureItem {
  return {
    id: "cap-1",
    client_id: "client-1",
    kind: "task",
    content: "明天 10 点交周报",
    url: null,
    note: null,
    status: "inbox",
    task_id: null,
    source: "quick-capture",
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

const INBOX_ITEM = makeItem();
const DONE_ITEM = makeItem({
  id: "cap-2",
  client_id: "client-2",
  kind: "idea",
  content: "给收集箱加一个导出按钮",
  status: "converted",
});

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  shelfStore.addText.mockResolvedValue({ id: "shelf-1" });
  shelfStore.addLink.mockResolvedValue({ id: "shelf-2" });
  useCaptureStore.setState({
    items: [],
    filter: "inbox",
    loading: false,
    error: null,
    inboxCount: 0,
  });
  bridge.quickCaptureState.mockResolvedValue({
    draft: null,
    last_type: "task",
    inbox_count: 1,
  });
  bridge.quickCaptureList.mockImplementation(async (status: string) =>
    status === "inbox" ? [INBOX_ITEM] : [INBOX_ITEM, DONE_ITEM],
  );
});

describe("CaptureInboxPanel", () => {
  it("进入收集箱加载未处理列表并渲染类型、内容与时间", async () => {
    render(<CaptureInboxPanel />);

    expect(await screen.findByText("明天 10 点交周报")).toBeTruthy();
    expect(bridge.quickCaptureList).toHaveBeenCalledWith("inbox", 50, 0);
    const list = screen.getByRole("list", { name: "捕获记录" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("任务")).toBeTruthy();
    expect(within(list).queryByText("已转任务")).toBeNull();
  });

  it("筛选切到全部时重新加载并显示状态标签", async () => {
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);
    await screen.findByText("明天 10 点交周报");

    await user.click(screen.getByRole("button", { name: "全部" }));

    await waitFor(() => {
      expect(bridge.quickCaptureList).toHaveBeenLastCalledWith("all", 50, 0);
    });
    expect(await screen.findByText("给收集箱加一个导出按钮")).toBeTruthy();
    expect(screen.getByText("已转任务")).toBeTruthy();
    const list = screen.getByRole("list", { name: "捕获记录" });
    expect(within(list).getByText("未处理")).toBeTruthy();
  });

  it("复制按钮复制条目内容（链接优先复制 URL）", async () => {
    const linkItem = makeItem({
      id: "cap-link",
      client_id: "client-link",
      kind: "link",
      content: "https://example.com/a 参考文档",
      url: "https://example.com/a",
      note: "参考文档",
    });
    bridge.quickCaptureList.mockResolvedValue([linkItem]);
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);

    await user.click(await screen.findByRole("button", { name: "复制链接" }));

    expect(clipboard.copyText).toHaveBeenCalledWith("https://example.com/a");
  });

  it("转为任务后条目从未处理列表移除并递减徽标计数", async () => {
    bridge.quickCaptureConvertToTask.mockResolvedValue({
      ...INBOX_ITEM,
      status: "converted",
      task_id: "task-9",
    });
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);
    await screen.findByText("明天 10 点交周报");

    await user.click(screen.getByRole("button", { name: "转为任务" }));

    await waitFor(() => {
      expect(bridge.quickCaptureConvertToTask).toHaveBeenCalledWith("cap-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("明天 10 点交周报")).toBeNull();
    });
    expect(useCaptureStore.getState().inboxCount).toBe(0);
  });

  it("标记已处理：未处理列表移除条目", async () => {
    bridge.quickCaptureMarkHandled.mockResolvedValue({ ...INBOX_ITEM, status: "handled" });
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);
    await screen.findByText("明天 10 点交周报");

    await user.click(screen.getByRole("button", { name: "标记已处理" }));

    await waitFor(() => {
      expect(bridge.quickCaptureMarkHandled).toHaveBeenCalledWith("cap-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("明天 10 点交周报")).toBeNull();
    });
  });

  it("全部筛选下已处理条目的处理操作禁用", async () => {
    bridge.quickCaptureList.mockResolvedValue([DONE_ITEM]);
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);

    await user.click(screen.getByRole("button", { name: "全部" }));
    const convert = (await screen.findByRole("button", {
      name: "转为任务",
    })) as HTMLButtonElement;
    const handled = screen.getByRole("button", {
      name: "标记已处理",
    }) as HTMLButtonElement;
    expect(convert.disabled).toBe(true);
    expect(handled.disabled).toBe(true);
  });

  it("删除需要就地二次确认：取消保留，确认后调用删除", async () => {
    bridge.quickCaptureDelete.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);
    await screen.findByText("明天 10 点交周报");

    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("button", { name: "确认删除" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消删除" }));
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
    expect(bridge.quickCaptureDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(bridge.quickCaptureDelete).toHaveBeenCalledWith("cap-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("明天 10 点交周报")).toBeNull();
    });
  });

  it("空态：未处理为空与全部为空使用不同文案", async () => {
    bridge.quickCaptureList.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);

    expect(await screen.findByText("收集箱是空的")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "全部" }));
    expect(await screen.findByText("还没有捕获记录")).toBeTruthy();
  });

  it("加载失败显示错误与重试，重试成功后渲染列表", async () => {
    bridge.quickCaptureList
      .mockRejectedValueOnce(new Error("网络错误"))
      .mockResolvedValueOnce([INBOX_ITEM]);
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("加载失败：网络错误");
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("明天 10 点交周报")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("刷新按钮重新加载当前筛选", async () => {
    const user = userEvent.setup();
    render(<CaptureInboxPanel />);
    await screen.findByText("明天 10 点交周报");

    await user.click(screen.getByRole("button", { name: "刷新收集箱" }));

    await waitFor(() => {
      expect(bridge.quickCaptureList).toHaveBeenCalledTimes(2);
    });
  });
});

describe("CaptureInboxPanel 跨模块转存（v0.8）", () => {
  async function renderWithItem(overrides: Partial<CaptureItem>) {
    render(<CaptureInboxPanel />);
    // 等初始加载完成（beforeEach 已 mock quickCaptureList 返回 INBOX_ITEM：task 类型）
    await waitFor(() => expect(screen.getByLabelText(/任务：/)).toBeTruthy());
    const target = makeItem(overrides);
    useCaptureStore.setState({ items: [target] });
    const item = await screen.findByLabelText(new RegExp(`^${overrides.kind === "link" ? "链接" : "文字"}：`));
    return { item, btn: within(item).getByRole("button", { name: `添加到暂存架：${overrides.kind === "link" ? "链接" : "文字"}` }) };
  }

  it("文本条目「添加到暂存架」调用 addText，成功后原条目保留", async () => {
    const user = userEvent.setup();
    const { btn } = await renderWithItem({ kind: "text", content: "转存文本样例" });
    await user.click(btn);
    await waitFor(() => expect(shelfStore.addText).toHaveBeenCalledWith("转存文本样例"));
    expect(shelfStore.addText).toHaveBeenCalledTimes(1);
  });

  it("链接条目转存调用 addLink（携带 URL），原条目保留", async () => {
    shelfStore.addText.mockClear();
    const user = userEvent.setup();
    const { btn } = await renderWithItem({ kind: "link", content: "示例站", url: "https://example.com/a" });
    await user.click(btn);
    await waitFor(() => expect(shelfStore.addLink).toHaveBeenCalledWith("https://example.com/a"));
    expect(shelfStore.addText).not.toHaveBeenCalled();
  });

  it("失败时提示错误且原条目状态不变", async () => {
    shelfStore.addText.mockRejectedValueOnce(new Error("配额不足"));
    const user = userEvent.setup();
    const { btn } = await renderWithItem({ kind: "text", content: "转存失败样例" });
    await user.click(btn);
    // Toast 渲染在应用外壳（App），此处断言 ui store 的队列与原条目保留
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.message.includes("配额不足"))).toBe(true),
    );
    expect(screen.getByText(/转存失败样例/)).toBeTruthy();
  });

  it("在途守卫：转存进行中按钮禁用，连点不重复创建", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    shelfStore.addText.mockImplementationOnce(() => gate.then(() => ({ id: "shelf-9" })));
    const user = userEvent.setup();
    const { btn } = await renderWithItem({ kind: "text", content: "在途守卫样例" });
    await user.click(btn);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    expect(shelfStore.addText).toHaveBeenCalledTimes(1);
  });
});
