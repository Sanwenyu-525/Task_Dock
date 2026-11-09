// 文件互传：电脑 → 手机下载、手机 → 电脑上传。
//
// 交互约束：
// - 同一时刻只跑一个传输（顺序执行），避免多路分块互相抢占内存与带宽；
// - 下载必须先选定接收目录（SAF 授权持久化），未选时现场弹出选择器；
// - 取消只中止在途请求，桌面端半成品记录由失败清理或下次启动恢复清除；
// - 所有网络错误都在页内 Toast 展示，不弹系统对话框（除删除确认）。
//
// 布局约束：
// - 「发送文件到电脑」固定在底部操作区：列表再长也不用滚到底才能发送；
// - 传输进行时底部操作区切换为进度与取消，进度始终可见、不随列表滚走；
// - 列表按方向分组，只有接收中/失败才用语义色，可下载/已接收保持中性，
//   避免整列彩色噪音把真正的异常淹掉。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AppBar } from "../components/AppBar";
import { EmptyState } from "../components/EmptyState";
import { FileTypeIcon, fileTypeOf } from "../components/FileTypeIcon";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import {
  Toast,
  TOAST_TOP_PUSH,
  type ToastMessage,
  type ToastPlacement,
  type ToastTone,
} from "../components/Toast";
import { getSetting, setSetting } from "../db/kv";
import { loadConnection, readToken, type PairedConnection } from "../db/syncConnection";
import { AppError, describeError } from "../lib/errors";
import { useWindowInsets } from "../lib/insets";
import type { Nav } from "../lib/nav";
import { deriveSyncKey } from "../lib/sync/crypto";
import {
  createFileClient,
  isFileCancelled,
  type FileClient,
  type RemoteFile,
} from "../lib/sync/files";
import {
  directoryLabel,
  downloadRemoteFile,
  formatBytes,
  pickLocalFiles,
  pickSaveDirectory,
  previewLocalFile,
  uploadDisplayName,
  uploadLocalFile,
} from "../lib/sync/fileIo";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

/** 接收目录的 SAF URI；只在用户主动选择后写入。 */
const SAVE_DIR_KEY = "files.save_dir.v1";
/** 单次最多上传的文件数：防止误选整个目录导致长时间占用。 */
const MAX_BATCH_FILES = 20;
/** 36dp 视觉按钮补到 44dp 命中区。 */
const ROW_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

interface TransferState {
  kind: "upload" | "download";
  name: string;
  /** 下载时用于把行按钮精确关联到记录；上传没有远端 id 之前的稳定值 */
  fileId?: string;
  /** 总字节数：用于进度文案，不再暴露「块」这种内部术语 */
  size: number;
  /** 每块字节数：下载取服务端 chunk_size，上传按 size/total 估算 */
  chunkBytes: number;
  done: number;
  total: number;
  /** 批量上传时的「第几个」，单文件下载不显示 */
  batch?: { index: number; total: number };
}

type MetaTone = "muted" | "warn" | "danger";

/** 文件行的状态文案：可下载是默认态，不上色也不重复成胶囊。 */
function fileStatus(file: RemoteFile): { text: string; tone: MetaTone } {
  if (file.status === "failed") return { text: "传输失败", tone: "danger" };
  if (file.status === "pending") {
    return {
      text: `${file.direction === "to_phone" ? "接收中" : "上传中"} ${file.received_chunks}/${file.chunks}`,
      tone: "warn",
    };
  }
  // 手机上传完成后仍保留在「发往电脑」列表里：明确标出「已接收」，
  // 避免用户把一条已完成记录误读成待处理。
  if (file.direction === "to_desktop") return { text: "已接收", tone: "muted" };
  return { text: "", tone: "muted" };
}

function formatFileTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const now = new Date();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? `今天 ${time}` : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function RemoveGlyph({ color }: { color: string }) {
  return (
    <View style={styles.removeGlyph} importantForAccessibility="no-hide-descendants">
      <View
        style={[styles.removeBar, { backgroundColor: color, transform: [{ rotate: "45deg" }] }]}
      />
      <View
        style={[styles.removeBar, { backgroundColor: color, transform: [{ rotate: "-45deg" }] }]}
      />
    </View>
  );
}

