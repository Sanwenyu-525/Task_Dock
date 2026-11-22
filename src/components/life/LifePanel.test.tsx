/**
 * @vitest-environment jsdom
 */
//! 生活页（A06）页面级结构与交互测试：
//! - 响应式原语接入标记（.ui-page-frame / .ui-toolbar-row / .ui-adaptive-grid）；
//! - 搜索输入受控，关键词经防抖后进入查询；
//! - 记录 ↔ 详情子区块切换后主区块内容与筛选保留；
//! - 列表行内金额、票据状态徽标、提醒时间等关键节点结构存在。
//!
//! 边界：jsdom 不计算真实 CSS 布局，这里只断言类名 / ARIA / 节点结构与受控输入行为，
//! 不断言列宽、换行或可见性等布局结论；后端命令全部 mock，store 用真实实例。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  lifeDocumentLinkGet,
  lifeDocumentLinkDelete,
  lifeDocumentLinksList,
  lifeEventDetail,
  lifeEventsRecent,
  lifeItemHistory,
  lifeItemsList,
  lifeOverview,
  type LifeDocumentLink,
  type LifeEventDetail,
  type LifeEventItem,
  type LifeEventSummary,
  type LifeItemHistory,
  type LifeItemSummary,
  type LifeOverview,
} from "../../lib/lifeBridge";
import { listTasks, mobileFileReveal, type Task } from "../../lib/bridge";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import LifePanel, { receiptStateInfo } from "./LifePanel";

vi.mock("../../lib/lifeBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/lifeBridge")>();
  return {
    ...actual,
    lifeItemsList: vi.fn(async () => []),
    lifeItemHistory: vi.fn(async () => null),
    lifeEventsRecent: vi.fn(async () => []),
    lifeEventDetail: vi.fn(async () => null),
    lifeEventCreate: vi.fn(),
    lifeEventUpdate: vi.fn(),
    lifeEventDelete: vi.fn(),
    lifeOverview: vi.fn(async () => null),
    lifeDocumentLinkCreate: vi.fn(),
    lifeDocumentLinkDelete: vi.fn(async () => undefined),
    lifeDocumentLinksList: vi.fn(async () => []),
    lifeDocumentLinkGet: vi.fn(async () => null),
  };
});

vi.mock("../../lib/bridge", () => ({
  listTasks: vi.fn(async () => []),
  shelfList: vi.fn(async () => ({ items: [] })),
  shelfGetItem: vi.fn(),
  shelfOpenItem: vi.fn(),
  mobileFileReveal: vi.fn(async () => undefined),
  toggleTask: vi.fn(),
}));

vi.mock("../shelf/ShelfImageLightbox", () => ({
  default: () => null,
}));

const ITEM: LifeItemSummary = {
  id: "item-1",
  name: "大米",
  normalized_name: "大米",
  category: "主食",
  note: "",
  aliases: [],
  purchase_count: 3,
  last_purchase_at: "2026-11-10T08:00:00.000Z",
  last_quantity_value: "5",
  last_quantity_unit: "kg",
  last_unit_price_minor: null,
  last_total_price_minor: 4800,
  last_currency: "CNY",
  last_amount_scale: 2,
  interval_days: 12,
  updated_at: "2026-11-10T08:00:00.000Z",
};

const LINK: LifeDocumentLink = {
  id: "link-1",
  owner_type: "event",
  owner_id: "ev-1",
  document_ref: "shelf-1",
  document_source: "shelf_item",
  document_name: "购物小票.jpg",
  mime: "",
  byte_size: 1024,
  remote_ref: null,
  remote_source: null,
  transfer_state: "local",
  created_at: "2026-11-10T08:00:00.000Z",
  updated_at: "2026-11-10T08:00:00.000Z",
};

const EVENT: LifeEventSummary = {
  id: "ev-1",
  event_type: "purchase",
  title: "",
  description: "",
  occurred_at: "2026-11-10T08:00:00.000Z",
  merchant: "超市",
  item_names: ["大米"],
  total_price_minor: 4800,
  currency: "CNY",
  amount_scale: 2,
  totals: [
    { currency: "CNY", amount_scale: 2, total_price_minor: 4800, item_count: 1 },
  ],
  link_count: 1,
};

const OVERVIEW: LifeOverview = {
  item_count: 1,
  purchase_count: 3,
  receipt_count: 1,
  purchases_last_30_days: 2,
};

