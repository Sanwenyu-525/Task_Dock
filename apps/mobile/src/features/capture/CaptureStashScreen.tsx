// 移动采集暂存：本机已保存素材的整理页。
//
// 数据边界（界面必须说清楚）：
// - 这里的副本在应用私有目录，卸载应用会被系统清理；不等于系统相册，也不等于桌面暂存架；
// - 删除本机素材只删本机副本与记录，不会删除系统相册里的照片或电脑上已接收的文件；
// - 上传/相册/暂存架状态按目的地分别展示，失败可单独重试，不重复执行已完成的目的地。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { AppBar } from "../../components/AppBar";
import { AppIcon } from "../../components/icons/AppIcon";
import { BottomSheet } from "../../components/BottomSheet";
import {
  BULK_ACTION_BAR_HEIGHT,
  BulkActionBar,
  type BulkAction,
} from "../../components/BulkActionBar";
import { EmptyState } from "../../components/EmptyState";
import { FileTypeIcon, fileTypeOf } from "../../components/FileTypeIcon";
import { ImageLightbox, type LightboxImage } from "../../components/ImageLightbox";
import { SearchField } from "../../components/SearchField";
import { SegmentedControl, type SegmentOption } from "../../components/SegmentedControl";
import { useToast } from "../../feedback/ToastProvider";
import { useToastBottomAnchor } from "../../feedback/ToastLayoutProvider";
import * as repo from "../../db/captureAssets";
import { formatRelative } from "../../domain/taskQuery";
import { AppError, describeError } from "../../lib/errors";
import { useWindowInsets } from "../../lib/insets";
import { useKeyboardHeight } from "../../lib/keyboard";
import type { Nav } from "../../lib/nav";
import { formatBytes, previewLocalFile } from "../../lib/sync/fileIo";
import { useTheme } from "../../theme/ThemeProvider";
import { font, radius, space } from "../../theme/tokens";

import { deleteFileQuietly } from "./files";
import { createTransferCancelToken, type TransferCancelToken } from "./cancel";
import { bumpCaptureRevision, subscribeCaptureRevision } from "./revision";
import { captureStatusOf, type CaptureStatusTone } from "./status";
import {
  captureAvailability,
  reconcileShelfDestinations,
  retryShelfImport,
  saveToAlbum,
  sendToDesktop,
  type PairingAvailability,
  type SendOutcome,
  type SendProgress,
} from "./service";
import {
  feedbackForOutcome,
  feedbackForSendResult,
  feedbackForShelfRetry,
} from "./sendFeedback";

type TypeFilter = "all" | "image" | "doc" | "other";

const TYPE_OPTIONS: Array<SegmentOption<TypeFilter>> = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "doc", label: "文档" },
  { value: "other", label: "其他" },
];

/** 文档类扩展名（表格/演示/文本/Markdown/代码/压缩包）归入「文档」筛选。 */
const DOC_KINDS = new Set([
  "doc",
  "sheet",
  "slide",
  "text",
  "markdown",
  "code",
  "pdf",
  "archive",
]);

function destinationTone(state: repo.CaptureDestinationState, tokens: ReturnType<typeof useTheme>["tokens"]) {
  if (state === "done") return tokens.ok;
  if (state === "failed") return tokens.danger;
  if (state === "cancelled") return tokens.muted;
  return tokens.warn;
}

function statusTone(
  tone: CaptureStatusTone,
  tokens: ReturnType<typeof useTheme>["tokens"],
): string {
  if (tone === "ok") return tokens.ok;
  if (tone === "warn") return tokens.warn;
  if (tone === "danger") return tokens.danger;
  if (tone === "accent") return tokens.accentText;
  return tokens.muted;
}

function classifyAsset(asset: repo.CaptureAsset): Exclude<TypeFilter, "all"> {
  if (asset.mime.startsWith("image/")) return "image";
  if (asset.mime === "application/pdf") return "doc";
  if (asset.mime.startsWith("text/")) return "doc";
  if (asset.kind === "scan") return "doc";
  if (DOC_KINDS.has(fileTypeOf(asset.name))) return "doc";
  return "other";
}

function isImageAsset(asset: repo.CaptureAsset): boolean {
  return asset.mime.startsWith("image/");
}

function groupDestinations(
  items: repo.CaptureDestination[],
): Record<string, repo.CaptureDestination[]> {
  const grouped: Record<string, repo.CaptureDestination[]> = {};
  for (const item of items) {
    (grouped[item.assetId] ??= []).push(item);
  }
  return grouped;
}

