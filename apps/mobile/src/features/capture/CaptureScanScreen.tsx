// 文档扫描：连续拍摄多页 → 页序调整/旋转/裁剪/重拍 → 合成 A4 PDF → 走统一处理页。
//
// 边界：
// - 复用已安装 expo-camera 与 `TaskDockMedia` 的 PDF 能力，不引入第三方扫描 SDK；
// - 每一页都是 staged 采集记录（文件在应用 staging 目录），离开页面后仍可回来继续，
//   进程被杀也只丢失「页序」（恢复时按拍摄顺序排列）；
// - PDF 落盘成功后才删除页面记录（页面已嵌入 PDF）；生成失败时保留全部原页；
// - 相机只在用户点击快门时拍照，退到后台立即卸载预览。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Linking,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import * as repo from "../../db/captureAssets";
import { AppError, describeError } from "../../lib/errors";
import { useWindowInsets } from "../../lib/insets";
import type { Nav } from "../../lib/nav";
import { formatBytes } from "../../lib/sync/fileIo";
import { font, radius, space } from "../../theme/tokens";

import { imageInfo } from "./album";
import { CROP_DEFAULT, ImageCropOverlay, ZoomableImage, type CropFraction } from "./components/ImageCropOverlay";
import { deleteFileQuietly, stageFromTemp } from "./files";
import { bumpCaptureRevision } from "./revision";
import { createScanPdf, transformStagedAsset } from "./service";