const TASK: Task = {
  id: "task-1",
  title: "交水电费",
  description: "",
  priority: 2,
  status: "pending",
  category: "生活",
  tags: [],
  due_at: "2026-11-20T00:00:00.000Z",
  remind_at: null,
  advance_minutes: 30,
  recurrence: null,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  completed_at: null,
  linked_agents: 0,
};

const EVENT_DETAIL: LifeEventDetail = {
  event: {
    id: "ev-1",
    event_type: "purchase",
    title: "大米",
    description: "",
    occurred_at: "2026-11-10T08:00:00.000Z",
    merchant: "超市",
    source: "manual",
    created_at: "2026-11-10T08:00:00.000Z",
    updated_at: "2026-11-10T08:00:00.000Z",
  },
  items: [
    {
      id: "ei-1",
      event_id: "ev-1",
      item_id: "item-1",
      item_name_snapshot: "大米",
      quantity_value: "5",
      quantity_unit: "kg",
      unit_price_minor: null,
      total_price_minor: 4800,
      currency: "CNY",
      amount_scale: 2,
      note: "",
    },
  ],
  links: [LINK],
};

const HISTORY: LifeItemHistory = {
  item: ITEM,
  purchases: [
    {
      event_id: "ev-1",
      item_row_id: "row-1",
      occurred_at: "2026-11-10T08:00:00.000Z",
      created_at: "2026-11-10T08:00:00.000Z",
      item_name: "大米",
      quantity_value: "5",
      quantity_unit: "kg",
      unit_price_minor: null,
      total_price_minor: 4800,
      currency: "CNY",
      amount_scale: 2,
      merchant: "超市",
      note: "",
      event_note: "",
      links: [LINK],
    },
  ],
  total_count: 1,
};

function seed() {
  vi.mocked(lifeItemsList).mockResolvedValue([ITEM]);
  vi.mocked(lifeOverview).mockResolvedValue(OVERVIEW);
  vi.mocked(lifeEventsRecent).mockResolvedValue([EVENT]);
  vi.mocked(lifeDocumentLinksList).mockResolvedValue([LINK]);
  vi.mocked(listTasks).mockResolvedValue([TASK]);
  vi.mocked(lifeEventDetail).mockResolvedValue(EVENT_DETAIL);
  vi.mocked(lifeItemHistory).mockResolvedValue(HISTORY);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: null });
  useGlobalSearchStore.setState({ pendingLocate: null });
  useUiStore.setState({ showToast: vi.fn(), openEditor: vi.fn() });
  // clearAllMocks 只清调用记录、不清实现：逐项恢复默认值，避免上一个用例的
  // mockResolvedValue（例如“票据已解除”）泄漏到下一个用例。
  vi.mocked(lifeDocumentLinkGet).mockResolvedValue(null);
  vi.mocked(lifeDocumentLinkDelete).mockResolvedValue(undefined);
  vi.mocked(mobileFileReveal).mockResolvedValue(undefined);
  seed();
});

afterEach(() => {
  cleanup();
});

