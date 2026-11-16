// 图片压缩：相册 / 文件 / TaskDock 素材库 / 分享图片，单张或批量真正重编码。
//
// 真实性边界（不伪造压缩成功）：
// - 输出由原生 TaskDockMedia.compressImageAsync 真正解码、按 EXIF 方向纠正、缩放并重新编码；
// - 原图永远不被覆盖：输出写到应用私有 tool-files/，原路径只读；
// - 输出可能比原图更大（PNG / 已高压缩的 WebP），界面如实显示「未减小」；
// - 重编码会移除 EXIF（含 GPS），页面对此明确说明，不提供「保留位置」的假选项；
// - 批量处理串行执行（一次只解一张图），避免多张全分辨率图片同时驻留内存；
// - 取消只能发生在「当前图片完成后」，界面如实说明，不假装已立即终止原生解码。
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { File } from "expo-file-system";

import { BottomSheet } from "../../../components/BottomSheet";
import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { useToast } from "../../../feedback/ToastProvider";
import { listAssets, type CaptureAsset } from "../../../db/captureAssets";
import { recordToolUse } from "../../../db/toolUsage";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import { describeError } from "../../../lib/errors";
import { pickLocalFiles } from "../../../lib/sync/fileIo";
import type { AppNav } from "../../../lib/nav";
import { importLocalFiles } from "../../capture/service";
import {
  compressImage,
  formatBytes,
  shareOutFile,
  type CompressOutput,
} from "../shared/nativeTools";
import { saveImageToGallery } from "../shared/saveOutput";
import { sendToolFileToDesktop } from "../shared/sendToDesktop";
import { takeImageDraft } from "../shareIntake";
import { ToolButton, ToolNote, ToolScreen, ToolSection } from "../shared/ToolUI";

const TOOL_ID = "tool.image-compress";
const MAX_IMAGES = 20;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

type Format = "jpeg" | "png" | "webp";

function formatLabel(format: Format): string {
  return format === "jpeg" ? "JPEG" : format === "webp" ? "WebP" : "PNG";
}

interface SourceImage {
  id: string;
  uri: string;
  name: string;
  mime: string;
  size: number;
  origin: "picker" | "library" | "share";
}

interface CompressItem {
  source: SourceImage;
  output?: CompressOutput;
  error?: string;
  before: number;
  after: number;
}

