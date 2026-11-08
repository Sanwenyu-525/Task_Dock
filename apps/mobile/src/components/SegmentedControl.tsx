// 通用分段控件：选中块会滑动到目标位置，避免切换主题时整块闪烁。
// 选项内容由调用方渲染（设置页用它放主题预览），组件只负责轨道、指示器与无障碍语义。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  renderSegment,
  accessibilityLabel,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  renderSegment?: (option: SegmentOption<T>, selected: boolean) => ReactNode;
  accessibilityLabel: string;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const position = useRef(new Animated.Value(index)).current;

  useEffect(() => {
    if (reduceMotion) {
      position.setValue(index);
      return;
    }
    const animation = Animated.spring(position, {
      toValue: index,
      useNativeDriver: true,
      damping: 24,
      stiffness: 280,
      mass: 0.85,
    });
    animation.start();
    return () => animation.stop();
  }, [index, position, reduceMotion]);

  const innerWidth = Math.max(0, trackWidth - space.sm);
  const segmentWidth = options.length > 0 ? innerWidth / options.length : 0;

  const indicatorStyle = useMemo(
    () => ({
      width: segmentWidth,
      transform: [{ translateX: Animated.multiply(position, segmentWidth) }],
    }),
    [position, segmentWidth],
  );

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: tokens.track, borderColor: tokens.cardBorder }]}
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            {
              backgroundColor: tokens.cardSolid,
              borderColor: tokens.accentSoft,
            },
            indicatorStyle,
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.segment, { opacity: pressed ? 0.7 : 1 }]}
          >
            {renderSegment ? (
              renderSegment(option, selected)
            ) : (
              <Text
                style={[
                  styles.label,
                  { color: selected ? tokens.accent : tokens.muted },
                  selected ? styles.labelActive : null,
                ]}
              >
                {option.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    padding: space.xs,
    borderRadius: radius.control + 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  indicator: {
    position: "absolute",
    top: space.xs,
    bottom: space.xs,
    left: space.xs,
    borderRadius: radius.control,
    borderWidth: 1,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
  },
  label: {
    fontSize: font.meta,
    fontWeight: "600",
  },
  labelActive: {
    fontWeight: "700",
  },
});