describe("LifePanel 生活页（A06 响应式）", () => {
  it("根节点接入页面查询容器，工具栏与统计卡片使用共享原语", async () => {
    render(<LifePanel />);

    const root = document.querySelector(".life-panel");
    expect(root).not.toBeNull();
    expect(root?.classList.contains("ui-page-frame")).toBe(true);

    const head = document.querySelector(".life-head");
    expect(head?.classList.contains("ui-toolbar-row")).toBe(true);
    expect(document.querySelector(".life-head .ui-toolbar-spacer")).not.toBeNull();

    const stats = document.querySelector(".life-stats");
    expect(stats?.classList.contains("ui-adaptive-grid")).toBe(true);

    // 默认侧栏为商品列表，ARIA 标记随视图切换。
    await screen.findAllByText("大米");
    expect(screen.getByLabelText("商品列表")).not.toBeNull();
  });

  it("搜索输入受控：键入后输入框回显，防抖后按关键词查询", async () => {
    render(<LifePanel />);
    await screen.findAllByText("大米");

    const search = screen.getByLabelText("搜索商品或购买记录") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "大米" } });
    expect(search.value).toBe("大米");

    await waitFor(() => {
      expect(lifeItemsList).toHaveBeenCalledWith(expect.objectContaining({ query: "大米" }));
    });
  });

  it("记录切换到详情后主区块与筛选保留，详情面板带可关闭标识", async () => {
    render(<LifePanel />);
    await screen.findAllByText("大米");
    const search = (await screen.findByLabelText("搜索商品或购买记录")) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "大米" } });

    const eventRow = await waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>(".life-event-row");
      expect(row).not.toBeNull();
      return row as HTMLButtonElement;
    });
    fireEvent.click(eventRow);

    const aside = await screen.findByLabelText("生活详情");
    expect(aside).not.toBeNull();
    expect(lifeEventDetail).toHaveBeenCalledWith("ev-1");

    // 主区块三个分组标题仍在，筛选关键词未被切换清掉。
    expect(screen.getByRole("heading", { name: "最近购买" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "生活待办" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "票据资料" })).not.toBeNull();
    expect((screen.getByLabelText("搜索商品或购买记录") as HTMLInputElement).value).toBe("大米");

    const closeBtn = screen.getByRole("button", { name: "关闭详情" });
    expect(closeBtn).not.toBeNull();
  });

  it("列表行保留金额、票据状态徽标与提醒时间等关键节点（结构标记）", async () => {
    render(<LifePanel />);
    await screen.findAllByText("大米");

    // 最近购买行：日期 / 标题 / 金额节点共存，金额节点不被打隐藏标记。
    const eventRow = document.querySelector(".life-event-row");
    expect(eventRow?.querySelector(".life-event-date")).not.toBeNull();
    expect(eventRow?.querySelector(".life-event-title")).not.toBeNull();
    expect(eventRow?.querySelector(".life-event-amount")).not.toBeNull();

    // 票据行：文件名 + 状态徽标共存。
    const receiptRow = document.querySelector(".life-receipt-row");
    expect(receiptRow?.querySelector(".life-receipt-name")).not.toBeNull();
    expect(receiptRow?.querySelector(".life-chip")).not.toBeNull();

    // 提醒行：勾选按钮 / 标题 / 时间节点共存。
    const taskRow = document.querySelector(".life-task-list li");
    expect(taskRow?.querySelector(".life-task-check")).not.toBeNull();
    expect(taskRow?.querySelector(".life-task-title")).not.toBeNull();
    expect(taskRow?.querySelector(".life-task-time")).not.toBeNull();
  });

  it("多币种事件按币种分行展示，绝不合并成一个总额", async () => {
    const mixed: LifeEventSummary = {
      ...EVENT,
      id: "ev-mixed",
      title: "混币购买",
      total_price_minor: null,
      currency: "",
      totals: [
        { currency: "CNY", amount_scale: 2, total_price_minor: 10_000, item_count: 1 },
        { currency: "USD", amount_scale: 2, total_price_minor: 10_000, item_count: 1 },
      ],
    };
    vi.mocked(lifeEventsRecent).mockResolvedValue([mixed]);
    render(<LifePanel />);
    await waitFor(() => {
      const amount = document.querySelector(".life-event-amount");
      expect(amount?.textContent).toContain("100.00 CNY");
      expect(amount?.textContent).toContain("100.00 USD");
      expect(amount?.textContent).not.toContain("200.00");
    });
    // 两行结构：金额节点文本包含换行，CSS 以 pre-line 渲染。
    expect(document.querySelector(".life-event-amount")?.textContent).toBe(
      "100.00 CNY\n100.00 USD",
    );
  });
});

// ── 详情状态隔离、票据定位与票据状态展示 ────────────────────
//
// 这组用例锁住三个真实缺陷：
// 1. 切换商品/事件时旧实体的关联票据不得残留（曾经 itemLinks 与 event.links 混拼）；
// 2. 旧请求（成功或失败）不得覆盖/关闭用户后打开的新详情；
// 3. 票据状态必须结合 remote_ref/remote_source 判断，不能只看 transfer_state。

