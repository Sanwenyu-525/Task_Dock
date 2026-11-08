// 需要「按下去有回弹」的按钮（FAB、主操作）统一走这里。
// 动画只做 transform，走 native driver；系统开启减少动态效果时直接不缩放。
import { useCallback, useRef, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  type Insets,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useReduceMotion } from "../theme/MotionProvider";

export function PressableScale({
  children,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = "button",
  accessibilityState,
  disabled = false,
  style,
  contentStyle,
  scaleTo = 0.96,
  hitSlop,
}: {
  children: ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityRole?: "button" | "link" | "tab";
  accessibilityState?: { disabled?: boolean; selected?: boolean };
  disabled?: boolean;
  /** 作用于 Pressable：定位、外边距等布局属性 */
  style?: StyleProp<ViewStyle>;
  /** 作用于内层 Animated.View：背景、圆角、内边距等视觉属性 */
  contentStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
  hitSlop?: Insets;
}) {
  const reduceMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;

  const pressIn = useCallback(() => {
    if (reduceMotion || disabled) return;
    Animated.spring(scale, {
      toValue: scaleTo,
      useNativeDriver: true,
      damping: 18,
      stiffness: 320,
      mass: 0.6,
    }).start();
  }, [disabled, reduceMotion, scale, scaleTo]);

  const pressOut = useCallback(() => {
    if (reduceMotion || disabled) {
      scale.setValue(1);
      return;
    }
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      damping: 16,
      stiffness: 260,
      mass: 0.6,
    }).start();
  }, [disabled, reduceMotion, scale]);

  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState ?? { disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      hitSlop={hitSlop}
      style={style}
    >
      <Animated.View
        style={[
          contentStyle,
          { transform: [{ scale }] },
          disabled ? { opacity: 0.45 } : null,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
