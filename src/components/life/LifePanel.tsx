//! 桌面端「生活」页：购买记录、购买历史、生活待办、票据资料。
//!
//! 边界：
//! - 生活待办**不新建任务表**：读取既有 `tasks`（分类=生活），新增走既有任务编辑器；
//! - 票据只保存引用；原图为手机采集素材且尚未传输到电脑时明确提示，不伪造预览；
//! - 所有查询都来自真实 SQLite；无记录时显示「尚无购买记录」，不展示示例数据；
//! - 宽/中/窄窗口分别使用双栏、窄双栏、单栏，不引入页面级固定宽度。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronRight,
  FileImage,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  ShoppingBasket,
  Trash2,
  X,
} from "lucide-react";

import {
  lifeDocumentLinkCreate,
  lifeDocumentLinkDelete,
  lifeDocumentLinkGet,
  lifeDocumentLinksList,
  lifeEventCreate,
  lifeEventDelete,
  lifeEventDetail,
  lifeEventUpdate,
  lifeEventsRecent,
  lifeItemHistory,
  lifeItemsList,
  lifeOverview,
  formatLifeDate,
  formatMoneyMinor,
  type LifeCurrencyTotal,
  type LifeDocumentLink,
  type LifeEventDetail,
  type LifeEventInput,
  type LifeEventSummary,
  type LifeItemHistory,
  type LifeItemSummary,
  type LifeOverview,
} from "../../lib/lifeBridge";
import {
  listTasks,
  mobileFileReveal,
  shelfGetItem,
  shelfList,
  shelfOpenItem,
  toggleTask,
  type ShelfItem,
  type Task,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog, Dialog, SearchField, Select } from "../ui";
import ShelfImageLightbox from "../shelf/ShelfImageLightbox";
import "./life-ui.css";

const LIFE_CATEGORY = "生活";
const CURRENCY_OPTIONS = [
  { value: "CNY", label: "CNY 人民币" },
  { value: "USD", label: "USD 美元" },
  { value: "EUR", label: "EUR 欧元" },
  { value: "JPY", label: "JPY 日元" },
  { value: "GBP", label: "GBP 英镑" },
  { value: "HKD", label: "HKD 港币" },
  { value: "KWD", label: "KWD 科威特第纳尔（3 位小数）" },
];

/** 单条记录金额展示：单币种一行；多币种逐行列出，绝不把不同货币合成一个数。 */
function eventAmountText(event: LifeEventSummary): string {
  const totals: LifeCurrencyTotal[] = event.totals ?? [];
  if (totals.length > 0) {
    return totals
      .map((total) => {
        const amount = formatMoneyMinor(total.total_price_minor, total.currency, total.amount_scale);
        return total.currency ? amount : `未标注货币 ${amount}`;
      })
      .join("\n");
  }
  return formatMoneyMinor(event.total_price_minor, event.currency, event.amount_scale) || "未记金额";
}

/** 输入提示随所选货币的 ISO 精度变化，避免 KWD/JPY 被固定文案误导。 */
function currencyMaxScale(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (code === "JPY") return 0;
  if (code === "KWD") return 3;
  return 2;
}

/** 票据在桌面端可执行的动作。`pending` = 原图还不在本机，任何“打开”都会说谎。 */
export type ReceiptAction = "shelf" | "mobile_file" | "pending" | "missing" | "unsupported";

export interface ReceiptState {
  /** 徽标文案：描述文件现在真实在哪，不只看 transfer_state。 */
  label: string;
  /** 复用既有 life-chip 色调类，不新增平行视觉机制。 */
  tone: "local" | "transferred" | "metadata_only" | "missing";
  action: ReceiptAction;
  /** 桌面端可直接打开的暂存架条目 id。 */
  shelfRef: string | null;
  /** 文件互传记录 id（文件已到电脑，但尚未导入暂存架）。 */
  mobileFileId: string | null;
}

/**
 * 票据状态判定。
 *
 * `transfer_state` 只说明“同步到哪一步”，不能单独决定展示：
 * - `remote_source=shelf_item`：原图已导入桌面暂存架，可直接预览；
 * - `remote_source=file`：文件已到电脑（文件互传接收目录），但**尚未导入暂存架**，
 *   不能再显示“原图尚未传输”，只能定位文件并提示导入；
 * - `document_source=shelf_item` 且无远端引用：桌面自己选的暂存架文件；
 * - `document_source=capture_asset` 且无远端引用：只有元数据同步，原图仍在手机。
 */
export function receiptStateInfo(link: LifeDocumentLink): ReceiptState {
  const remoteRef = (link.remote_ref ?? "").trim();
  const docRef = (link.document_ref ?? "").trim();
  if (link.transfer_state === "missing") {
    return {
      label: "原始文件缺失",
      tone: "missing",
      action: "missing",
      shelfRef: null,
      mobileFileId: null,
    };
  }
  if (remoteRef && link.remote_source === "shelf_item") {
    return {
      label: "已导入暂存架",
      tone: "transferred",
      action: "shelf",
      shelfRef: remoteRef,
      mobileFileId: null,
    };
  }
  if (remoteRef && link.remote_source === "file") {
    return {
      label: "已到电脑 · 待导入",
      tone: "metadata_only",
      action: "mobile_file",
      shelfRef: null,
      mobileFileId: remoteRef,
    };
  }
  if (link.transfer_state === "transferred") {
    // 数据库里不该出现：transferred 必须带 remote_ref（B2 已禁止裸创建）。
    // 展示成异常而不是“待传输”，避免把损坏状态伪装成正常流程。
    return {
      label: "状态异常 · 缺少远端引用",
      tone: "missing",
      action: "pending",
      shelfRef: null,
      mobileFileId: null,
    };
  }
  if (link.document_source === "shelf_item") {
    return {
      label: "本机文件",
      tone: "local",
      action: "shelf",
      shelfRef: docRef,
      mobileFileId: null,
    };
  }
  if (link.document_source === "capture_asset") {
    return {
      label: "仅元数据同步",
      tone: "metadata_only",
      action: "pending",
      shelfRef: null,
      mobileFileId: null,
    };
  }
  if (link.document_source === "file") {
    return {
      label: "本机文件引用",
      tone: "local",
      action: "unsupported",
      shelfRef: null,
      mobileFileId: null,
    };
  }
  return {
    label: "任务附件",
    tone: "local",
    action: "unsupported",
    shelfRef: null,
    mobileFileId: null,
  };
}

