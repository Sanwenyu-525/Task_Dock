// 指标磁贴：数字是主体，标签在上、数字在下。
//
// variant="card"（默认）：独立白卡，用于确实需要单独成块的场景；
// variant="column"：只渲染列内容，由调用方放进同一张卡（首页效率概览 = 一张卡三段），
// 这样三张统计不再像后台 KPI 组件，320dp 也不会出现 2+1 的尴尬排布。
// 只接收真实统计值，不内置任何示例数据。
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";

export function MetricTile({
  value,
  label,
  tone = "neutral",
  variant = "card",
  style,
}: {
  value: number;
  label: string;
  tone?: "neutral" | "accent" | "warn" | "ok";
  variant?: "card" | "column";
  style?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();
  const toneColor =
    tone === "warn"
      ? tokens.warn
      : tone === "ok"
        ? tokens.ok
        : tone === "accent"
          ? tokens.accentText
          : tokens.text;
  // 0 值不染色：没有事情的指标不该用强调色喊人
  const color = value > 0 ? toneColor : tokens.textSoft;
  const dot = tone === "ok" ? tokens.ok : tone === "warn" ? tokens.warn : tokens.accent;

  const inner = (
    <View style={[styles.inner, variant === "column" ? styles.innerColumn : null]}>
      <View style={styles.labelRow}>
        <View style={[styles.dot, { backgroundColor: value > 0 ? dot : tokens.faint }]} />
        <Text numberOfLines={1} style={[styles.label, { color: tokens.muted }]}>
          {label}
        </Text>
      </View>
      <Text numberOfLines={1} style={[styles.value, { color }]}>
        {value}
      </Text>
    </View>
  );

  if (variant === "column") {
    return <View style={[styles.column, style]}>{inner}</View>;
  }

  return <GlassCard style={[styles.card, style]}>{inner}</GlassCard>;
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  },
  column: {
    flex: 1,
  },
  inner: {
    paddingHorizontal: space.md,
    paddingTop: 10,
    paddingBottom: space.sm,
    gap: 1,
  },
  innerColumn: {
    alignItems: "center",
    paddingHorizontal: space.xs,
    paddingVertical: space.sm,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: radius.chip,
  },
  label: {
    flexShrink: 1,
    fontSize: font.label,
    fontWeight: "600",
  },
  value: {
    fontSize: font.stat,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
    lineHeight: font.stat + 5,
  },
});
