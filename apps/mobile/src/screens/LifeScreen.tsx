// 移动端生活页：快速购买记录、最近购买、本地搜索、生活待办、票据预览与关联。
//
// 边界：
// - 生活待办复用现有 TaskEditorSheet / tasks 表，保存后 category = 生活；
// - 票据只保存采集素材引用，原图为本机文件时走现有 ImageLightbox；
// - 不展示演示数据；所有列表来自本地 SQLite，失败在页面与 Toast 明确反馈。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { AppBar } from "../components/AppBar";
import { BottomSheet } from "../components/BottomSheet";
import { HeaderIconButton } from "../components/HeaderIconButton";
import { ImageLightbox, type LightboxImage } from "../components/ImageLightbox";
import { SearchField } from "../components/SearchField";
import { TaskEditorSheet, type TaskSubmitOutcome } from "../components/TaskEditorSheet";
import { AppIcon } from "../components/icons/AppIcon";
import { useToast } from "../feedback/ToastProvider";
import { useToastPagePlacement } from "../feedback/ToastLayoutProvider";
import { listAssets, type CaptureAsset } from "../db/captureAssets";
import { getSetting } from "../db/kv";
import {
  createDocumentLink,
  createPurchase,
  createReceiptEvent,
  deleteDocumentLink,
  deletePurchase,
  getEventDetail,
  getItemHistory,
  lifeOverview,
  listDocumentLinks,
  listItems,
  listRecentPurchases,
  loadDefaultCurrency,
  relinkDocument,
  searchLife,
  updatePurchase,
} from "../db/life";
import { createTask, listTasks, toggleTask } from "../db/tasks";
import {
  formatLifeCurrencyTotals,
  formatLifeDate,
  formatMoneyMinor,
  normalizeCurrency,
  parseLifeDateInput,
  type LifeDocumentLink,
  type LifeEventDetail,
  type LifeItem,
  type LifeItemHistory,
  type LifePurchaseInput,
  type LifeRecentPurchase,
  type LifeSearchHit,
} from "../domain/life";
import type { NewTaskInput, Task } from "../domain/types";
import { describeError } from "../lib/errors";
import { useWindowInsets } from "../lib/insets";
import { sendReceiptToDesktop } from "../lib/life/receiptTransfer";
import { receiptAction, receiptCountText } from "../lib/life/receiptState";
import { createRequestGeneration } from "../lib/life/requestGeneration";
import {
  createLifeTaskWithReminder,
  LIFE_TASK_CATEGORY,
  toggleLifeTaskWithReminder,
} from "../lib/life/taskActions";
import type { Nav } from "../lib/nav";
import {
  notifyWidgetDataChanged,
} from "../lib/widgetSnapshot";
import { rescheduleAllReminders, SNOOZE_SETTING_KEY } from "../notifications/reminderEngine";
import { scheduleReminder } from "../notifications/reminders";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

const LIFE_CATEGORY = LIFE_TASK_CATEGORY;
const CURRENCIES = ["CNY", "USD", "EUR", "JPY", "GBP", "HKD", "KWD"];

type Sheet =
  | { type: "purchase" }
  | { type: "item"; id: string }
  | { type: "event"; id: string }
  | { type: "assets"; ownerType: "event" | "item"; ownerId: string; title: string }
  | { type: "relink"; linkId: string };

interface PurchaseForm {
  mode: "create" | "edit";
  eventId: string | null;
  name: string;
  dateText: string;
  quantity: string;
  unit: string;
  total: string;
  currency: string;
  merchant: string;
  category: string;
  note: string;
}

function todayText(): string {
  return formatLifeDate(Date.now());
}

function moneyInputText(minor: number, scale: number): string {
  const safeScale = Number.isInteger(scale) && scale >= 0 && scale <= 3 ? scale : 2;
  const factor = 10 ** safeScale;
  const whole = Math.floor(minor / factor);
  if (safeScale === 0) return String(whole);
  return `${whole}.${String(minor % factor).padStart(safeScale, "0")}`;
}

function emptyForm(currency: string): PurchaseForm {
  return {
    mode: "create",
    eventId: null,
    name: "",
    dateText: todayText(),
    quantity: "",
    unit: "",
    total: "",
    currency,
    merchant: "",
    category: "",
    note: "",
  };
}

