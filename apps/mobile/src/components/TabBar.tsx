// 底部标签栏：蓝青专业版五栏（首页 / 任务 / 工作区 / 工具 / 我的）。
// 选中态 = 浅蓝滑动胶囊 + 蓝色图标与文字；未选中 = 蓝灰线性图标。
// 图标统一走 AppIcon（与全站同一套 lucide 几何），点击区 ≥ 54dp，尊重系统减少动画设置。
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import type { TabKey } from "../lib/nav";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { barShadow } from "../theme/shadows";
import { font, radius, space } from "../theme/tokens";

import { AppIcon, type IconName } from "./icons/AppIcon";

export type { TabKey };

const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: "home", label: "首页", icon: "home" },
  { key: "tasks", label: "任务", icon: "tasks" },
  { key: "workspace", label: "工作区", icon: "workspace" },
  { key: "tools", label: "工具", icon: "tools" },
  { key: "profile", label: "我的", icon: "profile" },
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
  const { tokens, scheme } = useTheme();
  const reduceMotion = useReduceMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const activeIndex = TABS.findIndex((tab) => tab.key === active);
  const position = useRef(new Animated.Value(Math.max(0, activeIndex))).current;

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
                <AppIcon name={tab.icon} color={color} size={22} />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.label,
                    { color },
                    selected ? styles.labelActive : null,
                    selected ? { color: tokens.accentText } : null,
                  ]}
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
  label: {
    fontSize: font.tab,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  labelActive: {
    fontWeight: "700",
  },
});