const ITEM_A: LifeItemSummary = { ...ITEM, id: "item-a", name: "大米" };
const ITEM_B: LifeItemSummary = { ...ITEM, id: "item-b", name: "牛奶", category: "饮品" };
const LINK_A: LifeDocumentLink = {
  ...LINK,
  id: "link-a",
  owner_type: "item",
  owner_id: "item-a",
  document_name: "大米小票.jpg",
};
const LINK_B1: LifeDocumentLink = {
  ...LINK,
  id: "link-b1",
  owner_type: "event",
  owner_id: "ev-b",
  document_name: "整单小票.jpg",
};
const LINK_B2: LifeDocumentLink = {
  ...LINK,
  id: "link-b2",
  owner_type: "item",
  owner_id: "item-b",
  document_name: "牛奶小票.jpg",
};
const EVENT_A: LifeEventSummary = { ...EVENT, id: "ev-a", title: "大米", item_names: ["大米"] };
const EVENT_B: LifeEventSummary = {
  ...EVENT,
  id: "ev-b",
  title: "牛奶",
  merchant: "便利店",
  item_names: ["牛奶"],
  link_count: 2,
};
const EVENT_ITEM_B: LifeEventItem = {
  id: "ei-b",
  event_id: "ev-b",
  item_id: "item-b",
  item_name_snapshot: "牛奶",
  quantity_value: "2",
  quantity_unit: "盒",
  unit_price_minor: null,
  total_price_minor: 2000,
  currency: "CNY",
  amount_scale: 2,
  note: "",
};

function eventDetailOf(
  summary: LifeEventSummary,
  items: LifeEventItem[],
  links: LifeDocumentLink[],
): LifeEventDetail {
  return {
    event: {
      id: summary.id,
      event_type: "purchase",
      title: summary.title,
      description: "",
      occurred_at: summary.occurred_at,
      merchant: summary.merchant,
      source: "manual",
      created_at: summary.occurred_at,
      updated_at: summary.occurred_at,
    },
    items,
    links,
  };
}

