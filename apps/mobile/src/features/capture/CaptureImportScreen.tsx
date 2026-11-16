// 相册/系统文件导入：只处理用户在系统选择器里明确选中的文件，不扫描整个相册。
//
// 流程：系统选择器 → 复制进应用 library（content:// 不能当永久路径）→ SHA-256 +
// 缩略图 → capture_assets(saved) → 直接进「本机素材库」，可继续发送电脑或整理。
import { useCallback, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { File as FsFile } from "expo-file-system";

import { AppBar } from "../../components/AppBar";
import { AppIcon } from "../../components/icons/AppIcon";
import { FileTypeIcon, fileTypeOf } from "../../components/FileTypeIcon";
import { PressableScale } from "../../components/PressableScale";
import { useToast } from "../../feedback/ToastProvider";
import { describeError } from "../../lib/errors";
import { useWindowInsets } from "../../lib/insets";
import type { Nav } from "../../lib/nav";
import { formatBytes } from "../../lib/sync/fileIo";
import { useTheme } from "../../theme/ThemeProvider";
import { font, radius, space } from "../../theme/tokens";

import { importLocalFiles } from "./service";
import { bumpCaptureRevision } from "./revision";

type Result = { kind: "idle" } | { kind: "done"; created: number; failures: string[] };

export function CaptureImportScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const [picked, setPicked] = useState<FsFile[]>([]);
  /** 最近一次选择用的入口：决定落库的 source 语义，不能一律写成相册 */
  const [picker, setPicker] = useState<"gallery" | "file_picker">("gallery");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ index: number; count: number; name: string } | null>(
    null,
  );
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const { showToast } = useToast();

  const pick = useCallback(async (imagesOnly: boolean) => {
    try {
      const pickedResult = await FsFile.pickFileAsync(
        imagesOnly ? { multipleFiles: true, mimeTypes: ["image/*"] } : { multipleFiles: true },
      );
      if (pickedResult.canceled) return;
      setPicked(pickedResult.result);
      setPicker(imagesOnly ? "gallery" : "file_picker");
      setResult({ kind: "idle" });
    } catch (error) {
      showToast(`无法打开系统选择器：${describeError(error)}`, "danger");
    }
  }, [showToast]);

  const runImport = useCallback(async () => {
    if (busy || picked.length === 0) return;
    setBusy(true);
    try {
      const outcome = await importLocalFiles(picked, {
        source: picker,
        onProgress: (index, count, name) => setProgress({ index: index + 1, count, name }),
      });
      setResult({ kind: "done", created: outcome.created.length, failures: outcome.failures });
      setPicked([]);
      bumpCaptureRevision();
    } catch (error) {
      showToast(describeError(error), "danger");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [busy, picked, picker, showToast]);

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <AppBar title="导入素材" onBack={nav.back} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}>
        <Text style={[styles.title, { color: tokens.text }]}>选择素材来源</Text>
        <Text style={[styles.note, { color: tokens.muted }]}>
          只读取你在系统选择器里明确选中的文件；不会申请完整相册权限，也不会自动上传。
          导入后会复制一份到 TaskDock 本机素材库，原文件保持不变。
        </Text>

        {/* 两个入口等宽铺满可用宽度；外层 Pressable 负责 flex，内层只做视觉。 */}
        <View style={styles.actions}>
          <PressableScale
            accessibilityLabel="从相册选择图片"
            accessibilityHint="支持多选图片，导入后进入本机素材库"
            onPress={() => void pick(true)}
            disabled={busy}
            style={styles.actionSlot}
            contentStyle={[
              styles.importCard,
              { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
            ]}
          >
            <View style={[styles.entryIcon, { backgroundColor: tokens.accentSoft }]}>
              <AppIcon name="gallery" color={tokens.accentText} size={32} />
            </View>
            <Text numberOfLines={2} style={[styles.entryTitle, { color: tokens.text }]}>
              从相册选择
            </Text>
            <Text numberOfLines={2} style={[styles.entryHint, { color: tokens.muted }]}>
              支持多选图片，保留原始尺寸
            </Text>
          </PressableScale>
          <PressableScale
            accessibilityLabel="从本机文件选择"
            accessibilityHint="支持文档、压缩包、音视频等文件，导入后进入本机素材库"
            onPress={() => void pick(false)}
            disabled={busy}
            style={styles.actionSlot}
            contentStyle={[
              styles.importCard,
              { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
            ]}
          >
            <View style={[styles.entryIcon, { backgroundColor: tokens.accentAltSoft }]}>
              <AppIcon name="folder" color={tokens.accent} size={32} />
            </View>
            <Text numberOfLines={2} style={[styles.entryTitle, { color: tokens.text }]}>
              从本机文件选择
            </Text>
            <Text numberOfLines={2} style={[styles.entryHint, { color: tokens.muted }]}>
              文档、压缩包、音视频等
            </Text>
          </PressableScale>
        </View>

        {picked.length > 0 ? (
          <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <View style={styles.cardHead}>
              <View style={styles.cardHeadText}>
                <Text style={[styles.cardTitle, { color: tokens.text }]}>
                  已选择 {picked.length} 个素材
                </Text>
                <Text style={[styles.cardSubtitle, { color: tokens.muted }]}>
                  {formatBytes(picked.reduce((sum, file) => sum + (file.size || 0), 0))}
                </Text>
              </View>
              <PressableScale
                accessibilityLabel="清空已选素材"
                disabled={busy}
                onPress={() => setPicked([])}
                style={styles.clearPress}
                contentStyle={styles.clearButton}
                scaleTo={0.9}
              >
                <Text style={[styles.clearText, { color: tokens.accentText }]}>清空</Text>
              </PressableScale>
            </View>
            <View style={[styles.previewDivider, { backgroundColor: tokens.separator }]} />
            {picked.slice(0, 20).map((file, index) => {
              const image = file.type?.startsWith("image/") ?? false;
              return (
                <View key={`${file.uri}-${index}`} style={styles.fileRow}>
                  {image ? (
                    <Image
                      source={{ uri: file.uri }}
                      style={[styles.fileThumb, { backgroundColor: tokens.track }]}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={styles.fileIcon}>
                      <FileTypeIcon kind={fileTypeOf(file.name)} size={34} />
                    </View>
                  )}
                  <View style={styles.fileBody}>
                    <Text numberOfLines={1} style={[styles.fileName, { color: tokens.text }]}>
                      {file.name || "未命名文件"}
                    </Text>
                    <Text numberOfLines={1} style={[styles.fileMeta, { color: tokens.muted }]}>
                      {formatBytes(file.size)}
                    </Text>
                  </View>
                  <PressableScale
                    accessibilityLabel={`移除 ${file.name || "未命名文件"}`}
                    disabled={busy}
                    onPress={() =>
                      setPicked((current) => current.filter((_, currentIndex) => currentIndex !== index))
                    }
                    style={styles.removePress}
                    contentStyle={styles.removeButton}
                    scaleTo={0.9}
                  >
                    <AppIcon name="close" color={tokens.muted} size={16} />
                  </PressableScale>
                </View>
              );
            })}
            {picked.length > 20 ? (
              <Text style={[styles.note, { color: tokens.muted }]}>
                其余 {picked.length - 20} 个文件未展开显示，仍会一起导入
              </Text>
            ) : null}
            <PressableScale
              accessibilityLabel="导入到本机素材库"
              onPress={() => void runImport()}
              disabled={busy}
              style={styles.fullWidthPress}
              contentStyle={[
                styles.importAction,
                { backgroundColor: busy ? tokens.track : tokens.accentFill },
              ]}
            >
              {busy ? <ActivityIndicator color={tokens.onAccent} size="small" /> : null}
              <Text style={[styles.importActionText, { color: busy ? tokens.muted : tokens.onAccent }]}>
                {busy ? "导入中…" : `导入到本机素材库（${picked.length}）`}
              </Text>
            </PressableScale>
            {busy && progress ? (
              <Text style={[styles.note, { color: tokens.muted }]}>
                {progress.index}/{progress.count} · {progress.name}
              </Text>
            ) : null}
          </View>
        ) : null}

        {result.kind === "done" ? (
          <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <Text style={[styles.cardTitle, { color: tokens.text }]}>
              已导入 {result.created} 个素材
            </Text>
            {result.failures.length > 0 ? (
              <>
                <Text style={[styles.cardTitle, { color: tokens.danger }]}>
                  {result.failures.length} 个失败
                </Text>
                {result.failures.slice(0, 8).map((failure, index) => (
                  <Text key={index} style={[styles.fileLine, { color: tokens.danger }]}>
                    {failure}
                  </Text>
                ))}
              </>
            ) : null}
            <PressableScale
              accessibilityLabel="查看本机素材库"
              onPress={() => nav.push("capture_stash")}
              contentStyle={[styles.secondary, { backgroundColor: tokens.accentSoft }]}
            >
              <Text style={[styles.secondaryText, { color: tokens.accentText }]}>查看本机素材库</Text>
            </PressableScale>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, gap: space.md },
  title: { fontSize: font.title, fontWeight: "700" },
  note: { fontSize: font.meta, lineHeight: 18 },
  actions: { flexDirection: "row", gap: space.md },
  // 等宽两列：flex 必须落在外层 Pressable 上（contentStyle 只负责内层视觉）
  actionSlot: { flex: 1, minWidth: 0 },
  importCard: {
    width: "100%",
    minHeight: 154,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.md,
    paddingVertical: space.lg,
    gap: space.xs,
  },
  entryIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.iconTile,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xxs,
  },
  entryTitle: { fontSize: font.title, fontWeight: "700", textAlign: "center" },
  entryHint: { fontSize: font.meta, lineHeight: 17, textAlign: "center" },
  primary: {
    minHeight: 48,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  primaryText: { fontSize: font.body, fontWeight: "700" },
  secondary: {
    minHeight: 48,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.md,
  },
  secondaryText: { fontSize: font.body, fontWeight: "600" },
  card: {
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    gap: space.sm,
  },
  cardTitle: { fontSize: font.body, fontWeight: "700" },
  cardSubtitle: { fontSize: font.meta, fontVariant: ["tabular-nums"] },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardHeadText: { flex: 1, minWidth: 0, gap: 1 },
  clearPress: { minWidth: 44, minHeight: 44, justifyContent: "center" },
  clearButton: { alignItems: "flex-end", justifyContent: "center", minHeight: 44 },
  clearText: { fontSize: font.meta, fontWeight: "600" },
  previewDivider: { height: StyleSheet.hairlineWidth },
  fileRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  fileThumb: { width: 52, height: 52, borderRadius: radius.control },
  fileIcon: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  fileBody: { flex: 1, minWidth: 0, gap: 2 },
  fileName: { fontSize: font.body, fontWeight: "600" },
  fileMeta: { fontSize: font.meta, fontVariant: ["tabular-nums"] },
  removePress: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  removeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  fullWidthPress: { alignSelf: "stretch", marginTop: space.xs },
  importAction: {
    width: "100%",
    minHeight: 48,
    borderRadius: radius.row,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  importActionText: { fontSize: font.body, fontWeight: "700" },
  fileLine: { fontSize: font.label, lineHeight: 16 },
});
