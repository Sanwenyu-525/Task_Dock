// 底部弹层基座：遮罩渐入 + 面板 spring 上滑，关闭时反向播放再卸载 Modal。
// 所有弹层共用，保证「一个应用只有一种弹层手感」；减少动态效果时直接呈现。
//
// 拖拽关闭（2026-11-17 统一整改）：顶部 48dp 的拖拽条是唯一手势来源，
// 只吃「向下滑动」，不会抢占面板内 ScrollView 的滚动；位移超过阈值或速度足够快
// 才关闭，其余情况弹回原位。遮罩点击与 Android 返回键行为保持不变。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Modal,
  PanResponder,
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
import { shouldCaptureSheetDrag, shouldDismissSheet } from "../lib/sheetDismiss";

const TRAVEL = 72;
/** 拖拽条触摸高度：48dp（≥44dp 最小可操作尺寸），明显大于视觉横线 */
const DRAG_ZONE_HEIGHT = 48;

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
  /**
   * 手动拖拽位移：与进场/退场动画叠加。
   * 关闭时保留当前位移，让面板从手指位置继续下滑，而不是先弹回再收起。
   * 每次重新打开时归零。
   */
  const dragY = useRef(new Animated.Value(0)).current;
  // 用 ref 持有最新的关闭回调：PanResponder 只在挂载时创建一次，避免手势中途换实例
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;

  const panResponder = useMemo(() => {
    const settle = () => {
      if (reduceMotion) {
        dragY.setValue(0);
        return;
      }
      Animated.spring(dragY, {
        toValue: 0,
        useNativeDriver: true,
        ...sheetSpring,
      }).start();
    };
    return PanResponder.create({
      // 按下不抢手势：拖拽条上的普通点按不应该产生"开始拖拽"的假反馈
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        shouldCaptureSheetDrag(gesture.dy, gesture.dx),
      onPanResponderMove: (_event, gesture) => {
        // 只允许向下拖：向上拖动没有对应语义，硬顶会把面板拉出屏幕
        dragY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: (_event, gesture) => {
        if (shouldDismissSheet(gesture.dy, gesture.vy)) {
          closeRef.current();
          return;
        }
        settle();
      },
      onPanResponderTerminate: settle,
    });
  }, [dragY, reduceMotion]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // 关闭后再次打开必须从 0 开始：上一轮拖拽的位移不能带到新的一轮
      dragY.setValue(0);
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
  }, [visible, reduceMotion, progress, dragY]);

  if (!mounted) return null;

  const translateY = Animated.add(
    progress.interpolate({
      inputRange: [0, 1],
      outputRange: [TRAVEL, 0],
    }),
    dragY,
  );

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
      {/* 拖拽关闭区：48dp 触摸高度，包含视觉横线；面板内容在它下面，不与内部滚动争抢手势 */}
      <View {...panResponder.panHandlers} style={styles.grabZone}>
        <View pointerEvents="none" style={[styles.grabber, { backgroundColor: tokens.track }]} />
      </View>
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
    // 顶部留白交给拖拽区自己承担（48dp），既保证触摸范围，也不把内容顶得太低
    paddingTop: 0,
  },
  grabZone: {
    height: DRAG_ZONE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
});
