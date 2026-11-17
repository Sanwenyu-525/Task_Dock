// 取色器：真实像素采样（原生 openImageSession + samplePixels），支持放大局部取色、
// 点按/拖动连续取色、HEX/RGB/HSL 切换、最近取色、收藏、WCAG 对比度。
//
// 坐标映射（最容易出错的地方）：
// - 原生会话返回的是「按最长边缩放后」的图片尺寸，采样坐标必须用这套尺寸；
// - 主画布按 contain 基准布局，叠加用户缩放/平移；触摸点先反算到图片中心坐标系，再除以显示比例；
// - 整图支持 1x/2x/4x 与双指缩放/平移，单指仍用于取色，坐标随当前视图实时反算；
// - 放大镜显示的是以当前取样点为中心的正方形裁剪区，点按/拖动放大镜同样按裁剪区反算，
//   因此「放大后取色」与「未放大取色」指向同一张图的同一像素，不做任何颜色猜测。
// - 拖动时标记实时跟随手指，原生采样按 90ms 节流；抬手才写入最近取色，避免拖动过程刷屏。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from "react-native";

import { BottomSheet } from "../../../components/BottomSheet";
import { Chip } from "../../../components/Chip";
import { AppIcon } from "../../../components/icons/AppIcon";
import { useToast } from "../../../feedback/ToastProvider";
import { listAssets, type CaptureAsset } from "../../../db/captureAssets";
import {
  listSavedColors,
  recordColor,
  recordToolUse,
  toggleColorFavorite,
  type SavedColor,
} from "../../../db/toolUsage";
import {
  argbToRgb,
  contrastRatio,
  formatHsl,
  formatRgb,
  parseHex,
  rgbToHex,
  rgbToHsl,
  type RgbColor,
} from "../../../domain/tools/color";
import { describeError } from "../../../lib/errors";
import { pickLocalFiles } from "../../../lib/sync/fileIo";
import type { AppNav } from "../../../lib/nav";
import { useTheme } from "../../../theme/ThemeProvider";
import { font, radius, space } from "../../../theme/tokens";
import {
  closeColorSession,
  openColorSession,
  sampleColorPixels,
  shareOutText,
  writeClipboard,
} from "../shared/nativeTools";
import { takeImageDraft } from "../shareIntake";
import { ToolButton, ToolField, ToolNote, ToolScreen, ToolSection } from "../shared/ToolUI";

const TOOL_ID = "tool.color-picker";
const CANVAS_HEIGHT = 300;
const LOUPE_SIZE = 220;
const SAMPLE_THROTTLE_MS = 90;
const MAX_CANVAS_ZOOM = 6;

