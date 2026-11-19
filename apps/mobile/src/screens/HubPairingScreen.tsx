// Personal Hub 扫码配对（基线 §6.2 / 契约 §2–§3）：手机端加入电脑 Hub 的唯一入口。
//
// 安全语义：
// - 二维码只建立配对申请，不授予任何远控能力；必须等电脑本机批准；
// - 批准后必须展示电脑指纹，供用户与电脑屏幕人工比对（v1.0 的 MITM 防御）；
// - 过期、签名不合法、版本不支持、电脑身份与二维码不一致都显式报错，不静默失败；
// - 页面没有任何「跳过电脑批准」入口，也没有把 invitation secret 渲染到界面。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { GlassCard } from "../components/GlassCard";
import { AppIcon } from "../components/icons/AppIcon";
import { PressableScale } from "../components/PressableScale";
import { useToast } from "../feedback/ToastProvider";
import { describeError } from "../lib/errors";
import { createHubClient } from "../lib/hub/hubClient";
import { deviceIdentityApi } from "../lib/hub/identity";
import {
  describeHubPairingError,
  pairWithHub,
  type HubPairingState,
} from "../lib/hub/pairing";
import { useWindowInsets } from "../lib/insets";
import type { Nav } from "../lib/nav";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

function deviceDisplayName(): string {
  const model = (Platform.constants as { Model?: string }).Model;
  return model ? `Android · ${model}` : "Android 手机";
}

/** 契约要求展示完整 32 位 hex 供人工逐字比对；按 4 位分组提升可读性。 */
function formatFingerprint(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) return value || "—";
  return normalized.match(/.{1,4}/g)?.join(" ") ?? normalized;
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function phaseLabel(state: HubPairingState): string {
  switch (state.phase) {
    case "verifying":
      return "正在校验二维码";
    case "verified":
      return "二维码已通过校验";
    case "submitting":
      return "正在提交配对申请";
    case "awaiting_pc_approval":
      return "等待电脑确认";
    case "approved":
      return "配对成功";
    case "rejected":
      return "电脑拒绝了申请";
    case "expired":
      return "邀请已过期";
    default:
      return "配对失败";
  }
}

