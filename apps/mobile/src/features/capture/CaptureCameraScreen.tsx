// 拍照采集：应用内相机（复用已安装的 expo-camera，不重复引入相机框架）。
//
// 质量边界：
// - 拍照后立刻把系统缓存里的临时文件复制到应用 staging 目录并建 staged 记录，
//   后续「保存本机 / 相册 / 发送电脑」永远有可用源文件；
// - 权限三态：未申请 / 已拒绝可再问 / 永久拒绝（只有后两种值得不同 UI）；
// - 应用退到后台时卸载相机预览，回到前台重建，避免占用摄像头与额外耗电；
// - 连续拍摄：每张独立 staged 记录；退出相机时明确询问是否放弃本次拍摄。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions, type CameraType, type FlashMode } from "expo-camera";

import * as repo from "../../db/captureAssets";
import { AppError, describeError } from "../../lib/errors";
import { useWindowInsets } from "../../lib/insets";
import type { Nav } from "../../lib/nav";
import { font, radius, space } from "../../theme/tokens";

import { createStagedAsset } from "../../db/captureAssets";
import { deleteFileQuietly, stageFromTemp } from "./files";
import { subscribeCaptureRevision } from "./revision";

function photoName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `照片-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.jpg`
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function CaptureCameraScreen({ nav }: { nav: Nav }) {
  const insets = useWindowInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("off");
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [busy, setBusy] = useState(false);
  const [staged, setStaged] = useState<repo.CaptureAsset[]>([]);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [mountError, setMountError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      void repo
        .listStagedAssets()
        .then((items) => {
          if (active) setStaged(items);
        })
        .catch(() => undefined);
    };
    load();
    // 从处理页返回时（保存/重拍/放弃）刷新会话剩余照片。
    const unsubscribe = subscribeCaptureRevision(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);

  // 双指缩放：只在本页接管两指手势，单指仍交给底层预览。
  // 用 ref 保存当前 zoom，PanResponder 只创建一次；否则每次缩放重渲染都会替换
  // responder，正在进行的双指手势会在中途丢失 startZoom。
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

  const takePhoto = useCallback(async () => {
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
      const asset = await createStagedAsset({
        kind: "photo",
        source: "camera",
        name: photoName(),
        localPath: copy.uri,
        mime: "image/jpeg",
        byteSize: copy.size,
        width: photo.width,
        height: photo.height,
      });
      setStaged((prev) => [...prev, asset]);
    } catch (error) {
      if (stagedUri) deleteFileQuietly(stagedUri);
      Alert.alert("拍照失败", describeError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, ready]);

  const discardAndBack = useCallback(async () => {
    const removeAll = async () => {
      for (const asset of staged) {
        const paths = await repo.deleteAsset(asset.id).catch(() => []);
        for (const path of paths) deleteFileQuietly(path);
      }
      setStaged([]);
      nav.back();
    };
    if (staged.length === 0) {
      nav.back();
      return;
    }
    Alert.alert(
      "放弃本次拍摄？",
      `已拍 ${staged.length} 张，返回会删除这些尚未保存的照片。`,
      [
        { text: "继续拍摄", style: "cancel" },
        { text: "放弃", style: "destructive", onPress: () => void removeAll() },
      ],
    );
  }, [nav, staged]);

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
        <Text style={styles.permissionTitle}>需要相机权限才能拍照</Text>
        <Text style={styles.permissionBody}>
          TaskDock 只用相机拍摄你主动触发的照片；照片先保存在本机，不会自动上传。
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
            facing={facing}
            flash={flash}
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
          onPress={() => void discardAndBack()}
        >
          <Text style={styles.roundGlyph}>‹</Text>
        </Pressable>
        <View style={styles.topPills}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`闪光灯：${flash === "off" ? "关闭" : flash === "auto" ? "自动" : "开启"}`}
            style={[styles.pill, flash !== "off" && styles.pillActive]}
            onPress={() =>
              setFlash((prev) => (prev === "off" ? "auto" : prev === "auto" ? "on" : "off"))
            }
          >
            <Text style={styles.pillText}>
              闪光 {flash === "off" ? "关" : flash === "auto" ? "自动" : "开"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`手电筒：${torch ? "开启" : "关闭"}`}
            style={[styles.pill, torch && styles.pillActive]}
            onPress={() => setTorch((prev) => !prev)}
          >
            <Text style={styles.pillText}>手电 {torch ? "开" : "关"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.thumbnailSlot}>
          {staged.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`查看已拍 ${staged.length} 张`}
              onPress={() => nav.push("capture_review")}
              style={styles.thumbnailButton}
            >
              <View style={styles.thumbnailFallback}>
                <Text style={styles.thumbnailCount}>{staged.length}</Text>
              </View>
            </Pressable>
          ) : (
            <Text style={styles.slotHint}>连续拍摄</Text>
          )}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={busy ? "正在拍照" : "拍照"}
          accessibilityState={{ disabled: busy || !ready }}
          disabled={busy || !ready}
          onPress={() => void takePhoto()}
          style={styles.shutterOuter}
        >
          <View style={[styles.shutterInner, (busy || !ready) && styles.shutterBusy]} />
        </Pressable>

        <View style={styles.rightSlot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={facing === "back" ? "切换到前置摄像头" : "切换到后置摄像头"}
            style={styles.sideButton}
            onPress={() => {
              setReady(false);
              setFacing((prev) => (prev === "back" ? "front" : "back"));
            }}
          >
            <Text style={styles.sideGlyph}>⇄</Text>
          </Pressable>
          {staged.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              style={styles.doneButton}
              onPress={() => nav.push("capture_review")}
            >
              <Text style={styles.doneText}>完成 {staged.length}</Text>
            </Pressable>
          ) : (
            <View style={styles.zoomHint}>
              <Text style={styles.slotHint}>双指缩放</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center", gap: space.sm },
  hint: { color: "#C7D2E2", fontSize: font.body },
  permissionTitle: {
    color: "#FFFFFF",
    fontSize: font.title,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: space.xl,
  },
  permissionBody: {
    color: "#B7C7DA",
    fontSize: font.body,
    lineHeight: 20,
    textAlign: "center",
    paddingHorizontal: space.xl,
    maxWidth: 320,
  },
  primaryButton: {
    marginTop: space.lg,
    minHeight: 48,
    paddingHorizontal: space.xl,
    borderRadius: radius.row,
    backgroundColor: "#0D66E0",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: "#FFFFFF", fontSize: font.body, fontWeight: "700" },
  linkButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.lg },
  linkText: { color: "#B7C7DA", fontSize: font.body },
  topBar: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  roundGlyph: { color: "#FFFFFF", fontSize: 30, lineHeight: 32, marginTop: -2 },
  topPills: { flexDirection: "row", gap: space.xs, marginLeft: "auto" },
  pill: {
    paddingHorizontal: space.md,
    minHeight: 36,
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.28)",
  },
  pillActive: { backgroundColor: "rgba(22,119,255,0.75)" },
  pillText: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(0,0,0,0.30)",
  },
  thumbnailSlot: { width: 78, alignItems: "flex-start" },
  thumbnailButton: {
    width: 52,
    height: 52,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#FFFFFF",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1A2433",
  },
  thumbnailFallback: { alignItems: "center", justifyContent: "center" },
  thumbnailCount: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  slotHint: { color: "rgba(255,255,255,0.72)", fontSize: 11 },
  shutterOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: "#FFFFFF" },
  shutterBusy: { backgroundColor: "rgba(255,255,255,0.55)" },
  rightSlot: { width: 78, alignItems: "flex-end", gap: space.xs },
  sideButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sideGlyph: { color: "#FFFFFF", fontSize: 20, fontWeight: "600" },
  doneButton: {
    minHeight: 36,
    paddingHorizontal: space.sm,
    borderRadius: 999,
    backgroundColor: "rgba(22,119,255,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  doneText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  zoomHint: { paddingTop: 4 },
});
