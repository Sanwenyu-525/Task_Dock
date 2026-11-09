// 状态胶囊：状态点 + 文案（通知权限「已允许」、同步「在线/离线」共用）。
// tone 决定点与文字颜色，底色用对应 soft token 保证两套主题都可读。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export type StatusTone = "ok" | "warn" | "danger" | "neutral";

export function StatusPill({ label, tone }: { label: string; tone: StatusTone }) {
  const { tokens } = useTheme();
  const color =
    tone === "ok"
      ? tokens.ok
      : tone === "warn"
        ? tokens.warn
        : tone === "danger"
          ? tokens.danger
          : tokens.muted;
  const background =
    tone === "ok"
      ? tokens.okSoft
      : tone === "warn"
        ? tokens.warnSoft
        : tone === "danger"
          ? tokens.dangerSoft
          : tokens.track;

  return (
    <View accessibilityRole="text" style={[styles.pill, { backgroundColor: background }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text numberOfLines={1} style={[styles.label, { color }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.chip,
    flexShrink: 1,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  label: {
    flexShrink: 1,
    fontSize: font.label,
    fontWeight: "600",
  },
});
