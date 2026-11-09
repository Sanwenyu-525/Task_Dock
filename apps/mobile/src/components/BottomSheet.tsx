// 底部弹层基座：遮罩渐入 + 面板 spring 上滑，关闭时反向播放再卸载 Modal。
// 所有弹层共用，保证「一个应用只有一种弹层手感」；减少动态效果时直接呈现。
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";

import {
  duration,
  easeOut,
  sheetSpring,
  useReduceMotion,
} from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { floatingShadow } from "../theme/shadows";
import { radius, space } from "../theme/tokens";
import { useWindowInsets } from "../lib/insets";
import { useKeyboardHeight } from "../lib/keyboard";

const TRAVEL = 72;

export function BottomSheet({
  visible,
  onRequestClose,
  children,
  keyboardAware = false,
  maxHeightRatio = 0.86,
  accessibilityLabel,
}: {
  visible: boolean;
  onRequestClose: () => void;
  children: ReactNode;
  /** 编辑类弹层需要跟随键盘收缩，纯动作表不需要 */
  keyboardAware?: boolean;
  /** 内容最高占屏比例，避免长列表把标题顶出屏幕 */
  maxHeightRatio?: number;
  accessibilityLabel: string;
}) {
  const { tokens, scheme } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useWindowInsets();
  const [mounted, setMounted] = useState(visible);
  /**
   * 键盘高度自己听：这个 Modal 窗口不吃 adjustResize，KeyboardAvoidingView 的
   * height 行为在真机（Android 16）上实测无效——面板会被键盘整个盖住。
   * 直接按键盘高度给容器加下内边距，位移是确定的，不依赖系统窗口行为。
   * 实现统一收敛在 lib/keyboard.ts（笔记编辑器与分享页共用同一份）。
   */
  const keyboardHeight = useKeyboardHeight(keyboardAware);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (reduceMotion) {
        progress.setValue(1);
        return;
      }
      const animation = Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        ...sheetSpring,
      });
      animation.start();
      return () => animation.stop();
    }

    if (reduceMotion) {
      progress.setValue(0);
      setMounted(false);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 0,
      duration: duration.fast,
      easing: easeOut,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, reduceMotion, progress]);

  if (!mounted) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [TRAVEL, 0],
  });

  const panel = (
    <Animated.View
      accessibilityViewIsModal
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility="yes"
      style={[
        styles.panel,
        {
          backgroundColor: tokens.sheet,
          borderColor: tokens.cardBorder,
          paddingBottom: Math.max(insets.bottom, space.md) + space.md,
          maxHeight: `${Math.round(maxHeightRatio * 100)}%`,
          transform: [{ translateY }],
        },
        floatingShadow(scheme),
      ]}
    >
      <View
        pointerEvents="none"
        style={[styles.grabber, { backgroundColor: tokens.track }]}
      />
      {children}
    </Animated.View>
  );

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onRequestClose}
    >
      <View style={styles.root}>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: tokens.overlay, opacity: progress },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭弹层"
          onPress={onRequestClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[styles.avoider, { paddingBottom: keyboardAware ? keyboardHeight : 0 }]}
          pointerEvents="box-none"
        >
          {panel}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  avoider: {
    flex: 1,
    justifyContent: "flex-end",
  },
  panel: {
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: space.md,
  },
});
