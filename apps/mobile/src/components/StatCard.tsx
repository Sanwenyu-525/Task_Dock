// 统计卡：数值是主角（24/700 + tabular-nums），标签退为 11dp 次级信息。
// 320dp 窄屏由父级改成 2×2，本组件只保证自身在任意给定宽度下不换行、不溢出。
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";

export type StatTone = "neutral" | "accent" | "warn" | "danger" | "ok";

export function StatCard({
  label,
  value,
  tone = "neutral",
  accessibilityLabel,
  style,
}: {
  label: string;
  value: number;
  tone?: StatTone;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();
  const color =
    tone === "warn"
      ? tokens.warn
      : tone === "ok"
        ? tokens.ok
        : tone === "accent"
          ? tokens.accent
          : tone === "danger"
            ? tokens.danger
            : tokens.text;

  return (
    <GlassCard
      style={[styles.card, style]}
      accessibilityLabel={accessibilityLabel ?? `${label} ${value} 项`}
    >
      <View style={styles.row}>
        <Text numberOfLines={1} style={[styles.label, { color: tokens.muted }]}>
          {label}
        </Text>
        <View
          importantForAccessibility="no"
          style={[styles.dot, { backgroundColor: tone === "neutral" ? tokens.faint : color }]}
        />
      </View>
      <Text numberOfLines={1} style={[styles.value, { color }]}>
        {value}
      </Text>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexShrink: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.xs,
  },
  label: {
    flexShrink: 1,
    fontSize: font.label,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  value: {
    fontSize: font.stat,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.4,
    lineHeight: font.stat + 6,
  },
});