export function LifeScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const { showToast } = useToast();
  useToastPagePlacement("bottom");

  const [overview, setOverview] = useState({ itemCount: 0, purchaseCount: 0, receiptCount: 0 });
  const [recent, setRecent] = useState<LifeRecentPurchase[]>([]);
  const [links, setLinks] = useState<LifeDocumentLink[]>([]);
  const [items, setItems] = useState<LifeItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LifeSearchHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [quickName, setQuickName] = useState("");
  const [savingQuick, setSavingQuick] = useState(false);

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [form, setForm] = useState<PurchaseForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<LifeItemHistory | null>(null);
  const [eventDetail, setEventDetail] = useState<LifeEventDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [receiptSendingId, setReceiptSendingId] = useState<string | null>(null);
  const [receiptProgress, setReceiptProgress] = useState<{
    linkId: string;
    done: number;
    total: number;
  } | null>(null);
  const receiptCancelRef = useRef(false);

  const [assetChoices, setAssetChoices] = useState<CaptureAsset[]>([]);
  const [assetBusy, setAssetBusy] = useState(false);

  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const [taskEditorOpen, setTaskEditorOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  /** 页面列表与详情各自有请求代际：快速切换/刷新时旧响应不得覆盖新状态。 */
  const refreshGeneration = useRef(createRequestGeneration());
  const detailGeneration = useRef(createRequestGeneration());

  const refresh = useCallback(async () => {
    const seq = refreshGeneration.current.next();
    setLoading(true);
    try {
      const [nextOverview, nextRecent, nextLinks, nextItems, lifeTasks] = await Promise.all([
        lifeOverview(),
        listRecentPurchases(8),
        listDocumentLinks(null, null, 40),
        listItems("", 40),
        // 生活待办在 SQLite 层按 category 过滤并限量，复用同一个 tasks 仓储。
        listTasks({ category: LIFE_CATEGORY, limit: 60 }),
      ]);
      if (!refreshGeneration.current.isCurrent(seq)) return;
      setOverview(nextOverview);
      setRecent(nextRecent);
      setLinks(nextLinks);
      setItems(nextItems);
      // 排序已由 SQL 完成（待办在前、截止时间升序），不再读全表后 JS 过滤。
      setTasks(lifeTasks);
      setError(null);
    } catch (reason) {
      if (!refreshGeneration.current.isCurrent(seq)) return;
      setError(describeError(reason));
    } finally {
      if (refreshGeneration.current.isCurrent(seq)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setHits([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void searchLife(keyword, 20)
        .then((next) => {
          if (active) setHits(next);
        })
        .catch((reason) => {
          if (active) setError(describeError(reason));
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  // ── 购买记录表单 ────────────────────────────────────────

  const openCreate = useCallback(
    (preset?: { name?: string; category?: string; unit?: string; currency?: string }) => {
      setFormError(null);
      void loadDefaultCurrency()
        .then((defaultCurrency) => {
          setForm({
            ...emptyForm(defaultCurrency),
            name: preset?.name ?? "",
            category: preset?.category ?? "",
            unit: preset?.unit ?? "",
            currency: preset?.currency || defaultCurrency,
          });
          setSheet({ type: "purchase" });
        })
        .catch((reason) => {
          showToast(`读取默认货币失败：${describeError(reason)}`, "warn");
          setForm({
            ...emptyForm(""),
            name: preset?.name ?? "",
            category: preset?.category ?? "",
            unit: preset?.unit ?? "",
            currency: preset?.currency ?? "",
          });
          setSheet({ type: "purchase" });
        });
    },
    [showToast],
  );

  const openEdit = useCallback(
    (
      detailValue: LifeItemHistory | null,
      purchase: LifeItemHistory["purchases"][number],
      eventItemCount: number,
    ) => {
      if (eventItemCount !== 1) {
        showToast("该记录包含多件商品，移动端暂不支持整组编辑", "warn");
        return;
      }
      setFormError(null);
      setForm({
        mode: "edit",
        eventId: purchase.eventId,
        name: purchase.itemName,
        dateText: formatLifeDate(purchase.occurredAt),
        quantity: purchase.quantityValue ?? "",
        unit: purchase.quantityUnit,
        total:
          purchase.totalPriceMinor === null
            ? ""
            : moneyInputText(purchase.totalPriceMinor, purchase.amountScale),
        currency: purchase.currency,
        merchant: purchase.merchant,
        category: detailValue?.item.category ?? "",
        note: purchase.note,
      });
      setSheet({ type: "purchase" });
    },
    [showToast],
  );

  const savePurchase = useCallback(async () => {
    if (!form || saving) return;
    setFormError(null);
    const name = form.name.trim();
    if (!name) {
      setFormError("请填写商品名称");
      return;
    }
    const occurredAt = parseLifeDateInput(form.dateText);
    if (occurredAt === null) {
      setFormError("日期格式应为 YYYY-MM-DD");
      return;
    }
    const total = form.total.trim();
    if (total && !form.currency) {
      setFormError("填写金额时必须选择货币");
      return;
    }
    setSaving(true);
    try {
      const input: LifePurchaseInput = {
        name,
        occurredAt,
        quantityValue: form.quantity.trim() || null,
        quantityUnit: form.unit.trim() || null,
        totalPrice: total || null,
        currency: form.currency ? normalizeCurrency(form.currency) : null,
        merchant: form.merchant.trim() || null,
        category: form.category.trim() || null,
        note: form.note.trim() || null,
      };
      let createdItemId: string | null = null;
      if (form.mode === "edit" && form.eventId) {
        await updatePurchase(form.eventId, input);
        showToast("购买记录已更新", "success");
      } else {
        const saved = await createPurchase(input);
        createdItemId = saved.itemId || null;
        showToast("购买记录已保存", "success");
        setQuickName("");
      }
      setForm(null);
      setSheet(null);
      await refresh();
      if (createdItemId) {
        await openItem(createdItemId);
      } else if (form.mode === "edit" && form.eventId) {
        await openEvent(form.eventId);
      }
    } catch (reason) {
      setFormError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }, [form, saving, refresh, showToast]);
  // openItem/openEvent 在下方定义；保存回调只会在挂载后触发，不能把它们放进依赖数组，
  // 否则会在声明前求值（TDZ）。

  const quickSave = useCallback(async () => {
    const name = quickName.trim();
    if (!name) {
      showToast("请先输入商品名称", "warn");
      return;
    }
    setSavingQuick(true);
    try {
      const saved = await createPurchase({ name, occurredAt: Date.now() });
      setQuickName("");
      showToast("已记录购买", "success");
      await refresh();
      if (saved.itemId) await openItem(saved.itemId);
    } catch (reason) {
      showToast(`保存失败：${describeError(reason)}`, "danger");
    } finally {
      setSavingQuick(false);
    }
  }, [quickName, refresh, showToast]);

  // ── 详情 ───────────────────────────────────────────────

  const openItem = useCallback(async (itemId: string) => {
    const seq = detailGeneration.current.next();
    setDetailBusy(true);
    setDetail(null);
    setEventDetail(null);
    setSheet({ type: "item", id: itemId });
    try {
      const next = await getItemHistory(itemId, 50);
      if (!detailGeneration.current.isCurrent(seq)) return;
      if (!next) throw new Error("商品不存在或已删除");
      setDetail(next);
    } catch (reason) {
      // 旧请求失败不得关闭新详情，也不得弹出与新详情无关的报错。
      if (!detailGeneration.current.isCurrent(seq)) return;
      showToast(describeError(reason), "danger");
      setSheet(null);
    } finally {
      // 旧请求结束不得提前关掉新请求的 loading。
      if (detailGeneration.current.isCurrent(seq)) setDetailBusy(false);
    }
  }, [showToast]);

  const openEvent = useCallback(async (eventId: string) => {
    const seq = detailGeneration.current.next();
    setDetailBusy(true);
    setEventDetail(null);
    setDetail(null);
    setSheet({ type: "event", id: eventId });
    try {
      const next = await getEventDetail(eventId);
      if (!detailGeneration.current.isCurrent(seq)) return;
      if (!next) throw new Error("生活记录不存在或已删除");
      setEventDetail(next);
    } catch (reason) {
      if (!detailGeneration.current.isCurrent(seq)) return;
      showToast(describeError(reason), "danger");
      setSheet(null);
    } finally {
      if (detailGeneration.current.isCurrent(seq)) setDetailBusy(false);
    }
  }, [showToast]);

  const previewLink = useCallback(
    (link: LifeDocumentLink) => {
      if (link.transferState === "missing") {
        showToast("票据原文件缺失：关联仍保留，但图片已被删除或未传输", "warn");
        return;
      }
      if (!link.localUri) {
        showToast(
          link.documentSource === "shelf_item"
            ? "这张票据的原图在电脑端，手机尚未收到；请从电脑文件互传发送到手机后再预览"
            : "票据原图尚未传输到本机，请在「本机素材」中重新发送或重新采集",
          "warn",
        );
        return;
      }
      if (link.mime.startsWith("image/")) {
        setLightbox({
          images: [{ uri: link.localUri, name: link.documentName || "生活票据" }],
          index: 0,
        });
        return;
      }
      showToast("这是一份文件票据（非图片），请在系统文件应用或电脑端打开", "info");
    },
    [showToast],
  );

  const removeLink = useCallback(
    (link: LifeDocumentLink) => {
      Alert.alert("解除票据关联？", "只解除关联，原始图片不会被删除。", [
        { text: "取消", style: "cancel" },
        {
          text: "解除",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteDocumentLink(link.id);
                showToast("已解除关联，原文件未删除", "success");
                await refresh();
                if (eventDetail) await openEvent(eventDetail.eventId);
                else if (detail) await openItem(detail.item.id);
              } catch (reason) {
                showToast(`解除失败：${describeError(reason)}`, "danger");
              }
            })();
          },
        },
      ]);
    },
    [detail, eventDetail, openEvent, openItem, refresh, showToast],
  );

  const confirmDeletePurchase = useCallback(
    (eventId: string) => {
      Alert.alert("删除这条生活记录？", "购买历史会从两端删除；原始票据文件不会删除。", [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deletePurchase(eventId);
                setSheet(null);
                showToast("生活记录已删除", "success");
                await refresh();
              } catch (reason) {
                showToast(`删除失败：${describeError(reason)}`, "danger");
              }
            })();
          },
        },
      ]);
    },
    [refresh, showToast],
  );

  // ── 票据关联 ───────────────────────────────────────────

  const openAssetPicker = useCallback(
    async (ownerType: "event" | "item", ownerId: string, title: string) => {
      setSheet({ type: "assets", ownerType, ownerId, title });
      setAssetChoices([]);
      setAssetBusy(true);
      try {
        const assets = await listAssets("saved");
        setAssetChoices(
          assets.filter(
            (asset) =>
              Boolean(asset.localPath) &&
              (asset.kind === "photo" || asset.kind === "scan" || asset.kind === "file"),
          ),
        );
      } catch (reason) {
        showToast(`读取本机素材失败：${describeError(reason)}`, "danger");
      } finally {
        setAssetBusy(false);
      }
    },
    [showToast],
  );

  const attachAsset = useCallback(
    async (asset: CaptureAsset) => {
      if (!sheet || sheet.type !== "assets") return;
      if (!asset.localPath) {
        showToast("该素材文件已不在本机，无法关联", "warn");
        return;
      }
      setAssetBusy(true);
      try {
        await createDocumentLink({
          ownerType: sheet.ownerType,
          ownerId: sheet.ownerId,
          documentRef: asset.id,
          documentSource: "capture_asset",
          documentName: asset.name,
          mime: asset.mime,
          byteSize: asset.byteSize,
          transferState: "local",
        });
        showToast("票据已关联", "success");
        setSheet(null);
        await refresh();
        if (sheet.ownerType === "event") await openEvent(sheet.ownerId);
        else await openItem(sheet.ownerId);
      } catch (reason) {
        showToast(`关联失败：${describeError(reason)}`, "danger");
      } finally {
        setAssetBusy(false);
      }
    },
    [sheet, refresh, openEvent, openItem, showToast],
  );

  const saveAsReceipt = useCallback(
    async (asset: CaptureAsset) => {
      if (!asset.localPath) {
        showToast("该素材文件已不在本机，无法保存为票据", "warn");
        return;
      }
      setAssetBusy(true);
      try {
        await createReceiptEvent({
          name: asset.name,
          assetId: asset.id,
          mime: asset.mime,
          byteSize: asset.byteSize,
        });
        showToast("已保存为生活票据", "success");
        setSheet(null);
        await refresh();
      } catch (reason) {
        showToast(`保存失败：${describeError(reason)}`, "danger");
      } finally {
        setAssetBusy(false);
      }
    },
    [refresh, showToast],
  );

  const openRelink = useCallback((linkId: string) => {
    setSheet({ type: "relink", linkId });
  }, []);

  const sendLink = useCallback(
    async (link: LifeDocumentLink) => {
      receiptCancelRef.current = false;
      setReceiptSendingId(link.id);
      setReceiptProgress({ linkId: link.id, done: 0, total: 0 });
      try {
        const outcome = await sendReceiptToDesktop(link.id, {
          isCancelled: () => receiptCancelRef.current,
          onProgress: (done, total) =>
            setReceiptProgress({ linkId: link.id, done, total }),
        });
        showToast(`票据已导入电脑暂存架：${outcome.name}`, "success");
        if (sheet?.type === "event") await openEvent(sheet.id);
        else if (sheet?.type === "item") await openItem(sheet.id);
        await refresh();
      } catch (reason) {
        if (receiptCancelRef.current) {
          showToast(describeError(reason), "warn");
        } else {
          showToast(describeError(reason), "danger");
        }
        // 失败也要刷新：上传成功但导入失败会落成 metadata_only，原文件缺失会落成 missing。
        // 不刷新会让详情页仍显示旧按钮和旧徽标，用户看到的与数据库真实状态不一致。
        try {
          await refresh();
          if (sheet?.type === "event") await openEvent(sheet.id);
          else if (sheet?.type === "item") await openItem(sheet.id);
        } catch (refreshError) {
          showToast(`票据状态已更新，但刷新失败：${describeError(refreshError)}`, "warn");
        }
      } finally {
        setReceiptSendingId(null);
        setReceiptProgress(null);
      }
    },
    [openEvent, openItem, refresh, sheet, showToast],
  );

  const cancelReceiptSend = useCallback((linkId: string) => {
    if (receiptSendingId !== linkId) return;
    receiptCancelRef.current = true;
  }, [receiptSendingId]);

  const applyRelink = useCallback(
    async (ownerType: "event" | "item", ownerId: string) => {
      if (!sheet || sheet.type !== "relink") return;
      try {
        await relinkDocument(sheet.linkId, ownerType, ownerId);
        showToast("票据关联已更新", "success");
        setSheet(null);
        await refresh();
        if (eventDetail) await openEvent(eventDetail.eventId);
      } catch (reason) {
        showToast(`修改关联失败：${describeError(reason)}`, "danger");
      }
    },
    [sheet, eventDetail, openEvent, refresh, showToast],
  );

  // ── 任务 ───────────────────────────────────────────────

  const toggleLifeTask = useCallback(
    async (task: Task) => {
      let outcome: Awaited<ReturnType<typeof toggleTask>>;
      let reminderWarning: string | null;
      try {
        const result = await toggleLifeTaskWithReminder(task.id, {
          toggleTask,
          rescheduleAllReminders,
        });
        outcome = result.outcome;
        reminderWarning = result.reminderWarning;
      } catch (reason) {
        showToast(`更新待办失败：${describeError(reason)}`, "danger");
        return;
      }
      if (!outcome.task) {
        showToast("任务已不存在", "danger");
        return;
      }
      // 任务状态已真实落库；提醒重排失败只能提示提醒异常，不能把完成说成失败。
      try {
        notifyWidgetDataChanged();
      } catch {
        // 小组件刷新是派生展示，失败不影响任务数据。
      }
      try {
        await refresh();
      } catch (reason) {
        showToast(`待办状态已更新，但列表刷新失败：${describeError(reason)}`, "warn");
      }
      if (reminderWarning) {
        showToast(`待办状态已更新，但${reminderWarning}`, "warn");
      }
    },
    [refresh, showToast],
  );

  const submitTask = useCallback(
    async (input: NewTaskInput): Promise<TaskSubmitOutcome> => {
      let reminderWarning: string | null;
      try {
        const result = await createLifeTaskWithReminder(input, {
          createTask,
          getSetting,
          scheduleReminder,
          snoozeSettingKey: SNOOZE_SETTING_KEY,
        });
        reminderWarning = result.reminderWarning;
      } catch (reason) {
        // 写库失败：把原因交回 TaskEditorSheet，由弹层保留输入并提示（不再先关弹层）
        return { ok: false, message: describeError(reason) };
      }
      // 任务已保存；提醒是独立的异步排期，失败不得回滚或谎报保存失败。
      if (reminderWarning) {
        showToast(`待办已保存，但${reminderWarning}`, "warn");
      } else {
        showToast("生活待办已添加", "success");
      }
      try {
        notifyWidgetDataChanged();
      } catch {
        // 派生展示刷新失败不改变任务已保存的事实。
      }
      try {
        await refresh();
      } catch (reason) {
        showToast(`待办已保存，但列表刷新失败：${describeError(reason)}`, "warn");
      }
      return { ok: true, notice: reminderWarning ?? undefined };
    },
    [refresh, showToast],
  );

  const openSearchHit = useCallback(
    async (hit: LifeSearchHit) => {
      if (hit.kind === "item") await openItem(hit.id);
      else if (hit.kind === "event") await openEvent(hit.id);
      else {
        if (hit.ownerType === "item") await openItem(hit.id);
        else await openEvent(hit.id);
      }
    },
    [openEvent, openItem],
  );

  const pendingTasks = useMemo(
    () => tasks.filter((task) => task.status === "pending"),
    [tasks],
  );
  // 已完成任务复用同一批查询结果，不新建任务仓库；恢复也复用 toggleTask。
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.status !== "pending"),
    [tasks],
  );
  const doneCount = completedTasks.length;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title="生活"
        onBack={nav.back}
        right={
          <HeaderIconButton
            icon="add"
            accessibilityLabel="记录购买"
            onPress={() => openCreate()}
          />
        }
      />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
        keyboardShouldPersistTaps="handled"
      >
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索商品，例如「大米」"
          accessibilityLabel="搜索生活记录"
        />

        {error && (
          <View style={[styles.errorCard, { borderColor: tokens.danger, backgroundColor: tokens.card }]}>
            <Text style={[styles.errorText, { color: tokens.danger }]}>加载失败：{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => void refresh()}>
              <Text style={[styles.linkText, { color: tokens.accentText }]}>重试</Text>
            </Pressable>
          </View>
        )}

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={tokens.accent} />
            <Text style={[styles.muted, { color: tokens.muted }]}>读取本机生活记录…</Text>
          </View>
        ) : (
          <>
            {query.trim() ? (
              <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
                <Text style={[styles.sectionTitle, { color: tokens.text }]}>搜索结果</Text>
                {hits.length === 0 ? (
                  <Text style={[styles.emptyText, { color: tokens.muted }]}>
                    尚无购买记录
                  </Text>
                ) : (
                  hits.map((hit) => (
                    <Pressable
                      key={`${hit.kind}:${hit.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={hit.title}
                      onPress={() => void openSearchHit(hit)}
                      style={({ pressed }) => [
                        styles.row,
                        { borderColor: tokens.separator, opacity: pressed ? 0.7 : 1 },
                      ]}
                    >
                      <View style={styles.rowMain}>
                        <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                          {hit.title}
                        </Text>
                        <Text style={[styles.rowMeta, { color: tokens.muted }]} numberOfLines={1}>
                          {hit.subtitle}
                        </Text>
                      </View>
                      <Text style={[styles.kindTag, { color: tokens.accentText, backgroundColor: tokens.accentSoft }]}>
                        {hit.kind === "item" ? "商品" : hit.kind === "event" ? "记录" : "票据"}
                      </Text>
                    </Pressable>
                  ))
                )}
              </View>
            ) : null}

            <View style={styles.statRow}>
              <View style={[styles.stat, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
                <Text style={[styles.statValue, { color: tokens.text }]}>{overview.itemCount}</Text>
                <Text style={[styles.statLabel, { color: tokens.muted }]}>商品</Text>
              </View>
              <View style={[styles.stat, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
                <Text style={[styles.statValue, { color: tokens.text }]}>{overview.purchaseCount}</Text>
                <Text style={[styles.statLabel, { color: tokens.muted }]}>购买</Text>
              </View>
              <View style={[styles.stat, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
                <Text style={[styles.statValue, { color: tokens.text }]}>{overview.receiptCount}</Text>
                <Text style={[styles.statLabel, { color: tokens.muted }]}>票据</Text>
              </View>
            </View>

            <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <Text style={[styles.sectionTitle, { color: tokens.text }]}>快速记录</Text>
              <Text style={[styles.hint, { color: tokens.muted }]}>
                只填商品名称即可保存；数量、金额、商家可在详情里补充。
              </Text>
              <View style={styles.quickRow}>
                <TextInput
                  underlineColorAndroid="transparent"
                  value={quickName}
                  onChangeText={setQuickName}
                  placeholder="买了什么？例如 大米"
                  placeholderTextColor={tokens.muted}
                  style={[
                    styles.quickInput,
                    { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent },
                  ]}
                  accessibilityLabel="商品名称"
                  returnKeyType="done"
                  onSubmitEditing={() => void quickSave()}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="保存购买记录"
                  disabled={savingQuick}
                  onPress={() => void quickSave()}
                  style={({ pressed }) => [
                    styles.quickButton,
                    { backgroundColor: savingQuick ? tokens.muted : tokens.accentFill, opacity: pressed ? 0.8 : 1 },
                  ]}
                >
                  {savingQuick ? (
                    <ActivityIndicator color={tokens.onAccent} size="small" />
                  ) : (
                    <Text style={[styles.quickButtonText, { color: tokens.onAccent }]}>记录</Text>
                  )}
                </Pressable>
              </View>
              <View style={styles.inlineActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => openCreate({ name: quickName.trim() })}
                >
                  <Text style={[styles.linkText, { color: tokens.accentText }]}>补充日期 / 数量 / 金额</Text>
                </Pressable>
              </View>
            </View>

            <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <View style={styles.sectionHead}>
                <Text style={[styles.sectionTitle, { color: tokens.text }]}>最近购买</Text>
                <Text style={[styles.sectionMeta, { color: tokens.muted }]}>{recent.length} 条</Text>
              </View>
              {recent.length === 0 ? (
                <Text style={[styles.emptyText, { color: tokens.muted }]}>尚无购买记录</Text>
              ) : (
                recent.map((purchase) => (
                  <Pressable
                    key={purchase.eventId}
                    accessibilityRole="button"
                    accessibilityLabel={`查看 ${purchase.itemNames.join("、")}`}
                    onPress={() => void openEvent(purchase.eventId)}
                    style={({ pressed }) => [styles.row, { borderColor: tokens.separator, opacity: pressed ? 0.7 : 1 }]}
                  >
                    <View style={styles.rowMain}>
                      <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                        {purchase.itemNames.join("、") || purchase.title}
                      </Text>
                      <Text style={[styles.rowMeta, { color: tokens.muted }]} numberOfLines={1}>
                        {[formatLifeDate(purchase.occurredAt), purchase.merchant, purchase.linkCount > 0 ? `${purchase.linkCount} 张票据` : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    <Text style={[styles.amount, { color: tokens.text }]}>
                      {formatLifeCurrencyTotals(purchase.totals) || "未记金额"}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>

            <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <View style={styles.sectionHead}>
                <Text style={[styles.sectionTitle, { color: tokens.text }]}>生活待办</Text>
                <View style={styles.inlineActions}>
                  <Text style={[styles.sectionMeta, { color: tokens.muted }]}>分类 LIFE</Text>
                  {doneCount > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={showCompleted ? "收起已完成待办" : "查看已完成待办"}
                      onPress={() => setShowCompleted((value) => !value)}
                    >
                      <Text style={[styles.linkText, { color: tokens.accentText }]}>
                        {showCompleted ? "收起已完成" : `已完成 ${doneCount}`}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable accessibilityRole="button" onPress={() => setTaskEditorOpen(true)}>
                    <Text style={[styles.linkText, { color: tokens.accentText }]}>新增</Text>
                  </Pressable>
                </View>
              </View>
              {pendingTasks.length === 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setTaskEditorOpen(true)}
                  style={({ pressed }) => [styles.emptyAction, { borderColor: tokens.cardBorder, opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text style={[styles.emptyText, { color: tokens.muted }]}>暂无生活待办，点这里新增</Text>
                </Pressable>
              ) : (
                pendingTasks.slice(0, 6).map((task) => (
                  <View key={task.id} style={[styles.taskRow, { borderColor: tokens.separator }]}>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: false }}
                      accessibilityLabel={`完成 ${task.title}`}
                      onPress={() => void toggleLifeTask(task)}
                      style={[styles.taskCheck, { borderColor: tokens.accent }]}
                    >
                      <AppIcon name="check" color={tokens.accentText} size={14} />
                    </Pressable>
                    <View style={styles.rowMain}>
                      <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                        {task.title}
                      </Text>
                      <Text style={[styles.rowMeta, { color: tokens.muted }]}>
                        {task.remindAt
                          ? `提醒 ${formatLifeDate(task.remindAt)}`
                          : task.dueAt
                            ? `截止 ${formatLifeDate(task.dueAt)}`
                            : "未设置时间"}
                      </Text>
                    </View>
                  </View>
                ))
              )}
              {/* 已完成入口复用 toggleTask：查看与恢复都不复制任务操作逻辑。 */}
              {showCompleted
                ? completedTasks.slice(0, 8).map((task) => (
                    <View key={task.id} style={[styles.taskRow, { borderColor: tokens.separator }]}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`恢复 ${task.title}`}
                        onPress={() => void toggleLifeTask(task)}
                        style={({ pressed }) => [styles.restoreButton, { opacity: pressed ? 0.7 : 1 }]}
                      >
                        <Text style={[styles.linkText, { color: tokens.accentText }]}>恢复</Text>
                      </Pressable>
                      <View style={styles.rowMain}>
                        <Text style={[styles.rowTitle, { color: tokens.muted }]} numberOfLines={1}>
                          {task.title}
                        </Text>
                        <Text style={[styles.rowMeta, { color: tokens.muted }]}>已完成</Text>
                      </View>
                    </View>
                  ))
                : null}
            </View>

            <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
              <View style={styles.sectionHead}>
                <Text style={[styles.sectionTitle, { color: tokens.text }]}>票据资料</Text>
                <Text style={[styles.sectionMeta, { color: tokens.muted }]}>只存引用</Text>
              </View>
              {links.length === 0 ? (
                <Text style={[styles.emptyText, { color: tokens.muted }]}>
                  暂无票据。拍摄小票后可在采集处理页「保存为生活票据」，或在购买记录里关联本机素材。
                </Text>
              ) : (
                links.slice(0, 8).map((link) => (
                  <Pressable
                    key={link.id}
                    accessibilityRole="button"
                    accessibilityLabel={`查看票据 ${link.documentName}`}
                    onPress={() => previewLink(link)}
                    style={({ pressed }) => [styles.row, { borderColor: tokens.separator, opacity: pressed ? 0.7 : 1 }]}
                  >
                    <AppIcon name="fileImage" color={tokens.muted} size={16} />
                    <View style={styles.rowMain}>
                      <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                        {link.documentName || "生活票据"}
                      </Text>
                      <Text style={[styles.rowMeta, { color: tokens.muted }]}>{receiptCountText(link)}</Text>
                    </View>
                    {receiptAction(link) === "send" || receiptAction(link) === "resume" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={
                          receiptSendingId === link.id ? "取消票据发送" : "发送票据到电脑"
                        }
                        onPress={() =>
                          receiptSendingId === link.id
                            ? cancelReceiptSend(link.id)
                            : void sendLink(link)
                        }
                      >
                        <Text style={[styles.linkText, { color: tokens.accentText }]}>
                          {receiptSendingId === link.id
                            ? `取消发送${
                                receiptProgress?.linkId === link.id &&
                                receiptProgress.total > 0
                                  ? ` ${Math.round(
                                      (receiptProgress.done / receiptProgress.total) * 100,
                                    )}%`
                                  : "…"
                              }`
                            : receiptAction(link) === "resume"
                              ? "继续导入"
                              : "发送"}
                        </Text>
                      </Pressable>
                    ) : (
                      <AppIcon name="chevronRight" color={tokens.muted} size={14} />
                    )}
                  </Pressable>
                ))
              )}
            </View>

            {items.length > 0 ? (
              <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
                <View style={styles.sectionHead}>
                  <Text style={[styles.sectionTitle, { color: tokens.text }]}>商品</Text>
                  <Text style={[styles.sectionMeta, { color: tokens.muted }]}>{items.length} 个</Text>
                </View>
                {items.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`查看 ${item.name} 的购买历史`}
                    onPress={() => void openItem(item.id)}
                    style={({ pressed }) => [styles.row, { borderColor: tokens.separator, opacity: pressed ? 0.7 : 1 }]}
                  >
                    <View style={styles.rowMain}>
                      <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>{item.name}</Text>
                      <Text style={[styles.rowMeta, { color: tokens.muted }]} numberOfLines={1}>
                        {item.category || "未分类"}
                        {item.aliases.length > 0 ? ` · ${item.aliases.join("、")}` : ""}
                      </Text>
                    </View>
                    <AppIcon name="chevronRight" color={tokens.muted} size={14} />
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* 购买记录表单 */}
      <BottomSheet
        visible={sheet?.type === "purchase"}
        onRequestClose={() => {
          if (!saving) {
            setForm(null);
            setSheet(null);
          }
        }}
        keyboardAware
        accessibilityLabel="购买记录表单"
      >
        {form && (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
            <Text style={[styles.sheetTitle, { color: tokens.text }]}>
              {form.mode === "edit" ? "编辑购买记录" : "记录购买"}
            </Text>
            {formError && (
              <Text style={[styles.formError, { color: tokens.danger }]}>{formError}</Text>
            )}
            <Text style={[styles.fieldLabel, { color: tokens.muted }]}>商品名称 *</Text>
            <TextInput
              underlineColorAndroid="transparent"
              value={form.name}
              onChangeText={(name) => setForm({ ...form, name })}
              placeholder="例如 大米"
              placeholderTextColor={tokens.muted}
              style={[styles.input, { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
              accessibilityLabel="商品名称"
              autoFocus
            />

            <Text style={[styles.fieldLabel, { color: tokens.muted }]}>实际购买日期</Text>
            <View style={styles.chipRow}>
              {[
                { label: "今天", value: formatLifeDate(Date.now()) },
                { label: "昨天", value: formatLifeDate(Date.now() - 86_400_000) },
              ].map((preset) => (
                <Pressable
                  key={preset.label}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: form.dateText === preset.value }}
                  onPress={() => setForm({ ...form, dateText: preset.value })}
                  style={[
                    styles.chip,
                    {
                      borderColor: form.dateText === preset.value ? tokens.accentFill : tokens.cardBorder,
                      backgroundColor: form.dateText === preset.value ? tokens.accentSoft : tokens.bgAccent,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: form.dateText === preset.value ? tokens.accentText : tokens.textSoft }]}>
                    {preset.label}
                  </Text>
                </Pressable>
              ))}
              <TextInput
                underlineColorAndroid="transparent"
                value={form.dateText}
                onChangeText={(dateText) => setForm({ ...form, dateText })}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={tokens.muted}
                style={[styles.dateInput, { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
                accessibilityLabel="购买日期"
              />
            </View>

            <View style={styles.formRow}>
              <View style={styles.formCol}>
                <Text style={[styles.fieldLabel, { color: tokens.muted }]}>数量</Text>
                <TextInput
                  underlineColorAndroid="transparent"
                  value={form.quantity}
                  onChangeText={(quantity) => setForm({ ...form, quantity })}
                  placeholder="支持小数"
                  placeholderTextColor={tokens.muted}
                  keyboardType="decimal-pad"
                  style={[styles.input, { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
                  accessibilityLabel="数量"
                />
              </View>
              <View style={styles.formCol}>
                <Text style={[styles.fieldLabel, { color: tokens.muted }]}>单位</Text>
                <TextInput
                  underlineColorAndroid="transparent"
                  value={form.unit}
                  onChangeText={(unit) => setForm({ ...form, unit })}
                  placeholder="kg / 袋 / 个"
                  placeholderTextColor={tokens.muted}
                  style={[styles.input, { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
                  accessibilityLabel="单位"
                />
              </View>
            </View>

            <View style={styles.formRow}>
              <View style={styles.formCol}>
                <Text style={[styles.fieldLabel, { color: tokens.muted }]}>金额</Text>
                <TextInput
                  underlineColorAndroid="transparent"
                  value={form.total}
                  onChangeText={(total) => setForm({ ...form, total })}
                  placeholder="48.00"
                  placeholderTextColor={tokens.muted}
                  keyboardType="decimal-pad"
                  style={[styles.input, { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
                  accessibilityLabel="金额"
                />
              </View>
              <View style={styles.formCol}>
                <Text style={[styles.fieldLabel, { color: tokens.muted }]}>货币</Text>
                {form.total.trim() === "" ? (
                  <Text style={[styles.noCurrency, { color: tokens.muted }]}>未填金额</Text>
                ) : (
                  <View style={styles.chipRow}>
                    {CURRENCIES.map((currency) => (
                      <Pressable
                        key={currency}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: form.currency === currency }}
                        onPress={() => setForm({ ...form, currency })}
                        style={[
                          styles.chip,
                          {
                            borderColor: form.currency === currency ? tokens.accentFill : tokens.cardBorder,
                            backgroundColor: form.currency === currency ? tokens.accentSoft : tokens.bgAccent,
                          },
                        ]}
                      >
                        <Text style={[styles.chipText, { color: form.currency === currency ? tokens.accentText : tokens.textSoft }]}>
                          {currency}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            </View>

            <Text style={[styles.fieldLabel, { color: tokens.muted }]}>商家（选填）</Text>
            <TextInput
              underlineColorAndroid="transparent"
              value={form.merchant}
              onChangeText={(merchant) => setForm({ ...form, merchant })}
              placeholder="例如 某超市"
              placeholderTextColor={tokens.muted}
              style={[styles.input, { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
              accessibilityLabel="商家"
            />

            <Text style={[styles.fieldLabel, { color: tokens.muted }]}>备注（选填）</Text>
            <TextInput
              underlineColorAndroid="transparent"
              value={form.note}
              onChangeText={(note) => setForm({ ...form, note })}
              placeholder="例如 普通袋装"
              placeholderTextColor={tokens.muted}
              multiline
              style={[styles.noteInput, { color: tokens.text, borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
              accessibilityLabel="备注"
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="保存购买记录"
              disabled={saving}
              onPress={() => void savePurchase()}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: saving ? tokens.muted : tokens.accentFill, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              {saving ? <ActivityIndicator color={tokens.onAccent} size="small" /> : null}
              <Text style={[styles.primaryButtonText, { color: tokens.onAccent }]}>保存</Text>
            </Pressable>
            {form.mode === "edit" && (
              <Text style={[styles.hint, { color: tokens.muted }]}>
                保存后会同时更新两端；若另一端也改过同一记录，同步中心会提示冲突，不会静默覆盖。
              </Text>
            )}
          </ScrollView>
        )}
      </BottomSheet>

      {/* 商品历史 */}
      <BottomSheet
        visible={sheet?.type === "item"}
        onRequestClose={() => setSheet(null)}
        maxHeightRatio={0.9}
        accessibilityLabel="商品购买历史"
      >
        {detailBusy || !detail ? (
          <View style={styles.sheetLoading}>
            <ActivityIndicator color={tokens.accent} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <Text style={[styles.sheetTitle, { color: tokens.text }]}>{detail.item.name}</Text>
            <Text style={[styles.hint, { color: tokens.muted }]}>
              {detail.item.category || "未分类"}
              {detail.item.aliases.length > 0 ? ` · 别名：${detail.item.aliases.join("、")}` : ""}
            </Text>
            <View style={styles.detailStats}>
              <View style={styles.detailStat}>
                <Text style={[styles.detailStatLabel, { color: tokens.muted }]}>最近购买</Text>
                <Text style={[styles.detailStatValue, { color: tokens.text }]}>
                  {detail.purchases[0] ? formatLifeDate(detail.purchases[0].occurredAt) : "尚无记录"}
                </Text>
              </View>
              <View style={styles.detailStat}>
                <Text style={[styles.detailStatLabel, { color: tokens.muted }]}>购买次数</Text>
                <Text style={[styles.detailStatValue, { color: tokens.text }]}>{detail.totalCount}</Text>
              </View>
              <View style={styles.detailStat}>
                <Text style={[styles.detailStatLabel, { color: tokens.muted }]}>两次间隔</Text>
                <Text style={[styles.detailStatValue, { color: tokens.text }]}>
                  {detail.intervalDays === null ? "暂无足够记录" : `${detail.intervalDays} 天`}
                </Text>
              </View>
            </View>

            <View style={styles.inlineActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  openCreate({
                    name: detail.item.name,
                    category: detail.item.category,
                    unit: detail.purchases[0]?.quantityUnit,
                    currency: detail.purchases[0]?.currency,
                  })
                }
              >
                <Text style={[styles.linkText, { color: tokens.accentText }]}>记录本次购买</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void openAssetPicker("item", detail.item.id, detail.item.name)}
              >
                <Text style={[styles.linkText, { color: tokens.accentText }]}>添加票据</Text>
              </Pressable>
            </View>

            <Text style={[styles.fieldLabel, { color: tokens.muted }]}>购买历史</Text>
            {detail.purchases.length === 0 ? (
              <Text style={[styles.emptyText, { color: tokens.muted }]}>尚无购买记录</Text>
            ) : (
              detail.purchases.map((purchase) => (
                <View key={purchase.itemRowId} style={[styles.historyRow, { borderColor: tokens.separator }]}>
                  <View style={styles.rowMain}>
                    <Text style={[styles.rowTitle, { color: tokens.text }]}>
                      {formatLifeDate(purchase.occurredAt)}
                    </Text>
                    <Text style={[styles.rowMeta, { color: tokens.muted }]}>
                      {[
                        purchase.quantityValue ? `${purchase.quantityValue}${purchase.quantityUnit}` : "",
                        purchase.merchant,
                        purchase.note,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "未记录数量/商家"}
                    </Text>
                    {purchase.links.length > 0 && (
                      <View style={styles.chipRow}>
                        {purchase.links.map((link) => (
                          <Pressable
                            key={link.id}
                            accessibilityRole="button"
                            onPress={() => previewLink(link)}
                            style={[styles.chip, { borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
                          >
                            <Text style={[styles.chipText, { color: tokens.accentText }]} numberOfLines={1}>
                              {link.documentName || "票据"}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>
                  <Text style={[styles.amount, { color: tokens.text }]}>
                    {formatMoneyMinor(
                      purchase.totalPriceMinor,
                      purchase.currency,
                      purchase.amountScale,
                    ) || "未记金额"}
                  </Text>
                  <View style={styles.rowActions}>
                    <HeaderIconButton
                      icon="edit"
                      accessibilityLabel="编辑这条购买记录"
                      onPress={() => {
                        void (async () => {
                          try {
                            const event = await getEventDetail(purchase.eventId);
                            if (!event) throw new Error("购买记录不存在");
                            openEdit(detail, purchase, event.items.length);
                          } catch (reason) {
                            showToast(describeError(reason), "danger");
                          }
                        })();
                      }}
                    />
                    <HeaderIconButton
                      icon="delete"
                      accessibilityLabel="删除这条生活记录"
                      onPress={() => confirmDeletePurchase(purchase.eventId)}
                    />
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        )}
      </BottomSheet>

      {/* 生活记录详情 */}
      <BottomSheet
        visible={sheet?.type === "event"}
        onRequestClose={() => setSheet(null)}
        maxHeightRatio={0.9}
        accessibilityLabel="生活记录详情"
      >
        {detailBusy || !eventDetail ? (
          <View style={styles.sheetLoading}>
            <ActivityIndicator color={tokens.accent} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <Text style={[styles.sheetTitle, { color: tokens.text }]}>
              {eventDetail.title || "生活记录"}
            </Text>
            <Text style={[styles.hint, { color: tokens.muted }]}>
              {[formatLifeDate(eventDetail.occurredAt), eventDetail.merchant, eventDetail.eventType === "purchase" ? "购买" : eventDetail.eventType === "maintenance" ? "维护" : "票据/生活"]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {eventDetail.items.length > 0 ? (
              eventDetail.items.map((item) => (
                <View key={item.id} style={[styles.historyRow, { borderColor: tokens.separator }]}>
                  <View style={styles.rowMain}>
                    <Text style={[styles.rowTitle, { color: tokens.text }]}>{item.itemName}</Text>
                    <Text style={[styles.rowMeta, { color: tokens.muted }]}>
                      {item.quantityValue ? `${item.quantityValue}${item.quantityUnit} · ` : ""}
                      {formatMoneyMinor(item.totalPriceMinor, item.currency, item.amountScale) || "未记录金额"}
                    </Text>
                  </View>
                  {item.itemId && (
                    <Pressable accessibilityRole="button" onPress={() => void openItem(item.itemId!)}>
                      <Text style={[styles.linkText, { color: tokens.accentText }]}>历史</Text>
                    </Pressable>
                  )}
                </View>
              ))
            ) : (
              <Text style={[styles.emptyText, { color: tokens.muted }]}>这张票据尚未关联商品或购买记录。</Text>
            )}

            <Text style={[styles.fieldLabel, { color: tokens.muted }]}>关联票据</Text>
            {eventDetail.links.length === 0 ? (
              <Text style={[styles.emptyText, { color: tokens.muted }]}>未关联票据</Text>
            ) : (
              eventDetail.links.map((link) => (
                <View key={link.id} style={[styles.linkRow, { borderColor: tokens.separator }]}>
                  <Pressable accessibilityRole="button" onPress={() => previewLink(link)} style={styles.rowMain}>
                    <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                      {link.documentName || "生活票据"}
                    </Text>
                    <Text style={[styles.rowMeta, { color: tokens.muted }]}>{receiptCountText(link)}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" onPress={() => openRelink(link.id)}>
                    <Text style={[styles.linkText, { color: tokens.accentText }]}>改关联</Text>
                  </Pressable>
                  {(() => {
                    const action = receiptAction(link);
                    if (!action) return null;
                    if (action === "transferred") {
                      return (
                        <Text style={[styles.linkText, { color: tokens.muted }]}>已传输</Text>
                      );
                    }
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={
                          receiptSendingId === link.id ? "取消票据发送" : "发送票据到电脑"
                        }
                        onPress={() =>
                          receiptSendingId === link.id
                            ? cancelReceiptSend(link.id)
                            : void sendLink(link)
                        }
                      >
                        <Text style={[styles.linkText, { color: tokens.accentText }]}>
                          {receiptSendingId === link.id
                            ? `取消发送${
                                receiptProgress?.linkId === link.id &&
                                receiptProgress.total > 0
                                  ? ` ${Math.round(
                                      (receiptProgress.done / receiptProgress.total) * 100,
                                    )}%`
                                  : "…"
                              }`
                            : action === "resume"
                              ? "继续导入"
                              : "发送到电脑"}
                        </Text>
                      </Pressable>
                    );
                  })()}
                  <Pressable accessibilityRole="button" onPress={() => removeLink(link)}>
                    <Text style={[styles.linkText, { color: tokens.danger }]}>解除</Text>
                  </Pressable>
                </View>
              ))
            )}

            <View style={styles.sheetActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void openAssetPicker("event", eventDetail.eventId, eventDetail.title || "生活记录")}
                style={[styles.secondaryButton, { borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
              >
                <Text style={[styles.secondaryButtonText, { color: tokens.accentText }]}>添加票据</Text>
              </Pressable>
              {eventDetail.eventType === "purchase" && eventDetail.items.length === 1 && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    const purchase = {
                      itemRowId: eventDetail.items[0].id,
                      eventId: eventDetail.eventId,
                      itemId: eventDetail.items[0].itemId,
                      itemName: eventDetail.items[0].itemName,
                      occurredAt: eventDetail.occurredAt,
                      createdAt: eventDetail.occurredAt,
                      merchant: eventDetail.merchant,
                      quantityValue: eventDetail.items[0].quantityValue,
                      quantityUnit: eventDetail.items[0].quantityUnit,
                      unitPriceMinor: eventDetail.items[0].unitPriceMinor,
                      totalPriceMinor: eventDetail.items[0].totalPriceMinor,
                      currency: eventDetail.items[0].currency,
                      amountScale: eventDetail.items[0].amountScale,
                      note: eventDetail.items[0].note,
                      links: eventDetail.links,
                    };
                    if (detail) openEdit(detail, purchase, eventDetail.items.length);
                    else openEdit(null, purchase, eventDetail.items.length);
                  }}
                  style={[styles.secondaryButton, { borderColor: tokens.cardBorder, backgroundColor: tokens.bgAccent }]}
                >
                  <Text style={[styles.secondaryButtonText, { color: tokens.accentText }]}>编辑</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() => confirmDeletePurchase(eventDetail.eventId)}
                style={[styles.secondaryButton, { borderColor: tokens.danger, backgroundColor: tokens.bgAccent }]}
              >
                <Text style={[styles.secondaryButtonText, { color: tokens.danger }]}>删除</Text>
              </Pressable>
            </View>
          </ScrollView>
        )}
      </BottomSheet>

      {/* 票据素材选择 */}
      <BottomSheet
        visible={sheet?.type === "assets"}
        onRequestClose={() => setSheet(null)}
        maxHeightRatio={0.85}
        accessibilityLabel="选择票据素材"
      >
        <ScrollView contentContainerStyle={styles.sheetContent}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>添加票据</Text>
          <Text style={[styles.hint, { color: tokens.muted }]}>
            只保存本机素材引用，不复制图片。没有合适票据时，先到「采集」拍照或导入。
          </Text>
          {assetBusy ? (
            <View style={styles.sheetLoading}>
              <ActivityIndicator color={tokens.accent} />
            </View>
          ) : assetChoices.length === 0 ? (
            <Text style={[styles.emptyText, { color: tokens.muted }]}>
              本机素材库还没有已保存的照片或文件。请先在采集页保存到「本机暂存」。
            </Text>
          ) : (
            assetChoices.map((asset) => (
              <View key={asset.id} style={[styles.assetRow, { borderColor: tokens.separator }]}>
                <Pressable accessibilityRole="button" onPress={() => void attachAsset(asset)} style={styles.rowMain}>
                  <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>{asset.name}</Text>
                  <Text style={[styles.rowMeta, { color: tokens.muted }]}>
                    {asset.kind === "photo" ? "照片" : asset.kind === "scan" ? "扫描件" : "文件"} · {formatLifeDate(asset.createdAt)}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void saveAsReceipt(asset)}
                  style={[styles.smallButton, { backgroundColor: tokens.accentSoft }]}
                >
                  <Text style={[styles.smallButtonText, { color: tokens.accentText }]}>保存为票据</Text>
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>
      </BottomSheet>

      {/* 修改票据关联 */}
      <BottomSheet
        visible={sheet?.type === "relink"}
        onRequestClose={() => setSheet(null)}
        maxHeightRatio={0.85}
        accessibilityLabel="修改票据关联"
      >
        <ScrollView contentContainerStyle={styles.sheetContent}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>改关联到</Text>
          <Text style={[styles.hint, { color: tokens.muted }]}>原文件不移动；仅切换关联的生活记录。</Text>
          <Text style={[styles.fieldLabel, { color: tokens.muted }]}>购买记录</Text>
          {recent.map((purchase) => (
            <Pressable
              key={purchase.eventId}
              accessibilityRole="button"
              onPress={() => void applyRelink("event", purchase.eventId)}
              style={({ pressed }) => [styles.row, { borderColor: tokens.separator, opacity: pressed ? 0.7 : 1 }]}
            >
              <View style={styles.rowMain}>
                <Text style={[styles.rowTitle, { color: tokens.text }]} numberOfLines={1}>
                  {purchase.itemNames.join("、") || purchase.title}
                </Text>
                <Text style={[styles.rowMeta, { color: tokens.muted }]}>{formatLifeDate(purchase.occurredAt)}</Text>
              </View>
              <AppIcon name="chevronRight" color={tokens.muted} size={14} />
            </Pressable>
          ))}
          <Text style={[styles.fieldLabel, { color: tokens.muted }]}>商品</Text>
          {items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              onPress={() => void applyRelink("item", item.id)}
              style={({ pressed }) => [styles.row, { borderColor: tokens.separator, opacity: pressed ? 0.7 : 1 }]}
            >
              <View style={styles.rowMain}>
                <Text style={[styles.rowTitle, { color: tokens.text }]}>{item.name}</Text>
                <Text style={[styles.rowMeta, { color: tokens.muted }]}>{item.category || "未分类"}</Text>
              </View>
              <AppIcon name="chevronRight" color={tokens.muted} size={14} />
            </Pressable>
          ))}
        </ScrollView>
      </BottomSheet>

      <TaskEditorSheet
        visible={taskEditorOpen}
        mode="create"
        task={null}
        onClose={() => setTaskEditorOpen(false)}
        onSubmit={async (input) => submitTask(input)}
      />

      <ImageLightbox
        visible={Boolean(lightbox)}
        images={lightbox?.images ?? []}
        initialIndex={lightbox?.index ?? 0}
        onClose={() => setLightbox(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  loading: { alignItems: "center", gap: space.sm, paddingVertical: space.xl },
  errorCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    padding: space.sm,
    gap: space.xs,
  },
  errorText: { fontSize: font.label, lineHeight: 17 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.card,
    padding: space.md,
    gap: space.xs,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  sectionTitle: { fontSize: font.body, fontWeight: "700", flexShrink: 1 },
  sectionMeta: { fontSize: font.meta },
  hint: { fontSize: font.meta, lineHeight: 17 },
  emptyText: { fontSize: font.label, lineHeight: 18, paddingVertical: space.sm },
  emptyAction: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    padding: space.sm,
    alignItems: "center",
  },
  muted: { fontSize: font.label },
  statRow: { flexDirection: "row", gap: space.sm },
  stat: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingVertical: space.sm,
    alignItems: "center",
    gap: 1,
  },
  statValue: { fontSize: font.title, fontWeight: "800" },
  statLabel: { fontSize: font.meta },
  quickRow: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
  quickInput: {
    flex: 1,
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    fontSize: font.body,
  },
  quickButton: {
    minWidth: 72,
    minHeight: 46,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
  },
  quickButtonText: { fontSize: font.body, fontWeight: "700" },
  inlineActions: { flexDirection: "row", flexWrap: "wrap", gap: space.md, alignItems: "center" },
  linkText: { fontSize: font.label, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flex: 1, gap: 1, minWidth: 0 },
  rowTitle: { fontSize: font.label, fontWeight: "600" },
  rowMeta: { fontSize: font.meta, lineHeight: 15 },
  amount: { fontSize: font.label, fontWeight: "600", flexShrink: 0 },
  kindTag: {
    fontSize: font.meta,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
    flexShrink: 0,
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  taskCheck: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  restoreButton: {
    width: 40,
    alignItems: "center",
    paddingVertical: 2,
  },
  sheetContent: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.sm },
  sheetLoading: { paddingVertical: space.xl, alignItems: "center" },
  sheetTitle: { fontSize: font.title, fontWeight: "800" },
  fieldLabel: { fontSize: font.label, fontWeight: "600", marginTop: space.xs },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    fontSize: font.body,
  },
  noteInput: {
    minHeight: 60,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.body,
    textAlignVertical: "top",
  },
  formRow: { flexDirection: "row", gap: space.sm },
  formCol: { flex: 1, gap: space.xs, minWidth: 0 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, alignItems: "center" },
  chip: {
    minHeight: 32,
    paddingHorizontal: space.sm,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    maxWidth: "100%",
  },
  chipText: { fontSize: font.meta, fontWeight: "600" },
  dateInput: {
    minHeight: 36,
    minWidth: 120,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.sm,
    fontSize: font.label,
  },
  noCurrency: { fontSize: font.label, paddingVertical: space.xs },
  primaryButton: {
    minHeight: 48,
    borderRadius: radius.row,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    marginTop: space.sm,
  },
  primaryButtonText: { fontSize: font.body, fontWeight: "700" },
  formError: { fontSize: font.label, lineHeight: 17 },
  detailStats: { flexDirection: "row", gap: space.sm },
  detailStat: { flex: 1, gap: 1 },
  detailStatLabel: { fontSize: font.meta },
  detailStatValue: { fontSize: font.label, fontWeight: "700" },
  historyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm },
  secondaryButton: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: { fontSize: font.label, fontWeight: "600" },
  assetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  smallButton: {
    minHeight: 34,
    paddingHorizontal: space.sm,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
  },
  smallButtonText: { fontSize: font.meta, fontWeight: "600" },
});