function SectionHeader({
  title,
  count,
  tone,
}: {
  title: string;
  count: number;
  tone: "accent" | "ok";
}) {
  const { tokens } = useTheme();

  return (
    <View style={styles.sectionHead}>
      <View
        style={[styles.sectionBar, { backgroundColor: tone === "accent" ? tokens.accent : tokens.ok }]}
      />
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: tokens.text }]}>
        {title}
      </Text>
      <Text style={[styles.sectionCount, { color: tokens.muted }]}>{`(${count})`}</Text>
      <View style={[styles.sectionRule, { backgroundColor: tokens.separator }]} />
    </View>
  );
}

function EmptyPanel({ title, hint }: { title: string; hint: string }) {
  const { tokens } = useTheme();

  return (
    <View style={[styles.emptyPanel, { backgroundColor: tokens.track }]}>
      <Text style={[styles.emptyTitle, { color: tokens.textSoft }]}>{title}</Text>
      <Text style={[styles.emptyHint, { color: tokens.muted }]}>{hint}</Text>
    </View>
  );
}

function FileRow({
  file,
  action,
  removeLabel,
  removeDisabled,
  onRemove,
}: {
  file: RemoteFile;
  action?: ReactNode;
  removeLabel: string;
  removeDisabled: boolean;
  onRemove: () => void;
}) {
  const { tokens } = useTheme();
  const incoming = file.direction === "to_phone";
  const status = fileStatus(file);
  const metaColor =
    status.tone === "danger"
      ? tokens.danger
      : status.tone === "warn"
        ? tokens.warn
        : tokens.muted;
  const meta = [
    formatBytes(file.size),
    formatFileTime(file.completed_at ?? file.created_at),
    status.text,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View
      style={[styles.fileRow, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}
    >
      <View
        style={[
          styles.fileTile,
          { backgroundColor: incoming ? tokens.accentSoft : tokens.okSoft },
        ]}
      >
        <FileTypeIcon
          kind={fileTypeOf(file.name)}
          color={incoming ? tokens.accent : tokens.ok}
        />
      </View>

      <View style={styles.fileMain}>
        <Text numberOfLines={1} style={[styles.fileName, { color: tokens.text }]}>
          {file.name}
        </Text>
        <Text numberOfLines={1} style={[styles.fileMeta, { color: metaColor }]}>
          {meta}
        </Text>
      </View>

      {action}

      <PressableScale
        onPress={onRemove}
        accessibilityLabel={removeLabel}
        disabled={removeDisabled}
        hitSlop={ROW_HIT_SLOP}
        contentStyle={styles.removeButton}
      >
        <RemoveGlyph color={tokens.muted} />
      </PressableScale>
    </View>
  );
}

export function FilesScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();

  const [connection, setConnection] = useState<PairedConnection | null>(null);
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saveDir, setSaveDir] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<Record<string, string>>({});
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const toastSeq = useRef(0);
  const mounted = useRef(true);
  const clientRef = useRef<FileClient | null>(null);
  /**
   * 取消意图：client.cancel() 只中止在途请求，分块之间可能恰好没有请求在飞，
   * 下一块会重新发起并继续传输。fileIo 在每块前后检查这个标记。
   */
  const cancelRequested = useRef(false);

  const showToast = useCallback(
    (text: string, tone: ToastTone = "info", placement?: ToastPlacement) => {
      toastSeq.current += 1;
      setToast({ id: toastSeq.current, text, tone, placement });
    },
    [],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  const ensureClient = useCallback(async (): Promise<FileClient> => {
    if (clientRef.current) return clientRef.current;
    const meta = await loadConnection();
    if (!meta) {
      throw new AppError("validation", "尚未配对，请先与桌面端配对");
    }
    const token = await readToken();
    if (!token) {
      throw new AppError("validation", "本机配对令牌不可用，请重新配对");
    }
    const syncKey = await deriveSyncKey(token);
    const client = createFileClient({ baseUrl: meta.baseUrl, token, syncKey });
    clientRef.current = client;
    return client;
  }, []);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true);
      try {
        const client = await ensureClient();
        const next = await client.list();
        if (!mounted.current) return;
        setFiles(next);
      } catch (error) {
        if (mounted.current) {
          showToast(`读取文件列表失败：${describeError(error)}`, "danger");
        }
      } finally {
        if (mounted.current) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    },
    [ensureClient, showToast],
  );

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const [meta, dir] = await Promise.all([
        loadConnection().catch(() => null),
        getSetting(SAVE_DIR_KEY).catch(() => null),
      ]);
      if (!mounted.current) return;
      setConnection(meta);
      setSaveDir(dir);
      if (meta) {
        await refresh(true);
      } else {
        setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
      // 页面卸载时同样要阻止分块之间继续发起下一块。
      cancelRequested.current = true;
      clientRef.current?.cancel();
    };
  }, [refresh]);

  const chooseSaveDir = useCallback(async (): Promise<string | null> => {
    try {
      const uri = await pickSaveDirectory();
      await setSetting(SAVE_DIR_KEY, uri);
      if (mounted.current) setSaveDir(uri);
      return uri;
    } catch (error) {
      if (mounted.current) {
        showToast(`选择接收位置失败：${describeError(error)}`, "danger");
      }
      return null;
    }
  }, [showToast]);

  const cancelTransfer = useCallback(() => {
    cancelRequested.current = true;
    clientRef.current?.cancel();
    showToast("正在取消…", "info", "bottom");
  }, [showToast]);

  const startDownload = useCallback(
    async (file: RemoteFile) => {
      if (transfer) return;
      cancelRequested.current = false;
      let directory = saveDir;
      if (!directory) {
        directory = await chooseSaveDir();
        if (!directory) return;
      }

      setTransfer({
        kind: "download",
        fileId: file.id,
        name: file.name,
        size: file.size,
        chunkBytes: file.chunk_size,
        done: 0,
        total: file.chunks,
      });
      try {
        const client = await ensureClient();
        const uri = await downloadRemoteFile(
          client,
          file,
          directory,
          (done, total) => {
            if (mounted.current) {
              setTransfer((prev) =>
                prev && prev.kind === "download" ? { ...prev, done, total } : prev,
              );
            }
          },
          () => cancelRequested.current,
        );
        if (!mounted.current) return;
        setDownloaded((prev) => ({ ...prev, [file.id]: uri }));
        showToast(`已下载：${file.name}`, "success", "bottom");
      } catch (error) {
        if (!mounted.current) return;
        if (isFileCancelled(error)) {
          showToast("已取消下载", "info", "bottom");
        } else {
          showToast(`下载失败：${describeError(error)}`, "danger", "bottom");
        }
      } finally {
        if (mounted.current) setTransfer(null);
      }
    },
    [chooseSaveDir, ensureClient, saveDir, showToast, transfer],
  );

  const startUpload = useCallback(async () => {
    if (transfer) return;
    cancelRequested.current = false;
    let picked;
    try {
      picked = await pickLocalFiles();
    } catch (error) {
      showToast(`打开文件选择器失败：${describeError(error)}`, "danger", "bottom");
      return;
    }
    if (picked.length === 0) return;
    if (picked.length > MAX_BATCH_FILES) {
      showToast(`一次最多发送 ${MAX_BATCH_FILES} 个文件，请分批选择`, "danger", "bottom");
      return;
    }

    try {
      const client = await ensureClient();
      for (let index = 0; index < picked.length; index += 1) {
        if (!mounted.current) return;
        const file = picked[index];
        const displayName = uploadDisplayName(file);
        setTransfer({
          kind: "upload",
          name: displayName,
          size: file.size,
          chunkBytes: 0,
          done: 0,
          total: 0,
          batch: { index: index + 1, total: picked.length },
        });
        try {
          const result = await uploadLocalFile(
            client,
            file,
            (done, total) => {
              if (mounted.current) {
                setTransfer((prev) =>
                  prev && prev.kind === "upload"
                    ? {
                        ...prev,
                        done,
                        total,
                        chunkBytes: total > 0 ? Math.ceil(file.size / total) : 0,
                      }
                    : prev,
                );
              }
            },
            () => cancelRequested.current,
          );
          if (mounted.current) showToast(`已发送：${result.name}`, "success", "bottom");
        } catch (error) {
          if (!mounted.current) return;
          if (isFileCancelled(error)) {
            const rest = picked.length - index - 1;
            showToast(
              rest > 0 ? `已取消上传，剩余 ${rest} 个文件未发送` : "已取消上传",
              "info",
              "bottom",
            );
          } else {
            showToast(`发送「${displayName}」失败：${describeError(error)}`, "danger", "bottom");
          }
          break;
        }
      }
    } catch (error) {
      if (mounted.current) showToast(describeError(error), "danger", "bottom");
    } finally {
      if (mounted.current) setTransfer(null);
      await refresh(true);
    }
  }, [ensureClient, refresh, showToast, transfer]);

  const removeRemote = useCallback(
    (file: RemoteFile) => {
      const detail =
        file.direction === "to_phone"
          ? "将删除电脑上的副本，手机端之后无法再下载。"
          : "将删除电脑上已接收的文件。";
      Alert.alert(`删除「${file.name}」？`, detail, [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                const client = await ensureClient();
                await client.remove(file.id);
                if (!mounted.current) return;
                setDownloaded((prev) => {
                  const next = { ...prev };
                  delete next[file.id];
                  return next;
                });
                showToast("已删除电脑端副本", "success");
                await refresh(true);
              } catch (error) {
                if (mounted.current) {
                  showToast(`删除失败：${describeError(error)}`, "danger");
                }
              }
            })();
          },
        },
      ]);
    },
    [ensureClient, refresh, showToast],
  );

  const openLocal = useCallback(
    async (uri: string) => {
      try {
        await previewLocalFile(uri);
      } catch (error) {
        showToast(`打开文件失败：${describeError(error)}`, "danger");
      }
    },
    [showToast],
  );

  const incoming = files.filter((file) => file.direction === "to_phone");
  const outgoing = files.filter((file) => file.direction === "to_desktop");
  const percent =
    transfer && transfer.total > 0
      ? Math.min(100, Math.round((transfer.done / transfer.total) * 100))
      : 0;
  const doneBytes =
    transfer && transfer.chunkBytes > 0
      ? Math.min(transfer.size, transfer.done * transfer.chunkBytes)
      : 0;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top }]}>
      <AppBar
        title="文件互传"
        onBack={() => nav.back()}
        right={
          <PressableScale
            onPress={() => void refresh()}
            accessibilityLabel="刷新文件列表"
            disabled={refreshing}
            contentStyle={styles.refresh}
          >
            <Text style={[styles.refreshText, { color: refreshing ? tokens.muted : tokens.accent }]}>
              {refreshing ? "刷新中" : "刷新"}
            </Text>
          </PressableScale>
        }
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          connection ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={tokens.accent}
              colors={[tokens.accent]}
              progressBackgroundColor={tokens.card}
            />
          ) : undefined
        }
      >
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={tokens.accent} />
            <Text style={[styles.hint, { color: tokens.muted }]}>正在读取传输记录…</Text>
          </View>
        ) : !connection ? (
          <EmptyState
            title="尚未配对"
            hint="文件互传需要先与桌面端在同一 Wi-Fi 下配对，传输只走局域网。"
            actionLabel="去配对"
            onAction={() => nav.push("pairing")}
          />
        ) : (
          <>
            <GlassCard style={styles.dirCard}>
              <View style={styles.dirMain}>
                <Text style={[styles.dirLabel, { color: tokens.muted }]}>接收位置</Text>
                <Text numberOfLines={1} style={[styles.dirValue, { color: tokens.text }]}>
                  {saveDir ? directoryLabel(saveDir) : "尚未选择"}
                </Text>
              </View>
              <PressableScale
                onPress={() => void chooseSaveDir()}
                accessibilityLabel={saveDir ? "更改接收位置" : "选择接收位置"}
                contentStyle={styles.dirAction}
              >
                <Text style={[styles.dirActionText, { color: tokens.accent }]}>
                  {saveDir ? "更改" : "选择"}
                </Text>
              </PressableScale>
            </GlassCard>

            <SectionHeader title="来自电脑" count={incoming.length} tone="accent" />
            {incoming.length === 0 ? (
              <EmptyPanel
                title="还没有可下载的文件"
                hint="在电脑端「设置 → 手机与同步 → 文件互传」点「发送文件」，文件会出现在这里。"
              />
            ) : (
              incoming.map((file) => {
                const localUri = downloaded[file.id];
                const active = transfer?.fileId === file.id;
                let action: ReactNode = null;
                if (localUri) {
                  action = (
                    <PressableScale
                      onPress={() => void openLocal(localUri)}
                      accessibilityLabel={`打开 ${file.name}`}
                      hitSlop={ROW_HIT_SLOP}
                      contentStyle={[styles.rowAction, { backgroundColor: tokens.accentSoft }]}
                    >
                      <Text style={[styles.rowActionText, { color: tokens.accent }]}>打开</Text>
                    </PressableScale>
                  );
                } else if (active) {
                  action = (
                    <Text style={[styles.rowBusy, { color: tokens.accent }]}>下载中</Text>
                  );
                } else if (file.status === "ready") {
                  action = (
                    <PressableScale
                      onPress={() => void startDownload(file)}
                      accessibilityLabel={`下载 ${file.name}`}
                      disabled={Boolean(transfer)}
                      hitSlop={ROW_HIT_SLOP}
                      contentStyle={[styles.rowAction, { backgroundColor: tokens.accentFill }]}
                    >
                      <Text style={[styles.rowActionText, { color: tokens.onAccent }]}>下载</Text>
                    </PressableScale>
                  );
                } else if (file.status === "pending") {
                  action = <Text style={[styles.rowBusy, { color: tokens.muted }]}>等待中</Text>;
                }
                return (
                  <FileRow
                    key={file.id}
                    file={file}
                    action={action}
                    removeLabel={`删除电脑上的 ${file.name}`}
                    removeDisabled={active}
                    onRemove={() => removeRemote(file)}
                  />
                );
              })
            )}

            <SectionHeader title="发往电脑" count={outgoing.length} tone="ok" />
            {outgoing.length === 0 ? (
              <EmptyPanel
                title="还没有上传记录"
                hint="点下方「发送文件到电脑」，从手机选择文件上传；上传完成后保存在电脑的应用数据目录。"
              />
            ) : (
              outgoing.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  removeLabel={`从电脑移除 ${file.name}`}
                  removeDisabled={false}
                  onRemove={() => removeRemote(file)}
                />
              ))
            )}

            <Text style={[styles.footer, { color: tokens.faint }]}>
              文件只在局域网内传输，不经过云端；下载文件保存在你选择的接收位置。
            </Text>
          </>
        )}
      </ScrollView>

      {connection && !loading ? (
        <View
          style={[
            styles.dock,
            {
              backgroundColor: tokens.card,
              borderColor: tokens.separator,
              paddingBottom: insets.bottom + space.md,
            },
          ]}
        >
          {transfer ? (
            <>
              <View style={styles.dockHead}>
                <Text style={[styles.dockKind, { color: tokens.accent }]}>
                  {transfer.kind === "upload" ? "正在上传" : "正在下载"}
                </Text>
                <Text numberOfLines={1} style={[styles.dockName, { color: tokens.text }]}>
                  {transfer.name}
                </Text>
                <PressableScale
                  onPress={cancelTransfer}
                  accessibilityLabel="取消传输"
                  contentStyle={styles.cancelButton}
                >
                  <Text style={[styles.cancelText, { color: tokens.danger }]}>取消</Text>
                </PressableScale>
              </View>
              <View
                accessibilityRole="progressbar"
                accessibilityLabel={`${transfer.kind === "upload" ? "上传" : "下载"}进度`}
                accessibilityValue={{ min: 0, max: 100, now: percent }}
                style={[styles.progressTrack, { backgroundColor: tokens.separator }]}
              >
                <View
                  style={[
                    styles.progressFill,
                    { backgroundColor: tokens.accent, width: `${percent}%` },
                  ]}
                />
              </View>
              <View style={styles.dockFoot}>
                <Text style={[styles.dockMeta, { color: tokens.muted }]}>
                  {transfer.total > 0
                    ? `${formatBytes(doneBytes)} / ${formatBytes(transfer.size)} · ${percent}%`
                    : "准备中…"}
                </Text>
                {transfer.batch ? (
                  <Text style={[styles.dockMeta, { color: tokens.muted }]}>
                    第 {transfer.batch.index}/{transfer.batch.total} 个
                  </Text>
                ) : null}
              </View>
            </>
          ) : (
            <PressableScale
              onPress={() => void startUpload()}
              accessibilityLabel="发送文件到电脑"
              contentStyle={[styles.uploadButton, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.uploadText, { color: tokens.onAccent }]}>
                发送文件到电脑
              </Text>
            </PressableScale>
          )}
        </View>
      ) : null}

      <Toast
        toast={toast}
        onDismiss={dismissToast}
        placement="top"
        topOffset={TOAST_TOP_PUSH}
        bottomOffset={insets.bottom + 116}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // 底部操作区是 ScrollView 的兄弟节点：必须显式 flex:1，列表再长也不会把操作区顶出屏幕。
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  refresh: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.xs,
  },
  refreshText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  loading: {
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.xl,
  },
  hint: {
    fontSize: font.meta,
  },
  dirCard: {
    padding: space.md,
    // GlassCard 默认是纵向容器；接收位置与「更改」必须显式横排，
    // 否则按钮会掉到下一行、把卡片撑高。
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  dirMain: {
    flex: 1,
    gap: 2,
  },
  dirLabel: {
    fontSize: font.label,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  dirValue: {
    fontSize: font.body,
    fontWeight: "600",
  },
  dirAction: {
    minHeight: 44,
    minWidth: 52,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  dirActionText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.lg,
  },
  sectionBar: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  sectionTitle: {
    fontSize: font.body,
    fontWeight: "700",
  },
  sectionCount: {
    fontSize: font.label,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  emptyPanel: {
    borderRadius: radius.row,
    padding: space.md,
    gap: 3,
  },
  emptyTitle: {
    fontSize: font.body,
    fontWeight: "600",
  },
  emptyHint: {
    fontSize: font.meta,
    lineHeight: 18,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fileTile: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  fileMain: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    fontSize: font.body,
    fontWeight: "600",
  },
  fileMeta: {
    fontSize: font.meta,
    fontVariant: ["tabular-nums"],
  },
  rowAction: {
    minHeight: 36,
    minWidth: 56,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  rowActionText: {
    fontSize: font.meta,
    fontWeight: "700",
  },
  rowBusy: {
    fontSize: font.meta,
    fontWeight: "600",
    paddingHorizontal: space.xs,
  },
  removeButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  removeGlyph: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  removeBar: {
    position: "absolute",
    width: 13,
    height: 1.5,
    borderRadius: 1,
  },
  footer: {
    marginTop: space.lg,
    fontSize: font.label,
    lineHeight: 17,
    textAlign: "center",
  },
  dock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
  },
  dockHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 28,
  },
  dockKind: {
    fontSize: font.label,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  dockName: {
    flex: 1,
    fontSize: font.body,
    fontWeight: "600",
  },
  cancelButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  cancelText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
  },
  dockFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  dockMeta: {
    fontSize: font.label,
    fontVariant: ["tabular-nums"],
  },
  uploadButton: {
    minHeight: 48,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  uploadText: {
    fontSize: font.title,
    fontWeight: "700",
  },
});
