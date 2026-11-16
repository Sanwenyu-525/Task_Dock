// 相册/系统文件导入：只处理用户在系统选择器里明确选中的文件，不扫描整个相册。
//
// 流程：系统选择器 → 复制进应用 library（content:// 不能当永久路径）→ SHA-256 +
// 缩略图 → capture_assets(saved) → 直接进「本机素材库」，可继续发送电脑或整理。
import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { File as FsFile } from "expo-file-system";

import { AppBar } from "../../components/AppBar";
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
        <Text style={[styles.title, { color: tokens.text }]}>从系统相册或文件中选择素材</Text>
        <Text style={[styles.note, { color: tokens.muted }]}>
          只读取你在系统选择器里明确选中的文件；不会申请完整相册权限，也不会自动上传。
          导入后会复制一份到 TaskDock 本机素材库，原文件保持不变。
        </Text>

        <View style={styles.actions}>
          <PressableScale
            accessibilityLabel="选择图片"
            onPress={() => void pick(true)}
            disabled={busy}
            contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
          >
            <Text style={[styles.primaryText, { color: tokens.onAccent }]}>选择图片</Text>
          </PressableScale>
          <PressableScale
            accessibilityLabel="选择文件"
            onPress={() => void pick(false)}
            disabled={busy}
            contentStyle={[styles.secondary, { backgroundColor: tokens.accentSoft }]}
          >
            <Text style={[styles.secondaryText, { color: tokens.accentText }]}>选择文件</Text>
          </PressableScale>
        </View>

        {picked.length > 0 ? (
          <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <View style={styles.cardHead}>
              <Text style={[styles.cardTitle, { color: tokens.text }]}>
                已选择 {picked.length} 个文件
              </Text>
              <PressableScale
                accessibilityLabel="清空已选文件"
                disabled={busy}
                onPress={() => setPicked([])}
                style={styles.clearPress}
                contentStyle={styles.clearButton}
                scaleTo={0.9}
              >
                <Text style={[styles.clearText, { color: tokens.accentText }]}>清空</Text>
              </PressableScale>
            </View>
            {picked.slice(0, 20).map((file, index) => (
              <Text
                key={`${file.uri}-${index}`}
                numberOfLines={1}
                style={[styles.fileLine, { color: tokens.textSoft }]}
              >
                {index + 1}. {file.name || "未命名"} · {formatBytes(file.size)}
              </Text>
            ))}
            {picked.length > 20 ? (
              <Text style={[styles.note, { color: tokens.muted }]}>
                其余 {picked.length - 20} 个文件未展开显示
              </Text>
            ) : null}
            <PressableScale
              accessibilityLabel="导入到本机暂存"
              onPress={() => void runImport()}
              disabled={busy}
              contentStyle={[styles.primary, { backgroundColor: busy ? tokens.track : tokens.accentFill }]}
            >
              {busy ? <ActivityIndicator color={tokens.onAccent} size="small" /> : null}
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>
                {busy ? "导入中…" : `导入到本机暂存（${picked.length}）`}
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
  actions: { flexDirection: "row", gap: space.sm },
  primary: {
    minHeight: 48,
    flex: 1,
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
    flex: 1,
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
    gap: space.xs,
  },
  cardTitle: { fontSize: font.body, fontWeight: "700" },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  clearPress: { marginLeft: "auto", minWidth: 44, minHeight: 44, justifyContent: "center" },
  clearButton: { alignItems: "flex-end", justifyContent: "center", minHeight: 44 },
  clearText: { fontSize: font.meta, fontWeight: "600" },
  fileLine: { fontSize: font.label, lineHeight: 16 },
});