function historyOf(item: LifeItemSummary, links: LifeDocumentLink[] = []): LifeItemHistory {
  return {
    item,
    purchases: [
      {
        event_id: `ev-${item.id}`,
        item_row_id: `row-${item.id}`,
        occurred_at: item.last_purchase_at ?? "2026-11-10T08:00:00.000Z",
        created_at: "2026-11-10T08:00:00.000Z",
        item_name: item.name,
        quantity_value: null,
        quantity_unit: "",
        unit_price_minor: null,
        total_price_minor: null,
        currency: "",
        amount_scale: 2,
        merchant: "",
        note: "",
        event_note: "",
        links,
      },
    ],
    total_count: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function findRow(selector: string, text: string): Promise<HTMLButtonElement> {
  return await waitFor(() => {
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find((element) =>
      element.textContent?.includes(text),
    );
    if (!row) throw new Error(`未找到 ${selector} 中包含「${text}」的行`);
    return row;
  });
}

function detailTitle(): string | null {
  return document.querySelector(".life-detail h2")?.textContent ?? null;
}

describe("LifePanel 详情状态隔离", () => {
  it("商品 A → 事件 B：商品票据不会串到事件详情", async () => {
    vi.mocked(lifeItemsList).mockResolvedValue([ITEM_A, ITEM_B]);
    vi.mocked(lifeEventsRecent).mockResolvedValue([EVENT_B]);
    vi.mocked(lifeDocumentLinksList).mockImplementation(async (_ownerType, ownerId) =>
      ownerId === "item-a" ? [LINK_A] : [],
    );
    vi.mocked(lifeEventDetail).mockResolvedValue(
      eventDetailOf(EVENT_B, [EVENT_ITEM_B], [LINK_B1, LINK_B2]),
    );
    render(<LifePanel />);

    fireEvent.click(await findRow(".life-item-row", "大米"));
    await waitFor(() => expect(document.body.textContent).toContain("大米小票.jpg"));
    expect(detailTitle()).toBe("大米");

    fireEvent.click(await findRow(".life-event-row", "牛奶"));
    await waitFor(() => expect(document.body.textContent).toContain("整单小票.jpg"));

    expect(detailTitle()).toBe("牛奶");
    expect(document.body.textContent).toContain("牛奶小票.jpg");
    expect(document.body.textContent).toContain("商品票据 · 牛奶");
    // 上一个商品的票据既不在事件票据区，也不得出现在任何其它位置。
    expect(document.body.textContent).not.toContain("大米小票.jpg");
  });

  it("商品 A → 商品 B：旧请求晚返回不得覆盖新详情", async () => {
    const slowA = deferred<LifeItemHistory>();
    vi.mocked(lifeItemsList).mockResolvedValue([ITEM_A, ITEM_B]);
    vi.mocked(lifeDocumentLinksList).mockResolvedValue([]);
    vi.mocked(lifeItemHistory).mockImplementation((itemId) =>
      itemId === "item-a" ? slowA.promise : Promise.resolve(historyOf(ITEM_B)),
    );
    render(<LifePanel />);

    fireEvent.click(await findRow(".life-item-row", "大米"));
    fireEvent.click(await findRow(".life-item-row", "牛奶"));
    await waitFor(() => expect(detailTitle()).toBe("牛奶"));

    slowA.resolve(historyOf(ITEM_A));
    // 让晚到的 Promise 完成后再断言。
    await waitFor(() => expect(detailTitle()).toBe("牛奶"));
    expect(document.querySelector(".life-detail")?.textContent).not.toContain("大米");
  });

  it("事件 A → 事件 B：旧请求失败不得关闭新详情", async () => {
    const slowA = deferred<LifeEventDetail>();
    vi.mocked(lifeEventsRecent).mockResolvedValue([EVENT_A, EVENT_B]);
    vi.mocked(lifeEventDetail).mockImplementation((eventId) =>
      eventId === "ev-a"
        ? slowA.promise
        : Promise.resolve(eventDetailOf(EVENT_B, [EVENT_ITEM_B], [LINK_B1])),
    );
    render(<LifePanel />);

    fireEvent.click(await findRow(".life-event-row", "大米"));
    fireEvent.click(await findRow(".life-event-row", "牛奶"));
    await waitFor(() => expect(detailTitle()).toBe("牛奶"));

    slowA.reject(new Error("读取失败"));
    await waitFor(() => expect(document.body.textContent).toContain("整单小票.jpg"));
    expect(detailTitle()).toBe("牛奶");
    // 旧请求的失败不得弹错、不得把详情关掉。
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("生活详情")).not.toBeNull();
  });
});

describe("LifePanel 全局搜索票据定位", () => {
  it("事件级票据：用 parentId 读关联并按 owner_type 打开事件", async () => {
    vi.mocked(lifeEventsRecent).mockResolvedValue([EVENT_B]);
    vi.mocked(lifeDocumentLinkGet).mockResolvedValue(LINK_B1);
    vi.mocked(lifeEventDetail).mockResolvedValue(
      eventDetailOf(EVENT_B, [EVENT_ITEM_B], [LINK_B1, LINK_B2]),
    );
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "life",
        id: "ev-b",
        kind: "life_receipt",
        parentId: "link-b1",
        workspaceProjectId: null,
        keyword: "小票",
        token: 41,
      },
    });
    render(<LifePanel />);

    await waitFor(() => expect(lifeEventDetail).toHaveBeenCalledWith("ev-b"));
    const focused = document.querySelector(".life-link-row.is-focused");
    expect(focused?.textContent).toContain("整单小票.jpg");
    expect(detailTitle()).toBe("牛奶");
    // 一次性意图必须被消费，刷新页面不会重复定位。
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();
  });

  it("商品级票据：owner_type=item 时打开商品历史", async () => {
    vi.mocked(lifeItemsList).mockResolvedValue([ITEM_A]);
    vi.mocked(lifeDocumentLinkGet).mockResolvedValue(LINK_A);
    vi.mocked(lifeDocumentLinksList).mockResolvedValue([LINK_A]);
    vi.mocked(lifeItemHistory).mockResolvedValue(historyOf(ITEM_A, []));
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "life",
        id: "item-a",
        kind: "life_receipt",
        parentId: "link-a",
        workspaceProjectId: null,
        keyword: "小票",
        token: 42,
      },
    });
    render(<LifePanel />);

    await waitFor(() =>
      expect(lifeItemHistory).toHaveBeenCalledWith("item-a", 50),
    );
    expect(lifeEventDetail).not.toHaveBeenCalled();
    const focused = document.querySelector(".life-link-row.is-focused");
    expect(focused?.textContent).toContain("大米小票.jpg");
    expect(detailTitle()).toBe("大米");
  });

  it("关联已解除时明确提示，不回退猜 owner", async () => {
    vi.mocked(lifeDocumentLinkGet).mockResolvedValue(null);
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "life",
        id: "item-a",
        kind: "life_receipt",
        parentId: "link-gone",
        workspaceProjectId: null,
        keyword: "小票",
        token: 43,
      },
    });
    render(<LifePanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("已被解除");
    expect(lifeItemHistory).not.toHaveBeenCalled();
    expect(lifeEventDetail).not.toHaveBeenCalled();
  });
});