interface Session {
  id: string;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface LoupeView {
  region: number;
  cropX: number;
  cropY: number;
  scale: number;
  imageWidth: number;
  imageHeight: number;
  left: number;
  top: number;
}

interface PinchState {
  startZoom: number;
  startDistance: number;
  anchorX: number;
  anchorY: number;
}

function clampPoint(target: Session, point: Point): Point {
  return {
    x: Math.max(0, Math.min(target.width - 1, Math.round(point.x))),
    y: Math.max(0, Math.min(target.height - 1, Math.round(point.y))),
  };
}

function clampViewCenter(
  target: Session,
  canvasWidth: number,
  canvasHeight: number,
  zoom: number,
  center: Point,
): Point {
  const fitScale = Math.min(canvasWidth / target.width, canvasHeight / target.height);
  const scale = Math.max(fitScale * zoom, 0.0001);
  const halfWidth = canvasWidth / (2 * scale);
  const halfHeight = canvasHeight / (2 * scale);
  const clampAxis = (value: number, size: number, half: number) =>
    size <= half * 2 ? size / 2 : Math.max(half, Math.min(size - half, value));
  return {
    x: clampAxis(center.x, target.width, halfWidth),
    y: clampAxis(center.y, target.height, halfHeight),
  };
}

export function ColorPickerScreen({ nav, onBack }: { nav: AppNav; onBack: () => void }) {
  const { tokens } = useTheme();
  const { showToast } = useToast();

  const [source, setSource] = useState<{ uri: string; name: string } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [canvas, setCanvas] = useState({ width: 0, height: CANVAS_HEIGHT });
  const [focus, setFocus] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<RgbColor | null>(null);
  const [zoom, setZoom] = useState(4);
  const [format, setFormat] = useState<"hex" | "rgb" | "hsl">("hex");
  const [history, setHistory] = useState<SavedColor[]>([]);
  const [colorB, setColorB] = useState("#FFFFFF");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState<CaptureAsset[]>([]);
  const [loupeGesture, setLoupeGesture] = useState<LoupeView | null>(null);
  const [loupeTouch, setLoupeTouch] = useState<{ x: number; y: number } | null>(null);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [viewCenter, setViewCenter] = useState<Point | null>(null);

  const sessionRef = useRef<Session | null>(null);
  const sampleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSampleRef = useRef<Point | null>(null);
  const sampleSeqRef = useRef(0);
  const lastSampleAtRef = useRef(0);
  const pinchRef = useRef<PinchState | null>(null);
  const gestureModeRef = useRef<"sample" | "pinch">("sample");

  useEffect(() => {
    void recordToolUse(TOOL_ID);
    void refreshHistory();
  }, []);

  useEffect(() => {
    const draft = takeImageDraft();
    if (draft) void loadImage(draft.uri, draft.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (sampleTimerRef.current) clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = null;
      pendingSampleRef.current = null;
      const active = sessionRef.current;
      if (active) void closeColorSession(active.id);
    },
    [],
  );

  async function refreshHistory() {
    try {
      setHistory(await listSavedColors());
    } catch {
      // 历史读失败不影响取色主流程
    }
  }

  async function loadImage(uri: string, name: string) {
    setLoading(true);
    setError("");
    setCurrent(null);
    setFocus(null);
    setLoupeGesture(null);
    setLoupeTouch(null);
    setCanvasZoom(1);
    setViewCenter(null);
    pinchRef.current = null;
    gestureModeRef.current = "sample";
    cancelPendingSample();
    sampleSeqRef.current += 1;
    try {
      const previous = sessionRef.current;
      if (previous) await closeColorSession(previous.id);
      const opened = await openColorSession(uri, 1600);
      if (opened.width <= 0 || opened.height <= 0) throw new Error("图片尺寸无效");
      const next = { id: opened.id, width: opened.width, height: opened.height };
      sessionRef.current = next;
      setSession(next);
      setSource({ uri, name });
      const center = { x: Math.floor(opened.width / 2), y: Math.floor(opened.height / 2) };
      setViewCenter(center);
      setFocus(center);
      await sampleAt(center, next);
    } catch (loadError) {
      setSession(null);
      setSource(null);
      setError(`无法读取图片像素：${describeError(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  async function sampleAt(point: Point, target = session, options: { record?: boolean } = {}) {
    if (!target) return;
    const { x, y } = clampPoint(target, point);
    const seq = sampleSeqRef.current + 1;
    sampleSeqRef.current = seq;
    try {
      const values = await sampleColorPixels(target.id, [{ x, y }]);
      if (seq !== sampleSeqRef.current) return;
      const argb = values[0];
      const rgb = argbToRgb(argb);
      if (!rgb) {
        showToast("这个位置在图片之外，换个点试试", "warn");
        return;
      }
      setCurrent(rgb);
      if (options.record !== false) {
        const hex = rgbToHex(rgb);
        void recordColor(hex, "取色器").then(refreshHistory).catch(() => undefined);
      }
    } catch (sampleError) {
      if (seq !== sampleSeqRef.current) return;
      showToast(`取色失败：${describeError(sampleError)}`, "danger");
    }
  }

  function cancelPendingSample() {
    if (sampleTimerRef.current) {
      clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    pendingSampleRef.current = null;
  }

  function scheduleSample(point: Point, immediate = false) {
    if (!session) return;
    pendingSampleRef.current = point;
    if (immediate) {
      cancelPendingSample();
      lastSampleAtRef.current = Date.now();
      void sampleAt(point, session, { record: false });
      return;
    }
    if (sampleTimerRef.current) return;
    const elapsed = Date.now() - lastSampleAtRef.current;
    const delay = Math.max(0, SAMPLE_THROTTLE_MS - elapsed);
    sampleTimerRef.current = setTimeout(() => {
      sampleTimerRef.current = null;
      const pending = pendingSampleRef.current;
      pendingSampleRef.current = null;
      if (!pending) return;
      lastSampleAtRef.current = Date.now();
      void sampleAt(pending, session, { record: false });
    }, delay);
  }

  function commitSample(point: Point, target = session) {
    if (!target) return;
    cancelPendingSample();
    const next = clampPoint(target, point);
    setFocus(next);
    lastSampleAtRef.current = Date.now();
    void sampleAt(next, target, { record: true });
  }

  const layout = useMemo(() => {
    if (!session || !viewCenter || canvas.width <= 0) return null;
    const fitScale = Math.min(canvas.width / session.width, canvas.height / session.height);
    const scale = fitScale * canvasZoom;
    const displayWidth = session.width * scale;
    const displayHeight = session.height * scale;
    return {
      fitScale,
      scale,
      displayWidth,
      displayHeight,
      left: canvas.width / 2 - viewCenter.x * scale,
      top: canvas.height / 2 - viewCenter.y * scale,
    };
  }, [canvas.height, canvas.width, canvasZoom, session, viewCenter]);

  const loupe = useMemo(() => {
    if (!session || !focus) return null;
    const region = Math.min(session.width, session.height) / zoom;
    const cropX = Math.max(0, Math.min(session.width - region, focus.x - region / 2));
    const cropY = Math.max(0, Math.min(session.height - region, focus.y - region / 2));
    const scale = LOUPE_SIZE / region;
    return {
      region,
      cropX,
      cropY,
      scale,
      imageWidth: session.width * scale,
      imageHeight: session.height * scale,
      left: -cropX * scale,
      top: -cropY * scale,
    };
  }, [focus, session, zoom]);

  const displayLoupe = loupeGesture ?? loupe;

  function setCanvasZoomLevel(next: number) {
    if (!session || canvas.width <= 0) return;
    const target = focus ?? { x: session.width / 2, y: session.height / 2 };
    setViewCenter(clampViewCenter(session, canvas.width, canvas.height, next, target));
    setCanvasZoom(next);
    pinchRef.current = null;
  }

  function beginPinch(event: GestureResponderEvent) {
    if (!session || !layout || !viewCenter) return;
    const touches = event.nativeEvent.touches;
    if (touches.length < 2) return;
    const [first, second] = touches;
    if (!first || !second) return;
    const midX = (first.locationX + second.locationX) / 2;
    const midY = (first.locationY + second.locationY) / 2;
    const distance = Math.max(
      1,
      Math.hypot(first.locationX - second.locationX, first.locationY - second.locationY),
    );
    pinchRef.current = {
      startZoom: canvasZoom,
      startDistance: distance,
      anchorX: viewCenter.x + (midX - canvas.width / 2) / layout.scale,
      anchorY: viewCenter.y + (midY - canvas.height / 2) / layout.scale,
    };
    gestureModeRef.current = "pinch";
    cancelPendingSample();
  }

  function updatePinch(event: GestureResponderEvent) {
    if (!session || !layout || !pinchRef.current) return;
    const touches = event.nativeEvent.touches;
    if (touches.length < 2) return;
    const [first, second] = touches;
    if (!first || !second) return;
    const midX = (first.locationX + second.locationX) / 2;
    const midY = (first.locationY + second.locationY) / 2;
    const distance = Math.max(
      1,
      Math.hypot(first.locationX - second.locationX, first.locationY - second.locationY),
    );
    const pinch = pinchRef.current;
    const nextZoom = Math.max(
      1,
      Math.min(MAX_CANVAS_ZOOM, pinch.startZoom * (distance / pinch.startDistance)),
    );
    const nextScale = layout.fitScale * nextZoom;
    setViewCenter(
      clampViewCenter(session, canvas.width, canvas.height, nextZoom, {
        x: pinch.anchorX - (midX - canvas.width / 2) / nextScale,
        y: pinch.anchorY - (midY - canvas.height / 2) / nextScale,
      }),
    );
    setCanvasZoom(nextZoom);
  }

  function handleCanvasTouch(event: GestureResponderEvent, phase: "grant" | "move" | "release") {
    const touches = event.nativeEvent.touches;
    if (touches.length >= 2) {
      if (gestureModeRef.current !== "pinch") beginPinch(event);
      updatePinch(event);
      return;
    }
    if (gestureModeRef.current === "pinch") {
      if (phase === "release" && touches.length === 0) {
        pinchRef.current = null;
        gestureModeRef.current = "sample";
      }
      return;
    }
    handleCanvasGesture(event, phase);
  }

  function canvasPoint(event: GestureResponderEvent): Point | null {
    if (!session || !layout || !viewCenter) return null;
    const { locationX, locationY } = event.nativeEvent;
    const x = viewCenter.x + (locationX - canvas.width / 2) / layout.scale;
    const y = viewCenter.y + (locationY - canvas.height / 2) / layout.scale;
    if (x < 0 || y < 0 || x >= session.width || y >= session.height) return null;
    return { x, y };
  }

  function handleCanvasGesture(event: GestureResponderEvent, phase: "grant" | "move" | "release") {
    if (!session || !layout) return;
    const point = canvasPoint(event);
    if (!point) {
      if (phase === "release") showToast("点在图片外了，请点图片内部", "info");
      return;
    }
    const next = clampPoint(session, point);
    setFocus(next);
    if (phase === "release") {
      commitSample(next);
    } else {
      scheduleSample(next, phase === "grant");
    }
  }

  function handleLoupeGesture(
    event: GestureResponderEvent,
    phase: "grant" | "move" | "release",
    view: LoupeView | null = loupeGesture ?? loupe,
  ) {
    if (!session || !view) return;
    const { locationX, locationY } = event.nativeEvent;
    const x = clampPoint(session, {
      x: view.cropX + locationX / view.scale,
      y: view.cropY + locationY / view.scale,
    });
    setLoupeTouch({
      x: Math.max(0, Math.min(LOUPE_SIZE, locationX)),
      y: Math.max(0, Math.min(LOUPE_SIZE, locationY)),
    });
    setFocus(x);
    if (phase === "release") {
      commitSample(x);
      setLoupeGesture(null);
      setLoupeTouch(null);
    } else {
      scheduleSample(x, phase === "grant");
    }
  }

  function activateCanvas() {
    if (!session) return;
    const point = focus ?? { x: Math.floor(session.width / 2), y: Math.floor(session.height / 2) };
    commitSample(point);
  }

  function activateLoupe() {
    if (!focus) return;
    commitSample(focus);
  }

  const pickFiles = async () => {
    try {
      const files = await pickLocalFiles();
      const file = files[0];
      if (!file) return;
      const name = file.name ?? "image";
      if (!isImage(name, file.type ?? "")) {
        showToast("请选择图片文件", "warn");
        return;
      }
      await loadImage(file.uri, name);
    } catch (pickError) {
      showToast(`选择图片失败：${describeError(pickError)}`, "danger");
    }
  };

  const openLibrary = async () => {
    try {
      const assets = await listAssets();
      setLibraryAssets(
        assets.filter(
          (asset) =>
            (asset.kind === "photo" || asset.kind === "scan") &&
            asset.localPath != null &&
            isImage(asset.name, asset.mime),
        ),
      );
      setLibraryOpen(true);
    } catch (libraryError) {
      showToast(`读取素材库失败：${describeError(libraryError)}`, "danger");
    }
  };

  const currentHex = current ? rgbToHex(current) : "";
  const currentRgbText = current ? formatRgb(current) : "";
  const currentHslText = current ? formatHsl(rgbToHsl(current)) : "";
  const displayValue = format === "hex" ? currentHex : format === "rgb" ? currentRgbText : currentHslText;

  const contrast = useMemo(() => {
    if (!current) return null;
    const b = parseHex(colorB);
    if (!b) return null;
    return { ratio: contrastRatio(current, b), b };
  }, [colorB, current]);

  const copyValue = async () => {
    if (!displayValue) return;
    try {
      await writeClipboard(displayValue);
      showToast(`${format.toUpperCase()} 已复制`, "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const copyAll = async () => {
    if (!current) return;
    try {
      await writeClipboard(`${currentHex}\n${currentRgbText}\n${currentHslText}`);
      showToast("HEX / RGB / HSL 已复制", "success");
    } catch (copyError) {
      showToast(describeError(copyError), "danger");
    }
  };

  const toggleFavorite = async () => {
    if (!currentHex) return;
    try {
      await toggleColorFavorite(currentHex);
      await refreshHistory();
    } catch (favoriteError) {
      showToast(describeError(favoriteError), "danger");
    }
  };

  const shareColor = async () => {
    if (!current) return;
    try {
      await shareOutText(`${currentHex}  ${currentRgbText}  ${currentHslText}`, "取色结果");
    } catch (shareError) {
      showToast(describeError(shareError), "danger");
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ToolScreen
        title="取色器"
        subtitle="读取图片真实像素 · 放大精细取色"
        onBack={onBack}
        footer={
          <View style={styles.footerRow}>
            <ToolButton
              label="复制当前值"
              tone="primary"
              icon="copy"
              disabled={!current}
              onPress={() => void copyValue()}
              style={styles.footerPrimary}
            />
            <ToolButton label="复制全部" icon="copy" disabled={!current} onPress={() => void copyAll()} />
            <ToolButton label="分享" icon="share" disabled={!current} onPress={() => void shareColor()} />
          </View>
        }
      >
        <ToolSection title="图片来源">
          <View style={styles.actionRow}>
            <ToolButton label="相册 / 文件" icon="gallery" onPress={() => void pickFiles()} />
            <ToolButton label="素材库" icon="archive" onPress={() => void openLibrary()} />
            <ToolButton label="拍照" icon="camera" onPress={() => nav.push("capture_camera")} />
          </View>
          {loading ? <ToolNote text="正在解码图片…" /> : null}
          {error ? <ToolNote text={error} tone="warn" /> : null}
          {!source && !loading && !error ? (
            <ToolNote text="选择一张图片后，点按或拖动图片任意位置取色；下方放大镜可精确到像素并拖动微调。" />
          ) : null}
        </ToolSection>

        {session && layout ? (
          <ToolSection title={source?.name ?? "图片"} hint="点按或按住拖动图片取色；触点使用图片真实像素坐标">
            <View style={styles.zoomRow}>
              <Text style={[styles.zoomHint, { color: tokens.muted }]}>整图缩放</Text>
              {[1, 2, 4].map((value) => (
                <Chip
                  key={value}
                  label={`${value}x`}
                  active={Math.abs(canvasZoom - value) < 0.01}
                  onPress={() => setCanvasZoomLevel(value)}
                  variant="soft"
                />
              ))}
              <Text style={[styles.zoomHint, { color: tokens.muted }]}>双指缩放 / 平移</Text>
            </View>
            <View
              style={[styles.canvas, { height: CANVAS_HEIGHT, borderColor: tokens.cardBorder }]}
              onLayout={(event: LayoutChangeEvent) => {
                const { width } = event.nativeEvent.layout;
                setCanvas({ width, height: CANVAS_HEIGHT });
              }}
            >
              <Image
                source={{ uri: source!.uri }}
                style={{
                  position: "absolute",
                  width: layout.displayWidth,
                  height: layout.displayHeight,
                  left: layout.left,
                  top: layout.top,
                }}
                resizeMode="contain"
              />
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel="在图片上取色，可点按、拖动或双指缩放"
                accessibilityActions={[{ name: "activate", label: "取当前点颜色" }]}
                onAccessibilityAction={(event) => {
                  if (event.nativeEvent.actionName === "activate") activateCanvas();
                }}
                onAccessibilityTap={() => activateCanvas()}
                style={styles.canvasTouch}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderStart={(event) => {
                  if (event.nativeEvent.touches.length >= 2) beginPinch(event);
                }}
                onResponderGrant={(event) => {
                  gestureModeRef.current = "sample";
                  handleCanvasTouch(event, "grant");
                }}
                onResponderMove={(event) => handleCanvasTouch(event, "move")}
                onResponderRelease={(event) => handleCanvasTouch(event, "release")}
                onResponderEnd={(event) => {
                  if (event.nativeEvent.touches.length === 0) {
                    pinchRef.current = null;
                    gestureModeRef.current = "sample";
                  }
                }}
                onResponderTerminate={(event) => handleCanvasTouch(event, "release")}
                onResponderTerminationRequest={() => false}
              />
              {focus ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.marker,
                    {
                      left: layout.left + focus.x * layout.scale - 10,
                      top: layout.top + focus.y * layout.scale - 10,
                      borderColor: currentHex || "#FFFFFF",
                    },
                  ]}
                />
              ) : null}
            </View>
          </ToolSection>
        ) : null}

        {session && displayLoupe && focus ? (
          <ToolSection title="放大取色" hint="点按或拖动微调取样点；放大镜显示当前取样点周围区域">
            <View style={styles.zoomRow}>
              {[2, 4, 8].map((value) => (
                <Chip
                  key={value}
                  label={`${value}x`}
                  active={zoom === value}
                  onPress={() => setZoom(value)}
                  variant="soft"
                />
              ))}
              <Text style={[styles.zoomHint, { color: tokens.muted }]}>
                像素坐标 {Math.round(focus.x)}, {Math.round(focus.y)}
              </Text>
            </View>
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel="放大区域取色，可点按或拖动"
              accessibilityActions={[{ name: "activate", label: "取当前点颜色" }]}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "activate") activateLoupe();
              }}
              onAccessibilityTap={() => activateLoupe()}
              style={[
                styles.loupe,
                { width: LOUPE_SIZE, height: LOUPE_SIZE, borderColor: tokens.cardBorder },
              ]}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(event) => {
                if (!loupe) return;
                setLoupeGesture(loupe);
                handleLoupeGesture(event, "grant", loupe);
              }}
              onResponderMove={(event) => handleLoupeGesture(event, "move")}
              onResponderRelease={(event) => handleLoupeGesture(event, "release")}
              onResponderTerminate={(event) => handleLoupeGesture(event, "release")}
              onResponderTerminationRequest={() => false}
            >
              <Image
                source={{ uri: source!.uri }}
                style={{
                  width: displayLoupe.imageWidth,
                  height: displayLoupe.imageHeight,
                  position: "absolute",
                  left: displayLoupe.left,
                  top: displayLoupe.top,
                }}
              />
              {loupeTouch ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.marker,
                    {
                      left: loupeTouch.x - 10,
                      top: loupeTouch.y - 10,
                      borderColor: tokens.accent,
                    },
                  ]}
                />
              ) : (
                <View pointerEvents="none" style={[styles.loupeCenter, { borderColor: tokens.accent }]} />
              )}
            </View>
          </ToolSection>
        ) : null}

        {current ? (
          <ToolSection title="当前颜色">
            <View style={styles.currentRow}>
              <View style={[styles.swatch, { backgroundColor: currentHex, borderColor: tokens.cardBorderStrong }]} />
              <View style={styles.currentBody}>
                <Text selectable style={[styles.hexText, { color: tokens.text }]}>
                  {currentHex}
                </Text>
                <Text selectable style={[styles.channelText, { color: tokens.muted }]}>
                  {currentRgbText}
                </Text>
                <Text selectable style={[styles.channelText, { color: tokens.muted }]}>
                  {currentHslText}
                </Text>
              </View>
            </View>
            <View style={styles.chipRow}>
              {(["hex", "rgb", "hsl"] as const).map((value) => (
                <Chip
                  key={value}
                  label={value.toUpperCase()}
                  active={format === value}
                  onPress={() => setFormat(value)}
                  variant="soft"
                />
              ))}
              <ToolButton
                compact
                label={history.find((item) => item.hex === currentHex)?.favorite ? "取消收藏" : "收藏颜色"}
                icon="star"
                onPress={() => void toggleFavorite()}
              />
            </View>
            <Text style={[styles.stats, { color: tokens.muted }]}>
              当前复制格式：{displayValue || "—"}
            </Text>
          </ToolSection>
        ) : null}

        {current ? (
          <ToolSection title="对比度检查" hint="当前颜色为前景，另一个颜色为背景（WCAG 2.1）">
            <View style={styles.contrastRow}>
              <View style={[styles.contrastPreview, { backgroundColor: currentHex, borderColor: tokens.cardBorder }]}>
                <Text style={styles.contrastSample}>文字预览</Text>
              </View>
              <View
                style={[
                  styles.swatchSmall,
                  { backgroundColor: parseHex(colorB) ? colorB : tokens.bgAccent, borderColor: tokens.cardBorder },
                ]}
              />
              <View style={styles.contrastBody}>
                <Text selectable style={[styles.channelText, { color: tokens.text }]}>
                  背景 {colorB.toUpperCase()}
                </Text>
                <Text style={[styles.contrastRatio, { color: tokens.text }]}>
                  {contrast ? `${contrast.ratio.toFixed(2)} : 1` : "背景色无效"}
                </Text>
              </View>
            </View>
            <View style={styles.actionRow}>
              <ToolButton compact label="用当前色作背景" icon="sparkles" onPress={() => setColorB(currentHex)} />
              <ToolButton compact label="白底" onPress={() => setColorB("#FFFFFF")} />
              <ToolButton compact label="黑底" onPress={() => setColorB("#000000")} />
            </View>
            <ToolField
              label="背景色 HEX"
              value={colorB}
              onChangeText={setColorB}
              placeholder="#FFFFFF"
              autoCapitalize="characters"
              hint="支持 #RRGGBB 或 #RGB"
            />
            {contrast ? (
              <Text style={[styles.stats, { color: tokens.muted }]}>
                普通文字：AA {contrast.ratio >= 4.5 ? "通过" : "不通过"} · AAA{" "}
                {contrast.ratio >= 7 ? "通过" : "不通过"}
                {"\n"}大号文字（≥18pt / 14pt 粗体）：AA {contrast.ratio >= 3 ? "通过" : "不通过"} · AAA{" "}
                {contrast.ratio >= 4.5 ? "通过" : "不通过"}
              </Text>
            ) : null}
          </ToolSection>
        ) : null}

        {history.length > 0 ? (
          <ToolSection title="最近取色" hint="同色自动去重；收藏项优先保留">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.historyRow}>
              {history.map((item) => (
                <Pressable
                  key={item.hex}
                  accessibilityRole="button"
                  accessibilityLabel={`使用颜色 ${item.hex}`}
                  onPress={() => {
                    const parsed = parseHex(item.hex);
                    if (!parsed) return;
                    setCurrent(parsed);
                    setFocus(null);
                  }}
                  style={({ pressed }) => [
                    styles.historyItem,
                    { borderColor: tokens.cardBorder, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <View style={[styles.historySwatch, { backgroundColor: item.hex }]} />
                  <Text style={[styles.historyText, { color: tokens.textSoft }]}>{item.hex}</Text>
                  {item.favorite ? (
                    <AppIcon name="star" size={12} color={tokens.accent} style={styles.historyStar} />
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </ToolSection>
        ) : null}

        <ToolNote text="取色只读取本机图片像素，不申请悬浮窗、录屏或全局屏幕捕获权限；图片与颜色历史都不会上传。" />
      </ToolScreen>

      <BottomSheet
        visible={libraryOpen}
        onRequestClose={() => setLibraryOpen(false)}
        accessibilityLabel="选择素材库图片"
        maxHeightRatio={0.75}
      >
        <View style={styles.sheetBody}>
          <Text style={[styles.sheetTitle, { color: tokens.text }]}>本机素材库</Text>
          <Text style={[styles.sheetHint, { color: tokens.muted }]}>只列出本机有文件的照片与扫描件。</Text>
          <ScrollView contentContainerStyle={styles.sheetList}>
            {libraryAssets.length === 0 ? (
              <Text style={[styles.stats, { color: tokens.muted }]}>素材库还没有图片。</Text>
            ) : (
              libraryAssets.map((asset) => (
                <Pressable
                  key={asset.id}
                  accessibilityRole="button"
                  accessibilityLabel={`选择 ${asset.name}`}
                  onPress={() => {
                    setLibraryOpen(false);
                    if (asset.localPath) void loadImage(asset.localPath, asset.name);
                  }}
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
                      {asset.width && asset.height ? `${asset.width}×${asset.height}` : "尺寸未知"}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
          </ScrollView>
          <ToolButton label="关闭" onPress={() => setLibraryOpen(false)} />
        </View>
      </BottomSheet>
    </View>
  );
}

function isImage(name: string, mime: string): boolean {
  if (mime.startsWith("image/")) return true;
  return /\.(jpg|jpeg|png|webp|heic|heif|bmp)$/i.test(name);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  footerRow: { flexDirection: "row", gap: space.sm },
  footerPrimary: { flex: 1 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  canvas: {
    width: "100%",
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
  canvasTouch: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  marker: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  zoomRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  zoomHint: { fontSize: font.label },
  loupe: {
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    alignSelf: "center",
  },
  loupeCenter: {
    position: "absolute",
    left: LOUPE_SIZE / 2 - 10,
    top: LOUPE_SIZE / 2 - 10,
    width: 20,
    height: 20,
    borderWidth: 2,
    borderRadius: 10,
  },
  currentRow: { flexDirection: "row", gap: space.md, alignItems: "center" },
  swatch: {
    width: 72,
    height: 72,
    borderRadius: radius.control,
    borderWidth: 1,
  },
  currentBody: { flex: 1, gap: 2 },
  hexText: { fontSize: font.page, fontWeight: "700", fontFamily: "monospace" },
  channelText: { fontSize: font.meta, fontFamily: "monospace" },
  contrastRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  contrastPreview: {
    width: 96,
    height: 64,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  contrastSample: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  swatchSmall: { width: 32, height: 32, borderRadius: 8, borderWidth: 1 },
  contrastBody: { flex: 1, gap: 2, minWidth: 0 },
  contrastRatio: { fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] },
  chipRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  stats: { fontSize: font.label },
  historyRow: { gap: space.sm, paddingVertical: space.xs },
  historyItem: {
    width: 76,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xs,
    alignItems: "center",
    gap: 4,
  },
  historySwatch: { width: 40, height: 40, borderRadius: 8 },
  historyText: { fontSize: 11, fontFamily: "monospace" },
  historyStar: { position: "absolute", top: 2, right: 2 },
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
});
