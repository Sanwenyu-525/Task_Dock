// 指标磁贴：小图标 → 数字 → 标签。
//
// variant="stat"：首页效率概览的三张独立统计卡（白卡 + 语义色图标底板）。
// variant="column"：只渲染列内容，由调用方放进同一张卡（设置统计）。
// variant="card"：保留给单张统计卡，当前无调用方。
// 只接收真实统计值，不内置任何示例数据。
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { GlassCard } from "./GlassCard";
import { AppIcon, type IconName } from "./icons/AppIcon";

type MetricTone = "neutral" | "accent" | "alt" | "warn" | "ok";

export function MetricTile({
  value,
  label,
  icon,
  tone = "neutral",
  variant = "card",
  style,
}: {
  value: number;
  label: string;
  /** 语义图标；没有合适语义时可以不传，只显示数字与标签 */
  icon?: IconName;
  tone?: MetricTone;
  variant?: "card" | "column" | "stat";
  style?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();
  const toneColor =
    tone === "warn"
      ? tokens.warn
      : tone === "ok"
        ? tokens.ok
        : tone === "accent" || tone === "alt"
          ? tokens.accentText
          : tokens.text;
  // 0 值不染色：没有事情的指标不该用强调色喊人
  const color = value > 0 ? toneColor : tokens.textSoft;
  const iconColor =
    value <= 0
      ? tokens.faint
      : tone === "ok"
        ? tokens.ok
        : tone === "warn"
          ? tokens.warn
          : tone === "accent" || tone === "alt"
            ? tokens.accent
            : tokens.muted;
  const iconBackground =
    tone === "ok"
      ? tokens.okSoft
      : tone === "warn"
        ? tokens.warnSoft
        : tone === "accent"
          ? tokens.accentSoft
          : tone === "alt"
            ? tokens.accentAltSoft
            : tokens.track;

  if (variant === "stat") {
    return (
      <GlassCard style={[styles.statCard, style]}>
        {icon ? (
          <View style={[styles.statIcon, { backgroundColor: iconBackground }]}>
            <AppIcon name={icon} color={iconColor} size={17} />
          </View>
        ) : null}
        <Text numberOfLines={1} style={[styles.statValue, { color: tokens.text }]}>
          {value}
        </Text>
        <Text numberOfLines={1} style={[styles.label, { color: tokens.muted }]}>
          {label}
        </Text>
      </GlassCard>
    );
  }

  const inner = (
    <View style={[styles.inner, variant === "column" ? styles.innerColumn : null]}>
      {icon ? <AppIcon name={icon} color={iconColor} size={18} style={styles.icon} /> : null}
      <Text numberOfLines={1} style={[styles.value, { color }]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={[styles.label, { color: tokens.muted }]}>
        {label}
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
  statCard: {
    flex: 1,
    minHeight: 106,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: 2,
  },
  statIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
  statValue: {
    fontSize: font.stat,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
    lineHeight: font.stat + 5,
  },
  inner: {
    paddingHorizontal: space.md,
    paddingTop: 10,
    paddingBottom: space.sm,
    gap: 1,
  },
  innerColumn: {
    alignItems: "flex-start",
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.sm,
    gap: 1,
  },
  icon: {
    marginBottom: 3,
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