describe("LifePanel 票据解除与状态展示", () => {
  it("解除关联只删除当前详情里被点击的那一条", async () => {
    vi.mocked(lifeEventsRecent).mockResolvedValue([EVENT_B]);
    vi.mocked(lifeEventDetail).mockResolvedValue(
      eventDetailOf(EVENT_B, [EVENT_ITEM_B], [LINK_B1, LINK_B2]),
    );
    render(<LifePanel />);

    fireEvent.click(await findRow(".life-event-row", "牛奶"));
    await waitFor(() => expect(document.body.textContent).toContain("整单小票.jpg"));

    const row = await waitFor(() => {
      const found = Array.from(document.querySelectorAll(".life-link-row")).find((element) =>
        element.textContent?.includes("整单小票.jpg"),
      );
      if (!found) throw new Error("未找到目标票据行");
      return found;
    });
    const removeButton = Array.from(row.querySelectorAll("button")).find(
      (button) => button.textContent === "解除",
    );
    expect(removeButton).toBeTruthy();
    fireEvent.click(removeButton as HTMLButtonElement);

    await waitFor(() => expect(lifeDocumentLinkDelete).toHaveBeenCalledWith("link-b1"));
    expect(lifeDocumentLinkDelete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.body.textContent).not.toContain("整单小票.jpg"));
    // 同一详情里的其它票据、以及商品本身都不受影响。
    expect(document.body.textContent).toContain("牛奶小票.jpg");
    expect(detailTitle()).toBe("牛奶");
  });

  it("remote_source=file：显示“已到电脑 · 待导入”并提供定位，不谎称未传输", async () => {
    const fileLink: LifeDocumentLink = {
      ...LINK,
      id: "link-file",
      document_source: "capture_asset",
      document_name: "手机小票.jpg",
      remote_ref: "mf-1",
      remote_source: "file",
      transfer_state: "metadata_only",
    };
    vi.mocked(lifeDocumentLinksList).mockResolvedValue([fileLink]);
    render(<LifePanel />);

    const row = await findRow(".life-receipt-row", "手机小票.jpg");
    expect(row.textContent).toContain("已到电脑 · 待导入");
    expect(row.textContent).not.toContain("待传输");
    expect(row.textContent).not.toContain("仅元数据同步");

    fireEvent.click(row);
    await waitFor(() => expect(mobileFileReveal).toHaveBeenCalledWith("mf-1"));
  });
});

describe("receiptStateInfo 状态映射", () => {
  const base: LifeDocumentLink = { ...LINK };

  it("本机文件 / 仅元数据 / 已导入暂存架 / 缺失", () => {
    expect(
      receiptStateInfo({ ...base, document_source: "shelf_item", transfer_state: "local" }).label,
    ).toBe("本机文件");
    expect(
      receiptStateInfo({ ...base, document_source: "capture_asset", transfer_state: "local" }).label,
    ).toBe("仅元数据同步");
    expect(
      receiptStateInfo({
        ...base,
        remote_ref: "si-1",
        remote_source: "shelf_item",
        transfer_state: "transferred",
      }).label,
    ).toBe("已导入暂存架");
    expect(receiptStateInfo({ ...base, transfer_state: "missing" }).label).toBe("原始文件缺失");
  });

  it("已传输但缺远端引用暴露为异常，不再伪装成待传输", () => {
    const state = receiptStateInfo({
      ...base,
      document_source: "capture_asset",
      transfer_state: "transferred",
      remote_ref: null,
    });
    expect(state.label).toBe("状态异常 · 缺少远端引用");
    expect(state.action).toBe("pending");
  });

  it("file 远端引用走文件互传定位，shelf_item 远端引用走暂存架预览", () => {
    const file = receiptStateInfo({
      ...base,
      remote_ref: "mf-1",
      remote_source: "file",
      transfer_state: "metadata_only",
    });
    expect(file).toMatchObject({ action: "mobile_file", mobileFileId: "mf-1", shelfRef: null });
    const shelf = receiptStateInfo({
      ...base,
      remote_ref: "si-1",
      remote_source: "shelf_item",
      transfer_state: "transferred",
    });
    expect(shelf).toMatchObject({ action: "shelf", shelfRef: "si-1", mobileFileId: null });
  });
});
