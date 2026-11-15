// 移动采集暂存：本机已保存素材的整理页。
//
// 数据边界（界面必须说清楚）：
// - 这里的副本在应用私有目录，卸载应用会被系统清理；不等于系统相册，也不等于桌面暂存架；
// - 删除本机素材只删本机副本与记录，不会删除系统相册里的照片或电脑上已接收的文件；
// - 上传/相册/暂存架状态按目的地分别展示，失败可单独重试，不重复执行已完成的目的地。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { AppBar } from "../../components/AppBar";
import { Chip } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { PressableScale } from "../../components/PressableScale";
import {
  Toast,
  TOAST_TOP_PUSH,
  type ToastMessage,
  type ToastTone,
} from "../../components/Toast";
import * as repo from "../../db/captureAssets";
import { formatRelative } from "../../domain/taskQuery";
import { describeError } from "../../lib/errors";
import { useWindowInsets } from "../../lib/insets";
import type { Nav } from "../../lib/nav";
import { formatBytes, previewLocalFile } from "../../lib/sync/fileIo";
import { useTheme } from "../../theme/ThemeProvider";
import { font, radius, space } from "../../theme/tokens";

import { deleteFileQuietly } from "./files";
import { bumpCaptureRevision, subscribeCaptureRevision } from "./revision";
import { captureStatusOf, type CaptureStatusTone } from "./status";
import {
  captureAvailability,
  retryShelfImport,
  saveToAlbum,
  sendToDesktop,
  type PairingAvailability,
  type SendProgress,
} from "./service";

type Filter = "all" | "unsent" | "favorite" | "failed";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "unsent", label: "未发送" },
  { value: "favorite", label: "收藏" },
  { value: "failed", label: "有失败" },
];

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

/** 非图片素材（扫描 PDF / 音频 / 文件）没有位图缩略图，用类型角标代替空白方块。 */
function typeBadge(asset: repo.CaptureAsset): string {
  if (asset.mime === "application/pdf") return "PDF";
  if (asset.mime.startsWith("audio/")) return "音频";
  if (asset.kind === "scan") return "扫描";
  return "文件";
}

function isImageAsset(asset: repo.CaptureAsset): boolean {
  return asset.mime.startsWith("image/");
}

