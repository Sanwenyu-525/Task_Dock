// 指标磁贴：数字是主体，标签在上、数字在下；不再放装饰图标底板——
// 首页三张卡只需要回答「多少」，多一个 46dp 底板会把统计区抬到和今日专注抢注意力。
// 只接收真实统计值，不内置任何示例数据。
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";

export function MetricTile({
  value,
  label,
  tone = "neutral",
  style,
}: {
  value: number;
  label: string;
  tone?: "neutral" | "accent" | "warn" | "ok";
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

  return (
    <GlassCard style={[styles.card, style]}>
      <View style={styles.inner}>
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
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  },
  inner: {
    paddingHorizontal: space.md,
    paddingTop: 10,
    paddingBottom: space.sm,
    gap: 1,
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
