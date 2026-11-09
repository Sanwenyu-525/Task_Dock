// 配对新设备：应用内扫码（expo-camera）+ 手动地址/配对码，真实调用桌面端 /v1/pair。
//
// 状态机：scan → confirm（仅扫码有指纹可确认）→ pairing → success。
// 安全边界：
// - 相机权限只在用户点「允许使用相机」后申请，不在页面挂载时自动弹；
// - 配对码与令牌不写日志；令牌只进 SecureStore（db/syncConnection）；
// - 扫码成功后立即卸载相机（避免持续取帧），返回扫码时再重新挂载；
// - 失败按桌面端稳定错误码给可操作文案，不把 HTTP 细节糊到用户脸上。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { Toast, TOAST_TOP_PUSH, type ToastMessage, type ToastTone } from "../components/Toast";
import { loadConnection, loadOrCreateDeviceUid, saveConnection } from "../db/syncConnection";
import { describeError } from "../lib/errors";
import { useWindowInsets } from "../lib/insets";
import { useKeyboardHeight } from "../lib/keyboard";
import type { Nav } from "../lib/nav";
import {
  normalizeDesktopAddress,
  normalizePairingCode,
  parsePairingUri,
  targetToAddress,
  type PairingTarget,
} from "../lib/sync/pairing";
import { pairWithDesktop, pairingErrorMessage } from "../lib/sync/pairClient";
import { consumePendingPairing, subscribePendingPairing } from "../lib/sync/pendingPairing";
import { useTheme } from "../theme/ThemeProvider";
import { useReduceMotion } from "../theme/MotionProvider";
import { font, radius, space } from "../theme/tokens";

const STEPS = ["扫描", "确认指纹", "完成"];

function deviceLabel(): string {
  return Platform.OS === "android" ? "Android 手机" : "iPhone";
}

