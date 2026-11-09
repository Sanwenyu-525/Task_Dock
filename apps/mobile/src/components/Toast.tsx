// 轻提示：替代 Alert 做「操作结果」反馈。不拦截触摸，出现 2.4s 后自动淡出。
// 用 id 标识每一次提示，同文案连续出现两次也能重新播放。
//
// 位置跟随操作区：页面默认置顶（Tab 页贴页面顶端，推送页落在 AppBar 下方）；
// 由 FAB、底部主按钮、底部工具行或长按动作表触发的提示用 bottom，贴近操作处、
// 也避开键盘与底部 TabBar。单条提示可用 ToastMessage.placement 覆盖页面默认值。
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

import { APP_BAR_HEIGHT } from "./AppBar";
import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { floatingShadow } from "../theme/shadows";
import { font, radius, space } from "../theme/tokens";

export type ToastTone = "info" | "success" | "warn" | "danger";

/** 提示锚点：页面顶端 / 页面底部安全区上方 */
export type ToastPlacement = "top" | "bottom";

/** 推送页顶部提示：AppBar 下沿再留 8dp，不遮挡返回与右侧动作 */
export const TOAST_TOP_PUSH = APP_BAR_HEIGHT + space.sm;

export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
  /** 单条覆盖页面默认位置：同屏多数提示走默认，底部操作区触发的用 bottom */
  placement?: ToastPlacement;
}

export function Toast({
  toast,
  onDismiss,
  placement,
  topOffset = space.sm,
  bottomOffset = space.lg,
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
  /** 页面默认位置：顶部/中部操作、列表行与错误用 top；底部固定操作区用 bottom */
  placement: ToastPlacement;
  /** 顶部避让：推送页要落在 AppBar 下方 */
  topOffset?: number;
  /** 底部避让：任务页要躲开 FAB，编辑器要躲开工具栏与键盘 */
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

  const atTop = (toast.placement ?? placement) === "top";

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
        atTop ? { top: topOffset } : { bottom: bottomOffset },
        {
          backgroundColor: tokens.sheet,
          borderColor: tokens.cardBorder,
          opacity: appear,
          transform: [
            {
              translateY: appear.interpolate({
                inputRange: [0, 1],
                // 从锚点一侧向页面内侧收拢：顶部从上往下入，底部从下往上入
                outputRange: [atTop ? -10 : 10, 0],
              }),
            },
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