/** 详情数据与它的关联票据是一个整体：切换实体时一起失效，不保留上一实体的任何字段。 */
type DetailState =
  | {
      kind: "item";
      id: string;
      item: LifeItemHistory | null;
      links: LifeDocumentLink[];
      /** 全局搜索定位到某张票据时高亮该行。 */
      focusLinkId: string | null;
    }
  | {
      kind: "event";
      id: string;
      event: LifeEventDetail | null;
      links: LifeDocumentLink[];
      focusLinkId: string | null;
    };

interface PurchaseForm {
  mode: "create" | "edit";
  eventId: string | null;
  name: string;
  category: string;
  date: string;
  quantity: string;
  unit: string;
  total: string;
  currency: string;
  /** 编辑历史行时沿用原金额小数位；新建或切换货币后为 null。 */
  amountScale: number | null;
  merchant: string;
  note: string;
  receiptId: string;
}

function todayLocal(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function minorToDecimalText(minor: number, scale: number): string {
  const safeScale = Number.isInteger(scale) && scale >= 0 && scale <= 3 ? scale : 2;
  const factor = 10 ** safeScale;
  const whole = Math.floor(minor / factor);
  if (safeScale === 0) return String(whole);
  const fraction = String(minor % factor).padStart(safeScale, "0");
  return `${whole}.${fraction}`;
}

function emptyForm(currency: string): PurchaseForm {
  return {
    mode: "create",
    eventId: null,
    name: "",
    category: "",
    date: todayLocal(),
    quantity: "",
    unit: "",
    total: "",
    currency,
    amountScale: null,
    merchant: "",
    note: "",
    receiptId: "",
  };
}

export default function LifePanel() {
  const settings = useSettingsStore((s) => s.settings);
  const showToast = useUiStore((s) => s.showToast);
  const openTaskEditor = useUiStore((s) => s.openEditor);

  const defaultCurrency = (settings?.life_default_currency ?? "").trim().toUpperCase();

  const [items, setItems] = useState<LifeItemSummary[]>([]);
  const [overview, setOverview] = useState<LifeOverview | null>(null);
  const [events, setEvents] = useState<LifeEventSummary[]>([]);
  const [links, setLinks] = useState<LifeDocumentLink[]>([]);
  const [lifeTasks, setLifeTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [detail, setDetail] = useState<DetailState | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [form, setForm] = useState<PurchaseForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LifeEventSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<{ type: "event" | "item"; id: string; label: string } | null>(null);
  const [shelfChoices, setShelfChoices] = useState<ShelfItem[]>([]);
  const [shelfChoiceId, setShelfChoiceId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [receiptLoadError, setReceiptLoadError] = useState<string | null>(null);

  const [previewShelf, setPreviewShelf] = useState<ShelfItem | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const requestSeq = useRef(0);
  const detailSeq = useRef(0);

  const loadAll = useCallback(async (search: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [nextItems, nextOverview, nextEvents, nextLinks, nextTasks] = await Promise.all([
        lifeItemsList({ query: search || null, limit: 60 }),
        lifeOverview(),
        lifeEventsRecent(20, "purchase"),
        lifeDocumentLinksList(null, null),
        listTasks({ category: LIFE_CATEGORY, limit: 30 }),
      ]);
      if (seq !== requestSeq.current) return;
      setItems(nextItems);
      setOverview(nextOverview);
      setEvents(nextEvents);
      setLinks(nextLinks);
      setLifeTasks(
        [...nextTasks].sort((a, b) => {
          if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
          const left = a.due_at ? Date.parse(a.due_at) : Number.MAX_SAFE_INTEGER;
          const right = b.due_at ? Date.parse(b.due_at) : Number.MAX_SAFE_INTEGER;
          return left - right;
        }),
      );
    } catch (error) {
      if (seq === requestSeq.current) setLoadError(errorMessage(error));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // 搜索防抖 250ms；空关键词回到全量列表。
  useEffect(() => {
    const timer = window.setTimeout(() => setActiveQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void loadAll(activeQuery);
  }, [activeQuery, loadAll]);

  const closeDetail = useCallback(() => {
    // 关闭即作废在途请求：晚到的响应不得把详情重新打开。
    detailSeq.current += 1;
    setDetail(null);
    setDetailError(null);
  }, []);

  const selectItem = useCallback(
    async (itemId: string, options?: { focusLinkId?: string | null }) => {
      const seq = ++detailSeq.current;
      const focusLinkId = options?.focusLinkId ?? null;
      setDetailError(null);
      // 旧实体的商品历史与票据立即清空：加载期间不得显示上一个商品的任何数据。
      setDetail({ kind: "item", id: itemId, item: null, links: [], focusLinkId });
      try {
        const [history, nextLinks] = await Promise.all([
          lifeItemHistory(itemId, 50),
          lifeDocumentLinksList("item", itemId),
        ]);
        if (seq !== detailSeq.current) return;
        setDetail({ kind: "item", id: itemId, item: history, links: nextLinks, focusLinkId });
      } catch (error) {
        // 旧请求失败不得关闭或污染用户已经打开的新详情。
        if (seq !== detailSeq.current) return;
        setDetailError(errorMessage(error));
      }
    },
    [],
  );

  const openEvent = useCallback(
    async (eventId: string, options?: { focusLinkId?: string | null }) => {
      const seq = ++detailSeq.current;
      const focusLinkId = options?.focusLinkId ?? null;
      setDetailError(null);
      setDetail({ kind: "event", id: eventId, event: null, links: [], focusLinkId });
      try {
        // 事件详情已由后端合并「事件级 + 事件内商品的商品级」票据，前端不再拼装。
        const next = await lifeEventDetail(eventId);
        if (seq !== detailSeq.current) return;
        setDetail({ kind: "event", id: eventId, event: next, links: next.links, focusLinkId });
      } catch (error) {
        if (seq !== detailSeq.current) return;
        setDetailError(errorMessage(error));
      }
    },
    [],
  );

  const refreshDetail = useCallback(
    async (target: DetailState) => {
      if (target.kind === "event") {
        await openEvent(target.id, { focusLinkId: target.focusLinkId });
      } else {
        await selectItem(target.id, { focusLinkId: target.focusLinkId });
      }
    },
    [openEvent, selectItem],
  );

  // 全局搜索定位：消费一次性意图。
  // - 商品 → 商品历史；事件 → 事件详情；
  // - 票据：target_id 是 owner_id、parent_id 是关联 id，先读关联拿到 owner_type，
  //   再打开对应详情，禁止用「事件打不开就当商品」的异常回退去猜。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "life") return;
    const intent = pendingLocate;
    consumeLocate();
    setQuery(intent.keyword ?? "");
    if (intent.kind === "life_item") {
      void selectItem(intent.id);
      return;
    }
    if (intent.kind !== "life_receipt") {
      void openEvent(intent.id);
      return;
    }
    const linkId = intent.parentId;
    if (!linkId) {
      // 没有关联 id 就无法确定 owner 类型：如实报错，不回退猜测。
      setDetailError("票据定位信息不完整：缺少关联 id，请重新搜索。");
      return;
    }
    void (async () => {
      const seq = ++detailSeq.current;
      setDetailError(null);
      try {
        const link = await lifeDocumentLinkGet(linkId);
        if (seq !== detailSeq.current) return;
        if (!link) {
          setDetailError("该票据关联已被解除，无法定位。");
          return;
        }
        if (link.owner_type === "item") {
          await selectItem(link.owner_id, { focusLinkId: link.id });
        } else {
          await openEvent(link.owner_id, { focusLinkId: link.id });
        }
      } catch (error) {
        if (seq !== detailSeq.current) return;
        setDetailError(`定位票据失败：${errorMessage(error)}`);
      }
    })();
  }, [pendingLocate, consumeLocate, selectItem, openEvent]);

  const toggleLifeTask = async (task: Task) => {
    try {
      await toggleTask(task.id);
      const nextTasks = await listTasks({ category: LIFE_CATEGORY, limit: 30 });
      setLifeTasks(
        [...nextTasks].sort((a, b) => {
          if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
          return (a.due_at ? Date.parse(a.due_at) : Number.MAX_SAFE_INTEGER) -
            (b.due_at ? Date.parse(b.due_at) : Number.MAX_SAFE_INTEGER);
        }),
      );
    } catch (error) {
      showToast(`更新待办失败：${errorMessage(error)}`, { kind: "error" });
    }
  };

  const loadReceiptChoices = useCallback(async () => {
    setReceiptLoadError(null);
    try {
      const page = await shelfList({ kind: "all", limit: 100, sort: "recent" });
      setShelfChoices(page.items.filter((item) => item.kind === "image" || item.kind === "file"));
    } catch (error) {
      setReceiptLoadError(errorMessage(error));
    }
  }, []);

  const openCreate = () => {
    setFormError(null);
    setForm(emptyForm(defaultCurrency));
    void loadReceiptChoices();
  };

  const openEdit = async (purchase: LifeItemHistory["purchases"][number]) => {
    setFormError(null);
    // 事件级更新是「整组商品行替换」：包含多件商品时不允许在这里单行编辑，
    // 否则会静默删除同事件的其他商品行。
    try {
      const detail = await lifeEventDetail(purchase.event_id);
      if (detail.items.length > 1) {
        showToast("该购买记录包含多件商品，请在详情中整体编辑；此处不支持只改其中一行。", {
          kind: "warning",
        });
        return;
      }
    } catch (error) {
      showToast(`读取购买记录失败：${errorMessage(error)}`, { kind: "error" });
      return;
    }
    setForm({
      mode: "edit",
      eventId: purchase.event_id,
      name: purchase.item_name,
      category: detail?.kind === "item" ? (detail.item?.item.category ?? "") : "",
      date: formatLifeDate(purchase.occurred_at),
      quantity: purchase.quantity_value ?? "",
      unit: purchase.quantity_unit,
      total:
        purchase.total_price_minor === null
          ? ""
          : minorToDecimalText(purchase.total_price_minor, purchase.amount_scale),
      currency: purchase.currency,
      amountScale: purchase.amount_scale,
      merchant: purchase.merchant,
      note: purchase.note,
      receiptId: "",
    });
    void loadReceiptChoices();
  };

  const savePurchase = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setFormError("请填写商品名称");
      return;
    }
    if (form.total.trim() && !form.currency.trim()) {
      setFormError("已填写金额时必须选择货币");
      return;
    }
    setSaving(true);
    setFormError(null);
    const input: LifeEventInput = {
      event_type: "purchase",
      occurred_at: form.date || null,
      merchant: form.merchant.trim() || null,
      items: [
        {
          name,
          category: form.category.trim() || null,
          quantity_value: form.quantity.trim() || null,
          quantity_unit: form.unit.trim() || null,
          total_price: form.total.trim() || null,
          currency: form.currency.trim() || null,
          amount_scale: form.mode === "edit" ? form.amountScale : null,
          note: form.note.trim() || null,
        },
      ],
    };
    try {
      const saved =
        form.mode === "edit" && form.eventId
          ? await lifeEventUpdate(form.eventId, input)
          : await lifeEventCreate(input);
      let linkWarning = "";
      if (form.receiptId) {
        const choice = shelfChoices.find((item) => item.id === form.receiptId);
        if (!choice) {
          linkWarning = "所选票据已不在文件暂存中，购买记录已保存，请重新添加票据。";
        } else {
          try {
            await lifeDocumentLinkCreate({
              owner_type: "event",
              owner_id: saved.event.id,
              document_ref: choice.id,
              document_source: "shelf_item",
              document_name: choice.display_name,
              mime: "",
              byte_size: choice.byte_size,
              transfer_state: choice.exists_state === "ok" ? "local" : "missing",
            });
          } catch (error) {
            linkWarning = `购买记录已保存，但票据关联失败：${errorMessage(error)}`;
          }
        }
      }
      setForm(null);
      if (linkWarning) {
        showToast(linkWarning, { kind: "warning" });
      } else {
        showToast(form.mode === "edit" ? "购买记录已更新" : "购买记录已保存", {
          kind: "success",
        });
      }
      await loadAll(activeQuery);
      if (detail?.kind === "item") {
        await selectItem(detail.id);
      } else {
        const primaryItem = saved.items[0]?.item_id;
        if (primaryItem) await selectItem(primaryItem);
      }
    } catch (error) {
      // 失败保留全部表单内容，不关闭对话框。
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await lifeEventDelete(deleteTarget.id);
      setDeleteTarget(null);
      if (detail?.kind === "event" && detail.id === deleteTarget.id) closeDetail();
      showToast("购买记录已删除", { kind: "success" });
      await loadAll(activeQuery);
      if (detail?.kind === "item") await selectItem(detail.id);
    } catch (error) {
      showToast(`删除失败：${errorMessage(error)}`, { kind: "error" });
    } finally {
      setDeleting(false);
    }
  };

  const openLinkDialog = async () => {
    const target =
      detail?.kind === "event" && detail.event
        ? {
            type: "event" as const,
            id: detail.event.event.id,
            label: detail.event.event.title || "当前生活记录",
          }
        : detail?.kind === "item" && detail.item
          ? { type: "item" as const, id: detail.item.item.id, label: detail.item.item.name }
          : null;
    if (!target) {
      showToast("请先选择一个商品或购买记录", { kind: "warning" });
      return;
    }
    setLinkTarget(target);
    setLinkDialogOpen(true);
    setLinkError(null);
    setShelfChoiceId(null);
    try {
      const page = await shelfList({ kind: "all", limit: 100, sort: "recent" });
      setShelfChoices(page.items.filter((item) => item.kind === "image" || item.kind === "file"));
    } catch (error) {
      setLinkError(errorMessage(error));
    }
  };

  const saveLink = async () => {
    if (!linkTarget || !shelfChoiceId) {
      setLinkError("请选择一张票据文件");
      return;
    }
    const choice = shelfChoices.find((item) => item.id === shelfChoiceId);
    if (!choice) return;
    setLinking(true);
    setLinkError(null);
    try {
      const created = await lifeDocumentLinkCreate({
        owner_type: linkTarget.type,
        owner_id: linkTarget.id,
        document_ref: choice.id,
        document_source: "shelf_item",
        document_name: choice.display_name,
        mime: "",
        byte_size: choice.byte_size,
        transfer_state: "local",
      });
      setLinkDialogOpen(false);
      showToast("票据已关联", { kind: "success" });
      // 只把新关联并入当前详情；详情所属实体与其余字段保持不变。
      setDetail((current) => {
        if (!current) return current;
        const ownerKind = created.owner_type === "event" ? "event" : "item";
        if (current.kind !== ownerKind || current.id !== created.owner_id) return current;
        return {
          ...current,
          links: [created, ...current.links.filter((link) => link.id !== created.id)],
        };
      });
      await loadAll(activeQuery);
    } catch (error) {
      setLinkError(errorMessage(error));
    } finally {
      setLinking(false);
    }
  };

  const openLink = async (link: LifeDocumentLink) => {
    const state = receiptStateInfo(link);
    if (state.action === "missing") {
      showToast("票据原文件缺失：关联仍保留，但文件已被删除或从未传输成功。", {
        kind: "warning",
      });
      return;
    }
    if (state.action === "pending") {
      if (link.transfer_state === "transferred") {
        showToast("票据状态异常：标记为已传输但缺少远端引用，请重新从手机发送。", {
          kind: "error",
        });
        return;
      }
      showToast(
        "票据元数据已同步，但原图尚未传输到这台电脑。请在手机的生活票据详情里点「发送到电脑」后重试。",
        { kind: "warning" },
      );
      return;
    }
    if (state.action === "unsupported") {
      showToast(`该票据来源（${link.document_source}）暂不支持在桌面预览`, {
        kind: "warning",
      });
      return;
    }
    if (state.action === "mobile_file") {
      const fileId = state.mobileFileId;
      if (!fileId) return;
      setPreviewBusy(true);
      try {
        // 文件已在电脑的互传接收目录，但还没导入暂存架：定位给用户看，不谎称可预览。
        await mobileFileReveal(fileId);
        showToast(
          "文件已到这台电脑，但尚未导入文件暂存架；请在「文件互传」中导入后即可预览。",
          { kind: "info" },
        );
      } catch (error) {
        showToast(
          `定位文件失败：${errorMessage(error)}。请到「文件互传」查看该文件。`,
          { kind: "error" },
        );
      } finally {
        setPreviewBusy(false);
      }
      return;
    }
    const shelfRef = state.shelfRef;
    if (!shelfRef) {
      showToast("该票据缺少可打开的暂存架引用。", { kind: "warning" });
      return;
    }
    setPreviewBusy(true);
    try {
      const shelfItem = await shelfGetItem(shelfRef);
      if (shelfItem.kind === "image") setPreviewShelf(shelfItem);
      else await shelfOpenItem(shelfItem.id);
    } catch (error) {
      showToast(`打开票据失败：${errorMessage(error)}`, { kind: "error" });
    } finally {
      setPreviewBusy(false);
    }
  };

  const removeLink = async (link: LifeDocumentLink) => {
    // 只允许操作当前详情真实展示的关联：防止过期行/别的实体的票据被解除。
    const current = detail;
    if (!current || !current.links.some((item) => item.id === link.id)) {
      showToast("该票据不属于当前详情，请刷新后重试", { kind: "warning" });
      return;
    }
    try {
      await lifeDocumentLinkDelete(link.id);
      showToast("已解除票据关联，原文件未删除", { kind: "success" });
      setDetail((state) =>
        state ? { ...state, links: state.links.filter((item) => item.id !== link.id) } : state,
      );
      await loadAll(activeQuery);
    } catch (error) {
      showToast(`解除关联失败：${errorMessage(error)}`, { kind: "error" });
    }
  };

  const itemNamesByOwner = useMemo(() => {
    const map = new Map<string, string>();
    if (detail?.kind === "event" && detail.event) {
      for (const item of detail.event.items) {
        if (item.item_id) map.set(item.item_id, item.item_name_snapshot);
      }
    }
    return map;
  }, [detail]);

  const recentLinks = links.slice(0, 6);
  const showDetail = detail !== null;
  const eventDetail = detail?.kind === "event" ? detail.event : null;
  const itemDetail = detail?.kind === "item" ? detail.item : null;
  const detailLinks = detail?.links ?? [];
  const focusLinkId = detail?.focusLinkId ?? null;

  return (
    <div className="life-panel page-fill ui-page-frame">
      <header className="life-head ui-toolbar-row">
        <div className="life-head-main">
          <div className="life-title">
            <span className="life-title-icon" aria-hidden="true">
              <ShoppingBasket size={18} />
            </span>
            <div>
              <h1>生活</h1>
              <p>购买记录、生活待办与票据保存在本机，可通过局域网与手机同步。</p>
            </div>
          </div>
          <SearchField
            value={query}
            onChange={setQuery}
            ariaLabel="搜索商品或购买记录"
            placeholder="搜索商品，例如「大米」"
            className="life-search"
          />
        </div>
        <span className="ui-toolbar-spacer" aria-hidden="true" />
        <div className="life-actions">
          <button type="button" className="btn sm primary" onClick={openCreate}>
            <Plus size={13} aria-hidden="true" /> 记录购买
          </button>
          <button type="button" className="btn sm" onClick={() => openTaskEditor(undefined, LIFE_CATEGORY)}>
            <CalendarDays size={13} aria-hidden="true" /> 新增生活待办
          </button>
          <button type="button" className="btn sm" onClick={() => void openLinkDialog()}>
            <ReceiptText size={13} aria-hidden="true" /> 添加票据
          </button>
        </div>
      </header>

      {loadError && (
        <div className="life-banner error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>加载失败：{loadError}</span>
          <button type="button" className="btn sm" onClick={() => void loadAll(activeQuery)}>
            重试
          </button>
        </div>
      )}

      <div className="life-stats ui-adaptive-grid" aria-label="生活概览">
        <div className="life-stat">
          <span>商品</span>
          <strong>{overview?.item_count ?? 0}</strong>
        </div>
        <div className="life-stat">
          <span>购买次数</span>
          <strong>{overview?.purchase_count ?? 0}</strong>
        </div>
        <div className="life-stat">
          <span>近 30 天</span>
          <strong>{overview?.purchases_last_30_days ?? 0}</strong>
        </div>
        <div className="life-stat">
          <span>票据</span>
          <strong>{overview?.receipt_count ?? 0}</strong>
        </div>
      </div>

      <div className={`life-body ${showDetail ? "has-detail" : ""}`}>
        <div className="life-main">
          <section className="life-section" aria-labelledby="life-recent-title">
            <div className="life-section-head">
              <h2 id="life-recent-title">最近购买</h2>
              <span className="life-muted">{events.length} 条</span>
            </div>
            {events.length === 0 ? (
              <div className="life-empty">
                <p>尚无购买记录</p>
                <button type="button" className="btn sm" onClick={openCreate}>
                  记录第一笔购买
                </button>
              </div>
            ) : (
              <ul className="life-event-list">
                {events.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      className="life-event-row"
                      onClick={() => void openEvent(event.id)}
                    >
                      <span className="life-event-date">{formatLifeDate(event.occurred_at)}</span>
                      <span className="life-event-body">
                        <span className="life-event-title">
                          {event.item_names.length > 0 ? event.item_names.join("、") : event.title}
                        </span>
                        <span className="life-muted">
                          {[event.merchant, event.link_count > 0 ? `${event.link_count} 张票据` : ""]
                            .filter(Boolean)
                            .join(" · ") || "购买记录"}
                        </span>
                      </span>
                      <span className="life-event-amount">{eventAmountText(event)}</span>
                      <ChevronRight size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="life-section" aria-labelledby="life-todo-title">
            <div className="life-section-head">
              <h2 id="life-todo-title">生活待办</h2>
              <span className="life-muted">复用任务系统 · 分类「生活」</span>
            </div>
            {lifeTasks.length === 0 ? (
              <div className="life-empty">
                <p>暂无生活待办</p>
                <button type="button" className="btn sm" onClick={() => openTaskEditor(undefined, LIFE_CATEGORY)}>
                  新增待办
                </button>
              </div>
            ) : (
              <ul className="life-task-list">
                {lifeTasks.map((task) => (
                  <li key={task.id} className={task.status === "completed" ? "is-done" : ""}>
                    <button
                      type="button"
                      className="life-task-check"
                      aria-label={task.status === "pending" ? `完成 ${task.title}` : `恢复 ${task.title}`}
                      onClick={() => void toggleLifeTask(task)}
                    >
                      {task.status === "pending" ? <Check size={13} aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
                    </button>
                    <span className="life-task-title">{task.title}</span>
                    <span className="life-muted life-task-time">
                      {task.remind_at
                        ? `提醒 ${formatLifeDate(task.remind_at)}`
                        : task.due_at
                          ? `截止 ${formatLifeDate(task.due_at)}`
                          : "未设置时间"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="life-section" aria-labelledby="life-receipt-title">
            <div className="life-section-head">
              <h2 id="life-receipt-title">票据资料</h2>
              <span className="life-muted">只存引用，原图不复制</span>
            </div>
            {recentLinks.length === 0 ? (
              <div className="life-empty">
                <p>暂无票据</p>
                <button type="button" className="btn sm" onClick={() => void openLinkDialog()}>
                  从文件暂存关联
                </button>
              </div>
            ) : (
              <ul className="life-receipt-list">
                {recentLinks.map((link) => {
                  const receipt = receiptStateInfo(link);
                  return (
                    <li key={link.id}>
                      <button type="button" className="life-receipt-row" onClick={() => void openLink(link)}>
                        <FileImage size={14} aria-hidden="true" />
                        <span className="life-receipt-name">{link.document_name || "生活票据"}</span>
                        <span className={`life-chip ${receipt.tone}`}>
                          {receipt.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="life-side" aria-label={showDetail ? "生活详情" : "商品列表"}>
          {detailError && (
            <div className="life-banner error" role="alert">
              <AlertCircle size={14} aria-hidden="true" /> {detailError}
            </div>
          )}

          {eventDetail ? (
            <div className="life-detail">
              <div className="life-detail-head">
                <div>
                  <h2>{eventDetail.event.title || "购买记录"}</h2>
                  <p className="life-muted">
                    {formatLifeDate(eventDetail.event.occurred_at)}
                    {eventDetail.event.merchant ? ` · ${eventDetail.event.merchant}` : ""}
                  </p>
                </div>
                <button type="button" className="icon-btn sm" aria-label="关闭详情" data-tip="关闭详情" onClick={closeDetail}>
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <ul className="life-detail-items">
                {eventDetail.items.map((item) => (
                  <li key={item.id}>
                    <div className="life-detail-item-title">
                      <strong>{item.item_name_snapshot}</strong>
                      <span className="life-muted">
                        {item.quantity_value ? `${item.quantity_value}${item.quantity_unit}` : ""}
                      </span>
                    </div>
                    <span>{formatMoneyMinor(item.total_price_minor, item.currency, item.amount_scale) || "未记录金额"}</span>
                    {item.note && <span className="life-muted">{item.note}</span>}
                  </li>
                ))}
              </ul>
              <div className="life-detail-actions">
                <button
                  type="button"
                  className="btn sm"
                  disabled={!eventDetail.items[0]?.item_id}
                  onClick={() => {
                    const itemId = eventDetail.items[0]?.item_id;
                    if (itemId) void selectItem(itemId);
                  }}
                >
                  查看商品历史
                </button>
                <button type="button" className="btn sm" onClick={() => void openLinkDialog()}>
                  添加票据
                </button>
                <button type="button" className="btn sm danger" onClick={() => {
                  const summary = events.find((event) => event.id === eventDetail.event.id);
                  if (summary) setDeleteTarget(summary);
                }}>
                  删除记录
                </button>
              </div>
              <div className="life-detail-links">
                <h3>关联票据</h3>
                {detailLinks.length === 0 ? (
                  <p className="life-muted">未关联票据</p>
                ) : (
                  detailLinks.map((link) => {
                    const receipt = receiptStateInfo(link);
                    const ownerName = itemNamesByOwner.get(link.owner_id);
                    return (
                      <div
                        key={link.id}
                        className={`life-link-row${focusLinkId === link.id ? " is-focused" : ""}`}
                      >
                        <button type="button" className="life-link-open" onClick={() => void openLink(link)}>
                          <ReceiptText size={13} aria-hidden="true" /> {link.document_name || "生活票据"}
                        </button>
                        <span className="life-muted life-link-owner">
                          {link.owner_type === "item" ? (ownerName ? `商品票据 · ${ownerName}` : "商品票据") : "事件票据"}
                        </span>
                        <span className={`life-chip ${receipt.tone}`}>{receipt.label}</span>
                        <button type="button" className="btn sm" onClick={() => void removeLink(link)}>
                          解除
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : itemDetail ? (
            <div className="life-detail">
              <div className="life-detail-head">
                <div>
                  <h2>{itemDetail.item.name}</h2>
                  <p className="life-muted">
                    {itemDetail.item.category || "未分类"}
                    {itemDetail.item.aliases.length > 0 ? ` · 别名：${itemDetail.item.aliases.join("、")}` : ""}
                  </p>
                </div>
                <button type="button" className="icon-btn sm" aria-label="关闭详情" data-tip="关闭详情" onClick={closeDetail}>
                  <X size={13} aria-hidden="true" />
                </button>
              </div>

              <div className="life-detail-stats">
                <div>
                  <span>最近购买</span>
                  <strong>{formatLifeDate(itemDetail.item.last_purchase_at) || "尚无记录"}</strong>
                </div>
                <div>
                  <span>购买次数</span>
                  <strong>{itemDetail.item.purchase_count}</strong>
                </div>
                <div>
                  <span>两次间隔</span>
                  <strong>
                    {itemDetail.item.interval_days === null ? "暂无足够记录" : `${itemDetail.item.interval_days} 天`}
                  </strong>
                </div>
              </div>

              <div className="life-detail-actions">
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => {
                    const base = emptyForm(defaultCurrency || itemDetail.item.last_currency);
                    setFormError(null);
                    setForm({
                      ...base,
                      name: itemDetail.item.name,
                      category: itemDetail.item.category,
                      unit: itemDetail.item.last_quantity_unit,
                      currency: base.currency || itemDetail.item.last_currency,
                    });
                  }}
                >
                  <Plus size={12} aria-hidden="true" /> 记录本次购买
                </button>
                <button type="button" className="btn sm" onClick={() => void openLinkDialog()}>
                  添加票据
                </button>
              </div>

              <div className="life-history">
                <div className="life-section-head">
                  <h3>购买历史</h3>
                  <span className="life-muted">{itemDetail.total_count} 条</span>
                </div>
                {itemDetail.purchases.length === 0 ? (
                  <p className="life-muted">尚无购买记录</p>
                ) : (
                  <ul className="life-history-list">
                    {itemDetail.purchases.map((purchase) => (
                      <li key={purchase.item_row_id}>
                        <div className="life-history-main">
                          <span className="life-history-date">{formatLifeDate(purchase.occurred_at)}</span>
                          <span className="life-history-qty">
                            {purchase.quantity_value ? `${purchase.quantity_value}${purchase.quantity_unit}` : ""}
                          </span>
                          <span className="life-history-amount">
                            {formatMoneyMinor(purchase.total_price_minor, purchase.currency, purchase.amount_scale) || "未记录金额"}
                          </span>
                        </div>
                        {(purchase.merchant || purchase.note) && (
                          <p className="life-muted">
                            {[purchase.merchant, purchase.note].filter(Boolean).join(" · ")}
                          </p>
                        )}
                        {purchase.links.length > 0 && (
                          <div className="life-history-links">
                            {purchase.links.map((link) => (
                              <button key={link.id} type="button" className="life-chip link" onClick={() => void openLink(link)}>
                                <ReceiptText size={11} aria-hidden="true" /> {link.document_name || "票据"}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="life-history-actions">
                          <button type="button" className="icon-btn sm" aria-label={`编辑 ${purchase.item_name}`} data-tip="编辑" onClick={() => void openEdit(purchase)}>
                            <Pencil size={12} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-btn sm"
                            aria-label={`删除 ${purchase.item_name} 的这条记录`}
                            data-tip="删除这条记录"
                            onClick={() => {
                              const summary = events.find((event) => event.id === purchase.event_id);
                              setDeleteTarget(
                                summary ?? {
                                  id: purchase.event_id,
                                  event_type: "purchase",
                                  title: purchase.item_name,
                                  description: "",
                                  occurred_at: purchase.occurred_at,
                                  merchant: purchase.merchant,
                                  item_names: [purchase.item_name],
                                  total_price_minor: purchase.total_price_minor,
                                  currency: purchase.currency,
                                  amount_scale: purchase.amount_scale,
                                  link_count: purchase.links.length,
                                },
                              );
                            }}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {detailLinks.length > 0 && (
                <div className="life-detail-links">
                  <h3>关联票据</h3>
                  <p className="life-hint">只显示挂在该商品上的票据；某次购买的小票显示在对应历史行里。</p>
                  {detailLinks.map((link) => {
                    const receipt = receiptStateInfo(link);
                    return (
                      <div
                        key={link.id}
                        className={`life-link-row${focusLinkId === link.id ? " is-focused" : ""}`}
                      >
                        <button type="button" className="life-link-open" onClick={() => void openLink(link)}>
                          <ReceiptText size={13} aria-hidden="true" /> {link.document_name || "生活票据"}
                        </button>
                        <span className={`life-chip ${receipt.tone}`}>{receipt.label}</span>
                        <button type="button" className="btn sm" onClick={() => void removeLink(link)}>解除</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
              {detail && (
                <div className="life-detail life-detail-pending" role="status">
                  {detailError ? (
                    <>
                      <p className="life-muted">详情加载失败。</p>
                      <div className="life-detail-actions">
                        <button type="button" className="btn sm" onClick={() => void refreshDetail(detail)}>
                          重试
                        </button>
                        <button type="button" className="btn sm" onClick={closeDetail}>
                          关闭
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="life-loading">
                      <Loader2 size={14} className="spin" aria-hidden="true" /> 加载中…
                    </div>
                  )}
                </div>
              )}
              {/* 商品详情加载期间保留商品列表：用户可以在结果回来前继续切换，
                  列表不是「上一个详情的数据」，不会造成状态污染。事件详情从主区进入，
                  加载中只显示占位，避免把商品列表误当成事件内容。 */}
              {(!detail || detail.kind === "item") && (
                <div className="life-items">
                  <div className="life-section-head">
                    <h2>商品</h2>
                    <span className="life-muted">{items.length} 个</span>
                  </div>
                  {loading ? (
                    <div className="life-loading" role="status">
                      <Loader2 size={14} className="spin" aria-hidden="true" /> 加载中…
                    </div>
                  ) : items.length === 0 ? (
                    <div className="life-empty">
                      <p>{activeQuery ? "尚无购买记录" : "还没有商品记录"}</p>
                      {!activeQuery && (
                        <button type="button" className="btn sm" onClick={openCreate}>
                          记录购买
                        </button>
                      )}
                    </div>
                  ) : (
                    <ul className="life-item-list">
                      {items.map((item) => (
                        <li key={item.id}>
                          <button type="button" className="life-item-row" onClick={() => void selectItem(item.id)}>
                            <span className="life-item-name">{item.name}</span>
                            <span className="life-item-meta">
                              {item.last_purchase_at
                                ? `最近 ${formatLifeDate(item.last_purchase_at)} · ${item.purchase_count} 次`
                                : "尚无购买记录"}
                            </span>
                            <span className="life-item-price">
                              {formatMoneyMinor(item.last_total_price_minor, item.last_currency, item.last_amount_scale)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {/* 记录购买：默认只要求商品名称，其余字段选填。 */}
      <Dialog
        open={form !== null}
        onClose={() => {
          if (!saving) setForm(null);
        }}
        title={form?.mode === "edit" ? "编辑购买记录" : "记录购买"}
        size="md"
        footer={
          <>
            <button type="button" className="btn sm" disabled={saving} onClick={() => setForm(null)}>
              取消
            </button>
            <button type="button" className="btn sm primary" disabled={saving} onClick={() => void savePurchase()}>
              {saving ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
              保存
            </button>
          </>
        }
      >
        {form && (
          <div className="life-form">
            {formError && (
              <div className="life-banner error" role="alert">
                <AlertCircle size={14} aria-hidden="true" /> {formError}
              </div>
            )}
            <label className="life-field">
              <span>商品名称 *</span>
              <input
                className="input"
                value={form.name}
                autoFocus
                placeholder="例如：大米"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <div className="life-field-row">
              <label className="life-field">
                <span>实际购买日期</span>
                <input
                  className="input"
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                />
              </label>
              <label className="life-field">
                <span>分类</span>
                <input
                  className="input"
                  value={form.category}
                  placeholder="选填，如 主食"
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                />
              </label>
            </div>
            <div className="life-field-row three">
              <label className="life-field">
                <span>数量</span>
                <input
                  className="input"
                  value={form.quantity}
                  placeholder="支持小数，如 5.5"
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
              </label>
              <label className="life-field">
                <span>单位</span>
                <input
                  className="input"
                  value={form.unit}
                  placeholder="kg / 袋 / 个"
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </label>
              <label className="life-field">
                <span>
                  金额{form.currency ? `（最多 ${currencyMaxScale(form.currency)} 位小数）` : ""}
                </span>
                <input
                  className="input"
                  value={form.total}
                  placeholder="48.00"
                  onChange={(e) => setForm({ ...form, total: e.target.value })}
                />
              </label>
            </div>
            <div className="life-field-row">
              <label className="life-field">
                <span>货币</span>
                <Select
                  value={form.currency}
                  options={CURRENCY_OPTIONS}
                  onChange={(value) => setForm({ ...form, currency: value, amountScale: null })}
                  placeholder="请选择货币"
                  ariaLabel="货币"
                  size="sm"
                />
              </label>
              <label className="life-field">
                <span>商家</span>
                <input
                  className="input"
                  value={form.merchant}
                  placeholder="选填"
                  onChange={(e) => setForm({ ...form, merchant: e.target.value })}
                />
              </label>
            </div>
            <label className="life-field">
              <span>备注</span>
              <textarea
                className="input life-textarea"
                value={form.note}
                placeholder="选填，例如 普通袋装"
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </label>
            <label className="life-field">
              <span>关联票据（可选）</span>
              <Select
                value={form.receiptId}
                options={[
                  { value: "", label: "不关联票据" },
                  ...shelfChoices.map((choice) => ({
                    value: choice.id,
                    label: `${choice.display_name}${choice.kind === "image" ? " · 图片" : " · 文件"}`,
                  })),
                ]}
                onChange={(value) => setForm({ ...form, receiptId: value })}
                placeholder="不关联票据"
                ariaLabel="关联票据"
                size="sm"
              />
            </label>
            {receiptLoadError && (
              <p className="life-hint">读取文件暂存失败：{receiptLoadError}。仍可先保存购买记录，稍后单独添加票据。</p>
            )}
            {defaultCurrency === "" && form.total.trim() !== "" && form.currency === "" && (
              <p className="life-hint">未配置默认货币，请显式选择货币后再保存。</p>
            )}
          </div>
        )}
      </Dialog>

      {/* 关联票据：只从文件暂存挑选，复用既有图片查看器。 */}
      <Dialog
        open={linkDialogOpen}
        onClose={() => setLinkDialogOpen(false)}
        title={`添加票据${linkTarget ? ` · ${linkTarget.label}` : ""}`}
        size="md"
        footer={
          <>
            <button type="button" className="btn sm" onClick={() => setLinkDialogOpen(false)}>
              取消
            </button>
            <button type="button" className="btn sm primary" disabled={linking || !shelfChoiceId} onClick={() => void saveLink()}>
              {linking ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
              关联
            </button>
          </>
        }
      >
        {linkError && (
          <div className="life-banner error" role="alert">
            <AlertCircle size={14} aria-hidden="true" /> {linkError}
          </div>
        )}
        {shelfChoices.length === 0 ? (
          <p className="life-muted">文件暂存中没有图片或文件。请先在「收集与暂存」里导入票据。</p>
        ) : (
          <ul className="life-shelf-list">
            {shelfChoices.map((choice) => (
              <li key={choice.id}>
                <label>
                  <input
                    type="radio"
                    name="life-shelf-choice"
                    checked={shelfChoiceId === choice.id}
                    onChange={() => setShelfChoiceId(choice.id)}
                  />
                  <span>{choice.display_name}</span>
                  <span className="life-muted">{choice.kind === "image" ? "图片" : "文件"}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这条生活记录？"
        detail={
          <span>
            「{deleteTarget?.item_names?.join("、") || deleteTarget?.title}」将从购买历史中删除；
            原始票据文件不会删除，手机端会在下次同步时移除副本。
          </span>
        }
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      {previewBusy && (
        <div className="life-preview-busy" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 正在打开票据…
        </div>
      )}
      {previewShelf && (
        <ShelfImageLightbox item={previewShelf} onClose={() => setPreviewShelf(null)} />
      )}
    </div>
  );
}