function pageName(index: number): string {
  return `扫描页-${String(index + 1).padStart(2, "0")}.jpg`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function CaptureScanScreen({ nav }: { nav: Nav }) {
  const insets = useWindowInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<repo.CaptureAsset[]>([]);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [editing, setEditing] = useState<repo.CaptureAsset | null>(null);
  const [mountError, setMountError] = useState<string | null>(null);

  // 恢复未完成的扫描页（只认本模块的 scan 图片，不碰相册与电脑副本）。
  useEffect(() => {
    let active = true;
    void repo
      .listStagedAssets()
      .then((items) => {
        if (!active) return;
        setPages(items.filter((item) => item.kind === "scan" && item.mime.startsWith("image/")));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);

  // 双指缩放：单指手势留给底层预览，与拍照页一致。
  const pinch = useRef({ distance: 0, startZoom: 0 });
  const zoomRef = useRef(0);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length === 2,
        onMoveShouldSetPanResponder: (event) => event.nativeEvent.touches.length === 2,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          if (touches.length < 2) return;
          pinch.current.distance = Math.hypot(
            touches[0].pageX - touches[1].pageX,
            touches[0].pageY - touches[1].pageY,
          );
          pinch.current.startZoom = zoomRef.current;
        },
        onPanResponderMove: (event) => {
          const touches = event.nativeEvent.touches;
          if (touches.length < 2 || pinch.current.distance <= 0) return;
          const distance = Math.hypot(
            touches[0].pageX - touches[1].pageX,
            touches[0].pageY - touches[1].pageY,
          );
          const scale = distance / pinch.current.distance;
          setZoom(clamp(pinch.current.startZoom + (scale - 1) * 0.6, 0, 1));
        },
      }),
    [],
  );

  const addPage = useCallback(async () => {
    if (busy || !ready || !cameraRef.current) return;
    setBusy(true);
    let stagedUri: string | null = null;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.95,
        skipProcessing: false,
        shutterSound: false,
      });
      if (!photo?.uri) throw new AppError("storage", "相机没有返回照片，请重试");
      const copy = await stageFromTemp(photo.uri, "jpg");
      stagedUri = copy.uri;
      const info = await imageInfo(copy.uri).catch(() => null);
      const asset = await repo.createStagedAsset({
        kind: "scan",
        source: "scan",
        name: pageName(pages.length),
        localPath: copy.uri,
        mime: "image/jpeg",
        byteSize: copy.size,
        width: info?.width ?? null,
        height: info?.height ?? null,
      });
      setPages((prev) => [...prev, asset]);
      bumpCaptureRevision();
    } catch (error) {
      if (stagedUri) deleteFileQuietly(stagedUri);
      Alert.alert("拍摄失败", describeError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, pages.length, ready]);

  // 重拍当前页：删除该页记录与文件，回到相机继续拍。
  const retakePage = useCallback(
    async (asset: repo.CaptureAsset) => {
      const paths = await repo.deleteAsset(asset.id).catch(() => []);
      for (const path of paths) deleteFileQuietly(path);
      setPages((prev) => prev.filter((item) => item.id !== asset.id));
      setEditing(null);
      bumpCaptureRevision();
    },
    [],
  );

  const movePage = useCallback((asset: repo.CaptureAsset, direction: -1 | 1) => {
    setPages((prev) => {
      const index = prev.findIndex((item) => item.id === asset.id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const refreshPage = useCallback((updated: repo.CaptureAsset) => {
    setPages((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    setEditing(updated);
    bumpCaptureRevision();
  }, []);

  const exportPdf = useCallback(async () => {
    if (busy || pages.length === 0) return;
    setBusy(true);
    try {
      await createScanPdf(pages);
      setPages([]);
      bumpCaptureRevision();
      nav.push("capture_review");
    } catch (error) {
      Alert.alert("生成 PDF 失败", describeError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, nav, pages]);

  const leave = useCallback(() => {
    if (pages.length === 0) {
      nav.back();
      return;
    }
    Alert.alert(
      `保留这 ${pages.length} 页扫描？`,
      "保留后可在「文档扫描」继续；放弃会删除这些尚未导出 PDF 的页面。",
      [
        { text: "继续扫描", style: "cancel" },
        {
          text: "保留并返回",
          onPress: () => nav.back(),
        },
        {
          text: "放弃并删除",
          style: "destructive",
          onPress: () => {
            void (async () => {
              for (const page of pages) {
                const paths = await repo.deleteAsset(page.id).catch(() => []);
                for (const path of paths) deleteFileQuietly(path);
              }
              setPages([]);
              bumpCaptureRevision();
              nav.back();
            })();
          },
        },
      ],
    );
  }, [nav, pages]);

  if (!permission) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color="#FFFFFF" />
        <Text style={styles.hint}>正在检查相机权限…</Text>
      </View>
    );
  }

  if (mountError) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.permissionTitle}>相机不可用</Text>
        <Text style={styles.permissionBody}>{mountError}</Text>
        <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={nav.back}>
          <Text style={styles.primaryText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.permissionTitle}>需要相机权限才能扫描文档</Text>
        <Text style={styles.permissionBody}>
          TaskDock 只在你按下快门时拍照；扫描页先保存在本机，导出 PDF 前不会上传。
        </Text>
        {permission.canAskAgain ? (
          <Pressable
            accessibilityRole="button"
            style={styles.primaryButton}
            onPress={() => void requestPermission()}
          >
            <Text style={styles.primaryText}>授予相机权限</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            style={styles.primaryButton}
            onPress={() => void Linking.openSettings()}
          >
            <Text style={styles.primaryText}>去系统设置开启</Text>
          </Pressable>
        )}
        <Pressable accessibilityRole="button" style={styles.linkButton} onPress={nav.back}>
          <Text style={styles.linkText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {foreground ? (
        <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            flash="off"
            enableTorch={torch}
            zoom={zoom}
            autofocus="on"
            onCameraReady={() => setReady(true)}
            onMountError={(event) => setMountError(event.message || "无法打开摄像头")}
          />
        </View>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: "#000" }]}>
          <Text style={styles.hint}>相机已暂停</Text>
        </View>
      )}

      <View style={[styles.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回"
          style={styles.roundButton}
          onPress={leave}
        >
          <Text style={styles.roundGlyph}>‹</Text>
        </Pressable>
        <View style={styles.topPills}>
          <View style={styles.pill}>
            <Text style={styles.pillText}>已拍 {pages.length} 页</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`手电筒：${torch ? "开启" : "关闭"}`}
            style={[styles.pill, torch && styles.pillActive]}
            onPress={() => setTorch((prev) => !prev)}
          >
            <Text style={styles.pillText}>补光 {torch ? "开" : "关"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + space.md }]}>
        {pages.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
          >
            {pages.map((page, index) => (
              <Pressable
                key={page.id}
                accessibilityRole="button"
                accessibilityLabel={`第 ${index + 1} 页，点击编辑`}
                onPress={() => setEditing(page)}
                style={styles.thumbButton}
              >
                {page.localPath ? (
                  <Image source={{ uri: page.localPath }} style={styles.thumb} resizeMode="cover" />
                ) : (
                  <View style={styles.thumbFallback} />
                )}
                <View style={styles.thumbBadge}>
                  <Text style={styles.thumbBadgeText}>{index + 1}</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text style={[styles.hint, styles.stripHint]}>
            对准文档逐页拍摄，页序可在缩略图上调整
          </Text>
        )}

        <View style={styles.actionRow}>
          <View style={styles.sideSlot}>
            <Text style={styles.sideHint}>{pages.length > 0 ? "点缩略图编辑" : "自动对焦"}</Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? "正在拍摄" : "拍摄一页"}
            accessibilityState={{ disabled: busy || !ready }}
            disabled={busy || !ready}
            onPress={() => void addPage()}
            style={styles.shutterOuter}
          >
            <View style={[styles.shutterInner, (busy || !ready) && styles.shutterBusy]} />
          </Pressable>

          <View style={styles.sideSlot}>
            {pages.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="生成 PDF"
                disabled={busy}
                onPress={() => void exportPdf()}
                style={styles.pdfButton}
              >
                {busy ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.pdfText}>生成 PDF</Text>
                )}
              </Pressable>
            ) : (
              <Text style={styles.sideHint}>无需逐页确认</Text>
            )}
          </View>
        </View>
      </View>

      {editing ? (
        <PageEditor
          page={editing}
          index={pages.findIndex((item) => item.id === editing.id)}
          count={pages.length}
          onClose={() => setEditing(null)}
          onChanged={refreshPage}
          onMove={(direction) => movePage(editing, direction)}
          onRetake={() => void retakePage(editing)}
        />
      ) : null}
    </View>
  );
}

