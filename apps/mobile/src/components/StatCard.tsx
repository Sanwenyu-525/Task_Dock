// 统计卡：白卡 + 标签在上、数值在下（对齐页面原型）。
// 0 值一律退回中性色，只有真正需要关注的数量才上色——避免整片统计条一直飘红。
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

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
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? `${label} ${value} 项`}
      style={[
        styles.card,
        { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
        style,
      ]}
    >
      <Text numberOfLines={1} style={[styles.label, { color: tokens.muted }]}>
        {label}
      </Text>
      <Text numberOfLines={1} style={[styles.value, { color }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexShrink: 1,
    // basis 0 让四张卡严格均分，避免内容宽度略超时最后一张被 flexWrap 挤到下一行
    flexBasis: 0,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: 2,
  },
  label: {
    flexShrink: 1,
    fontSize: font.label,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  value: {
    fontSize: font.stat,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.6,
    lineHeight: font.stat + 7,
  },
});
