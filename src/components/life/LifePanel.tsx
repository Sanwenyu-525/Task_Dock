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

  const [selected, setSelected] = useState<LifeItemHistory | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<LifeEventDetail | null>(null);
  const [itemLinks, setItemLinks] = useState<LifeDocumentLink[]>([]);
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

  const selectItem = useCallback(async (itemId: string) => {
    setDetailError(null);
    setSelectedEvent(null);
    try {
      const [history, nextLinks] = await Promise.all([
        lifeItemHistory(itemId, 50),
        lifeDocumentLinksList("item", itemId),
      ]);
      setSelected(history);
      setItemLinks(nextLinks);
    } catch (error) {
      setSelected(null);
      setDetailError(errorMessage(error));
    }
  }, []);

  const openEvent = useCallback(async (eventId: string) => {
    setDetailError(null);
    setSelected(null);
    try {
      const detail = await lifeEventDetail(eventId);
      setSelectedEvent(detail);
    } catch (error) {
      setSelectedEvent(null);
      setDetailError(errorMessage(error));
    }
  }, []);

  // 全局搜索定位：消费一次性意图（商品 → 历史；事件/票据 → 事件详情）。
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
    void (async () => {
      try {
        await openEvent(intent.id);
      } catch {
        // 票据可能挂在商品上：事件不存在时回退为商品历史。
        await selectItem(intent.id);
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
      category: selected?.item.category ?? "",
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
      if (selected) {
        await selectItem(selected.item.id);
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
      if (selectedEvent?.event.id === deleteTarget.id) setSelectedEvent(null);
      showToast("购买记录已删除", { kind: "success" });
      await loadAll(activeQuery);
      if (selected) await selectItem(selected.item.id);
    } catch (error) {
      showToast(`删除失败：${errorMessage(error)}`, { kind: "error" });
    } finally {
      setDeleting(false);
    }
  };

  const openLinkDialog = async () => {
    const target = selectedEvent
      ? {
          type: "event" as const,
          id: selectedEvent.event.id,
          label: selectedEvent.event.title || "当前生活记录",
        }
      : selected
        ? { type: "item" as const, id: selected.item.id, label: selected.item.name }
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
      await lifeDocumentLinkCreate({
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
      await loadAll(activeQuery);
      if (selected) await selectItem(selected.item.id);
      if (selectedEvent) await openEvent(selectedEvent.event.id);
    } catch (error) {
      setLinkError(errorMessage(error));
    } finally {
      setLinking(false);
    }
  };

  const openLink = async (link: LifeDocumentLink) => {
    // 手机采集的原图经文件互传后，桌面端真正可预览的是 remote_ref（暂存架条目）；
    // document_ref 仍保留手机/本地来源，不能拿它去桌面暂存架查文件。
    const localSource = link.document_source;
    const localRef = link.document_ref;
    const remoteRef = link.remote_ref?.trim() ?? "";
    if (localSource === "shelf_item") {
      // 桌面端自己选择的暂存架文件。
    } else if (remoteRef && link.remote_source === "shelf_item") {
      // 已由手机传输并入库。
    } else if (localSource === "capture_asset") {
      showToast(
        "票据元数据已同步，但原图尚未传输到这台电脑。请在手机的生活票据详情里点「发送到电脑」后重试。",
        { kind: "warning" },
      );
      return;
    } else {
      showToast(`该票据来源（${localSource}）暂不支持在桌面预览`, { kind: "warning" });
      return;
    }
    const shelfRef = localSource === "shelf_item" ? localRef : remoteRef;
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
    try {
      await lifeDocumentLinkDelete(link.id);
      showToast("已解除票据关联，原文件未删除", { kind: "success" });
      await loadAll(activeQuery);
      if (selected) await selectItem(selected.item.id);
      if (selectedEvent) await openEvent(selectedEvent.event.id);
    } catch (error) {
      showToast(`解除关联失败：${errorMessage(error)}`, { kind: "error" });
    }
  };

  const visibleLinks = useMemo(() => {
    const seen = new Set<string>();
    return [...(selectedEvent?.links ?? []), ...itemLinks].filter((link) => {
      if (seen.has(link.id)) return false;
      seen.add(link.id);
      return true;
    });
  }, [selectedEvent, itemLinks]);

  const recentLinks = links.slice(0, 6);
  const showDetail = Boolean(selected || selectedEvent);

  return (
    <div className="life-panel page-fill">
      <header className="life-head">
        <div className="life-head-main">
          <div className="life-title">
            <span className="life-title-icon" aria-hidden="true">
              <ShoppingBasket size={18} />
            </span>
            <div>
              <h1>生活</h1>
              <p>购买记录、生活待办与票据，全部保存在本机并随任务系统同步。</p>
            </div>
          </div>
          <SearchField
            value={query}
            onChange={setQuery}
            ariaLabel="搜索商品或购买记录"
            placeholder="搜索商品，例如「大米」或「上次什么时候买的大米」"
            className="life-search"
          />
        </div>
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

      <div className="life-stats" aria-label="生活概览">
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
                      <span className="life-event-amount">
                        {formatMoneyMinor(event.total_price_minor, event.currency, event.amount_scale)}
                      </span>
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
                {recentLinks.map((link) => (
                  <li key={link.id}>
                    <button type="button" className="life-receipt-row" onClick={() => void openLink(link)}>
                      <FileImage size={14} aria-hidden="true" />
                      <span className="life-receipt-name">{link.document_name || "生活票据"}</span>
                      <span className={`life-chip ${link.transfer_state}`}>
                        {link.transfer_state === "transferred"
                          ? "已传输"
                          : link.transfer_state === "local"
                            ? "本机"
                            : link.transfer_state === "missing"
                              ? "文件缺失"
                              : "待传输"}
                      </span>
                    </button>
                  </li>
                ))}
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

          {selectedEvent ? (
            <div className="life-detail">
              <div className="life-detail-head">
                <div>
                  <h2>{selectedEvent.event.title || "购买记录"}</h2>
                  <p className="life-muted">
                    {formatLifeDate(selectedEvent.event.occurred_at)}
                    {selectedEvent.event.merchant ? ` · ${selectedEvent.event.merchant}` : ""}
                  </p>
                </div>
                <button type="button" className="icon-btn sm" aria-label="关闭详情" data-tip="关闭详情" onClick={() => setSelectedEvent(null)}>
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <ul className="life-detail-items">
                {selectedEvent.items.map((item) => (
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
                  disabled={!selectedEvent.items[0]?.item_id}
                  onClick={() => {
                    const itemId = selectedEvent.items[0]?.item_id;
                    if (itemId) void selectItem(itemId);
                  }}
                >
                  查看商品历史
                </button>
                <button type="button" className="btn sm" onClick={() => void openLinkDialog()}>
                  添加票据
                </button>
                <button type="button" className="btn sm danger" onClick={() => {
                  const summary = events.find((event) => event.id === selectedEvent.event.id);
                  if (summary) setDeleteTarget(summary);
                }}>
                  删除记录
                </button>
              </div>
              <div className="life-detail-links">
                <h3>关联票据</h3>
                {selectedEvent.links.length === 0 ? (
                  <p className="life-muted">未关联票据</p>
                ) : (
                  selectedEvent.links.map((link) => (
                    <div key={link.id} className="life-link-row">
                      <button type="button" className="life-link-open" onClick={() => void openLink(link)}>
                        <ReceiptText size={13} aria-hidden="true" /> {link.document_name || "生活票据"}
                      </button>
                      <button type="button" className="btn sm" onClick={() => void removeLink(link)}>
                        解除
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : selected ? (
            <div className="life-detail">
              <div className="life-detail-head">
                <div>
                  <h2>{selected.item.name}</h2>
                  <p className="life-muted">
                    {selected.item.category || "未分类"}
                    {selected.item.aliases.length > 0 ? ` · 别名：${selected.item.aliases.join("、")}` : ""}
                  </p>
                </div>
                <button type="button" className="icon-btn sm" aria-label="关闭详情" data-tip="关闭详情" onClick={() => setSelected(null)}>
                  <X size={13} aria-hidden="true" />
                </button>
              </div>

              <div className="life-detail-stats">
                <div>
                  <span>最近购买</span>
                  <strong>{formatLifeDate(selected.item.last_purchase_at) || "尚无记录"}</strong>
                </div>
                <div>
                  <span>购买次数</span>
                  <strong>{selected.item.purchase_count}</strong>
                </div>
                <div>
                  <span>两次间隔</span>
                  <strong>
                    {selected.item.interval_days === null ? "暂无足够记录" : `${selected.item.interval_days} 天`}
                  </strong>
                </div>
              </div>

              <div className="life-detail-actions">
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => {
                    const base = emptyForm(defaultCurrency || selected.item.last_currency);
                    setFormError(null);
                    setForm({
                      ...base,
                      name: selected.item.name,
                      category: selected.item.category,
                      unit: selected.item.last_quantity_unit,
                      currency: base.currency || selected.item.last_currency,
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
                  <span className="life-muted">{selected.total_count} 条</span>
                </div>
                {selected.purchases.length === 0 ? (
                  <p className="life-muted">尚无购买记录</p>
                ) : (
                  <ul className="life-history-list">
                    {selected.purchases.map((purchase) => (
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

              {visibleLinks.length > 0 && (
                <div className="life-detail-links">
                  <h3>关联票据</h3>
                  {visibleLinks.map((link) => (
                    <div key={link.id} className="life-link-row">
                      <button type="button" className="life-link-open" onClick={() => void openLink(link)}>
                        <ReceiptText size={13} aria-hidden="true" /> {link.document_name || "生活票据"}
                      </button>
                      <button type="button" className="btn sm" onClick={() => void removeLink(link)}>解除</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
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
                <span>金额（最多 2 位小数）</span>
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