function formatFingerprint(value: string): string {
  return value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4)}` : value || "—";
}

interface SuccessState {
  serverName: string;
}

export function PairingScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const reduceMotion = useReduceMotion();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState(false);
  const [target, setTarget] = useState<PairingTarget | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  const lastInvalidScan = useRef(0);
  /** 0 = 取景框顶部，1 = 底部；在框内上下往返（位移走 native driver）。 */
  const scanProgress = useRef(new Animated.Value(0.5)).current;

  const keyboardHeight = useKeyboardHeight(manual && !target && !success);

  // 扫描线只在相机真正取景时往返；减少动态或未授权时停在正中（不消耗帧）。
  useEffect(() => {
    if (reduceMotion || !permission?.granted) {
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
    return () => {
      loop.stop();
    };
  }, [permission?.granted, reduceMotion, scanProgress]);

  const scanTranslateY = scanProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [-52, 52],
  });

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // 已配对过：预填上次桌面地址，方便换码重配；不覆盖正在输入的内容。
  useEffect(() => {
    let active = true;
    loadConnection()
      .then((connection) => {
        if (!active || !connection) return;
        setAddress((current) => current || `${connection.host}:${connection.port}`);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // 深链（系统相机扫码唤起）：挂载时取走待处理载荷，运行中由订阅者接收。
  useEffect(() => {
    const apply = (next: PairingTarget) => {
      setTarget(next);
      setManual(false);
      setSuccess(null);
      setError(null);
    };
    const pending = consumePendingPairing();
    if (pending) apply(pending);
    const unsubscribe = subscribePendingPairing(apply);
    return unsubscribe;
  }, []);

  const handleBarcode = useCallback(
    ({ data }: { data: string }) => {
      const parsed = parsePairingUri(data);
      if (!parsed) {
        // 相机每帧都可能回传同一无效码：2s 内只提示一次，避免 Toast 风暴。
        const now = Date.now();
        if (now - lastInvalidScan.current > 2000) {
          lastInvalidScan.current = now;
          showToast("这不是 Task Dock 的配对二维码", "danger");
        }
        return;
      }
      Keyboard.dismiss();
      setTarget(parsed);
      setError(null);
    },
    [showToast],
  );

  const runPair = useCallback(async (candidate: PairingTarget) => {
    setBusy(true);
    setError(null);
    try {
      const deviceUid = await loadOrCreateDeviceUid();
      const result = await pairWithDesktop({
        address: targetToAddress(candidate),
        code: candidate.code,
        deviceName: deviceLabel(),
        platform: Platform.OS,
        deviceUid,
      });
      const addressInfo = targetToAddress(candidate);
      await saveConnection({
        token: result.token,
        meta: {
          baseUrl: addressInfo.baseUrl,
          host: addressInfo.host,
          port: addressInfo.port,
          serverName: result.serverName || candidate.serverName || addressInfo.host,
          deviceId: result.deviceId,
          platform: Platform.OS,
          instanceId: candidate.instanceId,
          fingerprint: candidate.fingerprint,
          pairedAt: result.pairedAt,
        },
      });
      setSuccess({
        serverName: result.serverName || candidate.serverName || addressInfo.host,
      });
      setTarget(null);
      setCode("");
    } catch (reason) {
      setError(pairingErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const submitManual = useCallback(() => {
    const addressInfo = normalizeDesktopAddress(address);
    if (!addressInfo) {
      setError("地址格式不正确：请输入桌面端显示的 IP 或 IP:端口（不支持 https）");
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError("配对码必须是 6 位数字");
      return;
    }
    Keyboard.dismiss();
    void runPair({
      host: addressInfo.host,
      port: addressInfo.port,
      code,
      serverName: "",
      instanceId: "",
      fingerprint: "",
      raw: "",
    });
  }, [address, code, runPair]);

  const askCamera = useCallback(async () => {
    try {
      const result = await requestPermission();
      if (!result.granted) {
        showToast("未授予相机权限，可改用手动输入", "danger");
      }
    } catch (reason) {
      showToast(`相机权限申请失败：${describeError(reason)}`, "danger");
    }
  }, [requestPermission, showToast]);

  const gotoScan = useCallback(() => {
    setManual(false);
    setTarget(null);
    setError(null);
  }, []);

  const stepIndex = success ? 2 : target ? 1 : 0;

  return (
    <View style={styles.container}>
      <AppBar
        title="配对新设备"
        badge={<Badge label="局域网" tone="active" />}
        onBack={nav.back}
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 + keyboardHeight + insets.bottom }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.intro, { color: tokens.textSoft }]}>
          与桌面端 Task Dock 在同一 Wi-Fi 下建立连接。桌面端是配对发起方，手机端只接受授权。
        </Text>

        <GlassCard style={styles.steps}>
          {STEPS.map((label, index) => (
            <View key={label} style={styles.step}>
              <View
                style={[
                  styles.stepDot,
                  {
                    backgroundColor: index <= stepIndex ? tokens.accentFill : "transparent",
                    borderColor: index <= stepIndex ? tokens.accentFill : tokens.cardBorder,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.stepIndex,
                    { color: index <= stepIndex ? tokens.onAccent : tokens.muted },
                  ]}
                >
                  {index + 1}
                </Text>
              </View>
              <Text
                numberOfLines={1}
                style={[
                  styles.stepLabel,
                  {
                    color: index === stepIndex ? tokens.text : tokens.muted,
                    fontWeight: index === stepIndex ? "600" : "400",
                  },
                ]}
              >
                {label}
              </Text>
              {index < STEPS.length - 1 ? (
                <View style={[styles.stepLine, { backgroundColor: tokens.separator }]} />
              ) : null}
            </View>
          ))}
        </GlassCard>

        {success ? (
          <GlassCard style={styles.successCard}>
            <View style={[styles.successMark, { backgroundColor: tokens.okSoft }]}>
              <Text style={[styles.successCheck, { color: tokens.ok }]}>✓</Text>
            </View>
            <Text style={[styles.successTitle, { color: tokens.text }]}>配对成功</Text>
            <Text style={[styles.successText, { color: tokens.textSoft }]}>
              「{success.serverName}」已授权，令牌已保存到本机安全存储。可在「同步」页测试连接。
            </Text>
            <PressableScale
              onPress={nav.back}
              accessibilityLabel="完成配对"
              style={styles.successAction}
              contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>完成</Text>
            </PressableScale>
          </GlassCard>
        ) : target ? (
          <GlassCard style={styles.confirmCard}>
            <Text style={[styles.confirmTitle, { color: tokens.text }]}>确认桌面端</Text>
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: tokens.muted }]}>设备</Text>
              <Text numberOfLines={1} style={[styles.metaValue, { color: tokens.text }]}>
                {target.serverName || "未命名桌面端"}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: tokens.muted }]}>地址</Text>
              <Text numberOfLines={1} style={[styles.metaValue, { color: tokens.text }]}>
                {target.host}:{target.port}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: tokens.muted }]}>配对码</Text>
              <Text style={[styles.metaValue, styles.mono, { color: tokens.text }]}>
                {target.code}
              </Text>
            </View>
            {target.fingerprint ? (
              <View style={styles.metaRow}>
                <Text style={[styles.metaLabel, { color: tokens.muted }]}>设备指纹</Text>
                <Text style={[styles.metaValue, styles.mono, { color: tokens.text }]}>
                  {formatFingerprint(target.fingerprint)}
                </Text>
              </View>
            ) : null}
            <Text style={[styles.confirmHint, { color: tokens.muted }]}>
              请核对设备指纹与桌面端「配对新设备」弹层显示一致，再确认授权。
            </Text>
            {error ? (
              <Text accessibilityRole="alert" style={[styles.errorText, { color: tokens.danger }]}>
                {error}
              </Text>
            ) : null}
            <PressableScale
              onPress={() => void runPair(target)}
              disabled={busy}
              accessibilityLabel="确认配对"
              accessibilityState={{ disabled: busy }}
              contentStyle={[
                styles.primary,
                { backgroundColor: busy ? tokens.track : tokens.accentFill },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={tokens.onAccent} />
              ) : (
                <Text style={[styles.primaryText, { color: tokens.onAccent }]}>确认配对</Text>
              )}
            </PressableScale>
            <PressableScale
              onPress={gotoScan}
              disabled={busy}
              accessibilityLabel="重新扫描"
              contentStyle={styles.secondary}
            >
              <Text style={[styles.secondaryText, { color: tokens.accent }]}>重新扫描</Text>
            </PressableScale>
          </GlassCard>
        ) : (
          <>
            <View style={[styles.segment, { backgroundColor: tokens.bgAccent }]}>
              <PressableScale
                onPress={() => {
                  setManual(false);
                  setError(null);
                }}
                accessibilityLabel="扫描二维码"
                accessibilityRole="tab"
                accessibilityState={{ selected: !manual }}
                style={styles.segmentItem}
                contentStyle={[styles.segmentItemInner, !manual && { backgroundColor: tokens.card }]}
              >
                <Text style={[styles.segmentText, { color: !manual ? tokens.text : tokens.muted }]}>
                  扫描二维码
                </Text>
              </PressableScale>
              <PressableScale
                onPress={() => {
                  setManual(true);
                  setError(null);
                }}
                accessibilityLabel="手动输入"
                accessibilityRole="tab"
                accessibilityState={{ selected: manual }}
                style={styles.segmentItem}
                contentStyle={[styles.segmentItemInner, manual && { backgroundColor: tokens.card }]}
              >
                <Text style={[styles.segmentText, { color: manual ? tokens.text : tokens.muted }]}>
                  手动输入
                </Text>
              </PressableScale>
            </View>

            {manual ? (
              <GlassCard style={styles.formCard}>
                <Text style={[styles.formLabel, { color: tokens.text }]}>桌面端地址</Text>
                <TextInput
                  accessibilityLabel="桌面端地址"
                  value={address}
                  onChangeText={setAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  placeholder="例如 192.168.1.10:47822"
                  placeholderTextColor={tokens.faint}
                  underlineColorAndroid="transparent"
                  selectTextOnFocus
                  editable={!busy}
                  style={[
                    styles.input,
                    {
                      backgroundColor: tokens.bgAccent,
                      borderColor: tokens.cardBorder,
                      color: tokens.text,
                    },
                  ]}
                />
                <Text style={[styles.formLabel, { color: tokens.text }]}>6 位配对码</Text>
                <TextInput
                  accessibilityLabel="6 位配对码"
                  value={code}
                  onChangeText={(text) => setCode(normalizePairingCode(text))}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="桌面端「配对新设备」弹层显示"
                  placeholderTextColor={tokens.faint}
                  underlineColorAndroid="transparent"
                  editable={!busy}
                  style={[
                    styles.input,
                    styles.codeInput,
                    {
                      backgroundColor: tokens.bgAccent,
                      borderColor: tokens.cardBorder,
                      color: tokens.text,
                    },
                  ]}
                />
                {error ? (
                  <Text accessibilityRole="alert" style={[styles.errorText, { color: tokens.danger }]}>
                    {error}
                  </Text>
                ) : null}
                <PressableScale
                  onPress={submitManual}
                  disabled={busy}
                  accessibilityLabel="连接并配对"
                  accessibilityState={{ disabled: busy }}
                  contentStyle={[
                    styles.primary,
                    { backgroundColor: busy ? tokens.track : tokens.accentFill },
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator color={tokens.onAccent} />
                  ) : (
                    <Text style={[styles.primaryText, { color: tokens.onAccent }]}>
                      连接并配对
                    </Text>
                  )}
                </PressableScale>
              </GlassCard>
            ) : (
              <GlassCard style={styles.finderCard}>
                <View style={[styles.finder, { backgroundColor: tokens.ink }]}>
                  {permission?.granted ? (
                    <CameraView
                      style={StyleSheet.absoluteFill}
                      facing="back"
                      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                      onBarcodeScanned={handleBarcode}
                      accessibilityLabel="二维码扫描取景框"
                    />
                  ) : null}
                  {(["topLeft", "topRight", "bottomLeft", "bottomRight"] as const).map((corner) => (
                    <View key={corner} pointerEvents="none" style={[styles.bracket, styles[corner]]}>
                      <View style={[styles.bracketH, { backgroundColor: tokens.accent }]} />
                      <View style={[styles.bracketV, { backgroundColor: tokens.accent }]} />
                    </View>
                  ))}
                  {/* 取景框是恒暗底（ink）或实时相机画面：accentSoft 叠在 ink 上只有约
                      1.1:1（浅色）/ 1.3:1（深色），线稿几乎不可见。改用 accent 后对 ink
                      浅色 3.31:1、深色 8.27:1，满足非文字图形 3:1，也与四角括号同色。 */}
                  <View pointerEvents="none" style={[styles.reticle, { borderColor: tokens.accent }]}>
                    <Animated.View
                      style={[
                        styles.scanLine,
                        {
                          backgroundColor: tokens.accent,
                          transform: [{ translateY: scanTranslateY }],
                        },
                      ]}
                    />
                  </View>
                  {!permission?.granted ? (
                    <View style={styles.cameraPrompt} pointerEvents="box-none">
                      <Text style={[styles.cameraPromptText, { color: tokens.inkText }]}>
                        {permission?.canAskAgain === false
                          ? "相机权限已被拒绝，请在系统设置中允许，或改用手动输入。"
                          : "授予相机权限后，将桌面端二维码放入框内即可配对。"}
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
                  将桌面端显示的二维码放入框内；配对码 120 秒内有效。
                </Text>
              </GlassCard>
            )}
          </>
        )}

        <GlassCard style={styles.noteCard}>
          <View style={styles.noteRow}>
            <View style={styles.shield}>
              <View style={[styles.shieldBody, { borderColor: tokens.ok }]} />
              <View style={[styles.shieldTip, { backgroundColor: tokens.ok }]} />
            </View>
            <Text style={[styles.noteText, { color: tokens.textSoft }]}>
              仅在局域网内配对；令牌保存在系统安全存储，桌面端只保存哈希。剪贴板与文件路径永不同步。
            </Text>
          </View>
        </GlassCard>

        <Text style={[styles.footer, { color: tokens.faint }]}>
          桌面端路径：左侧导航「手机互传」或标题栏手机图标
        </Text>
      </ScrollView>

      <Toast toast={toast} onDismiss={dismissToast} placement="top" topOffset={TOAST_TOP_PUSH} />
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
  steps: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    flexDirection: "row",
    alignItems: "center",
    padding: space.md,
    gap: space.xs,
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    // 三段等分整行：flex:1 让每段拿到行宽的 1/3（RN 下 flexBasis 归 0，按 grow 等分）。
    // 连接线在每段内部，只有 step 自身先拿到宽度，段内 flex:1 的连线才有空间补满；
    // 若这里只写 flexShrink:0，第一段会靠内部 grow 的连线吃掉整行，把后两段挤出卡片（真机复验踩过）。
    flex: 1,
  },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  stepIndex: {
    fontSize: font.label,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  stepLabel: {
    fontSize: font.label,
    // RN/Yoga 的 flexShrink 默认是 0（与 Web 不同），不显式给 1 的话窄屏或大字号下
    // 文字只会撑出本段而不会省略。给 1 让它先收缩、再由 numberOfLines={1} 省略，
    // 保证任何宽度下先省略文字，而不是把后两段顶出卡片或压成竖排。
    flexShrink: 1,
  },
  stepLine: {
    height: StyleSheet.hairlineWidth,
    flex: 1,
    minWidth: 12,
    marginHorizontal: space.xs,
  },
  segment: {
    flexDirection: "row",
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: 3,
    borderRadius: radius.control,
    gap: 3,
  },
  segmentItem: {
    flex: 1,
  },
  segmentItemInner: {
    minHeight: 36,
    borderRadius: radius.control - 3,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentText: {
    fontSize: font.body,
    fontWeight: "600",
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
    minHeight: 40,
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
  formCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    gap: space.sm,
  },
  formLabel: {
    fontSize: font.body,
    fontWeight: "600",
    marginTop: space.xs,
  },
  input: {
    minHeight: 44,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.body,
  },
  codeInput: {
    fontSize: font.title + 4,
    letterSpacing: 6,
    fontVariant: ["tabular-nums"],
  },
  errorText: {
    fontSize: font.meta,
    lineHeight: 18,
    paddingTop: space.xs,
  },
  confirmCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
    gap: space.sm,
  },
  confirmTitle: {
    fontSize: font.title,
    fontWeight: "700",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    minHeight: 26,
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
  confirmHint: {
    fontSize: font.meta,
    lineHeight: 18,
    paddingTop: space.xs,
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
  successCheck: {
    fontSize: 30,
    fontWeight: "700",
    lineHeight: 34,
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
    paddingHorizontal: space.sm,
  },
  /** 成功卡是居中列布局，按钮必须显式拉满，否则两个汉字会被挤成竖排 */
  successAction: {
    alignSelf: "stretch",
    marginTop: space.xs,
  },
  noteCard: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    padding: space.md,
  },
  noteRow: {
    flexDirection: "row",
    gap: space.sm,
  },
  shield: {
    width: 18,
    height: 20,
    alignItems: "center",
    marginTop: 2,
  },
  shieldBody: {
    width: 14,
    height: 15,
    borderWidth: 1.5,
    borderBottomWidth: 0,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  shieldTip: {
    width: 14,
    height: 3,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
  },
  noteText: {
    flex: 1,
    fontSize: font.body,
    lineHeight: 19,
  },
  footer: {
    fontSize: font.label,
    textAlign: "center",
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
});