export function ImageCompressScreen({ nav, onBack }: { nav: AppNav; onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();

  const [sources, setSources] = useState<SourceImage[]>([]);
  const [items, setItems] = useState<CompressItem[]>([]);
  const [quality, setQuality] = useState(80);
  const [maxDim, setMaxDim] = useState(1600);
  // 默认收起高级参数：主流程保持「选图 → 压缩 → 保存 / 发送」，需要精细控制再展开。
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [format, setFormat] = useState<Format>("jpeg");

  const [running, setRunning] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<CaptureAsset[]>([]);
  const [preview, setPreview] = useState<CompressItem | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    void recordToolUse(TOOL_ID);
  }, []);

  useEffect(() => {
    const draft = takeImageDraft();
    if (!draft) return;
    addSources([
      {
        id: `share-${Date.now()}`,
        uri: draft.uri,
        name: draft.name,
        mime: guessMime(draft.name),
        size: 0,
        origin: "share",
      },
    ]);
    // addSources 为稳定闭包外函数，这里只需首次执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addSources(next: SourceImage[]) {
    setSources((current) => {
      const seen = new Set(current.map((item) => item.uri));
      const merged = [...current];
      for (const item of next) {
        if (merged.length >= MAX_IMAGES) break;
        if (seen.has(item.uri)) continue;
        merged.push(item);
      }
      return merged;
    });
  }

  const totalBytes = useMemo(
    () => sources.reduce((sum, item) => sum + item.size, 0),
    [sources],
  );

  const pickFromFiles = async () => {
    try {
      const files = await pickLocalFiles();
      if (files.length === 0) return;
      const candidates: SourceImage[] = [];
      for (const file of files) {
        const name = file.name ?? "image";
        const mime = file.type ?? guessMime(name);
        if (!isImageFile(name, mime)) continue;
        const size = Number(file.size ?? 0);
        if (size > MAX_INPUT_BYTES) {
          showToast(`${name} 超过 ${formatBytes(MAX_INPUT_BYTES)}，已跳过`, "warn");
          continue;
        }
        candidates.push({
          id: `file-${file.uri}-${candidates.length}`,
          uri: file.uri,
          name,
          mime,
          size,
          origin: "picker",
        });
      }
      if (candidates.length === 0) {
        showToast("没有可用的图片文件", "warn");
        return;
      }
      addSources(candidates);
      showToast(`已加入 ${candidates.length} 张图片`, "success");
    } catch (error) {
      showToast(`选择图片失败：${describeError(error)}`, "danger");
    }
  };

  const openLibrary = async () => {
    try {
      const assets = await listAssets();
      const images = assets.filter(
        (asset) =>
          (asset.kind === "photo" || asset.kind === "scan") &&
          asset.localPath != null &&
          isImageFile(asset.name, asset.mime),
      );
      setLibraryAssets(images);
      setLibraryOpen(true);
    } catch (error) {
      showToast(`读取素材库失败：${describeError(error)}`, "danger");
    }
  };

  const addFromLibrary = (asset: CaptureAsset) => {
    if (!asset.localPath) return;
    if (asset.byteSize > MAX_INPUT_BYTES) {
      showToast(`${asset.name} 超过 ${formatBytes(MAX_INPUT_BYTES)}，已跳过`, "warn");
      return;
    }
    addSources([
      {
        id: `asset-${asset.id}`,
        uri: asset.localPath,
        name: asset.name,
        mime: asset.mime || guessMime(asset.name),
        size: asset.byteSize,
        origin: "library",
      },
    ]);
    setLibraryOpen(false);
    showToast("已从素材库加入", "success");
  };

  const removeSource = (id: string) => {
    setSources((current) => current.filter((item) => item.id !== id));
    setItems((current) => current.filter((item) => item.source.id !== id));
  };

  const compressOne = async (source: SourceImage): Promise<CompressItem> => {
    const before = source.size > 0 ? source.size : 0;
    try {
      const output = await compressImage(source.uri, {
        maxWidth: maxDim,
        maxHeight: maxDim,
        quality,
        format,
      });
      return { source, output, before, after: output.size };
    } catch (error) {
      return { source, error: describeError(error), before, after: 0 };
    }
  };

  const runCompress = async () => {
    if (sources.length === 0 || running) return;
    setRunning(true);
    setCancelRequested(false);
    cancelRef.current = false;
    setItems([]);
    const results: CompressItem[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      if (cancelRef.current) break;
      const source = sources[index];
      setProgress({ done: index, total: sources.length, name: source.name });
      const item = await compressOne(source);
      results.push(item);
      setItems([...results]);
      setProgress({ done: index + 1, total: sources.length, name: source.name });
    }
    setRunning(false);
    setProgress(null);
    const failed = results.filter((item) => item.error).length;
    const larger = results.filter(
      (item) => item.output && item.before > 0 && item.after >= item.before,
    ).length;
    if (cancelRef.current) {
      showToast(`已取消，完成 ${results.length} 张`, "info");
    } else if (failed > 0) {
      showToast(`完成 ${results.length - failed} 张，失败 ${failed} 张；可重试`, "warn");
    } else {
      showToast(
        larger > 0
          ? `已完成 ${results.length} 张；其中 ${larger} 张没有减小，请调整质量或格式`
          : `已完成 ${results.length} 张`,
        larger > 0 ? "warn" : "success",
      );
    }
  };

  const retryOne = async (source: SourceImage) => {
    if (running) return;
    const item = await compressOne(source);
    setItems((current) => current.map((entry) => (entry.source.id === source.id ? item : entry)));
    if (item.error) showToast(`重试失败：${item.error}`, "danger");
    else showToast("已重新压缩", "success");
  };

  const saveAlbum = async (item: CompressItem) => {
    if (!item.output) return;
    setBusyKey(`album-${item.source.id}`);
    try {
      const saved = await saveImageToGallery(item.output.uri, outputName(item), item.output.mime);
      showToast(`已保存到系统相册：${saved.displayName}`, "success");
    } catch (error) {
      showToast(`保存相册失败：${describeError(error)}`, "danger");
    } finally {
      setBusyKey(null);
    }
  };

  const saveLibrary = async (item: CompressItem) => {
    if (!item.output) return;
    setBusyKey(`library-${item.source.id}`);
    try {
      const file = new File(item.output.uri);
      const outcome = await importLocalFiles([file], { source: "file_picker" });
      if (outcome.created.length === 0) {
        showToast(outcome.failures[0] ?? "保存素材库失败", "danger");
        return;
      }
      showToast(`已保存到本机素材库：${outcome.created[0].name}`, "success");
    } catch (error) {
      showToast(`保存素材库失败：${describeError(error)}`, "danger");
    } finally {
      setBusyKey(null);
    }
  };

  const shareItem = async (item: CompressItem) => {
    if (!item.output) return;
    try {
      await shareOutFile(item.output.uri, item.output.mime, outputName(item));
    } catch (error) {
      showToast(describeError(error), "danger");
    }
  };

  const sendItem = async (item: CompressItem) => {
    if (!item.output) return;
    setBusyKey(`send-${item.source.id}`);
    try {
      const result = await sendToolFileToDesktop({
        uri: item.output.uri,
        fileName: outputName(item),
        mime: item.output.mime,
      });
      showToast(result.message, result.ok ? "success" : "info");
    } catch (error) {
      showToast(`发送失败：${describeError(error)}`, "danger");
    } finally {
      setBusyKey(null);
    }
  };

  const saveAllAlbum = async () => {
    const done = items.filter((item) => item.output);
    if (done.length === 0) return;
    setBusyKey("album-all");
    let ok = 0;
    const failures: string[] = [];
    for (const item of done) {
      try {
        await saveImageToGallery(item.output!.uri, outputName(item), item.output!.mime);
        ok += 1;
      } catch (error) {
        failures.push(`${item.source.name}：${describeError(error)}`);
      }
    }
    setBusyKey(null);
    showToast(
      failures.length === 0 ? `已保存 ${ok} 张到系统相册` : `保存 ${ok} 张，失败 ${failures.length} 张`,
      failures.length === 0 ? "success" : "warn",
    );
  };

  const requestCancel = () => {
    cancelRef.current = true;
    setCancelRequested(true);
    showToast("已请求取消：会在当前这张处理完后停止", "info");
  };

  const finished = items.filter((item) => item.output).length;
  const failedCount = items.filter((item) => item.error).length;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ToolScreen
        title="图片压缩"
        subtitle="真正重编码 · 原图保留 · 批量串行处理"
        onBack={onBack}
        footer={
          <View style={styles.footerRow}>
            <ToolButton
              label={running ? "压缩中…" : `开始压缩${sources.length > 1 ? `（${sources.length} 张）` : ""}`}
              tone="primary"
              icon="fileImage"
              disabled={sources.length === 0 || running}
              onPress={() => void runCompress()}
              style={styles.footerPrimary}
            />
            {running ? (
              <ToolButton label={cancelRequested ? "停止中…" : "取消"} icon="close" disabled={cancelRequested} onPress={requestCancel} />
            ) : items.length > 0 ? (
              <ToolButton label="保存全部到相册" icon="gallery" onPress={() => void saveAllAlbum()} disabled={busyKey !== null} />
            ) : null}
          </View>
        }
      >
        <ToolSection title="图片来源" hint={`最多 ${MAX_IMAGES} 张，单张不超过 ${formatBytes(MAX_INPUT_BYTES)}`}>
          <View style={styles.actionRow}>
            <ToolButton label="相册 / 文件" icon="gallery" onPress={() => void pickFromFiles()} disabled={running} />
            <ToolButton label="素材库" icon="archive" onPress={() => void openLibrary()} disabled={running} />
            <ToolButton label="去拍摄" icon="camera" onPress={() => nav.push("capture_camera")} disabled={running} />
          </View>

          {sources.length === 0 ? (
            <ToolNote text="还没有选择图片。可以从相册、文件选择器、本机素材库或采集中心拍照加入；压缩不会修改原图。" />
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourceRow}>
              {sources.map((source) => (
                <View key={source.id} style={[styles.sourceCard, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
                  <Image source={{ uri: source.uri }} style={styles.sourceThumb} resizeMode="cover" />
                  <Text style={[styles.sourceName, { color: tokens.text }]} numberOfLines={1}>
                    {source.name}
                  </Text>
                  <Text style={[styles.sourceMeta, { color: tokens.muted }]}>
                    {source.size > 0 ? formatBytes(source.size) : "大小未知"}
                  </Text>
                  {!running ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`移除 ${source.name}`}
                      onPress={() => removeSource(source.id)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      style={styles.sourceRemove}
                    >
                      <AppIcon name="close" size={16} color={tokens.muted} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          )}
          {sources.length > 0 ? (
            <Text style={[styles.stats, { color: tokens.muted }]}>
              共 {sources.length} 张 · 原图合计 {totalBytes > 0 ? formatBytes(totalBytes) : "大小未知"}
            </Text>
          ) : null}
        </ToolSection>

        <ToolSection title="压缩参数">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={optionsOpen ? "收起高级参数" : "展开高级参数"}
            onPress={() => setOptionsOpen((value) => !value)}
            style={({ pressed }) => [
              styles.optionsToggle,
              { backgroundColor: tokens.card, borderColor: tokens.cardBorder, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <View style={styles.optionsText}>
              <Text style={[styles.optionLabel, { color: tokens.text }]}>高级参数</Text>
              <Text style={[styles.optionsSummary, { color: tokens.muted }]} numberOfLines={1}>
                质量 {quality} · {maxDim > 0 ? `最长边 ${maxDim}` : "原始尺寸"} · {formatLabel(format)}
              </Text>
            </View>
            <AppIcon name={optionsOpen ? "chevronUp" : "chevronDown"} size={18} color={tokens.muted} />
          </Pressable>
          {optionsOpen ? (
            <>
              <View style={styles.optionBlock}>
            <Text style={[styles.optionLabel, { color: tokens.textSoft }]}>质量</Text>
            <View style={styles.chipRow}>
              {[90, 80, 70, 60, 50].map((value) => (
                <Chip
                  key={value}
                  label={`${value}`}
                  active={quality === value}
                  onPress={() => setQuality(value)}
                  variant="soft"
                />
              ))}
            </View>
          </View>
          <View style={styles.optionBlock}>
            <Text style={[styles.optionLabel, { color: tokens.textSoft }]}>最长边</Text>
            <View style={styles.chipRow}>
              {[
                { value: 0, label: "不缩放" },
                { value: 2048, label: "2048" },
                { value: 1600, label: "1600" },
                { value: 1080, label: "1080" },
                { value: 720, label: "720" },
              ].map((option) => (
                <Chip
                  key={option.label}
                  label={option.label}
                  active={maxDim === option.value}
                  onPress={() => setMaxDim(option.value)}
                  variant="soft"
                />
              ))}
            </View>
          </View>
          <View style={styles.optionBlock}>
            <Text style={[styles.optionLabel, { color: tokens.textSoft }]}>格式</Text>
            <View style={styles.chipRow}>
              {[
                { value: "jpeg" as Format, label: "JPEG" },
                { value: "webp" as Format, label: "WebP" },
                { value: "png" as Format, label: "PNG（无损）" },
              ].map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  active={format === option.value}
                  onPress={() => setFormat(option.value)}
                  variant="soft"
                />
              ))}
            </View>
          </View>
            </>
          ) : null}
          <ToolNote text="透明图片转 JPEG 会合成白底；PNG 不压缩画质但体积通常最大。重编码会移除 EXIF（含 GPS 位置），这是默认且唯一行为。" />
        </ToolSection>

        {progress || items.length > 0 ? (
          <ToolSection title="处理进度">
            {progress ? (
              <Text style={[styles.stats, { color: tokens.textSoft }]}>
                {progress.done}/{progress.total} · 正在处理 {progress.name}
                {cancelRequested ? " · 等待当前图片完成" : ""}
              </Text>
            ) : (
              <Text style={[styles.stats, { color: tokens.textSoft }]}>
                完成 {finished} 张 · 失败 {failedCount} 张
              </Text>
            )}
          </ToolSection>
        ) : null}

        {items.length > 0 ? (
          <ToolSection title="压缩结果">
            {items.map((item) => (
              <ResultRow
                key={item.source.id}
                item={item}
                busy={busyKey}
                onPreview={() => setPreview(item)}
                onRetry={() => void retryOne(item.source)}
                onAlbum={() => void saveAlbum(item)}
                onLibrary={() => void saveLibrary(item)}
                onShare={() => void shareItem(item)}
                onSend={() => void sendItem(item)}
              />
            ))}
          </ToolSection>
        ) : null}

        <ToolNote text="压缩产物写在应用私有目录 tool-files/，原图不会被覆盖；需要长期保留时请保存到系统相册或发送到电脑。" />
      </ToolScreen>

      <BottomSheet
        visible={libraryOpen}
        onRequestClose={() => setLibraryOpen(false)}
        accessibilityLabel="选择素材库图片"
        maxHeightRatio={0.75}
      >
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>本机素材库</Text>
          <Text style={[styles.sheetHint, { color: tokens.muted }]}>
            只列出本机有文件的照片与扫描件；不含桌面端资料。
          </Text>
          <ScrollView contentContainerStyle={styles.sheetList}>
            {libraryAssets.length === 0 ? (
              <Text style={[styles.stats, { color: tokens.muted }]}>素材库还没有图片。</Text>
            ) : (
              libraryAssets.map((asset) => (
                <Pressable
                  key={asset.id}
                  accessibilityRole="button"
                  accessibilityLabel={`选择 ${asset.name}`}
                  onPress={() => addFromLibrary(asset)}
                  style={({ pressed }) => [
                    styles.sheetRow,
                    { borderColor: tokens.separator, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  {asset.thumbnailPath || asset.localPath ? (
                    <Image
                      source={{ uri: asset.thumbnailPath ?? asset.localPath ?? "" }}
                      style={styles.sheetThumb}
                      resizeMode="cover"
                    />
                  ) : null}
                  <View style={styles.sheetRowBody}>
                    <Text style={[styles.sheetRowTitle, { color: tokens.text }]} numberOfLines={1}>
                      {asset.name}
                    </Text>
                    <Text style={[styles.sheetRowMeta, { color: tokens.muted }]}>
                      {formatBytes(asset.byteSize)} · {asset.state === "saved" ? "已保存" : "暂存"}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>
          <ToolButton label="关闭" tone="secondary" onPress={() => setLibraryOpen(false)} />
        </View>
      </BottomSheet>

      <BottomSheet
        visible={preview !== null}
        onRequestClose={() => setPreview(null)}
        accessibilityLabel="压缩结果预览"
        maxHeightRatio={0.8}
      >
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>压缩预览</Text>
          {preview?.output ? (
            <>
              <Image
                source={{ uri: preview.output.uri }}
                style={[styles.previewImage, { borderColor: tokens.cardBorder }]}
                resizeMode="contain"
              />
              <Text style={[styles.sheetHint, { color: tokens.muted }]}>
                {preview.output.width}×{preview.output.height} · {formatBytes(preview.output.size)}
              </Text>
            </>
          ) : null}
          <ToolButton label="关闭" onPress={() => setPreview(null)} />
        </View>
      </BottomSheet>
    </View>
  );
}

function ResultRow({
  item,
  busy,
  onPreview,
  onRetry,
  onAlbum,
  onLibrary,
  onShare,
  onSend,
}: {
  item: CompressItem;
  busy: string | null;
  onPreview: () => void;
  onRetry: () => void;
  onAlbum: () => void;
  onLibrary: () => void;
  onShare: () => void;
  onSend: () => void;
}) {
  const { tokens } = useTheme();
  const out = item.output;
  const delta = out && item.before > 0 ? (out.size - item.before) / item.before : null;
  const larger = delta !== null && delta >= 0;
  return (
    <View style={[styles.resultCard, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
      {out ? (
        <Pressable accessibilityRole="button" accessibilityLabel="查看压缩预览" onPress={onPreview}>
          <Image
            source={{ uri: out.uri }}
            style={[styles.resultThumb, { borderColor: tokens.cardBorder }]}
            resizeMode="cover"
          />
        </Pressable>
      ) : (
        <View style={[styles.resultThumb, styles.resultThumbError, { borderColor: tokens.danger }]}>
          <AppIcon name="warning" size={20} color={tokens.danger} />
        </View>
      )}
      <View style={styles.resultBody}>
        <Text style={[styles.resultName, { color: tokens.text }]} numberOfLines={1}>
          {item.source.name}
        </Text>
        {out ? (
          <>
            <Text style={[styles.resultMeta, { color: tokens.muted }]}>
              {out.sourceWidth}×{out.sourceHeight} → {out.width}×{out.height} · {out.format.toUpperCase()}
            </Text>
            <Text style={[styles.resultMeta, { color: larger ? tokens.warn : tokens.ok }]}>
              {item.before > 0 ? `${formatBytes(item.before)} → ${formatBytes(out.size)}` : `输出 ${formatBytes(out.size)}`}
              {delta !== null ? `（${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%）` : ""}
              {larger ? " · 未减小" : ""}
            </Text>
          </>
        ) : (
          <Text style={[styles.resultMeta, { color: tokens.danger }]} numberOfLines={2}>
            {item.error ?? "处理失败"}
          </Text>
        )}
        {out ? (
          <View style={styles.resultActions}>
            <ToolButton compact label="相册" icon="gallery" disabled={busy !== null} onPress={onAlbum} />
            <ToolButton compact label="素材库" icon="archive" disabled={busy !== null} onPress={onLibrary} />
            <ToolButton compact label="分享" icon="share" disabled={busy !== null} onPress={onShare} />
            <ToolButton compact label="电脑" icon="send" disabled={busy !== null} onPress={onSend} />
          </View>
        ) : (
          <View style={styles.resultActions}>
            <ToolButton compact label="重试" icon="refresh" onPress={onRetry} />
          </View>
        )}
      </View>
    </View>
  );
}

function outputName(item: CompressItem): string {
  const extension = item.output?.format === "png" ? "png" : item.output?.format === "webp" ? "webp" : "jpg";
  const base = item.source.name.replace(/\.[^.]+$/, "");
  return `${base || "image"}-compressed.${extension}`;
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}

function isImageFile(name: string, mime: string): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(jpg|jpeg|png|webp|heic|heif|bmp)$/i.test(name);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  sourceRow: { gap: space.sm, paddingVertical: space.xs },
  sourceCard: {
    width: 110,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xs,
    gap: 2,
  },
  sourceThumb: { width: "100%", height: 72, borderRadius: 8 },
  sourceName: { fontSize: font.label, fontWeight: "600" },
  sourceMeta: { fontSize: 10 },
  sourceRemove: { position: "absolute", top: 2, right: 2, width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  stats: { fontSize: font.label },
  optionsToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 52,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionsText: { flex: 1, gap: 2, minWidth: 0 },
  optionsSummary: { fontSize: font.label },
  optionBlock: { gap: space.xs },
  optionLabel: { fontSize: font.label, fontWeight: "600" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  resultCard: {
    flexDirection: "row",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resultThumb: { width: 72, height: 72, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  resultThumbError: { alignItems: "center", justifyContent: "center" },
  resultBody: { flex: 1, gap: 2, minWidth: 0 },
  resultName: { fontSize: font.meta, fontWeight: "600" },
  resultMeta: { fontSize: font.label },
  resultActions: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xs },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  sheetTitle: { fontSize: font.section, fontWeight: "700" },
  sheetHint: { fontSize: font.label, lineHeight: 18 },
  sheetList: { gap: space.xs, paddingVertical: space.sm },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetThumb: { width: 48, height: 48, borderRadius: 8 },
  sheetRowBody: { flex: 1, gap: 2 },
  sheetRowTitle: { fontSize: font.meta, fontWeight: "600" },
  sheetRowMeta: { fontSize: font.label },
  previewImage: { width: "100%", height: 320, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
});
