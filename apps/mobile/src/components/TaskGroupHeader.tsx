// 分组头：左侧色点 + 名称 + 数量，右侧一条渐隐的分割线延伸到屏幕边。
// 纯展示，不参与分组计算（分组在 src/screens/taskGroups.ts）。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

export type GroupTone = "accent" | "warn" | "ok" | "muted";

export function TaskGroupHeader({
  title,
  count,
  hint,
  tone = "muted",
}: {
  title: string;
  count: number;
  hint?: string;
  tone?: GroupTone;
}) {
  const { tokens } = useTheme();
  const toneColor =
    tone === "accent"
      ? tokens.accent
      : tone === "warn"
        ? tokens.warn
        : tone === "ok"
          ? tokens.ok
          : tokens.faint;

  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${title}，${count} 项${hint ? `，${hint}` : ""}`}
      style={styles.row}
    >
      <View style={[styles.dot, { backgroundColor: toneColor }]} />
      <Text style={[styles.title, { color: tokens.textSoft }]}>{title}</Text>
      <Text style={[styles.count, { color: tokens.muted }]}>{count}</Text>
      <View style={[styles.rule, { backgroundColor: tokens.separator }]} />
      {hint ? (
        <Text numberOfLines={1} style={[styles.hint, { color: tokens.muted }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    paddingHorizontal: space.xs,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  title: {
    fontSize: font.meta,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  count: {
    fontSize: font.label,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  hint: {
    flexShrink: 1,
    fontSize: font.label,
  },
});
