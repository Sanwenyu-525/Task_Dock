// 轻提示：替代 Alert 做「操作结果」反馈。不拦截触摸，出现 2.4s 后自动淡出。
// 用 id 标识每一次提示，同文案连续出现两次也能重新播放。
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { floatingShadow } from "../theme/shadows";
import { font, radius, space } from "../theme/tokens";

export type ToastTone = "info" | "success" | "warn" | "danger";

export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
}

export function Toast({
  toast,
  onDismiss,
  bottomOffset = space.lg,
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
  /** 底部避让：任务页要躲开 FAB */
  bottomOffset?: number;
}) {
  const { tokens, scheme } = useTheme();
  const reduceMotion = useReduceMotion();
  const appear = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!toast) return;

    if (reduceMotion) {
      appear.setValue(1);
    } else {
      appear.setValue(0);
      Animated.timing(appear, {
        toValue: 1,
        duration: duration.base,
        easing: easeOut,
        useNativeDriver: true,
      }).start();
    }

    const timer = setTimeout(() => {
      if (reduceMotion) {
        onDismiss();
        return;
      }
      Animated.timing(appear, {
        toValue: 0,
        duration: duration.fast,
        easing: easeOut,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) onDismiss();
      });
    }, duration.toast);

    return () => clearTimeout(timer);
  }, [appear, onDismiss, reduceMotion, toast]);

  if (!toast) return null;

  const toneColor =
    toast.tone === "danger"
      ? tokens.danger
      : toast.tone === "warn"
        ? tokens.warn
        : toast.tone === "success"
          ? tokens.ok
          : tokens.accent;

  return (
    <Animated.View
      pointerEvents="none"
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={toast.text}
      style={[
        styles.wrap,
        {
          bottom: bottomOffset,
          backgroundColor: tokens.sheet,
          borderColor: tokens.cardBorder,
          opacity: appear,
          transform: [
            { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
        floatingShadow(scheme),
      ]}
    >
      <View style={[styles.bar, { backgroundColor: toneColor }]} />
      <Text numberOfLines={3} style={[styles.text, { color: tokens.text }]}>
        {toast.text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bar: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 2,
  },
  text: {
    flex: 1,
    fontSize: font.body,
    lineHeight: 18,
  },
});
