// 拍照后的统一处理页：预览 / 旋转 / 基础裁剪 / 重拍 / 多目的地保存。
//
// 交互约束：
// - 目的地必须由用户显式勾选，默认只勾「本机暂存」这一项也不替用户选择相册或电脑；
// - 一个目的地失败不会回滚其他目的地已完成的记录；结果按目的地分别显示；
// - 已完成的目的地再次点「保存」会跳过，不会重复上传或往相册塞第二份；
// - 裁剪使用源图像素坐标（按 contain 显示比例换算），只做基础矩形裁剪。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { AppBar } from "../../components/AppBar";
import { BottomSheet } from "../../components/BottomSheet";
import { PressableScale } from "../../components/PressableScale";
import { AppIcon } from "../../components/icons/AppIcon";
import { useToast } from "../../feedback/ToastProvider";
import { useToastBottomAnchor } from "../../feedback/ToastLayoutProvider";
import * as repo from "../../db/captureAssets";
import {
  createDocumentLink,
  createPurchase,
  createReceiptEvent,
  listRecentPurchases,
  loadDefaultCurrency,
} from "../../db/life";
import {
  formatLifeDate,
  formatMoneyMinor,
  parseLifeDateInput,
  type LifeRecentPurchase,
} from "../../domain/life";
import { AppError, describeError } from "../../lib/errors";
import { useWindowInsets } from "../../lib/insets";
import { useKeyboardHeight } from "../../lib/keyboard";
import type { Nav } from "../../lib/nav";
import { formatBytes } from "../../lib/sync/fileIo";
import { useTheme } from "../../theme/ThemeProvider";
import { font, radius, space } from "../../theme/tokens";

import { captureAvailability, cleanupStagedAfterRun, listShelfGroups, retryShelfImport, saveToAlbum, saveToLocal, sendToDesktop, transformStagedAsset, type DestinationChoice, type PairingAvailability, type SendProgress } from "./service";
import { createTransferCancelToken, type TransferCancelToken } from "./cancel";
import { deleteFileQuietly } from "./files";
import { bumpCaptureRevision } from "./revision";
import {
  CROP_DEFAULT,
  ImageCropOverlay,
  ZoomableImage,
  type CropFraction,
} from "./components/ImageCropOverlay";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── 目的地行 ────────────────────────────────────────────────

