// 统计卡：色块分区而不是四张白卡。
// 0 值一律退回中性底（track），只有真正需要关注的数量才上色——避免整片统计条一直飘红。
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export type StatTone = "neutral" | "accent" | "warn" | "danger" | "ok";

export function StatCard({
  label,
  value,
  tone = "neutral",
  compact = false,
  accessibilityLabel,
  style,
}: {
  label: string;
  value: number;
  tone?: StatTone;
  /** 紧凑形态：数值与标签并排显示，用于四块统计压成一行 */
  compact?: boolean;
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
            : tokens.textSoft;
  const background =
    tone === "warn"
      ? tokens.warnSoft
      : tone === "ok"
        ? tokens.okSoft
        : tone === "accent"
          ? tokens.accentSoft
          : tone === "danger"
            ? tokens.dangerSoft
            : tokens.track;

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? `${label} ${value} 项`}
      style={[styles.card, compact ? styles.compactCard : null, { backgroundColor: background }, style]}
    >
      {compact ? (
        <View style={styles.compactRow}>
          <Text numberOfLines={1} style={[styles.compactValue, { color }]}>
            {value}
          </Text>
          <Text numberOfLines={1} style={[styles.compactLabel, { color: tokens.muted }]}>
            {label}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.row}>
            <Text numberOfLines={1} style={[styles.label, { color: tokens.muted }]}>
              {label}
            </Text>
            <View
              importantForAccessibility="no"
              style={[
                styles.dot,
                { backgroundColor: tone === "neutral" ? tokens.faint : color, opacity: 0.85 },
              ]}
            />
          </View>
          <Text numberOfLines={1} style={[styles.value, { color }]}>
            {value}
          </Text>
        </>
      )}
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
    letterSpacing: 0.3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  value: {
    fontSize: font.stat,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.6,
    lineHeight: font.stat + 7,
  },
  // 紧凑形态：四块并排时每块只有约 76dp 宽，必须去掉上下堆叠与内边距
  compactCard: {
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    gap: 0,
    borderRadius: radius.control,
  },
  compactRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
  },
  compactValue: {
    fontSize: font.title,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.3,
    lineHeight: font.title + 3,
  },
  compactLabel: {
    flexShrink: 1,
    fontSize: font.label,
    fontWeight: "600",
  },
});