// ── 单页编辑（预览 / 旋转 / 裁剪 / 重拍 / 调整页序）───────────

function PageEditor({
  page,
  index,
  count,
  onClose,
  onChanged,
  onMove,
  onRetake,
}: {
  page: repo.CaptureAsset;
  index: number;
  count: number;
  onClose: () => void;
  onChanged: (asset: repo.CaptureAsset) => void;
  onMove: (direction: -1 | 1) => void;
  onRetake: () => void;
}) {
  const insets = useWindowInsets();
  const [busy, setBusy] = useState(false);
  const [cropActive, setCropActive] = useState(false);
  const [fraction, setFraction] = useState<CropFraction>(CROP_DEFAULT);
  const [layout, setLayout] = useState({ width: 0, height: 0 });

  const display = useMemo(() => {
    if (!page.width || !page.height || layout.width <= 0) {
      return { x: 0, y: 0, width: layout.width, height: layout.height };
    }
    const ratio = Math.min(layout.width / page.width, layout.height / page.height);
    const width = page.width * ratio;
    const height = page.height * ratio;
    return {
      x: (layout.width - width) / 2,
      y: (layout.height - height) / 2,
      width,
      height,
    };
  }, [layout.height, layout.width, page.height, page.width]);

  const rotate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await transformStagedAsset(page, { rotate: 90 });
      setFraction(CROP_DEFAULT);
      onChanged(updated);
    } catch (error) {
      Alert.alert("旋转失败", describeError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, onChanged, page]);

  const applyCrop = useCallback(async () => {
    if (busy || !page.width || !page.height) return;
    setBusy(true);
    try {
      const updated = await transformStagedAsset(page, {
        crop: {
          x: Math.round(fraction.x * page.width),
          y: Math.round(fraction.y * page.height),
          width: Math.max(1, Math.round(fraction.w * page.width)),
          height: Math.max(1, Math.round(fraction.h * page.height)),
        },
      });
      setCropActive(false);
      setFraction(CROP_DEFAULT);
      onChanged(updated);
    } catch (error) {
      Alert.alert("裁剪失败", describeError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, fraction, onChanged, page]);

  return (
    <View style={styles.editorRoot}>
      <View style={[styles.editorTop, { paddingTop: insets.top + space.sm }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭编辑" onPress={onClose}>
          <Text style={styles.editorClose}>完成</Text>
        </Pressable>
        <Text style={styles.editorTitle}>
          第 {index + 1}/{count} 页 · {formatBytes(page.byteSize)}
        </Text>
        <View style={{ width: 44 }} />
      </View>

      <View
        style={styles.editorPreview}
        onLayout={(event: LayoutChangeEvent) => {
          const { width, height } = event.nativeEvent.layout;
          setLayout({ width, height });
        }}
      >
        {page.localPath ? (
          cropActive ? (
            <>
              <Image
                source={{ uri: page.localPath }}
                resizeMode="contain"
                style={StyleSheet.absoluteFill}
              />
              <ImageCropOverlay
                fraction={fraction}
                onChange={setFraction}
                display={display}
                hint={
                  page.width && page.height
                    ? `裁剪范围 ${Math.round(fraction.w * page.width)}×${Math.round(fraction.h * page.height)} px`
                    : undefined
                }
              />
            </>
          ) : (
            <ZoomableImage uri={page.localPath} />
          )
        ) : (
          <Text style={styles.hint}>文件不可用</Text>
        )}
        {busy ? (
          <View style={styles.editorBusy}>
            <ActivityIndicator color="#FFFFFF" />
          </View>
        ) : null}
      </View>

      <View style={[styles.editorTools, { paddingBottom: insets.bottom + space.md }]}>
        {cropActive ? (
          <>
            <Pressable
              accessibilityRole="button"
              style={[styles.editorButton, styles.editorButtonNeutral]}
              onPress={() => {
                setCropActive(false);
                setFraction(CROP_DEFAULT);
              }}
            >
              <Text style={styles.editorButtonText}>取消裁剪</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.editorButton, styles.editorButtonPrimary]}
              onPress={() => void applyCrop()}
              disabled={busy}
            >
              <Text style={styles.editorButtonText}>应用裁剪</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              style={[styles.editorButton, styles.editorButtonNeutral]}
              onPress={() => void rotate()}
              disabled={busy}
            >
              <Text style={styles.editorButtonText}>旋转 90°</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.editorButton, styles.editorButtonNeutral]}
              onPress={() => setCropActive(true)}
              disabled={busy}
            >
              <Text style={styles.editorButtonText}>裁剪</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: index <= 0 }}
              style={[styles.editorButton, styles.editorButtonNeutral, index <= 0 && styles.disabled]}
              onPress={() => onMove(-1)}
              disabled={index <= 0}
            >
              <Text style={styles.editorButtonText}>← 前移</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: index >= count - 1 }}
              style={[
                styles.editorButton,
                styles.editorButtonNeutral,
                index >= count - 1 && styles.disabled,
              ]}
              onPress={() => onMove(1)}
              disabled={index >= count - 1}
            >
              <Text style={styles.editorButtonText}>后移 →</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.editorButton, styles.editorButtonDanger]}
              onPress={onRetake}
              disabled={busy}
            >
              <Text style={styles.editorButtonText}>重拍此页</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.xl },
  hint: { color: "#C7D2E2", fontSize: font.body, textAlign: "center" },
  permissionTitle: {
    color: "#FFFFFF",
    fontSize: font.title,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: space.xl,
  },
  permissionBody: {
    color: "#C7D2E2",
    fontSize: font.label,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: space.xl,
  },
  primaryButton: {
    marginTop: space.md,
    minHeight: 46,
    paddingHorizontal: space.xl,
    borderRadius: radius.row,
    backgroundColor: "#2E7BE6",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: "#FFFFFF", fontSize: font.body, fontWeight: "700" },
  linkButton: { minHeight: 40, paddingHorizontal: space.lg, justifyContent: "center" },
  linkText: { color: "#9FB3C8", fontSize: font.body },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  roundButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.42)",
    alignItems: "center",
    justifyContent: "center",
  },
  roundGlyph: { color: "#FFFFFF", fontSize: 26, lineHeight: 28, marginTop: -2 },
  topPills: { flexDirection: "row", gap: space.sm },
  pill: {
    minHeight: 34,
    paddingHorizontal: space.md,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.42)",
    alignItems: "center",
    justifyContent: "center",
  },
  pillActive: { backgroundColor: "rgba(46,123,230,0.75)" },
  pillText: { color: "#FFFFFF", fontSize: font.label, fontWeight: "600" },
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: space.sm,
    gap: space.sm,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  strip: { paddingHorizontal: space.lg, gap: space.sm },
  stripHint: { paddingHorizontal: space.lg, fontSize: font.label },
  thumbButton: { width: 56, height: 72, borderRadius: 8, overflow: "hidden", backgroundColor: "#132033" },
  thumb: { width: "100%", height: "100%" },
  thumbFallback: { flex: 1, backgroundColor: "#1B2A3D" },
  thumbBadge: {
    position: "absolute",
    left: 4,
    top: 4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbBadgeText: { color: "#FFFFFF", fontSize: 10.5, fontWeight: "700" },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
  },
  sideSlot: { width: 92, alignItems: "center" },
  sideHint: { color: "#9FB3C8", fontSize: 10.5, textAlign: "center" },
  shutterOuter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: "rgba(255,255,255,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#FFFFFF" },
  shutterBusy: { backgroundColor: "rgba(255,255,255,0.45)" },
  pdfButton: {
    minHeight: 40,
    minWidth: 88,
    paddingHorizontal: space.sm,
    borderRadius: radius.row,
    backgroundColor: "#2E7BE6",
    alignItems: "center",
    justifyContent: "center",
  },
  pdfText: { color: "#FFFFFF", fontSize: font.label, fontWeight: "700" },
  editorRoot: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#050B14" },
  editorTop: {
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  editorClose: { color: "#8FC0FF", fontSize: font.body, fontWeight: "700" },
  editorTitle: { color: "#FFFFFF", fontSize: font.label },
  editorPreview: { flex: 1, margin: space.md, borderRadius: radius.row, overflow: "hidden", backgroundColor: "#0B1420" },
  editorBusy: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  editorTools: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  editorButton: {
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.row,
    alignItems: "center",
    justifyContent: "center",
  },
  editorButtonNeutral: { backgroundColor: "rgba(255,255,255,0.14)" },
  editorButtonPrimary: { backgroundColor: "#2E7BE6" },
  editorButtonDanger: { backgroundColor: "rgba(211,58,58,0.85)" },
  editorButtonText: { color: "#FFFFFF", fontSize: font.label, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
