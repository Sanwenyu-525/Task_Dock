// 筛选/选项芯片：选中态用背景色与文字色的插值过渡，避免整块瞬间跳变。
// 底色用 accentFill 而不是 accent：胶囊里是白字，必须守住 4.5:1。
import { useEffect, useMemo, useRef } from "react";
import { Animated, Pressable, StyleSheet } from "react-native";

import { duration, easeOut, useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export function Chip({
  label,
  active,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(active ? 1 : 0);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: active ? 1 : 0,
      duration: duration.fast,
      easing: easeOut,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [active, progress, reduceMotion]);

  const background = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [tokens.track, tokens.accentFill],
      }),
    [progress, tokens.accentFill, tokens.track],
  );
  const border = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [tokens.cardBorder, tokens.accentFill],
      }),
    [progress, tokens.accentFill, tokens.cardBorder],
  );
  const color = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: [tokens.textSoft, tokens.onAccent],
      }),
    [progress, tokens.onAccent, tokens.textSoft],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      // 芯片本体 34dp，靠上下各 5dp 的 hitSlop 补到 44dp 命中区
      hitSlop={{ top: 5, bottom: 5, left: 2, right: 2 }}
      style={({ pressed }) => [styles.press, { opacity: disabled ? 0.45 : pressed ? 0.82 : 1 }]}
    >
      <Animated.View style={[styles.chip, { backgroundColor: background, borderColor: border }]}>
        <Animated.Text style={[styles.label, { color }]} numberOfLines={1}>
          {label}
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  press: {
    alignSelf: "flex-start",
  },
  chip: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    fontSize: font.meta,
    fontWeight: "600",
    lineHeight: font.meta + 5,
  },
});