function AssetStatusStrip({
  statusLabel,
  statusColor,
  items,
  tokens,
}: {
  statusLabel: string;
  statusColor: string;
  items: repo.CaptureDestination[];
  tokens: ReturnType<typeof useTheme>["tokens"];
}) {
  const labels: Record<repo.CaptureDestinationKind, string> = {
    local: "本机",
    album: "相册",
    desktop: "电脑",
    shelf: "暂存架",
  };
  const shown = items.filter((item) => item.destination !== "local");
  return (
    <View style={styles.statusStrip}>
      <View
        style={[
          styles.statusBadge,
          { backgroundColor: `${statusColor}1F`, borderColor: `${statusColor}55` },
        ]}
      >
        <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
      </View>
      {shown.map((item) => {
        const toneColor = destinationTone(item.state, tokens);
        return (
          <View
            key={item.destination}
            style={[
              styles.statusBadge,
              { backgroundColor: `${toneColor}1F`, borderColor: `${toneColor}55` },
            ]}
          >
            <Text style={[styles.statusText, { color: toneColor }]}>
              {labels[item.destination]}
            </Text>
            {item.state === "done" ? (
              <AppIcon name="check" color={toneColor} size={12} />
            ) : item.state === "failed" ? (
              <AppIcon name="error" color={toneColor} size={12} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function CaptureStashScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  // 素材详情是自绘底部弹层（Modal 不吃 adjustResize）：键盘弹出时整块上移，
  // 否则文件名/备注输入框与底部按钮会被键盘盖住。
  const keyboardHeight = useKeyboardHeight();
  // 键盘弹出时把详情弹层限制在键盘以上的可视区，避免整块上移后标题/关闭与图片被裁出屏幕。
  const sheetMaxHeight = keyboardHeight > 0 ? Math.max(240, Dimensions.get("screen").height - keyboardHeight - insets.top - space.xl) : undefined;
  const [assets, setAssets] = useState<repo.CaptureAsset[]>([]);
  const [destinations, setDestinations] = useState<Record<string, repo.CaptureDestination[]>>({});
  const [stagedCount, setStagedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<repo.CaptureAsset | null>(null);
  const [detailDestinations, setDetailDestinations] = useState<repo.CaptureDestination[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [cancelable, setCancelable] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelTokenRef = useRef<TransferCancelToken | null>(null);
  const staleNoticeRef = useRef(0);
  // 本地首屏与后台对账彻底解耦：seq 丢弃旧结果，mountedRef 防止卸载后 setState，
  // reconcileInFlight 保证同一时刻最多一个远程对账请求。
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const loadedRef = useRef(false);
  const availabilityRef = useRef<PairingAvailability | null>(null);
  const reconcileInFlightRef = useRef(false);
  const reconcilePendingRef = useRef(false);
  const backgroundReconcileRef = useRef<(pair: PairingAvailability, seq: number) => void>(() => undefined);
  const [availability, setAvailability] = useState<PairingAvailability | null>(null);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  // 详情面板的垂直拖拽位移；只由顶部拖拽条驱动，内容区滚动不参与。
  const detailTranslateY = useRef(new Animated.Value(0)).current;

  const { showToast } = useToast();
  // 批量操作栏只在多选且已选中时出现：出现时把实际高度交给 Toast，避免底部提示压住动作。
  const bulkAnchor = useToastBottomAnchor(Boolean(selecting && selected.size > 0), false);

  const requestCancelTransfer = useCallback(() => {
    if (!cancelTokenRef.current || cancelling) return;
    cancelTokenRef.current.cancel();
    setCancelling(true);
  }, [cancelling]);

  const refreshDestinations = useCallback(async (seq: number) => {
    const allDestinations = await repo.listAllDestinations();
    if (!mountedRef.current || seq !== loadSeqRef.current) return;
    setDestinations(groupDestinations(allDestinations));
  }, []);

  // 远程对账只在本地首屏已经展示后发生；失败不改变本地列表与 loading。
  // 单飞 + pending：并发 revision 最多补充一次对账，不产生请求风暴。
  const backgroundReconcile = useCallback(
    async (pair: PairingAvailability, seq: number) => {
      if (!mountedRef.current || !pair.paired) return;
      if (reconcileInFlightRef.current) {
        reconcilePendingRef.current = true;
        return;
      }
      reconcileInFlightRef.current = true;
      try {
        const result = await reconcileShelfDestinations();
        if (!mountedRef.current || seq !== loadSeqRef.current) return;
        await refreshDestinations(seq);
        if (result.stale > 0 && staleNoticeRef.current !== result.stale) {
          staleNoticeRef.current = result.stale;
          showToast(
            `${result.stale} 个条目已不在桌面暂存架中；电脑上的文件仍保留，可重新导入`,
            "warn",
          );
        } else if (result.stale === 0) {
          staleNoticeRef.current = 0;
        }
      } catch {
        // 电脑离线/授权失败：保持本地已展示数据，下一次刷新再试。
      } finally {
        reconcileInFlightRef.current = false;
        // 对账失败时也要消费 pending：否则在它执行期间到达的新一轮本地刷新
        // 会丢掉唯一一次补跑机会，最新目的地状态只能等下一次用户操作才刷新。
        const pending = reconcilePendingRef.current;
        reconcilePendingRef.current = false;
        if (pending) {
          const latestSeq = loadSeqRef.current;
          const latestPair = availabilityRef.current;
          if (mountedRef.current && latestSeq !== seq && latestPair?.paired) {
            backgroundReconcileRef.current(latestPair, latestSeq);
          }
        }
      }
    },
    [refreshDestinations, showToast],
  );

  useEffect(() => {
    backgroundReconcileRef.current = (pair, seq) => {
      void backgroundReconcile(pair, seq);
    };
  }, [backgroundReconcile]);

  const load = useCallback(async () => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    if (!loadedRef.current) setLoading(true);
    setLoadError(null);
    try {
      // Local First：本地 SQLite 读取与配对状态并行，远程对账绝不进入这一段。
      const [pair, list, allDestinations, staged] = await Promise.all([
        captureAvailability(),
        repo.listAssets("saved"),
        repo.listAllDestinations(),
        repo.listStagedAssets(),
      ]);
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      loadedRef.current = true;
      availabilityRef.current = pair;
      setAssets(list);
      setDestinations(groupDestinations(allDestinations));
      setStagedCount(staged.length);
      setAvailability(pair);
      setLoading(false);
      if (pair.paired) {
        backgroundReconcileRef.current(pair, seq);
      }
    } catch (error) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setLoading(false);
      // 本地读取失败必须明确报错，不能伪装成「还没有本机素材」。
      setLoadError(describeError(error));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void load();
    return subscribeCaptureRevision(() => {
      void load();
    });
  }, [load]);

  useEffect(() => {
    if (!detail) return;
    detailTranslateY.setValue(0);
    setNameDraft(detail.name);
    setNoteDraft(detail.note);
  }, [detail?.id, detailTranslateY]);

  // 目的地状态会因后台对账/发送刷新；只更新状态行，不能重置用户正在编辑的草稿。
  useEffect(() => {
    if (!detail) return;
    setDetailDestinations(destinations[detail.id] ?? []);
  }, [detail?.id, destinations]);

  const detailPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_, gesture) => {
          detailTranslateY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_, gesture) => {
          const shouldClose = Math.abs(gesture.dy) > 72 || Math.abs(gesture.vy) > 1.1;
          if (shouldClose) {
            Animated.timing(detailTranslateY, {
              toValue: gesture.dy >= 0 ? 420 : -420,
              duration: 180,
              useNativeDriver: true,
            }).start(() => {
              setDetail(null);
              detailTranslateY.setValue(0);
            });
            return;
          }
          Animated.spring(detailTranslateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
            speed: 22,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(detailTranslateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
            speed: 22,
          }).start();
        },
      }),
    [detailTranslateY],
  );

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (typeFilter !== "all" && classifyAsset(asset) !== typeFilter) return false;
      if (keyword) {
        const haystack = `${asset.name} ${asset.note}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [assets, query, typeFilter]);

  const imagePool = useMemo(
    () => assets.filter((asset) => isImageAsset(asset) && (asset.thumbnailPath || asset.localPath)),
    [assets],
  );

  const toggleSelection = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const enterSelection = useCallback((id: string) => {
    setSelecting(true);
    setSelected(new Set([id]));
  }, []);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const selectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === visible.length ? new Set() : new Set(visible.map((asset) => asset.id)),
    );
  }, [visible]);

  const openLightbox = useCallback((asset: repo.CaptureAsset) => {
    const images: LightboxImage[] = imagePool.map((item) => ({
      uri: item.thumbnailPath ?? item.localPath ?? "",
      name: item.name,
    }));
    const index = imagePool.findIndex((item) => item.id === asset.id);
    setLightbox({ images, index: index >= 0 ? index : 0 });
  }, [imagePool]);

  const requestDelete = useCallback(
    (ids: string[]) => {
      if (ids.length === 0 || busy) return;
      setConfirmIds(ids);
    },
    [busy],
  );

  const runDelete = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0 || busy) return;
      setBusy(true);
      try {
        for (const id of ids) {
          const paths = await repo.deleteAsset(id);
          for (const path of paths) deleteFileQuietly(path);
        }
        exitSelection();
        if (detail && ids.includes(detail.id)) setDetail(null);
        await load();
        bumpCaptureRevision();
        showToast(`已删除 ${ids.length} 个本机素材`, "success");
      } catch (error) {
        // 删除是逐条进行的：失败前已删除的条目保留删除结果，但绝不能把整批显示成功。
        showToast(`删除本机素材失败：${describeError(error)}`, "danger");
        try {
          await load();
        } catch {
          // 刷新失败已由页面错误态/下一次手动刷新处理；这里不能再抛未处理 Promise。
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, detail, exitSelection, load, showToast],
  );

  const sendAssets = useCallback(
    async (ids: string[], target: "inbox" | "shelf") => {
      if (ids.length === 0 || busy) return;
      if (availability?.paired !== true) {
        showToast(availability?.reason ?? "尚未配对电脑", "warn");
        return;
      }
      setBusy(true);
      const token = createTransferCancelToken();
      cancelTokenRef.current = token;
      setCancelable(true);
      setCancelling(false);
      const outcomes: SendOutcome[] = [];
      let offlineMessage: string | null = null;
      let stopMessage: string | null = null;
      try {
        const list = assets.filter((asset) => ids.includes(asset.id));
        for (let i = 0; i < list.length; i += 1) {
          const asset = list[i];
          const items = destinations[asset.id] ?? [];
          const desktop = items.find((item) => item.destination === "desktop");
          const shelf = items.find((item) => item.destination === "shelf");
          if (target === "inbox" && desktop?.state === "done") {
            outcomes.push({ assetId: asset.id, state: "done", remoteId: desktop.remoteId ?? undefined });
            continue;
          }
          if (target === "shelf" && shelf?.state === "done") {
            // done 但没有真实 shelf_item_id 不能算成功，也不能让用户误以为已入架。
            outcomes.push({
              assetId: asset.id,
              state: shelf.remoteShelfId ? "done" : "failed",
              remoteId: shelf.remoteId ?? undefined,
              shelfId: shelf.remoteShelfId ?? undefined,
              message: shelf.remoteShelfId ? undefined : "已有暂存架记录，但缺少条目 ID，请刷新核对",
            });
            continue;
          }
          if (token.isCancelled()) {
            // 用户取消后不再发起任何新请求；本机文件不动，未完成的目的地写 cancelled。
            if (desktop?.state !== "done") {
              await repo.setDestination(asset.id, "desktop", {
                state: "cancelled",
                lastError: "文件传输已取消",
              });
            }
            if (target === "shelf" && shelf?.state !== "done") {
              await repo.setDestination(asset.id, "shelf", {
                state: "cancelled",
                lastError: "文件传输已取消",
              });
            }
            outcomes.push({ assetId: asset.id, state: "cancelled", message: "文件传输已取消" });
            continue;
          }
          setBusyLabel(
            `${target === "shelf" ? "发送到暂存架" : "发送到电脑"} ${i + 1}/${list.length}`,
          );
          if (target === "shelf" && desktop?.state === "done" && desktop.remoteId) {
            const retry = await retryShelfImport(asset, desktop.remoteId, null, token);
            outcomes.push({
              assetId: asset.id,
              state: retry.state,
              remoteId: desktop.remoteId,
              shelfId: retry.remoteShelfId ?? undefined,
              message: retry.message,
            });
            if (retry.state === "cancelled") {
              // 暂存架取消不删除已经完成的 desktop 文件；停止后续条目。
              for (let j = i + 1; j < list.length; j += 1) {
                const next = list[j];
                const nextItems = destinations[next.id] ?? [];
                const nextDesktop = nextItems.find((item) => item.destination === "desktop");
                const nextShelf = nextItems.find((item) => item.destination === "shelf");
                if (nextDesktop?.state !== "done") {
                  await repo.setDestination(next.id, "desktop", {
                    state: "cancelled",
                    lastError: "文件传输已取消",
                  });
                }
                if (target === "shelf" && nextShelf?.state !== "done") {
                  await repo.setDestination(next.id, "shelf", {
                    state: "cancelled",
                    lastError: "文件传输已取消",
                  });
                }
                outcomes.push({ assetId: next.id, state: "cancelled", message: "文件传输已取消" });
              }
              break;
            }
            if (retry.stopBatch) {
              stopMessage = retry.message;
              for (let j = i + 1; j < list.length; j += 1) {
                const next = list[j];
                if (target === "shelf") {
                  await repo.setDestination(next.id, "shelf", {
                    state: "failed",
                    lastError: retry.message,
                  });
                }
                outcomes.push({ assetId: next.id, state: "failed", message: retry.message });
              }
              break;
            }
            continue;
          }
          const result = await sendToDesktop([asset], {
            target,
            onProgress: setProgress,
            batch: { index: i, count: list.length },
            cancelToken: token,
          });
          outcomes.push(...result.outcomes);
          if (token.isCancelled()) {
            // sendToDesktop 已把当前条目和内存中的后续条目写好；继续循环只会
            // 在顶部走 cancelled 分支，不再产生网络请求。
            continue;
          }
          if (result.offline) {
            offlineMessage = result.message ?? "电脑端暂时不可达，已保留为待发送";
            for (let j = i + 1; j < list.length; j += 1) {
              const next = list[j];
              const nextItems = destinations[next.id] ?? [];
              const nextDesktop = nextItems.find((item) => item.destination === "desktop");
              if (nextDesktop?.state !== "done") {
                await repo.setDestination(next.id, "desktop", {
                  state: "pending",
                  lastError: offlineMessage,
                });
              }
              if (target === "shelf") {
                await repo.setDestination(next.id, "shelf", {
                  state: "pending",
                  lastError: offlineMessage,
                });
              }
              outcomes.push({
                assetId: next.id,
                state: "pending",
                message: offlineMessage,
              });
            }
            break;
          }
          if (result.stopBatch) {
            // 授权/安全类失败：停止整批，不把令牌失效伪装成「离线待发送」。
            stopMessage = result.message ?? "授权或安全校验失败，已停止本批发送";
            for (let j = i + 1; j < list.length; j += 1) {
              const next = list[j];
              const nextItems = destinations[next.id] ?? [];
              const nextDesktop = nextItems.find((item) => item.destination === "desktop");
              if (nextDesktop?.state !== "done") {
                await repo.setDestination(next.id, "desktop", {
                  state: "failed",
                  lastError: stopMessage,
                });
              }
              if (target === "shelf") {
                await repo.setDestination(next.id, "shelf", {
                  state: "failed",
                  lastError: stopMessage,
                });
              }
              outcomes.push({ assetId: next.id, state: "failed", message: stopMessage });
            }
            break;
          }
        }
        await load();
        const feedback = feedbackForSendResult(
          {
            outcomes,
            offline: Boolean(offlineMessage),
            message: offlineMessage ?? stopMessage ?? undefined,
            stopBatch: Boolean(stopMessage),
          },
          target,
        );
        showToast(feedback.message, feedback.tone);
        exitSelection();
      } catch (error) {
        // 页面级兜底：sendToDesktop/repo.load 自身失败时也必须让用户看到原因并释放 busy。
        showToast(`发送未完成：${describeError(error)}`, "danger");
      } finally {
        cancelTokenRef.current = null;
        setCancelable(false);
        setCancelling(false);
        setBusy(false);
        setBusyLabel("");
        setProgress(null);
      }
    },
    [assets, availability, busy, destinations, exitSelection, load, showToast],
  );

  const retryOne = useCallback(
    async (asset: repo.CaptureAsset, kind: repo.CaptureDestinationKind) => {
      if (busy) return;
      setBusy(true);
      setBusyLabel("重试中…");
      try {
        if (kind === "album") {
          await saveToAlbum(asset);
          showToast("已保存到相册", "success");
        } else if (kind === "desktop") {
          const token = createTransferCancelToken();
          cancelTokenRef.current = token;
          setCancelable(true);
          setCancelling(false);
          const result = await sendToDesktop([asset], {
            target: "inbox",
            onProgress: setProgress,
            cancelToken: token,
          });
          const feedback =
            !result.stopBatch && !result.offline && result.outcomes.length === 1
              ? feedbackForOutcome(result.outcomes[0], "inbox")
              : feedbackForSendResult(result, "inbox");
          showToast(feedback.message, feedback.tone);
        } else if (kind === "shelf") {
          const token = createTransferCancelToken();
          cancelTokenRef.current = token;
          setCancelable(true);
          setCancelling(false);
          const desktop = (destinations[asset.id] ?? []).find(
            (item) => item.destination === "desktop" && item.state === "done" && item.remoteId,
          );
          if (desktop?.remoteId) {
            const retry = await retryShelfImport(asset, desktop.remoteId, null, token);
            const feedback = feedbackForShelfRetry(retry);
            showToast(feedback.message, feedback.tone);
          } else {
            const result = await sendToDesktop([asset], {
              target: "shelf",
              onProgress: setProgress,
              cancelToken: token,
            });
            const feedback =
              !result.stopBatch && !result.offline && result.outcomes.length === 1
                ? feedbackForOutcome(result.outcomes[0], "shelf")
                : feedbackForSendResult(result, "shelf");
            showToast(feedback.message, feedback.tone);
          }
        }
        await load();
      } catch (error) {
        showToast(describeError(error), "danger");
      } finally {
        cancelTokenRef.current = null;
        setCancelable(false);
        setCancelling(false);
        setBusy(false);
        setBusyLabel("");
        setProgress(null);
      }
    },
    [busy, destinations, load, showToast],
  );

  const saveDetail = useCallback(async () => {
    if (!detail || busy) return;
    const name = nameDraft.trim();
    let nameSaved = false;
    setBusy(true);
    setBusyLabel("保存修改…");
    try {
      if (name && name !== detail.name) {
        try {
          await repo.renameAsset(detail.id, name);
          nameSaved = true;
        } catch (error) {
          throw new AppError("storage", `文件名保存失败：${describeError(error)}`, error);
        }
      }
      if (noteDraft !== detail.note) {
        try {
          await repo.updateAssetNote(detail.id, noteDraft);
        } catch (error) {
          throw new AppError(
            "storage",
            `${nameSaved ? "文件名已保存，但" : ""}备注保存失败：${describeError(error)}`,
            error,
          );
        }
      }
      try {
        await load();
      } catch (error) {
        throw new AppError("storage", `修改已写入，但刷新素材列表失败：${describeError(error)}`, error);
      }
      bumpCaptureRevision();
      setDetail((prev) =>
        prev ? { ...prev, name: name || prev.name, note: noteDraft } : prev,
      );
      showToast("已保存修改", "success");
    } catch (error) {
      showToast(describeError(error), "danger");
      if (nameSaved) {
        setDetail((prev) => (prev ? { ...prev, name } : prev));
      }
      try {
        await load();
      } catch {
        // 刷新失败已经在上面的错误提示里体现；这里不再抛第二个未处理异常。
      }
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }, [busy, detail, load, nameDraft, noteDraft, showToast]);

  const openFile = useCallback(
    async (asset: repo.CaptureAsset) => {
      if (!asset.localPath) return;
      try {
        await previewLocalFile(asset.localPath);
      } catch (error) {
        showToast(describeError(error), "danger");
      }
    },
    [showToast],
  );

  const now = Date.now();
  const selectedIds = [...selected];

  const bulkActions: BulkAction[] = [
    {
      key: "inbox",
      label: "发电脑",
      icon: "send",
      disabled: busy,
      onPress: () => void sendAssets(selectedIds, "inbox"),
    },
    {
      key: "shelf",
      label: "暂存架",
      icon: "folder",
      disabled: busy,
      onPress: () => void sendAssets(selectedIds, "shelf"),
    },
    {
      key: "delete",
      label: "删除",
      icon: "delete",
      tone: "danger",
      disabled: busy,
      onPress: () => requestDelete(selectedIds),
    },
  ];

  if (loading) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: tokens.bg }]}>
        <ActivityIndicator color={tokens.accent} />
      </View>
    );
  }

  if (loadError && assets.length === 0) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <AppBar title="采集暂存" onBack={nav.back} />
        <View style={styles.center}>
          <EmptyState
            icon="warning"
            title="本机素材读取失败"
            hint={loadError}
            actionLabel="重试"
            onAction={() => void load()}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar
        title={selecting ? `已选 ${selected.size}` : "采集暂存"}
        onBack={selecting ? exitSelection : nav.back}
        right={
          <View style={styles.headerActions}>
            {!selecting ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="从相册或文件导入"
                onPress={() => nav.push("capture_import")}
                style={styles.headerButton}
              >
                <Text style={[styles.headerText, { color: tokens.accentText }]}>导入</Text>
              </Pressable>
            ) : null}
            {assets.length > 0 ? (
              <>
                {selecting ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={selectAll}
                    style={styles.headerButton}
                  >
                    <Text style={[styles.headerText, { color: tokens.accentText }]}>
                      {selected.size === visible.length ? "取消全选" : "全选"}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => (selecting ? exitSelection() : setSelecting(true))}
                  style={styles.headerButton}
                >
                  <Text style={[styles.headerText, { color: tokens.accentText }]}>
                    {selecting ? "完成" : "选择"}
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
        }
      />

      {loadError ? (
        <View
          style={[
            styles.loadErrorNotice,
            { backgroundColor: tokens.dangerSoft, borderColor: tokens.cardBorder },
          ]}
        >
          <Text style={[styles.loadErrorText, { color: tokens.danger }]} numberOfLines={3}>
            本机数据刷新失败：{loadError}。当前显示上次成功加载的数据。
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重试读取本机素材"
            onPress={() => void load()}
            style={styles.loadErrorRetry}
          >
            <Text style={[styles.loadErrorRetryText, { color: tokens.accentText }]}>重试</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.searchRow}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索文件名、备注"
          accessibilityLabel="搜索本机素材"
        />
      </View>

      <View style={styles.filterRow}>
        <SegmentedControl
          options={TYPE_OPTIONS}
          value={typeFilter}
          onChange={setTypeFilter}
          accessibilityLabel="按类型筛选素材"
          emphasis="soft"
          size="compact"
        />
      </View>

      {stagedCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => nav.push("capture_review")}
          style={[styles.banner, { backgroundColor: tokens.accentSoft, borderColor: tokens.accent }]}
        >
          <Text style={[styles.bannerText, { color: tokens.accentText }]}>
            有 {stagedCount} 张照片尚未处理，点此继续保存
          </Text>
          <AppIcon name="chevronRight" color={tokens.accentText} size={18} />
        </Pressable>
      ) : null}

      {visible.length === 0 ? (
        <View style={styles.center}>
          <EmptyState
            icon="gallery"
            title={assets.length === 0 ? "还没有本机采集素材" : "没有符合筛选的素材"}
            hint={
              assets.length === 0
                ? "拍照或从相册/文件导入后会出现在这里；没有电脑时也可以先保存到本机。"
                : "切换类型筛选或搜索关键词，或回到采集中心继续采集。"
            }
            actionLabel={assets.length === 0 ? "去采集" : undefined}
            onAction={assets.length === 0 ? () => nav.push("capture_home") : undefined}
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.list,
            { paddingBottom: selecting ? BULK_ACTION_BAR_HEIGHT + insets.bottom + space.lg : 30 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {visible.map((asset) => {
            const items = destinations[asset.id] ?? [];
            const isSelected = selected.has(asset.id);
            const status = captureStatusOf(asset, items);
            const statusColor = statusTone(status.tone, tokens);
            const thumbUri = asset.thumbnailPath ?? asset.localPath;
            const showThumb = isImageAsset(asset) && Boolean(thumbUri);
            return (
              <Pressable
                key={asset.id}
                accessibilityRole={selecting ? "checkbox" : "button"}
                accessibilityState={selecting ? { checked: isSelected } : undefined}
                accessibilityLabel={asset.name}
                onPress={() => {
                  if (selecting) toggleSelection(asset.id);
                  else setDetail(asset);
                }}
                onLongPress={() => enterSelection(asset.id)}
                style={[
                  styles.card,
                  {
                    backgroundColor: tokens.card,
                    borderColor: isSelected ? tokens.accentFill : tokens.cardBorder,
                  },
                ]}
              >
                {selecting ? (
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: isSelected ? tokens.accentFill : tokens.muted,
                        backgroundColor: isSelected ? tokens.accentFill : "transparent",
                      },
                    ]}
                  >
                    {isSelected ? <AppIcon name="check" color={tokens.onAccent} size={14} /> : null}
                  </View>
                ) : null}
                {showThumb ? (
                  <Pressable
                    accessibilityRole="imagebutton"
                    accessibilityLabel={`查看图片 ${asset.name}`}
                    onPress={() => openLightbox(asset)}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Image
                      source={{ uri: thumbUri ?? undefined }}
                      style={styles.thumb}
                      resizeMode="cover"
                    />
                  </Pressable>
                ) : (
                  <View style={styles.fileIconBare}>
                    <FileTypeIcon kind={fileTypeOf(asset.name)} size={34} />
                  </View>
                )}
                <View style={styles.cardMain}>
                  <View style={styles.nameRow}>
                    <Text numberOfLines={1} style={[styles.cardName, { color: tokens.text }]}>
                      {asset.name}
                    </Text>
                    {asset.favorite ? (
                      <AppIcon name="star" color={tokens.warn} size={14} />
                    ) : null}
                  </View>
                  <Text style={[styles.cardMeta, { color: tokens.muted }]} numberOfLines={1}>
                    {formatRelative(asset.createdAt, now)} · {formatBytes(asset.byteSize)}
                  </Text>
                  <AssetStatusStrip
                    statusLabel={status.label}
                    statusColor={statusColor}
                    items={items}
                    tokens={tokens}
                  />
                  {items.some((item) => item.state === "failed") ? (
                    <Text style={[styles.cardError, { color: tokens.danger }]} numberOfLines={1}>
                      {items.find((item) => item.state === "failed")?.lastError}
                    </Text>
                  ) : null}
                </View>
                <AppIcon name="chevronRight" color={tokens.faint} size={18} />
              </Pressable>
            );
          })}
          <Text style={[styles.boundary, { color: tokens.faint }]}>
            素材保存在本机应用私有目录，卸载应用会被系统清理；不等于系统相册，也不等于电脑上的桌面暂存架。
          </Text>
        </ScrollView>
      )}

      {selecting && selected.size > 0 ? (
        <BulkActionBar
          selectedCount={selected.size}
          actions={bulkActions}
          onCancel={exitSelection}
          onLayout={bulkAnchor.onLayout}
        />
      ) : null}

      {busy ? (
        <View style={[styles.busyOverlay, { backgroundColor: tokens.overlay }]}>
          <View style={[styles.busyCard, { backgroundColor: tokens.sheet }]}>
            <ActivityIndicator color={tokens.accent} />
            <Text style={[styles.busyText, { color: tokens.text }]}>{busyLabel || "处理中…"}</Text>
            {progress ? (
              <Text style={[styles.busyMeta, { color: tokens.muted }]}>
                {progress.index + 1}/{progress.count} · {progress.done}/{progress.total} 块
              </Text>
            ) : null}
            {cancelable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={cancelling ? "正在取消上传" : "取消上传"}
                accessibilityState={{ disabled: cancelling }}
                disabled={cancelling}
                onPress={requestCancelTransfer}
                style={({ pressed }) => [
                  styles.busyCancel,
                  {
                    borderColor: tokens.accent,
                    backgroundColor: tokens.track,
                    opacity: cancelling ? 0.65 : pressed ? 0.75 : 1,
                  },
                ]}
              >
                <Text style={[styles.busyCancelText, { color: tokens.accentText }]}>
                  {cancelling ? "正在取消…" : "取消上传"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <BottomSheet
        visible={confirmIds !== null}
        onRequestClose={() => setConfirmIds(null)}
        accessibilityLabel="删除本机素材确认"
      >
        <Text numberOfLines={2} style={[styles.confirmTitle, { color: tokens.text }]}>
          {confirmIds && confirmIds.length > 0 ? `删除 ${confirmIds.length} 个本机素材？` : "删除本机素材？"}
        </Text>
        <Text numberOfLines={3} style={[styles.confirmHint, { color: tokens.muted }]}>
          只删除 TaskDock 本机副本与记录；系统相册里的照片、电脑上已接收的文件和暂存架托管副本都不会被删除。
        </Text>
        <View style={styles.confirmActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消删除"
            onPress={() => setConfirmIds(null)}
            style={({ pressed }) => [
              styles.confirmButton,
              styles.confirmCancel,
              { backgroundColor: tokens.track, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[styles.confirmCancelText, { color: tokens.textSoft }]}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="确认删除"
            disabled={busy}
            onPress={() => {
              const ids = confirmIds ?? [];
              setConfirmIds(null);
              void runDelete(ids);
            }}
            style={({ pressed }) => [
              styles.confirmButton,
              styles.confirmDelete,
              {
                backgroundColor: tokens.dangerSoft,
                opacity: busy ? 0.4 : pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.confirmDeleteText, { color: tokens.danger }]}>删除</Text>
          </Pressable>
        </View>
      </BottomSheet>

      <Modal
        visible={detail !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDetail(null)}
      >
        <View style={[styles.modalMask, { backgroundColor: tokens.overlay }]}>
          <Animated.View
            style={[
              styles.detailSheet,
              {
                backgroundColor: tokens.sheet,
                paddingBottom: (keyboardHeight > 0 ? 0 : insets.bottom) + space.md,
                marginBottom: keyboardHeight,
                maxHeight: sheetMaxHeight,
                transform: [{ translateY: detailTranslateY }],
              },
            ]}
          >
            <View
              {...detailPan.panHandlers}
              style={styles.detailDragHandle}
              accessible
              accessibilityLabel="拖动关闭素材详情"
              accessibilityHint="向上或向下拖动可关闭；也可以使用右上角关闭按钮或系统返回键"
            >
              <View style={[styles.detailDragBar, { backgroundColor: tokens.separator }]} />
            </View>
            {detail ? (
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <View style={styles.detailHeader}>
                  <Text style={[styles.detailTitle, { color: tokens.text }]} numberOfLines={1}>
                    素材详情
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="关闭"
                    onPress={() => setDetail(null)}
                    style={styles.detailClose}
                  >
                    <Text style={[styles.detailCloseText, { color: tokens.muted }]}>关闭</Text>
                  </Pressable>
                </View>
                {detail.localPath && isImageAsset(detail) ? (
                  <Pressable
                    onPress={() => openLightbox(detail)}
                    accessibilityRole="imagebutton"
                    accessibilityLabel="在灯箱中查看图片"
                  >
                    <Image
                      source={{ uri: detail.thumbnailPath ?? detail.localPath }}
                      style={[styles.detailImage, { backgroundColor: tokens.ink }]}
                      resizeMode="contain"
                    />
                  </Pressable>
                ) : detail.localPath ? (
                  <Pressable
                    onPress={() => void openFile(detail)}
                    accessibilityRole="button"
                    accessibilityLabel="用其他应用打开"
                    style={[styles.detailFileCard, { backgroundColor: tokens.track }]}
                  >
                    <FileTypeIcon kind={fileTypeOf(detail.name)} size={32} />
                    <Text style={[styles.detailFileName, { color: tokens.textSoft }]} numberOfLines={2}>
                      {detail.name}
                    </Text>
                    <Text style={[styles.detailFileHint, { color: tokens.muted }]}>
                      点击用其他应用打开
                    </Text>
                  </Pressable>
                ) : null}
                <Text style={[styles.detailMeta, { color: tokens.muted }]}>
                  {detail.kind} · {detail.mime} · {formatBytes(detail.byteSize)}
                  {detail.width && detail.height ? ` · ${detail.width}×${detail.height}` : ""}
                  {detail.sha256 ? ` · SHA-256 ${detail.sha256.slice(0, 12)}…` : ""}
                </Text>
                <Text style={[styles.fieldLabel, { color: tokens.muted }]}>文件名</Text>
                <TextInput
                  value={nameDraft}
                  onChangeText={setNameDraft}
                  style={[styles.input, { color: tokens.text, backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}
                  underlineColorAndroid="transparent"
                  accessibilityLabel="文件名"
                />
                <Text style={[styles.fieldLabel, { color: tokens.muted }]}>备注</Text>
                <TextInput
                  value={noteDraft}
                  onChangeText={setNoteDraft}
                  placeholder="只保存在本机素材记录"
                  placeholderTextColor={tokens.faint}
                  multiline
                  style={[styles.noteInput, { color: tokens.text, backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}
                  underlineColorAndroid="transparent"
                  accessibilityLabel="备注"
                />
                <View style={styles.detailActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void saveDetail()}
                    style={[styles.smallButton, { backgroundColor: tokens.accentFill }]}
                  >
                    <Text style={[styles.smallButtonText, { color: tokens.onAccent }]}>保存修改</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      void (async () => {
                        try {
                          await repo.setAssetFavorite(detail.id, !detail.favorite);
                          await load();
                          bumpCaptureRevision();
                          setDetail({ ...detail, favorite: !detail.favorite });
                        } catch (error) {
                          showToast(`更新收藏状态失败：${describeError(error)}`, "danger");
                        }
                      })();
                    }}
                    style={[styles.smallButton, { backgroundColor: tokens.track }]}
                  >
                    <Text style={[styles.smallButtonText, { color: tokens.textSoft }]}>
                      {detail.favorite ? "取消收藏" : "收藏"}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => requestDelete([detail.id])}
                    style={[styles.smallButton, { backgroundColor: tokens.dangerSoft }]}
                  >
                    <Text style={[styles.smallButtonText, { color: tokens.danger }]}>删除本机</Text>
                  </Pressable>
                </View>

                <Text style={[styles.sectionTitle, { color: tokens.text }]}>目标位置状态</Text>
                {(() => {
                  const status = captureStatusOf(detail, detailDestinations);
                  const color = statusTone(status.tone, tokens);
                  return (
                    <View style={styles.statusRow}>
                      <View
                        style={[
                          styles.statusBadge,
                          { backgroundColor: `${color}1F`, borderColor: `${color}55` },
                        ]}
                      >
                        <Text style={[styles.statusText, { color }]}>当前状态：{status.label}</Text>
                      </View>
                    </View>
                  );
                })()}
                {(["local", "album", "desktop", "shelf"] as const).map((kind) => {
                  const item = detailDestinations.find((entry) => entry.destination === kind);
                  if (!item && kind !== "album" && kind !== "desktop" && kind !== "shelf") return null;
                  const labels = {
                    local: "本机暂存",
                    album: "系统相册",
                    desktop: "电脑收件箱",
                    shelf: "桌面暂存架",
                  } as const;
                  const stateLabel = !item
                    ? "未执行"
                    : item.state === "done"
                      ? "成功"
                      : item.state === "failed"
                        ? "失败"
                        : item.state === "cancelled"
                          ? "已取消"
                          : item.state === "running"
                            ? "进行中"
                            : "等待连接";
                  const canRetry = item
                    ? item.state === "failed" || item.state === "cancelled" || item.state === "pending"
                    : kind !== "local";
                  return (
                    <View key={kind} style={styles.destRow}>
                      <View style={styles.destMain}>
                        <Text style={[styles.destTitle, { color: tokens.textSoft }]}>
                          {labels[kind]} · {stateLabel}
                        </Text>
                        {item?.lastError ? (
                          <Text style={[styles.destError, { color: tokens.danger }]} numberOfLines={3}>
                            {item.lastError}
                          </Text>
                        ) : null}
                      </View>
                      {canRetry && kind !== "local" ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void retryOne(detail, kind)}
                          style={[styles.retryButton, { borderColor: tokens.accent }]}
                        >
                          <Text style={[styles.retryText, { color: tokens.accentText }]}>重试</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
                <Text style={[styles.detailFoot, { color: tokens.faint }]}>
                  本机副本位于应用私有目录，卸载应用会被系统清理；系统相册与电脑上的副本独立存在。
                </Text>
              </ScrollView>
            ) : null}
          </Animated.View>
        </View>
      </Modal>

      <ImageLightbox
        visible={lightbox !== null}
        images={lightbox?.images ?? []}
        initialIndex={lightbox?.index ?? 0}
        onClose={() => setLightbox(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl },
  headerActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
  headerButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm },
  headerText: { fontSize: font.label, fontWeight: "600" },
  searchRow: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  loadErrorNotice: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    padding: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  loadErrorText: { flex: 1, fontSize: font.label, lineHeight: 16 },
  loadErrorRetry: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  loadErrorRetryText: { fontSize: font.label, fontWeight: "700" },
  filterRow: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  banner: {
    marginHorizontal: space.lg,
    marginTop: space.xs,
    padding: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  bannerText: { flex: 1, fontSize: font.label, fontWeight: "600" },
  list: { paddingHorizontal: space.lg, gap: space.sm },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.control,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  thumb: { width: 56, height: 56, borderRadius: radius.control },
  fileIconBare: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  cardMain: { flex: 1, gap: space.xxs, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  cardName: { flexShrink: 1, fontSize: font.title, fontWeight: "600" },
  cardMeta: { fontSize: font.meta },
  statusStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.xs,
    marginTop: space.xxs,
  },
  statusRow: { flexDirection: "row", marginTop: space.xs },
  statusBadge: {
    minHeight: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xxs,
    paddingHorizontal: space.sm,
    borderRadius: radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusText: { fontSize: font.label, fontWeight: "700" },
  cardError: { fontSize: font.label },
  boundary: {
    paddingTop: space.md,
    paddingHorizontal: space.xs,
    fontSize: font.label,
    lineHeight: 16,
  },
  busyOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  busyCard: {
    minWidth: 220,
    padding: space.lg,
    borderRadius: radius.card,
    alignItems: "center",
    gap: space.sm,
  },
  busyText: { fontSize: font.body, fontWeight: "600", textAlign: "center" },
  busyMeta: { fontSize: font.label },
  busyCancel: {
    minHeight: 38,
    minWidth: 128,
    paddingHorizontal: space.lg,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.xs,
  },
  busyCancelText: { fontSize: font.label, fontWeight: "600" },
  confirmTitle: { fontSize: font.title, fontWeight: "700", lineHeight: 22 },
  confirmHint: { fontSize: font.meta, lineHeight: 20, marginTop: space.xs },
  confirmActions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  confirmButton: { flex: 1, minHeight: 46, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  confirmCancel: {},
  confirmCancelText: { fontSize: font.body, fontWeight: "700" },
  confirmDelete: {},
  confirmDeleteText: { fontSize: font.body, fontWeight: "700" },
  modalMask: { flex: 1, justifyContent: "flex-end" },
  detailSheet: {
    maxHeight: "88%",
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  detailDragHandle: {
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -space.sm,
    marginBottom: space.xs,
  },
  detailDragBar: { width: 44, height: 5, borderRadius: 3 },
  detailHeader: { flexDirection: "row", alignItems: "center", marginBottom: space.sm },
  detailTitle: { flex: 1, fontSize: font.title, fontWeight: "700" },
  detailClose: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm },
  detailCloseText: { fontSize: font.label, fontWeight: "600" },
  detailImage: { width: "100%", height: 220, borderRadius: radius.row },
  detailFileCard: {
    width: "100%",
    minHeight: 150,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    padding: space.md,
  },
  detailFileName: { fontSize: font.body, fontWeight: "600", textAlign: "center" },
  detailFileHint: { fontSize: font.label },
  detailMeta: { fontSize: font.label, lineHeight: 16, marginTop: space.sm },
  fieldLabel: { fontSize: font.label, marginTop: space.sm },
  input: {
    minHeight: 40,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    marginTop: space.xs,
    fontSize: font.body,
  },
  noteInput: {
    minHeight: 56,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginTop: space.xs,
    fontSize: font.body,
    textAlignVertical: "top",
  },
  detailActions: { flexDirection: "row", gap: space.sm, marginTop: space.md, flexWrap: "wrap" },
  smallButton: { minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  smallButtonText: { fontSize: font.label, fontWeight: "700" },
  sectionTitle: { fontSize: font.label, fontWeight: "700", marginTop: space.md, marginBottom: space.xs },
  destRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs },
  destMain: { flex: 1, gap: space.xxs },
  destTitle: { fontSize: font.label, fontWeight: "600" },
  destError: { fontSize: font.label, lineHeight: 14 },
  retryButton: {
    minHeight: 34,
    paddingHorizontal: space.sm,
    borderRadius: radius.chip,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { fontSize: font.label, fontWeight: "700" },
  detailFoot: { fontSize: font.label, lineHeight: 14, marginTop: space.md },
});
