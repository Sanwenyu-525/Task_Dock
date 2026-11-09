// 底部标签栏：选中态用一块会滑动的玻璃胶囊表达，避免每次切换都「闪一下」。
// 图标用基础 View 画出（同一 1.5dp 线重），不依赖图标库，也不让 Unicode 字形
// 在不同 ROM 上被渲染成彩色 emoji；点击区 ≥ 52dp。
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { barShadow } from "../theme/shadows";
import { font, radius, space } from "../theme/tokens";

export type TabKey = "tasks" | "inbox" | "notes" | "device" | "settings";

const TABS: { key: TabKey; label: string }[] = [
  { key: "tasks", label: "任务" },
  { key: "inbox", label: "收集箱" },
  { key: "notes", label: "笔记" },
  { key: "device", label: "设备" },
  { key: "settings", label: "设置" },
];

/** 图标按原型 22dp（Material Symbols）绘制；线重约 1.8，与 22dp 视觉比例一致 */
const STROKE = 1.8;

/** 齿轮 8 个齿的角度；齿块按角度旋转并沿半径摆放 */
const GEAR_TEETH = [0, 45, 90, 135, 180, 225, 270, 315];

function TabIcon({ tab, color }: { tab: TabKey; color: string }) {
  if (tab === "tasks") {
    // 勾选圆：始终描边，选中只换成 accent 色（原型的 check_circle，不是实心）
    return (
      <View style={styles.iconBox}>
        <View style={[styles.checkRing, { borderColor: color }]} />
        <View style={[styles.checkTickShort, { backgroundColor: color }]} />
        <View style={[styles.checkTickLong, { backgroundColor: color }]} />
      </View>
    );
  }

  if (tab === "inbox") {
    // 收件箱：近正方形外框 + 底部托盘线与 U 形开口（Material Symbols inbox）
    return (
      <View style={styles.iconBox}>
        <View style={[styles.inboxBox, { borderColor: color }]} />
        <View style={[styles.inboxTrayLeft, { backgroundColor: color }]} />
        <View style={[styles.inboxTrayRight, { backgroundColor: color }]} />
        <View style={[styles.inboxDipLeft, { backgroundColor: color }]} />
        <View style={[styles.inboxDipBottom, { backgroundColor: color }]} />
        <View style={[styles.inboxDipRight, { backgroundColor: color }]} />
      </View>
    );
  }

  if (tab === "notes") {
    return (
      <View style={styles.iconBox}>
        {/* 一页纸：带折角的文档轮廓 + 两行文字线（description） */}
        <View style={[styles.noteSheet, { borderColor: color }]} />
        <View style={[styles.noteFold, { backgroundColor: color }]} />
        <View style={[styles.noteLine, styles.noteLineShort, { backgroundColor: color }]} />
        <View style={[styles.noteLine, styles.noteLineLong, { backgroundColor: color }]} />
      </View>
    );
  }

  if (tab === "device") {
    // 设备：手机 + 桌面显示器并排，表达「与电脑连接/互传」。
    return (
      <View style={styles.iconBox}>
        <View style={[styles.devicePhone, { borderColor: color }]} />
        <View style={[styles.deviceHome, { backgroundColor: color }]} />
        <View style={[styles.deviceScreen, { borderColor: color }]} />
        <View style={[styles.deviceBase, { backgroundColor: color }]} />
      </View>
    );
  }

  // 设置：齿轮（圆环 + 8 个齿）
  return (
    <View style={styles.iconBox}>
      <View style={[styles.gearRing, { borderColor: color }]} />
      {GEAR_TEETH.map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <View
            key={deg}
            style={[
              styles.gearTooth,
              {
                backgroundColor: color,
                left: 11 + 8.3 * Math.cos(rad) - 1.8,
                top: 11 + 8.3 * Math.sin(rad) - 1.8,
                transform: [{ rotate: `${deg}deg` }],
              },
            ]}
          />
        );
      })}
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
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  checkRing: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: STROKE,
  },
  checkTickShort: {
    position: "absolute",
    width: 5.1,
    height: STROKE,
    borderRadius: 1,
    left: 5.35,
    top: 12.2,
    transform: [{ rotate: "44deg" }],
  },
  checkTickLong: {
    position: "absolute",
    width: 9.5,
    height: STROKE,
    borderRadius: 1,
    left: 8.15,
    top: 10.3,
    transform: [{ rotate: "-45deg" }],
  },
  inboxBox: {
    position: "absolute",
    left: 1.5,
    top: 1.5,
    width: 19,
    height: 19,
    borderRadius: 3,
    borderWidth: STROKE,
  },
  inboxTrayLeft: {
    position: "absolute",
    left: 2.2,
    top: 13.6,
    width: 5.4,
    height: STROKE,
    borderRadius: 1,
  },
  inboxTrayRight: {
    position: "absolute",
    left: 14.4,
    top: 13.6,
    width: 5.4,
    height: STROKE,
    borderRadius: 1,
  },
  inboxDipLeft: {
    position: "absolute",
    left: 6.85,
    top: 14.85,
    width: 2.8,
    height: STROKE,
    borderRadius: 1,
    transform: [{ rotate: "62deg" }],
  },
  inboxDipBottom: {
    position: "absolute",
    left: 8.7,
    top: 16.5,
    width: 4.6,
    height: STROKE,
    borderRadius: 1,
  },
  inboxDipRight: {
    position: "absolute",
    left: 12.35,
    top: 14.85,
    width: 2.8,
    height: STROKE,
    borderRadius: 1,
    transform: [{ rotate: "-62deg" }],
  },
  noteSheet: {
    position: "absolute",
    left: 3.75,
    top: 2,
    width: 14.5,
    height: 18,
    borderRadius: 3,
    borderWidth: STROKE,
  },
  noteFold: {
    position: "absolute",
    left: 11.7,
    top: 3.8,
    width: 7.6,
    height: STROKE,
    borderRadius: 1,
    transform: [{ rotate: "45deg" }],
  },
  noteLine: {
    position: "absolute",
    height: STROKE,
    borderRadius: 1,
  },
  noteLineShort: {
    top: 7.3,
    left: 6.2,
    width: 7.3,
  },
  noteLineLong: {
    top: 11.6,
    left: 6.2,
    width: 7.3,
  },
  // 设备图标：左侧手机、右下显示器；两者留 1dp 间隙，22dp 下不会糊成一块。
  devicePhone: {
    position: "absolute",
    left: 1.2,
    top: 2.2,
    width: 7.2,
    height: 14.6,
    borderWidth: 1.7,
    borderRadius: 1.9,
  },
  deviceHome: {
    position: "absolute",
    left: 3,
    top: 14.3,
    width: 3.4,
    height: 1.2,
    borderRadius: 0.6,
  },
  deviceScreen: {
    position: "absolute",
    left: 9.8,
    top: 7.6,
    width: 11,
    height: 7.6,
    borderWidth: 1.7,
    borderRadius: 1.4,
  },
  deviceBase: {
    position: "absolute",
    left: 8.6,
    top: 16.4,
    width: 13.4,
    height: 1.5,
    borderRadius: 0.75,
  },
  gearRing: {
    position: "absolute",
    left: 4.25,
    top: 4.25,
    width: 13.5,
    height: 13.5,
    borderRadius: 6.75,
    borderWidth: 1.9,
  },
  gearTooth: {
    position: "absolute",
    width: 3.6,
    height: 3.6,
    borderRadius: 1,
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
