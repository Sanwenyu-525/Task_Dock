// 分组头：左侧色条 + 名称 + (数量) + 折叠箭头，右侧分割线延伸到屏幕边；补充说明用胶囊。
// 色条比圆点更容易在长列表里做视觉锚点，也让「今天 / 已完成」这些分区一眼可分。
// 折叠只切展示：点击整行开合，计数始终显示，用户知道收起来了几项。
// 纯展示，不参与分组计算（分组在 src/screens/taskGroups.ts）。
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

export type GroupTone = "accent" | "warn" | "ok" | "muted";
export type GroupHintTone = "muted" | "warn";

function TaskGroupHeaderBase({
  title,
  count,
  hint,
  hintTone = "muted",
  tone = "muted",
  collapsed = false,
  onPress,
}: {
  title: string;
  count: number;
  hint?: string;
  /** 补充说明的色调：warn 用于「N 项已逾期」这类需要留意的提示 */
  hintTone?: GroupHintTone;
  tone?: GroupTone;
  /** true = 该分组已折叠，任务行不显示 */
  collapsed?: boolean;
  /** 传入即整行可点，用于开合分组 */
  onPress?: () => void;
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

  const content = (
    <>
      <View style={[styles.bar, { backgroundColor: toneColor }]} />
      <Text style={[styles.title, { color: tokens.text }]}>{title}</Text>
      <Text style={[styles.count, { color: tokens.muted }]}>({count})</Text>
      <View style={[styles.rule, { backgroundColor: tokens.separator }]} />
      {hint ? (
        <View
          style={[
            styles.hintPill,
            { backgroundColor: hintTone === "warn" ? tokens.warnSoft : tokens.track },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[
              styles.hint,
              { color: hintTone === "warn" ? tokens.warn : tokens.muted },
            ]}
          >
            {hint}
          </Text>
        </View>
      ) : null}
      {onPress ? (
        <View style={styles.chevronBox} pointerEvents="none">
          <View
            style={[
              styles.chevron,
              {
                borderColor: tokens.muted,
                transform: [{ rotate: collapsed ? "-45deg" : "45deg" }],
                marginTop: collapsed ? 0 : -3,
              },
            ]}
          />
        </View>
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${title}，${count} 项${hint ? `，${hint}` : ""}`}
        style={styles.row}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}，${count} 项${hint ? `，${hint}` : ""}`}
      accessibilityHint={collapsed ? "展开该分组" : "折叠该分组"}
      accessibilityState={{ expanded: !collapsed }}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

/** 分组头在每分钟 now 刷新时也会重渲染，参数全是原始值，memo 后可直接跳过 */
export const TaskGroupHeader = memo(TaskGroupHeaderBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    paddingHorizontal: space.xs,
  },
  bar: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  title: {
    fontSize: font.meta + 1,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  count: {
    fontSize: font.label,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  chevronBox: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  chevron: {
    width: 6,
    height: 6,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  hintPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: 999,
  },
  hint: {
    flexShrink: 1,
    fontSize: font.label,
    fontWeight: "600",
  },
});
