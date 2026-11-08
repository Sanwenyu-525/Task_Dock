// 底部标签栏：选中态用一块会滑动的玻璃胶囊表达，避免每次切换都「闪一下」。
// 图标沿用现有几何字形，不引入图标库；点击区 ≥ 52dp。
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export type TabKey = "tasks" | "inbox" | "settings";

const TABS: { key: TabKey; label: string; glyph: string }[] = [
  { key: "tasks", label: "任务", glyph: "☰" },
  { key: "inbox", label: "收集箱", glyph: "▤" },
  { key: "settings", label: "设置", glyph: "⚙" },
];

export function TabBar({
  active,
  onChange,
  bottomInset,
}: {
  active: TabKey;
  onChange: (key: TabKey) => void;
  bottomInset: number;
}) {
  const { tokens } = useTheme();
  const reduceMotion = useReduceMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const activeIndex = TABS.findIndex((tab) => tab.key === active);
  const position = useRef(new Animated.Value(activeIndex)).current;

  useEffect(() => {
    if (reduceMotion) {
      position.setValue(activeIndex);
      return;
    }
    const animation = Animated.spring(position, {
      toValue: activeIndex,
      useNativeDriver: true,
      damping: 24,
      stiffness: 280,
      mass: 0.85,
    });
    animation.start();
    return () => animation.stop();
  }, [activeIndex, position, reduceMotion]);

  // 指示器宽度按轨道均分；轨道未测量完成前不渲染，避免 0 宽度的瞬时闪烁
  const segment = trackWidth > 0 ? (trackWidth - space.sm) / TABS.length : 0;
  const indicatorStyle = useMemo(
    () => ({
      width: segment,
      transform: [{ translateX: Animated.multiply(position, segment) }],
    }),
    [position, segment],
  );

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: tokens.bgAccent,
          borderTopColor: tokens.cardBorder,
          paddingBottom: Math.max(bottomInset, space.sm),
        },
      ]}
    >
      <View
        accessibilityRole="tablist"
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        style={styles.track}
      >
        {segment > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.indicator,
              { backgroundColor: tokens.accentSoft, borderColor: tokens.cardBorder },
              indicatorStyle,
            ]}
          />
        ) : null}
        {TABS.map((tab) => {
          const selected = tab.key === active;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityHint={selected ? undefined : `切换到${tab.label}`}
              accessibilityState={{ selected }}
              onPress={() => onChange(tab.key)}
              style={({ pressed }) => [styles.item, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={[styles.glyph, { color: selected ? tokens.accent : tokens.muted }]}>
                {tab.glyph}
              </Text>
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  { color: selected ? tokens.accent : tokens.muted },
                  selected ? styles.labelActive : null,
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.xs,
  },
  track: {
    flexDirection: "row",
    padding: space.xs,
    borderRadius: radius.card,
  },
  indicator: {
    position: "absolute",
    top: space.xs,
    bottom: space.xs,
    left: space.xs,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  item: {
    flex: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  glyph: {
    fontSize: 17,
    lineHeight: 20,
  },
  label: {
    fontSize: font.label,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  labelActive: {
    fontWeight: "700",
  },
});
