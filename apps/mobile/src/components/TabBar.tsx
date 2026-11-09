// 底部标签栏：选中态用一块会滑动的玻璃胶囊表达，避免每次切换都「闪一下」。
// 图标用基础 View 画出（同一 1.5dp 线重），不依赖图标库，也不让 Unicode 字形
// 在不同 ROM 上被渲染成彩色 emoji；点击区 ≥ 52dp。
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { barShadow } from "../theme/shadows";
import { font, radius, space } from "../theme/tokens";

export type TabKey = "tasks" | "inbox" | "notes" | "settings";

const TABS: { key: TabKey; label: string }[] = [
  { key: "tasks", label: "任务" },
  { key: "inbox", label: "收集箱" },
  { key: "notes", label: "笔记" },
  { key: "settings", label: "设置" },
];

/** 线重统一用 1.5，与 hairline 边框形成同一套笔触 */
const STROKE = 1.5;

function TabIcon({ tab, color }: { tab: TabKey; color: string }) {
  if (tab === "tasks") {
    return (
      <View style={[styles.iconBox, styles.listIcon]}>
        <View style={[styles.iconLine, { width: 15, backgroundColor: color }]} />
        <View style={[styles.iconLine, { width: 15, backgroundColor: color }]} />
        <View style={[styles.iconLine, { width: 9, backgroundColor: color }]} />
      </View>
    );
  }

  if (tab === "inbox") {
    return (
      <View style={styles.iconBox}>
        {/* 两张叠放的卡片：一张后置低透明，读作「收集起来的东西」 */}
        <View
          style={[
            styles.cardBack,
            { borderColor: color, opacity: 0.45 },
          ]}
        />
        <View style={[styles.cardFront, { borderColor: color }]} />
      </View>
    );
  }

  if (tab === "notes") {
    return (
      <View style={styles.iconBox}>
        {/* 一页纸：带折角的文档轮廓 + 两行文字线 */}
        <View style={[styles.noteSheet, { borderColor: color }]} />
        <View style={[styles.noteLine, styles.noteLineShort, { backgroundColor: color }]} />
        <View style={[styles.noteLine, styles.noteLineLong, { backgroundColor: color }]} />
      </View>
    );
  }

  return (
    <View style={[styles.iconBox, styles.sliders]}>
      <View style={styles.sliderRow}>
        <View style={[styles.sliderLine, { width: 4, backgroundColor: color }]} />
        <View style={[styles.sliderKnob, { backgroundColor: color }]} />
        <View style={[styles.sliderLine, styles.sliderLineGrow, { backgroundColor: color }]} />
      </View>
      <View style={styles.sliderRow}>
        <View style={[styles.sliderLine, styles.sliderLineGrow, { backgroundColor: color }]} />
        <View style={[styles.sliderKnob, { backgroundColor: color }]} />
        <View style={[styles.sliderLine, { width: 4, backgroundColor: color }]} />
      </View>
    </View>
  );
}

export function TabBar({
  active,
  onChange,
  bottomInset,
}: {
  active: TabKey;
  onChange: (key: TabKey) => void;
  bottomInset: number;
}) {
  const { tokens, scheme } = useTheme();
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
    <View style={[styles.host, { paddingBottom: Math.max(bottomInset, space.sm) }]}>
      <View
        style={[
          styles.bar,
          { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
          barShadow(scheme),
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
              style={[styles.indicator, { backgroundColor: tokens.accentSoft }, indicatorStyle]}
            />
          ) : null}
          {TABS.map((tab) => {
            const selected = tab.key === active;
            const color = selected ? tokens.accent : tokens.muted;
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
                <TabIcon tab={tab.key} color={color} />
                <Text
                  numberOfLines={1}
                  style={[styles.label, { color }, selected ? styles.labelActive : null]}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    paddingHorizontal: space.md,
    paddingTop: space.xs,
  },
  bar: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xs,
  },
  track: {
    flexDirection: "row",
    borderRadius: radius.row,
  },
  indicator: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: radius.row,
  },
  item: {
    flex: 1,
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  iconBox: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  iconLine: {
    height: STROKE,
    borderRadius: 1,
    marginVertical: 1.75,
  },
  listIcon: {
    alignItems: "flex-start",
    paddingLeft: 1.5,
  },
  cardBack: {
    position: "absolute",
    left: 4.5,
    top: 1.5,
    width: 10,
    height: 12,
    borderRadius: 2.5,
    borderWidth: STROKE,
  },
  cardFront: {
    position: "absolute",
    left: 2.5,
    top: 4.5,
    width: 13,
    height: 11,
    borderRadius: 2.5,
    borderWidth: STROKE,
  },
  noteSheet: {
    position: "absolute",
    left: 3,
    top: 1.5,
    width: 12,
    height: 15,
    borderRadius: 2.5,
    borderWidth: STROKE,
  },
  noteLine: {
    position: "absolute",
    height: STROKE,
    borderRadius: 1,
  },
  noteLineShort: {
    top: 6,
    left: 6,
    width: 6,
  },
  noteLineLong: {
    top: 9.5,
    left: 6,
    width: 6,
  },
  sliders: {
    justifyContent: "center",
    gap: 5,
  },
  sliderRow: {
    width: 15,
    height: 4.5,
    flexDirection: "row",
    alignItems: "center",
    gap: 1.5,
  },
  sliderLine: {
    height: STROKE,
    borderRadius: 1,
  },
  sliderLineGrow: {
    flex: 1,
  },
  sliderKnob: {
    width: 4.5,
    height: 4.5,
    borderRadius: 2.5,
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