function CheckRow({
  checked,
  title,
  hint,
  disabled,
  onPress,
}: {
  checked: boolean;
  title: string;
  hint?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.checkRow,
        { borderColor: tokens.cardBorder, opacity: disabled ? 0.55 : pressed ? 0.75 : 1 },
      ]}
    >
      <View
        style={[
          styles.checkbox,
          {
            borderColor: checked ? tokens.accentFill : tokens.muted,
            backgroundColor: checked ? tokens.accentFill : "transparent",
          },
        ]}
      >
        {checked ? <AppIcon name="check" color={tokens.onAccent} size={14} /> : null}
      </View>
      <View style={styles.checkMain}>
        <Text style={[styles.checkTitle, { color: tokens.text }]}>{title}</Text>
        {hint ? <Text style={[styles.checkHint, { color: tokens.muted }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

// ── 页面 ────────────────────────────────────────────────────

export function CaptureReviewScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  // Android 16 edge-to-edge 下软键盘不吃 adjustResize：底部「保存」栏必须自己让位，
  // 否则输入文件名/备注时按钮被键盘整块盖住（与 BottomSheet 共用同一份键盘高度实现）。
  const keyboardHeight = useKeyboardHeight();
  const [assets, setAssets] = useState<repo.CaptureAsset[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [availability, setAvailability] = useState<PairingAvailability | null>(null);
  const [shelfGroups, setShelfGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [choice, setChoice] = useState<DestinationChoice>({
    local: true,
    album: false,
    desktop: false,
    desktopTarget: "inbox",
    shelfGroupId: null,
  });
  const [busy, setBusy] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [cancelable, setCancelable] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelTokenRef = useRef<TransferCancelToken | null>(null);
  const [destinations, setDestinations] = useState<Record<string, repo.CaptureDestination[]>>({});
  const [nameDraft, setNameDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  // 生活票据：不改变原有「保存到」的多目的地语义，只在用户显式打开这个面板时写生活库。
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptMode, setReceiptMode] = useState<"plain" | "link" | "create">("plain");
  const [receiptName, setReceiptName] = useState("");
  const [receiptDate, setReceiptDate] = useState(formatLifeDate(Date.now()));
  const [receiptPurchaseName, setReceiptPurchaseName] = useState("");
  const [receiptTotal, setReceiptTotal] = useState("");
  const [receiptCurrency, setReceiptCurrency] = useState("");
  const [receiptNote, setReceiptNote] = useState("");
  const [recentPurchases, setRecentPurchases] = useState<LifeRecentPurchase[]>([]);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [cropActive, setCropActive] = useState(false);
  const [cropFraction, setCropFraction] = useState<CropFraction>(CROP_DEFAULT);
  const [previewLayout, setPreviewLayout] = useState({ width: 0, height: 0 });
  const sessionIds = useRef<string[]>([]);

  const { showToast } = useToast();
  // 底部保存操作区会随键盘上移；登记实际高度让底部提示同时避开键盘与操作区。
  const bottomAnchor = useToastBottomAnchor(true, true);

  const requestCancelTransfer = useCallback(() => {
    if (!cancelTokenRef.current || cancelling) return;
    cancelTokenRef.current.cancel();
    setCancelling(true);
  }, [cancelling]);

  const current = assets[index] ?? null;
  // 扫描 PDF 不是位图：不显示缩放/裁剪工具，预览位置给文件卡片。
  const isImage = current?.mime.startsWith("image/") ?? false;

  const loadDestinations = useCallback(async (ids: string[]) => {
    const next: Record<string, repo.CaptureDestination[]> = {};
    for (const id of ids) next[id] = await repo.listDestinations(id);
    setDestinations(next);
  }, []);

  const reload = useCallback(async () => {
    const ids = sessionIds.current;
    if (ids.length === 0) {
      setAssets([]);
      return;
    }
    const loaded = (await Promise.all(ids.map((id) => repo.getAsset(id)))).filter(
      (asset): asset is repo.CaptureAsset => asset !== null,
    );
    setAssets(loaded);
    setIndex((prev) => clamp(prev, 0, Math.max(0, loaded.length - 1)));
    await loadDestinations(loaded.map((asset) => asset.id));
  }, [loadDestinations]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const staged = await repo.listStagedAssets();
        if (!active) return;
        sessionIds.current = staged.map((asset) => asset.id);
        setAssets(staged);
        setIndex(0);
        await loadDestinations(sessionIds.current);
        setAvailability(await captureAvailability());
      } catch (error) {
        // 首屏读取失败必须让用户看到原因；否则 loading 结束后只剩空列表，像是素材被清空。
        if (active) showToast(`读取采集暂存失败：${describeError(error)}`, "danger");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadDestinations, showToast]);

  useEffect(() => {
    setNameDraft(current?.name ?? "");
    setNoteDraft(current?.note ?? "");
    setCropActive(false);
    setCropFraction(CROP_DEFAULT);
  }, [current?.id, current?.name, current?.note]);

  const display = useMemo(() => {
    if (!current?.width || !current?.height || previewLayout.width <= 0) {
      return { x: 0, y: 0, width: previewLayout.width, height: previewLayout.height };
    }
    const ratio = Math.min(
      previewLayout.width / current.width,
      previewLayout.height / current.height,
    );
    const width = current.width * ratio;
    const height = current.height * ratio;
    return {
      x: (previewLayout.width - width) / 2,
      y: (previewLayout.height - height) / 2,
      width,
      height,
    };
  }, [current?.height, current?.width, previewLayout.height, previewLayout.width]);

  const commitName = useCallback(async () => {
    if (!current) return;
    const next = nameDraft.trim();
    if (!next || next === current.name) return;
    await repo.renameAsset(current.id, next);
    await reload();
    bumpCaptureRevision();
  }, [current, nameDraft, reload]);

  const commitNote = useCallback(async () => {
    if (!current || noteDraft === current.note) return;
    await repo.updateAssetNote(current.id, noteDraft);
    await reload();
    bumpCaptureRevision();
  }, [current, noteDraft, reload]);

  const rotate = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    setRunLabel("旋转图片…");
    try {
      await transformStagedAsset(current, { rotate: 90 });
      await reload();
      bumpCaptureRevision();
    } catch (error) {
      showToast(describeError(error), "danger");
    } finally {
      setBusy(false);
      setRunLabel("");
    }
  }, [busy, current, reload, showToast]);

  const applyCrop = useCallback(async () => {
    if (!current || busy || !current.width || !current.height) return;
    setBusy(true);
    setRunLabel("裁剪图片…");
    try {
      await transformStagedAsset(current, {
        crop: {
          x: Math.round(cropFraction.x * current.width),
          y: Math.round(cropFraction.y * current.height),
          width: Math.max(1, Math.round(cropFraction.w * current.width)),
          height: Math.max(1, Math.round(cropFraction.h * current.height)),
        },
      });
      setCropActive(false);
      await reload();
      bumpCaptureRevision();
    } catch (error) {
      showToast(describeError(error), "danger");
    } finally {
      setBusy(false);
      setRunLabel("");
    }
  }, [busy, cropFraction, current, reload, showToast]);

  const retake = useCallback(() => {
    if (!current || busy) return;
    Alert.alert(
      current.mime.startsWith("image/") ? "重拍这一张？" : "删除这份文档？",
      current.mime.startsWith("image/")
        ? "当前照片会从本次采集会话中删除，不会影响其他照片。"
        : "这份 PDF 会从本次采集会话中删除；已保存的相册或电脑副本不受影响。",
      [
      { text: "取消", style: "cancel" },
      {
        text: "重拍",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              const paths = await repo.deleteAsset(current.id);
              for (const path of paths) deleteFileQuietly(path);
              sessionIds.current = sessionIds.current.filter((id) => id !== current.id);
              bumpCaptureRevision();
              if (sessionIds.current.length === 0) {
                nav.back();
                return;
              }
              await reload();
            } catch (error) {
              showToast(`删除采集素材失败：${describeError(error)}`, "danger");
            }
          })();
        },
      },
    ]);
  }, [busy, current, nav, reload]);

  const openReceiptSheet = useCallback(() => {
    if (!current) return;
    setReceiptMode("plain");
    setReceiptName(current.name);
    setReceiptDate(formatLifeDate(Date.now()));
    setReceiptPurchaseName(current.name.replace(/\.[a-z0-9]{1,6}$/i, ""));
    setReceiptTotal("");
    setReceiptCurrency("");
    setReceiptNote("");
    setReceiptError(null);
    setRecentPurchases([]);
    setReceiptOpen(true);
    void (async () => {
      try {
        const [purchases, currency] = await Promise.all([
          listRecentPurchases(10),
          loadDefaultCurrency(),
        ]);
        setRecentPurchases(purchases);
        setReceiptCurrency(currency);
      } catch (error) {
        setReceiptError(`读取最近购买记录失败：${describeError(error)}`);
      }
    })();
  }, [current]);

  const ensureReceiptAsset = useCallback(async (): Promise<repo.CaptureAsset> => {
    if (!current) throw new AppError("validation", "没有可保存的采集素材");
    const saved = await saveToLocal(current);
    if (!saved.localPath) {
      throw new AppError("storage", "素材已保存，但本机文件路径缺失，无法建立票据关联");
    }
    return saved;
  }, [current]);

  const saveReceipt = useCallback(
    async (linkedPurchase?: LifeRecentPurchase) => {
      if (!current || receiptBusy) return;
      setReceiptBusy(true);
      setReceiptError(null);
      try {
        const occurredAt = parseLifeDateInput(receiptDate);
        if (occurredAt === null) throw new Error("日期格式不正确，请使用 YYYY-MM-DD");
        const asset = await ensureReceiptAsset();
        const documentName = receiptName.trim() || asset.name;
        if (receiptMode === "plain") {
          await createReceiptEvent({
            name: documentName,
            assetId: asset.id,
            mime: asset.mime,
            byteSize: asset.byteSize,
            occurredAt,
            note: receiptNote.trim() || undefined,
          });
          showToast("已保存为生活票据，可在生活页继续关联购买记录", "success");
        } else if (receiptMode === "link") {
          if (!linkedPurchase) throw new Error("请选择一条要关联的购买记录");
          await createDocumentLink({
            ownerType: "event",
            ownerId: linkedPurchase.eventId,
            documentRef: asset.id,
            documentSource: "capture_asset",
            documentName,
            mime: asset.mime,
            byteSize: asset.byteSize,
            transferState: "local",
          });
          showToast(
            `票据已关联到 ${formatLifeDate(linkedPurchase.occurredAt)} 的购买记录`,
            "success",
          );
        } else {
          const purchaseName = receiptPurchaseName.trim();
          if (!purchaseName) throw new Error("请填写购买商品名称");
          if (receiptTotal.trim() && !receiptCurrency.trim()) {
            throw new Error("请选择货币：未配置默认货币时不自动假设人民币");
          }
          const created = await createPurchase({
            name: purchaseName,
            occurredAt,
            totalPrice: receiptTotal.trim() || null,
            currency: receiptCurrency.trim() || null,
            note: receiptNote.trim() || null,
          });
          await createDocumentLink({
            ownerType: "event",
            ownerId: created.eventId,
            documentRef: asset.id,
            documentSource: "capture_asset",
            documentName,
            mime: asset.mime,
            byteSize: asset.byteSize,
            transferState: "local",
          });
          showToast("已创建购买记录并关联票据", "success");
        }
        setReceiptOpen(false);
        await reload();
        bumpCaptureRevision();
      } catch (error) {
        setReceiptError(describeError(error));
      } finally {
        setReceiptBusy(false);
      }
    },
    [
      current,
      ensureReceiptAsset,
      receiptBusy,
      receiptCurrency,
      receiptDate,
      receiptMode,
      receiptName,
      receiptNote,
      receiptPurchaseName,
      receiptTotal,
      reload,
      showToast,
    ],
  );

  const desktopSelected = choice.desktop;
  const canDesktop = availability?.paired === true;

  // 只在「发送到电脑 + 暂存架」时读取分组；老桌面端没有该接口时保持空列表（默认分组）。
  useEffect(() => {
    if (!desktopSelected || choice.desktopTarget !== "shelf" || !canDesktop) return;
    let active = true;
    setGroupsLoading(true);
    void listShelfGroups()
      .then((groups) => {
        if (active) setShelfGroups(groups);
      })
      .catch(() => {
        if (active) setShelfGroups([]);
      })
      .finally(() => {
        if (active) setGroupsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canDesktop, choice.desktopTarget, desktopSelected]);

  const toggleDestination = (key: "local" | "album" | "desktop") => {
    setChoice((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const run = useCallback(async () => {
    if (busy || assets.length === 0) return;
    if (!choice.local && !choice.album && !choice.desktop) {
      showToast("请先选择至少一个保存位置", "warn");
      return;
    }
    if (choice.desktop && availability?.paired !== true) {
      showToast(availability?.reason ?? "电脑端不可用，请先配对", "warn");
      return;
    }
    setBusy(true);
    // 取消只针对桌面传输；本机/相册已经保存成功的结果不因取消而回滚。
    const token = choice.desktop ? createTransferCancelToken() : null;
    cancelTokenRef.current = token;
    setCancelable(Boolean(token));
    setCancelling(false);
    try {
      // 用户常常改完文件名/备注直接点保存：输入框只在 onEndEditing 提交，先补一次，
      // 否则改名后的相册副本仍用旧名、备注也不会落库。
      // 这两步也必须在本 try 内：数据库/刷新失败时若留在 try 外，busy 永远不会释放。
      try {
        await commitName();
      } catch (error) {
        throw new AppError("storage", `文件名保存失败：${describeError(error)}`, error);
      }
      try {
        await commitNote();
      } catch (error) {
        throw new AppError("storage", `备注保存失败：${describeError(error)}`, error);
      }
      const failures: string[] = [];
      let offlineMessage: string | null = null;
      let pendingMessage: string | null = null;
      let stopMessage: string | null = null;
      const sessionAssets = (
        await Promise.all(sessionIds.current.map((id) => repo.getAsset(id)))
      ).filter((asset): asset is repo.CaptureAsset => asset !== null);
      let working = sessionAssets.length > 0 ? sessionAssets : assets;
      const doneKeys = new Set<string>();
      for (const list of Object.values(destinations)) {
        for (const item of list) {
          if (item.state === "done") doneKeys.add(`${item.assetId}:${item.destination}`);
        }
      }
      const total = working.length;

      // 取消后：未开始的 desktop/shelf 写 cancelled；已经 done 的目的地保持 done。
      const markCancelFrom = async (from: number) => {
        for (let j = from; j < total; j += 1) {
          const item = working[j];
          if (!doneKeys.has(`${item.id}:desktop`)) {
            await repo.setDestination(item.id, "desktop", {
              state: "cancelled",
              lastError: "文件传输已取消",
            });
          }
          if (choice.desktopTarget === "shelf" && !doneKeys.has(`${item.id}:shelf`)) {
            await repo.setDestination(item.id, "shelf", {
              state: "cancelled",
              lastError: "文件传输已取消",
            });
          }
        }
      };

      if (choice.local) {
        for (let i = 0; i < total; i += 1) {
          const asset = working[i];
          if (asset.state === "saved") continue;
          setRunLabel(`保存到本机 ${i + 1}/${total}`);
          try {
            const saved = await saveToLocal(asset);
            working = working.map((item) => (item.id === saved.id ? saved : item));
            setAssets(working);
            doneKeys.add(`${saved.id}:local`);
          } catch (error) {
            failures.push(`本机暂存：${describeError(error)}`);
          }
        }
        bumpCaptureRevision();
      }

      if (choice.album) {
        for (let i = 0; i < total; i += 1) {
          const asset = working[i];
          if (doneKeys.has(`${asset.id}:album`)) continue;
          setRunLabel(`保存到相册 ${i + 1}/${total}`);
          try {
            await saveToAlbum(asset);
            doneKeys.add(`${asset.id}:album`);
          } catch (error) {
            failures.push(`系统相册：${describeError(error)}`);
          }
        }
      }

      if (choice.desktop) {
        for (let i = 0; i < total; i += 1) {
          if (token?.isCancelled()) {
            await markCancelFrom(i);
            pendingMessage = "文件传输已取消";
            break;
          }
          const asset = working[i];
          const shelfDone = doneKeys.has(`${asset.id}:shelf`);
          const desktopDone = doneKeys.has(`${asset.id}:desktop`);
          if (choice.desktopTarget === "inbox" && desktopDone) continue;
          if (choice.desktopTarget === "shelf" && shelfDone) continue;
          setRunLabel(
            choice.desktopTarget === "shelf"
              ? `发送并导入暂存架 ${i + 1}/${total}`
              : `发送到电脑 ${i + 1}/${total}`,
          );
          const remote = destinations[asset.id]?.find(
            (item) => item.destination === "desktop" && item.state === "done" && item.remoteId,
          );
          if (choice.desktopTarget === "shelf" && desktopDone && remote?.remoteId) {
            const retry = await retryShelfImport(
              asset,
              remote.remoteId,
              choice.shelfGroupId,
              token ?? undefined,
            );
            if (retry.state === "cancelled") {
              pendingMessage = retry.message;
              await markCancelFrom(i + 1);
              break;
            }
            if (retry.stopBatch) {
              stopMessage = retry.message;
              failures.push(retry.message);
              break;
            }
            if (retry.state === "pending") pendingMessage = retry.message;
            else if (retry.state === "failed") {
              failures.push(retry.message);
            } else if (retry.remoteShelfId) {
              doneKeys.add(`${asset.id}:shelf`);
            } else {
              failures.push("电脑端已接收，但未返回暂存架条目 ID；请刷新核对");
            }
            continue;
          }
          const result = await sendToDesktop([asset], {
            target: choice.desktopTarget,
            shelfGroupId: choice.shelfGroupId,
            onProgress: setProgress,
            batch: { index: i, count: total },
            cancelToken: token ?? undefined,
          });
          if (token?.isCancelled()) {
            await markCancelFrom(i + 1);
            pendingMessage = result.message ?? "文件传输已取消";
            for (const outcome of result.outcomes) {
              if (outcome.state === "done") {
                doneKeys.add(`${asset.id}:desktop`);
                if (choice.desktopTarget === "inbox") continue;
                if (outcome.shelfId) doneKeys.add(`${asset.id}:shelf`);
              } else if (outcome.state === "cancelled") {
                pendingMessage = outcome.message ?? "文件传输已取消";
              } else if (outcome.state === "failed") {
                failures.push(outcome.message ?? "发送失败，请重试");
              }
            }
            break;
          }
          if (result.offline) {
            offlineMessage = result.message ?? "电脑端不可用";
            break;
          }
          if (result.stopBatch) {
            // 授权/安全类失败：继续发下一张只会重复失败，停止整批并展示真实原因。
            stopMessage = result.message ?? "授权或安全校验失败，已停止本批发送";
            if (result.message) failures.push(result.message);
            break;
          }
          for (const outcome of result.outcomes) {
            if (outcome.state === "done") {
              doneKeys.add(`${asset.id}:desktop`);
              if (choice.desktopTarget === "inbox") {
                continue;
              }
              if (outcome.shelfId) doneKeys.add(`${asset.id}:shelf`);
              else failures.push("电脑端已接收，但未返回暂存架条目 ID；请刷新核对");
            } else if (outcome.state === "pending") {
              pendingMessage = outcome.message ?? "已保留为待发送";
            } else if (outcome.state === "cancelled") {
              pendingMessage = outcome.message ?? "已取消发送";
            } else {
              failures.push(outcome.message ?? "发送失败，请重试");
            }
          }
        }
      }

      await cleanupStagedAfterRun(sessionIds.current);
      // 会话里保留「已保存到本机」或仍 staged 的素材，供本轮结果展示与后续重试；
      // 仅相册/电脑成功且没有本机副本的素材已在 cleanup 中删除。
      const kept = await Promise.all(sessionIds.current.map((id) => repo.getAsset(id)));
      sessionIds.current = kept
        .filter((asset): asset is repo.CaptureAsset => asset !== null)
        .map((asset) => asset.id);
      if (sessionIds.current.length === 0) {
        sessionIds.current = (await repo.listStagedAssets()).map((asset) => asset.id);
      }
      await reload();
      bumpCaptureRevision();

      if (failures.length > 0 || stopMessage) {
        showToast(failures[0] ?? stopMessage ?? "发送失败，请重试", "danger");
      } else if (offlineMessage || pendingMessage) {
        showToast(offlineMessage ?? pendingMessage ?? "电脑端不可用", "warn");
      } else {
        showToast(`已完成 ${total} 张素材的所选目的地`, "success");
      }
    } catch (error) {
      showToast(describeError(error), "danger");
    } finally {
      cancelTokenRef.current = null;
      setCancelable(false);
      setCancelling(false);
      setBusy(false);
      setRunLabel("");
      setProgress(null);
    }
  }, [assets, availability, busy, choice, commitName, commitNote, destinations, reload, showToast]);

  const summary = useMemo(() => {
    const kinds: repo.CaptureDestinationKind[] = ["local", "album", "desktop", "shelf"];
    const rows = kinds.map((kind) => {
      const items = Object.values(destinations)
        .flat()
        .filter((item) => item.destination === kind);
      return {
        kind,
        total: items.length,
        done: items.filter((item) => item.state === "done").length,
        failed: items.filter((item) => item.state === "failed").length,
        cancelled: items.filter((item) => item.state === "cancelled").length,
        pending: items.filter((item) => item.state === "pending").length,
        running: items.filter((item) => item.state === "running").length,
        error: items.find((item) => item.state === "failed")?.lastError ?? null,
      };
    });
    return rows.filter((row) => row.total > 0);
  }, [destinations]);

  if (loading) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: tokens.bg }]}>
        <ActivityIndicator color={tokens.accent} />
      </View>
    );
  }

  if (!current) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <AppBar title="采集处理" onBack={nav.back} />
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: tokens.muted }]}>
            没有待处理的照片。回到相机继续拍摄，或从采集暂存查看已保存素材。
          </Text>
          <PressableScale
            accessibilityLabel="继续拍摄"
            onPress={nav.back}
            contentStyle={[styles.secondaryButton, { backgroundColor: tokens.accentSoft }]}
          >
            <Text style={[styles.secondaryText, { color: tokens.accentText }]}>继续拍摄</Text>
          </PressableScale>
        </View>
      </View>
    );
  }

  const destinationLabel: Record<repo.CaptureDestinationKind, string> = {
    local: "本机暂存",
    album: isImage ? "系统相册" : "系统下载目录",
    desktop: "电脑收件箱",
    shelf: "桌面暂存架",
  };

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title={`${current.kind === "scan" ? "文档" : "照片"} ${index + 1}/${assets.length}`}
        onBack={nav.back}
        right={
          <Text style={[styles.headerMeta, { color: tokens.muted }]}>
            {current.width && current.height ? `${current.width}×${current.height}` : ""}
          </Text>
        }
      />

      <View
        style={[styles.preview, { backgroundColor: tokens.ink }]}
        onLayout={(event: LayoutChangeEvent) => {
          const { width, height } = event.nativeEvent.layout;
          setPreviewLayout({ width, height });
        }}
      >
        {!current.localPath ? (
          <Text style={[styles.emptyText, { color: tokens.muted }]}>文件不可用</Text>
        ) : !isImage ? (
          <View style={styles.fileCard}>
            <Text style={[styles.fileCardGlyph, { backgroundColor: tokens.dangerFill, color: tokens.onInk }]}>PDF</Text>
            <Text style={[styles.fileCardName, { color: tokens.text }]} numberOfLines={2}>
              {current.name}
            </Text>
            <Text style={[styles.fileCardMeta, { color: tokens.muted }]}>
              {formatBytes(current.byteSize)} · {current.mime}
            </Text>
            <Text style={[styles.noteLine, { color: tokens.muted }]}>
              PDF 无法在应用内预览；保存或发送后可在其他应用中打开
            </Text>
          </View>
        ) : cropActive ? (
          <>
            <Image
              source={{ uri: current.localPath }}
              resizeMode="contain"
              style={StyleSheet.absoluteFill}
            />
            <ImageCropOverlay
              fraction={cropFraction}
              onChange={setCropFraction}
              display={display}
              hint={
                current.width && current.height
                  ? `裁剪范围 ${Math.round(cropFraction.w * current.width)}×${Math.round(cropFraction.h * current.height)} px`
                  : undefined
              }
            />
          </>
        ) : (
          <ZoomableImage uri={current.localPath} />
        )}

        {!cropActive && assets.length > 1 ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="上一张"
              disabled={index === 0}
              onPress={() => setIndex((prev) => Math.max(0, prev - 1))}
              style={[
                styles.navArrow,
                styles.navLeft,
                { backgroundColor: tokens.overlay },
                index === 0 && styles.navDisabled,
              ]}
            >
              <AppIcon
                name="chevronRight"
                color={tokens.onAccent}
                size={22}
                style={styles.navPrevIcon}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="下一张"
              disabled={index >= assets.length - 1}
              onPress={() => setIndex((prev) => Math.min(assets.length - 1, prev + 1))}
              style={[
                styles.navArrow,
                styles.navRight,
                { backgroundColor: tokens.overlay },
                index >= assets.length - 1 && styles.navDisabled,
              ]}
            >
              <AppIcon name="chevronRight" color={tokens.onAccent} size={22} />
            </Pressable>
          </>
        ) : null}
      </View>

      <View style={styles.toolRow}>
        {cropActive ? (
          <>
            <Pressable
              accessibilityRole="button"
              style={[styles.toolSlot, styles.toolButton, { backgroundColor: tokens.track }]}
              onPress={() => {
                setCropActive(false);
                setCropFraction(CROP_DEFAULT);
              }}
            >
              <Text style={[styles.toolText, { color: tokens.textSoft }]}>取消裁剪</Text>
            </Pressable>
            <PressableScale
              accessibilityLabel="应用裁剪"
              onPress={() => void applyCrop()}
              style={styles.toolSlot}
              contentStyle={[styles.toolButton, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.toolText, { color: tokens.onAccent }]}>应用裁剪</Text>
            </PressableScale>
          </>
        ) : (
          <>
            {isImage ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.toolSlot, styles.toolButton, { backgroundColor: tokens.track }]}
                  onPress={() => void rotate()}
                  disabled={busy || current.state === "saved"}
                >
                  <Text style={[styles.toolText, { color: tokens.textSoft }]}>旋转 90°</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.toolSlot, styles.toolButton, { backgroundColor: tokens.track }]}
                  onPress={() => setCropActive(true)}
                  disabled={busy || current.state === "saved"}
                >
                  <Text style={[styles.toolText, { color: tokens.textSoft }]}>裁剪</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isImage ? "重拍这一张" : "删除这份文档"}
              style={[styles.toolSlot, styles.toolButton, { backgroundColor: tokens.track }]}
              onPress={retake}
              disabled={busy}
            >
              {/* PDF 没有「重拍」，同一个入口对文档只能是删除 */}
              <Text style={[styles.toolText, { color: tokens.danger }]}>
                {isImage ? "重拍" : "删除"}
              </Text>
            </Pressable>
          </>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.details}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.fieldRow}>
          <Text style={[styles.fieldLabel, { color: tokens.muted }]}>文件名</Text>
          <TextInput
            value={nameDraft}
            onChangeText={setNameDraft}
            onEndEditing={() => {
              void commitName().catch((error) => {
                showToast(`文件名保存失败：${describeError(error)}`, "danger");
              });
            }}
            style={[styles.input, { color: tokens.text, backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}
            underlineColorAndroid="transparent"
            accessibilityLabel="文件名"
          />
        </View>
        <Text style={[styles.metaLine, { color: tokens.muted }]}>
          {formatBytes(current.byteSize)} · {current.mime}
          {current.note ? "" : " · 可添加备注"}
        </Text>
        <TextInput
          value={noteDraft}
          onChangeText={setNoteDraft}
          onEndEditing={() => {
            void commitNote().catch((error) => {
              showToast(`备注保存失败：${describeError(error)}`, "danger");
            });
          }}
          placeholder="备注（只保存在本机素材记录里）"
          placeholderTextColor={tokens.faint}
          style={[styles.noteInput, { color: tokens.text, backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}
          underlineColorAndroid="transparent"
          multiline
          accessibilityLabel="备注"
        />

        <Text style={[styles.sectionTitle, { color: tokens.text }]}>保存到</Text>
        <CheckRow
          checked={choice.local}
          title="TaskDock 本机暂存"
          hint="生成应用私有副本，卸载应用会被清理；不等于系统相册"
          onPress={() => toggleDestination("local")}
        />
        <CheckRow
          checked={choice.album}
          title={isImage ? "系统相册" : "系统下载目录"}
          hint={
            isImage
              ? "通过 MediaStore 写入 Pictures/TaskDock"
              : "通过 MediaStore 把 PDF 写入 Downloads/TaskDock"
          }
          onPress={() => toggleDestination("album")}
        />
        <CheckRow
          checked={choice.desktop}
          title="发送到电脑"
          hint={
            availability?.paired
              ? `目标：${availability.serverName ?? "已配对电脑"}`
              : availability?.reason ?? "尚未配对"
          }
          disabled={!canDesktop}
          onPress={() => toggleDestination("desktop")}
        />
        {desktopSelected && canDesktop ? (
          <View style={styles.targetRow}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: choice.desktopTarget === "inbox" }}
              onPress={() => setChoice((prev) => ({ ...prev, desktopTarget: "inbox" }))}
              style={[
                styles.targetChip,
                {
                  borderColor:
                    choice.desktopTarget === "inbox" ? tokens.accentFill : tokens.cardBorder,
                  backgroundColor:
                    choice.desktopTarget === "inbox" ? tokens.accentSoft : tokens.card,
                },
              ]}
            >
              <Text
                style={[
                  styles.targetText,
                  {
                    color:
                      choice.desktopTarget === "inbox" ? tokens.accentText : tokens.textSoft,
                  },
                ]}
              >
                电脑文件收件箱
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: choice.desktopTarget === "shelf" }}
              onPress={() => setChoice((prev) => ({ ...prev, desktopTarget: "shelf" }))}
              style={[
                styles.targetChip,
                {
                  borderColor:
                    choice.desktopTarget === "shelf" ? tokens.accentFill : tokens.cardBorder,
                  backgroundColor:
                    choice.desktopTarget === "shelf" ? tokens.accentSoft : tokens.card,
                },
              ]}
            >
              <Text
                style={[
                  styles.targetText,
                  {
                    color:
                      choice.desktopTarget === "shelf" ? tokens.accentText : tokens.textSoft,
                  },
                ]}
              >
                桌面暂存架
              </Text>
            </Pressable>
          </View>
        ) : null}
        {desktopSelected && choice.desktopTarget === "shelf" ? (
          <>
            <View style={styles.groupRow}>
              <Text style={[styles.groupLabel, { color: tokens.muted }]}>暂存分组</Text>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: choice.shelfGroupId === null }}
                onPress={() => setChoice((prev) => ({ ...prev, shelfGroupId: null }))}
                style={[
                  styles.groupChip,
                  {
                    borderColor:
                      choice.shelfGroupId === null ? tokens.accentFill : tokens.cardBorder,
                    backgroundColor:
                      choice.shelfGroupId === null ? tokens.accentSoft : tokens.card,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.groupText,
                    {
                      color:
                        choice.shelfGroupId === null ? tokens.accentText : tokens.textSoft,
                    },
                  ]}
                >
                  默认分组
                </Text>
              </Pressable>
              {shelfGroups.map((group) => {
                const active = choice.shelfGroupId === group.id;
                return (
                  <Pressable
                    key={group.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    onPress={() => setChoice((prev) => ({ ...prev, shelfGroupId: group.id }))}
                    style={[
                      styles.groupChip,
                      {
                        borderColor: active ? tokens.accentFill : tokens.cardBorder,
                        backgroundColor: active ? tokens.accentSoft : tokens.card,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.groupText,
                        { color: active ? tokens.accentText : tokens.textSoft },
                      ]}
                    >
                      {group.name}
                    </Text>
                  </Pressable>
                );
              })}
              {groupsLoading ? (
                <Text style={[styles.noteLine, { color: tokens.muted }]}>读取分组…</Text>
              ) : null}
            </View>
            <Text style={[styles.noteLine, { color: tokens.muted }]}>
              先上传到电脑，再由桌面端以托管副本加入暂存架；两步结果分别显示，导入失败不会回滚已上传文件。
            </Text>
          </>
        ) : null}

        {summary.length > 0 ? (
          <View style={styles.resultCard}>
            <Text style={[styles.sectionTitle, { color: tokens.text }]}>处理结果</Text>
            {summary.map((row) => {
              const ok = row.failed === 0 && row.cancelled === 0 && row.done === row.total;
              const tone = row.failed > 0 ? tokens.danger : ok ? tokens.ok : tokens.warn;
              return (
                <View key={row.kind} style={styles.resultRow}>
                  <View style={[styles.resultDot, { backgroundColor: tone }]} />
                  <View style={styles.resultMain}>
                    <Text style={[styles.resultTitle, { color: tokens.textSoft }]}>
                      {destinationLabel[row.kind]} · 成功 {row.done}/{row.total}
                      {row.failed > 0 ? ` · 失败 ${row.failed}` : ""}
                      {row.pending > 0 ? ` · 等待 ${row.pending}` : ""}
                    </Text>
                    {row.error ? (
                      <Text style={[styles.resultError, { color: tokens.danger }]} numberOfLines={3}>
                        {row.error}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>

      <View
        style={[
          styles.actionBar,
          {
            paddingBottom: (keyboardHeight > 0 ? 0 : insets.bottom) + space.sm,
            marginBottom: keyboardHeight,
            borderColor: tokens.separator,
            backgroundColor: tokens.bg,
          },
        ]}
        onLayout={bottomAnchor.onLayout}
      >
        {busy && progress ? (
          <View style={styles.progressRow}>
            <View style={[styles.progressTrack, { backgroundColor: tokens.track }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: tokens.accentFill,
                    flex: Math.max(0.001, progress.total > 0 ? progress.done / progress.total : 0),
                  },
                ]}
              />
              <View
                style={{
                  flex: Math.max(
                    0.001,
                    progress.total > 0 ? 1 - progress.done / progress.total : 1,
                  ),
                }}
              />
            </View>
            <Text style={[styles.progressText, { color: tokens.muted }]}>
              {progress.index + 1}/{progress.count} · {progress.done}/{progress.total} 块
            </Text>
          </View>
        ) : null}
        {cancelable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelling ? "正在取消上传" : "取消上传"}
            accessibilityState={{ disabled: cancelling }}
            disabled={cancelling}
            onPress={requestCancelTransfer}
            style={({ pressed }) => [
              styles.cancelAction,
              {
                borderColor: tokens.accent,
                backgroundColor: tokens.track,
                opacity: cancelling ? 0.65 : pressed ? 0.75 : 1,
              },
            ]}
          >
            <Text style={[styles.cancelActionText, { color: tokens.accentText }]}>
              {cancelling ? "正在取消…" : "取消上传"}
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.receiptEntryRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="保存为生活票据"
            disabled={busy}
            onPress={openReceiptSheet}
            style={({ pressed }) => [
              styles.receiptEntry,
              { borderColor: tokens.cardBorder, opacity: busy ? 0.55 : pressed ? 0.75 : 1 },
            ]}
          >
            <AppIcon name="fileImage" color={tokens.accentText} size={17} />
            <Text style={[styles.receiptEntryText, { color: tokens.accentText }]}>
              保存为生活票据
            </Text>
          </Pressable>
          <Text style={[styles.receiptEntryHint, { color: tokens.muted }]}>
            可选：关联购买记录或新建购买记录
          </Text>
        </View>
        <PressableScale
          accessibilityLabel="保存到所选位置"
          accessibilityState={{ disabled: busy || assets.length === 0 }}
          disabled={busy || assets.length === 0}
          onPress={() => void run()}
          contentStyle={[
            styles.primaryAction,
            { backgroundColor: busy ? tokens.muted : tokens.accentFill },
          ]}
        >
          {busy ? <ActivityIndicator color={tokens.onAccent} size="small" /> : null}
          <Text style={[styles.primaryActionText, { color: tokens.onAccent }]}>
            {busy ? runLabel || "处理中…" : `保存到所选位置（${assets.length} 项）`}
          </Text>
        </PressableScale>
        <Text style={[styles.footNote, { color: tokens.faint }]}>
          未勾选的目的地不会执行；失败的项目保留本机文件，可再次点击重试。
        </Text>
      </View>

      <BottomSheet
        visible={receiptOpen}
        onRequestClose={() => {
          if (!receiptBusy) setReceiptOpen(false);
        }}
        keyboardAware
        maxHeightRatio={0.88}
        accessibilityLabel="保存为生活票据"
      >
        <View style={styles.sheetHeader}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>保存为生活票据</Text>
          <Text style={[styles.sheetHint, { color: tokens.muted }]}>
            只引用本机素材，不复制图片字节；删除关联不会删除原图。
          </Text>
        </View>

        <View style={styles.modeRow}>
          {(
            [
              ["plain", "仅保存票据"],
              ["link", "关联已有"],
              ["create", "新建购买"],
            ] as const
          ).map(([mode, label]) => {
            const selected = receiptMode === mode;
            return (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => {
                  setReceiptMode(mode);
                  setReceiptError(null);
                }}
                style={[
                  styles.modeChip,
                  {
                    borderColor: selected ? tokens.accentFill : tokens.cardBorder,
                    backgroundColor: selected ? tokens.accentSoft : tokens.card,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.modeText,
                    { color: selected ? tokens.accentText : tokens.textSoft },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.fieldRow}>
          <Text style={[styles.fieldLabel, { color: tokens.muted }]}>票据名称</Text>
          <TextInput
            underlineColorAndroid="transparent"
            value={receiptName}
            onChangeText={setReceiptName}
            style={[
              styles.input,
              { color: tokens.text, backgroundColor: tokens.card, borderColor: tokens.cardBorder },
            ]}
            placeholder={current.name}
            placeholderTextColor={tokens.faint}
            accessibilityLabel="票据名称"
          />
        </View>
        <View style={styles.fieldRow}>
          <Text style={[styles.fieldLabel, { color: tokens.muted }]}>日期</Text>
          <TextInput
            underlineColorAndroid="transparent"
            value={receiptDate}
            onChangeText={setReceiptDate}
            style={[
              styles.input,
              { color: tokens.text, backgroundColor: tokens.card, borderColor: tokens.cardBorder },
            ]}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={tokens.faint}
            accessibilityLabel="票据日期，格式年-月-日"
          />
        </View>

        {receiptMode === "plain" ? (
          <Text style={[styles.receiptHint, { color: tokens.muted }]}>
            只保存原始文件为一笔生活票据；之后可在生活页的票据资料里关联购买记录。
          </Text>
        ) : null}

        {receiptMode === "link" ? (
          <View style={styles.purchaseList}>
            <Text style={[styles.sheetHint, { color: tokens.muted }]}>
              选择一条购买记录，票据会直接关联到它。
            </Text>
            {recentPurchases.length === 0 ? (
              <Text style={[styles.receiptHint, { color: tokens.muted }]}>
                暂无购买记录；可切换到「新建购买」。
              </Text>
            ) : (
              recentPurchases.map((purchase) => (
                <Pressable
                  key={purchase.eventId}
                  accessibilityRole="button"
                  accessibilityLabel={`关联到 ${formatLifeDate(purchase.occurredAt)} 的购买记录`}
                  disabled={receiptBusy}
                  onPress={() => void saveReceipt(purchase)}
                  style={({ pressed }) => [
                    styles.purchaseRow,
                    {
                      borderColor: tokens.cardBorder,
                      opacity: receiptBusy ? 0.6 : pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <View style={styles.purchaseMain}>
                    <Text style={[styles.purchaseTitle, { color: tokens.text }]} numberOfLines={1}>
                      {purchase.itemNames.join("、") || purchase.title}
                    </Text>
                    <Text style={[styles.purchaseMeta, { color: tokens.muted }]}>
                      {formatLifeDate(purchase.occurredAt)}
                      {purchase.merchant ? ` · ${purchase.merchant}` : ""}
                      {purchase.totalPriceMinor !== null
                        ? ` · ${formatMoneyMinor(
                            purchase.totalPriceMinor,
                            purchase.currency,
                            purchase.amountScale,
                          )}`
                        : ""}
                    </Text>
                  </View>
                  <AppIcon name="chevronRight" color={tokens.muted} size={16} />
                </Pressable>
              ))
            )}
          </View>
        ) : null}

        {receiptMode === "create" ? (
          <View style={styles.purchaseList}>
            <View style={styles.fieldRow}>
              <Text style={[styles.fieldLabel, { color: tokens.muted }]}>商品名称</Text>
              <TextInput
                underlineColorAndroid="transparent"
                value={receiptPurchaseName}
                onChangeText={setReceiptPurchaseName}
                style={[
                  styles.input,
                  {
                    color: tokens.text,
                    backgroundColor: tokens.card,
                    borderColor: tokens.cardBorder,
                  },
                ]}
                placeholder="例如 大米"
                placeholderTextColor={tokens.faint}
                accessibilityLabel="购买商品名称"
              />
            </View>
            <View style={styles.fieldRow}>
              <Text style={[styles.fieldLabel, { color: tokens.muted }]}>金额</Text>
              <TextInput
                underlineColorAndroid="transparent"
                value={receiptTotal}
                onChangeText={setReceiptTotal}
                keyboardType="decimal-pad"
                style={[
                  styles.input,
                  {
                    color: tokens.text,
                    backgroundColor: tokens.card,
                    borderColor: tokens.cardBorder,
                  },
                ]}
                placeholder="选填，例如 48.00"
                placeholderTextColor={tokens.faint}
                accessibilityLabel="购买金额"
              />
            </View>
            <View style={styles.groupRow}>
              <Text style={[styles.groupLabel, { color: tokens.muted }]}>货币</Text>
              {["CNY", "USD", "EUR", "JPY", "GBP", "HKD"].map((code) => {
                const selected = receiptCurrency === code;
                return (
                  <Pressable
                    key={code}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => setReceiptCurrency(code)}
                    style={[
                      styles.groupChip,
                      {
                        borderColor: selected ? tokens.accentFill : tokens.cardBorder,
                        backgroundColor: selected ? tokens.accentSoft : tokens.card,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.groupText,
                        { color: selected ? tokens.accentText : tokens.textSoft },
                      ]}
                    >
                      {code}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.receiptHint, { color: tokens.faint }]}>
              未配置默认货币时不会自动按人民币记账；金额为空也可保存商品名称。
            </Text>
          </View>
        ) : null}

        {receiptError ? (
          <Text accessibilityRole="alert" style={[styles.receiptError, { color: tokens.danger }]}>
            {receiptError}
          </Text>
        ) : null}

        {receiptMode !== "link" ? (
          <PressableScale
            accessibilityLabel={receiptMode === "plain" ? "仅保存票据" : "创建购买记录并关联票据"}
            accessibilityState={{ disabled: receiptBusy }}
            disabled={receiptBusy}
            onPress={() => void saveReceipt()}
            contentStyle={[
              styles.primaryAction,
              { backgroundColor: receiptBusy ? tokens.muted : tokens.accentFill },
            ]}
          >
            {receiptBusy ? <ActivityIndicator color={tokens.onAccent} size="small" /> : null}
            <Text style={[styles.primaryActionText, { color: tokens.onAccent }]}>
              {receiptMode === "plain" ? "保存票据" : "创建并关联"}
            </Text>
          </PressableScale>
        ) : null}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl },
  preview: {
    flex: 1,
    minHeight: 180,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  navArrow: {
    position: "absolute",
    top: "44%",
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  navLeft: { left: space.sm },
  navRight: { right: space.sm },
  navDisabled: { opacity: 0 },
  // 图标集没有 chevron-left：用同一个描边箭头翻转，保持与右侧同一套线宽
  navPrevIcon: { transform: [{ rotate: "180deg" }] },
  toolRow: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  // 等宽按钮：flex 落在最外层 Pressable，toolButton 只承载视觉属性
  toolSlot: { flex: 1 },
  toolButton: {
    minHeight: 40,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
  },
  toolText: { fontSize: font.label, fontWeight: "600" },
  // flexShrink: 键盘弹起时底部保存栏上移 300dp 左右，详情区必须能一起压缩（内部仍可滚动），
  // 否则总高度超出屏幕，保存栏会被挤出可视区。
  scroll: { flexGrow: 0, flexShrink: 1, maxHeight: "46%" },
  details: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm },
  fieldRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  fieldLabel: { fontSize: font.label, width: 44 },
  input: {
    flex: 1,
    minHeight: 40,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    fontSize: font.body,
  },
  metaLine: { fontSize: font.label },
  noteInput: {
    minHeight: 56,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.body,
    textAlignVertical: "top",
  },
  sectionTitle: { fontSize: font.label, fontWeight: "700", marginTop: space.sm },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  checkMain: { flex: 1, gap: 1 },
  checkTitle: { fontSize: font.body, fontWeight: "600" },
  checkHint: { fontSize: font.label, lineHeight: 15 },
  targetRow: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  groupRow: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  groupLabel: { fontSize: font.label },
  groupChip: {
    minHeight: 32,
    paddingHorizontal: space.sm,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  groupText: { fontSize: font.label, fontWeight: "600" },
  targetChip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  targetText: { fontSize: font.label, fontWeight: "600" },
  noteLine: { fontSize: font.label, lineHeight: 16 },
  resultCard: { gap: space.xs, marginTop: space.xs },
  resultRow: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  resultDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  resultMain: { flex: 1, gap: 2 },
  resultTitle: { fontSize: font.label, fontWeight: "600" },
  resultError: { fontSize: font.label, lineHeight: 15 },
  actionBar: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space.xs,
  },
  progressRow: { gap: 4 },
  progressTrack: { height: 6, borderRadius: 3, overflow: "hidden", flexDirection: "row" },
  progressFill: { height: "100%", borderRadius: 3 },
  progressText: { fontSize: font.label },
  cancelAction: {
    minHeight: 36,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelActionText: { fontSize: font.label, fontWeight: "600" },
  primaryAction: {
    minHeight: 50,
    borderRadius: radius.row,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  primaryActionText: { fontSize: font.body, fontWeight: "700" },
  footNote: { fontSize: 10.5, lineHeight: 14, textAlign: "center" },
  headerMeta: { fontSize: font.label },
  fileCard: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xl },
  fileCardGlyph: {
    fontSize: 20,
    fontWeight: "800",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: "hidden",
  },
  fileCardName: { fontSize: font.body, fontWeight: "700", textAlign: "center" },
  fileCardMeta: { fontSize: font.label },
  emptyText: { fontSize: font.body, lineHeight: 20, textAlign: "center", paddingHorizontal: space.lg },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: space.xl,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { fontSize: font.body, fontWeight: "600" },
  receiptEntryRow: { gap: 2, marginBottom: space.xs },
  receiptEntry: {
    minHeight: 40,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
  },
  receiptEntryText: { fontSize: font.label, fontWeight: "700" },
  receiptEntryHint: { fontSize: 10.5, textAlign: "center" },
  sheetHeader: { gap: 2, marginBottom: space.sm },
  sheetTitle: { fontSize: font.section, fontWeight: "700" },
  sheetHint: { fontSize: font.label, lineHeight: 17 },
  modeRow: { flexDirection: "row", gap: space.xs, marginBottom: space.sm },
  modeChip: {
    flex: 1,
    minHeight: 36,
    borderRadius: radius.control,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  modeText: { fontSize: font.label, fontWeight: "700" },
  receiptHint: { fontSize: font.label, lineHeight: 17 },
  purchaseList: { gap: space.xs, marginTop: space.sm },
  purchaseRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  purchaseMain: { flex: 1, gap: 2 },
  purchaseTitle: { fontSize: font.body, fontWeight: "600" },
  purchaseMeta: { fontSize: font.label },
  receiptError: { fontSize: font.label, lineHeight: 18, marginTop: space.xs },
});