export function HubPairingScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const reduceMotion = useReduceMotion();
  const { showToast } = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [state, setState] = useState<HubPairingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const controllerRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const lastInvalidScan = useRef(0);
  const scanProgress = useRef(new Animated.Value(0.5)).current;

  const invitation = state && "invitation" in state ? state.invitation : undefined;
  // 倒计时只在「邀请仍可能被批准」的阶段运行；失败/成功/拒绝后不再保留定时器。
  const countdownActive =
    state?.phase === "verified" ||
    state?.phase === "submitting" ||
    state?.phase === "awaiting_pc_approval";
  const deadlineMs =
    countdownActive && invitation ? Date.parse(invitation.exp) : null;
  const secondsLeft =
    deadlineMs === null ? null : Math.max(0, Math.ceil((deadlineMs - tick) / 1000));

  // 倒计时只在有邀请时每秒推进；页面卸载/失败后立即停止。
  useEffect(() => {
    if (deadlineMs === null) return;
    setTick(Date.now());
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadlineMs]);

  // 扫描线只在真正取景时往返；减少动态效果时停在正中。
  useEffect(() => {
    const scanning = state === null || state.phase === "verifying";
    if (reduceMotion || !permission?.granted || !scanning) {
      scanProgress.stopAnimation();
      scanProgress.setValue(0.5);
      return;
    }
    scanProgress.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanProgress, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scanProgress, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [permission?.granted, reduceMotion, scanProgress, state]);

  const scanTranslateY = scanProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-52, 52],
  });

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(null);
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const start = useCallback(async (qrPayload: string) => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await pairWithHub({
        qrPayload,
        identity: deviceIdentityApi,
        deviceName: deviceDisplayName(),
        createClient: (baseUrl) => createHubClient({ baseUrl, identity: deviceIdentityApi }),
        signal: controller.signal,
        onState: setState,
      });
    } catch (reason) {
      // 取消是用户主动动作：回到扫码态，不显示失败卡片。
      const code = (reason as { code?: unknown } | null)?.code;
      if (code === "CANCELLED") {
        setState(null);
        setError(null);
      } else {
        setError(describeHubPairingError(reason));
      }
    } finally {
      startedRef.current = false;
      controllerRef.current = null;
    }
  }, []);

  const handleBarcode = useCallback(
    ({ data }: { data: string }) => {
      if (startedRef.current || state !== null) return;
      // 相机每帧可能回传同一内容；2s 内只提示一次无效码。
      if (!data || data.trim().length === 0) return;
      const now = Date.now();
      if (now - lastInvalidScan.current < 1500) return;
      lastInvalidScan.current = now;
      void start(data);
    },
    [start, state],
  );

  const askCamera = useCallback(async () => {
    try {
      const result = await requestPermission();
      if (!result.granted) showToast("未授予相机权限，无法扫描配对二维码", "danger");
    } catch (reason) {
      showToast(`相机权限申请失败：${describeError(reason)}`, "danger");
    }
  }, [requestPermission, showToast]);

  const goBack = useCallback(() => {
    cancel();
    nav.back();
  }, [cancel, nav]);

  const scanning = state === null;
  const showCamera = scanning && permission?.granted === true;

  return (
    <View style={styles.container}>
      <AppBar title="Personal Hub 配对" badge={<Badge label="Personal Hub" tone="active" />} onBack={goBack} />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.intro, { color: tokens.textSoft }]}>
          扫描电脑端 Personal Hub 显示的二维码，把这台手机加入你的电脑。提交后必须在电脑上确认，
          手机端不能跳过这一步。
        </Text>

        {scanning ? (
          <GlassCard style={styles.finderCard}>
            <View style={[styles.finder, { backgroundColor: tokens.ink }]}>
              {showCamera ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleBarcode}
                  accessibilityLabel="Personal Hub 配对二维码扫描取景框"
                />
              ) : null}
              {(["topLeft", "topRight", "bottomLeft", "bottomRight"] as const).map((corner) => (
                <View key={corner} pointerEvents="none" style={[styles.bracket, styles[corner]]}>
                  <View style={[styles.bracketH, { backgroundColor: tokens.accent }]} />
                  <View style={[styles.bracketV, { backgroundColor: tokens.accent }]} />
                </View>
              ))}
              <View pointerEvents="none" style={[styles.reticle, { borderColor: tokens.accent }]}>
                <Animated.View
                  style={[
                    styles.scanLine,
                    { backgroundColor: tokens.accent, transform: [{ translateY: scanTranslateY }] },
                  ]}
                />
              </View>
              {!permission?.granted ? (
                <View style={styles.cameraPrompt} pointerEvents="box-none">
                  <Text style={[styles.cameraPromptText, { color: tokens.inkText }]}>
                    {permission?.canAskAgain === false
                      ? "相机权限已被拒绝，请在系统设置中允许后返回。"
                      : "授予相机权限后，将电脑上的配对二维码放入框内。"}
                  </Text>
                  <PressableScale
                    onPress={() =>
                      permission?.canAskAgain === false
                        ? void Linking.openSettings()
                        : void askCamera()
                    }
                    accessibilityLabel={
                      permission?.canAskAgain === false ? "打开系统设置" : "允许使用相机"
                    }
                    contentStyle={[styles.cameraButton, { backgroundColor: tokens.accentFill }]}
                  >
                    <Text style={[styles.cameraButtonText, { color: tokens.onAccent }]}>
                      {permission?.canAskAgain === false ? "打开系统设置" : "允许使用相机"}
                    </Text>
                  </PressableScale>
                </View>
              ) : null}
            </View>
            <Text style={[styles.finderHint, { color: tokens.textSoft }]}>
              二维码默认 5 分钟内有效且只能使用一次；过期后请在电脑上重新生成。
            </Text>
          </GlassCard>
        ) : null}

        {state && !invitation && state.phase !== "failed" ? (
          <GlassCard style={styles.statusCard}>
            <View style={styles.busyRow}>
              <ActivityIndicator color={tokens.accent} />
              <Text style={[styles.busyText, { color: tokens.textSoft }]}>
                {state.phase === "verifying" ? "正在校验二维码内容与签名…" : "正在准备配对…"}
              </Text>
            </View>
            <PressableScale
              onPress={cancel}
              accessibilityLabel="取消配对"
              contentStyle={styles.secondary}
            >
              <Text style={[styles.secondaryText, { color: tokens.accentText }]}>取消</Text>
            </PressableScale>
          </GlassCard>
        ) : null}

        {state && state.phase !== "approved" && state.phase !== "rejected" && state.phase !== "expired" && state.phase !== "failed" && invitation ? (
          <GlassCard style={styles.statusCard}>
            <View style={styles.statusHeader}>
              <Text style={[styles.statusTitle, { color: tokens.text }]}>{phaseLabel(state)}</Text>
              {secondsLeft !== null ? (
                <Text style={[styles.countdown, { color: secondsLeft <= 60 ? tokens.warn : tokens.muted }]}>
                  剩余 {formatCountdown(secondsLeft)}
                </Text>
              ) : null}
            </View>

            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: tokens.muted }]}>Hub 设备 ID</Text>
              <Text numberOfLines={1} style={[styles.metaValue, styles.mono, { color: tokens.text }]}>
                {invitation.hid.slice(0, 8)}…{invitation.hid.slice(-4)}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: tokens.muted }]}>电脑指纹（hfp）</Text>
            </View>
            <Text selectable style={[styles.fingerprint, { color: tokens.text }]}>
              {formatFingerprint(invitation.hfp)}
            </Text>

            {state.phase === "awaiting_pc_approval" ? (
              <View style={[styles.approvalBox, { backgroundColor: tokens.warnSoft }]}>
                <Text style={[styles.approvalTitle, { color: tokens.text }]}>请在电脑上确认</Text>
                <Text style={[styles.approvalText, { color: tokens.textSoft }]}>
                  电脑端 Personal Hub 会显示这台手机的指纹；请在电脑本机点击「批准」。
                  手机端不会、也不能代替电脑批准。
                </Text>
                {state.warning ? (
                  <Text style={[styles.warningText, { color: tokens.warn }]}>{state.warning}</Text>
                ) : null}
              </View>
            ) : (
              <View style={styles.busyRow}>
                <ActivityIndicator color={tokens.accent} />
                <Text style={[styles.busyText, { color: tokens.textSoft }]}>
                  {state.phase === "verified" ? "正在联系云端…" : "正在提交配对申请…"}
                </Text>
              </View>
            )}

            <PressableScale
              onPress={cancel}
              accessibilityLabel="取消配对"
              contentStyle={styles.secondary}
            >
              <Text style={[styles.secondaryText, { color: tokens.accentText }]}>取消</Text>
            </PressableScale>
          </GlassCard>
        ) : null}

        {state?.phase === "approved" ? (
          <GlassCard style={styles.successCard} level="primary">
            <View style={[styles.successMark, { backgroundColor: tokens.okSoft }]}>
              <AppIcon name="check" color={tokens.ok} size={34} />
            </View>
            <Text style={[styles.successTitle, { color: tokens.text }]}>配对成功</Text>
            <Text style={[styles.successText, { color: tokens.textSoft }]}>
              「{state.peer.displayName || "电脑"}」已批准这台手机。配对只代表可信设备关系，
              不授予屏幕查看、输入控制或文件访问。
            </Text>

            <View style={[styles.compareCard, { borderColor: tokens.cardBorderStrong }]}>
              <Text style={[styles.compareTitle, { color: tokens.text }]}>
                请与电脑屏幕逐字比对电脑指纹
              </Text>
              <Text selectable style={[styles.fingerprint, { color: tokens.text }]}>
                {formatFingerprint(state.peer.identityFingerprint)}
              </Text>
              <Text style={[styles.compareHint, { color: tokens.textSoft }]}>
                电脑端应显示相同指纹。若不一致，说明连接可能被中间人替换，请立即在电脑上撤销这台设备。
              </Text>
            </View>

            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: tokens.muted }]}>电脑</Text>
              <Text numberOfLines={1} style={[styles.metaValue, { color: tokens.text }]}>
                {state.peer.displayName || state.peer.deviceId.slice(0, 8)}
              </Text>
            </View>

            <PressableScale
              onPress={nav.back}
              accessibilityLabel="完成配对"
              style={styles.stretch}
              contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>完成</Text>
            </PressableScale>
          </GlassCard>
        ) : null}

        {state?.phase === "rejected" ? (
          <GlassCard style={styles.errorCard}>
            <Text style={[styles.errorTitle, { color: tokens.text }]}>电脑拒绝了这次申请</Text>
            <Text style={[styles.errorBody, { color: tokens.textSoft }]}>
              邀请已失效。请确认电脑端操作人是你本人，然后在电脑上重新生成配对二维码。
            </Text>
            <PressableScale
              onPress={cancel}
              accessibilityLabel="重新扫码"
              style={styles.stretch}
              contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>重新扫码</Text>
            </PressableScale>
          </GlassCard>
        ) : null}

        {state?.phase === "expired" ? (
          <GlassCard style={styles.errorCard}>
            <Text style={[styles.errorTitle, { color: tokens.text }]}>配对二维码已过期</Text>
            <Text style={[styles.errorBody, { color: tokens.textSoft }]}>
              邀请默认 5 分钟有效。请在电脑上重新生成二维码，再重新扫码。
            </Text>
            <PressableScale
              onPress={cancel}
              accessibilityLabel="重新扫码"
              style={styles.stretch}
              contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>重新扫码</Text>
            </PressableScale>
          </GlassCard>
        ) : null}

        {state?.phase === "failed" || (error && !state) ? (
          <GlassCard style={styles.errorCard}>
            <Text style={[styles.errorTitle, { color: tokens.text }]}>配对未完成</Text>
            <Text accessibilityRole="alert" style={[styles.errorBody, { color: tokens.danger }]}>
              {error ?? (state?.phase === "failed" ? describeHubPairingError(state.error) : "配对失败")}
            </Text>
            {state?.phase === "failed" ? (
              <Text style={[styles.errorCode, { color: tokens.muted }]}>
                原因码：{state.error.code}
              </Text>
            ) : null}
            <PressableScale
              onPress={cancel}
              accessibilityLabel="返回扫码"
              style={styles.stretch}
              contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>返回扫码</Text>
            </PressableScale>
          </GlassCard>
        ) : null}

        <GlassCard style={styles.noteCard} level="tertiary">
          <Text style={[styles.noteText, { color: tokens.textSoft }]}>
            二维码只建立配对申请，不授予远控权限。设备私钥只保存在本机 Keystore 包装的存储中，
            不会上传到云端，也不会显示在本页面。
          </Text>
        </GlassCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  intro: {
    fontSize: font.body,
    lineHeight: 19,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  finderCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.sm,
  },
  finder: {
    height: 250,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  bracket: {
    position: "absolute",
    width: 22,
    height: 22,
  },
  topLeft: { left: 14, top: 14 },
  topRight: { right: 14, top: 14, transform: [{ scaleX: -1 }] },
  bottomLeft: { left: 14, bottom: 14, transform: [{ scaleY: -1 }] },
  bottomRight: { right: 14, bottom: 14, transform: [{ scaleX: -1 }, { scaleY: -1 }] },
  bracketH: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 22,
    height: 2.5,
    borderRadius: 2,
  },
  bracketV: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 2.5,
    height: 22,
    borderRadius: 2,
  },
  reticle: {
    width: 132,
    height: 132,
    borderRadius: radius.control,
    borderWidth: 1,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  scanLine: {
    width: 96,
    height: 2,
    borderRadius: 1,
  },
  cameraPrompt: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    bottom: space.lg,
    alignItems: "center",
    gap: space.sm,
  },
  cameraPromptText: {
    fontSize: font.meta,
    lineHeight: 18,
    textAlign: "center",
  },
  cameraButton: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraButtonText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  finderHint: {
    fontSize: font.meta,
    lineHeight: 18,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
  },
  statusCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    gap: space.xs,
  },
  statusHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    marginBottom: space.xs,
  },
  statusTitle: {
    fontSize: font.title,
    fontWeight: "700",
    flexShrink: 1,
  },
  countdown: {
    fontSize: font.body,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    minHeight: 24,
  },
  metaLabel: {
    fontSize: font.body,
  },
  metaValue: {
    flexShrink: 1,
    textAlign: "right",
    fontSize: font.body,
    fontWeight: "600",
  },
  mono: {
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
  },
  fingerprint: {
    fontSize: font.title - 1,
    lineHeight: 24,
    fontWeight: "700",
    letterSpacing: 1.5,
    fontVariant: ["tabular-nums"],
    paddingVertical: space.xs,
  },
  approvalBox: {
    marginTop: space.sm,
    borderRadius: radius.control,
    padding: space.md,
    gap: space.xs,
  },
  approvalTitle: {
    fontSize: font.title - 1,
    fontWeight: "700",
  },
  approvalText: {
    fontSize: font.body,
    lineHeight: 19,
  },
  warningText: {
    fontSize: font.meta,
    lineHeight: 18,
  },
  busyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginTop: space.md,
  },
  busyText: {
    fontSize: font.body,
  },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    marginTop: space.sm,
  },
  primaryText: {
    fontSize: font.title,
    fontWeight: "600",
  },
  secondary: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.sm,
  },
  secondaryText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  successCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.lg,
    alignItems: "center",
    gap: space.sm,
  },
  successMark: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
  },
  successTitle: {
    fontSize: font.title + 2,
    fontWeight: "700",
    marginTop: space.xs,
  },
  successText: {
    fontSize: font.body,
    lineHeight: 19,
    textAlign: "center",
  },
  compareCard: {
    alignSelf: "stretch",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control,
    padding: space.md,
    marginTop: space.xs,
    gap: space.xs,
  },
  compareTitle: {
    fontSize: font.body,
    fontWeight: "700",
  },
  compareHint: {
    fontSize: font.meta,
    lineHeight: 18,
  },
  stretch: {
    alignSelf: "stretch",
    marginTop: space.xs,
  },
  errorCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.lg,
    gap: space.sm,
  },
  errorTitle: {
    fontSize: font.title,
    fontWeight: "700",
  },
  errorBody: {
    fontSize: font.body,
    lineHeight: 19,
  },
  errorCode: {
    fontSize: font.label,
    fontVariant: ["tabular-nums"],
  },
  noteCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
  },
  noteText: {
    fontSize: font.body,
    lineHeight: 19,
  },
});