function DestinationChips({
  items,
  tokens,
}: {
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
  if (shown.length === 0) return null;
  return (
    <View style={styles.badgeRow}>
      {shown.map((item) => (
        <View
          key={item.destination}
          style={[styles.destBadge, { backgroundColor: `${destinationTone(item.state, tokens)}1F` }]}
        >
          <Text style={[styles.destBadgeText, { color: destinationTone(item.state, tokens) }]}>
            {labels[item.destination]}
            {item.state === "done" ? " ✓" : item.state === "failed" ? " !" : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function CaptureStashScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const [assets, setAssets] = useState<repo.CaptureAsset[]>([]);
  const [destinations, setDestinations] = useState<Record<string, repo.CaptureDestination[]>>({});
  const [stagedCount, setStagedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<repo.CaptureAsset | null>(null);
  const [detailDestinations, setDetailDestinations] = useState<repo.CaptureDestination[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [availability, setAvailability] = useState<PairingAvailability | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone, placement: "bottom" });
  }, []);

  const load = useCallback(async () => {
    const [list, allDestinations, staged, pair] = await Promise.all([
      repo.listAssets("saved"),
      repo.listAllDestinations(),
      repo.listStagedAssets(),
      captureAvailability(),
    ]);
    const grouped: Record<string, repo.CaptureDestination[]> = {};
    for (const item of allDestinations) {
      (grouped[item.assetId] ??= []).push(item);
    }
    setAssets(list);
    setDestinations(grouped);
    setStagedCount(staged.length);
    setAvailability(pair);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return subscribeCaptureRevision(() => {
      void load();
    });
  }, [load]);

  useEffect(() => {
    if (!detail) return;
    setNameDraft(detail.name);
    setNoteDraft(detail.note);
    setDetailDestinations(destinations[detail.id] ?? []);
  }, [detail?.id, detail?.name, detail?.note, destinations]);

  const visible = useMemo(() => {
    return assets.filter((asset) => {
      const items = destinations[asset.id] ?? [];
      const failed = items.some((item) => item.state === "failed" || item.state === "cancelled");
      const sent = items.some(
        (item) => item.destination === "desktop" && item.state === "done",
      );
      if (filter === "favorite") return asset.favorite;
      if (filter === "failed") return failed;
      if (filter === "unsent") return !sent;
      return true;
    });
  }, [assets, destinations, filter]);

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

  const deleteSelected = useCallback(
    (ids: string[]) => {
      if (ids.length === 0 || busy) return;
      Alert.alert(
        `删除 ${ids.length} 个本机素材？`,
        "只删除 TaskDock 本机副本与记录；系统相册里的照片、电脑上已接收的文件和暂存架托管副本都不会被删除。",
        [
          { text: "取消", style: "cancel" },
          {
            text: "删除",
            style: "destructive",
            onPress: () => {
              void (async () => {
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
                } finally {
                  setBusy(false);
                }
              })();
            },
          },
        ],
      );
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
      const failures: string[] = [];
      let offline: string | null = null;
      try {
        const list = assets.filter((asset) => ids.includes(asset.id));
        for (let i = 0; i < list.length; i += 1) {
          const asset = list[i];
          const items = destinations[asset.id] ?? [];
          const desktop = items.find((item) => item.destination === "desktop");
          const shelf = items.find((item) => item.destination === "shelf");
          if (target === "inbox" && desktop?.state === "done") continue;
          if (target === "shelf" && shelf?.state === "done") continue;
          setBusyLabel(
            `${target === "shelf" ? "发送到暂存架" : "发送到电脑"} ${i + 1}/${list.length}`,
          );
          if (target === "shelf" && desktop?.state === "done" && desktop.remoteId) {
            try {
              await retryShelfImport(asset, desktop.remoteId, null);
            } catch (error) {
              failures.push(describeError(error));
            }
            continue;
          }
          const result = await sendToDesktop([asset], {
            target,
            onProgress: setProgress,
            batch: { index: i, count: list.length },
          });
          if (result.offline) {
            offline = result.message ?? "电脑端暂时不可达，已保留为待发送";
            break;
          }
          for (const outcome of result.outcomes) {
            if (outcome.state !== "done" && outcome.message) failures.push(outcome.message);
          }
        }
        await load();
        if (offline) showToast(offline, "warn");
        else if (failures.length > 0) showToast(failures[0], "danger");
        else showToast("发送完成", "success");
        exitSelection();
      } finally {
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
        } else if (kind === "desktop") {
          const result = await sendToDesktop([asset], { target: "inbox", onProgress: setProgress });
          if (result.offline) showToast(result.message ?? "电脑端不可达", "warn");
        } else if (kind === "shelf") {
          const desktop = (destinations[asset.id] ?? []).find(
            (item) => item.destination === "desktop" && item.state === "done" && item.remoteId,
          );
          if (desktop?.remoteId) {
            await retryShelfImport(asset, desktop.remoteId, null);
          } else {
            const result = await sendToDesktop([asset], {
              target: "shelf",
              onProgress: setProgress,
            });
            if (result.offline) showToast(result.message ?? "电脑端不可达", "warn");
          }
        }
        await load();
        showToast("已重试", "success");
      } catch (error) {
        showToast(describeError(error), "danger");
      } finally {
        setBusy(false);
        setBusyLabel("");
        setProgress(null);
      }
    },
    [busy, destinations, load, showToast],
  );

  const saveDetail = useCallback(async () => {
    if (!detail) return;
    const name = nameDraft.trim();
    if (name && name !== detail.name) await repo.renameAsset(detail.id, name);
    if (noteDraft !== detail.note) await repo.updateAssetNote(detail.id, noteDraft);
    await load();
    bumpCaptureRevision();
    showToast("已保存修改", "success");
  }, [detail, load, nameDraft, noteDraft, showToast]);

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

  if (loading) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: tokens.bg }]}>
        <ActivityIndicator color={tokens.accent} />
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

      {stagedCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => nav.push("capture_review")}
          style={[styles.banner, { backgroundColor: tokens.accentSoft, borderColor: tokens.accent }]}
        >
          <Text style={[styles.bannerText, { color: tokens.accentText }]}>
            有 {stagedCount} 张照片尚未处理，点此继续保存
          </Text>
          <Text style={[styles.bannerArrow, { color: tokens.accentText }]}>›</Text>
        </Pressable>
      ) : null}

      <View style={styles.filterRow}>
        {FILTERS.map((item) => (
          <Chip
            key={item.value}
            label={item.label}
            active={filter === item.value}
            onPress={() => setFilter(item.value)}
          />
        ))}
      </View>

      {visible.length === 0 ? (
        <View style={styles.center}>
          <EmptyState
            title={assets.length === 0 ? "还没有本机采集素材" : "没有符合筛选的素材"}
            hint={
              assets.length === 0
                ? "拍照或从相册导入后会出现在这里；没有电脑时也可以先保存到本机。"
                : "切换筛选条件，或回到相机继续采集。"
            }
          />
          <PressableScale
            accessibilityLabel="去拍照"
            onPress={() => nav.push("capture_camera")}
            contentStyle={[styles.cta, { backgroundColor: tokens.accentFill }]}
          >
            <Text style={[styles.ctaText, { color: tokens.onAccent }]}>去拍照</Text>
          </PressableScale>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {visible.map((asset) => {
            const items = destinations[asset.id] ?? [];
            const isSelected = selected.has(asset.id);
            const status = captureStatusOf(asset, items);
            const statusColor = statusTone(status.tone, tokens);
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
                    {isSelected ? <Text style={styles.checkGlyph}>✓</Text> : null}
                  </View>
                ) : null}
                {isImageAsset(asset) && (asset.thumbnailPath || asset.localPath) ? (
                  <Image
                    source={{ uri: asset.thumbnailPath ?? asset.localPath ?? undefined }}
                    style={styles.thumb}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[styles.thumb, styles.thumbType, { backgroundColor: tokens.track }]}>
                    <Text style={[styles.thumbTypeText, { color: tokens.textSoft }]}>
                      {typeBadge(asset)}
                    </Text>
                  </View>
                )}
                <View style={styles.cardMain}>
                  <View style={styles.nameRow}>
                    <Text numberOfLines={1} style={[styles.cardName, { color: tokens.text }]}>
                      {asset.name}
                    </Text>
                    {asset.favorite ? (
                      <Text style={[styles.star, { color: tokens.warn }]}>★</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.cardMeta, { color: tokens.muted }]} numberOfLines={1}>
                    {formatRelative(asset.createdAt, now)} · {formatBytes(asset.byteSize)}
                  </Text>
                  <View style={styles.statusRow}>
                    <View
                      style={[
                        styles.statusBadge,
                        { backgroundColor: `${statusColor}1F`, borderColor: `${statusColor}55` },
                      ]}
                    >
                      <Text style={[styles.statusText, { color: statusColor }]}>
                        {status.label}
                      </Text>
                    </View>
                  </View>
                  <DestinationChips items={items} tokens={tokens} />
                  {items.some((item) => item.state === "failed") ? (
                    <Text style={[styles.cardError, { color: tokens.danger }]} numberOfLines={1}>
                      {items.find((item) => item.state === "failed")?.lastError}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.chevron, { color: tokens.faint }]}>›</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {selecting && selected.size > 0 ? (
        <View
          style={[
            styles.batchBar,
            {
              backgroundColor: tokens.bg,
              borderColor: tokens.separator,
              paddingBottom: insets.bottom + space.sm,
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送到电脑收件箱"
            disabled={busy}
            onPress={() => void sendAssets(selectedIds, "inbox")}
            style={[styles.batchButton, { backgroundColor: tokens.accentFill }]}
          >
            <Text style={[styles.batchText, { color: tokens.onAccent }]}>发到收件箱</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送到桌面暂存架"
            disabled={busy}
            onPress={() => void sendAssets(selectedIds, "shelf")}
            style={[styles.batchButton, { backgroundColor: tokens.accentSoft }]}
          >
            <Text style={[styles.batchText, { color: tokens.accentText }]}>发到暂存架</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="删除所选"
            disabled={busy}
            onPress={() => deleteSelected(selectedIds)}
            style={[styles.batchDelete, { borderColor: tokens.danger }]}
          >
            <Text style={[styles.batchDeleteText, { color: tokens.danger }]}>删除</Text>
          </Pressable>
        </View>
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
          </View>
        </View>
      ) : null}

      <Modal
        visible={detail !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDetail(null)}
      >
        <View style={[styles.modalMask, { backgroundColor: tokens.overlay }]}>
          <View
            style={[
              styles.detailSheet,
              { backgroundColor: tokens.sheet, paddingBottom: insets.bottom + space.md },
            ]}
          >
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
                  <Pressable onPress={() => void openFile(detail)} accessibilityRole="imagebutton">
                    <Image
                      source={{ uri: detail.thumbnailPath ?? detail.localPath }}
                      style={styles.detailImage}
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
                    <Text style={[styles.detailFileGlyph, { color: tokens.text }]}>
                      {typeBadge(detail)}
                    </Text>
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
                        await repo.setAssetFavorite(detail.id, !detail.favorite);
                        await load();
                        bumpCaptureRevision();
                        setDetail({ ...detail, favorite: !detail.favorite });
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
                    onPress={() => deleteSelected([detail.id])}
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
          </View>
        </View>
      </Modal>

      <Toast
        toast={toast}
        onDismiss={() => setToast(null)}
        placement="bottom"
        topOffset={TOAST_TOP_PUSH}
        bottomOffset={insets.bottom + (selecting ? 88 : 24)}
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
  banner: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    padding: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  bannerText: { flex: 1, fontSize: font.label, fontWeight: "600" },
  bannerArrow: { fontSize: 20, marginTop: -2 },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  list: { paddingHorizontal: space.lg, paddingBottom: 120, gap: space.sm },
  card: {
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
  checkGlyph: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: "#0E1A2B" },
  thumbType: { alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(120,140,165,0.35)" },
  thumbTypeText: { fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  cardMain: { flex: 1, gap: 2, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  cardName: { flexShrink: 1, fontSize: font.body, fontWeight: "600" },
  star: { fontSize: 13 },
  cardMeta: { fontSize: 11 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 2 },
  statusRow: { flexDirection: "row", marginTop: 3 },
  statusBadge: {
    minHeight: 20,
    paddingHorizontal: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  statusText: { fontSize: 10.5, fontWeight: "700" },
  destBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999 },
  destBadgeText: { fontSize: 10, fontWeight: "700" },
  cardError: { fontSize: 10.5 },
  chevron: { fontSize: 22, marginTop: -2 },
  batchBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  batchButton: { flex: 1, minHeight: 46, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  batchText: { fontSize: font.label, fontWeight: "700" },
  batchDelete: {
    minHeight: 46,
    paddingHorizontal: space.md,
    borderRadius: radius.row,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  batchDeleteText: { fontSize: font.label, fontWeight: "700" },
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
  modalMask: { flex: 1, justifyContent: "flex-end" },
  detailSheet: {
    maxHeight: "88%",
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  detailHeader: { flexDirection: "row", alignItems: "center", marginBottom: space.sm },
  detailTitle: { flex: 1, fontSize: font.title, fontWeight: "700" },
  detailClose: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm },
  detailCloseText: { fontSize: font.label, fontWeight: "600" },
  detailImage: { width: "100%", height: 220, borderRadius: radius.row, backgroundColor: "#0E1A2B" },
  detailFileCard: {
    width: "100%",
    minHeight: 150,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    padding: space.md,
  },
  detailFileGlyph: { fontSize: 22, fontWeight: "800", letterSpacing: 1 },
  detailFileName: { fontSize: font.body, fontWeight: "600", textAlign: "center" },
  detailFileHint: { fontSize: font.label },
  detailMeta: { fontSize: font.label, lineHeight: 16, marginTop: space.sm },
  fieldLabel: { fontSize: font.label, marginTop: space.sm },
  input: {
    minHeight: 40,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    marginTop: 4,
    fontSize: font.body,
  },
  noteInput: {
    minHeight: 56,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginTop: 4,
    fontSize: font.body,
    textAlignVertical: "top",
  },
  detailActions: { flexDirection: "row", gap: space.sm, marginTop: space.md, flexWrap: "wrap" },
  smallButton: { minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  smallButtonText: { fontSize: font.label, fontWeight: "700" },
  sectionTitle: { fontSize: font.label, fontWeight: "700", marginTop: space.md, marginBottom: space.xs },
  destRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  destMain: { flex: 1, gap: 2 },
  destTitle: { fontSize: font.label, fontWeight: "600" },
  destError: { fontSize: 10.5, lineHeight: 14 },
  retryButton: {
    minHeight: 34,
    paddingHorizontal: space.sm,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { fontSize: 11, fontWeight: "700" },
  detailFoot: { fontSize: 10.5, lineHeight: 14, marginTop: space.md },
  cta: { minHeight: 46, paddingHorizontal: space.xl, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  ctaText: { fontSize: font.body, fontWeight: "700" },
});
