// 全局唯一的 Toast 宿主：由 Shell 在最上层挂载一次。
// 负责定位（状态栏/标题栏/键盘/底部安全区）、队列计时、入场/退场动画与无障碍。
// 页面不再各自渲染 Toast，也不传 topOffset / bottomOffset。
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { useToast, useToastState } from "../feedback/ToastProvider";
import { useActiveToastLayout } from "../feedback/ToastLayoutProvider";
import {
  resolveToastBottomOffset,
  resolveToastTopOffset,
} from "../feedback/toastLayout";
import { toastTransition } from "../feedback/toastLifecycle";
import type { ToastItem } from "../feedback/toastQueue";
import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { cardShadow } from "../theme/shadows";
import { font, radius, space } from "../theme/tokens";
import { useKeyboardHeight } from "../lib/keyboard";

import { AppIcon, type IconName } from "./icons/AppIcon";

const TONE_ICON: Record<ToastItem["tone"], IconName> = {
  info: "info",
  success: "success",
  warn: "warning",
  danger: "error",
};

export function ToastHost({
  safeTop,
  defaultHeaderHeight,
  defaultBottomOffset,
}: {
  /** 状态栏安全区，由 Shell 只计算一次。 */
  safeTop: number;
  /** 没有页面锚点时的统一标题栏高度（ScreenHeader / AppBar 均为 56dp）。 */
  defaultHeaderHeight: number;
  /** 没有页面底部锚点时的默认底部避让值（含 TabBar / 登记操作区 / 手势区）。 */
  defaultBottomOffset: number;
}) {
  const { tokens, scheme } = useTheme();
  const reduceMotion = useReduceMotion();
  const keyboardHeight = useKeyboardHeight();
  const state = useToastState();
  const { dismissToast } = useToast();
  const pageLayout = useActiveToastLayout();
  const current = state.current;

  const [visible, setVisible] = useState<ToastItem | null>(current);
  const opacity = useRef(new Animated.Value(0)).current;
  const closing = useRef<number | null>(null);
  const lastId = useRef<number | null>(null);
  const lastRev = useRef(-1);

  const hide = useCallback(
    (id: number) => {
      if (closing.current === id) return;
      closing.current = id;
      if (reduceMotion) {
        dismissToast(id);
        return;
      }
      Animated.timing(opacity, {
        toValue: 0,
        duration: duration.fast,
        easing: easeOut,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && closing.current === id) dismissToast(id);
      });
    },
    [dismissToast, opacity, reduceMotion],
  );

  useEffect(() => {
    if (!current) {
      setVisible(null);
      opacity.setValue(0);
      lastId.current = null;
      return;
    }

    setVisible(current);
    const previous =
      lastId.current === null ? null : { id: lastId.current, rev: lastRev.current };
    const transition = toastTransition(previous, current);
    lastId.current = current.id;
    lastRev.current = current.rev;
    if (transition === "enter") {
      closing.current = null;
      if (reduceMotion) {
        opacity.setValue(1);
      } else {
        // 新消息必须先停掉上一条的退场动画，避免旧动画把新内容淡出。
        opacity.stopAnimation();
        opacity.setValue(0);
        Animated.timing(opacity, {
          toValue: 1,
          duration: duration.base,
          easing: easeOut,
          useNativeDriver: true,
        }).start();
      }
    } else if (transition === "refresh") {
      // 同文案重复触发：只重置计时，不重播入场动画。
      // 若旧计时器已经开始退场，必须停掉它并把透明度拉回 1，否则旧回调会把刷新后的消息关掉。
      closing.current = null;
      opacity.stopAnimation();
      opacity.setValue(1);
    }

    const timer = setTimeout(() => hide(current.id), current.durationMs);
    return () => clearTimeout(timer);
  }, [current, hide, opacity, reduceMotion]);

  if (!visible) return null;

  const atTop = (visible.placement ?? pageLayout.defaultPlacement ?? "top") === "top";
  const topOffset = resolveToastTopOffset({
    safeTop,
    layout: pageLayout,
    defaultHeaderHeight,
    gap: space.sm,
  });
  const bottom = resolveToastBottomOffset({
    keyboardHeight,
    layout: pageLayout,
    defaultBottomOffset,
    gap: space.sm,
  });
  const toneColor =
    visible.tone === "danger"
      ? tokens.danger
      : visible.tone === "warn"
        ? tokens.warn
        : visible.tone === "success"
          ? tokens.ok
          : tokens.accentText;
  const toneSoft =
    visible.tone === "danger"
      ? tokens.dangerSoft
      : visible.tone === "warn"
        ? tokens.warnSoft
        : visible.tone === "success"
          ? tokens.okSoft
          : tokens.accentSoft;

  return (
    <View pointerEvents="box-none" style={styles.host} accessibilityElementsHidden={false}>
      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.card,
          atTop ? { top: topOffset } : { bottom },
          {
            backgroundColor: tokens.sheet,
            borderColor: tokens.cardBorder,
            opacity,
            transform: [
              {
                translateY: opacity.interpolate({
                  inputRange: [0, 1],
                  outputRange: [atTop ? -8 : 8, 0],
                }),
              },
            ],
          },
          cardShadow(scheme),
        ]}
      >
        <View style={[styles.bar, { backgroundColor: toneColor }]} />
        <View style={[styles.iconWrap, { backgroundColor: toneSoft }]}>
          <AppIcon name={TONE_ICON[visible.tone]} color={toneColor} size={18} />
        </View>
        <Text
          numberOfLines={3}
          ellipsizeMode="tail"
          accessibilityRole={visible.tone === "danger" ? "alert" : "text"}
          accessibilityLiveRegion={visible.tone === "danger" ? "assertive" : "polite"}
          accessibilityLabel={visible.text}
          style={[styles.text, { color: tokens.text }]}
        >
          {visible.text}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭提示"
          hitSlop={8}
          onPress={() => hide(visible.id)}
          style={({ pressed }) => [styles.close, { opacity: pressed ? 0.55 : 1 }]}
        >
          <AppIcon name="close" color={tokens.muted} size={16} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  card: {
    position: "absolute",
    left: space.lg,
    right: space.lg,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    paddingLeft: space.md,
    paddingRight: space.xs,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bar: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 2,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    flex: 1,
    fontSize: font.body,
    lineHeight: 20,
    fontWeight: "500",
  },
  close: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
