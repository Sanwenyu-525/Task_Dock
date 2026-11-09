// 推送页顶栏：返回箭头 + 标题 + 右侧动作插槽。
// 返回箭头用 View 绘制（与 TabBar/FAB 同一套笔触），热区 44dp。
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

const STROKE = 1.5;

export function AppBar({
  title,
  badge,
  onBack,
  right,
}: {
  title: string;
  badge?: ReactNode;
  onBack: () => void;
  right?: ReactNode;
}) {
  const { tokens } = useTheme();

  return (
    <View style={[styles.bar, { borderColor: tokens.separator }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回"
        onPress={onBack}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        style={({ pressed }) => [styles.back, { opacity: pressed ? 0.6 : 1 }]}
      >
        {/* 箭头 = 一段横杆 + 两根 45° 斜线组成箭头 */}
        <View style={styles.arrow}>
          <View style={[styles.shaft, { backgroundColor: tokens.text }]} />
          <View
            style={[
              styles.head,
              styles.headTop,
              { backgroundColor: tokens.text },
            ]}
          />
          <View
            style={[
              styles.head,
              styles.headBottom,
              { backgroundColor: tokens.text },
            ]}
          />
        </View>
      </Pressable>

      <Text numberOfLines={1} accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
        {title}
      </Text>
      {badge}

      <View style={styles.right}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginRight: space.xs,
  },
  arrow: {
    width: 20,
    height: 20,
    justifyContent: "center",
  },
  shaft: {
    width: 14,
    height: STROKE,
    borderRadius: STROKE / 2,
  },
  head: {
    position: "absolute",
    width: 9,
    height: STROKE,
    borderRadius: STROKE / 2,
    left: 0,
  },
  headTop: {
    transform: [{ rotate: "45deg" }, { translateX: 3.2 }],
  },
  headBottom: {
    transform: [{ rotate: "-45deg" }, { translateX: 3.2 }],
  },
  title: {
    flexShrink: 1,
    fontSize: font.title,
    fontWeight: "600",
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    marginLeft: "auto",
  },
});
